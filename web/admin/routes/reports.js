const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const sendSystemMessage = require('../utils/systemMessage');
const { logAction } = require('../utils/logger');

async function renderReportsPage(req, res, targetType, viewPath, title) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const connection = await pool.getConnection();

    const [[{ total_pending }]] = await connection.query(`
      SELECT COUNT(*) as total_pending 
      FROM complaints 
      WHERE status = 'pending' AND target_type IN (?)
    `, [Array.isArray(targetType) ? targetType : [targetType]]);

    const totalPages = Math.ceil(total_pending / limit) || 1;

    const [complaints] = await connection.query(`
      SELECT c.*, u.username as reporter_name, u.avatar as reporter_avatar 
      FROM complaints c 
      LEFT JOIN users u ON c.reporter_id = u.id
      WHERE c.status = 'pending' AND c.target_type IN (?)
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `, [Array.isArray(targetType) ? targetType : [targetType], limit, offset]);
    // Fetch target user info and extra data to support "Ban Offender" and better UI
    for (let c of complaints) {
      c.offender_id = null;
      c.offender_name = null;
      c.target_avatar = '/images/default_user_avatar.png'; // fallback
      c.target_link = '#';
      const targetContentSnapshot = c.target_content;
      c.target_content = targetContentSnapshot || null;

      if (c.target_type === 'user') {
        c.offender_id = c.target_id;
        const [u] = await connection.query('SELECT username, avatar FROM users WHERE id = ?', [c.target_id]);
        if (u.length) { 
          c.offender_name = u[0].username; 
          c.target_avatar = u[0].avatar || c.target_avatar;
          c.target_link = `${req.app.locals.APP_URL}/ru/account,userinfo/?username=${encodeURIComponent(u[0].username)}`; 
        }
      } else if (c.target_type === 'pm') {
        const [msgRows] = await connection.query(`
          SELECT u.username, u.avatar, u.id as user_id, m.content
          FROM messages m
          JOIN users u ON m.sender_id = u.id
          WHERE m.id = ?
        `, [c.target_id]);
        if (msgRows.length > 0) {
          c.pm_author_name = msgRows[0].username;
          c.pm_author_id = msgRows[0].user_id;
          c.offender_id = msgRows[0].user_id;
          c.offender_name = msgRows[0].username;
          c.target_avatar = msgRows[0].avatar || c.target_avatar;
          c.target_content = targetContentSnapshot || msgRows[0].content;
          c.target_link = `${req.app.locals.APP_URL}/ru/account,userinfo/?username=${encodeURIComponent(msgRows[0].username)}`; 
        }
      } else if (c.target_type === 'channel') {
        const [r] = await connection.query('SELECT u.id, u.username, x.logo_url, x.shortname FROM channels x JOIN users u ON x.user_id = u.id WHERE x.id = ?', [c.target_id]);
        if (r.length) { 
          c.offender_id = r[0].id; 
          c.offender_name = r[0].username; 
          c.target_avatar = r[0].logo_url || c.target_avatar;
          c.target_link = `${req.app.locals.APP_URL}/${r[0].shortname}`; 
        }
      } else if (c.target_type === 'record') {
        const [r] = await connection.query('SELECT u.id, u.username, x.thumbnail_url, x.id as record_id FROM records x JOIN channels ch ON x.channel_id = ch.id JOIN users u ON ch.user_id = u.id WHERE x.id = ?', [c.target_id]);
        if (r.length) { 
          c.offender_id = r[0].id; 
          c.offender_name = r[0].username; 
          c.target_avatar = r[0].thumbnail_url || '/images/default_record_thumbnail.png';
          c.target_link = `${req.app.locals.APP_URL}/ru/tv,viewrecord,${r[0].record_id}`; 
        }
      } else if (c.target_type === 'channel_comment') {
        const [r] = await connection.query('SELECT u.id, u.username, u.avatar, x.text as content FROM channel_comments x JOIN users u ON x.user_id = u.id WHERE x.id = ?', [c.target_id]);
        if (r.length) { 
          c.offender_id = r[0].id; 
          c.offender_name = r[0].username; 
          c.target_avatar = r[0].avatar || c.target_avatar;
          c.target_content = targetContentSnapshot || r[0].content;
        }
      } else if (c.target_type === 'record_comment') {
        const [r] = await connection.query('SELECT u.id, u.username, u.avatar, x.text as content FROM record_comments x JOIN users u ON x.user_id = u.id WHERE x.id = ?', [c.target_id]);
        if (r.length) { 
          c.offender_id = r[0].id; 
          c.offender_name = r[0].username; 
          c.target_avatar = r[0].avatar || c.target_avatar;
          c.target_content = targetContentSnapshot || r[0].content;
        }
      }
    }
    
    connection.release();
    
    res.render('reports', {
      user: req.session.user,
      currentPath: viewPath,
      complaints,
      title,
      total_pending,
      page,
      limit,
      totalPages
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
}

router.get('/', (req, res) => res.redirect('/reports/users'));

router.get('/users', (req, res) => renderReportsPage(req, res, 'user', '/reports/users', 'Пользователи'));
router.get('/channels', (req, res) => renderReportsPage(req, res, ['channel', 'channel_comment'], '/reports/channels', 'Каналы и комментарии'));
router.get('/records', (req, res) => renderReportsPage(req, res, ['record', 'record_comment'], '/reports/records', 'Записи и комментарии'));
router.get('/pms', (req, res) => renderReportsPage(req, res, 'pm', '/reports/pms', 'Личные сообщения'));

router.get('/archive', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const connection = await pool.getConnection();

    const [[{ total_archived }]] = await connection.query(`
      SELECT COUNT(*) as total_archived 
      FROM complaints 
      WHERE status != 'pending'
    `);

    const totalPages = Math.ceil(total_archived / limit) || 1;

    const [complaints] = await connection.query(`
      SELECT c.*, u.username as reporter_name, u.avatar as reporter_avatar 
      FROM complaints c 
      LEFT JOIN users u ON c.reporter_id = u.id
      WHERE c.status != 'pending'
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);
    
    // Fetch target user info and extra data to support better UI in archive
    for (let c of complaints) {
      c.offender_id = null;
      c.offender_name = null;
      c.target_avatar = '/images/default_user_avatar.png'; // fallback
      c.target_link = '#';
      const targetContentSnapshot = c.target_content;
      c.target_content = targetContentSnapshot || null;

      if (c.target_type === 'user') {
        c.offender_id = c.target_id;
        const [u] = await connection.query('SELECT username, avatar FROM users WHERE id = ?', [c.target_id]);
        if (u.length) { 
          c.offender_name = u[0].username; 
          c.target_avatar = u[0].avatar || c.target_avatar;
          c.target_link = `${req.app.locals.APP_URL}/ru/account,userinfo/?username=${encodeURIComponent(u[0].username)}`; 
        }
      } else if (c.target_type === 'pm') {
        const [msgRows] = await connection.query(`
          SELECT u.username, u.avatar, u.id as user_id, m.content
          FROM messages m
          JOIN users u ON m.sender_id = u.id
          WHERE m.id = ?
        `, [c.target_id]);
        if (msgRows.length > 0) {
          c.pm_author_name = msgRows[0].username;
          c.pm_author_id = msgRows[0].user_id;
          c.offender_id = msgRows[0].user_id;
          c.offender_name = msgRows[0].username;
          c.target_avatar = msgRows[0].avatar || c.target_avatar;
          c.target_content = targetContentSnapshot || msgRows[0].content;
          c.target_link = `${req.app.locals.APP_URL}/ru/account,userinfo/?username=${encodeURIComponent(msgRows[0].username)}`; 
        }
      } else if (c.target_type === 'channel') {
        const [r] = await connection.query('SELECT u.id, u.username, x.logo_url, x.shortname FROM channels x JOIN users u ON x.user_id = u.id WHERE x.id = ?', [c.target_id]);
        if (r.length) { 
          c.offender_id = r[0].id; 
          c.offender_name = r[0].username; 
          c.target_avatar = r[0].logo_url || c.target_avatar;
          c.target_link = `${req.app.locals.APP_URL}/${r[0].shortname}`; 
        }
      } else if (c.target_type === 'record') {
        const [r] = await connection.query('SELECT u.id, u.username, x.thumbnail_url, x.id as record_id FROM records x JOIN channels ch ON x.channel_id = ch.id JOIN users u ON ch.user_id = u.id WHERE x.id = ?', [c.target_id]);
        if (r.length) { 
          c.offender_id = r[0].id; 
          c.offender_name = r[0].username; 
          c.target_avatar = r[0].thumbnail_url || '/images/default_record_thumbnail.png';
          c.target_link = `${req.app.locals.APP_URL}/ru/tv,viewrecord,${r[0].record_id}`; 
        }
      } else if (c.target_type === 'channel_comment') {
        const [r] = await connection.query('SELECT u.id, u.username, u.avatar, x.text as content FROM channel_comments x JOIN users u ON x.user_id = u.id WHERE x.id = ?', [c.target_id]);
        if (r.length) { 
          c.offender_id = r[0].id; 
          c.offender_name = r[0].username; 
          c.target_avatar = r[0].avatar || c.target_avatar;
          c.target_content = targetContentSnapshot || r[0].content;
        }
      } else if (c.target_type === 'record_comment') {
        const [r] = await connection.query('SELECT u.id, u.username, u.avatar, x.text as content FROM record_comments x JOIN users u ON x.user_id = u.id WHERE x.id = ?', [c.target_id]);
        if (r.length) { 
          c.offender_id = r[0].id; 
          c.offender_name = r[0].username; 
          c.target_avatar = r[0].avatar || c.target_avatar;
          c.target_content = targetContentSnapshot || r[0].content;
        }
      }
    }
    connection.release();
    
    res.render('reports-archive', {
      user: req.session.user,
      currentPath: '/reports/archive',
      complaints,
      total_archived,
      page,
      limit,
      totalPages
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

router.post('/:id/resolve', async (req, res) => {
  try {
    const { actions, verdict, ban_duration, ban_reason } = req.body;
    // actions is an array of strings: ['delete_content', 'ban_offender', 'ban_reporter']
    const complaintId = req.params.id;

    const connection = await pool.getConnection();
    const [complaintRows] = await connection.query('SELECT * FROM complaints WHERE id = ?', [complaintId]);
    
    if (complaintRows.length === 0) {
      connection.release();
      return res.json({ success: false, error: 'Жалоба не найдена' });
    }

    const complaint = complaintRows[0];
    const targetType = complaint.target_type;
    const targetId = complaint.target_id;
    const reporterId = complaint.reporter_id;

    let appliedVerdict = verdict || 'Приняты меры';
    let status = 'resolved';

    if (actions && actions.length === 0 && (verdict || '').startsWith('Отклонена')) {
       status = 'rejected';
    }

    let appliedActionsText = [];

    // Fetch offender_id to send system notifications
    let offenderId = null;
    if (targetType === 'user') {
      offenderId = targetId;
    } else if (targetType === 'pm') {
      const [r] = await connection.query('SELECT sender_id FROM messages WHERE id = ?', [targetId]);
      if (r.length) offenderId = r[0].sender_id;
    } else if (targetType === 'channel_comment') {
      const [r] = await connection.query('SELECT user_id FROM channel_comments WHERE id = ?', [targetId]);
      if (r.length) offenderId = r[0].user_id;
    } else if (targetType === 'record_comment') {
      const [r] = await connection.query('SELECT user_id FROM record_comments WHERE id = ?', [targetId]);
      if (r.length) offenderId = r[0].user_id;
    } else if (targetType === 'record') {
      const [r] = await connection.query('SELECT c.user_id FROM records r JOIN channels c ON r.channel_id = c.id WHERE r.id = ?', [targetId]);
      if (r.length) offenderId = r[0].user_id;
    } else if (targetType === 'channel') {
      const [r] = await connection.query('SELECT user_id FROM channels WHERE id = ?', [targetId]);
      if (r.length) offenderId = r[0].user_id;
    }

    // Process actions
    if (actions && actions.includes('delete_avatar') && targetType === 'user') {
      await connection.query('UPDATE users SET avatar = "/images/default_user_avatar.png" WHERE id = ?', [targetId]);
      appliedActionsText.push('Удалена аватарка');
      if (offenderId) await sendSystemMessage(offenderId, 'Ваша аватарка была удалена администрацией платформы из-за нарушения правил.');
    }

    if (actions && actions.includes('delete_content')) {
      if (targetType === 'pm') {
        await connection.query('UPDATE messages SET content = "Сообщение удалено из-за нарушении правил" WHERE id = ?', [targetId]);
        appliedActionsText.push('Сообщение удалено');
        if (offenderId) await sendSystemMessage(offenderId, 'Ваше личное сообщение было удалено администрацией платформы из-за нарушения правил.');
      } else if (targetType === 'channel_comment') {
        await connection.query('UPDATE channel_comments SET is_hidden = 1 WHERE id = ?', [targetId]);
        appliedActionsText.push('Комментарий скрыт');
        if (offenderId) await sendSystemMessage(offenderId, 'Ваш комментарий на канале был скрыт администрацией платформы из-за нарушения правил.');
      } else if (targetType === 'record_comment') {
        await connection.query('UPDATE record_comments SET is_hidden = 1 WHERE id = ?', [targetId]);
        appliedActionsText.push('Комментарий скрыт');
        if (offenderId) await sendSystemMessage(offenderId, 'Ваш комментарий к записи был скрыт администрацией платформы из-за нарушения правил.');
      } else if (targetType === 'record') {
        await connection.query('UPDATE records SET status = "deleted" WHERE id = ?', [targetId]);
        appliedActionsText.push('Запись мягко удалена');
        if (offenderId) await sendSystemMessage(offenderId, 'Ваша запись была удалена администрацией платформы из-за нарушения правил.');
      }
    }

    if (actions && actions.includes('ban_content')) {
      if (targetType === 'channel') {
        await connection.query('UPDATE channels SET status = "banned", rtmp_disabled = 1 WHERE id = ?', [targetId]);
        appliedActionsText.push('Телеканал заблокирован');
        if (offenderId) await sendSystemMessage(offenderId, 'Ваш телеканал был заблокирован администрацией платформы из-за нарушения правил.');
      }
    }

    if (actions && actions.includes('ban_reporter')) {
       // Issue report ban
       let banDate = null;
       if (ban_duration === 'temporary' && req.body.banned_until) {
         banDate = req.body.banned_until;
       } else if (ban_duration === 'permanent') {
         banDate = '2099-12-31';
       }
       
       if (banDate) {
         await connection.query('UPDATE users SET report_banned_until = ?, report_ban_reason = ? WHERE id = ?', 
           [banDate, ban_reason || '', reporterId]);
       }
    }

    // Ban offender is handled separately via the existing user ban logic (/users/:id/ban endpoint)
    // We don't process it here, the frontend will just do the API call.

    if (actions && actions.includes('ban_offender')) {
       appliedActionsText.push('Нарушитель заблокирован');
    }

    if (appliedActionsText.length > 0) {
      appliedVerdict += ` (${appliedActionsText.join(', ')})`;
    }

    await connection.query('UPDATE complaints SET status = ?, verdict = ? WHERE id = ?', [status, appliedVerdict, complaintId]);
    
    connection.release();
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, `Рассмотрел жалобу (ID: ${complaintId}, Вердикт: ${appliedVerdict})`, userIp);

    res.json({ success: true });
  } catch (err) {
    console.error('Error resolving complaint:', err);
    res.json({ success: false, error: 'Server Error' });
  }
});

module.exports = router;
