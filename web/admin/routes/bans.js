const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { logAction } = require('../utils/logger');

async function checkAccess(req) {
  if (!req.session.user) return false;
  const connection = await pool.getConnection();
  const [rows] = await connection.query('SELECT role, is_superadmin FROM staff WHERE user_id = ?', [req.session.user.id]);
  connection.release();
  if (rows.length === 0) return false;
  return rows[0].role === 'moderator' || rows[0].role === 'admin' || rows[0].is_superadmin;
}

async function checkAdminAccess(req) {
  if (!req.session.user) return false;
  const connection = await pool.getConnection();
  const [rows] = await connection.query('SELECT role, is_superadmin FROM staff WHERE user_id = ?', [req.session.user.id]);
  connection.release();
  if (rows.length === 0) return false;
  return rows[0].role === 'admin' || rows[0].is_superadmin;
}

// User Bans List
router.get('/bans/users', async (req, res) => {
  try {
    if (!(await checkAccess(req))) return res.status(403).render('error', { status: 403, title: 'Доступ запрещен', message: 'Недостаточно прав' });
    
    const { search } = req.query;
    let query = `
      SELECT u.id, u.username, u.email, u.ban_reason, u.banned_until,
             a.username as banned_by_username
      FROM users u
      LEFT JOIN users a ON u.banned_by = a.id
      WHERE u.is_banned = 1
    `;
    let countQuery = `SELECT COUNT(*) as total FROM users u WHERE u.is_banned = 1`;
    let params = [];

    if (search) {
      if (!isNaN(search)) {
        query += ` AND u.id = ?`;
        countQuery += ` AND u.id = ?`;
        params.push(search);
      } else {
        query += ` AND (u.username LIKE ? OR u.email LIKE ?)`;
        countQuery += ` AND (u.username LIKE ? OR u.email LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`);
      }
    }
    
    const limit = parseInt(req.query.limit) || 10;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;

    query += ` ORDER BY u.banned_until ASC LIMIT ? OFFSET ?`;

    const connection = await pool.getConnection();
    const [[{ total }]] = await connection.query(countQuery, params);
    
    params.push(limit, offset);
    const [bans] = await connection.query(query, params);
    connection.release();

    const totalPages = Math.ceil(total / limit);

    res.render('bans-users', {
      currentPath: '/bans/users',
      bans,
      search: search || '',
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

// IP Bans List
router.get('/bans/ip', async (req, res) => {
  try {
    if (!(await checkAdminAccess(req))) return res.status(403).render('error', { status: 403, title: 'Доступ запрещен', message: 'Недостаточно прав' });
    
    const limit = parseInt(req.query.limit) || 10;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;

    const connection = await pool.getConnection();
    const [[{ total }]] = await connection.query('SELECT COUNT(*) as total FROM ip_bans');
    
    const [bans] = await connection.query(`
      SELECT i.*, a.username as banned_by_username
      FROM ip_bans i
      LEFT JOIN users a ON i.banned_by = a.id
      ORDER BY i.created_at DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);
    connection.release();

    const totalPages = Math.ceil(total / limit);

    res.render('bans-ip', {
      currentPath: '/bans/ip',
      bans,
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

// Unban IP
router.post('/bans/ip/:ip/unban', async (req, res) => {
  try {
    if (!(await checkAdminAccess(req))) return res.status(403).render('error', { status: 403, title: 'Доступ запрещен', message: 'Недостаточно прав' });
    
    const ip = req.params.ip;
    const connection = await pool.getConnection();
    await connection.query('DELETE FROM ip_bans WHERE ip_address = ?', [ip]);
    connection.release();
    
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Разблокировал IP: ${ip}`, userIp);
    
    req.session.success_msg = 'IP-адрес успешно разблокирован';
    res.redirect('/bans/ip');
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сервера' });
  }
});

// Add Manual IP Ban
router.post('/bans/ip/add', async (req, res) => {
  try {
    if (!(await checkAdminAccess(req))) return res.status(403).render('error', { status: 403, title: 'Доступ запрещен', message: 'Недостаточно прав' });
    
    const { ip_address, ip_ban_type, reason } = req.body;
    const adminId = req.session.user ? req.session.user.id : null;
    
    if (!ip_address || ip_address.trim() === '') {
      return res.status(400).render('error', { status: 400, title: 'Ошибка', message: 'IP-адрес обязателен.' });
    }
    if (reason && reason.length > 200) {
      return res.status(400).render('error', { status: 400, title: 'Ошибка', message: 'Причина блокировки не может превышать 200 символов.' });
    }
    
    const ipType = ip_ban_type === 'full' ? 'full' : 'account';
    
    const connection = await pool.getConnection();
    
    const { isProtectedIp } = require('../utils/ipChecker');
    const myIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    const protected = await isProtectedIp(connection, ip_address.trim(), myIp);
    
    if (protected) {
      connection.release();
      return res.status(400).render('error', { status: 400, title: 'Ошибка', message: 'Нельзя заблокировать этот IP, так как он принадлежит вам или члену персонала.' });
    }
    await connection.query(
      'INSERT INTO ip_bans (ip_address, banned_by, ban_type, reason) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE banned_by = VALUES(banned_by), ban_type = VALUES(ban_type), reason = VALUES(reason)',
      [ip_address.trim(), adminId, ipType, reason]
    );
    connection.release();
    
    logAction('team', req.session.user.username, `Заблокировал IP: ${ip_address.trim()} (Тип: ${ipType}, Причина: ${reason})`, myIp);
    
    req.session.success_msg = 'IP-адрес успешно заблокирован';
    res.redirect('/bans/ip');
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сервера' });
  }
});

module.exports = router;
