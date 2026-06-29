const express = require('express');
const router = express.Router();
const { pool } = require('../../config/db');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { requireAuth } = require('../../middlewares/auth');
const { logAction } = require('../../utils/logger');
const geoip = require('geoip-lite');
const emailService = require('../../emailService');
const { panelMiddleware, recordUploadMiddleware, designUploadMiddleware } = require('../../middlewares/panel');
const wordFilter = require('../../utils/wordFilter');

router.get('/channels/:shortname/news/:id', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [channelRows] = await connection.query('SELECT id, name, user_id FROM channels WHERE shortname = ?', [req.params.shortname]);
    if (channelRows.length === 0) {
      connection.release();
      return res.status(404).render('404', { pageTitle: 'Канал не найден | ЭтоЯTV' });
    }

    let canSeeHiddenNews = false;
    if (req.session && req.session.user) {
      if (req.session.user.id === channelRows[0].user_id) canSeeHiddenNews = true;
      if (['admin', 'moderator', 'mod'].includes(req.session.user.staff_role)) canSeeHiddenNews = true;
      if (req.session.user.role === 'admin') canSeeHiddenNews = true;
    }

    const newsCondition = canSeeHiddenNews ? '' : ' AND is_hidden = 0';
    const [newsRows] = await connection.query(`SELECT * FROM channel_news WHERE id = ? AND channel_id = ?${newsCondition}`, [req.params.id, channelRows[0].id]);
    connection.release();

    if (newsRows.length === 0) {
      return res.status(404).render('404', { pageTitle: 'Новость не найдена | ЭтоЯTV' });
    }

    res.render('news_view', { pageTitle: newsRows[0].title + ' | ЭтоЯTV - Я есть телевидение!', newsItem: newsRows[0], channelName: channelRows[0].name });
  } catch (e) {
    console.error('Error fetching channel news item:', e);
    res.status(500).send('Database error');
  }
});

