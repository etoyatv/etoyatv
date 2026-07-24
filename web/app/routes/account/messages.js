const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const { requireAuth } = require('../../../middlewares/auth');
const { canMessageUser } = require('./privacy');
const { redirectBack } = require('../../../utils/safeRedirect');

// 0. Unsubscribe from system notifications via email
router.get('/ru/messages/unsubscribe', async (req, res) => {
  const { id, token } = req.query;
  if (!id || !token) {
    return res.status(400).render('unsubscribe_error', {
      pageTitle: 'Ошибка отписки | ЭтоЯTV',
      errorTitle: 'Неверный запрос',
      errorMessage: 'Отсутствуют необходимые параметры отписки.'
    });
  }

  try {
    const connection = await pool.getConnection();
    const [users] = await connection.query('SELECT id, email, username FROM users WHERE id = ?', [id]);
    
    if (users.length === 0) {
      connection.release();
      return res.status(404).render('unsubscribe_error', {
        pageTitle: 'Ошибка отписки | ЭтоЯTV',
        errorTitle: 'Пользователь не найден',
        errorMessage: 'Пользователь с указанным ID не зарегистрирован в системе.'
      });
    }

    const user = users[0];
    const crypto = require('crypto');
    const secret = process.env.SESSION_SECRET;
    const expectedToken = crypto.createHmac('sha256', secret)
      .update(`${user.id}:${user.email}`)
      .digest('hex');

    if (token !== expectedToken) {
      connection.release();
      return res.status(400).render('unsubscribe_error', {
        pageTitle: 'Ошибка отписки | ЭтоЯTV',
        errorTitle: 'Недействительная ссылка',
        errorMessage: 'Ссылка отписки недействительна или устарела.'
      });
    }

    await connection.query('UPDATE users SET system_emails_enabled = 0 WHERE id = ?', [user.id]);
    connection.release();

    res.render('unsubscribe_success', {
      pageTitle: 'Отписка от рассылки | ЭтоЯTV',
      username: user.username
    });
  } catch (e) {
    console.error('Error handling unsubscribe request:', e);
    res.status(500).render('unsubscribe_error', {
      pageTitle: 'Ошибка отписки | ЭтоЯTV',
      errorTitle: 'Ошибка сервера',
      errorMessage: 'Внутренняя ошибка сервера при обработке запроса на отписку.'
    });
  }
});

// 1. Inbox (Conversations List)
router.get('/ru/messages/', requireAuth, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const userId = req.session.user.id;

    // We want the latest message per conversation
    const [conversations] = await connection.query(`
      SELECT m.*, u.username as other_username, u.avatar as other_avatar, u.last_active
      FROM messages m
      JOIN (
        SELECT 
          CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END as contact_id,
          MAX(id) as last_msg_id
        FROM messages 
        WHERE sender_id = ? OR receiver_id = ?
        GROUP BY contact_id
      ) latest ON m.id = latest.last_msg_id
      JOIN users u ON u.id = latest.contact_id
      WHERE u.deleted_at IS NULL AND IFNULL(u.role, 'user') != 'banned'
      ORDER BY m.created_at DESC
    `, [userId, userId, userId]);

    connection.release();
    res.render('messages_list', { pageTitle: 'Мои сообщения | ЭтоЯTV', conversations, currentUserId: userId });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error loading messages');
  }
});

