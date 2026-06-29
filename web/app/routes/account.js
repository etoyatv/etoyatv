const express = require('express');
const router = express.Router();
const { pool } = require('../../config/db');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const emailService = require('../../emailService');
const wordFilter = require('../../utils/wordFilter');
const { requireAuth } = require('../../middlewares/auth');
const { panelMiddleware, recordUploadMiddleware, designUploadMiddleware } = require('../../middlewares/panel');
const multer = require('multer');
const { upload } = require('../../config/upload');
const { logAction } = require('../../utils/logger');

router.get('/ru/account,programs', async (req, res) => {
  const targetUsername = req.query.username;
  if (!targetUsername) {
    if (req.session.user) {
      return res.redirect(`/ru/account,programs?username=${encodeURIComponent(req.session.user.username)}`);
    } else {
      return res.redirect('/login');
    }
  }

  try {
    const connection = await pool.getConnection();
    const [userRows] = await connection.query('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL AND (is_banned = 0 OR (banned_until IS NOT NULL AND banned_until <= NOW()))', [targetUsername]);
    if (userRows.length === 0) {
      connection.release();
      return res.status(404).send('User not found');
    }
    const profileUser = userRows[0];

    const [scheduleRows] = await connection.query(`
      SELECT p.*, c.name as channel_name, c.shortname, c.logo_url 
      FROM personal_schedules ps
      JOIN programs p ON ps.program_id = p.id
      JOIN channels c ON p.channel_id = c.id
      WHERE ps.user_id = ? AND p.start_time >= NOW() - INTERVAL 2 HOUR
      ORDER BY p.start_time ASC
    `, [profileUser.id]);
    if (req.session.user) {
      const [userBookmarks] = await connection.query('SELECT program_id FROM personal_schedules WHERE user_id = ?', [req.session.user.id]);
      const bookmarkedIds = new Set(userBookmarks.map(b => b.program_id));
      scheduleRows.forEach(p => {
        p.is_bookmarked = bookmarkedIds.has(p.id);
      });
    }
    
    const [profileChannelRows] = await connection.query('SELECT * FROM channels WHERE user_id = ? AND is_personal = TRUE LIMIT 1', [profileUser.id]);
    const profileChannel = profileChannelRows.length > 0 ? profileChannelRows[0] : null;

    connection.release();
    
    res.render('account_programs', {
      pageTitle: `Личное расписание пользователя ${profileUser.username} | ЭтоЯTV`,
      schedules: scheduleRows,
      activeMenu: 'programs',
      profileUser: profileUser,
      profileChannel: profileChannel
    });
  } catch (err) {
    console.error('Error fetching personal schedule:', err);
    res.status(500).send('Database error');
  }
});

