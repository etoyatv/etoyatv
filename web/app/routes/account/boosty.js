const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const { requireAuth } = require('../../../middlewares/auth');

router.post('/settings/boosty/request', requireAuth, async (req, res) => {
  const { boosty_email } = req.body;
  if (!boosty_email || !boosty_email.includes('@')) {
    req.session.errorBoosty = 'Некорректный формат E-Mail адреса';
    return req.session.save(() => res.redirect('/account,profile/#tab-boosty'));
  }

  try {
    const connection = await pool.getConnection();
    const [existingLink] = await connection.query('SELECT id FROM users WHERE boosty_email = ? AND id != ?', [boosty_email.trim(), req.session.user.id]);
    connection.release();

    if (existingLink.length > 0) {
      req.session.errorBoosty = 'Этот E-Mail адрес Boosty уже привязан к другому аккаунту.';
      return req.session.save(() => res.redirect('/account,profile/#tab-boosty'));
    }

    const { checkSubscriberByEmail, sendVerificationCode } = require('../../../utils/boosty');
    console.log(`[BOOSTY] User ${req.session.user.username} requested link for email ${boosty_email}`);
    
    const subscriber = await checkSubscriberByEmail(boosty_email);
    if (!subscriber) {
      req.session.errorBoosty = 'Этот E-Mail не найден в списке подписчиков Boosty.';
      return req.session.save(() => res.redirect('/account,profile/#tab-boosty'));
    }

    const isActive = subscriber.subscribed === true && 
                     subscriber.status === 'active' && 
                     subscriber.level && 
                     subscriber.level.price > 0;

    if (!isActive) {
      req.session.errorBoosty = 'Подписка на Boosty не активна или является бесплатной.';
      return req.session.save(() => res.redirect('/account,profile/#tab-boosty'));
    }

    // Generate random 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Send message to Boosty user
    console.log(`[BOOSTY] Sending verification code ${code} to Boosty User ID ${subscriber.id}`);
    await sendVerificationCode(subscriber.id, code);

    // Save pending validation to session
    req.session.pending_boosty_link = {
      email: boosty_email.trim(),
      code: code,
      boostyUserId: subscriber.id,
      nextPayTime: subscriber.offTime || subscriber.nextPayTime,
      expires: Date.now() + 10 * 60 * 1000 // 10 minutes expiry
    };

    req.session.successBoosty = 'Код подтверждения отправлен в ваши личные сообщения на Boosty!';
    req.session.save(() => res.redirect('/account,profile/#tab-boosty'));
  } catch (err) {
    console.error('[BOOSTY] Request link error:', err);
    req.session.errorBoosty = `Ошибка отправки кода: ${err.message}`;
    req.session.save(() => res.redirect('/account,profile/#tab-boosty'));
  }
});

router.post('/settings/boosty/verify', requireAuth, async (req, res) => {
  const { code } = req.body;
  const pending = req.session.pending_boosty_link;

  if (!pending || Date.now() > pending.expires) {
    delete req.session.pending_boosty_link;
    req.session.errorBoosty = 'Срок действия кода истек или запрос отсутствует. Попробуйте снова.';
    return req.session.save(() => res.redirect('/account,profile/#tab-boosty'));
  }

  if (!code || code.trim() !== pending.code) {
    req.session.errorBoosty = 'Неверный код подтверждения';
    return req.session.save(() => res.redirect('/account,profile/#tab-boosty'));
  }

  try {
    const nextPayTimeDate = new Date(pending.nextPayTime * 1000);
    const connection = await pool.getConnection();

    // Verify uniqueness
    const [existingLink] = await connection.query('SELECT id FROM users WHERE boosty_email = ? AND id != ?', [pending.email, req.session.user.id]);
    if (existingLink.length > 0) {
      connection.release();
      delete req.session.pending_boosty_link;
      req.session.errorBoosty = 'Этот E-Mail адрес Boosty уже привязан к другому аккаунту.';
      return req.session.save(() => res.redirect('/account,profile/#tab-boosty'));
    }

    // Save email
    await connection.query('UPDATE users SET boosty_email = ? WHERE id = ?', [pending.email, req.session.user.id]);
    
    // Find target channel (boosty_channel_id or personal)
    const [chRows] = await connection.query('SELECT id, is_personal FROM channels WHERE user_id = ? AND status IN (\'active\', \'banned\')', [req.session.user.id]);
    let targetChannelId = null;
    if (chRows.length > 0) {
      const personalCh = chRows.find(c => c.is_personal === 1 || c.is_personal === true);
      if (personalCh) {
        targetChannelId = personalCh.id;
      } else {
        targetChannelId = chRows[0].id;
      }
    }

    if (targetChannelId) {
      await connection.query('UPDATE channels SET is_premium = 1, is_verified = 1, premium_until = ? WHERE id = ?', [nextPayTimeDate, targetChannelId]);
      await connection.query('UPDATE channels SET is_premium = 0, is_verified = 0, premium_until = NULL WHERE user_id = ? AND id != ?', [req.session.user.id, targetChannelId]);
    }

    connection.release();

    delete req.session.pending_boosty_link;
    req.session.successBoosty = `Аккаунт Boosty успешно привязан! Премиум активен до ${nextPayTimeDate.toLocaleString('ru-RU')}`;
    req.session.save(() => res.redirect('/account,profile/#tab-boosty'));
  } catch (err) {
    console.error('[BOOSTY] Verify link error:', err);
    req.session.errorBoosty = `Ошибка при активации: ${err.message}`;
    req.session.save(() => res.redirect('/account,profile/#tab-boosty'));
  }
});

