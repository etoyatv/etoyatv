const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const emailService = require('../../../emailService');
const wordFilter = require('../../../utils/wordFilter');
const { requireAuth } = require('../../../middlewares/auth');
const multer = require('multer');
const { upload } = require('../../../config/upload');
const { logAction } = require('../../../utils/logger');

router.get('/ru/account,profile/', requireAuth, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
    
    const invitePage = Math.max(1, parseInt(req.query.invite_page) || 1);
    const limit = 5;
    const offset = (invitePage - 1) * limit;

    const [totalRows] = await connection.query('SELECT COUNT(*) as count FROM invite_codes WHERE creator_id = ?', [req.session.user.id]);
    const totalInvites = totalRows[0].count;
    const totalInvitePages = Math.ceil(totalInvites / limit) || 1;

    // Fetch user's invite codes
    const [invites] = await connection.query(`
      SELECT i.*, u.username as used_by_name 
      FROM invite_codes i
      LEFT JOIN users u ON i.used_by_id = u.id
      WHERE i.creator_id = ?
      ORDER BY i.created_at DESC
      LIMIT ? OFFSET ?
    `, [req.session.user.id, limit, offset]);

    const [bannedChannels] = await connection.query("SELECT id FROM channels WHERE user_id = ? AND status = 'banned'", [req.session.user.id]);
    const hasBannedChannel = bannedChannels.length > 0;

    const error2FA = req.session.error2FA;
    delete req.session.error2FA;

    const errorSession = req.session.errorSession;
    delete req.session.errorSession;
    const successSession = req.session.successSession;
    delete req.session.successSession;

    const successPassword = req.session.successPassword;
    delete req.session.successPassword;
    const errorPassword = req.session.errorPassword;
    delete req.session.errorPassword;

    const errorInvite = req.session.errorInvite;
    delete req.session.errorInvite;
    const successInvite = req.session.successInvite;
    delete req.session.successInvite;

    const errorProfile = req.session.errorProfile;
    delete req.session.errorProfile;
    const successProfile = req.session.successProfile;
    delete req.session.successProfile;

    const errorAbout = req.session.errorAbout;
    delete req.session.errorAbout;
    const successAbout = req.session.successAbout;
    delete req.session.successAbout;

    const errorBoosty = req.session.errorBoosty;
    delete req.session.errorBoosty;
    const successBoosty = req.session.successBoosty;
    delete req.session.successBoosty;

    const errorPrivacy = req.session.errorPrivacy;
    delete req.session.errorPrivacy;
    const successPrivacy = req.session.successPrivacy;
    delete req.session.successPrivacy;

    const pendingBoostyEmail = req.session.pending_boosty_link ? req.session.pending_boosty_link.email : null;

    const [profileChannelRows] = await connection.query('SELECT * FROM channels WHERE user_id = ? AND is_personal = TRUE LIMIT 1', [req.session.user.id]);
    const profileChannel = profileChannelRows.length > 0 ? profileChannelRows[0] : null;

    connection.release();
    res.render('settings', { 
      pageTitle: 'Настройки профиля | ЭтоЯTV', 
      profileUser: rows[0], 
      profileChannel,
      invites,
      invitePage,
      totalInvitePages,
      hasBannedChannel,
      error2FA,
      errorSession,
      successSession,
      successPassword,
      errorPassword,
      errorInvite,
      successInvite,
      errorProfile,
      successProfile,
      errorAbout,
      successAbout,
      errorBoosty,
      successBoosty,
      pendingBoostyEmail,
      errorPrivacy,
      successPrivacy
    });
  } catch (e) {
    console.error('PROFILE ERROR:', e);
    res.status(500).send('Error');
  }
});

