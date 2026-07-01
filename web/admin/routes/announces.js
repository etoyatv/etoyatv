const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const sendSystemMessage = require('../utils/systemMessage');
const { logAction } = require('../utils/logger');

// GET /announces - List all channel announces (programs) with pagination and search
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';

    let whereClause = '';
    let queryParams = [];
    let searchParam = '';

    if (search) {
      whereClause = 'WHERE p.title LIKE ? OR p.description LIKE ? OR c.name LIKE ?';
      searchParam = `%${search}%`;
      queryParams.push(searchParam, searchParam, searchParam);
    }

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as count 
      FROM programs p
      JOIN channels c ON p.channel_id = c.id
      ${whereClause}
    `;
    const [countRows] = await pool.query(countQuery, queryParams);
    const totalCount = countRows[0].count;

    // Get hidden count
    const hiddenCountQuery = `
      SELECT COUNT(*) as count 
      FROM programs p
      JOIN channels c ON p.channel_id = c.id
      WHERE p.is_hidden = 1 ${search ? 'AND (p.title LIKE ? OR p.description LIKE ? OR c.name LIKE ?)' : ''}
    `;
    const [hiddenCountRows] = await pool.query(hiddenCountQuery, search ? [searchParam, searchParam, searchParam] : []);
    const hiddenCount = hiddenCountRows[0].count;

    // Get announces with channel info
    const query = `
      SELECT p.*, c.name as channel_name, c.logo_url, c.shortname, c.user_id, c.status as channel_status, u.is_banned as user_is_banned
      FROM programs p
      JOIN channels c ON p.channel_id = c.id
      LEFT JOIN users u ON c.user_id = u.id
      ${whereClause}
      ORDER BY p.start_time ASC
      LIMIT ? OFFSET ?
    `;
    
    const finalParams = [...queryParams, limit, offset];
    const [announcesItems] = await pool.query(query, finalParams);

    const totalPages = Math.ceil(totalCount / limit);

    res.render('announces', {
      currentPath: req.originalUrl.split('?')[0],
      pageTitle: 'Анонсы | Админ-панель',
      announcesItems,
      page,
      limit,
      totalPages,
      totalCount,
      hiddenCount,
      search,
      user: req.session.user
    });

  } catch (error) {
    console.error('Error fetching announces:', error);
    res.status(500).send('Internal Server Error');
  }
});

// POST /announces/:id/delete - Delete an announce
router.post('/:id/delete', async (req, res) => {
  if (req.session.user && !req.session.user.is_superadmin && req.session.user.staff_role === 'moderator') {
    return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  }
  try {
    const { id } = req.params;
    
    // Fetch user_id and details before deleting
    const [rows] = await pool.query(`
      SELECT c.user_id, p.title, c.name as channel_name 
      FROM programs p
      JOIN channels c ON p.channel_id = c.id
      WHERE p.id = ?
    `, [id]);

    if (rows.length === 0) {
      req.session.error_msg = 'Анонс не найден';
      return res.redirect('back');
    }

    await pool.query('DELETE FROM programs WHERE id = ?', [id]);
    
    // Notify channel owner
    if (rows[0].user_id) {
      const msg = `Ваш анонс "${rows[0].title}" на телеканале "${rows[0].channel_name}" был удален администрацией платформы.`;
      await sendSystemMessage(rows[0].user_id, msg);
    }

    const title = rows[0].title;
    const cName = rows[0].channel_name;
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, `Удалил анонс "${title}" (ID: ${id}) телеканала "${cName}"`, userIp);

    req.session.success_msg = 'Анонс полностью удален';
    res.redirect('back');
  } catch (error) {
    console.error('Error deleting announce:', error);
    req.session.error_msg = 'Ошибка сервера при удалении';
    res.redirect('back');
  }
});

// POST /announces/:id/edit - Edit announce
router.post('/:id/edit', async (req, res) => {
  if (req.session.user && !req.session.user.is_superadmin && req.session.user.staff_role === 'moderator') {
    return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  }
  try {
    const { id } = req.params;
    const { title, description, start_time } = req.body;

    if (!title || !start_time) {
      req.session.error_msg = 'Заголовок и время начала не могут быть пустыми';
      return res.redirect('back');
    }

    // Fetch details before editing
    const [rows] = await pool.query(`
      SELECT c.user_id, p.title, c.name as channel_name 
      FROM programs p
      JOIN channels c ON p.channel_id = c.id
      WHERE p.id = ?
    `, [id]);

    if (rows.length === 0) {
      req.session.error_msg = 'Анонс не найден';
      return res.redirect('back');
    }

    await pool.query('UPDATE programs SET title = ?, description = ?, start_time = ? WHERE id = ?', [title, description, start_time, id]);
    
    // Notify channel owner
    if (rows[0].user_id) {
      const msg = `Ваш анонс "${title}" на телеканале "${rows[0].channel_name}" был отредактирован администрацией платформы.`;
      await sendSystemMessage(rows[0].user_id, msg);
    }

    const cName = rows[0].channel_name;
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, `Изменил анонс "${title.trim()}" (ID: ${id}) телеканала "${cName}"`, userIp);

    req.session.success_msg = 'Анонс успешно обновлен';
    res.redirect('back');
  } catch (error) {
    console.error('Error editing announce:', error);
    req.session.error_msg = 'Ошибка сервера при редактировании';
    res.redirect('back');
  }
});


// POST /announces/:id/hide - Toggle hide status
router.post('/:id/hide', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Fetch current status and channel/user status
    const [announceRows] = await pool.query(`
      SELECT p.is_hidden, p.title, c.status as channel_status, u.is_banned as user_is_banned, c.user_id, c.name as channel_name
      FROM programs p
      JOIN channels c ON p.channel_id = c.id
      LEFT JOIN users u ON c.user_id = u.id
      WHERE p.id = ?
    `, [id]);

    if (announceRows.length === 0) {
      req.session.error_msg = 'Анонс не найден';
      return res.redirect('back');
    }

    const announce = announceRows[0];
    const newHiddenStatus = !announce.is_hidden;

    // If trying to unhide, check if channel/user is banned
    if (!newHiddenStatus) {
      if (announce.channel_status === 'banned' || announce.user_is_banned) {
        req.session.error_msg = 'Нельзя показать анонс: канал или владелец заблокирован';
        return res.redirect('back');
      }
    }

    await pool.query('UPDATE programs SET is_hidden = ? WHERE id = ?', [newHiddenStatus ? 1 : 0, id]);
    
    // Notify channel owner
    if (announce.user_id) {
      const action = newHiddenStatus ? 'скрыт' : 'восстановлен';
      const msg = `Ваш анонс "${announce.title}" на телеканале "${announce.channel_name}" был ${action} администрацией платформы.`;
      await sendSystemMessage(announce.user_id, msg);
    }

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, newHiddenStatus ? `Скрыл анонс "${announce.title}" (ID: ${id}) телеканала "${announce.channel_name}"` : `Восстановил анонс "${announce.title}" (ID: ${id}) телеканала "${announce.channel_name}"`, userIp);

    req.session.success_msg = newHiddenStatus ? 'Анонс скрыт' : 'Анонс теперь отображается';
    res.redirect('back');
    
  } catch (error) {
    console.error('Error toggling announce hide status:', error);
    req.session.error_msg = 'Ошибка сервера';
    res.redirect('back');
  }
});

module.exports = router;
