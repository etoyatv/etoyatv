const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { logAction } = require('../utils/logger');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadDir = path.join(__dirname, '../public/uploads/records');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, 'record_' + Date.now() + '_' + Math.floor(Math.random() * 1000) + ext);
  }
});
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2 GB limit
});

// GET /records - List all records
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const search = req.query.q || '';

    let whereClause = '';
    let queryParams = [];
    
    if (search) {
      whereClause = 'WHERE r.title LIKE ? OR r.description LIKE ?';
      const searchParam = `%${search}%`;
      queryParams.push(searchParam, searchParam);
    }

    const countQuery = `SELECT COUNT(*) as count FROM records r ${whereClause}`;
    const [countRows] = await pool.query(countQuery, queryParams);
    const totalCount = countRows[0].count;
    const totalPages = Math.ceil(totalCount / limit) || 1;

    const dataQuery = `
      SELECT r.*, c.name as channel_name 
      FROM records r
      LEFT JOIN channels c ON r.channel_id = c.id
      ${whereClause}
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `;
    const finalParams = [...queryParams, limit, offset];
    const [records] = await pool.query(dataQuery, finalParams);

    res.render('records', {
      currentPath: req.originalUrl.split('?')[0],
      pageTitle: 'Записи | Админ-панель',
      records,
      page,
      limit,
      totalPages,
      totalCount,
      q: search,
      user: req.session.user
    });

  } catch (error) {
    console.error('Error fetching records:', error);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сервера' });
  }
});

// GET /records/:id/edit - Edit record page
router.get('/:id/edit', async (req, res) => {
  if (req.user && !req.user.is_superadmin && req.user.staff_role === 'moderator') return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  try {
    const { id } = req.params;
    const [rows] = await pool.query(`
      SELECT r.*, c.name as channel_name 
      FROM records r
      LEFT JOIN channels c ON r.channel_id = c.id
      WHERE r.id = ?
    `, [id]);

    if (rows.length === 0) {
      req.session.error_msg = 'Запись не найдена';
      return res.redirect('/records');
    }

    const record = rows[0];

    // Calculate sizes from HLS folder depending on stream type
    let sdSize = 0;
    let highSize = 0;
    let lowSize = 0;

    if (record.hls_url) {
      const hlsDir = path.join(__dirname, '../public', path.dirname(record.hls_url));
      
      const getDirSize = (dirPath) => {
        let size = 0;
        if (fs.existsSync(dirPath)) {
          const files = fs.readdirSync(dirPath);
          for (let i = 0; i < files.length; i++) {
            const filePath = path.join(dirPath, files[i]);
            const stats = fs.statSync(filePath);
            if (stats.isFile()) {
              size += stats.size;
            } else if (stats.isDirectory()) {
              size += getDirSize(filePath);
            }
          }
        }
        return size;
      };

      sdSize = getDirSize(path.join(hlsDir, 'sd'));
      highSize = getDirSize(path.join(hlsDir, 'high'));
      lowSize = getDirSize(path.join(hlsDir, 'low'));
    }

    res.render('records-edit', {
      currentPath: '/records',
      pageTitle: 'Редактирование записи',
      record,
      sdSize,
      highSize,
      lowSize,
      user: req.session.user
    });

  } catch (error) {
    console.error('Error loading record edit page:', error);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сервера' });
  }
});

