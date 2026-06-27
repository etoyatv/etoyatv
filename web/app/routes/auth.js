const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../../config/db');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const emailService = require('../../emailService');
const { requireAuth } = require('../../middlewares/auth');
const { panelMiddleware, recordUploadMiddleware, designUploadMiddleware } = require('../../middlewares/panel');
const { logAction } = require('../../utils/logger');
const wordFilter = require('../../utils/wordFilter');
const { verifyHCaptcha } = require('../../utils/hcaptcha');

router.get('/login', (req, res) => {
  if (req.ip_ban && req.ip_ban.ban_type === 'account') {
    return res.render('login', { pageTitle: 'Вход | ЭтоЯTV', error: 'Ваш IP-адрес заблокирован для использования аккаунтов. Вы можете находиться на сайте только в режиме зрителя.' });
  }
  if (req.session.user) return res.redirect('/');
  res.render('login', { pageTitle: 'Вход | ЭтоЯTV', error: null });
});

router.get('/register', async (req, res) => {
  if (req.ip_ban && req.ip_ban.ban_type === 'account') {
    return res.render('register', { pageTitle: 'Регистрация | ЭтоЯTV', error: 'Ваш IP-адрес заблокирован для использования аккаунтов. Вы можете находиться на сайте только в режиме зрителя.', is_ip_banned: true });
  }
  if (req.session.user) return res.redirect('/');
  if (res.locals.systemSettings && res.locals.systemSettings['registration_disabled'] === '1') {
    return res.render('register', { pageTitle: 'Регистрация | ЭтоЯTV', error: 'Регистрация временно отключена администратором.' });
  }
  res.render('register', { pageTitle: 'Регистрация | ЭтоЯTV' });
});

