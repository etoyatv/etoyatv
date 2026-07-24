const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const { logAction } = require('../../../utils/logger');
const { requireAuth } = require('../../../middlewares/auth');
const { panelMiddleware } = require('../../../middlewares/panel');

router.post('/api/programs', panelMiddleware, async (req, res) => {
  const { channel_id, title, description, start_time } = req.body;
  if (channel_id != res.locals.panelChannel.id) return res.status(403).json({ error: 'Access denied' });
  try {
    const [result] = await pool.query('INSERT INTO programs (channel_id, title, description, start_time) VALUES (?, ?, ?, ?)', [channel_id, title, description || '', start_time]);
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Создал анонс (ID: ${result.insertId}, Название: ${title})`, userIp);
    res.json({ success: true, id: result.insertId });
  } catch (e) {
    console.error(e);
    res.json({ success: false, error: 'Database error' });
  }
});

router.put('/api/programs/:id', panelMiddleware, async (req, res) => {
  const { id } = req.params;
  const { title, description, start_time } = req.body;
  const channel_id = res.locals.panelChannel.id;
  try {
    const [result] = await pool.query('UPDATE programs SET title = ?, description = ?, start_time = ? WHERE id = ? AND channel_id = ?', [title, description || '', start_time, id, channel_id]);
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Изменил анонс (ID: ${id})`, userIp);
    res.json({ success: result.affectedRows > 0 });
  } catch (e) {
    console.error(e);
    res.json({ success: false, error: 'Database error' });
  }
});

