const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const sendSystemMessage = require('../utils/systemMessage');
const { logAction } = require('../utils/logger');

// GET /news - List all channel news with pagination and search
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
      whereClause = 'WHERE n.title LIKE ? OR n.content LIKE ? OR n.announce LIKE ?';
      searchParam = `%${search}%`;
      queryParams.push(searchParam, searchParam, searchParam);
    }

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as count 
      FROM channel_news n 
      ${whereClause}
    `;
    const [countRows] = await pool.query(countQuery, queryParams);
    const totalCount = countRows[0].count;

    // Get hidden count
    const hiddenCountQuery = `
      SELECT COUNT(*) as count 
      FROM channel_news n 
      WHERE is_hidden = 1 ${search ? 'AND (n.title LIKE ? OR n.content LIKE ? OR n.announce LIKE ?)' : ''}
    `;
    const [hiddenCountRows] = await pool.query(hiddenCountQuery, search ? [searchParam, searchParam, searchParam] : []);
    const hiddenCount = hiddenCountRows[0].count;

    // Get news items with channel info
    const newsQuery = `
      SELECT n.*, c.name as channel_name, c.logo_url, c.status as channel_status, u.is_banned as user_is_banned, c.shortname
      FROM channel_news n
      LEFT JOIN channels c ON n.channel_id = c.id
      LEFT JOIN users u ON c.user_id = u.id
      ${whereClause}
      ORDER BY n.created_at DESC
      LIMIT ? OFFSET ?
    `;
    
    // pagination params at the end
    const finalParams = [...queryParams, limit, offset];
    const [newsItems] = await pool.query(newsQuery, finalParams);

    const totalPages = Math.ceil(totalCount / limit);

    res.render('news', {
      currentPath: req.originalUrl.split('?')[0],
      pageTitle: 'Новости | Админ-панель',
      newsItems,
      page,
      limit,
      totalPages,
      totalCount,
      hiddenCount,
      search,
      user: req.session.user
    });

  } catch (error) {
    console.error('Error fetching news:', error);
    res.status(500).send('Internal Server Error');
  }
});

// POST /news/:id/hide - Toggle hide status
router.post('/:id/hide', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Fetch current status and channel/user status
    const [newsRows] = await pool.query(`
      SELECT n.is_hidden, n.title, c.status as channel_status, u.is_banned as user_is_banned, c.user_id, c.name as channel_name
      FROM channel_news n
      LEFT JOIN channels c ON n.channel_id = c.id
      LEFT JOIN users u ON c.user_id = u.id
      WHERE n.id = ?
    `, [id]);

    if (newsRows.length === 0) {
      req.session.error_msg = 'Новость не найдена';
      return res.redirect('back');
    }

    const news = newsRows[0];
    const newHiddenStatus = !news.is_hidden;

    // If trying to unhide, check if channel/user is banned
    if (!newHiddenStatus) {
      if (news.channel_status === 'banned' || news.user_is_banned) {
        req.session.error_msg = 'Нельзя показать новость: канал или владелец заблокирован';
        return res.redirect('back');
      }
    }

    await pool.query('UPDATE channel_news SET is_hidden = ? WHERE id = ?', [newHiddenStatus ? 1 : 0, id]);
    
    // Notify channel owner
    if (news.user_id) {
      const action = newHiddenStatus ? 'скрыта' : 'восстановлена';
      const msg = `Ваша новость "${news.title}" на телеканале "${news.channel_name}" была ${action} администрацией платформы.`;
      await sendSystemMessage(news.user_id, msg);
    }

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, newHiddenStatus ? `Скрыл новость "${news.title}" (ID: ${id}) телеканала "${news.channel_name}"` : `Восстановил новость "${news.title}" (ID: ${id}) телеканала "${news.channel_name}"`, userIp);

    req.session.success_msg = newHiddenStatus ? 'Новость скрыта' : 'Новость теперь отображается';
    res.redirect('back');
    
  } catch (error) {
    console.error('Error toggling news hide status:', error);
    req.session.error_msg = 'Ошибка сервера';
    res.redirect('back');
  }
});

// POST /news/:id/delete - Hard delete
router.post('/:id/delete', async (req, res) => {
  if (req.session.user && !req.session.user.is_superadmin && req.session.user.staff_role === 'moderator') return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  try {
    const { id } = req.params;
    
    // Fetch user_id before deleting
    const [newsRows] = await pool.query(`
      SELECT c.user_id, n.title, c.name 
      FROM channel_news n
      JOIN channels c ON n.channel_id = c.id
      WHERE n.id = ?
    `, [id]);

    await pool.query('DELETE FROM channel_news WHERE id = ?', [id]);
    
    // Notify channel owner
    if (newsRows.length > 0 && newsRows[0].user_id) {
      const msg = `Ваша новость "${newsRows[0].title}" на телеканале "${newsRows[0].name}" была удалена администрацией платформы.`;
      await sendSystemMessage(newsRows[0].user_id, msg);
    }

    const nTitle = newsRows.length > 0 ? newsRows[0].title : 'Unknown';
    const cName = newsRows.length > 0 ? newsRows[0].name : 'Unknown';
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, `Полностью удалил новость "${nTitle}" (ID: ${id}) телеканала "${cName}"`, userIp);

    req.session.success_msg = 'Новость полностью удалена';
    res.redirect('back');
  } catch (error) {
    console.error('Error deleting news:', error);
    req.session.error_msg = 'Ошибка сервера при удалении';
    res.redirect('back');
  }
});

// POST /news/:id/edit - Edit news
router.post('/:id/edit', async (req, res) => {
  if (!req.session.user.is_superadmin && req.session.user.staff_role === 'moderator') {
    return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  }
  try {
    const { id } = req.params;
    const { title, announce, content } = req.body;

    if (!title) {
      req.session.error_msg = 'Заголовок не может быть пустым';
      return res.redirect('back');
    }

    await pool.query('UPDATE channel_news SET title = ?, announce = ?, content = ? WHERE id = ?', [title, announce, content, id]);
    
    const [nRows] = await pool.query('SELECT c.name FROM channel_news n JOIN channels c ON n.channel_id = c.id WHERE n.id = ?', [id]);
    const cName = nRows.length > 0 ? nRows[0].name : 'Unknown';
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, `Изменил новость "${title.trim()}" (ID: ${id}) телеканала "${cName}"`, userIp);

    req.session.success_msg = 'Новость успешно обновлена';
    res.redirect('back');
  } catch (error) {
    console.error('Error editing news:', error);
    req.session.error_msg = 'Ошибка сервера при редактировании';
    res.redirect('back');
  }
});

module.exports = router;
