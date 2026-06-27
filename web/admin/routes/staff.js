const express = require('express');
const router = express.Router();
const { logAction } = require('../utils/logger');

// Block moderators from /staff entirely
router.use('/staff', (req, res, next) => {
  if (req.user && req.user.staff_role === 'moderator') {
    return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  }
  next();
});

// Autocomplete search
router.get('/api/users/search', async (req, res) => {
  try {
    const { pool } = require('../config/db');
    const q = req.query.q || '';
    if (q.length < 2) return res.json([]);
    
    const connection = await pool.getConnection();
    const [users] = await connection.query(`
      SELECT id, username, avatar 
      FROM users 
      WHERE username LIKE ? AND deleted_at IS NULL
      LIMIT 10
    `, [`%${q}%`]);
    connection.release();
    
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json([]);
  }
});

// View Admins
router.get('/staff/admins', async (req, res) => {
  if (!req.user.is_superadmin) {
    return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Доступ к управлению администраторами разрешен только главным администраторам' });
  }

  try {
    const { pool } = require('../config/db');
    
    const limit = parseInt(req.query.limit) || 10;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;

    const connection = await pool.getConnection();
    const [[{ total }]] = await connection.query(`SELECT COUNT(*) as total FROM staff WHERE role = 'admin'`);

    const [staff] = await connection.query(`
      SELECT s.id as staff_id, s.role, s.is_superadmin, u.id as user_id, u.username, u.avatar 
      FROM staff s
      JOIN users u ON s.user_id = u.id
      WHERE s.role = 'admin'
      LIMIT ? OFFSET ?
    `, [limit, offset]);
    connection.release();

    const totalPages = Math.ceil(total / limit);

    res.render('staff', { tab: 'admins', staff, limit, page, total, totalPages });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { status: 500, title: 'Ошибка сервера', message: 'Произошла непредвиденная ошибка на сервере.' });
  }
});

// View Moderators
router.get('/staff/mods', async (req, res) => {
  try {
    const { pool } = require('../config/db');
    
    const limit = parseInt(req.query.limit) || 10;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;

    const connection = await pool.getConnection();
    const [[{ total }]] = await connection.query(`SELECT COUNT(*) as total FROM staff WHERE role = 'moderator'`);

    const [staff] = await connection.query(`
      SELECT s.id as staff_id, s.role, s.is_superadmin, u.id as user_id, u.username, u.avatar 
      FROM staff s
      JOIN users u ON s.user_id = u.id
      WHERE s.role = 'moderator'
      LIMIT ? OFFSET ?
    `, [limit, offset]);
    connection.release();

    const totalPages = Math.ceil(total / limit);

    res.render('staff', { tab: 'mods', staff, limit, page, total, totalPages });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { status: 500, title: 'Ошибка сервера', message: 'Произошла непредвиденная ошибка на сервере.' });
  }
});

// Grant role
router.post('/staff/grant', async (req, res) => {
  try {
    const { pool } = require('../config/db');
    const { user_id, target_role } = req.body;
    
    // Check permission: ordinary admin cannot grant admin
    if (target_role === 'admin' && !req.user.is_superadmin) {
      return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Только главный администратор может назначать других администраторов' });
    }
    
    const connection = await pool.getConnection();
    
    // Insert or update
    await connection.query(`
      INSERT INTO staff (user_id, role) 
      VALUES (?, ?) 
      ON DUPLICATE KEY UPDATE role = ?
    `, [user_id, target_role, target_role]);
    
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.user.username, `Назначил роль '${target_role}' пользователю (ID: ${user_id})`, userIp);

    connection.release();
    res.redirect('back');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { status: 500, title: 'Ошибка сервера', message: 'Произошла непредвиденная ошибка на сервере.' });
  }
});

// Revoke role
router.post('/staff/revoke/:id', async (req, res) => {
  try {
    const { pool } = require('../config/db');
    const connection = await pool.getConnection();
    
    // Get the target staff member
    const [[target]] = await connection.query('SELECT role, is_superadmin FROM staff WHERE id = ?', [req.params.id]);
    
    if (!target) {
      connection.release();
      return res.status(404).render('error', { status: 404, title: 'Не найдено', message: 'Пользователь или запись не найдена.' });
    }
    
    if (target.is_superadmin) {
      connection.release();
      return res.status(403).render('error', { status: 403, title: 'Действие запрещено', message: 'Нельзя снять с должности главного администратора' });
    }
    
    // Ordinary admins cannot revoke other admins
    if (target.role === 'admin' && !req.user.is_superadmin) {
      connection.release();
      return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Обычный администратор не может снять другого администратора' });
    }
    
    // Delete Telegram notification settings before removing from staff
    await connection.query('DELETE FROM admin_notification_settings WHERE user_id = (SELECT user_id FROM staff WHERE id = ?)', [req.params.id]);

    await connection.query('DELETE FROM staff WHERE id = ?', [req.params.id]);
    
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.user.username, `Снял пользователя с должности (Staff ID: ${req.params.id})`, userIp);

    connection.release();
    
    res.redirect('back');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { status: 500, title: 'Ошибка сервера', message: 'Произошла непредвиденная ошибка на сервере.' });
  }
});

module.exports = router;
