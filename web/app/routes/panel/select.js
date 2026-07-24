// Panel channel selection
const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const { requireAuth } = require('../../../middlewares/auth');

router.get('/ru/panel,select', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  try {
    const connection = await pool.getConnection();
    const isStaff = req.session.user.staff_role && req.session.user.mask_mode !== 'user_mask';

    // If channel_id query param is provided and user is staff, set it in session and redirect to dashboard
    if (req.query.channel_id && isStaff) {
      const [ch] = await connection.query("SELECT id FROM channels WHERE id = ? AND status IN ('active', 'banned')", [req.query.channel_id]);
      if (ch.length > 0) {
        req.session.panel_channel_id = ch[0].id;
        connection.release();
        return res.redirect('/panel,dashboard');
      }
    }

    const [ownedChannels] = await connection.query("SELECT c.*, 'owner' as panel_role FROM channels c WHERE c.user_id = ? AND c.status IN ('active', 'banned')", [req.session.user.id]);
    const [teamChannels] = await connection.query("SELECT c.*, t.is_editor, t.is_reporter, t.is_coowner FROM channels c JOIN channel_team t ON c.id = t.channel_id WHERE t.user_id = ? AND c.status IN ('active', 'banned') AND (t.is_editor = 1 OR t.is_reporter = 1 OR t.is_coowner = 1)", [req.session.user.id]);

    let availableChannels = [...ownedChannels, ...teamChannels.map(c => {
      let role = 'reporter';
      if (c.is_coowner) role = 'coowner';
      else if (c.is_editor) role = 'editor';
      return { ...c, panel_role: role };
    })];

    // If user is staff, and they have panel_channel_id in session that is not in availableChannels, load it too
    if (isStaff && req.session.panel_channel_id) {
      const isAlreadyAvailable = availableChannels.some(c => c.id == req.session.panel_channel_id);
      if (!isAlreadyAvailable) {
        const [staffSelectedChannel] = await connection.query("SELECT c.*, 'staff' as panel_role FROM channels c WHERE c.id = ? AND c.status IN ('active', 'banned')", [req.session.panel_channel_id]);
        if (staffSelectedChannel.length > 0) {
          availableChannels.push(staffSelectedChannel[0]);
        }
      }
    }

    const [pendingTransfers] = await connection.query(`
      SELECT t.id as transfer_id, t.created_at, c.name as channel_name, c.shortname, u.username as old_owner_username
      FROM pending_channel_transfers t
      JOIN channels c ON t.channel_id = c.id
      JOIN users u ON t.old_owner_id = u.id
      WHERE t.new_owner_id = ? AND t.email_confirmed = TRUE
    `, [req.session.user.id]);

    connection.release();

    if (availableChannels.length === 1 && !isStaff && pendingTransfers.length === 0 && req.query.to !== 'channel') {
      req.session.panel_channel_id = availableChannels[0].id;
      return res.redirect('/panel,dashboard');
    }

    const to = req.query.to || '';
    const pageTitle = to === 'channel' ? 'Мои каналы | ЭтоЯTV' : 'Выбор телеканала | Панель управления | ЭтоЯTV';
    res.render('panel/select', { pageTitle, availableChannels, pendingTransfers, to });
  } catch (e) {
    console.error('Error loading channels:', e);
    res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,set_channel', requireAuth, async (req, res) => {
  const { channel_id } = req.body;
  const to = req.query.to || req.body.to;
  if (channel_id) {
    try {
      const connection = await pool.getConnection();
      const [staffRows] = await connection.query('SELECT role FROM staff WHERE user_id = ?', [req.session.user.id]);
      const isStaff = staffRows.length > 0;
      const [owned] = await connection.query(
        "SELECT id FROM channels WHERE id = ? AND user_id = ? AND status IN ('active', 'banned')",
        [channel_id, req.session.user.id]
      );
      let allowed = owned.length > 0;
      if (!allowed) {
        const [team] = await connection.query(
          "SELECT c.id FROM channels c JOIN channel_team t ON c.id = t.channel_id WHERE c.id = ? AND t.user_id = ? AND c.status IN ('active', 'banned') AND (t.is_editor = 1 OR t.is_reporter = 1 OR t.is_coowner = 1)",
          [channel_id, req.session.user.id]
        );
        allowed = team.length > 0;
      }
      if (!allowed && isStaff) {
        const [staffCh] = await connection.query(
          "SELECT id FROM channels WHERE id = ? AND status IN ('active', 'banned')",
          [channel_id]
        );
        allowed = staffCh.length > 0;
      }
      if (!allowed) {
        connection.release();
        return res.status(403).send('Нет доступа к этому каналу');
      }
      req.session.panel_channel_id = channel_id;
      if (to === 'channel') {
        const [ch] = await connection.query("SELECT shortname FROM channels WHERE id = ?", [channel_id]);
        connection.release();
        if (ch.length > 0) {
          return res.redirect('/' + ch[0].shortname);
        }
        return res.redirect('/panel,dashboard');
      }
      connection.release();
    } catch (err) {
      console.error(err);
      return res.status(500).send('Server Error');
    }
  }
  res.redirect('/panel,dashboard');
});

module.exports = router;
