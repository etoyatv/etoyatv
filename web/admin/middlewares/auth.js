const { pool } = require('../config/db');
const { logAction } = require('../utils/logger');

const requireAdminAuth = async (req, res, next) => {
  if (!req.session.user) {
    const ip = req.ip || req.connection.remoteAddress;
    console.warn(`[SECURITY] Попытка входа в админку без авторизации. IP: ${ip}`);
    await logAction('system', 'Система', `Попытка входа в админку без авторизации (Не залогинен)`, ip);
    return res.redirect('https://youtube.com/watch?v=dQw4w9WgXcQ');
  }

  try {
    const connection = await pool.getConnection();
    const [staffRows] = await connection.query(`
      SELECT s.role, s.is_superadmin, s.blur_18_plus, s.mask_mode, u.avatar, u.is_totp_enabled 
      FROM staff s 
      JOIN users u ON s.user_id = u.id 
      WHERE s.user_id = ?
    `, [req.session.user.id]);
    connection.release();

    if (staffRows.length === 0) {
      const ip = req.ip || req.connection.remoteAddress;
      console.warn(`[SECURITY] Пользователь ${req.session.user.username} (ID: ${req.session.user.id}) пытался зайти в админку без прав! IP: ${ip}`);
      await logAction('system', req.session.user.username, `Попытка входа в админку без прав персонала`, ip);
      return res.redirect('https://youtube.com/watch?v=dQw4w9WgXcQ');
    }

    if (!staffRows[0].is_totp_enabled) {
      const ip = req.ip || req.connection.remoteAddress;
      console.warn(`[SECURITY] Член персонала ${req.session.user.username} (ID: ${req.session.user.id}) пытался зайти в админку без включенной 2FA! IP: ${ip}`);
      await logAction('system', req.session.user.username, `Попытка входа в админку без включенной 2FA`, ip);
      const appUrl = process.env.APP_URL || 'http://localhost:3001';
      return res.redirect(appUrl + '/account/2fa/setup');
    }

    req.user = req.session.user;
    req.user.staff_role = staffRows[0].role;
    req.user.is_superadmin = staffRows[0].is_superadmin;
    req.user.blur_18_plus = staffRows[0].blur_18_plus === 1;
    req.user.mask_mode = staffRows[0].mask_mode;
    req.user.avatar = staffRows[0].avatar;
    res.locals.user = req.user;
    res.locals.currentPath = req.path;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).send('Внутренняя ошибка сервера');
  }
};

module.exports = { requireAdminAuth };