router.post('/settings/profile', requireAuth, (req, res) => {
  if (req.ip_ban && req.ip_ban.ban_type === 'account') {
    return res.send('<script>alert("Ваш IP-адрес заблокирован (режим зрителя). Изменение профиля невозможно."); window.location.href="/account,profile/#tab-profile";</script>');
  }
  upload.single('avatar')(req, res, async function (err) {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.send('<script>alert("Размер файла превышает 4 МБ."); setTimeout(function(){ window.location.href="/account,profile/#tab-profile"; }, 1500);</script>');
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.send('<script>alert("Разрешена загрузка только изображений (jpeg, jpg, png, gif, webp)."); setTimeout(function(){ window.location.href="/account,profile/#tab-profile"; }, 1500);</script>');
      }
      return res.send('<script>alert("Ошибка загрузки файла."); setTimeout(function(){ window.location.href="/account,profile/#tab-profile"; }, 1500);</script>');
    } else if (err) {
      return res.send('<script>alert("Ошибка сервера при загрузке."); setTimeout(function(){ window.location.href="/account,profile/#tab-profile"; }, 1500);</script>');
    }

    // Square check for GIF avatar if uploaded
    if (req.file) {
      const isGif = req.file.mimetype === 'image/gif' || path.extname(req.file.originalname).toLowerCase() === '.gif';
      if (isGif && fs.existsSync(req.file.path)) {
        try {
          const sharp = require('sharp');
          const metadata = await sharp(req.file.path).metadata();
          if (metadata.width !== metadata.height) {
            fs.unlinkSync(req.file.path);
            return res.send('<script>alert("Для GIF-аватарок разрешено только квадратное соотношение сторон (например, 100x100, 200x200)."); window.location.href="/account,profile/#tab-profile";</script>');
          }
        } catch (sharpErr) {
          console.error('Failed to parse GIF metadata for avatar:', sharpErr);
          if (fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
          }
          return res.send('<script>alert("Не удалось обработать изображение. Возможно, файл поврежден."); window.location.href="/account,profile/#tab-profile";</script>');
        }
      }
    }

    const { email, timezone, birthdate, lang } = req.body;
    const currentEmail = req.session.user.email;
    const isEmailChanged = email && email.toLowerCase().trim() !== currentEmail.toLowerCase().trim();

    if (isEmailChanged) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        req.session.errorProfile = 'Некорректный формат E-Mail адреса';
        return res.redirect('/account,profile/#tab-profile');
      }

      try {
        const connection = await pool.getConnection();
        const [existing] = await connection.query('SELECT id FROM users WHERE email = ? AND id != ?', [email.trim(), req.session.user.id]);
        connection.release();
        if (existing.length > 0) {
          req.session.errorProfile = 'Этот E-Mail уже занят другим пользователем';
          return res.redirect('/account,profile/#tab-profile');
        }
      } catch (dbErr) {
        console.error('Email uniqueness check failed:', dbErr);
        req.session.errorProfile = 'Ошибка базы данных при проверке E-Mail';
        return res.redirect('/account,profile/#tab-profile');
      }
    }

    const supportedLangs = req.supportedLangs || ['ru', 'en', 'uk', 'be'];
    const selectedLang = supportedLangs.includes(lang) ? lang : 'ru';

    let updateQuery = 'UPDATE users SET timezone = ?, birthdate = ?, lang = ? WHERE id = ?';
    let params = [timezone, birthdate || null, selectedLang, req.session.user.id];

    if (req.file) {
      updateQuery = 'UPDATE users SET timezone = ?, birthdate = ?, avatar = ?, lang = ? WHERE id = ?';
      params = [timezone, birthdate || null, '/images/avatars/' + req.file.filename, selectedLang, req.session.user.id];
      
      try {
        const connection = await pool.getConnection();
        const [oldRows] = await connection.query('SELECT avatar FROM users WHERE id = ?', [req.session.user.id]);
        connection.release();
        if (oldRows.length > 0 && oldRows[0].avatar && oldRows[0].avatar.startsWith('/images/avatars/')) {
          const { deletePublicFileIfExists } = require('../../../utils/safePath');
          const publicRoot = path.join(__dirname, '../../../public');
          deletePublicFileIfExists(oldRows[0].avatar, publicRoot, { ignoreDefaults: false });
        }
      } catch (e) { console.error(e); }
    }

    try {
      const connection = await pool.getConnection();
      await connection.query(updateQuery, params);
      connection.release();
      
      if (timezone) {
        req.session.user.timezone = timezone;
      }
      req.session.user.lang = selectedLang;
      req.session.lang = selectedLang;

      if (isEmailChanged) {
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        req.session.pending_email_change = {
          new_email: email.trim(),
          code: code,
          expires: Date.now() + 15 * 60 * 1000
        };

        try {
          await emailService.sendEmailChangeVerificationCode(email.trim(), req.session.user.username, code);
          res.redirect('/settings/verify-email');
        } catch (mailErr) {
          console.error('Failed to send verification email:', mailErr);
          req.session.errorProfile = 'Не удалось отправить код подтверждения на новый E-Mail';
          res.redirect('/account,profile/#tab-profile');
        }
      } else {
        req.session.successProfile = 'Профиль успешно сохранен';
        res.redirect('/account,profile/#tab-profile');
      }
    } catch (e) {
      console.error('Error saving profile:', e);
      req.session.errorProfile = 'Ошибка при сохранении профиля';
      res.redirect('/account,profile/#tab-profile');
    }
  });
});

