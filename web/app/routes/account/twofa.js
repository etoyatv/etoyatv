const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const { requireAuth } = require('../../../middlewares/auth');
const { logAction } = require('../../../utils/logger');

router.get('/account/2fa/setup', requireAuth, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT is_totp_enabled FROM users WHERE id = ?', [req.session.user.id]);
    connection.release();
    if (rows[0].is_totp_enabled) return res.redirect('/account,profile/#tab-security');

    const authenticator = require('otplib').authenticator;
    const qrcode = require('qrcode');

    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(req.session.user.email || req.session.user.username, 'ЭтоЯTV', secret);
    const qrImage = await qrcode.toDataURL(otpauth);

    req.session.totp_setup_secret = secret;

    res.render('account_2fa_setup', {
      pageTitle: 'Настройка 2FA | ЭтоЯTV',
      secret,
      qrImage,
      error: null
    });
  } catch (e) {
    console.error('Error in /account/2fa/setup:', e);
    res.status(500).send('Error');
  }
});

router.post('/account/2fa/verify', requireAuth, async (req, res) => {
  const { code } = req.body;
  const secret = req.session.totp_setup_secret;
  if (!secret) return res.redirect('/account/2fa/setup');

  const authenticator = require('otplib').authenticator;
  const isValid = authenticator.check(code, secret);

  if (isValid) {
    try {
      const crypto = require('crypto');
      const backupCodes = Array.from({length: 10}, () => crypto.randomBytes(4).toString('hex').toUpperCase());
      
      const connection = await pool.getConnection();
      await connection.query('UPDATE users SET totp_secret = ?, is_totp_enabled = 1, totp_backup_codes = ? WHERE id = ?', 
        [secret, JSON.stringify(backupCodes), req.session.user.id]);
      connection.release();
      
      delete req.session.totp_setup_secret;
      const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
      logAction('user', req.session.user.username, 'Включил защиту по 2FA', userIp);
      
      res.render('account_2fa_success', {
        pageTitle: '2FA включена | ЭтоЯTV',
        backupCodes
      });
    } catch (e) {
      res.status(500).send('Error saving 2FA');
    }
  } else {
    try {
      const qrcode = require('qrcode');
      const otpauth = authenticator.keyuri(req.session.user.email || req.session.user.username, 'ЭтоЯTV', secret);
      const qrImage = await qrcode.toDataURL(otpauth);
      res.render('account_2fa_setup', {
        pageTitle: 'Настройка 2FA | ЭтоЯTV',
        secret,
        qrImage,
        error: 'Неверный код, попробуйте еще раз.'
      });
    } catch(e) {
      res.status(500).send('Error');
    }
  }
});

router.post('/account/2fa/disable', requireAuth, async (req, res) => {
  const code = (req.body.code || '').trim();
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT totp_secret, totp_backup_codes FROM users WHERE id = ?', [req.session.user.id]);
    
    if (rows.length === 0 || !rows[0].totp_secret) {
      connection.release();
      return res.redirect('/account,profile/#tab-security');
    }

    const authenticator = require('otplib').authenticator;
    let isValid = authenticator.check(code, rows[0].totp_secret);
    
    if (!isValid && rows[0].totp_backup_codes) {
      try {
        const backupCodes = JSON.parse(rows[0].totp_backup_codes);
        if (backupCodes.includes(code.toUpperCase())) {
          isValid = true;
        }
      } catch (e) {}
    }

    if (!isValid) {
      connection.release();
      req.session.error2FA = 'Неверный код 2FA для отключения';
      return req.session.save(() => {
        res.redirect('/account,profile/#tab-security');
      });
    }

    await connection.query('UPDATE users SET totp_secret = NULL, is_totp_enabled = 0, totp_backup_codes = NULL WHERE id = ?', [req.session.user.id]);
    connection.release();
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('user', req.session.user.username, 'Отключил защиту по 2FA', userIp);
    res.redirect('/account,profile/#tab-security');
  } catch (e) {
    res.status(500).send('Error');
  }
});

module.exports = router;
