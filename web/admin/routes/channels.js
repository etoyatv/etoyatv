const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { requireAdminAuth } = require('../middlewares/auth');
const sendSystemMessage = require('../utils/systemMessage');
const { logAction } = require('../utils/logger');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

// Setup multer for channel avatars
// Setup multer for channel avatars
let storageRoot = process.env.MEDIA_STORAGE_PATH;
if (storageRoot && !path.isAbsolute(storageRoot)) {
  storageRoot = path.resolve(__dirname, '../../', storageRoot);
} else if (!storageRoot) {
  storageRoot = path.join(__dirname, '../../public');
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = path.join(storageRoot, 'images', 'design');
    console.log('[Admin Avatar Upload] Saving to:', dir);
    if (!fs.existsSync(dir)){
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'channel_' + uniqueSuffix + ext);
  }
});
const imageFilter = (req, file, cb) => {
  const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Invalid file type'));
  }
};

const upload = multer({ 
  storage: storage,
  fileFilter: imageFilter,
  limits: { fileSize: 4 * 1024 * 1024 } // 4MB
});

// GET /channels - List all channels
router.get('/channels', requireAdminAuth, async (req, res) => {
  const query = req.query.q || '';
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  try {
    const connection = await pool.getConnection();
    
    let countRows, channelsRows;
    if (query.trim() === '') {
      [countRows] = await connection.query('SELECT COUNT(*) as count FROM channels');
      [channelsRows] = await connection.query(`
        SELECT c.*, u.username as owner_username 
        FROM channels c
        JOIN users u ON c.user_id = u.id
        ORDER BY c.id DESC LIMIT ? OFFSET ?
      `, [limit, offset]);
    } else {
      const searchPattern = '%' + query + '%';
      [countRows] = await connection.query('SELECT COUNT(*) as count FROM channels WHERE name LIKE ? OR shortname LIKE ?', [searchPattern, searchPattern]);
      [channelsRows] = await connection.query(`
        SELECT c.*, u.username as owner_username 
        FROM channels c
        JOIN users u ON c.user_id = u.id
        WHERE c.name LIKE ? OR c.shortname LIKE ?
        ORDER BY c.id DESC LIMIT ? OFFSET ?
      `, [searchPattern, searchPattern, limit, offset]);
    }
    
    connection.release();

    const totalCount = countRows[0].count;
    const totalPages = Math.ceil(totalCount / limit) || 1;

    res.render('channels', {
      pageTitle: 'Все каналы | Админ-панель',
      channels: channelsRows,
      q: query,
      page,
      limit,
      totalPages,
      totalCount,
      baseUrl: '/channels'
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Internal Server Error');
  }
});

// GET /channels/banned - List all banned channels
router.get('/channels/banned', requireAdminAuth, async (req, res) => {
  const query = req.query.q || '';
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  try {
    const connection = await pool.getConnection();
    
    let countRows, channelsRows;
    if (query.trim() === '') {
      [countRows] = await connection.query('SELECT COUNT(*) as count FROM channels WHERE status = "banned"');
      [channelsRows] = await connection.query(`
        SELECT c.*, u.username as owner_username 
        FROM channels c
        JOIN users u ON c.user_id = u.id
        WHERE c.status = 'banned'
        ORDER BY c.id DESC LIMIT ? OFFSET ?
      `, [limit, offset]);
    } else {
      const searchPattern = '%' + query + '%';
      [countRows] = await connection.query('SELECT COUNT(*) as count FROM channels WHERE status = "banned" AND (name LIKE ? OR shortname LIKE ?)', [searchPattern, searchPattern]);
      [channelsRows] = await connection.query(`
        SELECT c.*, u.username as owner_username 
        FROM channels c
        JOIN users u ON c.user_id = u.id
        WHERE c.status = 'banned' AND (c.name LIKE ? OR c.shortname LIKE ?)
        ORDER BY c.id DESC LIMIT ? OFFSET ?
      `, [searchPattern, searchPattern, limit, offset]);
    }
    
    connection.release();

    const totalCount = countRows[0].count;
    const totalPages = Math.ceil(totalCount / limit) || 1;

    res.render('channels', {
      pageTitle: 'Заблокированные каналы | Админ-панель',
      channels: channelsRows,
      q: query,
      page,
      limit,
      totalPages,
      totalCount,
      baseUrl: '/channels/banned'
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Internal Server Error');
  }
});

// GET /channels/deleted - List all deleted channels
router.get('/channels/deleted', requireAdminAuth, async (req, res) => {
  const query = req.query.q || '';
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  try {
    const connection = await pool.getConnection();
    
    let countRows, channelsRows;
    if (query.trim() === '') {
      [countRows] = await connection.query('SELECT COUNT(*) as count FROM channels WHERE status = "deleted"');
      [channelsRows] = await connection.query(`
        SELECT c.*, u.username as owner_username 
        FROM channels c
        JOIN users u ON c.user_id = u.id
        WHERE c.status = 'deleted'
        ORDER BY c.id DESC LIMIT ? OFFSET ?
      `, [limit, offset]);
    } else {
      const searchPattern = '%' + query + '%';
      [countRows] = await connection.query('SELECT COUNT(*) as count FROM channels WHERE status = "deleted" AND (name LIKE ? OR shortname LIKE ?)', [searchPattern, searchPattern]);
      [channelsRows] = await connection.query(`
        SELECT c.*, u.username as owner_username 
        FROM channels c
        JOIN users u ON c.user_id = u.id
        WHERE c.status = 'deleted' AND (c.name LIKE ? OR c.shortname LIKE ?)
        ORDER BY c.id DESC LIMIT ? OFFSET ?
      `, [searchPattern, searchPattern, limit, offset]);
    }
    
    connection.release();

    const totalCount = countRows[0].count;
    const totalPages = Math.ceil(totalCount / limit) || 1;

    res.render('channels', {
      pageTitle: 'Удаленные каналы | Админ-панель',
      channels: channelsRows,
      q: query,
      page,
      limit,
      totalPages,
      totalCount,
      baseUrl: '/channels/deleted'
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Internal Server Error');
  }
});

// GET /channels/api/users_search - API for user autocomplete
router.get('/channels/api/users_search', requireAdminAuth, async (req, res) => {
  const q = req.query.q || '';
  if (q.length < 1) return res.json([]);
  try {
    const connection = await pool.getConnection();
    const searchPattern = q + '%';
    const [users] = await connection.query('SELECT id, username FROM users WHERE username LIKE ? OR id = ? LIMIT 10', [searchPattern, q]);
    connection.release();
    res.json(users);
  } catch(e) {
    console.error('User search API error:', e);
    res.json([]);
  }
});

// GET /channels/:id/edit - Edit channel page
router.get('/channels/:id/edit', requireAdminAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const connection = await pool.getConnection();
    const [channels] = await connection.query(`
      SELECT c.*, u.username as owner_username 
      FROM channels c 
      JOIN users u ON c.user_id = u.id 
      WHERE c.id = ?
    `, [id]);
    
    if (channels.length === 0) {
      connection.release();
      return res.status(404).send('Канал не найден');
    }
    const channel = channels[0];

    // Get team members
    const [team] = await connection.query(`
      SELECT ct.*, u.username 
      FROM channel_team ct 
      JOIN users u ON ct.user_id = u.id 
      WHERE ct.channel_id = ?
    `, [id]);

    // Get stream key
    const [keys] = await connection.query('SELECT stream_key FROM stream_keys WHERE channel_id = ? LIMIT 1', [id]);
    const streamKey = keys.length > 0 ? keys[0].stream_key : null;

    // Get CDN usage
    const [recRows] = await connection.query('SELECT SUM(size_bytes) as total FROM records WHERE channel_id = ?', [id]);
    const totalBytes = recRows[0].total || 0;
    const usageGB = (totalBytes / (1024 * 1024 * 1024)).toFixed(2);
    
    // Convert quota to GB for display
    const quotaGB = channel.cdn_quota_mb ? (channel.cdn_quota_mb / 1024).toFixed(2) : '2.00';

    // Check if it is a service channel
    const [settings] = await connection.query("SELECT setting_value FROM system_settings WHERE setting_key = 'service_channel_id'");
    const isServiceChannel = settings.length > 0 && settings[0].setting_value == id;

    // Get ban info if banned
    let banInfo = null;
    if (channel.status === 'banned') {
       const [ownerBans] = await connection.query('SELECT banned_until, ban_reason FROM users WHERE id = ?', [channel.user_id]);
       banInfo = ownerBans[0];
    }

    connection.release();

    res.render('channel-edit', {
      pageTitle: `Редактирование канала - ${channel.shortname} (id: ${channel.id})`,
      channel,
      team,
      streamKey,
      usageGB,
      quotaGB,
      isServiceChannel,
      banInfo
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Internal Server Error');
  }
});

// POST /channels/:id/edit - Update channel info
router.post('/channels/:id/edit', requireAdminAuth, (req, res, next) => {
  if (!req.user.is_superadmin && req.user.staff_role === 'moderator') {
    return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторы не могут изменять данные каналов.' });
  }
  upload.single('avatar')(req, res, (err) => {
    if (err) {
      console.error('[Admin Avatar Upload] Multer error:', err);
      let errorMsg = 'Ошибка загрузки аватара: ';
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          errorMsg += 'размер файла превышает 4 МБ.';
        } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          errorMsg += 'разрешена загрузка только изображений (jpeg, jpg, png, gif, webp).';
        } else {
          errorMsg += err.message;
        }
      } else {
        errorMsg += err.message;
      }
      req.session.error_msg = errorMsg;
      return res.redirect('/channels/' + req.params.id + '/edit');
    }
    next();
  });
}, async (req, res) => {
  console.log('[Admin Avatar Upload] POST received. req.file:', req.file ? req.file.originalname : 'No file');
  console.log('[Admin Edit] req.body:', req.body);
  const { id } = req.params;
  const { name, shortname, description, rtmp_disabled, autopilot_disabled, chat_disabled, design_disabled } = req.body;
  
  if (name && name.length > 77) {
    req.session.error_msg = 'Ошибка: Название телеканала не должно превышать 77 символов.';
    return res.redirect('/channels/' + id + '/edit');
  }

  if (description && description.length > 200) {
    req.session.error_msg = 'Ошибка: Описание канала не может превышать 200 символов.';
    return res.redirect('/channels/' + id + '/edit');
  }

  if (shortname) {
    const restrictedSlugs = ['login', 'register', 'api', 'news', 'account', 'channels'];
    if (restrictedSlugs.includes(shortname.toLowerCase())) {
      req.session.error_msg = 'Ошибка: Это короткое имя недоступно (зарезервировано системой).';
      return res.redirect('/channels/' + id + '/edit');
    }

    const slugRegex = /^[a-zA-Z0-9_-]+$/;
    if (!slugRegex.test(shortname)) {
      req.session.error_msg = 'Ошибка: Короткое имя может содержать только латинские буквы, цифры, дефис и подчеркивание.';
      return res.redirect('/channels/' + id + '/edit');
    }
  }

  // Check uniqueness
  const [existing] = await pool.query('SELECT id FROM channels WHERE shortname = ? AND id != ?', [shortname, id]);
  if (existing.length > 0) {
    req.session.error_msg = 'Короткое имя уже занято!';
    return res.redirect('/channels/' + id + '/edit');
  }

  try {
    const { 
      name, shortname, description, 
      rtmp_disabled, autopilot_disabled, chat_disabled, design_disabled,
      cdn_quota_gb, is_premium, is_verified
    } = req.body;

    const quotaMB = cdn_quota_gb ? Math.floor(parseFloat(cdn_quota_gb) * 1024) : 2048;

    let query, params;
    const connection = await pool.getConnection();

    if (req.file) {
      const avatarPath = '/images/design/' + req.file.filename;
      query = 'UPDATE channels SET name = ?, shortname = ?, description = ?, logo_url = ?, rtmp_disabled = ?, autopilot_disabled = ?, autopilot_enabled = CASE WHEN ? = 1 THEN 0 ELSE autopilot_enabled END, chat_disabled = ?, chat_enabled = CASE WHEN ? = 1 THEN 0 ELSE chat_enabled END, design_disabled = ?, cdn_quota_mb = ?, is_premium = ?, is_verified = ? WHERE id = ?';
      params = [
        name, shortname, description, avatarPath,
        rtmp_disabled ? 1 : 0, 
        autopilot_disabled ? 1 : 0,
        autopilot_disabled ? 1 : 0,
        chat_disabled ? 1 : 0,
        chat_disabled ? 1 : 0,
        design_disabled ? 1 : 0,
        quotaMB,
        is_premium ? 1 : 0,
        is_verified ? 1 : 0,
        id
      ];
    } else {
      query = 'UPDATE channels SET name = ?, shortname = ?, description = ?, rtmp_disabled = ?, autopilot_disabled = ?, autopilot_enabled = CASE WHEN ? = 1 THEN 0 ELSE autopilot_enabled END, chat_disabled = ?, chat_enabled = CASE WHEN ? = 1 THEN 0 ELSE chat_enabled END, design_disabled = ?, cdn_quota_mb = ?, is_premium = ?, is_verified = ? WHERE id = ?';
      params = [
        name, shortname, description, 
        rtmp_disabled ? 1 : 0, 
        autopilot_disabled ? 1 : 0,
        autopilot_disabled ? 1 : 0,
        chat_disabled ? 1 : 0,
        chat_disabled ? 1 : 0,
        design_disabled ? 1 : 0,
        quotaMB,
        is_premium ? 1 : 0,
        is_verified ? 1 : 0,
        id
      ];
    }
    
    await connection.query(query, params);
    connection.release();
    
    if (autopilot_disabled) {
      const io = req.app.get('io');
      if (io) {
        io.to('channel_' + id).emit('autopilot_update');
      }
    }
    
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, `Изменил настройки телеканала "${name}" (ID: ${id})`, userIp);

    req.session.success_msg = 'Канал успешно обновлен!';
    req.session.save(() => {
      res.redirect('/channels/' + id + '/edit');
    });
  } catch (e) {
    console.error(e);
    req.session.error_msg = 'Ошибка сохранения: ' + e.message;
    res.redirect('/channels/' + id + '/edit');
  }
});

// POST /channels/:id/delete_avatar
router.post('/channels/:id/delete_avatar', requireAdminAuth, async (req, res) => {
  if (!req.user.is_superadmin && req.user.staff_role === 'moderator') {
    return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  }
  const { id } = req.params;
  try {
    const [c] = await pool.query('SELECT name FROM channels WHERE id = ?', [id]);
    const cName = c.length > 0 ? c[0].name : 'Unknown';
    await pool.query('UPDATE channels SET logo_url = "/images/default_channel_logo.png" WHERE id = ?', [id]);
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, `Сбросил аватар телеканала "${cName}" (ID: ${id})`, userIp);
    req.session.success_msg = 'Аватар удален!';
    res.redirect('/channels/' + id + '/edit');
  } catch(e) {
    req.session.error_msg = 'Ошибка: ' + e.message;
    res.redirect('/channels/' + id + '/edit');
  }
});

// POST /channels/:id/toggle_status
router.post('/channels/:id/toggle_status', requireAdminAuth, async (req, res) => {
  const { id } = req.params;
  const redirectUrl = req.query.redirect || ('/channels/' + id + '/edit');
  const { action_type, ban_type, banned_until, ban_reason } = req.body;

  try {
    const connection = await pool.getConnection();
    const [c] = await connection.query('SELECT status, user_id, name FROM channels WHERE id = ?', [id]);
    
    if (c.length > 0) {
      const channel = c[0];
      const adminId = req.session.user ? req.session.user.id : 1;
      
      if (action_type === 'ban') {
        const parsedUntil = (ban_type === 'temporary' && banned_until) ? banned_until : null;
        await connection.query('UPDATE channels SET status = ?, banned_until = ?, ban_reason = ? WHERE id = ?', ['banned', parsedUntil, ban_reason, id]);
        
        let messageText = 'Ваш телеканал заблокирован навсегда.';
        if (parsedUntil) {
          const d = new Date(parsedUntil);
          const formattedDate = `${d.getDate().toString().padStart(2, '0')}.${(d.getMonth() + 1).toString().padStart(2, '0')}.${d.getFullYear()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
          messageText = `Ваш телеканал заблокирован до ${formattedDate}.`;
        }
        
        await sendSystemMessage(channel.user_id, messageText);
        req.session.success_msg = 'Канал заблокирован!';
        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
        logAction('admin', req.session.user.username, `Заблокировал телеканал "${channel.name}" (ID: ${id})`, userIp);
      } else if (action_type === 'unban') {
        await connection.query('UPDATE channels SET status = ?, banned_until = NULL, ban_reason = NULL WHERE id = ?', ['active', id]);
        await sendSystemMessage(channel.user_id, 'Ваш телеканал был разблокирован.');
        req.session.success_msg = 'Канал разблокирован!';
        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
        logAction('admin', req.session.user.username, `Разблокировал телеканал "${channel.name}" (ID: ${id})`, userIp);
      } else {
        const newStatus = channel.status === 'banned' ? 'active' : 'banned';
        await connection.query('UPDATE channels SET status = ? WHERE id = ?', [newStatus, id]);
        req.session.success_msg = 'Статус изменен!';
        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
        logAction('admin', req.session.user.username, `Изменил статус телеканала "${channel.name}" (ID: ${id}) на ${newStatus}`, userIp);
      }
    }
    
    connection.release();
    res.redirect(redirectUrl);
  } catch(e) {
    console.error(e);
    req.session.error_msg = 'Ошибка изменения статуса';
    res.redirect(redirectUrl);
  }
});

function deleteFileIfExistsAdmin(fileUrl) {
  if (!fileUrl) return;
  if (fileUrl.includes('default_channel_logo') || fileUrl.includes('default_bg')) return;
  const relativePath = fileUrl.startsWith('/') ? fileUrl.substring(1) : fileUrl;
  const absolutePath = path.join(storageRoot, relativePath);
  if (fs.existsSync(absolutePath)) {
    try { fs.unlinkSync(absolutePath); } catch (e) { console.error('[ADMIN] File delete error:', e); }
  }
}

// POST /channels/:id/delete
router.post('/channels/:id/delete', requireAdminAuth, async (req, res) => {
  if (!req.user.is_superadmin && req.user.staff_role === 'moderator') {
    return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  }
  const { id } = req.params;
  const redirectUrl = req.query.redirect || ('/channels/' + id + '/edit');
  try {
    const connection = await pool.getConnection();
    const [c] = await connection.query('SELECT status, logo_url, bg_url, name FROM channels WHERE id = ?', [id]);
    if (c.length > 0) {
      if (c[0].status === 'deleted') {
        // Отменить удаление (если канал был удален юзером)
        const channel = c[0];
        await connection.query('UPDATE channels SET status = ?, deleted_at = NULL, deleted_by_admin = 0 WHERE id = ?', ['active', id]);
        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
        logAction('admin', req.session.user.username, `Отменил удаление телеканала "${channel.name}" (ID: ${id})`, userIp);
        connection.release();
        req.session.success_msg = 'Канал восстановлен!';
        return res.redirect(redirectUrl);
      } else {
        // Немедленное физическое удаление (если админ удаляет активный или забаненный канал)
        const channel = c[0];
        
        // Удаляем файлы записей
        const [records] = await connection.query('SELECT video_url, thumbnail_url FROM records WHERE channel_id = ?', [id]);
        for (const record of records) {
          deleteFileIfExistsAdmin(record.video_url);
          deleteFileIfExistsAdmin(record.thumbnail_url);
        }
        
        // Удаляем файлы оформления
        deleteFileIfExistsAdmin(channel.logo_url);
        deleteFileIfExistsAdmin(channel.bg_url);
        
        // Удаляем запись из БД (КАСКАДНО удалит связанные записи)
        await connection.query('DELETE FROM channels WHERE id = ?', [id]);
        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
        logAction('admin', req.session.user.username, `Полностью удалил телеканал "${channel.name}" (ID: ${id})`, userIp);
        connection.release();
        req.session.success_msg = 'Канал полностью удален!';
        // Перенаправляем на список каналов, так как текущего больше нет
        return res.redirect('/channels');
      }
    }
    connection.release();
    res.redirect('/channels');
  } catch(e) {
    console.error(e);
    res.redirect(redirectUrl);
  }
});

// POST /channels/:id/reset_stream_key
router.post('/channels/:id/reset_stream_key', requireAdminAuth, async (req, res) => {
  if (!req.user.is_superadmin && req.user.staff_role === 'moderator') {
    return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  }
  const { id } = req.params;
  try {
    const connection = await pool.getConnection();
    const [ch] = await connection.query('SELECT user_id, name FROM channels WHERE id = ?', [id]);
    if (ch.length > 0) {
      const crypto = require('crypto');
      const newKey = 'sk_live_' + crypto.randomBytes(16).toString('hex');
      const [existing] = await connection.query('SELECT stream_key FROM stream_keys WHERE channel_id = ?', [id]);
      if (existing.length > 0) {
        await connection.query('UPDATE stream_keys SET stream_key = ?, is_active = 1 WHERE channel_id = ?', [newKey, id]);
      } else {
        await connection.query('INSERT INTO stream_keys (channel_id, user_id, stream_key, is_active) VALUES (?, ?, ?, 1)', [id, ch[0].user_id, newKey]);
      }
      const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
      logAction('admin', req.session.user.username, `Сбросил ключ вещания для телеканала "${ch[0].name}" (ID: ${id})`, userIp);
    }
    connection.release();
    req.session.success_msg = 'Ключ вещания обновлен!';
    res.redirect('/channels/' + id + '/edit');
  } catch(e) {
    console.error(e);
    res.redirect('/channels/' + id + '/edit');
  }
});

// POST /channels/:id/toggle_service
router.post('/channels/:id/toggle_service', requireAdminAuth, async (req, res) => {
  if (!req.user.is_superadmin && req.user.staff_role === 'moderator') {
    return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  }
  const { id } = req.params;
  try {
    const connection = await pool.getConnection();
    const [sets] = await connection.query("SELECT setting_value FROM system_settings WHERE setting_key = 'service_channel_id'");
    
    // First, clear any existing service channel
    await connection.query("DELETE FROM system_settings WHERE setting_key = 'service_channel_id'");
    
    // If it was not this channel, insert it (toggle on)
    if (!(sets.length > 0 && sets[0].setting_value == id)) {
      await connection.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('service_channel_id', ?)", [id]);
    }
    
    connection.release();
    req.session.success_msg = 'Служебный канал изменен!';
    res.redirect('/channels/' + id + '/edit');
  } catch(e) {
    res.redirect('/channels/' + id + '/edit');
  }
});

// POST /channels/:id/change_owner
router.post('/channels/:id/change_owner', requireAdminAuth, async (req, res) => {
  if (!req.user.is_superadmin && req.user.staff_role === 'moderator') {
    return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  }
  const { id } = req.params;
  const { new_owner } = req.body;
  try {
    const connection = await pool.getConnection();
    const [users] = await connection.query('SELECT id, username FROM users WHERE id = ? OR username = ?', [new_owner, new_owner]);
    if (users.length > 0) {
      const [c] = await connection.query('SELECT name FROM channels WHERE id = ?', [id]);
      const cName = c.length > 0 ? c[0].name : 'Unknown';
      const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
      
      await connection.query('UPDATE channels SET user_id = ? WHERE id = ?', [users[0].id, id]);
      logAction('admin', req.session.user.username, `Изменил владельца телеканала "${cName}" (ID: ${id}) на пользователя "${users[0].username || users[0].id}"`, userIp);
      
      req.session.success_msg = 'Владелец изменен!';
    } else {
      req.session.error_msg = 'Пользователь не найден';
    }
    connection.release();
    res.redirect('/channels/' + id + '/edit');
  } catch(e) {
    req.session.error_msg = 'Ошибка: ' + e.message;
    res.redirect('/channels/' + id + '/edit');
  }
});

// POST /channels/:id/add_team
router.post('/channels/:id/add_team', requireAdminAuth, async (req, res) => {
  if (!req.user.is_superadmin && req.user.staff_role === 'moderator') {
    return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  }
  const { id } = req.params;
  const { team_user, is_reporter, is_moderator, is_editor } = req.body;
  try {
    const connection = await pool.getConnection();
    const [users] = await connection.query('SELECT id, username FROM users WHERE id = ? OR username = ?', [team_user, team_user]);
    if (users.length > 0) {
      const uId = users[0].id;
      
      const [c] = await connection.query('SELECT name FROM channels WHERE id = ?', [id]);
      const cName = c.length > 0 ? c[0].name : 'Unknown';
      const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;

      if (!is_reporter && !is_moderator && !is_editor) {
        // remove
        await connection.query('DELETE FROM channel_team WHERE channel_id = ? AND user_id = ?', [id, uId]);
        logAction('admin', req.session.user.username, `Удалил пользователя "${users[0].username || users[0].id}" из команды телеканала "${cName}" (ID: ${id})`, userIp);
        req.session.success_msg = 'Пользователь удален из команды';
      } else {
        // insert or update
        const rep = is_reporter ? 1 : 0;
        const mod = is_moderator ? 1 : 0;
        const ed = is_editor ? 1 : 0;
        await connection.query('INSERT INTO channel_team (channel_id, user_id, is_reporter, is_moderator, is_editor) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE is_reporter = ?, is_moderator = ?, is_editor = ?', [id, uId, rep, mod, ed, rep, mod, ed]);
        logAction('admin', req.session.user.username, `Изменил права пользователя "${users[0].username || users[0].id}" в команде телеканала "${cName}" (ID: ${id})`, userIp);
        req.session.success_msg = 'Команда обновлена!';
      }
    } else {
      req.session.error_msg = 'Пользователь не найден';
    }
    connection.release();
    res.redirect('/channels/' + id + '/edit');
  } catch(e) {
    req.session.error_msg = 'Ошибка: ' + e.message;
    res.redirect('/channels/' + id + '/edit');
  }
});

module.exports = router;
