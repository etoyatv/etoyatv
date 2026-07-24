const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const { requireAuth } = require('../../../middlewares/auth');
const { hasProfileAccess, hasFriendsListAccess, canMessageUser } = require('./privacy');

router.get('/ru/account,programs', async (req, res) => {
  const targetUsername = req.query.username;
  if (!targetUsername) {
    if (req.session.user) {
      return res.redirect(`/account,programs?username=${encodeURIComponent(req.session.user.username)}`);
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
    const hasAccess = await hasProfileAccess(req.session.user, profileUser);
    if (!hasAccess) {
      connection.release();
      return res.redirect(`/account,userinfo/?username=${encodeURIComponent(profileUser.username)}`);
    }
    const [scheduleRows] = await connection.query(`
      SELECT p.*, c.name as channel_name, c.shortname, c.logo_url, c.logo_fit,
             (SELECT COUNT(*) FROM personal_schedules ps2 WHERE ps2.program_id = p.id) as bookmarks_count
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

    const canSeeFriendsList = await hasFriendsListAccess(req.session.user, profileUser);

    connection.release();
    
    res.render('account_programs', {
      pageTitle: `Личное расписание пользователя ${profileUser.username} | ЭтоЯTV`,
      schedules: scheduleRows,
      activeMenu: 'programs',
      profileUser: profileUser,
      profileChannel: profileChannel,
      canSeeFriendsList
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
      return res.redirect(`/account,userinfo/?username=${encodeURIComponent(req.session.user.username)}`);
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
    const hasAccess = await hasProfileAccess(req.session.user, profileUser);
    if (!hasAccess) {
      const [staffRows] = await connection.query('SELECT role, is_superadmin FROM staff WHERE user_id = ?', [profileUser.id]);
      if (staffRows.length > 0) {
        profileUser.staff_role = staffRows[0].role;
        profileUser.is_superadmin = staffRows[0].is_superadmin;
      } else {
        profileUser.staff_role = null;
        profileUser.is_superadmin = false;
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
        }
      }

      let canMessageTarget = false;
      if (req.session.user && req.session.user.id !== profileUser.id) {
        canMessageTarget = await canMessageUser(req.session.user, profileUser);
      }

      connection.release();

      return res.status(403).render('profile', {
        pageTitle: `Доступ ограничен | ЭтоЯTV`,
        profileUser: profileUser,
        friendshipStatus: friendshipStatus,
        pendingRequests: pendingRequests,
        pendingOutgoingRequests: pendingOutgoingRequests,
        friends: [],
        favoriteChannels: [],
        favoriteChannelsTotal: 0,
        favoriteRecords: [],
        favoriteRecordsTotal: 0,
        profileChannel: null,
        personalSchedules: [],
        personalSchedulesTotal: 0,
        comments: [],
        cpage: 1,
        commentsTotalPages: 0,
        totalComments: 0,
        canMessageTarget: canMessageTarget,
        isRestricted: true,
        restrictionMessage: 'Владелец этого профиля ограничил доступ к своей странице.'
      });
    }
    const [staffRows] = await connection.query('SELECT role, is_superadmin FROM staff WHERE user_id = ?', [profileUser.id]);
    if (staffRows.length > 0) {
      profileUser.staff_role = staffRows[0].role;
      profileUser.is_superadmin = staffRows[0].is_superadmin;
    } else {
      profileUser.staff_role = null;
      profileUser.is_superadmin = false;
    }
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

    const canSeeFriendsList = await hasFriendsListAccess(req.session.user, profileUser);
    let friends = [];
    if (canSeeFriendsList) {
      const [friendsRows] = await connection.query(`
        SELECT u.*, 
               (u.last_active IS NOT NULL AND UNIX_TIMESTAMP(NOW()) - UNIX_TIMESTAMP(u.last_active) <= 300) as is_online
        FROM users u
        JOIN friendships f ON (f.requester_id = u.id OR f.receiver_id = u.id)
        WHERE f.status = 'accepted'
          AND u.id != ?
          AND (f.requester_id = ? OR f.receiver_id = ?)
        ORDER BY u.id DESC
      `, [profileUser.id, profileUser.id, profileUser.id]);
      friends = friendsRows;
    }

    const [favoriteChannels] = await connection.query(`
      SELECT c.*, u.username as owner_name, u.avatar as owner_avatar,
      (SELECT COUNT(*) FROM channel_fans cf WHERE cf.channel_id = c.id) as fans_count
      ${req.session.user ? `, (SELECT COUNT(*) FROM channel_fans cf WHERE cf.channel_id = c.id AND cf.user_id = ${Number(req.session.user.id)}) as is_fan` : `, 0 as is_fan`}
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
             ${req.session.user ? `, (SELECT COUNT(*) FROM record_favorites rf WHERE rf.record_id = r.id AND rf.user_id = ${Number(req.session.user.id)}) > 0 as is_fan` : ', 0 as is_fan'}
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

    const [personalSchedules] = await connection.query(`
      SELECT p.*, c.name as channel_name, c.shortname, c.logo_url, c.logo_fit,
             (SELECT COUNT(*) FROM personal_schedules ps2 WHERE ps2.program_id = p.id) as bookmarks_count
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

    let canMessageTarget = false;
    if (req.session.user && req.session.user.id !== profileUser.id) {
      canMessageTarget = await canMessageUser(req.session.user, profileUser);
    }

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
      totalComments,
      canMessageTarget,
      canSeeFriendsList
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
      return res.redirect(`/account,favrecords?username=${encodeURIComponent(req.session.user.username)}`);
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
    const hasAccess = await hasProfileAccess(req.session.user, profileUser);
    if (!hasAccess) {
      connection.release();
      return res.redirect(`/account,userinfo/?username=${encodeURIComponent(profileUser.username)}`);
    }

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
             ${req.session.user ? `, (SELECT COUNT(*) FROM record_favorites rf WHERE rf.record_id = r.id AND rf.user_id = ${Number(req.session.user.id)}) > 0 as is_fan` : ', 0 as is_fan'}
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

    const canSeeFriendsList = await hasFriendsListAccess(req.session.user, profileUser);
    let friends = [];
    if (canSeeFriendsList) {
      const [friendsRows] = await connection.query(`
        SELECT u.*, (u.last_active IS NOT NULL AND UNIX_TIMESTAMP(NOW()) - UNIX_TIMESTAMP(u.last_active) <= 300) as is_online
        FROM users u JOIN friendships f ON (f.requester_id = u.id OR f.receiver_id = u.id)
        WHERE f.status = 'accepted' AND u.id != ? AND (f.requester_id = ? OR f.receiver_id = ?) ORDER BY u.id DESC
      `, [profileUser.id, profileUser.id, profileUser.id]);
      friends = friendsRows;
    }

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
      user: req.session.user,
      canSeeFriendsList
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
      return res.redirect(`/account,favchannels?username=${encodeURIComponent(req.session.user.username)}`);
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
    const hasAccess = await hasProfileAccess(req.session.user, profileUser);
    if (!hasAccess) {
      connection.release();
      return res.redirect(`/account,userinfo/?username=${encodeURIComponent(profileUser.username)}`);
    }

    const page = parseInt(req.query.page) || 1;
    const limit = 5;
    const offset = (page - 1) * limit;

    const [countRows] = await connection.query("SELECT COUNT(*) as cnt FROM channel_fans f JOIN channels c ON f.channel_id = c.id WHERE f.user_id = ? AND c.status = 'active'", [profileUser.id]);
    const totalChannels = countRows[0].cnt;
    const totalPages = Math.ceil(totalChannels / limit) || 1;

    const [favoriteChannels] = await connection.query(`
      SELECT c.*, u.username as owner_name, u.avatar as owner_avatar,
      (SELECT COUNT(*) FROM channel_fans cf WHERE cf.channel_id = c.id) as fans_count
      ${req.session.user ? `, (SELECT COUNT(*) FROM channel_fans cf WHERE cf.channel_id = c.id AND cf.user_id = ${Number(req.session.user.id)}) as is_fan` : `, 0 as is_fan`}
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

    const canSeeFriendsList = await hasFriendsListAccess(req.session.user, profileUser);
    let friends = [];
    if (canSeeFriendsList) {
      const [friendsRows] = await connection.query(`
        SELECT u.*, (u.last_active IS NOT NULL AND UNIX_TIMESTAMP(NOW()) - UNIX_TIMESTAMP(u.last_active) <= 300) as is_online
        FROM users u JOIN friendships f ON (f.requester_id = u.id OR f.receiver_id = u.id)
        WHERE f.status = 'accepted' AND u.id != ? AND (f.requester_id = ? OR f.receiver_id = ?) ORDER BY u.id DESC
      `, [profileUser.id, profileUser.id, profileUser.id]);
      friends = friendsRows;
    }

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
      user: req.session.user,
      canSeeFriendsList
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
             ${req.session.user ? `, (SELECT COUNT(*) FROM record_favorites rf WHERE rf.record_id = r.id AND rf.user_id = ${Number(req.session.user.id)}) > 0 as is_fan` : ', 0 as is_fan'}
      FROM records r 
      JOIN record_likes l ON r.id = l.record_id 
      JOIN channels c ON r.channel_id = c.id
      WHERE l.user_id = ? AND c.status = 'active'
      ORDER BY l.created_at DESC
    `, [req.session.user.id]);

    res.render('account_records', {
      pageTitle: 'Избранные записи | ЭтоЯTV',
      profileUser: req.session.user,
      records,
      canSeeFriendsList: true
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
    const viewer = req.session && req.session.user ? req.session.user : null;
    const viewerId = viewer ? viewer.id : null;
    const isStaff = viewer && ['admin', 'moderator'].includes(viewer.staff_role);

    // Private profiles are hidden from search/list except for the owner and staff
    const privacyClause = isStaff
      ? '1=1'
      : viewerId
        ? "(privacy_profile IS NULL OR privacy_profile != 'private' OR id = ?)"
        : "(privacy_profile IS NULL OR privacy_profile != 'private')";
    const privacyParams = (!isStaff && viewerId) ? [viewerId] : [];

    let countRows, userRows;
    if (query.trim() === '') {
      [countRows] = await connection.query(
        `SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL AND is_banned = 0 AND ${privacyClause}`,
        privacyParams
      );
      [userRows] = await connection.query(
        `SELECT *, (last_active IS NOT NULL AND UNIX_TIMESTAMP(NOW()) - UNIX_TIMESTAMP(last_active) <= 300) as is_online
         FROM users WHERE deleted_at IS NULL AND is_banned = 0 AND ${privacyClause}
         ORDER BY id DESC LIMIT ? OFFSET ?`,
        [...privacyParams, limit, offset]
      );
    } else {
      const searchPattern = '%' + query + '%';
      [countRows] = await connection.query(
        `SELECT COUNT(*) as count FROM users WHERE username LIKE ? AND deleted_at IS NULL AND is_banned = 0 AND ${privacyClause}`,
        [searchPattern, ...privacyParams]
      );
      [userRows] = await connection.query(
        `SELECT *, (last_active IS NOT NULL AND UNIX_TIMESTAMP(NOW()) - UNIX_TIMESTAMP(last_active) <= 300) as is_online
         FROM users WHERE username LIKE ? AND deleted_at IS NULL AND is_banned = 0 AND ${privacyClause}
         ORDER BY id DESC LIMIT ? OFFSET ?`,
        [searchPattern, ...privacyParams, limit, offset]
      );
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

module.exports = router;
