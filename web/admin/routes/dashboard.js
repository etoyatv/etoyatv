const express = require('express');
const router = express.Router();
const { requireAdminAuth } = require('../middlewares/auth');
const { logAction } = require('../utils/logger');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configure multer for ads
const adStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = path.join(__dirname, '../../public/uploads/ads');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    cb(null, 'ad_' + Date.now() + path.extname(file.originalname));
  }
});

const adUpload = multer({ 
  storage: adStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: function (req, file, cb) {
    const filetypes = /jpeg|jpg|png|gif/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Только изображения!'));
  }
});

// Apply auth middleware to all routes in this router
router.use(requireAdminAuth);

async function renderDashboard(req, res) {
  try {
    const { pool } = require('../config/db');
    const connection = await pool.getConnection();
    
    const [[{ total_users }]] = await connection.query('SELECT COUNT(*) as total_users FROM users');
    const [[{ total_channels }]] = await connection.query('SELECT COUNT(*) as total_channels FROM channels');
    const [[{ total_news }]] = await connection.query('SELECT (SELECT COUNT(*) FROM news) + (SELECT COUNT(*) FROM channel_news) as total_news');
    const [[{ total_records }]] = await connection.query('SELECT COUNT(*) as total_records FROM records');

    const [[today_stats]] = await connection.query(`
      SELECT 
        COALESCE(ROUND(AVG(NULLIF(users_online, 0))), 0) as avg_users, MAX(users_online) as max_users,
        COALESCE(ROUND(AVG(NULLIF(viewers_online, 0))), 0) as avg_viewers, MAX(viewers_online) as max_viewers
      FROM stats_snapshots 
      WHERE timestamp >= NOW() - INTERVAL 24 HOUR
    `);

    const [graph_data] = await connection.query(`
      SELECT timestamp, users_online, viewers_online 
      FROM stats_snapshots 
      WHERE timestamp >= NOW() - INTERVAL 24 HOUR 
      ORDER BY timestamp ASC
    `);

    connection.release();

    res.render('dashboard', {
      currentPath: req.path,
      total_users,
      total_channels,
      total_news,
      total_records,
      today_stats: today_stats || { avg_users: 0, max_users: 0, avg_viewers: 0, max_viewers: 0 },
      graph_data: JSON.stringify(graph_data)
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сервера' });
  }
}

router.get('/', renderDashboard);

// Admin logout
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    // Redirect back to main site after logout
    res.redirect(process.env.APP_URL || 'http://localhost:3001/');
  });
});

// Mock routes for the top menu to prevent 404s
const mockPages = [];
mockPages.forEach(page => {
  router.get(page, renderDashboard);
});

// Settings page
router.get('/settings', async (req, res) => {
  let envContent = '';
  if (req.user && req.user.is_superadmin) {
    try {
      envContent = fs.readFileSync('/app/.env', 'utf8');
    } catch (e) {
      try {
        envContent = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
      } catch (err) {
        console.error('Failed to read .env file:', err);
        envContent = '# Ошибка чтения файла .env';
      }
    }
  }

  // Load Telegram notification settings
  let notifSettings = {
    user_id: req.session.user.id,
    tg_chat_id: '',
    tg_bind_code: null,
    notify_registration: 0,
    notify_creation: 0,
    notify_stream: 0,
    notify_deletion: 0
  };
  try {
    const { pool } = require('../config/db');
    const [notifSettingsRows] = await pool.query('SELECT * FROM admin_notification_settings WHERE user_id = ?', [req.session.user.id]);
    if (notifSettingsRows.length > 0) {
      notifSettings = notifSettingsRows[0];
    } else {
      await pool.query('INSERT IGNORE INTO admin_notification_settings (user_id) VALUES (?)', [req.session.user.id]);
    }
  } catch (dbErr) {
    console.error('Failed to load notification settings:', dbErr);
  }

  res.render('settings', { 
    currentPath: '/settings', 
    settings: res.locals.systemSettings || {},
    envContent,
    notifSettings,
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    botUsername: process.env.TELEGRAM_BOT_USERNAME
  });
});


