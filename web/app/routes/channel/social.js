// Channel social interactions: favorites, reports, comments (form), news (form)
const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const { requireAuth } = require('../../../middlewares/auth');
const { logAction } = require('../../../utils/logger');
const wordFilter = require('../../../utils/wordFilter');

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
      SELECT u.id, u.username, u.avatar,
             (u.last_active IS NOT NULL AND UNIX_TIMESTAMP(NOW()) - UNIX_TIMESTAMP(u.last_active) <= 300) as is_online
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

    const [bans] = await connection.query(
      'SELECT id FROM channel_bans WHERE channel_id = ? AND user_id = ? AND banned_until > NOW()',
      [channels[0].id, req.session.user.id]
    );
    if (bans.length > 0) {
      connection.release();
      return res.status(403).send('Вы заблокированы на этом канале и не можете оставлять комментарии.');
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
    return res.redirect('/panel,news?error=' + encodeURIComponent('Title is required'));
  }

  try {
    const connection = await pool.getConnection();
    const [channels] = await connection.query('SELECT id, user_id FROM channels WHERE shortname = ?', [shortname]);
    if (channels.length === 0) {
      connection.release();
      return res.redirect('/panel,news?error=' + encodeURIComponent('Channel not found'));
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
    res.redirect('/panel,news?error=' + encodeURIComponent('Server Error'));
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

module.exports = router;