router.get('/settings/verify-email', requireAuth, (req, res) => {
  const pending = req.session.pending_email_change;
  if (!pending || Date.now() > pending.expires) {
    delete req.session.pending_email_change;
    req.session.errorProfile = 'Срок действия запроса на изменение E-Mail истек или запрос отсутствует';
    return res.redirect('/account,profile/#tab-profile');
  }

  const error = req.session.verifyEmailError;
  delete req.session.verifyEmailError;

  res.render('verify_email_change', {
    pageTitle: 'Подтверждение смены E-Mail | ЭтоЯTV',
    pendingEmail: pending.new_email,
    error: error || null,
    success: null
  });
});

router.post('/settings/verify-email', requireAuth, async (req, res) => {
  const pending = req.session.pending_email_change;
  if (!pending || Date.now() > pending.expires) {
    delete req.session.pending_email_change;
    req.session.errorProfile = 'Срок действия запроса на изменение E-Mail истек';
    return res.redirect('/account,profile/#tab-profile');
  }

  const { code } = req.body;
  if (!code || code.trim() !== pending.code) {
    req.session.verifyEmailError = 'Неверный код подтверждения';
    return res.redirect('/settings/verify-email');
  }

  try {
    const connection = await pool.getConnection();
    const [oldUser] = await connection.query('SELECT email FROM users WHERE id = ?', [req.session.user.id]);
    await connection.query('UPDATE users SET email = ?, last_email_change = NOW() WHERE id = ?', [pending.new_email, req.session.user.id]);
    connection.release();

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    const oldEmail = oldUser.length > 0 ? oldUser[0].email : '';
    logAction('user', req.session.user.username, `Изменил свою почту с подтверждением. Старая почта: ${oldEmail}. Новая: ${pending.new_email}`, userIp);

    req.session.user.email = pending.new_email;
    delete req.session.pending_email_change;

    req.session.successProfile = 'E-Mail адрес успешно изменен';
    res.redirect('/account,profile/#tab-profile');
  } catch (err) {
    console.error('Error verifying email change:', err);
    req.session.verifyEmailError = 'Произошла ошибка при обновлении E-Mail адреса';
    res.redirect('/settings/verify-email');
  }
});

