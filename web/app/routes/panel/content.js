const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { formatChatMessage } = require('../../../utils/chatFormatter');
const { pool } = require('../../../config/db');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const emailService = require('../../../emailService');
const { requireAuth } = require('../../../middlewares/auth');
const { panelMiddleware, recordUploadMiddleware, designUploadMiddleware } = require('../../../middlewares/panel');
const { logAction } = require('../../../utils/logger');
const wordFilter = require('../../../utils/wordFilter');
const { getPinnedMessages } = require('../../../utils/pinnedMessages');
const { deletePublicFileIfExists, safeResolvePublic } = require('../../../utils/safePath');

function unlinkRecordFiles(record) {
  const publicRoot = path.join(__dirname, '../../../public');
  if (record.video_url) deletePublicFileIfExists(record.video_url, publicRoot);
  if (record.thumbnail_url) deletePublicFileIfExists(record.thumbnail_url, publicRoot);
  if (record.hls_url) {
    const hlsFile = safeResolvePublic(record.hls_url, publicRoot);
    if (hlsFile) {
      const hlsDir = path.dirname(hlsFile);
      if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true, force: true });
    }
  }
}

router.get('/ru/panel,announces', panelMiddleware, async (req, res) => {
  const channelId = res.locals.panelChannel.id;
  try {
    const [programs] = await pool.query('SELECT * FROM programs WHERE channel_id = ? ORDER BY start_time ASC', [channelId]);
    res.render('panel/announces', { activeMenu: 'announces', activeSubmenu: '', breadcrumbs: '<a href="/panel,dashboard">Панель управления</a> &gt; Анонсы', programs });
  } catch (err) {
    console.error('Error fetching programs:', err);
    res.status(500).send('Database error');
  }
});

router.get('/ru/panel,news', panelMiddleware, async (req, res) => {
  const channelId = res.locals.panelChannel.id;
  try {
    const connection = await pool.getConnection();
    const [news] = await connection.query('SELECT * FROM channel_news WHERE channel_id = ? ORDER BY created_at DESC', [channelId]);
    connection.release();
    res.render('panel/news', { activeMenu: 'news', activeSubmenu: '', breadcrumbs: '<a href="/panel,dashboard">Панель управления</a> &gt; Новости', newsList: news });
  } catch (e) {
    console.error('Error fetching news for panel:', e);
    res.status(500).send('Database error');
  }
});

router.post('/ru/panel,news,add', panelMiddleware, async (req, res) => {
  const { title, announce, content } = req.body;
  if (announce && announce.length > 100) {
    return res.redirect('/panel,news?error=' + encodeURIComponent('Анонс не должен превышать 100 символов'));
  }
  if (content && content.length > 200) {
    return res.redirect('/panel,news?error=' + encodeURIComponent('Полный текст не должен превышать 200 символов'));
  }
  const channelId = res.locals.panelChannel.id;
  try {
    const filteredTitle = req.session.user.staff_role ? title.trim() : await wordFilter.filter(title.trim());
    const filteredAnnounce = req.session.user.staff_role ? (announce ? announce.trim() : null) : await wordFilter.filter(announce ? announce.trim() : null);
    const filteredContent = req.session.user.staff_role ? (content ? content.trim() : null) : await wordFilter.filter(content ? content.trim() : null);

    const connection = await pool.getConnection();
    await connection.query('INSERT INTO channel_news (channel_id, title, announce, content, author_id) VALUES (?, ?, ?, ?, ?)',
      [channelId, filteredTitle, filteredAnnounce, filteredContent, req.session.user.id]);
    connection.release();
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Добавил новость "${title.trim()}" на канал ${res.locals.panelChannel.shortname}`, userIp);
    res.redirect('/panel,news?success=1');
  } catch (e) {
    console.error('Error adding channel news:', e);
    res.redirect('/panel,news?error=Server Error');
  }
});

router.post('/ru/panel,news,delete/:id', panelMiddleware, async (req, res) => {
  const { id } = req.params;
  const channelId = res.locals.panelChannel.id;
  try {
    const connection = await pool.getConnection();
    await connection.query('DELETE FROM channel_news WHERE id = ? AND channel_id = ?', [id, channelId]);
    connection.release();
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Удалил новость (ID: ${id}) с канала ${res.locals.panelChannel.shortname}`, userIp);
    res.redirect('/panel,news?deleted=1');
  } catch (e) {
    console.error('Error deleting news:', e);
    res.redirect('/panel,news?error=1');
  }
});

router.get('/ru/panel,stat,viewers', panelMiddleware, (req, res) => {
  res.render('panel/stat_viewers', { activeMenu: 'stat', activeSubmenu: 'viewers', breadcrumbs: '<a href="/panel,dashboard">Панель управления</a> &gt; Статистика &gt; Одновременные зрители' });
});

router.get('/ru/panel,stat,audience', panelMiddleware, (req, res) => {
  res.render('panel/stat_audience', { activeMenu: 'stat', activeSubmenu: 'audience', breadcrumbs: '<a href="/panel,dashboard">Панель управления</a> &gt; Статистика &gt; Аудитория' });
});

router.get('/ru/panel,stat,records', panelMiddleware, (req, res) => {
  res.render('panel/stat_records', { activeMenu: 'stat', activeSubmenu: 'records_stat', breadcrumbs: '<a href="/panel,dashboard">Панель управления</a> &gt; Статистика &gt; Статистика всех записей' });
});


module.exports = router;