router.get('/ru/account,userinfo/', async (req, res) => {
  const targetUsername = req.query.username;
  if (!targetUsername) {
    if (req.session.user) {
      return res.redirect(`/ru/account,userinfo/?username=${encodeURIComponent(req.session.user.username)}`);
    } else {
      return res.redirect('/login');
    }
  }

  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT * FROM users WHERE username = ?', [targetUsername]);

    if (rows.length === 0) {
      connection.release();
      return res.status(404).render('404', { pageTitle: 'Пользователь не найден | ЭтоЯTV' });
    }

    const profileUser = rows[0];
    const isBanned = profileUser.is_banned === 1 && (!profileUser.banned_until || new Date(profileUser.banned_until) > new Date());
    
    if (profileUser.deleted_at || isBanned) {
      const isAdminOrMod = req.session.user && ['admin', 'moderator', 'mod'].includes(req.session.user.staff_role);
      if (!isAdminOrMod) {
        connection.release();
        return res.status(403).render('account_deleted', { pageTitle: 'Пользователь удален | ЭтоЯTV' });
      }
    }
    let friendshipStatus = 'none';
    let pendingRequests = [];
    let pendingOutgoingRequests = [];

    if (req.session.user && req.session.user.id) {
      const currentUserId = req.session.user.id;
      if (currentUserId !== profileUser.id) {
        const [friendships] = await connection.query(
          'SELECT * FROM friendships WHERE (requester_id = ? AND receiver_id = ?) OR (requester_id = ? AND receiver_id = ?)',
          [currentUserId, profileUser.id, profileUser.id, currentUserId]
        );
        if (friendships.length > 0) {
          const friendship = friendships[0];
          if (friendship.status === 'accepted') {
            friendshipStatus = 'accepted';
          } else {
            if (friendship.requester_id === currentUserId) {
              friendshipStatus = 'pending_sent';
            } else {
              friendshipStatus = 'pending_received';
            }
          }
        }
      } else {
        [pendingRequests] = await connection.query(`
          SELECT u.* 
          FROM friendships f
          JOIN users u ON f.requester_id = u.id
          WHERE f.receiver_id = ? AND f.status = 'pending'
        `, [currentUserId]);
        [pendingOutgoingRequests] = await connection.query(`
          SELECT u.* 
          FROM friendships f
          JOIN users u ON f.receiver_id = u.id
          WHERE f.requester_id = ? AND f.status = 'pending'
        `, [currentUserId]);
      }
    }

    const [friends] = await connection.query(`
      SELECT u.*, 
             (u.last_active IS NOT NULL AND UNIX_TIMESTAMP(NOW()) - UNIX_TIMESTAMP(u.last_active) <= 300) as is_online
      FROM users u
      JOIN friendships f ON (f.requester_id = u.id OR f.receiver_id = u.id)
      WHERE f.status = 'accepted'
        AND u.id != ?
        AND (f.requester_id = ? OR f.receiver_id = ?)
      ORDER BY u.id DESC
    `, [profileUser.id, profileUser.id, profileUser.id]);

    const [favoriteChannels] = await connection.query(`
      SELECT c.*, u.username as owner_name, u.avatar as owner_avatar,
      (SELECT COUNT(*) FROM channel_fans cf WHERE cf.channel_id = c.id) as fans_count
      ${req.session.user ? `, (SELECT COUNT(*) FROM channel_fans cf WHERE cf.channel_id = c.id AND cf.user_id = ${req.session.user.id}) as is_fan` : `, 0 as is_fan`}
      FROM channels c
      JOIN channel_fans f ON c.id = f.channel_id
      JOIN users u ON c.user_id = u.id
      WHERE f.user_id = ? AND c.status = 'active'
      ORDER BY f.created_at DESC
      LIMIT 5
    `, [profileUser.id]);

    const [favChannelsCountRow] = await connection.query(`SELECT COUNT(*) as cnt FROM channel_fans f JOIN channels c ON f.channel_id = c.id WHERE f.user_id = ? AND c.status = 'active'`, [profileUser.id]);
    const favoriteChannelsTotal = favChannelsCountRow[0].cnt;

    const [profileChannelRows] = await connection.query(`
      SELECT * FROM channels WHERE user_id = ? AND is_personal = TRUE LIMIT 1
    `, [profileUser.id]);
    const profileChannel = profileChannelRows.length > 0 ? profileChannelRows[0] : null;

    const [favoriteRecords] = await connection.query(`
      SELECT r.*, c.name as channel_name, c.shortname,
             (SELECT COUNT(*) FROM record_favorites rf WHERE rf.record_id = r.id) as fans_count
             ${req.session.user ? `, (SELECT COUNT(*) FROM record_favorites rf WHERE rf.record_id = r.id AND rf.user_id = ${req.session.user.id}) > 0 as is_fan` : ', 0 as is_fan'}
      FROM records r
      JOIN record_favorites f ON r.id = f.record_id
      JOIN channels c ON r.channel_id = c.id
      WHERE f.user_id = ? AND c.status = 'active'
      ORDER BY f.created_at DESC
      LIMIT 2
    `, [profileUser.id]);

    const [favoriteRecordsCountRow] = await connection.query(`
      SELECT COUNT(*) as cnt FROM record_favorites f JOIN records r ON f.record_id = r.id JOIN channels c ON r.channel_id = c.id WHERE f.user_id = ? AND c.status = 'active'
    `, [profileUser.id]);
    const favoriteRecordsTotal = favoriteRecordsCountRow[0].cnt;

    // Fetch personal schedules (up to 3)
    const [personalSchedules] = await connection.query(`
      SELECT p.*, c.name as channel_name, c.shortname, c.logo_url 
      FROM personal_schedules ps
      JOIN programs p ON ps.program_id = p.id
      JOIN channels c ON p.channel_id = c.id
      WHERE ps.user_id = ? AND p.start_time >= NOW() - INTERVAL 2 HOUR
      ORDER BY p.start_time ASC
      LIMIT 3
    `, [profileUser.id]);
    
    const [psCountRow] = await connection.query(`SELECT COUNT(*) as cnt FROM personal_schedules ps JOIN programs p ON ps.program_id = p.id WHERE ps.user_id = ? AND p.start_time >= NOW() - INTERVAL 2 HOUR`, [profileUser.id]);
    const personalSchedulesTotal = psCountRow[0].cnt;

    if (req.session.user) {
      const [userBookmarks] = await connection.query('SELECT program_id FROM personal_schedules WHERE user_id = ?', [req.session.user.id]);
      const bookmarkedIds = new Set(userBookmarks.map(b => b.program_id));
      personalSchedules.forEach(p => {
        p.is_bookmarked = bookmarkedIds.has(p.id);
      });
    }

    const cpage = parseInt(req.query.cpage) || 1;
    const cperPage = 7;
    const coffset = (cpage - 1) * cperPage;

    const [commentCountRows] = await connection.query('SELECT COUNT(*) as cnt FROM profile_comments WHERE profile_user_id = ? AND is_hidden = 0', [profileUser.id]);
    const totalComments = commentCountRows[0].cnt;
    const commentsTotalPages = Math.ceil(totalComments / cperPage);

    const [commentsRows] = await connection.query(`
      SELECT c.id, c.text, c.created_at, u.id as user_id, u.username, u.avatar 
      FROM profile_comments c 
      JOIN users u ON c.author_id = u.id 
      WHERE c.profile_user_id = ? AND c.is_hidden = 0
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `, [profileUser.id, cperPage, coffset]);

    connection.release();

    res.render('profile', {
      pageTitle: `Профиль пользователя ${profileUser.username} | ЭтоЯTV`,
      profileUser: profileUser,
      friendshipStatus: friendshipStatus,
      pendingRequests: pendingRequests,
      pendingOutgoingRequests: pendingOutgoingRequests,
      friends: friends,
      favoriteChannels: favoriteChannels,
      favoriteChannelsTotal: favoriteChannelsTotal,
      favoriteRecords: favoriteRecords,
      favoriteRecordsTotal: favoriteRecordsTotal,
      profileChannel: profileChannel,
      personalSchedules: personalSchedules,
      personalSchedulesTotal: personalSchedulesTotal,
      comments: commentsRows,
      cpage,
      commentsTotalPages,
      totalComments
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка сервера');
  }
});

router.get('/ru/account,favrecords', async (req, res) => {
  const targetUsername = req.query.username;
  if (!targetUsername) {
    if (req.session.user) {
      return res.redirect(`/ru/account,favrecords?username=${encodeURIComponent(req.session.user.username)}`);
    } else {
      return res.redirect('/login');
    }
  }

  try {
    const connection = await pool.getConnection();
    const [userRows] = await connection.query('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL AND (is_banned = 0 OR (banned_until IS NOT NULL AND banned_until <= NOW()))', [targetUsername]);
    if (userRows.length === 0) {
      connection.release();
      return res.status(404).send('User not found');
    }
    const profileUser = userRows[0];

    const page = parseInt(req.query.page) || 1;
    const limit = 5;
    const offset = (page - 1) * limit;

    const [countRows] = await connection.query("SELECT COUNT(*) as cnt FROM record_favorites f JOIN records r ON f.record_id = r.id JOIN channels c ON r.channel_id = c.id WHERE f.user_id = ? AND c.status = 'active'", [profileUser.id]);
    const totalRecords = countRows[0].cnt;
    const totalPages = Math.ceil(totalRecords / limit) || 1;

    const [records] = await connection.query(`
      SELECT r.id, r.title, r.duration, r.views, r.thumbnail_url, r.created_at, r.is_18_plus,
             c.name as channel_name, c.shortname,
             (SELECT COUNT(*) FROM record_favorites rf WHERE rf.record_id = r.id) as fans_count
             ${req.session.user ? `, (SELECT COUNT(*) FROM record_favorites rf WHERE rf.record_id = r.id AND rf.user_id = ${req.session.user.id}) > 0 as is_fan` : ', 0 as is_fan'}
      FROM records r 
      JOIN record_favorites f ON r.id = f.record_id 
      JOIN channels c ON r.channel_id = c.id
      WHERE f.user_id = ? AND c.status = 'active'
      ORDER BY f.created_at DESC
      LIMIT ? OFFSET ?
    `, [profileUser.id, limit, offset]);

    let friendshipStatus = 'none';
    let pendingRequests = [];
    if (req.session.user && req.session.user.id) {
      const currentUserId = req.session.user.id;
      if (currentUserId !== profileUser.id) {
        const [friendships] = await connection.query(
          'SELECT * FROM friendships WHERE (requester_id = ? AND receiver_id = ?) OR (requester_id = ? AND receiver_id = ?)',
          [currentUserId, profileUser.id, profileUser.id, currentUserId]
        );
        if (friendships.length > 0) {
          const friendship = friendships[0];
          if (friendship.status === 'accepted') friendshipStatus = 'accepted';
          else friendshipStatus = friendship.requester_id === currentUserId ? 'pending_sent' : 'pending_received';
        }
      } else {
        [pendingRequests] = await connection.query(`
          SELECT u.* FROM friendships f JOIN users u ON f.requester_id = u.id WHERE f.receiver_id = ? AND f.status = 'pending'
        `, [currentUserId]);
      }
    }

    const [friends] = await connection.query(`
      SELECT u.*, (u.last_active IS NOT NULL AND UNIX_TIMESTAMP(NOW()) - UNIX_TIMESTAMP(u.last_active) <= 300) as is_online
      FROM users u JOIN friendships f ON (f.requester_id = u.id OR f.receiver_id = u.id)
      WHERE f.status = 'accepted' AND u.id != ? AND (f.requester_id = ? OR f.receiver_id = ?) ORDER BY u.id DESC
    `, [profileUser.id, profileUser.id, profileUser.id]);

    const [profileChannelRows] = await connection.query('SELECT * FROM channels WHERE user_id = ? AND is_personal = TRUE LIMIT 1', [profileUser.id]);
    const profileChannel = profileChannelRows.length > 0 ? profileChannelRows[0] : null;

    connection.release();

    res.render('account_favrecords', {
      pageTitle: `Избранные записи пользователя ${profileUser.username} | YaTV`,
      profileUser,
      records,
      totalRecords,
      currentPage: page,
      totalPages,
      friendshipStatus,
      pendingRequests,
      friends,
      profileChannel,
      user: req.session.user
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});

router.get('/ru/account,favchannels', async (req, res) => {
  const targetUsername = req.query.username;
  if (!targetUsername) {
    if (req.session.user) {
      return res.redirect(`/ru/account,favchannels?username=${encodeURIComponent(req.session.user.username)}`);
    } else {
      return res.redirect('/login');
    }
  }

  try {
    const connection = await pool.getConnection();
    const [userRows] = await connection.query('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL AND (is_banned = 0 OR (banned_until IS NOT NULL AND banned_until <= NOW()))', [targetUsername]);
    if (userRows.length === 0) {
      connection.release();
      return res.status(404).send('User not found');
    }
    const profileUser = userRows[0];

    const page = parseInt(req.query.page) || 1;
    const limit = 5;
    const offset = (page - 1) * limit;

    const [countRows] = await connection.query("SELECT COUNT(*) as cnt FROM channel_fans f JOIN channels c ON f.channel_id = c.id WHERE f.user_id = ? AND c.status = 'active'", [profileUser.id]);
    const totalChannels = countRows[0].cnt;
    const totalPages = Math.ceil(totalChannels / limit) || 1;

    const [favoriteChannels] = await connection.query(`
      SELECT c.*, u.username as owner_name, u.avatar as owner_avatar,
      (SELECT COUNT(*) FROM channel_fans cf WHERE cf.channel_id = c.id) as fans_count
      ${req.session.user ? `, (SELECT COUNT(*) FROM channel_fans cf WHERE cf.channel_id = c.id AND cf.user_id = ${req.session.user.id}) as is_fan` : `, 0 as is_fan`}
      FROM channels c
      JOIN channel_fans f ON c.id = f.channel_id
      JOIN users u ON c.user_id = u.id
      WHERE f.user_id = ? AND c.status = 'active'
      ORDER BY f.created_at DESC
      LIMIT ? OFFSET ?
    `, [profileUser.id, limit, offset]);

    let friendshipStatus = 'none';
    let pendingRequests = [];
    if (req.session.user && req.session.user.id) {
      const currentUserId = req.session.user.id;
      if (currentUserId !== profileUser.id) {
        const [friendships] = await connection.query(
          'SELECT * FROM friendships WHERE (requester_id = ? AND receiver_id = ?) OR (requester_id = ? AND receiver_id = ?)',
          [currentUserId, profileUser.id, profileUser.id, currentUserId]
        );
        if (friendships.length > 0) {
          const friendship = friendships[0];
          if (friendship.status === 'accepted') friendshipStatus = 'accepted';
          else friendshipStatus = friendship.requester_id === currentUserId ? 'pending_sent' : 'pending_received';
        }
      } else {
        [pendingRequests] = await connection.query(`
          SELECT u.* FROM friendships f JOIN users u ON f.requester_id = u.id WHERE f.receiver_id = ? AND f.status = 'pending'
        `, [currentUserId]);
      }
    }

    const [friends] = await connection.query(`
      SELECT u.*, (u.last_active IS NOT NULL AND UNIX_TIMESTAMP(NOW()) - UNIX_TIMESTAMP(u.last_active) <= 300) as is_online
      FROM users u JOIN friendships f ON (f.requester_id = u.id OR f.receiver_id = u.id)
      WHERE f.status = 'accepted' AND u.id != ? AND (f.requester_id = ? OR f.receiver_id = ?) ORDER BY u.id DESC
    `, [profileUser.id, profileUser.id, profileUser.id]);

    const [profileChannelRows] = await connection.query('SELECT * FROM channels WHERE user_id = ? AND is_personal = TRUE LIMIT 1', [profileUser.id]);
    const profileChannel = profileChannelRows.length > 0 ? profileChannelRows[0] : null;

    connection.release();

    res.render('account_favchannels', {
      pageTitle: `Избранные телеканалы пользователя ${profileUser.username} | YaTV`,
      profileUser,
      favoriteChannels,
      totalChannels,
      currentPage: page,
      totalPages,
      friendshipStatus,
      pendingRequests,
      friends,
      profileChannel,
      user: req.session.user
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});

router.get('/ru/account,records', requireAuth, async (req, res) => {
  try {
    const [records] = await pool.query(`
      SELECT r.id, r.title, r.duration, r.views, r.thumbnail_url, r.created_at, r.is_18_plus,
             c.name as channel_name, c.shortname,
             (SELECT COUNT(*) FROM record_favorites rf WHERE rf.record_id = r.id) as fans_count
             ${req.session.user ? `, (SELECT COUNT(*) FROM record_favorites rf WHERE rf.record_id = r.id AND rf.user_id = ${req.session.user.id}) > 0 as is_fan` : ', 0 as is_fan'}
      FROM records r 
      JOIN record_likes l ON r.id = l.record_id 
      JOIN channels c ON r.channel_id = c.id
      WHERE l.user_id = ? AND c.status = 'active'
      ORDER BY l.created_at DESC
    `, [req.session.user.id]);

    res.render('account_records', {
      pageTitle: 'Избранные записи | ЭтоЯTV',
      profileUser: req.session.user,
      records
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});

router.get('/ru/account,userlist', async (req, res) => {
  const query = req.query.q || '';
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  try {
    const connection = await pool.getConnection();
    let countRows, userRows;
    if (query.trim() === '') {
      [countRows] = await connection.query('SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL AND is_banned = 0');
      [userRows] = await connection.query('SELECT *, (last_active IS NOT NULL AND UNIX_TIMESTAMP(NOW()) - UNIX_TIMESTAMP(last_active) <= 300) as is_online FROM users WHERE deleted_at IS NULL AND is_banned = 0 ORDER BY id DESC LIMIT ? OFFSET ?', [limit, offset]);
    } else {
      const searchPattern = '%' + query + '%';
      [countRows] = await connection.query('SELECT COUNT(*) as count FROM users WHERE username LIKE ? AND deleted_at IS NULL AND is_banned = 0', [searchPattern]);
      [userRows] = await connection.query('SELECT *, (last_active IS NOT NULL AND UNIX_TIMESTAMP(NOW()) - UNIX_TIMESTAMP(last_active) <= 300) as is_online FROM users WHERE username LIKE ? AND deleted_at IS NULL AND is_banned = 0 ORDER BY id DESC LIMIT ? OFFSET ?', [searchPattern, limit, offset]);
    }
    connection.release();

    const totalUsers = countRows[0].count;
    const totalPages = Math.ceil(totalUsers / limit) || 1;

    res.render('userlist', {
      pageTitle: `Поиск пользователей | ЭтоЯTV`,
      users: userRows,
      searchQuery: query,
      page: page,
      totalPages: totalPages
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка сервера');
  }
});

router.get('/ru/account,profile/', requireAuth, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
    
    const invitePage = Math.max(1, parseInt(req.query.invite_page) || 1);
    const limit = 5;
    const offset = (invitePage - 1) * limit;

    const [totalRows] = await connection.query('SELECT COUNT(*) as count FROM invite_codes WHERE creator_id = ?', [req.session.user.id]);
    const totalInvites = totalRows[0].count;
    const totalInvitePages = Math.ceil(totalInvites / limit) || 1;

    // Fetch user's invite codes
    const [invites] = await connection.query(`
      SELECT i.*, u.username as used_by_name 
      FROM invite_codes i
      LEFT JOIN users u ON i.used_by_id = u.id
      WHERE i.creator_id = ?
      ORDER BY i.created_at DESC
      LIMIT ? OFFSET ?
    `, [req.session.user.id, limit, offset]);

    const [bannedChannels] = await connection.query("SELECT id FROM channels WHERE user_id = ? AND status = 'banned'", [req.session.user.id]);
    const hasBannedChannel = bannedChannels.length > 0;

    const error2FA = req.session.error2FA;
    delete req.session.error2FA;

    const successPassword = req.session.successPassword;
    delete req.session.successPassword;
    const errorPassword = req.session.errorPassword;
    delete req.session.errorPassword;

    const errorInvite = req.session.errorInvite;
    delete req.session.errorInvite;
    const successInvite = req.session.successInvite;
    delete req.session.successInvite;

    const errorProfile = req.session.errorProfile;
    delete req.session.errorProfile;
    const successProfile = req.session.successProfile;
    delete req.session.successProfile;

    const errorAbout = req.session.errorAbout;
    delete req.session.errorAbout;
    const successAbout = req.session.successAbout;
    delete req.session.successAbout;

    const [profileChannelRows] = await connection.query('SELECT * FROM channels WHERE user_id = ? AND is_personal = TRUE LIMIT 1', [req.session.user.id]);
    const profileChannel = profileChannelRows.length > 0 ? profileChannelRows[0] : null;

    connection.release();
    res.render('settings', { 
      pageTitle: 'Настройки профиля | ЭтоЯTV', 
      profileUser: rows[0], 
      profileChannel,
      invites,
      invitePage,
      totalInvitePages,
      hasBannedChannel,
      error2FA,
      successPassword,
      errorPassword,
      errorInvite,
      successInvite,
      errorProfile,
      successProfile,
      errorAbout,
      successAbout
    });
  } catch (e) {
    console.error('PROFILE ERROR:', e);
    res.status(500).send('Error');
  }
});

router.post('/settings/profile', requireAuth, (req, res) => {
  if (req.ip_ban && req.ip_ban.ban_type === 'account') {
    return res.send('<script>alert("Ваш IP-адрес заблокирован (режим зрителя). Изменение профиля невозможно."); window.location.href="/ru/account,profile/#tab-profile";</script>');
  }
  upload.single('avatar')(req, res, async function (err) {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.send('<script>alert("Размер файла превышает 4 МБ."); setTimeout(function(){ window.location.href="/ru/account,profile/#tab-profile"; }, 1500);</script>');
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.send('<script>alert("Разрешена загрузка только изображений (jpeg, jpg, png, gif, webp)."); setTimeout(function(){ window.location.href="/ru/account,profile/#tab-profile"; }, 1500);</script>');
      }
      return res.send('<script>alert("Ошибка загрузки файла."); setTimeout(function(){ window.location.href="/ru/account,profile/#tab-profile"; }, 1500);</script>');
    } else if (err) {
      return res.send('<script>alert("Ошибка сервера при загрузке."); setTimeout(function(){ window.location.href="/ru/account,profile/#tab-profile"; }, 1500);</script>');
    }

    const { email, timezone, birthdate } = req.body;
    const currentEmail = req.session.user.email;
    const isEmailChanged = email && email.toLowerCase().trim() !== currentEmail.toLowerCase().trim();

    if (isEmailChanged) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        req.session.errorProfile = 'Некорректный формат E-Mail адреса';
        return res.redirect('/ru/account,profile/#tab-profile');
      }

      try {
        const connection = await pool.getConnection();
        const [existing] = await connection.query('SELECT id FROM users WHERE email = ? AND id != ?', [email.trim(), req.session.user.id]);
        connection.release();
        if (existing.length > 0) {
          req.session.errorProfile = 'Этот E-Mail уже занят другим пользователем';
          return res.redirect('/ru/account,profile/#tab-profile');
        }
      } catch (dbErr) {
        console.error('Email uniqueness check failed:', dbErr);
        req.session.errorProfile = 'Ошибка базы данных при проверке E-Mail';
        return res.redirect('/ru/account,profile/#tab-profile');
      }
    }

    let updateQuery = 'UPDATE users SET timezone = ?, birthdate = ? WHERE id = ?';
    let params = [timezone, birthdate || null, req.session.user.id];

    if (req.file) {
      updateQuery = 'UPDATE users SET timezone = ?, birthdate = ?, avatar = ? WHERE id = ?';
      params = [timezone, birthdate || null, '/images/avatars/' + req.file.filename, req.session.user.id];
      
      try {
        const connection = await pool.getConnection();
        const [oldRows] = await connection.query('SELECT avatar FROM users WHERE id = ?', [req.session.user.id]);
        connection.release();
        if (oldRows.length > 0 && oldRows[0].avatar && oldRows[0].avatar.startsWith('/images/avatars/')) {
          const fs = require('fs');
          const path = require('path');
          const filepath = path.join(__dirname, '../../public', oldRows[0].avatar);
          fs.unlink(filepath, (unlinkErr) => { if (unlinkErr) console.error('Failed to delete old avatar:', filepath); });
        }
      } catch (e) { console.error(e); }
    }

    try {
      const connection = await pool.getConnection();
      await connection.query(updateQuery, params);
      connection.release();
      
      if (timezone) {
        req.session.user.timezone = timezone;
      }

      if (isEmailChanged) {
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        req.session.pending_email_change = {
          new_email: email.trim(),
          code: code,
          expires: Date.now() + 15 * 60 * 1000
        };

        try {
          await emailService.sendEmailChangeVerificationCode(email.trim(), req.session.user.username, code);
          res.redirect('/settings/verify-email');
        } catch (mailErr) {
          console.error('Failed to send verification email:', mailErr);
          req.session.errorProfile = 'Не удалось отправить код подтверждения на новый E-Mail';
          res.redirect('/ru/account,profile/#tab-profile');
        }
      } else {
        req.session.successProfile = 'Профиль успешно сохранен';
        res.redirect('/ru/account,profile/#tab-profile');
      }
    } catch (e) {
      console.error('Error saving profile:', e);
      req.session.errorProfile = 'Ошибка при сохранении профиля';
      res.redirect('/ru/account,profile/#tab-profile');
    }
  });
});

router.get('/settings/verify-email', requireAuth, (req, res) => {
  const pending = req.session.pending_email_change;
  if (!pending || Date.now() > pending.expires) {
    delete req.session.pending_email_change;
    req.session.errorProfile = 'Срок действия запроса на изменение E-Mail истек или запрос отсутствует';
    return res.redirect('/ru/account,profile/#tab-profile');
  }

  const error = req.session.verifyEmailError;
  delete req.session.verifyEmailError;

  res.render('verify_email_change', {
    pageTitle: 'Подтверждение смены E-Mail | ЭтоЯTV',
    pendingEmail: pending.new_email,
    error: error || null,
    success: null
  });
});

router.post('/settings/verify-email', requireAuth, async (req, res) => {
  const pending = req.session.pending_email_change;
  if (!pending || Date.now() > pending.expires) {
    delete req.session.pending_email_change;
    req.session.errorProfile = 'Срок действия запроса на изменение E-Mail истек';
    return res.redirect('/ru/account,profile/#tab-profile');
  }

  const { code } = req.body;
  if (!code || code.trim() !== pending.code) {
    req.session.verifyEmailError = 'Неверный код подтверждения';
    return res.redirect('/settings/verify-email');
  }

  try {
    const connection = await pool.getConnection();
    const [oldUser] = await connection.query('SELECT email FROM users WHERE id = ?', [req.session.user.id]);
    await connection.query('UPDATE users SET email = ? WHERE id = ?', [pending.new_email, req.session.user.id]);
    connection.release();

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    const oldEmail = oldUser.length > 0 ? oldUser[0].email : '';
    logAction('user', req.session.user.username, `Изменил свою почту с подтверждением. Старая почта: ${oldEmail}. Новая: ${pending.new_email}`, userIp);

    req.session.user.email = pending.new_email;
    delete req.session.pending_email_change;

    req.session.successProfile = 'E-Mail адрес успешно изменен';
    res.redirect('/ru/account,profile/#tab-profile');
  } catch (err) {
    console.error('Error verifying email change:', err);
    req.session.verifyEmailError = 'Произошла ошибка при обновлении E-Mail адреса';
    res.redirect('/settings/verify-email');
  }
});

router.post('/settings/nickname', requireAuth, async (req, res) => {
  if (req.ip_ban && req.ip_ban.ban_type === 'account') {
    return res.render('settings', { pageTitle: 'Настройки | ЭтоЯTV', profileUser: req.session.user, errorNick: 'Смена никнейма заблокирована (режим зрителя).' });
  }
  let { new_nickname } = req.body;
  if (typeof new_nickname !== 'string') {
    new_nickname = '';
  }
  new_nickname = new_nickname.trim();

  if (!new_nickname || new_nickname.length > 13) {
    return res.render('settings', { pageTitle: 'Настройки | ЭтоЯTV', profileUser: req.session.user, errorNick: 'Имя пользователя не должно превышать 13 символов' });
  }

  const usernameRegex = /^[a-zA-Z0-9_-]+$/;
  if (!usernameRegex.test(new_nickname)) {
    return res.render('settings', { pageTitle: 'Настройки | ЭтоЯTV', profileUser: req.session.user, errorNick: 'Имя пользователя может содержать только латинские буквы, цифры, дефисы и нижние подчеркивания' });
  }

  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT username, last_nickname_change FROM users WHERE id = ?', [req.session.user.id]);
    const user = rows[0];

    if (user.last_nickname_change) {
      const diff = Date.now() - new Date(user.last_nickname_change).getTime();
      const days = diff / (1000 * 60 * 60 * 24);
      if (days < 30) {
        connection.release();
        return res.render('settings', { pageTitle: 'Настройки | ЭтоЯTV', profileUser: req.session.user, errorNick: 'Никнейм можно менять только 1 раз в 30 дней.' });
      }
    }

    const [existing] = await connection.query('SELECT id FROM users WHERE username = ?', [new_nickname]);
    if (existing.length > 0) {
      connection.release();
      return res.render('settings', { pageTitle: 'Настройки | ЭтоЯTV', profileUser: req.session.user, errorNick: 'Этот никнейм уже занят.' });
    }

    if (!req.session.user.staff_role && await wordFilter.containsBadWords(new_nickname)) {
      connection.release();
      return res.render('settings', { pageTitle: 'Настройки | ЭтоЯTV', profileUser: req.session.user, errorNick: 'Пользователя с запрещенным словом нельзя создавать.' });
    }

    await connection.query('UPDATE users SET username = ?, last_nickname_change = NOW() WHERE id = ?', [new_nickname, req.session.user.id]);
    await connection.query('INSERT INTO nickname_change_logs (user_id, old_nickname, new_nickname) VALUES (?, ?, ?)', [req.session.user.id, user.username, new_nickname]);

    req.session.user.username = new_nickname;
    connection.release();
    res.render('settings', { pageTitle: 'Настройки | ЭтоЯTV', profileUser: req.session.user, successNick: 'Никнейм успешно изменен!' });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error changing nickname');
  }
});

router.post('/settings/about', requireAuth, async (req, res) => {
  if (req.ip_ban && req.ip_ban.ban_type === 'account') {
    return res.status(403).send('Запрещено в режиме зрителя');
  }
  let { telegram, discord, about } = req.body;
  if (about && about.length > 200) {
    about = about.substring(0, 200);
  }
  try {
    const connection = await pool.getConnection();
    await connection.query('UPDATE users SET telegram = ?, discord = ?, about = ? WHERE id = ?', [telegram, discord, about, req.session.user.id]);
    connection.release();
    req.session.successAbout = 'Информация "О себе" успешно сохранена';
    req.session.save(() => {
      res.redirect('/ru/account,profile/#tab-about');
    });
  } catch (e) {
    req.session.errorAbout = 'Ошибка при сохранении информации "О себе"';
    req.session.save(() => {
      res.redirect('/ru/account,profile/#tab-about');
    });
  }
});

router.post('/settings/password', requireAuth, async (req, res) => {
  if (req.ip_ban && req.ip_ban.ban_type === 'account') {
    return res.status(403).send('Запрещено в режиме зрителя');
  }
  const { oldPassword, newPassword } = req.body;
  
  if (!newPassword || newPassword.trim().length < 6) {
    req.session.errorPassword = 'Новый пароль должен содержать не менее 6 символов';
    return req.session.save(() => {
      res.redirect('/ru/account,profile/#tab-password');
    });
  }

  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
    const match = await bcrypt.compare(oldPassword, rows[0].password);
    if (!match) {
      connection.release();
      req.session.errorPassword = 'Неверный старый пароль';
      return req.session.save(() => {
        res.redirect('/ru/account,profile/#tab-password');
      });
    }
    const hashedNew = await bcrypt.hash(newPassword, 10);
    await connection.query('UPDATE users SET password = ? WHERE id = ?', [hashedNew, req.session.user.id]);
    connection.release();
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('user', req.session.user.username, 'Самостоятельно изменил пароль', userIp);
    
    req.session.successPassword = 'Пароль успешно изменен!';
    req.session.save(() => {
      res.redirect('/ru/account,profile/#tab-password');
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error saving password');
  }
});

router.get('/account/2fa/setup', requireAuth, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT is_totp_enabled FROM users WHERE id = ?', [req.session.user.id]);
    connection.release();
    if (rows[0].is_totp_enabled) return res.redirect('/ru/account,profile/#tab-security');

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
      return res.redirect('/ru/account,profile/#tab-security');
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
        res.redirect('/ru/account,profile/#tab-security');
      });
    }

    await connection.query('UPDATE users SET totp_secret = NULL, is_totp_enabled = 0, totp_backup_codes = NULL WHERE id = ?', [req.session.user.id]);
    connection.release();
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('user', req.session.user.username, 'Отключил защиту по 2FA', userIp);
    res.redirect('/ru/account,profile/#tab-security');
  } catch (e) {
    res.status(500).send('Error');
  }
});

router.post('/settings/delete-account', requireAuth, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    
    // Check if user has a banned channel
    const [bannedChannels] = await connection.query("SELECT id FROM channels WHERE user_id = ? AND status = 'banned'", [req.session.user.id]);
    if (bannedChannels.length > 0) {
      connection.release();
      return res.send('<script>alert("Вы не можете удалить аккаунт, так как ваш телеканал заблокирован."); setTimeout(function(){ window.location.href="/ru/account,profile"; }, 1500);</script>');
    }

    await connection.query('UPDATE users SET deleted_at = NOW() WHERE id = ?', [req.session.user.id]);
    await connection.query("UPDATE channels SET status = 'deleted', deleted_at = NOW(), rtmp_disabled = 1 WHERE user_id = ? AND status != 'banned'", [req.session.user.id]);
    
    const [channels] = await connection.query('SELECT shortname FROM channels WHERE user_id = ?', [req.session.user.id]);
    const axios = require('axios');
    for (const ch of channels) {
      if (ch.shortname) {
        try {
          await axios.delete(`http://192.168.90.5:8000/api/streams/live/${ch.shortname}`, {
            auth: {
              username: process.env.RTMP_API_USER || 'admin',
              password: process.env.RTMP_API_PASS || 'admin'
            }
          });
        } catch (e) {
          console.error(`Failed to drop stream for ${ch.shortname}:`, e.message);
        }
      }
    }

    await connection.query('INSERT INTO user_deletion_logs (user_id, username) VALUES (?, ?)', [req.session.user.id, req.session.user.username]);
    connection.release();
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('user', req.session.user.username, 'Самостоятельно удалил свой аккаунт', userIp);
    req.session.destroy((err) => {
      res.redirect('/login');
    });
  } catch (e) {
    console.error('Error deleting account:', e);
    res.status(500).send('Server error');
  }
});

