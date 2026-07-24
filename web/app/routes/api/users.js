const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const { requireAuth } = require('../../../middlewares/auth');

router.get('/api/users/search', requireAuth, async (req, res) => {
  const q = req.query.q || '';
  if (q.length < 1) return res.json([]);

  try {
    const connection = await pool.getConnection();
    const searchPattern = q + '%';
    const [users] = await connection.query('SELECT id, username, avatar FROM users WHERE username LIKE ? AND id != ? AND deleted_at IS NULL AND is_banned = 0 LIMIT 10', [searchPattern, req.session.user.id]);
    connection.release();
    res.json(users);
  } catch (e) {
    res.status(500).json([]);
  }
});

module.exports = router;
