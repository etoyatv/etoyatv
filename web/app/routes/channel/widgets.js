// Channel embed widgets: chat, player, combined
const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const { formatChatMessage } = require('../../../utils/chatFormatter');
const { getPinnedMessages } = require('../../../utils/pinnedMessages');
const { canViewChannelContent } = require('../../../utils/channelAccess');

router.get('/widget/chat/:shortname', async (req, res, next) => {
  const { shortname } = req.params;

  try {
    const [channels] = await pool.query('SELECT c.*, u.username FROM channels c JOIN users u ON c.user_id = u.id WHERE c.shortname = ?', [shortname]);

    if (channels.length === 0) {
      return res.status(404).send('Channel not found');
    }

    if (channels[0].status === 'deleted' || channels[0].status === 'banned') {
      return res.status(403).send('Channel is banned or deleted');
    }

    const level = channels[0].access_level || 'public';
    if ((level === 'password' || level === 'private') && !canViewChannelContent(req, channels[0])) {
      return res.status(403).send('Channel is locked');
    }

    const channelId = channels[0].id;

    channels[0].pinnedMessages = await getPinnedMessages(channels[0]);
    if (channels[0].pinnedMessages.common) {
      channels[0].pinned_message = channels[0].pinnedMessages.common.message;
      channels[0].pinned_guest_name = channels[0].pinnedMessages.common.username || channels[0].pinnedMessages.common.guest_name;
      channels[0].pinned_username = channels[0].pinnedMessages.common.username;
      channels[0].pinned_role = channels[0].pinnedMessages.common.role;
      channels[0].pinned_color = channels[0].pinnedMessages.common.color;
      channels[0].pinned_message_id = channels[0].pinnedMessages.common.id;
    } else {
      channels[0].pinned_message = null;
      channels[0].pinned_message_id = null;
    }

    // Fetch recent chat messages
    const [chatRows] = await pool.query(`
      SELECT m.id, m.user_id, m.guest_name, u.username, m.message, m.role, m.created_at, m.color, m.stream_index
      FROM chat_messages m
      LEFT JOIN users u ON m.user_id = u.id
      WHERE m.channel_id = ?
      ORDER BY m.id ASC
    `, [channelId]);

    chatRows.forEach(row => {
      row.message = formatChatMessage(row.message);
    });

    let channelRole = 'guest';
    let isModerator = false;
    if (req.session.user) {
      if (req.session.user.id === channels[0].user_id) {
        channelRole = 'owner';
        isModerator = true;
      } else {
        const [teamRow] = await pool.query('SELECT is_reporter, is_moderator, is_editor, is_coowner FROM channel_team WHERE channel_id = ? AND user_id = ?', [channelId, req.session.user.id]);
        if (teamRow.length > 0) {
          const t = teamRow[0];
          if (t.is_coowner) channelRole = 'coowner';
          else if (t.is_moderator) channelRole = 'moderator';
          else if (t.is_editor) channelRole = 'editor';
          else if (t.is_reporter) channelRole = 'reporter';

          if (t.is_moderator || t.is_coowner) isModerator = true;
        }
      }
    }

    const isGlobalAdminOrMod = req.session.user && ['admin', 'moderator', 'mod'].includes(req.session.user.staff_role);
    if (isGlobalAdminOrMod) {
      channelRole = 'alien';
      isModerator = true;
    }

    const overlay = req.query.overlay === '1' || req.query.overlay === 'true';
    const readonly = req.query.readonly === '1' || req.query.readonly === 'true' || overlay;

    res.render('chat_widget', {
      channel: channels[0],
      chatMessages: chatRows,
      user: req.session.user,
      channelRole,
      isModerator,
      overlay,
      readonly,
      CDN_BASE_URL: res.locals.CDN_BASE_URL || ''
    });
  } catch (e) {
    console.error('Error fetching chat widget:', e);
    res.status(500).send('Server error');
  }
});

router.get('/widget/player/:shortname', async (req, res, next) => {
  const { shortname } = req.params;

  try {
    const [channels] = await pool.query('SELECT c.*, u.username FROM channels c JOIN users u ON c.user_id = u.id WHERE c.shortname = ?', [shortname]);

    if (channels.length === 0) {
      return res.status(404).send('Channel not found');
    }

    if (channels[0].status === 'deleted' || channels[0].status === 'banned') {
      return res.status(403).send('Channel is banned or deleted');
    }

    const level = channels[0].access_level || 'public';
    if ((level === 'password' || level === 'private') && !canViewChannelContent(req, channels[0])) {
      return res.status(403).send('Channel is locked');
    }

    const channelId = channels[0].id;

    let channelRole = 'guest';
    let isModerator = false;
    if (req.session.user) {
      if (req.session.user.id === channels[0].user_id) {
        channelRole = 'owner';
        isModerator = true;
      } else {
        const [teamRow] = await pool.query('SELECT is_reporter, is_moderator, is_editor, is_coowner FROM channel_team WHERE channel_id = ? AND user_id = ?', [channelId, req.session.user.id]);
        if (teamRow.length > 0) {
          const t = teamRow[0];
          if (t.is_coowner) channelRole = 'coowner';
          else if (t.is_moderator) channelRole = 'moderator';
          else if (t.is_editor) channelRole = 'editor';
          else if (t.is_reporter) channelRole = 'reporter';

          if (t.is_moderator || t.is_coowner) isModerator = true;
        }
      }
    }

    const isGlobalAdminOrMod = req.session.user && ['admin', 'moderator', 'mod'].includes(req.session.user.staff_role);
    if (isGlobalAdminOrMod) {
      channelRole = 'alien';
      isModerator = true;
    }

    res.render('player_widget', {
      channel: channels[0],
      user: req.session.user,
      channelRole,
      isModerator,
      CDN_BASE_URL: res.locals.CDN_BASE_URL || ''
    });
  } catch (e) {
    console.error('Error fetching player widget:', e);
    res.status(500).send('Server error');
  }
});

router.get('/widget/combined/:shortname', async (req, res, next) => {
  const { shortname } = req.params;
  const { layout, autoplay } = req.query;

  try {
    const [channels] = await pool.query('SELECT status FROM channels WHERE shortname = ?', [shortname]);

    if (channels.length === 0) {
      return res.status(404).send('Channel not found');
    }

    if (channels[0].status === 'deleted' || channels[0].status === 'banned') {
      return res.status(403).send('Channel is banned or deleted');
    }

    res.render('combined_widget', {
      shortname,
      layout: layout === 'vertical' ? 'vertical' : 'horizontal',
      autoplay: autoplay === '1' ? '1' : '0'
    });
  } catch (e) {
    console.error('Error fetching combined widget:', e);
    res.status(500).send('Server error');
  }
});

module.exports = router;
