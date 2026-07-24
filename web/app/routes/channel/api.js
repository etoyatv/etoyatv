// Channel API routes: unlock, comments API, live master playlist
const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const { requireAuth } = require('../../../middlewares/auth');
const { logAction } = require('../../../utils/logger');
const { verifyChannelPassword, hashChannelPassword } = require('../../../utils/channelPassword');
const { canViewChannelContent } = require('../../../utils/channelAccess');

const UNLOCK_WINDOW_MS = 15 * 60 * 1000;
const UNLOCK_MAX_ATTEMPTS = 10;
const unlockAttempts = new Map();

function getClientIp(req) {
  let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  if (typeof ip === 'string' && ip.includes(',')) ip = ip.split(',')[0].trim();
  return String(ip);
}

function checkUnlockRateLimit(ip, shortname) {
  const key = `${ip}|${String(shortname || '').toLowerCase()}`;
  const now = Date.now();
  let entry = unlockAttempts.get(key);
  if (!entry || now - entry.start > UNLOCK_WINDOW_MS) {
    entry = { start: now, count: 0 };
    unlockAttempts.set(key, entry);
  }
  entry.count += 1;
  return entry.count <= UNLOCK_MAX_ATTEMPTS;
}

router.post('/api/channels/:shortname/unlock', async (req, res) => {
  const { shortname } = req.params;
  const { password } = req.body;
  try {
    const ip = getClientIp(req);
    if (!checkUnlockRateLimit(ip, shortname)) {
      return res.redirect(`/${shortname}?error=` + encodeURIComponent('Слишком много попыток. Подождите 15 минут.'));
    }

    const [channels] = await pool.query('SELECT id, password FROM channels WHERE shortname = ?', [shortname]);
    if (channels.length === 0) return res.status(404).send('Not found');

    const result = await verifyChannelPassword(channels[0].password, password);
    if (result.ok) {
      if (result.needsRehash) {
        const hashed = await hashChannelPassword(password);
        await pool.query('UPDATE channels SET password = ? WHERE id = ?', [hashed, channels[0].id]);
      }
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
      SELECT c.id, c.text, c.created_at, c.user_id,
             COALESCE(u.username, c.author_name, 'Пользователь') AS username,
             CASE WHEN u.id IS NULL THEN '/images/default_user_avatar.png' ELSE u.avatar END AS avatar
      FROM channel_comments c
      LEFT JOIN users u ON c.user_id = u.id
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

    const [bans] = await connection.query(
      'SELECT id FROM channel_bans WHERE channel_id = ? AND user_id = ? AND banned_until > NOW()',
      [channels[0].id, req.session.user.id]
    );
    if (bans.length > 0) {
      connection.release();
      return res.json({ success: false, error: 'Вы заблокированы на этом канале и не можете оставлять комментарии.' });
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

router.get('/api/channels/:id/live_master.m3u8', async (req, res) => {
  try {
    const channelId = req.params.id;
    const [channels] = await pool.query(
      'SELECT id, shortname, is_live, access_level, user_id, password FROM channels WHERE id = ?',
      [channelId]
    );
    if (channels.length === 0) {
      return res.status(404).type('application/vnd.apple.mpegurl').send('#EXTM3U\n');
    }
    if (!canViewChannelContent(req, channels[0])) {
      return res.status(403).type('application/vnd.apple.mpegurl').send('#EXTM3U\n');
    }
    const shortname = String(channels[0].shortname || '').toLowerCase();
    const highBase = (process.env.RTMP_STREAM_URL || 'http://localhost:8080/live').replace(/\/$/, '');
    const cdnBase = (process.env.CDN_BASE_URL || '').replace(/\/$/, '');
    const highUrl = `${highBase}/${shortname}/index.m3u8`;

    let body = '#EXTM3U\n#EXT-X-VERSION:3\n';
    body += '#EXT-X-STREAM-INF:BANDWIDTH=3000000,AVERAGE-BANDWIDTH=2500000,RESOLUTION=1920x1080,NAME="high"\n';
    body += `${highUrl}\n`;

    if (process.env.LIVE_ABR_ENABLED === '1' && cdnBase) {
      const lowUrl = `${cdnBase}/live_abr/${shortname}/low/index.m3u8`;
      body += '#EXT-X-STREAM-INF:BANDWIDTH=750000,AVERAGE-BANDWIDTH=550000,RESOLUTION=640x360,NAME="low"\n';
      body += `${lowUrl}\n`;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.type('application/vnd.apple.mpegurl').send(body);
  } catch (e) {
    console.error('[LIVE ABR] master playlist error:', e);
    return res.status(500).type('application/vnd.apple.mpegurl').send('#EXTM3U\n');
  }
});

module.exports = router;