router.get('/friends/request', requireAuth, async (req, res) => {
  const targetUsername = req.query.username;
  if (!targetUsername) return res.redirect('back');
  try {
    const connection = await pool.getConnection();
    const [users] = await connection.query('SELECT id FROM users WHERE username = ?', [targetUsername]);
    if (users.length > 0) {
      const receiverId = users[0].id;
      const requesterId = req.session.user.id;
      if (requesterId !== receiverId) {
        await connection.query(
          'INSERT IGNORE INTO friendships (requester_id, receiver_id, status) VALUES (?, ?, ?)',
          [requesterId, receiverId, 'pending']
        );
      }
    }
    connection.release();
    res.redirect(`/ru/account,userinfo/?username=${encodeURIComponent(targetUsername)}`);
  } catch (e) {
    console.error('Error in /friends/request:', e);
    res.status(500).send('Server error');
  }
});

router.get('/friends/accept', requireAuth, async (req, res) => {
  const targetUsername = req.query.username;
  if (!targetUsername) return res.redirect('back');
  try {
    const connection = await pool.getConnection();
    const [users] = await connection.query('SELECT id FROM users WHERE username = ?', [targetUsername]);
    if (users.length > 0) {
      const requesterId = users[0].id;
      const receiverId = req.session.user.id;
      await connection.query(
        'UPDATE friendships SET status = ? WHERE requester_id = ? AND receiver_id = ?',
        ['accepted', requesterId, receiverId]
      );
    }
    connection.release();
    res.redirect(`/ru/account,userinfo/?username=${encodeURIComponent(targetUsername)}`);
  } catch (e) {
    console.error('Error in /friends/accept:', e);
    res.status(500).send('Server error');
  }
});

