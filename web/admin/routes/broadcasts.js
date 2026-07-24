const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../config/db');
const { logAction } = require('../utils/logger');

// GET /broadcasts - List broadcast history and render form
router.get('/', async (req, res) => {
  if (!req.user?.is_superadmin && req.user?.staff_role === 'moderator') {
    return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ к рассылкам запрещен' });
  }
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const connection = await pool.getConnection();

    // Get total count
    const [countRows] = await connection.query('SELECT COUNT(*) as count FROM system_broadcasts');
    const totalCount = countRows[0].count;

    // Get history
    const [broadcasts] = await connection.query(`
      SELECT b.*, u.username as admin_name 
      FROM system_broadcasts b
      JOIN users u ON b.admin_id = u.id
      ORDER BY b.created_at DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    connection.release();

    // Generate a fresh unique token for this session/form rendering to prevent duplicate submission
    const broadcastToken = crypto.randomUUID();

    const totalPages = Math.ceil(totalCount / limit);

    res.render('broadcasts', {
      currentPath: req.originalUrl.split('?')[0],
      pageTitle: 'Рассылки | Админ-панель',
      broadcasts,
      page,
      limit,
      totalPages,
      totalCount,
      broadcastToken,
      user: req.session.user
    });

  } catch (error) {
    console.error('Error fetching broadcasts history:', error);
    res.status(500).send('Internal Server Error');
  }
});

// POST /broadcasts/send - Queue a new broadcast
router.post('/send', async (req, res) => {
  if (!req.user?.is_superadmin && req.user?.staff_role === 'moderator') {
    return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ к рассылкам запрещен' });
  }
  const { message_text, broadcast_token, send_email } = req.body;
  const shouldSendEmail = send_email === '1' ? 1 : 0;

  if (!message_text || !message_text.trim()) {
    req.session.error_msg = 'Текст сообщения не может быть пустым';
    return res.redirect('/broadcasts');
  }

  if (message_text.length > 400) {
    req.session.error_msg = 'Текст сообщения не должен превышать 400 символов';
    return res.redirect('/broadcasts');
  }

  if (!broadcast_token) {
    req.session.error_msg = 'Отсутствует токен отправки. Пожалуйста, попробуйте еще раз.';
    return res.redirect('/broadcasts');
  }

  let connection;
  try {
    connection = await pool.getConnection();
    const adminId = req.session.user.id;

    // 1. Insert into system_broadcasts with 'pending' status
    // UNIQUE key on broadcast_token will prevent duplicate insertions
    let broadcastId;
    try {
      const [insertResult] = await connection.query(`
        INSERT INTO system_broadcasts (admin_id, message_text, broadcast_token, status, send_email)
        VALUES (?, ?, ?, 'pending', ?)
      `, [adminId, message_text.trim(), broadcast_token, shouldSendEmail]);
      broadcastId = insertResult.insertId;
    } catch (insertError) {
      if (insertError.code === 'ER_DUP_ENTRY') {
        req.session.error_msg = 'Эта рассылка уже была отправлена. Защита от дублирования сработала.';
        connection.release();
        return res.redirect('/broadcasts');
      }
      throw insertError;
    }

    // Log the queueing of the broadcast
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, `Добавил системную рассылку в очередь (ID: ${broadcastId}, почта: ${shouldSendEmail ? 'включена' : 'выключена'}).`, userIp);

    connection.release();

    req.session.success_msg = 'Рассылка успешно добавлена в очередь отправки';
    res.redirect('/broadcasts');

  } catch (error) {
    if (connection) connection.release();
    console.error('Error starting broadcast:', error);
    req.session.error_msg = 'Внутренняя ошибка сервера при запуске рассылки';
    res.redirect('/broadcasts');
  }
});

module.exports = router;
