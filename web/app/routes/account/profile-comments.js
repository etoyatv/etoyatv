const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const { requireAuth } = require('../../../middlewares/auth');
const wordFilter = require('../../../utils/wordFilter');
const { logAction } = require('../../../utils/logger');
const { hasProfileAccess } = require('./privacy');

router.get('/api/profiles/:username/comments_html', async (req, res) => {
  const { username } = req.params;
  const cpage = parseInt(req.query.cpage) || 1;
  const cperPage = 7;
  const coffset = (cpage - 1) * cperPage;

  try {
    const connection = await pool.getConnection();
    const [users] = await connection.query('SELECT * FROM users WHERE username = ?', [username]);
    if (users.length === 0) {
      connection.release();
      return res.status(404).send('User not found');
    }
    const profileUser = users[0];
    if (!(await hasProfileAccess(req.session.user, profileUser))) {
      connection.release();
      return res.status(403).send('Access denied');
    }

    const [commentCountRows] = await connection.query('SELECT COUNT(*) as cnt FROM profile_comments WHERE profile_user_id = ? AND is_hidden = 0', [profileUser.id]);
    const totalComments = commentCountRows[0].cnt;
    const commentsTotalPages = Math.ceil(totalComments / cperPage);

    const [commentsRows] = await connection.query(`
      SELECT c.id, c.text, c.created_at, u.id as user_id, u.username, u.avatar 
      FROM profile_comments c 
      JOIN users u ON c.author_id = u.id 
      WHERE c.profile_user_id = ? AND c.is_hidden = 0
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `, [profileUser.id, cperPage, coffset]);

    connection.release();

    res.render('partials/profile_comments_list', {
      comments: commentsRows,
      cpage,
      commentsTotalPages,
      user: req.session.user,
      profileUser: profileUser
    });
  } catch (e) {
    console.error('Error in profile comments html:', e);
    res.status(500).send('Error');
  }
});

router.get('/api/profiles/:username/comments_count', async (req, res) => {
  const { username } = req.params;
  try {
    const [users] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
    if (users.length === 0) return res.json({ success: false, error: 'User not found' });
    if (!(await hasProfileAccess(req.session.user, users[0]))) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    const [countRows] = await pool.query('SELECT COUNT(*) as cnt FROM profile_comments WHERE profile_user_id = ? AND is_hidden = 0', [users[0].id]);
    res.json({ success: true, count: countRows[0].cnt });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/api/profiles/:username/comment', requireAuth, async (req, res) => {
  const { username } = req.params;
  const { text } = req.body;
  if (!text || !text.trim()) return res.json({ success: false, error: 'Text is empty' });

  try {
    const connection = await pool.getConnection();
    const [users] = await connection.query('SELECT * FROM users WHERE username = ?', [username]);
    if (users.length === 0) {
      connection.release();
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    if (!(await hasProfileAccess(req.session.user, users[0]))) {
      connection.release();
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    let commentText = text.trim();
    if (commentText.length > 300) commentText = commentText.substring(0, 300);

    const filteredComment = req.session.user.staff_role ? commentText : await wordFilter.filter(commentText);

    await connection.query('INSERT INTO profile_comments (profile_user_id, author_id, text) VALUES (?, ?, ?)', [users[0].id, req.session.user.id, filteredComment]);

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('user', req.session.user.username, `Оставил комментарий в профиле пользователя ${username}: "${filteredComment}"`, userIp);

    connection.release();
    res.json({ success: true });
  } catch (e) {
    console.error('Error adding profile comment:', e);
    res.json({ success: false, error: 'Server error' });
  }
});

router.delete('/api/profiles/:username/comment/:id', requireAuth, async (req, res) => {
  const { username, id } = req.params;
  try {
    const connection = await pool.getConnection();
    const [comments] = await connection.query('SELECT author_id, profile_user_id FROM profile_comments WHERE id = ?', [id]);
    if (comments.length === 0) {
      connection.release();
      return res.json({ success: false, error: 'Comment not found' });
    }
    const comment = comments[0];
    const staffRole = req.session.user.staff_role || '';
    const isStaff = ['admin', 'moderator', 'mod'].includes(staffRole);

    if (req.session.user.id !== comment.author_id && req.session.user.id !== comment.profile_user_id && !isStaff) {
      connection.release();
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    await connection.query('DELETE FROM profile_comments WHERE id = ?', [id]);
    connection.release();
    res.json({ success: true });
  } catch (e) {
    console.error('Error deleting profile comment:', e);
    res.json({ success: false, error: 'Server error' });
  }
});

module.exports = router;