router.get('/friends/reject', requireAuth, async (req, res) => {
  const targetUsername = req.query.username;
  if (!targetUsername) return res.redirect('back');
  try {
    const connection = await pool.getConnection();
    const [users] = await connection.query('SELECT id FROM users WHERE username = ?', [targetUsername]);
    if (users.length > 0) {
      const requesterId = users[0].id;
      const receiverId = req.session.user.id;
      await connection.query(
        'DELETE FROM friendships WHERE requester_id = ? AND receiver_id = ?',
        [requesterId, receiverId]
      );
    }
    connection.release();
    res.redirect(`/ru/account,userinfo/?username=${encodeURIComponent(targetUsername)}`);
  } catch (e) {
    console.error('Error in /friends/reject:', e);
    res.status(500).send('Server error');
  }
});

router.get('/friends/remove', requireAuth, async (req, res) => {
  const targetUsername = req.query.username;
  if (!targetUsername) return res.redirect('back');
  try {
    const connection = await pool.getConnection();
    const [users] = await connection.query('SELECT id FROM users WHERE username = ?', [targetUsername]);
    if (users.length > 0) {
      const targetUserId = users[0].id;
      const currentUserId = req.session.user.id;
      await connection.query(
        'DELETE FROM friendships WHERE (requester_id = ? AND receiver_id = ?) OR (requester_id = ? AND receiver_id = ?)',
        [currentUserId, targetUserId, targetUserId, currentUserId]
      );
    }
    connection.release();
    res.redirect(`/ru/account,userinfo/?username=${encodeURIComponent(targetUsername)}`);
  } catch (e) {
    console.error('Error in /friends/remove:', e);
    res.status(500).send('Server error');
  }
});