router.post('/settings/boosty/cancel', requireAuth, (req, res) => {
  delete req.session.pending_boosty_link;
  req.session.save(() => res.redirect('/account,profile/#tab-boosty'));
});

router.post('/settings/boosty/unlink', requireAuth, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    
    // Clear email and remove premium from all channels
    await connection.query('UPDATE users SET boosty_email = NULL WHERE id = ?', [req.session.user.id]);
    await connection.query('UPDATE channels SET is_premium = 0, is_verified = 0, premium_until = NULL WHERE user_id = ?', [req.session.user.id]);
    
    connection.release();
    
    req.session.successBoosty = 'Аккаунт Boosty успешно отвязан. Премиум-статус снят.';
    req.session.save(() => res.redirect('/account,profile/#tab-boosty'));
  } catch (err) {
    console.error('[BOOSTY] Unlink error:', err);
    req.session.errorBoosty = `Ошибка при отвязке: ${err.message}`;
    req.session.save(() => res.redirect('/account,profile/#tab-boosty'));
  }
});

router.post('/settings/boosty/sync', requireAuth, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [userRows] = await connection.query('SELECT boosty_email, boosty_channel_id FROM users WHERE id = ?', [req.session.user.id]);
    
    if (userRows.length === 0 || !userRows[0].boosty_email) {
      connection.release();
      req.session.errorBoosty = 'У вас нет привязанного аккаунта Boosty';
      return req.session.save(() => res.redirect('/account,profile/#tab-boosty'));
    }
    
    const boostyEmail = userRows[0].boosty_email;
    const boostyChannelId = userRows[0].boosty_channel_id;
    const { checkSubscriberByEmail } = require('../../../utils/boosty');
    const subscriber = await checkSubscriberByEmail(boostyEmail);
    
    if (subscriber) {
      const isActive = subscriber.subscribed === true && 
                       subscriber.status === 'active' && 
                       subscriber.level && 
                       subscriber.level.price > 0;
      
      if (isActive) {
        const nextPayTimeDate = new Date((subscriber.offTime || subscriber.nextPayTime || 0) * 1000);
        
        const [chRows] = await connection.query('SELECT id, is_personal FROM channels WHERE user_id = ? AND status IN (\'active\', \'banned\')', [req.session.user.id]);
        
        let targetChannelId = null;
        if (boostyChannelId) {
          const hasSelected = chRows.find(c => c.id === boostyChannelId);
          if (hasSelected) {
            targetChannelId = boostyChannelId;
          }
        }
        
        if (!targetChannelId && chRows.length > 0) {
          const personalCh = chRows.find(c => c.is_personal === 1 || c.is_personal === true);
          if (personalCh) {
            targetChannelId = personalCh.id;
          } else {
            targetChannelId = chRows[0].id;
          }
        }
        
        if (targetChannelId) {
          await connection.query('UPDATE channels SET is_premium = 1, is_verified = 1, premium_until = ? WHERE id = ?', [nextPayTimeDate, targetChannelId]);
          await connection.query('UPDATE channels SET is_premium = 0, is_verified = 0, premium_until = NULL WHERE user_id = ? AND id != ?', [req.session.user.id, targetChannelId]);
        }
        
        req.session.successBoosty = `Статус успешно обновлен! Премиум продлен до ${nextPayTimeDate.toLocaleString('ru-RU')}`;
      } else {
        // Demote
        await connection.query('UPDATE channels SET is_premium = 0, is_verified = 0, premium_until = NULL WHERE user_id = ?', [req.session.user.id]);
        req.session.errorBoosty = 'Ваша подписка на Boosty неактивна. Премиум-статус снят.';
      }
    } else {
      // Not found
      await connection.query('UPDATE channels SET is_premium = 0, is_verified = 0, premium_until = NULL WHERE user_id = ?', [req.session.user.id]);
      req.session.errorBoosty = 'Подписчик с такой почтой больше не найден на Boosty. Премиум-статус снят.';
    }
    
    connection.release();
    req.session.save(() => res.redirect('/account,profile/#tab-boosty'));
  } catch (err) {
    console.error('[BOOSTY] Manual sync error:', err);
    req.session.errorBoosty = `Ошибка при синхронизации: ${err.message}`;
    req.session.save(() => res.redirect('/account,profile/#tab-boosty'));
  }
});

module.exports = router;