router.get('/ru/channel,programs', async (req, res) => {
  const shortname = req.query.shortname;
  if (!shortname) return res.redirect('/');
  try {
    const connection = await pool.getConnection();
    const [chRows] = await connection.query(`
      SELECT c.*, u.username as owner_username 
      FROM channels c 
      JOIN users u ON c.user_id = u.id 
      WHERE c.shortname = ?
    `, [shortname]);
    if (chRows.length === 0) {
      connection.release();
      return res.status(404).send('Channel not found');
    }
    if (chRows[0].status === 'deleted' || chRows[0].status === 'banned') {
      connection.release();
      const isAdminOrMod = req.session.user && ['admin', 'moderator', 'mod'].includes(req.session.user.staff_role);
      if (!isAdminOrMod) return res.status(403).render('deleted_channel', { pageTitle: 'Канал удален | ЭтоЯTV' });
    }
    const channel = chRows[0];
    const limit = 5;
    const page = parseInt(req.query.page) || 1;

    let dbLimit = limit;
    let dbOffset = (page - 1) * limit;

    if (channel.is_live) {
      if (page === 1) {
        dbLimit = limit - 1;
        dbOffset = 0;
      } else {
        dbLimit = limit;
        dbOffset = (page - 1) * limit - 1;
      }
    }

    const [countRows] = await connection.query(`
      SELECT COUNT(*) as count FROM programs WHERE channel_id = ? AND start_time >= NOW() - INTERVAL 2 HOUR
    `, [channel.id]);
    
    const totalDisplayItems = countRows[0].count + (channel.is_live ? 1 : 0);
    const totalPages = Math.ceil(totalDisplayItems / limit);

    const [progRows] = await connection.query(`
      SELECT * FROM programs WHERE channel_id = ? AND start_time >= NOW() - INTERVAL 2 HOUR ORDER BY start_time ASC LIMIT ? OFFSET ?
    `, [channel.id, dbLimit, dbOffset]);
    connection.release();

    res.render('channel_programs', {
      pageTitle: `Расписание телеканала ${channel.name} | ЭтоЯTV`,
      channel: channel,
      owner: { username: channel.owner_username },
      programs: progRows,
      user: req.session.user,
      page: page,
      totalPages: totalPages
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Database error');
  }
});

router.post('/api/channels/:id/favorite', requireAuth, async (req, res) => {
  const channelId = req.params.id;
  const userId = req.session.user.id;
  try {
    const connection = await pool.getConnection();
    const [existing] = await connection.query('SELECT id FROM channel_fans WHERE user_id = ? AND channel_id = ?', [userId, channelId]);
    let isFan = false;
    if (existing.length > 0) {
      await connection.query('DELETE FROM channel_fans WHERE id = ?', [existing[0].id]);
    } else {
      await connection.query('INSERT INTO channel_fans (user_id, channel_id) VALUES (?, ?)', [userId, channelId]);
      isFan = true;
    }
    const [countRows] = await connection.query('SELECT COUNT(*) as count FROM channel_fans WHERE channel_id = ?', [channelId]);
    const [fansRows] = await connection.query(`
      SELECT u.id, u.username, u.avatar 
      FROM channel_fans f 
      JOIN users u ON f.user_id = u.id 
      WHERE f.channel_id = ? 
      ORDER BY f.created_at DESC 
      LIMIT 6
    `, [channelId]);
    connection.release();
    res.json({ success: true, isFan, count: countRows[0].count, fans: fansRows });
  } catch (e) {
    console.error('Error toggling favorite:', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

router.post('/api/channels/:id/report', requireAuth, async (req, res) => {
  const channelId = req.params.id;
  const userId = req.session.user.id;
  const { reason } = req.body;

  if (!reason || reason.trim() === '') {
    return res.status(400).json({ success: false, error: 'Reason is required' });
  }

  try {
    const connection = await pool.getConnection();
    // Verify channel exists
    const [channel] = await connection.query('SELECT user_id FROM channels WHERE id = ?', [channelId]);
    if (channel.length === 0) {
      connection.release();
      return res.status(404).json({ success: false, error: 'Channel not found' });
    }
    if (channel[0].user_id === userId) {
      connection.release();
      return res.status(403).json({ success: false, error: 'Cannot report your own channel' });
    }

    await connection.query('INSERT INTO channel_reports (reporter_id, channel_id, reason) VALUES (?, ?, ?)', [userId, channelId, reason]);
    connection.release();
    res.json({ success: true });
  } catch (e) {
    console.error('Error reporting channel:', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

router.get('/ru/channel,records', async (req, res, next) => {
  const shortname = req.query.shortname;
  if (!shortname) return next();

  try {
    const [channels] = await pool.query('SELECT c.*, u.username as owner_username FROM channels c JOIN users u ON c.user_id = u.id WHERE c.shortname = ?', [shortname]);
    if (channels.length === 0) return next();
    if (channels[0].status === 'deleted' || channels[0].status === 'banned') {
      const isAdminOrMod = req.session.user && ['admin', 'moderator', 'mod'].includes(req.session.user.staff_role);
      if (!isAdminOrMod) return res.status(403).render('deleted_channel', { pageTitle: 'Канал удален | ЭтоЯTV' });
    }
    const channel = channels[0];
    const owner = { username: channel.owner_username };

    const [records] = await pool.query(`
      SELECT id, title, duration, views, thumbnail_url, created_at, is_18_plus,
             (SELECT COUNT(*) FROM record_favorites rf WHERE rf.record_id = records.id) as fans_count
             ${req.session.user ? `, (SELECT COUNT(*) FROM record_favorites rf WHERE rf.record_id = records.id AND rf.user_id = ${req.session.user.id}) > 0 as is_fan` : ', 0 as is_fan'}
      FROM records 
      WHERE channel_id = ? AND status NOT IN ('deleted', 'banned')
      ORDER BY created_at DESC
    `, [channel.id]);

    res.render('channel_records', {
      pageTitle: 'Записи телеканала ' + channel.name + ' | ЭтоЯTV',
      channel,
      owner,
      records,
      user: req.session.user
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.get('/ru/channel,programs', async (req, res, next) => {
  const shortname = req.query.shortname;
  if (!shortname) return next();

  try {
    const [channels] = await pool.query('SELECT c.*, u.username as owner_username FROM channels c JOIN users u ON c.user_id = u.id WHERE c.shortname = ?', [shortname]);
    if (channels.length === 0) return next();
    if (channels[0].status === 'deleted' || channels[0].status === 'banned') {
      const isAdminOrMod = req.session.user && ['admin', 'moderator', 'mod'].includes(req.session.user.staff_role);
      if (!isAdminOrMod) return res.status(403).render('deleted_channel', { pageTitle: 'Канал удален | ЭтоЯTV' });
    }
    const channel = channels[0];
    const owner = { username: channel.owner_username };

    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;

    const [countRows] = await pool.query('SELECT COUNT(*) as cnt FROM programs WHERE channel_id = ? AND start_time >= NOW() - INTERVAL 2 HOUR', [channel.id]);
    const totalProgramsCount = countRows[0].cnt;
    const totalPages = Math.ceil(totalProgramsCount / limit) || 1;

    const query = `
      SELECT p.*, 
             (SELECT COUNT(*) FROM personal_schedules ps WHERE ps.program_id = p.id) as bookmarks_count
             ${req.session.user ? `, (SELECT COUNT(*) FROM personal_schedules ps WHERE ps.program_id = p.id AND ps.user_id = ${req.session.user.id}) > 0 as is_bookmarked` : ', 0 as is_bookmarked'}
      FROM programs p
      WHERE p.channel_id = ? AND p.start_time >= NOW() - INTERVAL 2 HOUR
      ORDER BY p.start_time ASC
      LIMIT ? OFFSET ?
    `;
    const [programs] = await pool.query(query, [channel.id, limit, offset]);

    res.render('channel_programs', {
      pageTitle: 'Расписание телеканала ' + channel.name + ' | ЭтоЯTV',
      channel,
      owner,
      programs,
      user: req.session.user,
      page,
      totalPages
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.get('/ru/channel,friends', async (req, res, next) => {
  const shortname = req.query.shortname;
  if (!shortname) return next();

  try {
    const [channels] = await pool.query('SELECT c.*, u.username FROM channels c JOIN users u ON c.user_id = u.id WHERE c.shortname = ?', [shortname]);

    if (channels.length === 0) {
      return next();
    }
    if (channels[0].status === 'deleted' || channels[0].status === 'banned') {
      const isAdminOrMod = req.session.user && ['admin', 'moderator', 'mod'].includes(req.session.user.staff_role);
      if (!isAdminOrMod) return res.status(403).render('deleted_channel', { pageTitle: 'Канал удален | ЭтоЯTV' });
    }

    const channelId = channels[0].id;
    const [fans] = await pool.query(`
      SELECT f.user_id, u.username, u.avatar, u.last_active 
      FROM channel_fans f 
      JOIN users u ON f.user_id = u.id 
      WHERE f.channel_id = ? 
      ORDER BY f.created_at DESC
    `, [channelId]);

    res.render('channel_friends', {
      pageTitle: 'Фанаты телеканала ' + channels[0].name + ' | ЭтоЯTV',
      channel: channels[0],
      owner: { username: channels[0].username },
      fans
    });
  } catch (e) {
    console.error('Error fetching friends:', e);
    next();
  }
});

router.get('/channels/create', requireAuth, async (req, res) => {
  let hasRecentlyDeletedChannel = false;
  let personalCount = 0;
  let cooperativeCount = 0;
  try {
    const connection = await pool.getConnection();
    const [deleted] = await connection.query("SELECT id, deleted_at FROM channels WHERE user_id = ? AND status = 'deleted' AND deleted_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) LIMIT 1", [req.session.user.id]);
    
    const [owned] = await connection.query("SELECT is_personal FROM channels WHERE user_id = ? AND status IN ('active', 'banned')", [req.session.user.id]);
    personalCount = owned.filter(c => c.is_personal).length;
    cooperativeCount = owned.filter(c => !c.is_personal).length;

    connection.release();
    if (deleted.length > 0) {
      const diff = Date.now() - new Date(deleted[0].deleted_at).getTime();
      const daysLeft = 30 - Math.floor(diff / (1000 * 60 * 60 * 24));
      hasRecentlyDeletedChannel = daysLeft > 0 ? daysLeft : false;
    }
  } catch (e) { }
  res.render('channel_create', { 
    pageTitle: 'Создание телеканала | ЭтоЯTV', 
    error: req.query.error, 
    hasRecentlyDeletedChannel,
    personalCount,
    cooperativeCount
  });
});

router.post('/channels/restore', requireAuth, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    await connection.query("UPDATE channels SET status = 'active', deleted_at = NULL, rtmp_disabled = 0 WHERE user_id = ? AND status = 'deleted'", [req.session.user.id]);
    
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, 'Отменил удаление канала', userIp);

    connection.release();
    res.redirect('/ru/panel,dashboard');
  } catch (e) {
    console.error(e);
    res.redirect('/channels/create?error=' + encodeURIComponent('Ошибка восстановления'));
  }
});

router.post('/channels/create', requireAuth, async (req, res) => {
  const { name, description, shortname, channel_type, team_username, team_usernames } = req.body;
  if (!name || !shortname || !channel_type) {
    return res.redirect('/channels/create?error=' + encodeURIComponent('Имя канала, короткое имя и тип канала обязательны.'));
  }
  if (channel_type !== 'personal' && channel_type !== 'cooperative') {
    return res.redirect('/channels/create?error=' + encodeURIComponent('Неверный тип канала.'));
  }
  if (name.length > 77) {
    return res.redirect('/channels/create?error=' + encodeURIComponent('Название телеканала не должно превышать 77 символов.'));
  }
  if (description && description.length > 200) {
    return res.redirect('/channels/create?error=' + encodeURIComponent('Описание телеканала не должно превышать 200 символов.'));
  }

  const restrictedSlugs = ['login', 'register', 'api', 'news', 'account', 'channels', 'admin', 'panel'];
  if (restrictedSlugs.includes(shortname.toLowerCase())) {
    return res.redirect('/channels/create?error=' + encodeURIComponent('Это короткое имя недоступно.'));
  }

  const slugRegex = /^[a-zA-Z0-9_-]+$/;
  if (!slugRegex.test(shortname)) {
    return res.redirect('/channels/create?error=' + encodeURIComponent('Короткое имя может содержать только латинские буквы, цифры, дефис и подчеркивание.'));
  }

  if (!req.session.user.staff_role && await wordFilter.containsBadWords(shortname)) {
    return res.redirect('/channels/create?error=' + encodeURIComponent('Данный URL адрес нельзя назвать.'));
  }

  try {
    const connection = await pool.getConnection();

    // Check limits
    const [owned] = await connection.query("SELECT is_personal FROM channels WHERE user_id = ? AND status IN ('active', 'banned')", [req.session.user.id]);
    const personalCount = owned.filter(c => c.is_personal).length;
    const cooperativeCount = owned.filter(c => !c.is_personal).length;

    if (channel_type === 'personal' && personalCount >= 1) {
      connection.release();
      return res.redirect('/channels/create?error=' + encodeURIComponent('Превышен лимит личных каналов (максимум 1).'));
    }
    if (channel_type === 'cooperative' && cooperativeCount >= 3) {
      connection.release();
      return res.redirect('/channels/create?error=' + encodeURIComponent('Превышен лимит кооперативных каналов (максимум 3).'));
    }

    // Check team member usernames if cooperative
    const teamUserIds = [];
    if (channel_type === 'cooperative') {
      let usernamesList = [];
      if (team_usernames) {
        if (Array.isArray(team_usernames)) {
          usernamesList = team_usernames.map(u => u.trim()).filter(Boolean);
        } else if (typeof team_usernames === 'string') {
          usernamesList = [team_usernames.trim()].filter(Boolean);
        }
      }
      if (team_username && team_username.trim()) {
        const singleInput = team_username.trim();
        if (!usernamesList.includes(singleInput)) {
          usernamesList.push(singleInput);
        }
      }
      // Unique list
      usernamesList = [...new Set(usernamesList)];

      for (const username of usernamesList) {
        const [users] = await connection.query('SELECT id FROM users WHERE username = ? AND deleted_at IS NULL AND is_banned = 0', [username]);
        if (users.length === 0) {
          connection.release();
          return res.redirect('/channels/create?error=' + encodeURIComponent(`Пользователь "${username}" не найден.`));
        }
        const teamUserId = users[0].id;
        if (teamUserId === req.session.user.id) {
          connection.release();
          return res.redirect('/channels/create?error=' + encodeURIComponent('Вы не можете добавить себя в команду.'));
        }
        if (!teamUserIds.includes(teamUserId)) {
          teamUserIds.push(teamUserId);
        }
      }
    }

    const [existing] = await connection.query('SELECT id FROM channels WHERE shortname = ?', [shortname]);
    if (existing.length > 0) {
      connection.release();
      return res.redirect('/channels/create?error=' + encodeURIComponent('Это короткое имя уже занято.'));
    }

    const filteredName = req.session.user.staff_role ? name : await wordFilter.filter(name);
    const filteredDescription = req.session.user.staff_role ? description : await wordFilter.filter(description);

    const [result] = await connection.query('INSERT INTO channels (user_id, name, description, shortname, bg_color, logo_url, status, is_personal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())',
      [req.session.user.id, filteredName, filteredDescription, shortname, '#262626', '/images/default_channel_logo.png', 'active', channel_type === 'personal' ? 1 : 0]);

    const channelId = result.insertId;

    if (channel_type === 'cooperative' && teamUserIds.length > 0) {
      for (const teamUserId of teamUserIds) {
        await connection.query('INSERT INTO channel_team (channel_id, user_id, is_editor, is_reporter, is_moderator, is_coowner) VALUES (?, ?, 1, 1, 1, 1)', [channelId, teamUserId]);
      }
    }

    connection.release();
    res.redirect('/' + shortname);
  } catch (e) {
    console.error('Error creating channel:', e);
    res.redirect('/channels/create?error=' + encodeURIComponent('Внутренняя ошибка сервера.'));
  }
});

router.get('/channels/transfer/confirm', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).render('error', {
      title: 'Неверная ссылка',
      message: 'Токен передачи не указан или неверен.',
      status: 400
    });
  }

  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT id FROM pending_channel_transfers WHERE token = ?', [token]);
    if (rows.length === 0) {
      connection.release();
      return res.status(404).render('error', {
        title: 'Запрос не найден',
        message: 'Запрос на передачу владения не существует или уже устарел.',
        status: 404
      });
    }

    await connection.query('UPDATE pending_channel_transfers SET email_confirmed = TRUE WHERE token = ?', [token]);
    connection.release();

    res.render('error', {
      title: 'Передача подтверждена',
      message: 'Передача успешно подтверждена вами по почте. Теперь получатель увидит предложение в своей панели и должен принять его для завершения процесса.',
      status: 'OK'
    });
  } catch (e) {
    console.error('Error confirming channel transfer:', e);
    res.status(500).render('error', {
      title: 'Ошибка сервера',
      message: 'Произошла непредвиденная ошибка на сервере.',
      status: 500
    });
  }
});

router.post('/channels/transfer/accept', requireAuth, async (req, res) => {
  const { transfer_id } = req.body;
  if (!transfer_id) {
    return res.status(400).send('Transfer ID is required');
  }

  const userId = req.session.user.id;

  try {
    const connection = await pool.getConnection();
    const [transferRows] = await connection.query(
      'SELECT * FROM pending_channel_transfers WHERE id = ? AND new_owner_id = ? AND email_confirmed = TRUE',
      [transfer_id, userId]
    );

    if (transferRows.length === 0) {
      connection.release();
      return res.status(404).send('Запрос на передачу не найден или не подтвержден владельцем.');
    }

    const transfer = transferRows[0];
    const channelId = transfer.channel_id;

    const [owned] = await connection.query(
      "SELECT id FROM channels WHERE user_id = ? AND is_personal = FALSE AND status IN ('active', 'banned')",
      [userId]
    );
    if (owned.length >= 3) {
      connection.release();
      return res.status(400).send('Вы не можете принять владение этим каналом, так как у вас уже есть 3 кооперативных канала.');
    }

    await connection.beginTransaction();

    await connection.query('UPDATE channels SET user_id = ? WHERE id = ?', [userId, channelId]);

    await connection.query('DELETE FROM channel_team WHERE channel_id = ? AND user_id = ?', [channelId, userId]);

    await connection.query('DELETE FROM channel_team WHERE channel_id = ? AND user_id = ?', [channelId, transfer.old_owner_id]);
    await connection.query(
      'INSERT INTO channel_team (channel_id, user_id, is_reporter, is_moderator, is_editor, is_coowner) VALUES (?, ?, 1, 0, 1, 0)',
      [channelId, transfer.old_owner_id]
    );

    await connection.query('DELETE FROM pending_channel_transfers WHERE id = ?', [transfer_id]);

    await connection.commit();
    connection.release();

    res.json({ success: true });
  } catch (e) {
    console.error('Error accepting channel transfer:', e);
    res.status(500).send('Internal server error');
  }
});

router.post('/channels/transfer/reject', requireAuth, async (req, res) => {
  const { transfer_id } = req.body;
  if (!transfer_id) {
    return res.status(400).send('Transfer ID is required');
  }

  const userId = req.session.user.id;

  try {
    const connection = await pool.getConnection();
    await connection.query('DELETE FROM pending_channel_transfers WHERE id = ? AND new_owner_id = ?', [transfer_id, userId]);
    connection.release();
    res.json({ success: true });
  } catch (e) {
    console.error('Error rejecting channel transfer:', e);
    res.status(500).send('Internal server error');
  }
});

router.post('/channels/:shortname/comments/add', requireAuth, async (req, res) => {
  const { shortname } = req.params;
  const { text } = req.body;
  if (!text || !text.trim()) {
    return res.redirect('/' + shortname + '#comments');
  }

  try {
    const connection = await pool.getConnection();
    const [channels] = await connection.query('SELECT id FROM channels WHERE shortname = ?', [shortname]);
    if (channels.length === 0) {
      connection.release();
      return res.status(404).send('Channel not found');
    }
    let commentText = text.trim();
    if (commentText.length > 300) commentText = commentText.substring(0, 300);

    const filteredComment = req.session.user.staff_role ? commentText : await wordFilter.filter(commentText);

    await connection.query('INSERT INTO channel_comments (channel_id, user_id, text) VALUES (?, ?, ?)', [channels[0].id, req.session.user.id, filteredComment]);
    
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('user', req.session.user.username, `Оставил комментарий к каналу (ID: ${channels[0].id})`, userIp);

    connection.release();
    res.redirect('/' + shortname + '#comments');
  } catch (e) {
    console.error('Error adding comment:', e);
    res.status(500).send('Internal Server Error');
  }
});

router.post('/channels/:shortname/comments/:id/delete', requireAuth, async (req, res) => {
  const { shortname, id } = req.params;

  try {
    const connection = await pool.getConnection();
    const [comments] = await connection.query('SELECT c.user_id, ch.user_id as owner_id FROM channel_comments c JOIN channels ch ON c.channel_id = ch.id WHERE c.id = ?', [id]);

    if (comments.length === 0) {
      connection.release();
      return res.status(404).send('Comment not found');
    }

    const isAuthor = comments[0].user_id === req.session.user.id;
    const isOwner = comments[0].owner_id === req.session.user.id;
    const isAdmin = req.session.user.is_admin || false; // stub for platform admin
    const isModerator = false; // stub for channel moderator

    if (isAuthor || isOwner || isAdmin || isModerator) {
      await connection.query('DELETE FROM channel_comments WHERE id = ?', [id]);
    }
    connection.release();
    res.redirect('/' + shortname + '#comments');
  } catch (e) {
    console.error('Error deleting comment:', e);
    res.status(500).send('Internal Server Error');
  }
});

router.post('/channels/:shortname/news/add', requireAuth, async (req, res) => {
  const { shortname } = req.params;
  const { title, announce, content } = req.body;

  if (!title || !title.trim()) {
    return res.redirect('/ru/panel,news?error=' + encodeURIComponent('Title is required'));
  }

  try {
    const connection = await pool.getConnection();
    const [channels] = await connection.query('SELECT id, user_id FROM channels WHERE shortname = ?', [shortname]);
    if (channels.length === 0) {
      connection.release();
      return res.redirect('/ru/panel,news?error=' + encodeURIComponent('Channel not found'));
    }

    const isOwner = channels[0].user_id === req.session.user.id;
    const isModerator = false; // stub for channel moderator

    if (!isOwner && !isModerator) {
      connection.release();
      return res.status(403).send('Forbidden');
    }

    await connection.query('INSERT INTO channel_news (channel_id, title, announce, content, author_id) VALUES (?, ?, ?, ?, ?)',
      [channels[0].id, title.trim(), announce ? announce.trim() : null, content ? content.trim() : null, req.session.user.id]);

    connection.release();
    res.redirect('/' + shortname);
  } catch (e) {
    console.error('Error adding channel news:', e);
    res.redirect('/ru/panel,news?error=' + encodeURIComponent('Server Error'));
  }
});

router.post('/channels/:shortname/news/:id/delete', requireAuth, async (req, res) => {
  const { shortname, id } = req.params;

  try {
    const connection = await pool.getConnection();
    const [news] = await connection.query('SELECT ch.user_id as owner_id FROM channel_news n JOIN channels ch ON n.channel_id = ch.id WHERE n.id = ?', [id]);

    if (news.length === 0) {
      connection.release();
      return res.status(404).send('News not found');
    }

    const isOwner = news[0].owner_id === req.session.user.id;
    const isAdmin = req.session.user.is_admin || false;
    const isModerator = false; // stub for channel moderator

    if (isOwner || isAdmin || isModerator) {
      await connection.query('DELETE FROM channel_news WHERE id = ?', [id]);
    }

    connection.release();
    res.redirect('/' + shortname);
  } catch (e) {
    console.error('Error deleting news:', e);
    res.status(500).send('Internal Server Error');
  }
});
router.get('/widget/chat/:shortname', async (req, res, next) => {
  const { shortname } = req.params;

  try {
    const [channels] = await pool.query('SELECT c.*, u.username FROM channels c JOIN users u ON c.user_id = u.id WHERE c.shortname = ?', [shortname]);

    if (channels.length === 0) {
      return res.status(404).send('Channel not found');
    }

    if (channels[0].status === 'deleted' || channels[0].status === 'banned') {
      return res.status(403).send('Channel is banned or deleted');
    }

    const channelId = channels[0].id;

    // Fetch pinned message details if set
    const pinnedMsgId = channels[0].pinned_message_id;
    channels[0].pinned_message = null;
    channels[0].pinned_message_id = null;
    if (pinnedMsgId) {
      try {
        const [pinnedRows] = await pool.query(`
          SELECT pm.id, pm.message, pm.guest_name, u.username, pm.role, pm.color
          FROM chat_messages pm
          LEFT JOIN users u ON pm.user_id = u.id
          WHERE pm.id = ?
        `, [pinnedMsgId]);
        if (pinnedRows.length > 0) {
          channels[0].pinned_message = pinnedRows[0].message;
          channels[0].pinned_guest_name = pinnedRows[0].guest_name;
          channels[0].pinned_username = pinnedRows[0].username;
          channels[0].pinned_role = pinnedRows[0].role;
          channels[0].pinned_color = pinnedRows[0].color;
          channels[0].pinned_message_id = pinnedRows[0].id;
        }
      } catch (e) {
        console.error('Error loading pinned message in widget:', e);
      }
    }

    // Fetch recent chat messages (last 100)
    const [chatRows] = await pool.query(`
      SELECT m.id, m.user_id, m.guest_name, u.username, m.message, m.role, m.created_at, m.color
      FROM chat_messages m
      LEFT JOIN users u ON m.user_id = u.id
      WHERE m.channel_id = ?
      ORDER BY m.created_at ASC
      LIMIT 100
    `, [channelId]);

    let channelRole = 'guest';
    let isModerator = false;
    if (req.session.user) {
      if (req.session.user.id === channels[0].user_id) {
        channelRole = 'owner';
        isModerator = true;
      } else {
        const [teamRow] = await pool.query('SELECT is_reporter, is_moderator, is_editor FROM channel_team WHERE channel_id = ? AND user_id = ?', [channelId, req.session.user.id]);
        if (teamRow.length > 0) {
          const t = teamRow[0];
          if (t.is_moderator) channelRole = 'moderator';
          else if (t.is_editor) channelRole = 'editor';
          else if (t.is_reporter) channelRole = 'reporter';

          if (t.is_moderator) isModerator = true;
        }
      }
    }

    const isGlobalAdminOrMod = req.session.user && ['admin', 'moderator', 'mod'].includes(req.session.user.staff_role);
    if (isGlobalAdminOrMod) {
      channelRole = 'alien';
      isModerator = true;
    }

    const overlay = req.query.overlay === '1' || req.query.overlay === 'true';
    const readonly = req.query.readonly === '1' || req.query.readonly === 'true' || overlay;

    res.render('chat_widget', {
      channel: channels[0],
      chatMessages: chatRows,
      user: req.session.user,
      channelRole,
      isModerator,
      overlay,
      readonly,
      CDN_BASE_URL: res.locals.CDN_BASE_URL || ''
    });
  } catch (e) {
    console.error('Error fetching chat widget:', e);
    res.status(500).send('Server error');
  }
});

router.get('/widget/player/:shortname', async (req, res, next) => {
  const { shortname } = req.params;

  try {
    const [channels] = await pool.query('SELECT c.*, u.username FROM channels c JOIN users u ON c.user_id = u.id WHERE c.shortname = ?', [shortname]);

    if (channels.length === 0) {
      return res.status(404).send('Channel not found');
    }

    if (channels[0].status === 'deleted' || channels[0].status === 'banned') {
      return res.status(403).send('Channel is banned or deleted');
    }

    const channelId = channels[0].id;

    let channelRole = 'guest';
    let isModerator = false;
    if (req.session.user) {
      if (req.session.user.id === channels[0].user_id) {
        channelRole = 'owner';
        isModerator = true;
      } else {
        const [teamRow] = await pool.query('SELECT is_reporter, is_moderator, is_editor FROM channel_team WHERE channel_id = ? AND user_id = ?', [channelId, req.session.user.id]);
        if (teamRow.length > 0) {
          const t = teamRow[0];
          if (t.is_moderator) channelRole = 'moderator';
          else if (t.is_editor) channelRole = 'editor';
          else if (t.is_reporter) channelRole = 'reporter';

          if (t.is_moderator) isModerator = true;
        }
      }
    }

    const isGlobalAdminOrMod = req.session.user && ['admin', 'moderator', 'mod'].includes(req.session.user.staff_role);
    if (isGlobalAdminOrMod) {
      channelRole = 'alien';
      isModerator = true;
    }

    res.render('player_widget', {
      channel: channels[0],
      user: req.session.user,
      channelRole,
      isModerator,
      CDN_BASE_URL: res.locals.CDN_BASE_URL || ''
    });
  } catch (e) {
    console.error('Error fetching player widget:', e);
    res.status(500).send('Server error');
  }
});
router.get('/widget/combined/:shortname', async (req, res, next) => {
  const { shortname } = req.params;
  const { layout, autoplay } = req.query;

  try {
    const [channels] = await pool.query('SELECT status FROM channels WHERE shortname = ?', [shortname]);

    if (channels.length === 0) {
      return res.status(404).send('Channel not found');
    }

    if (channels[0].status === 'deleted' || channels[0].status === 'banned') {
      return res.status(403).send('Channel is banned or deleted');
    }

    res.render('combined_widget', {
      shortname,
      layout: layout === 'vertical' ? 'vertical' : 'horizontal',
      autoplay: autoplay === '1' ? '1' : '0'
    });
  } catch (e) {
    console.error('Error fetching combined widget:', e);
    res.status(500).send('Server error');
  }
});

router.get('/:shortname', async (req, res, next) => {
  const { shortname } = req.params;

  // Skip logic if it looks like an asset or known root path
  if (shortname.includes('.') || shortname === 'ru' || shortname === 'images' || shortname === 'css' || shortname === 'js' || shortname === 'favicon.ico') {
    return next();
  }

  try {
    const [channels] = await pool.query('SELECT c.*, u.username FROM channels c JOIN users u ON c.user_id = u.id WHERE c.shortname = ?', [shortname]);

    if (channels.length === 0) {
      return next(); // pass to 404
    }

    if (channels[0].status === 'deleted' || channels[0].status === 'banned') {
      const isAdminOrMod = req.session.user && ['admin', 'moderator', 'mod'].includes(req.session.user.staff_role);
      if (!isAdminOrMod) {
        return res.status(403).render('deleted_channel', { pageTitle: 'Канал удален | ЭтоЯTV' });
      }
    }

    const channelId = channels[0].id;

    // Fetch pinned message details if set
    const pinnedMsgId = channels[0].pinned_message_id;
    channels[0].pinned_message = null;
    channels[0].pinned_message_id = null;
    if (pinnedMsgId) {
      try {
        const [pinnedRows] = await pool.query(`
          SELECT pm.id, pm.message, pm.guest_name, u.username, pm.role, pm.color
          FROM chat_messages pm
          LEFT JOIN users u ON pm.user_id = u.id
          WHERE pm.id = ?
        `, [pinnedMsgId]);
        if (pinnedRows.length > 0) {
          channels[0].pinned_message = pinnedRows[0].message;
          channels[0].pinned_guest_name = pinnedRows[0].guest_name;
          channels[0].pinned_username = pinnedRows[0].username;
          channels[0].pinned_role = pinnedRows[0].role;
          channels[0].pinned_color = pinnedRows[0].color;
          channels[0].pinned_message_id = pinnedRows[0].id;
        }
      } catch (e) {
        console.error('Error loading pinned message:', e);
      }
    }

    let coowners = [];
    if (!channels[0].is_personal) {
      const [coownerRows] = await pool.query(`
        SELECT t.user_id, u.username 
        FROM channel_team t 
        JOIN users u ON t.user_id = u.id 
        WHERE t.channel_id = ? AND t.is_coowner = 1 
        ORDER BY t.order_index ASC, t.id ASC
      `, [channelId]);
      coowners = coownerRows;
    }

    if (channels[0].access_level === 'password') {
      const isPlatformAdmin = req.session.user && ['admin', 'moderator', 'mod'].includes(req.session.user.staff_role);
      if (!isPlatformAdmin && (!req.session.unlockedChannels || !req.session.unlockedChannels.includes(channelId))) {
        return res.render('password_prompt', { pageTitle: 'Ввод пароля | ЭтоЯTV', channel: channels[0], error: req.query.error });
      }
    }

    // Fetch fans count and up to 6 fans for the block
    const [fansRows] = await pool.query(`
      SELECT f.user_id, u.username, u.avatar 
      FROM channel_fans f 
      JOIN users u ON f.user_id = u.id 
      WHERE f.channel_id = ? 
      ORDER BY f.created_at DESC 
      LIMIT 6
    `, [channelId]);

    const [fansCountRows] = await pool.query('SELECT COUNT(*) as count FROM channel_fans WHERE channel_id = ?', [channelId]);
    const fansCount = fansCountRows[0].count;

    let isFan = false;
    if (req.session.user) {
      const [userFanRows] = await pool.query('SELECT id FROM channel_fans WHERE user_id = ? AND channel_id = ?', [req.session.user.id, channelId]);
      isFan = userFanRows.length > 0;
    }

    const cpage = parseInt(req.query.cpage) || 1;
    const cperPage = 7;
    const coffset = (cpage - 1) * cperPage;

    const [commentCountRows] = await pool.query('SELECT COUNT(*) as cnt FROM channel_comments WHERE channel_id = ? AND is_hidden = 0', [channelId]);
    const totalComments = commentCountRows[0].cnt;
    const commentsTotalPages = Math.ceil(totalComments / cperPage);

    const [commentsRows] = await pool.query(`
      SELECT c.id, c.text, c.created_at, u.id as user_id, u.username, u.avatar 
      FROM channel_comments c 
      JOIN users u ON c.user_id = u.id 
      WHERE c.channel_id = ? AND c.is_hidden = 0
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `, [channelId, cperPage, coffset]);

    let channelRole = 'guest';
    let isModerator = false;
    if (req.session.user) {
      if (req.session.user.id === channels[0].user_id) {
        channelRole = 'owner';
        isModerator = true;
      } else {
        const [teamRow] = await pool.query('SELECT is_reporter, is_moderator, is_editor FROM channel_team WHERE channel_id = ? AND user_id = ?', [channelId, req.session.user.id]);
        if (teamRow.length > 0) {
          const t = teamRow[0];
          if (t.is_moderator) channelRole = 'moderator';
          else if (t.is_editor) channelRole = 'editor';
          else if (t.is_reporter) channelRole = 'reporter';

          if (t.is_moderator) isModerator = true;
        }
      }
    }

    const isGlobalAdminOrMod = req.session.user && ['admin', 'moderator', 'mod'].includes(req.session.user.staff_role);
    const canSeeHiddenNews = isModerator || isGlobalAdminOrMod;

    if (isGlobalAdminOrMod) {
      channelRole = 'alien';
      isModerator = true;
    }

    const [newsRows] = await pool.query(`
      SELECT id, title, announce, created_at 
      FROM channel_news 
      WHERE channel_id = ? ${canSeeHiddenNews ? '' : 'AND is_hidden = 0'}
      ORDER BY created_at DESC
    `, [channelId]);

    const [chatRows] = await pool.query(`
      SELECT m.id, m.user_id, m.guest_name, u.username, m.message, m.role, m.created_at, m.color
      FROM chat_messages m
      LEFT JOIN users u ON m.user_id = u.id
      WHERE m.channel_id = ?
      ORDER BY m.created_at ASC
      LIMIT 100
    `, [channelId]);

    const [recordsCountRows] = await pool.query('SELECT COUNT(*) as cnt FROM records WHERE channel_id = ? AND status NOT IN ("deleted", "banned")', [channelId]);
    const totalRecords = recordsCountRows[0].cnt;

    const [recordsRows] = await pool.query(`
      
      SELECT r.*,
             (SELECT COUNT(*) FROM record_favorites rf WHERE rf.record_id = r.id) as fans_count
             ${req.session.user ? `, (SELECT COUNT(*) FROM record_favorites rf WHERE rf.record_id = r.id AND rf.user_id = ${req.session.user.id}) > 0 as is_fan` : ', 0 as is_fan'}
      FROM records r 
      WHERE channel_id = ? AND status NOT IN ('deleted', 'banned')
      ORDER BY created_at DESC 
      LIMIT 2
    `, [channelId]);

    // Fetch upcoming programs for the channel
    let programsRows = [];
    let totalPrograms = 0;
    try {
      const [pCountRows] = await pool.query('SELECT COUNT(*) as cnt FROM programs WHERE channel_id = ? AND start_time >= NOW() - INTERVAL 2 HOUR', [channelId]);
      totalPrograms = pCountRows[0].cnt;
      
      const progLimit = channels[0].is_live ? 2 : 3;
      const query = `
        SELECT p.*, 
               (SELECT COUNT(*) FROM personal_schedules ps WHERE ps.program_id = p.id) as bookmarks_count
               ${req.session.user ? `, (SELECT COUNT(*) FROM personal_schedules ps WHERE ps.program_id = p.id AND ps.user_id = ${req.session.user.id}) > 0 as is_bookmarked` : ', 0 as is_bookmarked'}
        FROM programs p
        WHERE p.channel_id = ? AND p.start_time >= NOW() - INTERVAL 2 HOUR
        ORDER BY p.start_time ASC
        LIMIT ?
      `;
      const [pRows] = await pool.query(query, [channelId, progLimit]);
      programsRows = pRows;
    } catch (e) {
      console.error('Error fetching programs:', e);
    }

    res.render('channel', {
      pageTitle: channels[0].name + ' | ЭтоЯTV - Я есть телевидение!',
      channel: channels[0],
      owner: { username: channels[0].username, id: channels[0].user_id },
      fans: fansRows,
      fansCount,
      isFan,
      comments: commentsRows,
      cpage,
      commentsTotalPages,
      totalComments,
      news: newsRows,
      chatMessages: chatRows,
      user: req.session.user,
      records: recordsRows,
      totalRecords: totalRecords,
      channelRole,
      isModerator,
      programs: programsRows,
      totalPrograms,
      coowners: coowners
    });
  } catch (e) {
    console.error('Error fetching channel:', e);
    next();
  }
});

router.post('/api/channels/:shortname/unlock', async (req, res) => {
  const { shortname } = req.params;
  const { password } = req.body;
  try {
    const [channels] = await pool.query('SELECT id, password FROM channels WHERE shortname = ?', [shortname]);
    if (channels.length === 0) return res.status(404).send('Not found');

    if (channels[0].password === password) {
      if (!req.session.unlockedChannels) req.session.unlockedChannels = [];
      if (!req.session.unlockedChannels.includes(channels[0].id)) {
        req.session.unlockedChannels.push(channels[0].id);
      }
      res.redirect(`/${shortname}`);
    } else {
      res.redirect(`/${shortname}?error=` + encodeURIComponent('Неверный пароль'));
    }
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.get('/api/channels/:shortname/comments_html', async (req, res) => {
  const { shortname } = req.params;
  const cpage = parseInt(req.query.cpage) || 1;
  const cperPage = 7;
  const coffset = (cpage - 1) * cperPage;

  try {
    const connection = await pool.getConnection();
    const [channels] = await connection.query('SELECT * FROM channels WHERE shortname = ?', [shortname]);
    if (channels.length === 0) {
      connection.release();
      return res.status(404).send('Channel not found');
    }
    const channel = channels[0];

    const [commentCountRows] = await connection.query('SELECT COUNT(*) as cnt FROM channel_comments WHERE channel_id = ? AND is_hidden = 0', [channel.id]);
    const totalComments = commentCountRows[0].cnt;
    const commentsTotalPages = Math.ceil(totalComments / cperPage);

    const [commentsRows] = await connection.query(`
      SELECT c.id, c.text, c.created_at, u.id as user_id, u.username, u.avatar 
      FROM channel_comments c 
      JOIN users u ON c.user_id = u.id 
      WHERE c.channel_id = ? AND c.is_hidden = 0
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `, [channel.id, cperPage, coffset]);

    connection.release();

    res.render('partials/channel_comments_list', {
      comments: commentsRows,
      cpage,
      commentsTotalPages,
      user: req.session.user,
      channel: channel
    });
  } catch (e) {
    console.error('Error in channel comments html:', e);
    res.status(500).send('Error');
  }
});

router.get('/api/channels/:shortname/comments_count', async (req, res) => {
  const { shortname } = req.params;
  try {
    const [channels] = await pool.query('SELECT id FROM channels WHERE shortname = ?', [shortname]);
    if (channels.length === 0) return res.json({ success: false, error: 'Channel not found' });
    const [countRows] = await pool.query('SELECT COUNT(*) as cnt FROM channel_comments WHERE channel_id = ? AND is_hidden = 0', [channels[0].id]);
    res.json({ success: true, count: countRows[0].cnt });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/api/channels/:shortname/comment', requireAuth, async (req, res) => {
  const { shortname } = req.params;
  const { text } = req.body;
  if (!text || !text.trim()) return res.json({ success: false, error: 'Text is empty' });

  try {
    const connection = await pool.getConnection();
    const [channels] = await connection.query('SELECT id FROM channels WHERE shortname = ?', [shortname]);
    if (channels.length === 0) {
      connection.release();
      return res.status(404).json({ success: false, error: 'Channel not found' });
    }
    let commentText = text.trim();
    if (commentText.length > 300) commentText = commentText.substring(0, 300);

    await connection.query('INSERT INTO channel_comments (channel_id, user_id, text) VALUES (?, ?, ?)', [channels[0].id, req.session.user.id, commentText]);
    
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('user', req.session.user.username, `Оставил комментарий к каналу (ID: ${channels[0].id})`, userIp);

    connection.release();
    res.json({ success: true });
  } catch (e) {
    console.error('Error adding channel comment:', e);
    res.json({ success: false, error: 'Server error' });
  }
});

router.post('/api/channels/:shortname/unlock', async (req, res) => {
  const { shortname } = req.params;
  const { password } = req.body;
  try {
    const [channels] = await pool.query('SELECT id, password FROM channels WHERE shortname = ?', [shortname]);
    if (channels.length === 0) return res.status(404).send('Not found');

    if (channels[0].password === password) {
      if (!req.session.unlockedChannels) req.session.unlockedChannels = [];
      if (!req.session.unlockedChannels.includes(channels[0].id)) {
        req.session.unlockedChannels.push(channels[0].id);
      }
      res.redirect(`/${shortname}`);
    } else {
      res.redirect(`/${shortname}?error=` + encodeURIComponent('Неверный пароль'));
    }
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.get('/api/channels/:shortname/comments_html', async (req, res) => {
  const { shortname } = req.params;
  const cpage = parseInt(req.query.cpage) || 1;
  const cperPage = 7;
  const coffset = (cpage - 1) * cperPage;

  try {
    const connection = await pool.getConnection();
    const [channels] = await connection.query('SELECT * FROM channels WHERE shortname = ?', [shortname]);
    if (channels.length === 0) {
      connection.release();
      return res.status(404).send('Channel not found');
    }
    const channel = channels[0];

    const [commentCountRows] = await connection.query('SELECT COUNT(*) as cnt FROM channel_comments WHERE channel_id = ? AND is_hidden = 0', [channel.id]);
    const totalComments = commentCountRows[0].cnt;
    const commentsTotalPages = Math.ceil(totalComments / cperPage);

    const [commentsRows] = await connection.query(`
      SELECT c.id, c.text, c.created_at, u.id as user_id, u.username, u.avatar 
      FROM channel_comments c 
      JOIN users u ON c.user_id = u.id 
      WHERE c.channel_id = ? AND c.is_hidden = 0
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `, [channel.id, cperPage, coffset]);

    connection.release();

    res.render('partials/channel_comments_list', {
      comments: commentsRows,
      cpage,
      commentsTotalPages,
      user: req.session.user,
      channel: channel
    });
  } catch (e) {
    console.error('Error in channel comments html:', e);
    res.status(500).send('Error');
  }
});

router.get('/api/channels/:shortname/comments_count', async (req, res) => {
  const { shortname } = req.params;
  try {
    const [channels] = await pool.query('SELECT id FROM channels WHERE shortname = ?', [shortname]);
    if (channels.length === 0) return res.json({ success: false, error: 'Channel not found' });
    const [countRows] = await pool.query('SELECT COUNT(*) as cnt FROM channel_comments WHERE channel_id = ? AND is_hidden = 0', [channels[0].id]);
    res.json({ success: true, count: countRows[0].cnt });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/api/channels/:shortname/comment', requireAuth, async (req, res) => {
  const { shortname } = req.params;
  const { text } = req.body;
  if (!text || !text.trim()) return res.json({ success: false, error: 'Text is empty' });

  try {
    const connection = await pool.getConnection();
    const [channels] = await connection.query('SELECT id FROM channels WHERE shortname = ?', [shortname]);
    if (channels.length === 0) {
      connection.release();
      return res.status(404).json({ success: false, error: 'Channel not found' });
    }
    let commentText = text.trim();
    if (commentText.length > 300) commentText = commentText.substring(0, 300);

    await connection.query('INSERT INTO channel_comments (channel_id, user_id, text) VALUES (?, ?, ?)', [channels[0].id, req.session.user.id, commentText]);
    
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('user', req.session.user.username, `Оставил комментарий к каналу (ID: ${channels[0].id}) на странице записей`, userIp);

    connection.release();
    res.json({ success: true });
  } catch (e) {
    console.error('Error adding channel comment:', e);
    res.json({ success: false, error: 'Server error' });
  }
});

router.delete('/api/channels/:shortname/comment/:id', requireAuth, async (req, res) => {
  const { shortname, id } = req.params;
  try {
    const connection = await pool.getConnection();
    const [comments] = await connection.query('SELECT c.user_id, ch.user_id as owner_id FROM channel_comments c JOIN channels ch ON c.channel_id = ch.id WHERE c.id = ?', [id]);
    if (comments.length === 0) {
      connection.release();
      return res.json({ success: false, error: 'Comment not found' });
    }
    const comment = comments[0];
    const role = req.session.user.role || 'registered';
    if (req.session.user.id !== comment.user_id && req.session.user.id !== comment.owner_id && role !== 'admin' && role !== 'mod') {
      connection.release();
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    await connection.query('DELETE FROM channel_comments WHERE id = ?', [id]);
    connection.release();
    res.json({ success: true });
  } catch (e) {
    console.error('Error deleting channel comment:', e);
    res.json({ success: false, error: 'Server error' });
  }
});

router.get('/api/channels/:id/autopilot_status', async (req, res) => {
  try {
    const channelId = req.params.id;
    const [channels] = await pool.query('SELECT user_id, shortname, autopilot_enabled, autopilot_album_id, autopilot_start_time, is_live, live_title, live_started_at FROM channels WHERE id = ?', [channelId]);

    if (channels.length === 0) {
      console.log(`[AUTOPILOT] Channel ${channelId} not found`);
      return res.json({ active: false });
    }

    let totalPrograms = 0;
    try {
      const [pCountRows] = await pool.query('SELECT COUNT(*) as cnt FROM programs WHERE channel_id = ? AND start_time >= NOW() - INTERVAL 2 HOUR', [channelId]);
      totalPrograms = pCountRows[0].cnt;
    } catch (e) {
      console.error(e);
    }

    const channel = channels[0];
    const isOwner = req.session && req.session.user && req.session.user.id === channel.user_id;

    if (channel.is_live === 1) {
      // Stream is live, override autopilot and return RTMP HLS stream URL
      return res.json({
        active: true,
        is_live: true,
        autopilot_enabled: channel.autopilot_enabled,
        live_title: channel.live_title,
        live_started_at: channel.live_started_at,
        is_owner: isOwner,
        shortname: channel.shortname,
        totalPrograms: totalPrograms,
        // The RTMP server will transcode and serve HLS at this path
        rtmp_url: `${process.env.RTMP_STREAM_URL || 'http://localhost:8080/live'}/${channel.shortname}/index.m3u8`
      });
    }

    if (!channel.autopilot_enabled || !channel.autopilot_album_id) {
      console.log(`[AUTOPILOT] Channel ${channelId} inactive because is_live=${channel.is_live}, enabled=${channel.autopilot_enabled}, album_id=${channel.autopilot_album_id}`);
      return res.json({ active: false, autopilot_enabled: channel.autopilot_enabled, totalPrograms: totalPrograms });
    }

    const [records] = await pool.query(`
      SELECT r.id, r.title, r.video_url, r.hls_url, r.duration, ar.order_index 
      FROM album_records ar 
      JOIN records r ON ar.record_id = r.id 
      WHERE ar.album_id = ? AND ((r.video_url IS NOT NULL AND r.video_url != '') OR (r.hls_url IS NOT NULL AND r.hls_url != ''))
      ORDER BY ar.order_index ASC, ar.created_at ASC
    `, [channel.autopilot_album_id]);

    if (records.length === 0) {
      console.log(`[AUTOPILOT] Album ${channel.autopilot_album_id} has no valid records`);
      return res.json({ active: false, totalPrograms: totalPrograms });
    }

    let totalDuration = 0;
    for (const rec of records) {
      if (!rec.duration || rec.duration <= 0) rec.duration = 3600; // 1 hour fallback
      totalDuration += rec.duration;
    }

    const startTime = new Date(channel.autopilot_start_time || Date.now()).getTime();
    const now = Date.now();
    let deltaSecs = Math.floor((now - startTime) / 1000);

    if (deltaSecs < 0) deltaSecs = 0;

    let currentOffset = deltaSecs % totalDuration;

    let currentVideo = null;
    let offsetInVideo = 0;

    let runningSum = 0;
    for (const rec of records) {
      const dur = rec.duration || 0;
      if (currentOffset >= runningSum && currentOffset < runningSum + dur) {
        currentVideo = rec;
        offsetInVideo = currentOffset - runningSum;
        break;
      }
      runningSum += dur;
    }

    if (!currentVideo) {
      currentVideo = records[0];
      offsetInVideo = 0;
    }

        const nextUpdateIn = (currentVideo.duration || 0) - offsetInVideo;

    res.json({
      active: true,
      autopilot_enabled: channel.autopilot_enabled,
      video: {
        id: currentVideo.id,
        title: currentVideo.title,
        video_url: currentVideo.video_url ? `${process.env.CDN_BASE_URL || ''}${currentVideo.video_url}` : null,
        hls_url: currentVideo.hls_url ? `${process.env.CDN_BASE_URL || ''}${currentVideo.hls_url}` : null,
        duration: currentVideo.duration
      },
      offset: offsetInVideo,
      nextUpdateIn: nextUpdateIn,
      totalPrograms: totalPrograms
    });

  } catch (e) {
    console.error('[AUTOPILOT] Error:', e);
    res.json({ active: false, error: e.message, totalPrograms: 0 });
  }
});

module.exports = router;

