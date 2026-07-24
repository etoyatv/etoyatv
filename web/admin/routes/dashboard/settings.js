const express = require('express');
const { logAction } = require('../../utils/logger');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

module.exports = function createSettingsRouter(adUpload) {
  const router = express.Router();

  // Settings page
  router.get('/settings', async (req, res) => {
    let envContent = '';
    if (req.user && req.user.is_superadmin) {
      try {
        envContent = fs.readFileSync('/app/.env', 'utf8');
      } catch (e) {
        try {
          envContent = fs.readFileSync(path.join(__dirname, '../../.env'), 'utf8');
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
      const { pool } = require('../../config/db');
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
      const { pool } = require('../../config/db');
      const connection = await pool.getConnection();

      // Identify which form was submitted
      const formType = req.body.form_type;
      const updates = [];

      if (formType === 'main_settings') {
        const switchSettings = [
          'site_disabled', 'rtmp_disabled', 'banner_enabled',
          'registration_disabled', 'invite_system_enabled',
          'allow_features_for_everyone', 'allow_multistream_for_everyone'
        ];
        const textSettings = [
          'site_disabled_message', 'banner_text_short', 'banner_text_full', 'forbidden_words', 'news_source'
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
      const { pool } = require('../../config/db');
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

  router.get('/settings', async (req, res) => {
    try {
      const { pool } = require('../../config/db');
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
      const { pool } = require('../../config/db');
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
      const { pool } = require('../../config/db');
      const isEnabled = req.body.blur_18_plus === '1' ? 1 : 0;
      const maskMode = req.body.mask_mode || 'disabled';
      const hideAdminTools = req.body.hide_admin_tools === '1' ? 1 : 0;

      // Save blur, mask modes & hide admin tools setting
      await pool.query('UPDATE staff SET blur_18_plus = ?, mask_mode = ?, hide_admin_tools = ? WHERE user_id = ?', [isEnabled, maskMode, hideAdminTools, req.session.user.id]);

      if (req.session.user) {
        req.session.user.mask_mode = maskMode;
        req.session.user.hide_admin_tools = hideAdminTools;
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
      const { pool } = require('../../config/db');
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
      const { pool } = require('../../config/db');
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
      const { pool } = require('../../config/db');
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

  return router;
};