// 2. Chat with specific user
router.get('/ru/messages/:username', requireAuth, async (req, res) => {
  const targetUsername = req.params.username;
  if (targetUsername === req.session.user.username) return res.redirect('/messages/');

  try {
    const connection = await pool.getConnection();
    const currentUserId = req.session.user.id;

    // Get target user
    const [targetUsers] = await connection.query('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL AND (is_banned = 0 OR (banned_until IS NOT NULL AND banned_until <= NOW()))', [targetUsername]);
    if (targetUsers.length === 0) {
      connection.release();
      return res.send('<script>alert("Пользователь не найден."); setTimeout(function(){ window.location.href="/messages/"; }, 1500);</script>');
    }
    const targetUser = targetUsers[0];
    if (targetUser.deleted_at || targetUser.role === 'banned') {
      connection.release();
      return res.send('<script>alert("Пользователь удален или заблокирован."); setTimeout(function(){ window.location.href="/messages/"; }, 1500);</script>');
    }

    const canMessage = await canMessageUser(req.session.user, targetUser);
    if (!canMessage) {
      connection.release();
      return res.status(403).render('error', {
        title: 'Доступ ограничен',
        message: 'Этот пользователь ограничил круг лиц, которые могут отправлять ему сообщения.',
        status: 403
      });
    }

    // Mark messages as read
    await connection.query('UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0', [targetUser.id, currentUserId]);

    // Check if I am blocked by them
    const [blocks] = await connection.query('SELECT * FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', [targetUser.id, currentUserId]);
    const amIBlocked = blocks.length > 0;

    // Check if I blocked them
    const [myBlocks] = await connection.query('SELECT * FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', [currentUserId, targetUser.id]);
    const areTheyBlocked = myBlocks.length > 0;

    // Get messages history
    const [messages] = await connection.query(`
      SELECT m.*, s.username as sender_name, s.avatar as sender_avatar 
      FROM messages m
      JOIN users s ON m.sender_id = s.id
      WHERE (m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?)
      ORDER BY m.created_at ASC
    `, [currentUserId, targetUser.id, targetUser.id, currentUserId]);

    connection.release();

    res.render('chat', {
      pageTitle: `Переписка с ${targetUser.username} | ЭтоЯTV`,
      targetUser,
      messages,
      currentUserId,
      amIBlocked,
      areTheyBlocked
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error loading chat');
  }
});

// 3. Send message
router.post('/ru/messages/:username', requireAuth, async (req, res) => {
  const targetUsername = req.params.username;
  if (targetUsername === 'Администрация ЭтоЯTV') {
    return res.send('<script>alert("Это системный аккаунт. Ответы не принимаются."); setTimeout(function(){ window.location.href="/messages/"; }, 1500);</script>');
  }
  const content = req.body.content ? req.body.content.trim() : '';
  if (!content) return res.redirect(`/messages/${encodeURIComponent(targetUsername)}`);
  if (content.length > 400) return res.send('<script>alert("Сообщение слишком длинное (максимум 400 символов)."); setTimeout(function(){ window.location.href="/messages/' + encodeURIComponent(targetUsername) + '"; }, 1500);</script>');

  try {
    const connection = await pool.getConnection();
    const currentUserId = req.session.user.id;

    const [targetUsers] = await connection.query('SELECT id, deleted_at, role, privacy_messages FROM users WHERE username = ?', [targetUsername]);
    if (targetUsers.length === 0) {
      connection.release();
      return res.send('<script>alert("Пользователь не найден."); setTimeout(function(){ window.location.href="/messages/"; }, 1500);</script>');
    }
    const targetUser = targetUsers[0];
    const targetUserId = targetUser.id;
    if (targetUser.deleted_at || targetUser.role === 'banned') {
      connection.release();
      return res.send('<script>alert("Пользователь удален или заблокирован."); setTimeout(function(){ window.location.href="/messages/"; }, 1500);</script>');
    }

    const canMessage = await canMessageUser(req.session.user, targetUser);
    if (!canMessage) {
      connection.release();
      return res.status(403).render('error', {
        title: 'Доступ ограничен',
        message: 'Этот пользователь ограничил круг лиц, которые могут отправлять ему сообщения.',
        status: 403
      });
    }

    // Check if blocked 
    const [blocks] = await connection.query('SELECT * FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', [targetUserId, currentUserId]);
    if (blocks.length > 0) {
      connection.release();
      return res.send('<script>alert("Этот пользователь ограничил круг лиц, которые могут отправлять ему сообщения."); setTimeout(function(){ window.location.href="/messages/' + encodeURIComponent(targetUsername) + '"; }, 1500);</script>');
    }

    await connection.query('INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)', [currentUserId, targetUserId, content]);
    connection.release();

    res.redirect(`/messages/${encodeURIComponent(targetUsername)}`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error sending message');
  }
});

// 4. Block user
router.post('/users/block/:username', requireAuth, async (req, res) => {
  const targetUsername = req.params.username;
  if (targetUsername === 'Администрация ЭтоЯTV') {
    return res.send('<script>alert("Нельзя заблокировать системный аккаунт."); setTimeout(function(){ window.history.back(); }, 1500);</script>');
  }
  try {
    const connection = await pool.getConnection();
    const currentUserId = req.session.user.id;
    const [targetUsers] = await connection.query('SELECT id FROM users WHERE username = ?', [targetUsername]);

    if (targetUsers.length > 0) {
      const targetUserId = targetUsers[0].id;
      // Toggle block
      const [existingBlock] = await connection.query('SELECT id FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', [currentUserId, targetUserId]);
      if (existingBlock.length > 0) {
        await connection.query('DELETE FROM user_blocks WHERE id = ?', [existingBlock[0].id]);
      } else {
        await connection.query('INSERT IGNORE INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)', [currentUserId, targetUserId]);
      }
    }
    connection.release();
    redirectBack(req, res, '/messages/');
  } catch (e) {
    res.status(500).send('Error');
  }
});

// 5. Report user
router.post('/users/report/:username', requireAuth, async (req, res) => {
  const targetUsername = req.params.username;
  const reason = req.body.reason || 'Жалоба с профиля';
  try {
    const connection = await pool.getConnection();
    const currentUserId = req.session.user.id;
    const [targetUsers] = await connection.query('SELECT id FROM users WHERE username = ?', [targetUsername]);

    if (targetUsers.length > 0) {
      const targetUserId = targetUsers[0].id;
      await connection.query('INSERT INTO user_reports (reporter_id, reported_id, reason) VALUES (?, ?, ?)', [currentUserId, targetUserId, reason]);
    }
    connection.release();
    res.send('<script>alert("Ваша жалоба отправлена администрации."); setTimeout(function(){ window.location.href=document.referrer; }, 1500);</script>');
  } catch (e) {
    res.status(500).send('Error');
  }
});

// 6. Delete message
router.post('/ru/messages/delete/:id', requireAuth, async (req, res) => {
  const msgId = req.params.id;
  try {
    const connection = await pool.getConnection();
    const currentUserId = req.session.user.id;
    // Verify ownership
    const [msgs] = await connection.query('SELECT * FROM messages WHERE id = ?', [msgId]);
    if (msgs.length > 0) {
      const msg = msgs[0];
      if (msg.sender_id === currentUserId || msg.receiver_id === currentUserId) {
        await connection.query('DELETE FROM messages WHERE id = ?', [msgId]);
      }
    }
    connection.release();
    redirectBack(req, res, '/messages/');
  } catch (e) {
    res.status(500).send('Error deleting message');
  }
});

router.get('/api/users/find_by_id', requireAuth, async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing ID' });
  try {
    const [rows] = await pool.query('SELECT username FROM users WHERE id = ? AND deleted_at IS NULL', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json({ username: rows[0].username });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/api/users/find_by_username', requireAuth, async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'Missing username' });
  try {
    const [rows] = await pool.query('SELECT id, username FROM users WHERE username = ? AND deleted_at IS NULL', [username]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json({ id: rows[0].id, username: rows[0].username });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