// Friends list routes
router.get(['/ru/account,friends', '/ru/account,friendof'], async (req, res) => {
  const targetUsername = req.query.username;
  if (!targetUsername) {
    return res.redirect('/');
  }

  try {
    const connection = await pool.getConnection();
    const [users] = await connection.query('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL AND (is_banned = 0 OR (banned_until IS NOT NULL AND banned_until <= NOW()))', [targetUsername]);
    if (users.length === 0) {
      connection.release();
      return res.status(404).render('404', { pageTitle: 'Пользователь не найден | ЭтоЯTV' });
    }

    if (users[0].deleted_at) {
      connection.release();
      return res.status(404).render('account_deleted', { pageTitle: 'Пользователь удален | ЭтоЯTV' });
    }

    const profileUser = users[0];
    const [friends] = await connection.query(`
      SELECT u.*, 
             (u.last_active IS NOT NULL AND UNIX_TIMESTAMP(NOW()) - UNIX_TIMESTAMP(u.last_active) <= 300) as is_online
      FROM users u
      JOIN friendships f ON (f.requester_id = u.id OR f.receiver_id = u.id)
      WHERE f.status = 'accepted'
        AND u.id != ?
        AND (f.requester_id = ? OR f.receiver_id = ?)
      ORDER BY u.id DESC
    `, [profileUser.id, profileUser.id, profileUser.id]);

    const [profileChannelRows] = await connection.query('SELECT * FROM channels WHERE user_id = ? AND is_personal = TRUE LIMIT 1', [profileUser.id]);
    const profileChannel = profileChannelRows.length > 0 ? profileChannelRows[0] : null;

    connection.release();

    const isFriendOfPage = req.path.includes('friendof');
    const viewName = isFriendOfPage ? 'friendof' : 'friends';
    const pageTitle = isFriendOfPage
      ? `В друзьях у пользователей ${profileUser.username} | ЭтоЯTV`
      : `Друзья пользователя ${profileUser.username} | ЭтоЯTV`;

    res.render(viewName, {
      pageTitle: pageTitle,
      profileUser: profileUser,
      friends: friends,
      profileChannel: profileChannel
    });
  } catch (e) {
    console.error('Error fetching friends:', e);
    res.status(500).send('Server error');
  }
});