router.post('/register', async (req, res) => {
  if (req.ip_ban && req.ip_ban.ban_type === 'account') {
    const invite_system_enabled = res.locals.systemSettings ? res.locals.systemSettings['invite_system_enabled'] === '1' : false;
    return res.render('register_form', { pageTitle: 'Регистрация | ЭтоЯTV', error: 'Ваш IP-адрес заблокирован для использования аккаунтов. Вы можете находиться на сайте только в режиме зрителя.', invite_system_enabled, is_ip_banned: true });
  }
  if (req.session.user) return res.redirect('/');
  if (res.locals.systemSettings && res.locals.systemSettings['registration_disabled'] === '1') {
    return res.render('register', { pageTitle: 'Регистрация | ЭтоЯTV', error: 'Регистрация временно отключена администратором.' });
  }

  const invite_system_enabled = res.locals.systemSettings ? res.locals.systemSettings['invite_system_enabled'] === '1' : false;
  const captchaToken = req.body['h-captcha-response'];
  const isCaptchaValid = await verifyHCaptcha(captchaToken);
  if (!isCaptchaValid) {
    return res.render('register_form', {
      pageTitle: 'Регистрация | ЭтоЯTV',
      error: 'Пожалуйста, подтвердите, что вы не робот.',
      invite_system_enabled
    });
  }

  const { username, email, password, invite_code } = req.body;
  
  try {
    const connection = await pool.getConnection();
    
    // Check invite system setting
    const [settingRows] = await connection.query('SELECT setting_value FROM system_settings WHERE setting_key = "invite_system_enabled"');
    const invite_system_enabled = settingRows.length > 0 && settingRows[0].setting_value === '1';
    
    let inviteId = null;
    let inviteCreatorId = null;
    if (invite_system_enabled) {
      if (!invite_code) {
        connection.release();
        return res.render('register_form', { pageTitle: 'Регистрация | ЭтоЯTV', error: 'Требуется инвайт-код', invite_system_enabled });
      }
      const [invRows] = await connection.query(`
        SELECT i.id, i.creator_id 
        FROM invite_codes i
        JOIN users u ON i.creator_id = u.id
        WHERE i.code = ? 
          AND i.used_at IS NULL
          AND u.deleted_at IS NULL 
          AND u.wipe_date IS NULL
          AND (u.is_banned = 0 OR (u.banned_until IS NOT NULL AND u.banned_until < NOW()))
      `, [invite_code]);
      if (invRows.length === 0) {
        connection.release();
        return res.render('register_form', { pageTitle: 'Регистрация | ЭтоЯTV', error: 'Неверный или уже использованный инвайт-код', invite_system_enabled });
      }
      inviteId = invRows[0].id;
      inviteCreatorId = invRows[0].creator_id;
    }

    if (username && username.length > 13) {
      connection.release();
      return res.render('register_form', {
        pageTitle: 'Регистрация | ЭтоЯTV',
        error: 'Имя пользователя не должно превышать 13 символов',
        invite_system_enabled
      });
    }

    const usernameRegex = /^[a-zA-Z0-9_-]+$/;
    if (username && !usernameRegex.test(username)) {
      connection.release();
      return res.render('register_form', {
        pageTitle: 'Регистрация | ЭтоЯTV',
        error: 'Имя пользователя может содержать только латинские буквы, цифры, дефисы и нижние подчеркивания',
        invite_system_enabled
      });
    }

    if (await wordFilter.containsBadWords(username)) {
      connection.release();
      return res.render('register_form', {
        pageTitle: 'Регистрация | ЭтоЯTV',
        error: 'Пользователя с запрещенным словом нельзя создавать.',
        invite_system_enabled
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const [existing] = await connection.query('SELECT * FROM users WHERE username = ? OR email = ?', [username, email]);

    let token = crypto.randomBytes(32).toString('hex');
    let expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    if (existing.length > 0) {
      const user = existing[0];
      const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;

      if (user.is_verified === 1) {
        connection.release();
        return res.render('register_form', { pageTitle: 'Регистрация | ЭтоЯTV', error: 'Логин или email уже занят', invite_system_enabled });
      } else {
        // Check cooldown
        if (user.last_email_sent && (Date.now() - new Date(user.last_email_sent).getTime() < 60000)) {
          connection.release();
          return res.render('register_form', { pageTitle: 'Регистрация | ЭтоЯTV', error: 'Письмо с подтверждением уже отправлено. Подождите 60 секунд.', invite_system_enabled });
        }
        await connection.query(
          'UPDATE users SET password = ?, verification_token = ?, verification_expires = ?, last_email_sent = NOW(), invited_by = ?, reg_ip = ?, last_ip = ? WHERE id = ?',
          [hashedPassword, token, expires, inviteCreatorId, userIp, userIp, user.id]
        );
        if (inviteId) {
          await connection.query('UPDATE invite_codes SET used_by_id = ?, used_at = NOW() WHERE id = ?', [user.id, inviteId]);
        }
        connection.release();
        emailService.sendVerificationEmail(email, username, token);
        return res.render('unverified_info', { pageTitle: 'Регистрация | ЭтоЯTV', email: email });
      }
    } else {
      const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
      const [insertRes] = await connection.query(
        'INSERT INTO users (username, email, password, is_verified, verification_token, verification_expires, last_email_sent, invited_by, reg_ip, last_ip) VALUES (?, ?, ?, 0, ?, ?, NOW(), ?, ?, ?)',
        [username, email, hashedPassword, token, expires, inviteCreatorId, userIp, userIp]
      );
      if (inviteId) {
        await connection.query('UPDATE invite_codes SET used_by_id = ?, used_at = NOW() WHERE id = ?', [insertRes.insertId, inviteId]);
      }
      connection.release();
      emailService.sendVerificationEmail(email, username, token);
      logAction('user', username, `Зарегистрировал новый аккаунт (Email: ${email})`, userIp);
      return res.render('unverified_info', { pageTitle: 'Регистрация | ЭтоЯTV', email: email });
    }
  } catch (err) {
    console.error(err);
    res.render('register_form', {
      pageTitle: 'Регистрация | ЭтоЯTV',
      error: 'Ошибка при регистрации (возможно, логин или email занят)'
    });
  }
});

router.post('/login', async (req, res) => {
  if (req.ip_ban && req.ip_ban.ban_type === 'account') {
    return res.render('login', { pageTitle: 'Вход | ЭтоЯTV', error: 'Ваш IP-адрес заблокирован для использования аккаунтов. Вы можете находиться на сайте только в режиме зрителя.' });
  }

  const captchaToken = req.body['h-captcha-response'];
  const isCaptchaValid = await verifyHCaptcha(captchaToken);
  if (!isCaptchaValid) {
    return res.render('login', {
      pageTitle: 'Вход | ЭтоЯTV',
      error: 'Пожалуйста, подтвердите, что вы не робот.'
    });
  }

  const { username, password } = req.body;
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT * FROM users WHERE username = ?', [username]);
    connection.release();
    if (rows.length > 0) {
      const match = await bcrypt.compare(password, rows[0].password);
      if (match) {
        if (rows[0].deleted_at) {
          if (rows[0].deleted_by_admin) {
            return res.render('login', {
              pageTitle: 'Вход | ЭтоЯTV',
              error: 'Этот аккаунт был заблокирован или удален администрацией платформы.'
            });
          }
          const deletedDate = new Date(rows[0].deleted_at);
          const diffDays = (Date.now() - deletedDate.getTime()) / (1000 * 60 * 60 * 24);
          if (diffDays > 90) {
            return res.render('login', {
              pageTitle: 'Вход | ЭтоЯTV',
              error: 'Этот аккаунт был удален безвозвратно.'
            });
          } else {
            return res.render('account_restore', {
              pageTitle: 'Восстановление аккаунта | ЭтоЯTV',
              userToRestore: rows[0].username,
              daysLeft: Math.floor(90 - diffDays)
            });
          }
        }

        if (rows[0].is_verified === 0) {
          return res.render('login', {
            pageTitle: 'Вход | ЭтоЯTV',
            error: 'Ваша учетная запись не подтверждена. Письмо с подтверждением отправлено на ваш email.',
            unverifiedUser: username
          });
        }
        
        // Ban check
        const now = new Date();
        const isBanned = rows[0].is_banned && (!rows[0].banned_until || new Date(rows[0].banned_until) > now);
        if (isBanned) {
          let banMessage = 'Данный пользователь заблокирован администрацией или модерацией платформы.';
          if (rows[0].banned_until) {
             banMessage += ` Блокировка до ${new Date(rows[0].banned_until).toLocaleDateString('ru-RU')}.`;
          } else {
             banMessage += ` Блокировка перманентная.`;
          }
          if (rows[0].show_ban_reason && rows[0].ban_reason) {
             banMessage += ` Причина: ${rows[0].ban_reason}`;
          }
          return res.render('login', {
            pageTitle: 'Вход | ЭтоЯTV',
            error: banMessage
          });
        }
        if (rows[0].is_totp_enabled) {
          req.session.pending_2fa_user = { id: rows[0].id, username: rows[0].username, email: rows[0].email, role: rows[0].role, timezone: rows[0].timezone };
          return req.session.save((err) => {
            res.redirect('/login/2fa');
          });
        }

        req.session.user = { id: rows[0].id, username: rows[0].username, email: rows[0].email, role: rows[0].role, timezone: rows[0].timezone };
        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
        logAction('user', rows[0].username, 'Вошел в свой аккаунт', userIp);
        return req.session.save((err) => {
          res.redirect('/');
        });
      }
    }
    res.render('login', {
      pageTitle: 'Вход | ЭтоЯTV',
      error: 'Неверный логин или пароль'
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка сервера');
  }
});

router.get('/login/2fa', (req, res) => {
  if (!req.session.pending_2fa_user) return res.redirect('/login');
  res.render('login_2fa', { pageTitle: 'Двухфакторная аутентификация | ЭтоЯTV', error: null });
});

router.post('/login/2fa', async (req, res) => {
  if (!req.session.pending_2fa_user) return res.redirect('/login');
  const { code } = req.body;
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT totp_secret, totp_backup_codes FROM users WHERE id = ?', [req.session.pending_2fa_user.id]);
    connection.release();
    if (rows.length === 0) return res.redirect('/login');

    const authenticator = require('otplib').authenticator;
    const isValid = authenticator.check(code, rows[0].totp_secret);
    
    let isValidBackup = false;
    let newBackupCodes = null;
    
    if (!isValid && rows[0].totp_backup_codes) {
      const backupCodes = JSON.parse(rows[0].totp_backup_codes);
      if (backupCodes.includes(code)) {
        isValidBackup = true;
        newBackupCodes = backupCodes.filter(c => c !== code);
      }
    }

    if (isValid || isValidBackup) {
      if (isValidBackup) {
        const conn = await pool.getConnection();
        await conn.query('UPDATE users SET totp_backup_codes = ? WHERE id = ?', [JSON.stringify(newBackupCodes), req.session.pending_2fa_user.id]);
        conn.release();
      }
      req.session.user = req.session.pending_2fa_user;
      delete req.session.pending_2fa_user;
      const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
      logAction('user', req.session.user.username, 'Вошел в свой аккаунт (2FA)', userIp);
      return req.session.save(() => res.redirect('/'));
    }

    res.render('login_2fa', { pageTitle: 'Двухфакторная аутентификация | ЭтоЯTV', error: 'Неверный код' });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка сервера');
  }
});

router.get('/forgot-password', (req, res) => {
  if (req.ip_ban && req.ip_ban.ban_type === 'account') {
    return res.render('forgot_password', { pageTitle: 'Восстановление пароля | ЭтоЯTV', error: 'Ваш IP-адрес заблокирован для использования аккаунтов. Вы можете находиться на сайте только в режиме зрителя.', success: null });
  }
  if (req.session.user) return res.redirect('/');
  res.render('forgot_password', { pageTitle: 'Восстановление пароля | ЭтоЯTV', error: null, success: null });
});

router.post('/forgot-password', async (req, res) => {
  if (req.ip_ban && req.ip_ban.ban_type === 'account') {
    return res.render('forgot_password', { pageTitle: 'Восстановление пароля | ЭтоЯTV', error: 'Ваш IP-адрес заблокирован для использования аккаунтов. Вы можете находиться на сайте только в режиме зрителя.', success: null });
  }

  const captchaToken = req.body['h-captcha-response'];
  const isCaptchaValid = await verifyHCaptcha(captchaToken);
  if (!isCaptchaValid) {
    return res.render('forgot_password', {
      pageTitle: 'Восстановление пароля | ЭтоЯTV',
      error: 'Пожалуйста, подтвердите, что вы не робот.',
      success: null
    });
  }

  const { email } = req.body;
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT * FROM users WHERE email = ?', [email]);
    if (rows.length > 0) {
      const user = rows[0];
      if (user.last_reset_sent && (Date.now() - new Date(user.last_reset_sent).getTime() < 60000)) {
        connection.release();
        return res.render('forgot_password', { pageTitle: 'Восстановление пароля | ЭтоЯTV', error: 'Письмо уже отправлено. Подождите 60 секунд.', success: null });
      }
      let token = crypto.randomBytes(32).toString('hex');
      let expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      await connection.query('UPDATE users SET reset_token = ?, reset_expires = ?, last_reset_sent = NOW() WHERE id = ?', [token, expires, user.id]);
      connection.release();
      emailService.sendPasswordResetEmail(user.email, user.username, token);
    } else {
      connection.release();
    }
    res.render('forgot_password', { pageTitle: 'Восстановление пароля | ЭтоЯTV', error: null, success: 'Если адрес существует, на него отправлено письмо со ссылкой для восстановления пароля.' });
  } catch (e) {
    console.error(e);
    res.render('forgot_password', { pageTitle: 'Восстановление пароля | ЭтоЯTV', error: 'Ошибка сервера', success: null });
  }
});

router.get('/reset-password', async (req, res) => {
  if (req.ip_ban && req.ip_ban.ban_type === 'account') {
    return res.status(403).send('Ваш IP-адрес заблокирован для использования аккаунтов. Вы можете находиться на сайте только в режиме зрителя.');
  }
  const { token, email } = req.query;
  if (!token || !email) return res.redirect('/login');
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT * FROM users WHERE email = ? AND reset_token = ? AND reset_expires > NOW()', [email, token]);
    connection.release();
    if (rows.length > 0) {
      res.render('reset_password', { pageTitle: 'Смена пароля | ЭтоЯTV', email, token, error: null });
    } else {
      res.status(400).send('Ссылка недействительна или срок ее действия истек.');
    }
  } catch (e) {
    res.status(500).send('Ошибка сервера');
  }
});

router.post('/reset-password', async (req, res) => {
  if (req.ip_ban && req.ip_ban.ban_type === 'account') {
    return res.status(403).send('Ваш IP-адрес заблокирован для использования аккаунтов. Вы можете находиться на сайте только в режиме зрителя.');
  }
  const { token, email, password } = req.body;
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT * FROM users WHERE email = ? AND reset_token = ? AND reset_expires > NOW()', [email, token]);
    if (rows.length > 0) {
      const hashedPassword = await bcrypt.hash(password, 10);
      await connection.query('UPDATE users SET password = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?', [hashedPassword, rows[0].id]);
      connection.release();
      const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
      logAction('user', rows[0].username, 'Изменил пароль путем восстановления', userIp);
      res.render('login', { pageTitle: 'Вход | ЭтоЯTV', error: null, success: 'Пароль успешно изменен. Теперь вы можете войти.' });
    } else {
      connection.release();
      res.render('reset_password', { pageTitle: 'Смена пароля | ЭтоЯTV', email, token, error: 'Ссылка недействительна или срок ее действия истек.' });
    }
  } catch (e) {
    res.status(500).send('Ошибка сервера');
  }
});