// Save advanced (.env) settings
router.post('/settings/advanced', async (req, res) => {
  if (!req.user || !req.user.is_superadmin) {
    return res.status(403).render('error', { 
      status: 403, 
      title: 'Отказано в доступе', 
      message: 'Этот раздел доступен исключительно Главному администратору!' 
    });
  }

  const { env_content } = req.body;
  try {
    fs.writeFileSync('/app/.env', env_content || '', 'utf8');
    
    // Log action
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, 'Изменил продвинутые настройки (.env)', userIp);
    
    req.session.success_msg = 'Продвинутые настройки (.env) успешно сохранены. Пожалуйста, перезапустите контейнеры для применения изменений.';
    res.redirect('/settings#advanced');
  } catch (err) {
    console.error('Error saving .env settings:', err);
    req.session.error_msg = 'Ошибка при сохранении настроек: ' + err.message;
    res.redirect('/settings#advanced');
  }
});


// Save settings
router.post('/settings', async (req, res) => {
  if (req.user && !req.user.is_superadmin && req.user.staff_role === 'moderator') return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  try {
    const { pool } = require('../config/db');
    const connection = await pool.getConnection();
    
    // Identify which form was submitted
    const formType = req.body.form_type;
    const updates = [];

    if (formType === 'main_settings') {
      const switchSettings = [
        'site_disabled', 'rtmp_disabled', 'banner_enabled',
        'registration_disabled', 'invite_system_enabled'
      ];
      const textSettings = [
        'site_disabled_message', 'banner_text_short', 'banner_text_full', 'forbidden_words'
      ];

      for (const key of switchSettings) {
        const val = req.body[key] === '1' ? '1' : '0';
        updates.push(connection.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?', [key, val, val]));
      }

      for (const key of textSettings) {
        const val = req.body[key] || '';
        updates.push(connection.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?', [key, val, val]));
      }
    } else if (formType === 'ads_settings') {
      const val = req.body.ads_enabled === '1' ? '1' : '0';
      updates.push(connection.query('INSERT INTO system_settings (setting_key, setting_value) VALUES ("ads_enabled", ?) ON DUPLICATE KEY UPDATE setting_value = ?', [val, val]));
    }

    await Promise.all(updates);
    
    connection.release();
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, 'Изменил системные настройки', userIp);
    req.session.success_msg = 'Настройки сохранены';
    res.redirect('/settings');
  } catch (e) {
    console.error('Error saving settings:', e);
    req.session.error_msg = 'Ошибка при сохранении настроек';
    res.redirect('/settings');
  }
});

// Save ads settings specifically
router.post('/settings/ads', async (req, res) => {
  if (req.user && !req.user.is_superadmin && req.user.staff_role === 'moderator') return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  try {
    const { pool } = require('../config/db');
    const connection = await pool.getConnection();
    const adsConfig = req.body.ads_config || '{}';
    
    await connection.query('INSERT INTO system_settings (setting_key, setting_value) VALUES ("ads_config", ?) ON DUPLICATE KEY UPDATE setting_value = ?', [adsConfig, adsConfig]);
    
    connection.release();
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, 'Изменил настройки рекламы', userIp);
    res.json({ success: true, message: 'Настройки рекламы сохранены' });
  } catch (e) {
    console.error('Error saving ads settings:', e);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// Upload ad image/gif
router.post('/settings/ads/upload', (req, res, next) => {
  if (req.user && !req.user.is_superadmin && req.user.staff_role === 'moderator') return res.status(403).json({ success: false, message: 'Отказано в доступе' });
  adUpload.single('ad_file')(req, res, (err) => {
    if (err) {
      console.error('[Admin Ad Upload] Multer error:', err);
      let errorMsg = 'Ошибка загрузки рекламы: ';
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          errorMsg += 'размер файла превышает 5 МБ.';
        } else {
          errorMsg += err.message;
        }
      } else {
        errorMsg += err.message;
      }
      return res.status(400).json({ success: false, message: errorMsg });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'Файл не загружен' });
  }

  try {
    const fs = require('fs');
    const path = require('path');
    const sizeOf = require('image-size');
    
    const filePath = req.file.path;
    const slotType = req.body.slotType || '';
    
    let width = null;
    let height = null;
    if (slotType === 'sidebar_320x240') {
      width = 320; height = 240;
    } else if (slotType === 'header_970x90') {
      width = 970; height = 90;
    } else if (slotType === 'sidebar_320x100') {
      width = 320; height = 100;
    }
    
    if (width && height) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (ext === '.gif') {
        const dimensions = sizeOf(filePath);
        if (dimensions.width !== width || dimensions.height !== height) {
          fs.unlinkSync(filePath);
          return res.status(400).json({ success: false, message: `Для GIF размеры должны быть строго ${width}x${height}px. Загруженный размер: ${dimensions.width || '?'}x${dimensions.height || '?'}px.` });
        }
      } else {
        const Jimp = require('jimp');
        const image = await Jimp.read(filePath);
        await image.cover(width, height).writeAsync(filePath);
      }
    }

    const fileUrl = '/uploads/ads/' + req.file.filename;
    res.json({ success: true, url: fileUrl });
  } catch (err) {
    console.error('Error processing image:', err);
    res.status(500).json({ success: false, message: 'Ошибка обработки изображения' });
  }
});