router.post('/settings/nickname', requireAuth, async (req, res) => {
  if (req.ip_ban && req.ip_ban.ban_type === 'account') {
    return res.render('settings', { pageTitle: 'Настройки | ЭтоЯTV', profileUser: req.session.user, errorNick: 'Смена никнейма заблокирована (режим зрителя).' });
  }
  let { new_nickname } = req.body;
  if (typeof new_nickname !== 'string') {
    new_nickname = '';
  }
  new_nickname = new_nickname.trim();

  if (!new_nickname || new_nickname.length > 13) {
    return res.render('settings', { pageTitle: 'Настройки | ЭтоЯTV', profileUser: req.session.user, errorNick: 'Имя пользователя не должно превышать 13 символов' });
  }

  const usernameRegex = /^[a-zA-Z0-9_-]+$/;
  if (!usernameRegex.test(new_nickname)) {
    return res.render('settings', { pageTitle: 'Настройки | ЭтоЯTV', profileUser: req.session.user, errorNick: 'Имя пользователя может содержать только латинские буквы, цифры, дефисы и нижние подчеркивания' });
  }

  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT username, last_nickname_change FROM users WHERE id = ?', [req.session.user.id]);
    const user = rows[0];

    if (user.last_nickname_change) {
      const diff = Date.now() - new Date(user.last_nickname_change).getTime();
      const days = diff / (1000 * 60 * 60 * 24);
      if (days < 30) {
        connection.release();
        return res.render('settings', { pageTitle: 'Настройки | ЭтоЯTV', profileUser: req.session.user, errorNick: 'Никнейм можно менять только 1 раз в 30 дней.' });
      }
    }

    const [existing] = await connection.query('SELECT id FROM users WHERE username = ?', [new_nickname]);
    if (existing.length > 0) {
      connection.release();
      return res.render('settings', { pageTitle: 'Настройки | ЭтоЯTV', profileUser: req.session.user, errorNick: 'Этот никнейм уже занят.' });
    }

    if (!req.session.user.staff_role && await wordFilter.containsBadWords(new_nickname)) {
      connection.release();
      return res.render('settings', { pageTitle: 'Настройки | ЭтоЯTV', profileUser: req.session.user, errorNick: 'Пользователя с запрещенным словом нельзя создавать.' });
    }

    await connection.query('UPDATE users SET username = ?, last_nickname_change = NOW() WHERE id = ?', [new_nickname, req.session.user.id]);
    await connection.query('INSERT INTO nickname_change_logs (user_id, old_nickname, new_nickname) VALUES (?, ?, ?)', [req.session.user.id, user.username, new_nickname]);

    req.session.user.username = new_nickname;
    connection.release();
    res.render('settings', { pageTitle: 'Настройки | ЭтоЯTV', profileUser: req.session.user, successNick: 'Никнейм успешно изменен!' });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error changing nickname');
  }
});

router.post('/settings/about', requireAuth, async (req, res) => {
  if (req.ip_ban && req.ip_ban.ban_type === 'account') {
    return res.status(403).send('Запрещено в режиме зрителя');
  }
  let { telegram, discord, about } = req.body;
  if (about && about.length > 200) {
    about = about.substring(0, 200);
  }
  try {
    const connection = await pool.getConnection();
    await connection.query('UPDATE users SET telegram = ?, discord = ?, about = ? WHERE id = ?', [telegram, discord, about, req.session.user.id]);
    connection.release();
    req.session.successAbout = 'Информация "О себе" успешно сохранена';
    req.session.save(() => {
      res.redirect('/account,profile/#tab-about');
    });
  } catch (e) {
    req.session.errorAbout = 'Ошибка при сохранении информации "О себе"';
    req.session.save(() => {
      res.redirect('/account,profile/#tab-about');
    });
  }
});

router.post('/settings/privacy', requireAuth, async (req, res) => {
  if (req.ip_ban && req.ip_ban.ban_type === 'account') {
    return res.status(403).send('Запрещено в режиме зрителя');
  }
  const { privacy_profile, privacy_messages, privacy_friends_list, system_emails_enabled } = req.body;
  
  const validProfile = ['public', 'only_friends', 'private'];
  const validMessages = ['all', 'only_friends', 'nobody'];
  const validFriends = ['all', 'only_friends', 'nobody'];
  
  const pProfile = validProfile.includes(privacy_profile) ? privacy_profile : 'public';
  const pMessages = validMessages.includes(privacy_messages) ? privacy_messages : 'all';
  const pFriends = validFriends.includes(privacy_friends_list) ? privacy_friends_list : 'all';
  const emailsEnabled = system_emails_enabled === '0' ? 0 : 1;
  
  try {
    const connection = await pool.getConnection();
    await connection.query(
      `UPDATE users 
       SET privacy_profile = ?, privacy_messages = ?, privacy_friends_list = ?, system_emails_enabled = ? 
       WHERE id = ?`,
      [pProfile, pMessages, pFriends, emailsEnabled, req.session.user.id]
    );
    connection.release();
    
    req.session.successPrivacy = 'Настройки приватности успешно сохранены';
    req.session.save(() => {
      res.redirect('/account,profile/#tab-privacy');
    });
  } catch (e) {
    console.error('Error saving privacy settings:', e);
    req.session.errorPrivacy = 'Ошибка сохранения настроек приватности';
    req.session.save(() => {
      res.redirect('/account,profile/#tab-privacy');
    });
  }
});