router.get('/logout', (req, res) => {
  if (req.session.user) {
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('user', req.session.user.username, 'Вышел из своего аккаунта', userIp);
  }
  req.session.destroy(() => {
    res.redirect('/');
  });
});


router.get('/register/form', async (req, res) => {
  if (req.ip_ban && req.ip_ban.ban_type === 'account') {
    const invite_system_enabled = res.locals.systemSettings ? res.locals.systemSettings['invite_system_enabled'] === '1' : false;
    return res.render('register_form', { pageTitle: 'Регистрация | ЭтоЯTV', error: 'Ваш IP-адрес заблокирован для использования аккаунтов. Вы можете находиться на сайте только в режиме зрителя.', invite_system_enabled, is_ip_banned: true });
  }
  if (req.session.user) return res.redirect('/');
  if (res.locals.systemSettings && res.locals.systemSettings['registration_disabled'] === '1') {
    return res.render('register_form', { pageTitle: 'Регистрация | ЭтоЯTV', error: 'Регистрация временно отключена администратором.', invite_system_enabled: false });
  }
  try {
    const invite_system_enabled = res.locals.systemSettings ? res.locals.systemSettings['invite_system_enabled'] === '1' : false;
    res.render('register_form', { pageTitle: 'Регистрация | ЭтоЯTV', error: null, invite_system_enabled });
  } catch(err) {
    console.error(err);
    res.render('register_form', { pageTitle: 'Регистрация | ЭтоЯTV', error: 'Ошибка сервера', invite_system_enabled: false });
  }
});

