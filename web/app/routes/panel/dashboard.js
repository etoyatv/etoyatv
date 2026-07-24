// Panel dashboard
const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const { formatChatMessage } = require('../../../utils/chatFormatter');
const { panelMiddleware } = require('../../../middlewares/panel');
const { getPinnedMessages } = require('../../../utils/pinnedMessages');

router.get('/dashboard', (req, res) => {
  res.redirect('/panel,dashboard');
});

router.get('/ru/panel,dashboard', panelMiddleware, async (req, res) => {
  try {
    const channelId = res.locals.panelChannel.id;

    // Fetch pinned messages
    res.locals.panelChannel.pinnedMessages = await getPinnedMessages(res.locals.panelChannel);
    if (res.locals.panelChannel.pinnedMessages.common) {
      res.locals.panelChannel.pinned_message = res.locals.panelChannel.pinnedMessages.common.message;
      res.locals.panelChannel.pinned_guest_name = res.locals.panelChannel.pinnedMessages.common.username || res.locals.panelChannel.pinnedMessages.common.guest_name;
      res.locals.panelChannel.pinned_username = res.locals.panelChannel.pinnedMessages.common.username;
      res.locals.panelChannel.pinned_role = res.locals.panelChannel.pinnedMessages.common.role;
      res.locals.panelChannel.pinned_color = res.locals.panelChannel.pinnedMessages.common.color;
      res.locals.panelChannel.pinned_message_id = res.locals.panelChannel.pinnedMessages.common.id;
    } else {
      res.locals.panelChannel.pinned_message = null;
      res.locals.panelChannel.pinned_message_id = null;
    }

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

    res.render('panel/dashboard', { 
      activeMenu: 'dashboard', 
      activeSubmenu: '', 
      breadcrumbs: 'Панель управления',
      chatMessages: chatRows
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

module.exports = router;