// ==========================================
// MESSAGING, BLOCKING & REPORTING SYSTEM
// ==========================================

// 1. Inbox (Conversations List)
router.get('/ru/messages/', requireAuth, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const userId = req.session.user.id;

    // We want the latest message per conversation
    const [conversations] = await connection.query(`
      SELECT m.*, u.username as other_username, u.avatar as other_avatar, u.last_active
      FROM messages m
      JOIN (
        SELECT 
          CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END as contact_id,
          MAX(id) as last_msg_id
        FROM messages 
        WHERE sender_id = ? OR receiver_id = ?
        GROUP BY contact_id
      ) latest ON m.id = latest.last_msg_id
      JOIN users u ON u.id = latest.contact_id
      WHERE u.deleted_at IS NULL AND IFNULL(u.role, 'user') != 'banned'
      ORDER BY m.created_at DESC
    `, [userId, userId, userId]);

    connection.release();
    res.render('messages_list', { pageTitle: 'Мои сообщения | ЭтоЯTV', conversations, currentUserId: userId });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error loading messages');
  }
});

// 2. Chat with specific user
router.get('/ru/messages/:username', requireAuth, async (req, res) => {
  const targetUsername = req.params.username;
  if (targetUsername === req.session.user.username) return res.redirect('/ru/messages/');

  try {
    const connection = await pool.getConnection();
    const currentUserId = req.session.user.id;

    // Get target user
    const [targetUsers] = await connection.query('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL AND (is_banned = 0 OR (banned_until IS NOT NULL AND banned_until <= NOW()))', [targetUsername]);
    if (targetUsers.length === 0) {
      connection.release();
      return res.send('<script>alert("Пользователь не найден."); setTimeout(function(){ window.location.href="/ru/messages/"; }, 1500);</script>');
    }
    const targetUser = targetUsers[0];
    if (targetUser.deleted_at || targetUser.role === 'banned') {
      connection.release();
      return res.send('<script>alert("Пользователь удален или заблокирован."); setTimeout(function(){ window.location.href="/ru/messages/"; }, 1500);</script>');
    }

    // Mark messages as read
    await connection.query('UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0', [targetUser.id, currentUserId]);

    // Check if I am blocked by them
    const [blocks] = await connection.query('SELECT * FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', [targetUser.id, currentUserId]);
    const amIBlocked = blocks.length > 0;

    // Check if I blocked them
    const [myBlocks] = await connection.query('SELECT * FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', [currentUserId, targetUser.id]);
    const areTheyBlocked = myBlocks.length > 0;

    // Get messages history
    const [messages] = await connection.query(`
      SELECT m.*, s.username as sender_name, s.avatar as sender_avatar 
      FROM messages m
      JOIN users s ON m.sender_id = s.id
      WHERE (m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?)
      ORDER BY m.created_at ASC
    `, [currentUserId, targetUser.id, targetUser.id, currentUserId]);

    connection.release();

    res.render('chat', {
      pageTitle: `Переписка с ${targetUser.username} | ЭтоЯTV`,
      targetUser,
      messages,
      currentUserId,
      amIBlocked,
      areTheyBlocked
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error loading chat');
  }
});

// 3. Send message
router.post('/ru/messages/:username', requireAuth, async (req, res) => {
  const targetUsername = req.params.username;
  if (targetUsername === 'Администрация ЭтоЯTV') {
    return res.send('<script>alert("Это системный аккаунт. Ответы не принимаются."); setTimeout(function(){ window.location.href="/ru/messages/"; }, 1500);</script>');
  }
  const content = req.body.content ? req.body.content.trim() : '';
  if (!content) return res.redirect(`/ru/messages/${encodeURIComponent(targetUsername)}`);
  if (content.length > 400) return res.send('<script>alert("Сообщение слишком длинное (максимум 400 символов)."); setTimeout(function(){ window.location.href="/ru/messages/' + encodeURIComponent(targetUsername) + '"; }, 1500);</script>');

  try {
    const connection = await pool.getConnection();
    const currentUserId = req.session.user.id;

    const [targetUsers] = await connection.query('SELECT id, deleted_at, role FROM users WHERE username = ?', [targetUsername]);
    if (targetUsers.length === 0) {
      connection.release();
      return res.send('<script>alert("Пользователь не найден."); setTimeout(function(){ window.location.href="/ru/messages/"; }, 1500);</script>');
    }
    const targetUser = targetUsers[0];
    const targetUserId = targetUser.id;
    if (targetUser.deleted_at || targetUser.role === 'banned') {
      connection.release();
      return res.send('<script>alert("Пользователь удален или заблокирован."); setTimeout(function(){ window.location.href="/ru/messages/"; }, 1500);</script>');
    }

    // Check if blocked 
    const [blocks] = await connection.query('SELECT * FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', [targetUserId, currentUserId]);
    if (blocks.length > 0) {
      connection.release();
      return res.send('<script>alert("Этот пользователь ограничил круг лиц, которые могут отправлять ему сообщения."); setTimeout(function(){ window.location.href="/ru/messages/' + encodeURIComponent(targetUsername) + '"; }, 1500);</script>');
    }

    await connection.query('INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)', [currentUserId, targetUserId, content]);
    connection.release();

    res.redirect(`/ru/messages/${encodeURIComponent(targetUsername)}`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error sending message');
  }
});

// 4. Block user
router.post('/users/block/:username', requireAuth, async (req, res) => {
  const targetUsername = req.params.username;
  if (targetUsername === 'Администрация ЭтоЯTV') {
    return res.send('<script>alert("Нельзя заблокировать системный аккаунт."); setTimeout(function(){ window.history.back(); }, 1500);</script>');
  }
  try {
    const connection = await pool.getConnection();
    const currentUserId = req.session.user.id;
    const [targetUsers] = await connection.query('SELECT id FROM users WHERE username = ?', [targetUsername]);

    if (targetUsers.length > 0) {
      const targetUserId = targetUsers[0].id;
      // Toggle block
      const [existingBlock] = await connection.query('SELECT id FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', [currentUserId, targetUserId]);
      if (existingBlock.length > 0) {
        await connection.query('DELETE FROM user_blocks WHERE id = ?', [existingBlock[0].id]);
      } else {
        await connection.query('INSERT IGNORE INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)', [currentUserId, targetUserId]);
      }
    }
    connection.release();
    res.redirect('back');
  } catch (e) {
    res.status(500).send('Error');
  }
});

// 5. Report user
router.post('/users/report/:username', requireAuth, async (req, res) => {
  const targetUsername = req.params.username;
  const reason = req.body.reason || 'Жалоба с профиля';
  try {
    const connection = await pool.getConnection();
    const currentUserId = req.session.user.id;
    const [targetUsers] = await connection.query('SELECT id FROM users WHERE username = ?', [targetUsername]);

    if (targetUsers.length > 0) {
      const targetUserId = targetUsers[0].id;
      await connection.query('INSERT INTO user_reports (reporter_id, reported_id, reason) VALUES (?, ?, ?)', [currentUserId, targetUserId, reason]);
    }
    connection.release();
    res.send('<script>alert("Ваша жалоба отправлена администрации."); setTimeout(function(){ window.location.href=document.referrer; }, 1500);</script>');
  } catch (e) {
    res.status(500).send('Error');
  }
});

// 6. Delete message
router.post('/ru/messages/delete/:id', requireAuth, async (req, res) => {
  const msgId = req.params.id;
  try {
    const connection = await pool.getConnection();
    const currentUserId = req.session.user.id;
    // Verify ownership
    const [msgs] = await connection.query('SELECT * FROM messages WHERE id = ?', [msgId]);
    if (msgs.length > 0) {
      const msg = msgs[0];
      if (msg.sender_id === currentUserId || msg.receiver_id === currentUserId) {
        await connection.query('DELETE FROM messages WHERE id = ?', [msgId]);
      }
    }
    connection.release();
    res.redirect('back');
  } catch (e) {
    res.status(500).send('Error deleting message');
  }
});

// 7. API Search Users for messaging
router.get('/api/users/search', requireAuth, async (req, res) => {
  const q = req.query.q || '';
  if (q.length < 1) return res.json([]);

  try {
    const connection = await pool.getConnection();
    const searchPattern = q + '%';
    const [users] = await connection.query('SELECT username, avatar FROM users WHERE username LIKE ? AND id != ? LIMIT 10', [searchPattern, req.session.user.id]);
    connection.release();
    res.json(users);
  } catch (e) {
    res.status(500).json([]);
  }
});




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
          res.redirect('/ru/account,profile/#tab-invites');
        });
      }
    }

    const crypto = require('crypto');
    const code = crypto.randomBytes(6).toString('hex').toUpperCase();
    await connection.query('INSERT INTO invite_codes (code, creator_id) VALUES (?, ?)', [code, req.session.user.id]);
    connection.release();
    
    req.session.successInvite = 'Инвайт-код успешно сгенерирован!';
    req.session.save(() => {
      res.redirect('/ru/account,profile/#tab-invites');
    });
  } catch(e) {
    console.error(e);
    req.session.errorInvite = 'Ошибка генерации инвайт-кода.';
    req.session.save(() => {
      res.redirect('/ru/account,profile/#tab-invites');
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
      res.redirect('/ru/account,profile/#tab-invites');
    });
  } catch(e) {
    console.error(e);
    req.session.errorInvite = 'Ошибка удаления инвайт-кода.';
    req.session.save(() => {
      res.redirect('/ru/account,profile/#tab-invites');
    });
  }
});