router.get('/register/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/login');
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT * FROM users WHERE verification_token = ? AND verification_expires > NOW()', [token]);
    if (rows.length > 0) {
      await connection.query('UPDATE users SET is_verified = 1, verification_token = NULL, verification_expires = NULL WHERE id = ?', [rows[0].id]);
      connection.release();
      res.render('login', { pageTitle: 'Вход | ЭтоЯTV', error: null, success: 'Аккаунт успешно подтвержден. Теперь вы можете войти.' });
    } else {
      connection.release();
      res.status(400).send('Ссылка недействительна или срок ее действия истек.');
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка сервера');
  }
});

router.post('/register/resend', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.redirect('/login');
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT * FROM users WHERE email = ?', [email]);
    if (rows.length > 0 && rows[0].is_verified === 0) {
       const user = rows[0];
       if (user.last_email_sent && (Date.now() - new Date(user.last_email_sent).getTime() < 60000)) {
         connection.release();
         return res.render('unverified_info', { pageTitle: 'Регистрация | ЭтоЯTV', email: email, error: 'Письмо уже отправлено. Подождите 60 секунд.' });
       }
       let token = crypto.randomBytes(32).toString('hex');
       let expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
       await connection.query('UPDATE users SET verification_token = ?, verification_expires = ?, last_email_sent = NOW() WHERE id = ?', [token, expires, user.id]);
       connection.release();
       const emailService = require('../../emailService');
       emailService.sendVerificationEmail(email, user.username, token);
       return res.render('unverified_info', { pageTitle: 'Регистрация | ЭтоЯTV', email: email, success: 'Письмо отправлено повторно.' });
    }
    connection.release();
    res.redirect('/login');
  } catch(e) {
    res.status(500).send('Ошибка сервера');
  }
});

router.post('/restore-account', async (req, res) => {
  const { username } = req.body;
  try {
    const connection = await pool.getConnection();
    const [userRows] = await connection.query('SELECT id, deleted_by_admin FROM users WHERE username = ?', [username]);
    if (userRows.length > 0) {
      if (userRows[0].deleted_by_admin) {
        connection.release();
        return res.render('login', { pageTitle: 'Вход | ЭтоЯTV', error: 'Этот аккаунт был заблокирован или удален администрацией платформы.', success: null });
      }
      const userId = userRows[0].id;
      await connection.query('UPDATE users SET deleted_at = NULL WHERE id = ?', [userId]);
      await connection.query('UPDATE channels SET status = "active", deleted_at = NULL, rtmp_disabled = 0 WHERE user_id = ? AND status = "deleted"', [userId]);
      const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
      logAction('user', username, 'Отменил удаление своего аккаунта (восстановил)', userIp);
    }
    connection.release();
    res.render('login', { pageTitle: 'Вход | ЭтоЯTV', success: 'Аккаунт восстановлен. Вы можете войти.', error: null });
  } catch(e) {
    res.status(500).send('Ошибка сервера');
  }
});

module.exports = router;
