const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const { requireAuth } = require('../../../middlewares/auth');

router.post('/settings/invites/generate', requireAuth, async (req, res) => {
  if (!res.locals.invite_system_enabled) {
    return res.status(404).render('404', { pageTitle: 'Страница не найдена | ЭтоЯTV' });
  }
  try {
    const connection = await pool.getConnection();
    
    // Check if user is admin (using staff table or role if applicable. Main app user object might have `staff_role` from session)
    const [staffRows] = await connection.query('SELECT role FROM staff WHERE user_id = ?', [req.session.user.id]);
    const isAdmin = staffRows.length > 0;
    
    if (!isAdmin) {
      // Ordinary user: limit 2 per day
      const [todayCount] = await connection.query(`
        SELECT COUNT(*) as count FROM invite_codes 
        WHERE creator_id = ? AND DATE(created_at) = CURDATE()
      `, [req.session.user.id]);
      
      if (todayCount[0].count >= 2) {
        connection.release();
        req.session.errorInvite = 'Вы исчерпали лимит генерации инвайтов на сегодня (2 шт).';
        return req.session.save(() => {
          res.redirect('/account,profile/#tab-invites');
        });
      }
    }

    const crypto = require('crypto');
    const code = crypto.randomBytes(6).toString('hex').toUpperCase();
    await connection.query('INSERT INTO invite_codes (code, creator_id) VALUES (?, ?)', [code, req.session.user.id]);
    connection.release();
    
    req.session.successInvite = 'Инвайт-код успешно сгенерирован!';
    req.session.save(() => {
      res.redirect('/account,profile/#tab-invites');
    });
  } catch(e) {
    console.error(e);
    req.session.errorInvite = 'Ошибка генерации инвайт-кода.';
    req.session.save(() => {
      res.redirect('/account,profile/#tab-invites');
    });
  }
});

router.post('/ru/account,profile/invites/delete/:id', requireAuth, async (req, res) => {
  if (!res.locals.invite_system_enabled) {
    return res.status(404).render('404', { pageTitle: 'Страница не найдена | ЭтоЯTV' });
  }
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();
    // Only allow deleting unused invites created by the user
    await connection.query('DELETE FROM invite_codes WHERE id = ? AND creator_id = ? AND used_at IS NULL', [id, req.session.user.id]);
    connection.release();
    req.session.successInvite = 'Инвайт-код успешно удален!';
    req.session.save(() => {
      res.redirect('/account,profile/#tab-invites');
    });
  } catch(e) {
    console.error(e);
    req.session.errorInvite = 'Ошибка удаления инвайт-кода.';
    req.session.save(() => {
      res.redirect('/account,profile/#tab-invites');
    });
  }
});

module.exports = router;
