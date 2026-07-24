const express = require('express');
const router = express.Router();
const { logAction } = require('../../utils/logger');

router.get('/invites', async (req, res) => {
  if (req.user && !req.user.is_superadmin && req.user.staff_role === 'moderator') return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  try {
    const { pool } = require('../../config/db');
    const connection = await pool.getConnection();

    // Check invite system status
    const [rows] = await connection.query('SELECT setting_value FROM system_settings WHERE setting_key = "invite_system_enabled"');
    const invite_system_enabled = rows.length > 0 && rows[0].setting_value === '1';

    if (!invite_system_enabled) {
      connection.release();
      return res.status(404).render('error', { status: 404, title: 'Не найдено', message: 'Система инвайтов отключена.' });
    }

    const [invites] = await connection.query(`
      SELECT i.*, c.username as creator_name, u.username as used_by_name,
             c.deleted_at as creator_deleted_at, c.wipe_date as creator_wipe_date,
             c.is_banned as creator_is_banned, c.banned_until as creator_banned_until
      FROM invite_codes i
      LEFT JOIN users c ON i.creator_id = c.id
      LEFT JOIN users u ON i.used_by_id = u.id
      ORDER BY i.created_at DESC
    `);
    connection.release();
    res.render('invites', { currentPath: '/invites', invites });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка загрузки инвайтов' });
  }
});

router.post('/invites/generate', async (req, res) => {
  if (req.user && !req.user.is_superadmin && req.user.staff_role === 'moderator') return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  try {
    const crypto = require('crypto');
    const code = crypto.randomBytes(6).toString('hex').toUpperCase(); // 12-char code
    const creatorId = req.session.user.id;

    const { pool } = require('../../config/db');
    const connection = await pool.getConnection();
    await connection.query('INSERT INTO invite_codes (code, creator_id) VALUES (?, ?)', [code, creatorId]);
    connection.release();

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, `Создал инвайт код: ${code}`, userIp);

    res.redirect('/invites');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка генерации инвайта' });
  }
});

router.post('/invites/delete/:id', async (req, res) => {
  if (req.user && !req.user.is_superadmin && req.user.staff_role === 'moderator') return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  try {
    const { id } = req.params;
    const { pool } = require('../../config/db');
    const connection = await pool.getConnection();
    await connection.query('DELETE FROM invite_codes WHERE id = ?', [id]);
    connection.release();
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, `Удалил инвайт код (ID: ${id})`, userIp);
    res.redirect('/invites');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка удаления инвайта' });
  }
});

module.exports = router;
