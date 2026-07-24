// Panel records management
const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const fs = require('fs');
const path = require('path');
const { panelMiddleware, recordUploadMiddleware } = require('../../../middlewares/panel');
const { logAction } = require('../../../utils/logger');
const wordFilter = require('../../../utils/wordFilter');
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

async function renderRecordsPage(req, res, activeSubmenu, title, extraCondition = '') {
  try {
    const channelId = res.locals.panelChannel.id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 10;
    const offset = (page - 1) * limit;
    const searchQuery = req.query.q ? req.query.q.trim() : '';

    let searchCondition = '';
    let queryParamsCount = [channelId];
    let queryParamsData = [channelId];

    if (searchQuery) {
      searchCondition = ' AND title LIKE ?';
      queryParamsCount.push(`%${searchQuery}%`);
      queryParamsData.push(`%${searchQuery}%`);
    }

    const countQuery = `SELECT COUNT(*) as count FROM records WHERE channel_id = ? ${extraCondition} ${searchCondition}`;
    const [countRows] = await pool.query(countQuery, queryParamsCount);
    const totalRecords = countRows[0].count;
    const totalPages = Math.ceil(totalRecords / limit) || 1;

    queryParamsData.push(limit, offset);
    const dataQuery = `SELECT * FROM records WHERE channel_id = ? ${extraCondition} ${searchCondition} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const [records] = await pool.query(dataQuery, queryParamsData);

    res.render('panel/records', {
      activeMenu: 'records',
      activeSubmenu: activeSubmenu,
      breadcrumbs: `<a href="/panel,dashboard">Панель управления</a> &gt; <a href="/panel,records">Медиа-архив</a> &gt; ${title}`,
      records,
      currentPage: page,
      totalPages: totalPages,
      searchQuery
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
}

router.get('/ru/panel,records', panelMiddleware, async (req, res) => {
  await renderRecordsPage(req, res, 'all', 'Все записи');
});

router.get('/ru/panel,records,processing', panelMiddleware, async (req, res) => {
  await renderRecordsPage(req, res, 'processing', 'В обработке', 'AND hls_url IS NULL');
});

router.get('/ru/panel,records,upload', panelMiddleware, (req, res) => {
  res.render('panel/upload', { activeMenu: 'records', activeSubmenu: 'upload', breadcrumbs: '<a href="/panel,dashboard">Панель управления</a> &gt; <a href="/panel,records">Медиа-архив</a> &gt; Загрузить видео' });
});

router.post('/ru/panel,records,delete', panelMiddleware, async (req, res) => {
  const { id } = req.body;
  const channelId = res.locals.panelChannel.id;
  try {
    const [rows] = await pool.query('SELECT video_url, thumbnail_url, hls_url FROM records WHERE id = ? AND channel_id = ?', [id, channelId]);
    if (rows.length > 0) {
      unlinkRecordFiles(rows[0]);
    }

    await pool.query('DELETE FROM records WHERE id = ? AND channel_id = ?', [id, channelId]);
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Удалил запись (ID: ${id}) с канала ${res.locals.panelChannel.shortname}`, userIp);
    res.redirect('/panel,records');
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,records,bulk_delete', panelMiddleware, async (req, res) => {
  const { record_ids } = req.body;
  if (!record_ids) return res.redirect('/panel,records');
  const ids = Array.isArray(record_ids) ? record_ids : [record_ids];
  const channelId = res.locals.panelChannel.id;

  try {
    for (const id of ids) {
      const [rows] = await pool.query('SELECT video_url, thumbnail_url, hls_url FROM records WHERE id = ? AND channel_id = ?', [id, channelId]);
      if (rows.length > 0) {
        unlinkRecordFiles(rows[0]);
        await pool.query('DELETE FROM records WHERE id = ? AND channel_id = ?', [id, channelId]);
        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
        logAction('team', req.session.user.username, `Удалил запись (ID: ${id}) с канала ${res.locals.panelChannel.shortname}`, userIp);
      }
    }
    res.redirect('/panel,records');
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,records,upload', panelMiddleware, recordUploadMiddleware, async (req, res) => {
  if (!req.file) {
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('json'))) {
      return res.status(400).json({ error: 'Файл не загружен.' });
    }
    return res.status(400).send('No file uploaded.');
  }

  let { title, description } = req.body;
  if (description && description.length > 200) description = description.substring(0, 200);

  const filteredTitle = req.session.user.staff_role ? title.trim() : await wordFilter.filter(title.trim());
  const filteredDesc = req.session.user.staff_role ? (description || '') : await wordFilter.filter(description || '');

  const channelId = res.locals.panelChannel.id;
  const videoUrl = '/uploads/records/' + req.file.filename;
  const videoPath = req.file.path;
  const videoSize = req.file.size || 0;
  
  const thumbnailFilename = 'thumb_' + path.parse(req.file.filename).name + '.jpg';
  const thumbnailUrl = '/uploads/records/' + thumbnailFilename;

  try {
    const [channelRows] = await pool.query('SELECT cdn_quota_mb FROM channels WHERE id = ?', [channelId]);
    const quotaMB = channelRows.length > 0 && channelRows[0].cdn_quota_mb ? channelRows[0].cdn_quota_mb : 2048;
    const QUOTA_LIMIT = quotaMB * 1024 * 1024; // Convert MB to bytes

    const [rows] = await pool.query('SELECT SUM(size_bytes) as totalSize FROM records WHERE channel_id = ?', [channelId]);
    const currentTotal = parseInt(rows[0].totalSize || 0);
    if (currentTotal + videoSize > QUOTA_LIMIT) {
      if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      const errMsg = `Превышена квота ${Math.floor(quotaMB / 1024 * 100) / 100} ГБ. Свободно только ${Math.max(0, (QUOTA_LIMIT - currentTotal) / 1024 / 1024).toFixed(2)} MB, а вы пытаетесь загрузить ${(videoSize / 1024 / 1024).toFixed(2)} MB. Пожалуйста, удалите старые видеозаписи в Медиа-архиве.`;
      if (req.xhr || (req.headers.accept && req.headers.accept.includes('json'))) {
        return res.status(400).json({ error: errMsg });
      }
      return res.status(400).send(errMsg);
    }

    const [result] = await pool.query(
      'INSERT INTO records (channel_id, title, description, video_url, thumbnail_url, duration, size_bytes, processing_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [channelId, filteredTitle, filteredDesc, videoUrl, thumbnailUrl, 0, req.file.size, 'pending']
    );

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Создал новую запись (ID: ${result.insertId}, Название: "${title.trim()}") на канале ${res.locals.panelChannel.shortname}`, userIp);

    if (req.xhr || (req.headers.accept && req.headers.accept.includes('json'))) {
      return res.json({ success: true, redirect: '/panel,records' });
    }
    res.redirect('/panel,records');
  } catch (err) {
    console.error('Error uploading record:', err);
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('json'))) {
      return res.status(500).json({ error: 'Внутренняя ошибка сервера при сохранении записи.' });
    }
    res.status(500).send('Internal Server Error');
  }
});

router.get('/ru/panel,records,edit', panelMiddleware, async (req, res) => {
  const channelId = res.locals.panelChannel.id;
  const recordId = req.query.id;
  if (!recordId) return res.redirect('/panel,records');

  try {
    const [records] = await pool.query('SELECT * FROM records WHERE id = ? AND channel_id = ?', [recordId, channelId]);
    if (records.length === 0) return res.redirect('/panel,records');

    const [allowedUsers] = await pool.query(
      `SELECT rp.user_id, u.username 
       FROM record_permissions rp 
       JOIN users u ON rp.user_id = u.id 
       WHERE rp.record_id = ?`,
      [recordId]
    );

    res.render('panel/edit', {
      record: records[0],
      allowedUsers: allowedUsers
    });
  } catch (e) {
    console.error('Error fetching record for edit:', e);
    res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,records,edit', panelMiddleware, async (req, res) => {
  const channelId = res.locals.panelChannel.id;
  const { id, title, description, is_18_plus, access_level, allowed_users } = req.body;
  if (!id || !title) return res.redirect('/panel,records');

  const is18Plus = is_18_plus === 'on' ? 1 : 0;
  const validAccess = ['public', 'unlisted', 'private'];
  const accessLevel = validAccess.includes(access_level) ? access_level : 'public';

  try {
    const filteredTitle = req.session.user.staff_role ? title.trim() : await wordFilter.filter(title.trim());
    const filteredDesc = req.session.user.staff_role ? (description ? description.trim() : '') : await wordFilter.filter(description ? description.trim() : '');

    const connection = await pool.getConnection();

    await connection.query('UPDATE records SET title = ?, description = ?, is_18_plus = ?, access_level = ? WHERE id = ? AND channel_id = ?', 
      [filteredTitle, filteredDesc, is18Plus, accessLevel, id, channelId]);

    // Update permissions list
    await connection.query('DELETE FROM record_permissions WHERE record_id = ?', [id]);

    if (accessLevel === 'private' && allowed_users) {
      const uids = allowed_users.split(',')
        .map(u => parseInt(u.trim()))
        .filter(u => !isNaN(u));
      
      if (uids.length > 0) {
        const [validUsers] = await connection.query('SELECT id FROM users WHERE id IN (?) AND deleted_at IS NULL', [uids]);
        const validIds = validUsers.map(v => v.id);

        if (validIds.length > 0) {
          const insertData = validIds.map(uid => [id, uid]);
          await connection.query('INSERT IGNORE INTO record_permissions (record_id, user_id) VALUES ?', [insertData]);
        }
      }
    }

    connection.release();
    
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Изменил данные видеозаписи (ID: ${id})`, userIp);

    res.redirect('/panel,records');
  } catch (e) {
    console.error('Error updating record:', e);
    res.status(500).send('Server Error');
  }
});

module.exports = router;
