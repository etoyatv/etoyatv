const express = require('express');
const router = express.Router();
const { logAction } = require('../../utils/logger');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const { redirectBack } = require('../../utils/safeRedirect');

const avatarsDir = path.join(__dirname, '../../public/images/avatars');
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

// Users Route
router.get('/users', async (req, res) => {
  try {
    const { pool } = require('../../config/db');
    const connection = await pool.getConnection();

    const isSuper = req.user && req.user.is_superadmin;

    let totalQuery = 'SELECT COUNT(u.id) as total FROM users u';
    let deletedQuery = 'SELECT COUNT(u.id) as deleted FROM users u WHERE u.deleted_at IS NOT NULL';
    let bannedQuery = 'SELECT COUNT(u.id) as banned FROM users u WHERE u.is_banned = 1';
    let usersQuery = `
      SELECT u.id, u.username, u.email, u.avatar, u.is_verified, u.deleted_at, u.role, u.is_banned, s.role as staff_role, s.is_superadmin
      FROM users u
      LEFT JOIN staff s ON u.id = s.user_id
    `;

    if (!isSuper) {
      totalQuery = 'SELECT COUNT(u.id) as total FROM users u LEFT JOIN staff s ON u.id = s.user_id WHERE s.is_superadmin IS NULL OR s.is_superadmin = 0';
      deletedQuery = 'SELECT COUNT(u.id) as deleted FROM users u LEFT JOIN staff s ON u.id = s.user_id WHERE u.deleted_at IS NOT NULL AND (s.is_superadmin IS NULL OR s.is_superadmin = 0)';
      bannedQuery = 'SELECT COUNT(u.id) as banned FROM users u LEFT JOIN staff s ON u.id = s.user_id WHERE u.is_banned = 1 AND (s.is_superadmin IS NULL OR s.is_superadmin = 0)';
      usersQuery += ' WHERE s.is_superadmin IS NULL OR s.is_superadmin = 0';
    }

    // Stats
    const [[{ total }]] = await connection.query(totalQuery);
    const [[{ deleted }]] = await connection.query(deletedQuery);

    // Check if is_banned exists, otherwise return 0 to avoid errors if db hasn't migrated yet
    let banned = 0;
    try {
      const [[b]] = await connection.query(bannedQuery);
      banned = b.banned;
    } catch (e) { }

    // Pagination
    const limit = parseInt(req.query.limit) || 10;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;

    usersQuery += ' ORDER BY u.id DESC LIMIT ? OFFSET ?';
    const [users] = await connection.query(usersQuery, [limit, offset]);

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
    const { pool } = require('../../config/db');
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
      const isSuper = req.user && req.user.is_superadmin;
      let countSql = 'SELECT COUNT(u.id) as total FROM users u';
      if (!isSuper) {
        countSql += ' LEFT JOIN staff s ON u.id = s.user_id';
      }

      let sql = `
        SELECT u.id, u.username, u.email, u.avatar, u.is_verified, u.deleted_at, u.role, u.is_banned, s.role as staff_role, s.is_superadmin
        FROM users u
        LEFT JOIN staff s ON u.id = s.user_id
      `;
      let params = [];

      let whereClause = '';
      if (type === 'id') {
        whereClause = 'u.id = ?';
        params.push(query);
      } else if (type === 'email') {
        whereClause = 'u.email LIKE ?';
        params.push('%' + query + '%');
      } else {
        whereClause = 'u.username LIKE ?';
        params.push('%' + query + '%');
      }

      if (!isSuper) {
        whereClause += ' AND (s.is_superadmin IS NULL OR s.is_superadmin = 0)';
      }

      sql += ' WHERE ' + whereClause;
      countSql += ' WHERE ' + whereClause;

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
    const adminId = req.session.user ? req.session.user.id : null;
    if (adminId && req.params.id == adminId) {
      return res.status(400).render('error', { status: 400, title: 'Ошибка', message: 'Вы не можете заблокировать самого себя.' });
    }

    const { pool } = require('../../config/db');
    const connection = await pool.getConnection();

    if (!(await checkAccess(req, connection, req.params.id))) {
      connection.release();
      return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'У вас нет прав для выполнения этого действия.' });
    }

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
          const { isProtectedIp } = require('../../utils/ipChecker');
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
    redirectBack(req, res, '/');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { status: 500, title: 'Ошибка сервера', message: 'Произошла непредвиденная ошибка на сервере.' });
  }
});