// Profile comments API routes
router.get('/api/profiles/:username/comments_html', async (req, res) => {
  const { username } = req.params;
  const cpage = parseInt(req.query.cpage) || 1;
  const cperPage = 7;
  const coffset = (cpage - 1) * cperPage;

  try {
    const connection = await pool.getConnection();
    const [users] = await connection.query('SELECT * FROM users WHERE username = ?', [username]);
    if (users.length === 0) {
      connection.release();
      return res.status(404).send('User not found');
    }
    const profileUser = users[0];

    const [commentCountRows] = await connection.query('SELECT COUNT(*) as cnt FROM profile_comments WHERE profile_user_id = ? AND is_hidden = 0', [profileUser.id]);
    const totalComments = commentCountRows[0].cnt;
    const commentsTotalPages = Math.ceil(totalComments / cperPage);

    const [commentsRows] = await connection.query(`
      SELECT c.id, c.text, c.created_at, u.id as user_id, u.username, u.avatar 
      FROM profile_comments c 
      JOIN users u ON c.author_id = u.id 
      WHERE c.profile_user_id = ? AND c.is_hidden = 0
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `, [profileUser.id, cperPage, coffset]);

    connection.release();

    res.render('partials/profile_comments_list', {
      comments: commentsRows,
      cpage,
      commentsTotalPages,
      user: req.session.user,
      profileUser: profileUser
    });
  } catch (e) {
    console.error('Error in profile comments html:', e);
    res.status(500).send('Error');
  }
});