// Users Route
router.get('/users', async (req, res) => {
  try {
    const { pool } = require('../config/db');
    const connection = await pool.getConnection();

    // Stats
    const [[{ total }]] = await connection.query('SELECT COUNT(*) as total FROM users');
    const [[{ deleted }]] = await connection.query('SELECT COUNT(*) as deleted FROM users WHERE deleted_at IS NOT NULL');
    
    // Check if is_banned exists, otherwise return 0 to avoid errors if db hasn't migrated yet
    let banned = 0;
    try {
      const [[b]] = await connection.query('SELECT COUNT(*) as banned FROM users WHERE is_banned = 1');
      banned = b.banned;
    } catch(e) { }

    // Pagination
    const limit = parseInt(req.query.limit) || 10;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;

    const [users] = await connection.query(`
      SELECT u.id, u.username, u.email, u.avatar, u.is_verified, u.deleted_at, u.role, u.is_banned, s.role as staff_role, s.is_superadmin
      FROM users u
      LEFT JOIN staff s ON u.id = s.user_id
      ORDER BY u.id DESC 
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    connection.release();

    const totalPages = Math.ceil(total / limit);

    res.render('users', {
      users,
      total,
      deleted,
      banned,
      limit,
      page,
      totalPages
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { status: 500, title: 'Ошибка сервера', message: 'Произошла непредвиденная ошибка на сервере.' });
  }
});

// Search users
router.get('/users/search', async (req, res) => {
  try {
    const { pool } = require('../config/db');
    const connection = await pool.getConnection();

    let users = [];
    let query = req.query.q || '';
    let type = req.query.type || 'username';
    let total = 0;
    let totalPages = 0;

    const limit = parseInt(req.query.limit) || 10;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;

    if (query) {
      let countSql = 'SELECT COUNT(*) as total FROM users u';
      let sql = `
        SELECT u.id, u.username, u.email, u.avatar, u.is_verified, u.deleted_at, u.role, u.is_banned, s.role as staff_role, s.is_superadmin
        FROM users u
        LEFT JOIN staff s ON u.id = s.user_id
      `;
      let params = [];
      
      if (type === 'id') {
        sql += ' WHERE u.id = ?';
        countSql += ' WHERE u.id = ?';
        params.push(query);
      } else if (type === 'email') {
        sql += ' WHERE u.email LIKE ?';
        countSql += ' WHERE u.email LIKE ?';
        params.push('%' + query + '%');
      } else {
        sql += ' WHERE u.username LIKE ?';
        countSql += ' WHERE u.username LIKE ?';
        params.push('%' + query + '%');
      }
      
      const [[{ total: count }]] = await connection.query(countSql, params);
      total = count;
      totalPages = Math.ceil(total / limit);

      sql += ' ORDER BY u.id DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const [rows] = await connection.query(sql, params);
      users = rows;
    }

    connection.release();

    res.render('users-search', {
      user: req.session.user,
      currentPath: '/users/search',
      users,
      q: query,
      type,
      limit,
      page,
      totalPages,
      total
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { status: 500, title: 'Ошибка сервера', message: 'Произошла ошибка при поиске.' });
  }
});


// Ban/Unban user
router.post('/users/:id/ban', async (req, res) => {
  try {
    const { pool } = require('../config/db');
    const connection = await pool.getConnection();

    if (!(await checkAccess(req, connection, req.params.id))) {
      connection.release();
      return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'У вас нет прав для выполнения этого действия.' });
    }
    
    const adminId = req.session.user ? req.session.user.id : null;
    const { ban_type, banned_until, reason, show_reason, ban_ip, ip_ban_type } = req.body;

    if (reason && reason.length > 200) {
      connection.release();
      return res.status(400).render('error', { status: 400, title: 'Ошибка', message: 'Причина блокировки не может превышать 200 символов.' });
    }

    if (ban_type === 'unban') {
       await connection.query('UPDATE users SET is_banned = 0, banned_by = NULL, banned_until = NULL, ban_reason = NULL, show_ban_reason = 0 WHERE id = ?', [req.params.id]);
       await connection.query('UPDATE channels SET status = "active", rtmp_disabled = 0 WHERE user_id = ? AND status = "banned"', [req.params.id]);
    } else {
       const until = (ban_type === 'temporary' && banned_until) ? banned_until : null;
       const showReason = show_reason === '1' ? 1 : 0;
       await connection.query('UPDATE users SET is_banned = 1, banned_by = ?, banned_until = ?, ban_reason = ?, show_ban_reason = ?, deleted_at = NULL WHERE id = ?', [adminId, until, reason, showReason, req.params.id]);
       await connection.query('UPDATE channels SET status = "banned", deleted_at = NULL, rtmp_disabled = 1 WHERE user_id = ?', [req.params.id]);

       if (ban_type === 'permanent' && ban_ip === '1') {
         const [uRows] = await connection.query('SELECT last_ip FROM users WHERE id = ?', [req.params.id]);
         if (uRows.length > 0 && uRows[0].last_ip) {
            const targetIp = uRows[0].last_ip;
            const myIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
            const { isProtectedIp } = require('../utils/ipChecker');
            const protected = await isProtectedIp(connection, targetIp, myIp);
            
            if (protected) {
               connection.release();
               return res.status(400).render('error', { status: 400, title: 'Ошибка', message: 'Нельзя заблокировать этот IP, так как он принадлежит вам или члену персонала.' });
            }

            const ipType = ip_ban_type === 'full' ? 'full' : 'account';
            await connection.query('INSERT INTO ip_bans (ip_address, banned_by, ban_type, reason) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE banned_by = VALUES(banned_by), ban_type = VALUES(ban_type), reason = VALUES(reason)', [targetIp, adminId, ipType, reason]);
         }
       }
    }
    
    const [uRows] = await connection.query('SELECT username FROM users WHERE id = ?', [req.params.id]);
    const targetUsername = uRows.length > 0 ? uRows[0].username : 'Unknown';
    connection.release();
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, ban_type === 'unban' ? `Разблокировал пользователя "${targetUsername}" (ID: ${req.params.id})` : `Заблокировал пользователя "${targetUsername}" (ID: ${req.params.id})`, userIp);
    
    req.session.success_msg = ban_type === 'unban' ? 'Пользователь успешно разблокирован' : 'Пользователь успешно заблокирован';
    res.redirect('back');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { status: 500, title: 'Ошибка сервера', message: 'Произошла непредвиденная ошибка на сервере.' });
  }
});

// Delete user
router.post('/users/:id/delete', async (req, res) => {
  try {
    const { pool } = require('../config/db');
    const connection = await pool.getConnection();

    if (!(await checkAccess(req, connection, req.params.id))) {
      connection.release();
      return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'У вас нет прав для выполнения этого действия.' });
    }
    
    const { action_type, reason } = req.body;

    if (action_type === 'restore') {
      await connection.query('UPDATE users SET deleted_at = NULL, delete_reason = NULL, deleted_by_admin = 0 WHERE id = ?', [req.params.id]);
      const [uRows] = await connection.query('SELECT username FROM users WHERE id = ?', [req.params.id]);
      const targetUsername = uRows.length > 0 ? uRows[0].username : 'Unknown';
      connection.release();
      const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
      logAction('admin', req.session.user.username, `Восстановил пользователя "${targetUsername}" (ID: ${req.params.id})`, userIp);
      req.session.success_msg = 'Пользователь успешно восстановлен';
      res.redirect('back');
    } else {
      const [uRows] = await connection.query('SELECT username FROM users WHERE id = ?', [req.params.id]);
      const targetUsername = uRows.length > 0 ? uRows[0].username : 'Unknown';
      await connection.query('UPDATE users SET deleted_at = NOW(), delete_reason = ?, deleted_by_admin = 1 WHERE id = ?', [reason || null, req.params.id]);
      // Also ban channels
      await connection.query('UPDATE channels SET status = "banned", deleted_at = NOW() WHERE user_id = ?', [req.params.id]);
      connection.release();
      const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
      logAction('admin', req.session.user.username, `Удалил пользователя "${targetUsername}" (ID: ${req.params.id})`, userIp);
      req.session.success_msg = 'Пользователь успешно удален';
      res.redirect('back');
    }
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { status: 500, title: 'Ошибка сервера', message: 'Произошла непредвиденная ошибка на сервере.' });
  }
});

const bcrypt = require('bcrypt');


const avatarsDir = path.join(__dirname, '../public/images/avatars');
if (!fs.existsSync(avatarsDir)) {
  fs.mkdirSync(avatarsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, avatarsDir) },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname) || '.png';
    // Prefix with 'admin_' or just target user id
    cb(null, 'avatar_' + req.params.id + '_' + Date.now() + ext)
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
  limits: { fileSize: 4 * 1024 * 1024 }
});

// Helper for permission checks
const checkAccess = async (req, connection, targetUserId) => {
  if (req.user.is_superadmin) return true;
  const [staffRows] = await connection.query('SELECT role, is_superadmin FROM staff WHERE user_id = ?', [targetUserId]);
  const tStaff = staffRows[0];
  if (req.user.staff_role === 'admin') {
    return !tStaff || !tStaff.is_superadmin;
  }
  if (req.user.staff_role === 'moderator') {
    return !tStaff;
  }
  return false;
};

// User Edit Form
router.get('/users/:id/edit', async (req, res) => {
  try {
    const { pool } = require('../config/db');
    const connection = await pool.getConnection();

    if (!(await checkAccess(req, connection, req.params.id))) {
      connection.release();
      return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Недостаточно прав для редактирования данного пользователя.' });
    }

    const [userRows] = await connection.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (userRows.length === 0) {
      connection.release();
      return res.status(404).render('error', { status: 404, title: 'Не найдено', message: 'Пользователь не найден.' });
    }
    const user = userRows[0];

    // Get Group
    const [staffRows] = await connection.query('SELECT role, is_superadmin FROM staff WHERE user_id = ?', [user.id]);
    const staff = staffRows[0] || null;

    // Get owned channels
    const [channels] = await connection.query('SELECT name, shortname FROM channels WHERE user_id = ?', [user.id]);

    // Get team access
    const [teamAccess] = await connection.query(`
      SELECT c.name, c.shortname, t.is_reporter, t.is_moderator, t.is_editor
      FROM channel_team t
      JOIN channels c ON t.channel_id = c.id
      WHERE t.user_id = ?
    `, [user.id]);

    // Get invited by (if exists)
    let inviter = null;
    if (user.invited_by) {
      const [inviterRows] = await connection.query('SELECT username FROM users WHERE id = ?', [user.invited_by]);
      if (inviterRows.length > 0) {
        inviter = inviterRows[0].username;
      }
    }

    connection.release();

    res.render('user-edit', {
      u: user,
      staff,
      channels,
      teamAccess,
      inviter
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { status: 500, title: 'Ошибка сервера', message: 'Произошла непредвиденная ошибка на сервере.' });
  }
});

router.post('/users/:id/reset_2fa', async (req, res) => {
  try {
    const { pool } = require('../config/db');
    const connection = await pool.getConnection();
    const userId = req.params.id;

    if (!(await checkAccess(req, connection, userId))) {
      connection.release();
      return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Недостаточно прав для редактирования данного пользователя.' });
    }

    if (!req.user.is_superadmin && req.user.staff_role === 'moderator') {
      connection.release();
      return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторы не могут изменять данные пользователей.' });
    }

    const [uRows] = await connection.query('SELECT username FROM users WHERE id = ?', [userId]);
    const targetUsername = uRows.length > 0 ? uRows[0].username : 'Unknown';

    await connection.query('UPDATE users SET is_totp_enabled = 0, totp_secret = NULL, totp_backup_codes = NULL WHERE id = ?', [userId]);
    connection.release();
    
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, `Сбросил 2FA для пользователя "${targetUsername}" (ID: ${userId})`, userIp);
    
    req.session.success_msg = '2FA была успешно сброшена для этого пользователя.';
    res.redirect(`/users/${userId}/edit`);
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Не удалось сбросить 2FA.' });
  }
});

// User Edit Submit
router.post('/users/:id/edit', (req, res, next) => {
  upload.single('avatar')(req, res, (err) => {
    if (err) {
      console.error('[Admin User Avatar Upload] Multer error:', err);
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
      return res.redirect(`/users/${req.params.id}/edit`);
    }
    next();
  });
}, async (req, res) => {
  try {
    const { pool } = require('../config/db');
    const connection = await pool.getConnection();
    const userId = req.params.id;

    if (!(await checkAccess(req, connection, userId))) {
      connection.release();
      return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Недостаточно прав для редактирования данного пользователя.' });
    }

    if (!req.user.is_superadmin && req.user.staff_role === 'moderator') {
      connection.release();
      return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторы не могут изменять данные пользователей.' });
    }

    const {
      username,
      email,
      password,
      discord,
      telegram,
      about,
      birthdate,
      timezone,
      remove_avatar
    } = req.body;

    if (username) {
      const trimmedUsername = username.trim();
      if (trimmedUsername.length > 13) {
        connection.release();
        return res.status(400).render('error', {
          status: 400,
          title: 'Некорректные данные',
          message: 'Имя пользователя не должно превышать 13 символов.'
        });
      }
      const usernameRegex = /^[a-zA-Z0-9_-]+$/;
      if (!usernameRegex.test(trimmedUsername)) {
        connection.release();
        return res.status(400).render('error', {
          status: 400,
          title: 'Некорректные данные',
          message: 'Имя пользователя может содержать только латинские буквы, цифры, дефисы и нижние подчеркивания.'
        });
      }
      const [existing] = await connection.query('SELECT id FROM users WHERE username = ? AND id != ?', [trimmedUsername, userId]);
      if (existing.length > 0) {
        connection.release();
        return res.status(400).render('error', {
          status: 400,
          title: 'Некорректные данные',
          message: 'Это имя пользователя уже занято.'
        });
      }
    }

    if (email) {
      const [existingEmail] = await connection.query('SELECT id FROM users WHERE email = ? AND id != ?', [email, userId]);
      if (existingEmail.length > 0) {
        connection.release();
        return res.status(400).render('error', {
          status: 400,
          title: 'Некорректные данные',
          message: 'Этот адрес электронной почты уже зарегистрирован.'
        });
      }
    }

    let updates = [];
    let params = [];

    if (username) { updates.push('username = ?'); params.push(username.trim()); }
    if (email) { updates.push('email = ?'); params.push(email); }
    if (discord !== undefined) { updates.push('discord = ?'); params.push(discord); }
    if (telegram !== undefined) { updates.push('telegram = ?'); params.push(telegram); }
    if (about !== undefined) { updates.push('about = ?'); params.push(about); }
    if (birthdate) { updates.push('birthdate = ?'); params.push(birthdate); }
    if (timezone !== undefined) { updates.push('timezone = ?'); params.push(timezone); }

    if (password) {
      if (password.length < 6) {
        connection.release();
        return res.status(400).render('error', {
          status: 400,
          title: 'Некорректные данные',
          message: 'Пароль должен состоять минимум из 6 символов.'
        });
      }
      const hash = await bcrypt.hash(password, 10);
      updates.push('password = ?'); params.push(hash);
      updates.push('last_password_change = NOW()');
    }

    if (remove_avatar === '1') {
      updates.push('avatar = ?'); params.push('/images/default_user_avatar.png');
    } else if (req.file) {
      updates.push('avatar = ?'); params.push('/images/avatars/' + req.file.filename);
    }

    if (updates.length > 0) {
      params.push(userId);
      await connection.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    const [uRows] = await connection.query('SELECT username FROM users WHERE id = ?', [userId]);
    const targetUsername = uRows.length > 0 ? uRows[0].username : 'Unknown';

    connection.release();

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, `Изменил профиль пользователя "${targetUsername}" (ID: ${userId})`, userIp);

    req.session.success_msg = 'Профиль пользователя успешно обновлен';
    res.redirect('/users/' + userId + '/edit');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { status: 500, title: 'Ошибка сервера', message: 'Произошла непредвиденная ошибка на сервере.' });
  }
});

// --- Settings ---
router.get('/settings', async (req, res) => {
  try {
    const { pool } = require('../config/db');
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT setting_value FROM system_settings WHERE setting_key = "invite_system_enabled"');
    const invite_system_enabled = rows.length > 0 && rows[0].setting_value === '1';
    connection.release();
    res.render('settings', { invite_system_enabled });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка загрузки настроек' });
  }
});

router.post('/settings', async (req, res) => {
  try {
    const { pool } = require('../config/db');
    const connection = await pool.getConnection();
    const isEnabled = req.body.invite_system_enabled === '1' ? '1' : '0';
    await connection.query('INSERT INTO system_settings (setting_key, setting_value) VALUES ("invite_system_enabled", ?) ON DUPLICATE KEY UPDATE setting_value = ?', [isEnabled, isEnabled]);
    connection.release();
    req.session.success_msg = 'Настройки инвайтов сохранены';
    res.redirect('/settings');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сохранения настроек' });
  }
});

router.post('/settings/personal', async (req, res) => {
  try {
    const { pool } = require('../config/db');
    const isEnabled = req.body.blur_18_plus === '1' ? 1 : 0;
    const maskMode = req.body.mask_mode || 'disabled';
    
    // Save blur & mask modes
    await pool.query('UPDATE staff SET blur_18_plus = ?, mask_mode = ? WHERE user_id = ?', [isEnabled, maskMode, req.session.user.id]);
    
    if (req.session.user) {
        req.session.user.mask_mode = maskMode;
    }

    // Save notification settings
    const notify_registration = req.body.notify_registration === '1' ? 1 : 0;
    const notify_creation = req.body.notify_creation === '1' ? 1 : 0;
    const notify_stream = req.body.notify_stream === '1' ? 1 : 0;
    const notify_deletion = req.body.notify_deletion === '1' ? 1 : 0;

    await pool.query(
      `INSERT INTO admin_notification_settings 
       (user_id, notify_registration, notify_creation, notify_stream, notify_deletion) 
       VALUES (?, ?, ?, ?, ?) 
       ON DUPLICATE KEY UPDATE 
       notify_registration = ?, notify_creation = ?, notify_stream = ?, notify_deletion = ?`,
      [
        req.session.user.id,
        notify_registration, notify_creation, notify_stream, notify_deletion,
        notify_registration, notify_creation, notify_stream, notify_deletion
      ]
    );
    
    req.session.success_msg = 'Личные настройки сохранены';
    res.redirect('/settings#personal');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сохранения настроек' });
  }
});

// Interactive Telegram binding routes
router.post('/settings/personal/telegram/bind-link', async (req, res) => {
  try {
    const { pool } = require('../config/db');
    const crypto = require('crypto');
    const bindCode = 'tgbind_' + crypto.randomBytes(8).toString('hex');

    await pool.query(
      `INSERT INTO admin_notification_settings (user_id, tg_bind_code) 
       VALUES (?, ?) 
       ON DUPLICATE KEY UPDATE tg_bind_code = ?`,
      [req.session.user.id, bindCode, bindCode]
    );

    const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'EtoYaTVBot';
    res.redirect(`https://t.me/${botUsername}?start=${bindCode}`);
  } catch (err) {
    console.error('Error generating bind link:', err);
    req.session.error_msg = 'Не удалось сгенерировать токен привязки';
    res.redirect('/settings#personal');
  }
});

router.get('/settings/personal/telegram/status', async (req, res) => {
  try {
    const { pool } = require('../config/db');
    const [rows] = await pool.query(
      'SELECT tg_chat_id, tg_bind_code FROM admin_notification_settings WHERE user_id = ?',
      [req.session.user.id]
    );
    if (rows.length > 0 && rows[0].tg_chat_id && rows[0].tg_chat_id !== '') {
      return res.json({ bound: true, waiting: false });
    }
    if (rows.length > 0 && rows[0].tg_bind_code) {
      return res.json({ bound: false, waiting: true });
    }
    res.json({ bound: false, waiting: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/settings/personal/telegram/unbind', async (req, res) => {
  try {
    const { pool } = require('../config/db');
    await pool.query(
      'UPDATE admin_notification_settings SET tg_chat_id = "", tg_bind_code = NULL WHERE user_id = ?',
      [req.session.user.id]
    );
    req.session.success_msg = 'Telegram успешно отвязан';
    res.redirect('/settings#personal');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка при отвязке Telegram' });
  }
});


// --- Invites ---
router.get('/invites', async (req, res) => {
  if (req.user && !req.user.is_superadmin && req.user.staff_role === 'moderator') return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  try {
    const { pool } = require('../config/db');
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
    
    const { pool } = require('../config/db');
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
    const { pool } = require('../config/db');
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