// POST /records/:id/edit - Save changes and optionally replace video
router.post('/:id/edit', upload.single('video'), async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, is_18_plus } = req.body;
    const is18Plus = is_18_plus === 'on' ? 1 : 0;

    if (!title) {
      req.session.error_msg = 'Заголовок не может быть пустым';
      return res.redirect('back');
    }

    if (description && description.length > 200) {
      req.session.error_msg = 'Краткое описание не может превышать 200 символов';
      return res.redirect('back');
    }

    const [rows] = await pool.query('SELECT * FROM records WHERE id = ?', [id]);
    if (rows.length === 0) {
      req.session.error_msg = 'Запись не найдена';
      return res.redirect('/records');
    }
    const oldRecord = rows[0];

    let updates = ['title = ?', 'description = ?', 'is_18_plus = ?'];
    let params = [title.trim(), description ? description.trim() : '', is18Plus];

    // If new video uploaded
    if (req.file) {
      const newVideoUrl = '/uploads/records/' + req.file.filename;
      const newSize = req.file.size;
      const thumbnailFilename = 'thumb_' + path.parse(req.file.filename).name + '.jpg';
      const newThumbnailUrl = '/uploads/records/' + thumbnailFilename;
      
      updates.push('video_url = ?', 'size_bytes = ?', 'thumbnail_url = ?', 'hls_url = NULL', 'processing_status = "pending"');
      params.push(newVideoUrl, newSize, newThumbnailUrl);

      // Delete old video, old thumbnail, and HLS
      if (oldRecord.video_url) {
        const oldVideoPath = path.join(__dirname, '../public', oldRecord.video_url);
        if (fs.existsSync(oldVideoPath)) fs.unlinkSync(oldVideoPath);
      }
      if (oldRecord.thumbnail_url) {
        const oldThumbPath = path.join(__dirname, '../public', oldRecord.thumbnail_url);
        if (fs.existsSync(oldThumbPath)) fs.unlinkSync(oldThumbPath);
      }
      if (oldRecord.hls_url) {
        const oldHlsDir = path.join(__dirname, '../public', path.dirname(oldRecord.hls_url));
        if (fs.existsSync(oldHlsDir)) fs.rmSync(oldHlsDir, { recursive: true, force: true });
      }
    }

    params.push(id);
    await pool.query(`UPDATE records SET ${updates.join(', ')} WHERE id = ?`, params);

    const [cRows] = await pool.query('SELECT name FROM channels WHERE id = ?', [oldRecord.channel_id]);
    const channelName = cRows.length > 0 ? cRows[0].name : 'Unknown';
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, `Изменил видеозапись "${title.trim()}" (ID: ${id}) телеканала "${channelName}"`, userIp);

    req.session.success_msg = 'Запись успешно сохранена';
    res.redirect('/records/' + id + '/edit');

  } catch (error) {
    console.error('Error saving record:', error);
    req.session.error_msg = 'Ошибка сервера при сохранении';
    res.redirect('back');
  }
});

// POST /records/:id/toggle_status - Ban or Unban
router.post('/:id/toggle_status', async (req, res) => {
  try {
    const { id } = req.params;
    const { new_status } = req.body; // expected 'banned' or 'active'

    if (new_status !== 'banned' && new_status !== 'active') {
      req.session.error_msg = 'Неверный статус';
      return res.redirect('back');
    }

    await pool.query('UPDATE records SET status = ? WHERE id = ?', [new_status, id]);
    
    const [rRows] = await pool.query('SELECT r.title, c.name FROM records r JOIN channels c ON r.channel_id = c.id WHERE r.id = ?', [id]);
    const rTitle = rRows.length > 0 ? rRows[0].title : 'Unknown';
    const cName = rRows.length > 0 ? rRows[0].name : 'Unknown';
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, new_status === 'banned' ? `Скрыл видеозапись "${rTitle}" (ID: ${id}) телеканала "${cName}"` : `Восстановил видеозапись "${rTitle}" (ID: ${id}) телеканала "${cName}"`, userIp);

    req.session.success_msg = new_status === 'banned' ? 'Запись скрыта (заблокирована)' : 'Запись восстановлена';
    res.redirect('back');

  } catch (error) {
    console.error('Error toggling record status:', error);
    req.session.error_msg = 'Ошибка сервера';
    res.redirect('back');
  }
});

// POST /records/:id/delete - Full delete
router.post('/:id/delete', async (req, res) => {
  if (req.user && !req.user.is_superadmin && req.user.staff_role === 'moderator') return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  try {
    const { id } = req.params;
    
    const [rows] = await pool.query('SELECT video_url, thumbnail_url, hls_url FROM records WHERE id = ?', [id]);
    
    if (rows.length > 0) {
      const record = rows[0];
      
      if (record.video_url) {
        const videoPath = path.join(__dirname, '../public', record.video_url);
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      }
      if (record.thumbnail_url) {
        const thumbPath = path.join(__dirname, '../public', record.thumbnail_url);
        if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
      }
      if (record.hls_url) {
        const hlsDir = path.join(__dirname, '../public', path.dirname(record.hls_url));
        if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true, force: true });
      }
    }

    const [rRows] = await pool.query('SELECT r.title, c.name FROM records r JOIN channels c ON r.channel_id = c.id WHERE r.id = ?', [id]);
    const rTitle = rRows.length > 0 ? rRows[0].title : 'Unknown';
    const cName = rRows.length > 0 ? rRows[0].name : 'Unknown';

    await pool.query('DELETE FROM album_records WHERE record_id = ?', [id]);
    await pool.query('DELETE FROM records WHERE id = ?', [id]);

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, `Полностью удалил видеозапись "${rTitle}" (ID: ${id}) телеканала "${cName}"`, userIp);

    req.session.success_msg = 'Запись полностью удалена';
    res.redirect('/records');
  } catch (error) {
    console.error('Error deleting record:', error);
    req.session.error_msg = 'Ошибка сервера при удалении';
    res.redirect('back');
  }
});

module.exports = router;
