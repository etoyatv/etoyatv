const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { formatChatMessage } = require('../../../utils/chatFormatter');
const { pool } = require('../../../config/db');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const emailService = require('../../../emailService');
const { requireAuth } = require('../../../middlewares/auth');
const { panelMiddleware, recordUploadMiddleware, designUploadMiddleware } = require('../../../middlewares/panel');
const { logAction } = require('../../../utils/logger');
const wordFilter = require('../../../utils/wordFilter');
const { getPinnedMessages } = require('../../../utils/pinnedMessages');
const { deletePublicFileIfExists, safeResolvePublic } = require('../../../utils/safePath');

function unlinkRecordFiles(record) {
  const publicRoot = path.join(__dirname, '../../../public');
  if (record.video_url) deletePublicFileIfExists(record.video_url, publicRoot);
  if (record.thumbnail_url) deletePublicFileIfExists(record.thumbnail_url, publicRoot);
  if (record.hls_url) {
    const hlsFile = safeResolvePublic(record.hls_url, publicRoot);
    if (hlsFile) {
      const hlsDir = path.dirname(hlsFile);
      if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true, force: true });
    }
  }
}

router.get('/ru/tv,studio', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const userId = req.session.user.id;
  const allowEveryone = res.locals.systemSettings && res.locals.systemSettings['allow_features_for_everyone'] === '1';
  try {
    const connection = await pool.getConnection();

    // 1. Get all channels owned by the user or where the user is a team member
    const [ownedChannels] = await connection.query("SELECT c.*, 'owner' as panel_role FROM channels c WHERE c.user_id = ? AND c.status IN ('active', 'banned')", [userId]);
    const [teamChannels] = await connection.query("SELECT c.*, t.is_editor, t.is_reporter, t.is_coowner FROM channels c JOIN channel_team t ON c.id = t.channel_id WHERE t.user_id = ? AND c.status IN ('active', 'banned') AND (t.is_editor = 1 OR t.is_reporter = 1 OR t.is_coowner = 1)", [userId]);

    let availableChannels = [...ownedChannels, ...teamChannels.map(c => {
      let role = 'reporter';
      if (c.is_coowner) role = 'coowner';
      else if (c.is_editor) role = 'editor';
      return { ...c, panel_role: role };
    })];

    const isStaff = req.session.user.staff_role && req.session.user.mask_mode !== 'user_mask';
    // If staff, load other channels if session.panel_channel_id exists
    if (isStaff && req.session.panel_channel_id) {
      const isAlreadyAvailable = availableChannels.some(c => c.id == req.session.panel_channel_id);
      if (!isAlreadyAvailable) {
        const [staffSelectedChannel] = await connection.query("SELECT c.*, 'staff' as panel_role FROM channels c WHERE c.id = ? AND c.status IN ('active', 'banned')", [req.session.panel_channel_id]);
        if (staffSelectedChannel.length > 0) {
          availableChannels.push(staffSelectedChannel[0]);
        }
      }
    }

    connection.release();

    if (availableChannels.length === 0) {
      return res.render('panel/studio_select', { availableChannels: [], error: 'У вас нет телеканалов для вещания.', allowEveryone });
    }

    // 2. Determine target channel
    let selectedChannelId = req.query.channel_id || req.session.panel_channel_id;
    let selectedChannel = availableChannels.find(c => c.id == selectedChannelId);

    if (selectedChannelId && selectedChannel) {
      req.session.panel_channel_id = selectedChannel.id;
    }

    if (!selectedChannel) {
      return res.render('panel/studio_select', { availableChannels, error: null, allowEveryone });
    }

    if (!selectedChannel.is_premium && !selectedChannel.is_verified && !allowEveryone) {
      return res.render('panel/studio_select', { 
        availableChannels, 
        error: `Телеканал "${selectedChannel.name}" не имеет активного Premium/Verified статуса. Эфирная студия доступна только для премиум-каналов.`,
        allowEveryone
      });
    }

    req.session.panel_channel_id = selectedChannel.id;

    let [keys] = await pool.query('SELECT stream_key FROM stream_keys WHERE channel_id = ? AND user_id = ?', [selectedChannel.id, userId]);
    let streamKey = '';
    if (keys.length === 0) {
      streamKey = 'sk_live_' + crypto.randomBytes(16).toString('hex');
      await pool.query('INSERT INTO stream_keys (channel_id, user_id, stream_key) VALUES (?, ?, ?)', [selectedChannel.id, userId, streamKey]);
    } else {
      streamKey = keys[0].stream_key;
    }

    const [records] = await pool.query(
      'SELECT id, title, video_url, hls_url, duration, thumbnail_url, access_level FROM records WHERE channel_id = ? AND hls_url IS NOT NULL ORDER BY created_at DESC',
      [selectedChannel.id]
    );

    res.render('panel/studio', {
      activeMenu: 'studio',
      activeSubmenu: '',
      panelChannel: selectedChannel,
      panelRole: selectedChannel.panel_role,
      records,
      streamKey,
      breadcrumbs: '<a href="/panel,dashboard">Панель управления</a> &gt; Эфирная студия'
    });
  } catch (e) {
    console.error('Error rendering Broadcast Studio:', e);
    res.status(500).send('Server Error');
  }
});

module.exports = router;