// Delete user
router.post('/users/:id/delete', async (req, res) => {
  try {
    const { pool } = require('../../config/db');
    const connection = await pool.getConnection();

    if (!(await checkAccess(req, connection, req.params.id))) {
      connection.release();
      return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'У вас нет прав для выполнения этого действия.' });
    }

    const { action_type, reason } = req.body;

    if (action_type === 'restore') {
      await connection.query('UPDATE users SET deleted_at = NULL, delete_reason = NULL, deleted_by_admin = 0 WHERE id = ?', [req.params.id]);
      await connection.query('UPDATE channels SET status = "active", deleted_at = NULL, rtmp_disabled = 0 WHERE user_id = ? AND deleted_at IS NOT NULL', [req.params.id]);
      const [uRows] = await connection.query('SELECT username FROM users WHERE id = ?', [req.params.id]);
      const targetUsername = uRows.length > 0 ? uRows[0].username : 'Unknown';
      connection.release();
      const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
      logAction('admin', req.session.user.username, `Восстановил пользователя "${targetUsername}" (ID: ${req.params.id})`, userIp);
      req.session.success_msg = 'Пользователь успешно восстановлен';
      redirectBack(req, res, '/');
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
      redirectBack(req, res, '/');
    }
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { status: 500, title: 'Ошибка сервера', message: 'Произошла непредвиденная ошибка на сервере.' });
  }
});

router.post('/users/:id/confirm', async (req, res) => {
  try {
    const { pool } = require('../../config/db');
    const connection = await pool.getConnection();

    if (!(await checkAccess(req, connection, req.params.id))) {
      connection.release();
      return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'У вас нет прав для выполнения этого действия.' });
    }

    const [uRows] = await connection.query('SELECT username FROM users WHERE id = ?', [req.params.id]);
    if (uRows.length === 0) {
      connection.release();
      return res.status(404).render('error', { status: 404, title: 'Не найдено', message: 'Пользователь не найден.' });
    }
    const targetUsername = uRows[0].username;

    await connection.query('UPDATE users SET is_verified = 1, verification_token = NULL WHERE id = ?', [req.params.id]);
    connection.release();

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, `Подтвердил email/аккаунт пользователя "${targetUsername}" (ID: ${req.params.id})`, userIp);

    req.session.success_msg = 'Пользователь успешно подтвержден';
    redirectBack(req, res, '/');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { status: 500, title: 'Ошибка сервера', message: 'Произошла непредвиденная ошибка на сервере.' });
  }
});

// User Edit Form
router.get('/users/:id/edit', async (req, res) => {
  try {
    const { pool } = require('../../config/db');
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
    const { pool } = require('../../config/db');
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
    const { pool } = require('../../config/db');
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

    let currentEmail = '';
    if (email) {
      const [currentUserRows] = await connection.query('SELECT email FROM users WHERE id = ?', [userId]);
      if (currentUserRows.length > 0) {
        currentEmail = currentUserRows[0].email || '';
      }

      const trimmedEmail = email.trim();
      if (trimmedEmail.toLowerCase() !== currentEmail.toLowerCase()) {
        const [existingEmail] = await connection.query('SELECT id FROM users WHERE LOWER(email) = ? AND id != ?', [trimmedEmail.toLowerCase(), userId]);
        if (existingEmail.length > 0) {
          connection.release();
          return res.status(400).render('error', {
            status: 400,
            title: 'Некорректные данные',
            message: 'Этот адрес электронной почты уже зарегистрирован.'
          });
        }
      }
    }

    let updates = [];
    let params = [];

    if (username) { updates.push('username = ?'); params.push(username.trim()); }
    if (email && email.trim() !== currentEmail) {
      updates.push('email = ?');
      params.push(email.trim());
      updates.push('last_email_change = NOW()');
    }
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

module.exports = router;