router.post('/settings/password', requireAuth, async (req, res) => {
  if (req.ip_ban && req.ip_ban.ban_type === 'account') {
    return res.status(403).send('Запрещено в режиме зрителя');
  }
  const { oldPassword, newPassword } = req.body;
  
  if (!newPassword || newPassword.trim().length < 6) {
    req.session.errorPassword = 'Новый пароль должен содержать не менее 6 символов';
    return req.session.save(() => {
      res.redirect('/account,profile/#tab-password');
    });
  }

  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
    const match = await bcrypt.compare(oldPassword, rows[0].password);
    if (!match) {
      connection.release();
      req.session.errorPassword = 'Неверный старый пароль';
      return req.session.save(() => {
        res.redirect('/account,profile/#tab-password');
      });
    }
    const hashedNew = await bcrypt.hash(newPassword, 10);
    await connection.query('UPDATE users SET password = ? WHERE id = ?', [hashedNew, req.session.user.id]);
    connection.release();
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('user', req.session.user.username, 'Самостоятельно изменил пароль', userIp);
    
    req.session.successPassword = 'Пароль успешно изменен!';
    req.session.save(() => {
      res.redirect('/account,profile/#tab-password');
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error saving password');
  }
});

router.post('/settings/sessions/terminate-others', requireAuth, async (req, res) => {
  if (req.ip_ban && req.ip_ban.ban_type === 'account') {
    return res.status(403).send('Запрещено в режиме зрителя');
  }

  const currentSessionId = req.sessionID;
  const userId = req.session.user.id;
  const username = req.session.user.username;
  const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;

  try {
    const [rows] = await pool.query('SELECT session_id, data FROM sessions');
    const sessionsToDelete = [];

    for (const row of rows) {
      if (row.session_id === currentSessionId) continue;
      try {
        const sessionData = JSON.parse(row.data);
        if (sessionData && sessionData.user && sessionData.user.id === userId) {
          sessionsToDelete.push(row.session_id);
        }
      } catch (e) {
        // Ignore invalid session JSONs
      }
    }

    if (sessionsToDelete.length > 0) {
      await pool.query('DELETE FROM sessions WHERE session_id IN (?)', [sessionsToDelete]);
      req.session.successSession = `Успешно завершено сеансов на других устройствах: ${sessionsToDelete.length}.`;
      logAction('user', username, `Завершил все другие сеансы (кол-во: ${sessionsToDelete.length})`, userIp);
    } else {
      req.session.successSession = 'У вас нет других активных сеансов на других устройствах.';
    }
  } catch (err) {
    console.error('[Sessions Terminate] Error:', err);
    req.session.errorSession = 'Произошла ошибка при завершении других сеансов.';
  }

  req.session.save(() => {
    res.redirect('/account,profile/#tab-security');
  });
});

router.post('/settings/delete-account', requireAuth, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    
    // Check if user has a banned channel
    const [bannedChannels] = await connection.query("SELECT id FROM channels WHERE user_id = ? AND status = 'banned'", [req.session.user.id]);
    if (bannedChannels.length > 0) {
      connection.release();
      return res.send('<script>alert("Вы не можете удалить аккаунт, так как ваш телеканал заблокирован."); setTimeout(function(){ window.location.href="/account,profile"; }, 1500);</script>');
    }

    await connection.query('UPDATE users SET deleted_at = NOW() WHERE id = ?', [req.session.user.id]);
    await connection.query("UPDATE channels SET status = 'deleted', deleted_at = NOW(), rtmp_disabled = 1 WHERE user_id = ? AND status != 'banned'", [req.session.user.id]);
    
    const [channels] = await connection.query('SELECT shortname FROM channels WHERE user_id = ?', [req.session.user.id]);
    const { kickStream } = require('../../../utils/mediaServer');
    for (const ch of channels) {
      if (ch.shortname) {
        try {
          await kickStream(ch.shortname);
        } catch (e) {
          console.error(`Failed to drop stream for ${ch.shortname}:`, e.message);
        }
      }
    }

    await connection.query('INSERT INTO user_deletion_logs (user_id, username) VALUES (?, ?)', [req.session.user.id, req.session.user.username]);
    connection.release();
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('user', req.session.user.username, 'Самостоятельно удалил свой аккаунт', userIp);
    req.session.destroy((err) => {
      res.redirect('/login');
    });
  } catch (e) {
    console.error('Error deleting account:', e);
    res.status(500).send('Server error');
  }
});

module.exports = router;
