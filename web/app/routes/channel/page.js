// Main channel page: GET /:shortname
const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const { formatChatMessage } = require('../../../utils/chatFormatter');
const { getPinnedMessages } = require('../../../utils/pinnedMessages');

router.get('/:shortname', async (req, res, next) => {
  const { shortname } = req.params;

  // Skip logic if it looks like an asset or known root path
  if (shortname.includes('.') || shortname === 'ru' || shortname === 'images' || shortname === 'css' || shortname === 'js' || shortname === 'favicon.ico') {
    return next();
  }

  try {
    const [channels] = await pool.query(`
      SELECT c.*, u.username, s.is_superadmin as owner_is_superadmin 
      FROM channels c 
      JOIN users u ON c.user_id = u.id 
      LEFT JOIN staff s ON u.id = s.user_id 
      WHERE c.shortname = ?
    `, [shortname]);

    if (channels.length === 0) {
      return next(); // pass to 404
    }

    if (channels[0].status === 'deleted' || channels[0].status === 'banned') {
      const isAdminOrMod = req.session.user && ['admin', 'moderator', 'mod'].includes(req.session.user.staff_role);
      if (!isAdminOrMod) {
        return res.status(403).render('deleted_channel', { pageTitle: 'Канал удален | ЭтоЯTV', channel: channels[0] });
      }
    }

    const channelId = channels[0].id;

    // Fetch pinned message details if set
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

    let coowners = [];
    if (!channels[0].is_personal) {
      const [coownerRows] = await pool.query(`
        SELECT t.user_id, u.username 
        FROM channel_team t 
        JOIN users u ON t.user_id = u.id 
        WHERE t.channel_id = ? AND t.is_coowner = 1 
        ORDER BY t.order_index ASC, t.id ASC
      `, [channelId]);
      coowners = coownerRows;
    }

    if (channels[0].access_level === 'password') {
      const isPlatformAdmin = req.session.user && ['admin', 'moderator', 'mod'].includes(req.session.user.staff_role);
      if (!isPlatformAdmin && (!req.session.unlockedChannels || !req.session.unlockedChannels.includes(channelId))) {
        return res.render('password_prompt', { pageTitle: 'Ввод пароля | ЭтоЯTV', channel: channels[0], error: req.query.error });
      }
    }

    // Fetch fans count and up to 6 fans for the block
    const [fansRows] = await pool.query(`
      SELECT f.user_id, u.username, u.avatar,
             (u.last_active IS NOT NULL AND UNIX_TIMESTAMP(NOW()) - UNIX_TIMESTAMP(u.last_active) <= 300) as is_online
      FROM channel_fans f 
      JOIN users u ON f.user_id = u.id 
      WHERE f.channel_id = ? 
      ORDER BY f.created_at DESC 
      LIMIT 6
    `, [channelId]);

    const [fansCountRows] = await pool.query('SELECT COUNT(*) as count FROM channel_fans WHERE channel_id = ?', [channelId]);
    const fansCount = fansCountRows[0].count;

    let isFan = false;
    if (req.session.user) {
      const [userFanRows] = await pool.query('SELECT id FROM channel_fans WHERE user_id = ? AND channel_id = ?', [req.session.user.id, channelId]);
      isFan = userFanRows.length > 0;
    }

    const cpage = parseInt(req.query.cpage) || 1;
    const cperPage = 7;
    const coffset = (cpage - 1) * cperPage;

    const [commentCountRows] = await pool.query('SELECT COUNT(*) as cnt FROM channel_comments WHERE channel_id = ? AND is_hidden = 0', [channelId]);
    const totalComments = commentCountRows[0].cnt;
    const commentsTotalPages = Math.ceil(totalComments / cperPage);

    const [commentsRows] = await pool.query(`
      SELECT c.id, c.text, c.created_at, c.user_id,
             COALESCE(u.username, c.author_name, 'Пользователь') AS username,
             CASE WHEN u.id IS NULL THEN '/images/default_user_avatar.png' ELSE u.avatar END AS avatar
      FROM channel_comments c
      LEFT JOIN users u ON c.user_id = u.id
      WHERE c.channel_id = ? AND c.is_hidden = 0
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `, [channelId, cperPage, coffset]);

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
    const canSeeHiddenNews = isModerator || isGlobalAdminOrMod;

    if (isGlobalAdminOrMod) {
      channelRole = 'alien';
      isModerator = true;
    }

    const [newsRows] = await pool.query(`
      SELECT id, title, announce, created_at 
      FROM channel_news 
      WHERE channel_id = ? ${canSeeHiddenNews ? '' : 'AND is_hidden = 0'}
      ORDER BY created_at DESC
    `, [channelId]);

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

    const isOwnerOrStaff = req.session.user && (req.session.user.id === channels[0].user_id || ['admin', 'moderator'].includes(req.session.user.staff_role));
    const accessFilter = isOwnerOrStaff ? '' : " AND access_level = 'public'";

    const [recordsCountRows] = await pool.query(`SELECT COUNT(*) as cnt FROM records WHERE channel_id = ? AND status NOT IN ("deleted", "banned")${accessFilter}`, [channelId]);
    const totalRecords = recordsCountRows[0].cnt;

    const [recordsRows] = await pool.query(`
      
      SELECT r.*,
             (SELECT COUNT(*) FROM record_favorites rf WHERE rf.record_id = r.id) as fans_count
             ${req.session.user ? `, (SELECT COUNT(*) FROM record_favorites rf WHERE rf.record_id = r.id AND rf.user_id = ${Number(req.session.user.id)}) > 0 as is_fan` : ', 0 as is_fan'}
      FROM records r 
      WHERE channel_id = ? AND status NOT IN ('deleted', 'banned')${accessFilter}
      ORDER BY created_at DESC 
      LIMIT 2
    `, [channelId]);

    // Fetch upcoming programs for the channel
    let programsRows = [];
    let totalPrograms = 0;
    try {
      const [pCountRows] = await pool.query('SELECT COUNT(*) as cnt FROM programs WHERE channel_id = ? AND start_time >= NOW() - INTERVAL 2 HOUR AND (is_hidden = 0 OR is_hidden IS NULL)', [channelId]);
      totalPrograms = pCountRows[0].cnt;
      
      const progLimit = channels[0].is_live ? 2 : 3;
      const query = `
        SELECT p.*, 
               (SELECT COUNT(*) FROM personal_schedules ps WHERE ps.program_id = p.id) as bookmarks_count
               ${req.session.user ? `, (SELECT COUNT(*) FROM personal_schedules ps WHERE ps.program_id = p.id AND ps.user_id = ${Number(req.session.user.id)}) > 0 as is_bookmarked` : ', 0 as is_bookmarked'}
        FROM programs p
        WHERE p.channel_id = ? AND p.start_time >= NOW() - INTERVAL 2 HOUR AND (p.is_hidden = 0 OR p.is_hidden IS NULL)
        ORDER BY p.start_time ASC
        LIMIT ?
      `;
      const [pRows] = await pool.query(query, [channelId, progLimit]);
      programsRows = pRows;
    } catch (e) {
      console.error('Error fetching programs:', e);
    }

    res.render('channel', {
      pageTitle: channels[0].name + ' | ЭтоЯTV - Я есть телевидение!',
      channel: channels[0],
      owner: { username: channels[0].username, id: channels[0].user_id },
      fans: fansRows,
      fansCount,
      isFan,
      comments: commentsRows,
      cpage,
      commentsTotalPages,
      totalComments,
      news: newsRows,
      chatMessages: chatRows,
      user: req.session.user,
      records: recordsRows,
      totalRecords: totalRecords,
      channelRole,
      isModerator,
      programs: programsRows,
      totalPrograms,
      coowners: coowners
    });
  } catch (e) {
    console.error('Error fetching channel:', e);
    next();
  }
});

module.exports = router;