router.delete('/api/programs/:id', panelMiddleware, async (req, res) => {
  const { id } = req.params;
  const channel_id = res.locals.panelChannel.id;
  try {
    const [result] = await pool.query('DELETE FROM programs WHERE id = ? AND channel_id = ?', [id, channel_id]);
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Удалил анонс (ID: ${id})`, userIp);
    res.json({ success: result.affectedRows > 0 });
  } catch (e) {
    console.error(e);
    res.json({ success: false, error: 'Database error' });
  }
});

router.post('/api/report', (req, res) => {
  console.log('--- REPORT RECEIVED ---');
  console.log('Record ID:', req.body.record_id);
  console.log('URL:', req.body.url);
  console.log('User:', req.session.user ? req.session.user.login : 'Guest');
  console.log('-----------------------');
  res.json({ success: true });
});

router.post('/api/channel/live_title', async (req, res) => {
  try {
    if (!req.session || !req.session.user) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const { shortname, title } = req.body;
    if (!shortname || typeof title !== 'string') return res.status(400).json({ success: false, error: 'Bad Request' });
    
    const [channels] = await pool.query('SELECT id, user_id FROM channels WHERE shortname = ?', [shortname]);
    if (channels.length === 0) return res.status(404).json({ success: false, error: 'Channel not found' });
    
    // Check if user is owner
    let isAuthorized = (channels[0].user_id == req.session.user.id);
    
    // If not owner, check if team member with editor/reporter/moderator role
    if (!isAuthorized) {
      const [team] = await pool.query(
        'SELECT id FROM channel_team WHERE channel_id = ? AND user_id = ? AND (is_editor = 1 OR is_reporter = 1 OR is_moderator = 1)',
        [channels[0].id, req.session.user.id]
      );
      if (team.length > 0) isAuthorized = true;
    }
    
    // Or if staff admin
    if (!isAuthorized && req.session.user.staff_role && req.session.user.mask_mode !== 'user_mask') {
      isAuthorized = true;
    }

    if (!isAuthorized) return res.status(403).json({ success: false, error: 'Forbidden' });
    
    await pool.query('UPDATE channels SET live_title = ? WHERE shortname = ?', [title.substring(0, 255), shortname]);
    res.json({ success: true });
  } catch (e) {
    console.error('[API] live_title update error:', e);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

router.post('/api/programs/:id/bookmark', requireAuth, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const programId = req.params.id;
    const userId = req.session.user.id;
    const [existing] = await connection.query('SELECT * FROM personal_schedules WHERE user_id=? AND program_id=?', [userId, programId]);
    if(existing.length > 0) {
      await connection.query('DELETE FROM personal_schedules WHERE user_id=? AND program_id=?', [userId, programId]);
      connection.release();
      res.json({ success: true, action: 'removed' });
    } else {
      await connection.query('INSERT INTO personal_schedules (user_id, program_id) VALUES (?, ?)', [userId, programId]);
      connection.release();
      res.json({ success: true, action: 'added' });
    }
  } catch(e) { 
    console.error('Error toggling schedule:', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

router.get('/api/debug_autopilot/:id', async (req, res) => {
  res.json({ status: 'ok' });
});

router.get('/api/programs', async (req, res) => {
  res.json([]);
});

router.post('/api/programs', requireAuth, async (req, res) => {
  res.json({ success: true });
});

router.put('/api/programs/:id', requireAuth, async (req, res) => {
  res.json({ success: true });
});

router.delete('/api/programs/:id', requireAuth, async (req, res) => {
  res.json({ success: true });
});

router.post('/api/complaints', requireAuth, async (req, res) => {
  const { target_type, target_id, reason } = req.body;
  const reporter_id = req.session.user.id;
  
  if (!target_type || !target_id || !reason) {
    return res.status(400).json({ success: false, error: 'Все поля обязательны' });
  }

  // Check if reporter is report_banned
  try {
    const connection = await pool.getConnection();
    const [users] = await connection.query('SELECT report_banned_until FROM users WHERE id = ?', [reporter_id]);
    
    if (users.length > 0 && users[0].report_banned_until && new Date(users[0].report_banned_until) > new Date()) {
      // User is shadowbanned, pretend it succeeded
      connection.release();
      return res.json({ success: true, message: 'Жалоба успешно отправлена' });
    }
    
    let targetContent = null;
    if (target_type === 'pm') {
      const [r] = await connection.query('SELECT content FROM messages WHERE id = ?', [target_id]);
      if (r.length) targetContent = r[0].content;
    } else if (target_type === 'channel_comment') {
      const [r] = await connection.query('SELECT text FROM channel_comments WHERE id = ?', [target_id]);
      if (r.length) targetContent = r[0].text;
    } else if (target_type === 'record_comment') {
      const [r] = await connection.query('SELECT text FROM record_comments WHERE id = ?', [target_id]);
      if (r.length) targetContent = r[0].text;
    } else if (target_type === 'profile_comment') {
      const [r] = await connection.query('SELECT text FROM profile_comments WHERE id = ?', [target_id]);
      if (r.length) targetContent = r[0].text;
    }

    // Insert complaint
    await connection.query(
      'INSERT INTO complaints (reporter_id, target_type, target_id, reason, target_content) VALUES (?, ?, ?, ?, ?)',
      [reporter_id, target_type, target_id, reason.substring(0, 200), targetContent]
    );
    connection.release();
    
    res.json({ success: true, message: 'Жалоба успешно отправлена' });
  } catch (e) {
    console.error('Error submitting complaint:', e);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

router.get('/api/admin/check-media-server', async (req, res) => {
  if (!req.session.user || !['admin', 'moderator', 'mod'].includes(req.session.user.staff_role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const { isServerAlive } = require('../../../utils/mediaServer');
    const alive = await isServerAlive();
    if (alive) {
      return res.json({ success: true, message: 'Подключение к медиасерверу успешно выполнено' });
    } else {
      return res.json({ success: false, message: 'Медиасервер не отвечает на запросы' });
    }
  } catch (error) {
    return res.json({ success: false, message: `Ошибка подключения к медиасерверу: ${error.message}` });
  }
});



router.post('/api/set-lang', (req, res) => {
  const { lang } = req.body;
  const supportedLangs = req.supportedLangs || ['ru', 'en', 'uk', 'be'];
  if (supportedLangs.includes(lang)) {
    req.session.lang = lang;
    res.cookie('lang', lang, { maxAge: 31536000000, httpOnly: true });
    if (req.session && req.session.user) {
      req.session.user.lang = lang;
      pool.query('UPDATE users SET lang = ? WHERE id = ?', [lang, req.session.user.id])
        .then(() => {
          req.session.save((err) => {
            if (err) console.error('Failed to save session:', err);
            res.json({ success: true });
          });
        })
        .catch(err => {
          console.error('Failed to save user lang to DB:', err);
          req.session.save((err) => {
            if (err) console.error('Failed to save session:', err);
            res.json({ success: true });
          });
        });
      return;
    }
    if (req.session) {
      req.session.save((err) => {
        if (err) console.error('Failed to save session:', err);
        res.json({ success: true });
      });
      return;
    }
    return res.json({ success: true });
  }
  res.status(400).json({ error: 'Unsupported language' });
});

module.exports = router;
