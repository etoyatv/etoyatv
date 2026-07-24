const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');

async function checkAccess(req) {
  if (!req.session.user) return false;
  const connection = await pool.getConnection();
  const [rows] = await connection.query('SELECT role, is_superadmin FROM staff WHERE user_id = ?', [req.session.user.id]);
  connection.release();
  if (rows.length === 0) return false;
  return rows[0].role === 'admin' || rows[0].role === 'moderator' || rows[0].is_superadmin;
}

router.get('/logs', async (req, res) => {
  try {
    if (!(await checkAccess(req))) return res.status(403).render('error', { status: 403, title: 'Доступ запрещен', message: 'Недостаточно прав' });
    
    let { search, category, action_type } = req.query;
    
    const isModOnly = req.user && !req.user.is_superadmin && req.user.staff_role === 'moderator';
    if (isModOnly && category === 'admin') {
      category = 'user';
    }

    const isSuper = req.user && req.user.is_superadmin;

    let query = `
      SELECT l.* FROM system_logs l
      LEFT JOIN users u ON l.username = u.username
      LEFT JOIN staff s ON u.id = s.user_id
      WHERE 1=1
    `;
    let countQuery = `
      SELECT COUNT(*) as total FROM system_logs l
      LEFT JOIN users u ON l.username = u.username
      LEFT JOIN staff s ON u.id = s.user_id
      WHERE 1=1
    `;
    let params = [];

    if (!isSuper) {
      query += ` AND (s.is_superadmin IS NULL OR s.is_superadmin = 0)`;
      countQuery += ` AND (s.is_superadmin IS NULL OR s.is_superadmin = 0)`;
    }

    if (isModOnly) {
      query += ` AND l.log_type != 'admin'`;
      countQuery += ` AND l.log_type != 'admin'`;
    }

    if (search) {
      query += ` AND (l.username LIKE ? OR l.action_text LIKE ? OR l.ip_address LIKE ?)`;
      countQuery += ` AND (l.username LIKE ? OR l.action_text LIKE ? OR l.ip_address LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    
    if (category) {
      query += ` AND l.log_type = ?`;
      countQuery += ` AND l.log_type = ?`;
      params.push(category);
    }
    
    // In our implementation action_type isn't explicitly used as a column, but if it was, we would filter it.
    // Instead we just filter by category
    
    const limit = parseInt(req.query.limit) || 20;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;

    query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;

    const connection = await pool.getConnection();
    const [[{ total }]] = await connection.query(countQuery, params);
    
    params.push(limit, offset);
    const [logs] = await connection.query(query, params);
    connection.release();

    const totalPages = Math.ceil(total / limit);

    res.render('logs', {
      user: req.session.user,
      currentPath: '/logs',
      logs,
      search: search || '',
      category: category || '',
      limit,
      page,
      total,
      totalPages
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сервера' });
  }
});

module.exports = router;