router.get('/api/profiles/:username/comments_count', async (req, res) => {
  const { username } = req.params;
  try {
    const [users] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
    if (users.length === 0) return res.json({ success: false, error: 'User not found' });
    const [countRows] = await pool.query('SELECT COUNT(*) as cnt FROM profile_comments WHERE profile_user_id = ? AND is_hidden = 0', [users[0].id]);
    res.json({ success: true, count: countRows[0].cnt });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/api/profiles/:username/comment', requireAuth, async (req, res) => {
  const { username } = req.params;
  const { text } = req.body;
  if (!text || !text.trim()) return res.json({ success: false, error: 'Text is empty' });

  try {
    const connection = await pool.getConnection();
    const [users] = await connection.query('SELECT id FROM users WHERE username = ?', [username]);
    if (users.length === 0) {
      connection.release();
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    let commentText = text.trim();
    if (commentText.length > 300) commentText = commentText.substring(0, 300);

    const filteredComment = req.session.user.staff_role ? commentText : await wordFilter.filter(commentText);

    await connection.query('INSERT INTO profile_comments (profile_user_id, author_id, text) VALUES (?, ?, ?)', [users[0].id, req.session.user.id, filteredComment]);

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('user', req.session.user.username, `Оставил комментарий в профиле пользователя ${username}: "${filteredComment}"`, userIp);

    connection.release();
    res.json({ success: true });
  } catch (e) {
    console.error('Error adding profile comment:', e);
    res.json({ success: false, error: 'Server error' });
  }
});

router.delete('/api/profiles/:username/comment/:id', requireAuth, async (req, res) => {
  const { username, id } = req.params;
  try {
    const connection = await pool.getConnection();
    const [comments] = await connection.query('SELECT author_id, profile_user_id FROM profile_comments WHERE id = ?', [id]);
    if (comments.length === 0) {
      connection.release();
      return res.json({ success: false, error: 'Comment not found' });
    }
    const comment = comments[0];
    const staffRole = req.session.user.staff_role || '';
    const isStaff = ['admin', 'moderator', 'mod'].includes(staffRole);

    if (req.session.user.id !== comment.author_id && req.session.user.id !== comment.profile_user_id && !isStaff) {
      connection.release();
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    await connection.query('DELETE FROM profile_comments WHERE id = ?', [id]);
    connection.release();
    res.json({ success: true });
  } catch (e) {
    console.error('Error deleting profile comment:', e);
    res.json({ success: false, error: 'Server error' });
  }
});

module.exports = router;
