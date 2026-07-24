const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const { requireAuth } = require('../../../middlewares/auth');
const { hasProfileAccess, hasFriendsListAccess } = require('./privacy');
const { redirectBack } = require('../../../utils/safeRedirect');

async function friendsRequestHandler(req, res) {
  const targetUsername = req.body.username || req.query.username;
  if (!targetUsername) return redirectBack(req, res, '/account,favchannels');
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
    res.redirect(`/account,userinfo/?username=${encodeURIComponent(targetUsername)}`);
  } catch (e) {
    console.error('Error in /friends/request:', e);
    res.status(500).send('Server error');
  }
}

router.post('/friends/request', requireAuth, friendsRequestHandler);

async function friendsAcceptHandler(req, res) {
  const targetUsername = req.body.username || req.query.username;
  if (!targetUsername) return redirectBack(req, res, '/account,favchannels');
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
    res.redirect(`/account,userinfo/?username=${encodeURIComponent(targetUsername)}`);
  } catch (e) {
    console.error('Error in /friends/accept:', e);
    res.status(500).send('Server error');
  }
}

router.post('/friends/accept', requireAuth, friendsAcceptHandler);

async function friendsRejectHandler(req, res) {
  const targetUsername = req.body.username || req.query.username;
  if (!targetUsername) return redirectBack(req, res, '/account,favchannels');
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
    res.redirect(`/account,userinfo/?username=${encodeURIComponent(targetUsername)}`);
  } catch (e) {
    console.error('Error in /friends/reject:', e);
    res.status(500).send('Server error');
  }
}

router.post('/friends/reject', requireAuth, friendsRejectHandler);

async function friendsRemoveHandler(req, res) {
  const targetUsername = req.body.username || req.query.username;
  if (!targetUsername) return redirectBack(req, res, '/account,favchannels');
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
    res.redirect(`/account,userinfo/?username=${encodeURIComponent(targetUsername)}`);
  } catch (e) {
    console.error('Error in /friends/remove:', e);
    res.status(500).send('Server error');
  }
}

router.post('/friends/remove', requireAuth, friendsRemoveHandler);

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

    const profileAccess = await hasProfileAccess(req.session.user, profileUser);
    if (!profileAccess) {
      connection.release();
      return res.redirect(`/account,userinfo/?username=${encodeURIComponent(profileUser.username)}`);
    }

    const hasAccess = await hasFriendsListAccess(req.session.user, profileUser);
    if (!hasAccess) {
      const [profileChannelRows] = await connection.query('SELECT * FROM channels WHERE user_id = ? AND is_personal = TRUE LIMIT 1', [profileUser.id]);
      const profileChannel = profileChannelRows.length > 0 ? profileChannelRows[0] : null;

      connection.release();

      const isFriendOfPage = req.path.includes('friendof');
      const viewName = isFriendOfPage ? 'friendof' : 'friends';
      const pageTitle = isFriendOfPage
        ? `В друзьях у пользователей ${profileUser.username} | ЭтоЯTV`
        : `Друзья пользователя ${profileUser.username} | ЭтоЯTV`;

      return res.status(403).render(viewName, {
        pageTitle: pageTitle,
        profileUser: profileUser,
        friends: [],
        profileChannel: profileChannel,
        canSeeFriendsList: false,
        isRestricted: true,
        restrictionMessage: 'Владелец этого профиля ограничил доступ к списку друзей.'
      });
    }

    const isOwner = req.session.user && req.session.user.id === profileUser.id;
    let friendsQuery = `
      SELECT u.*, 
             (u.last_active IS NOT NULL AND UNIX_TIMESTAMP(NOW()) - UNIX_TIMESTAMP(u.last_active) <= 300) as is_online,
             CASE WHEN f.requester_id = ? THEN f.requester_hidden ELSE f.receiver_hidden END as is_hidden_by_owner
      FROM users u
      JOIN friendships f ON (f.requester_id = u.id OR f.receiver_id = u.id)
      WHERE f.status = 'accepted'
        AND u.id != ?
        AND (f.requester_id = ? OR f.receiver_id = ?)
    `;
    const friendsParams = [profileUser.id, profileUser.id, profileUser.id, profileUser.id];
    if (!isOwner) {
      friendsQuery += ' AND f.requester_hidden = 0 AND f.receiver_hidden = 0';
    }
    friendsQuery += ' ORDER BY u.id DESC';

    const [friends] = await connection.query(friendsQuery, friendsParams);

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
      profileChannel: profileChannel,
      canSeeFriendsList: true
    });
  } catch (e) {
    console.error('Error fetching friends:', e);
    res.status(500).send('Server error');
  }
});

async function friendsHideHandler(req, res) {
  const targetUsername = req.body.username || req.query.username;
  if (!targetUsername) return redirectBack(req, res, '/account,favchannels');
  try {
    const connection = await pool.getConnection();
    const [users] = await connection.query('SELECT id FROM users WHERE username = ?', [targetUsername]);
    if (users.length > 0) {
      const targetId = users[0].id;
      const myId = req.session.user.id;
      await connection.query(
        `UPDATE friendships 
         SET requester_hidden = CASE WHEN requester_id = ? THEN 1 ELSE requester_hidden END,
             receiver_hidden = CASE WHEN receiver_id = ? THEN 1 ELSE receiver_hidden END
         WHERE ((requester_id = ? AND receiver_id = ?) OR (requester_id = ? AND receiver_id = ?))
           AND status = 'accepted'`,
        [myId, myId, myId, targetId, targetId, myId]
      );
    }
    connection.release();
    redirectBack(req, res, '/account,favchannels');
  } catch(e) {
    console.error(e);
    res.status(500).send('Database error');
  }
}

router.post('/friends/hide', requireAuth, friendsHideHandler);

async function friendsUnhideHandler(req, res) {
  const targetUsername = req.body.username || req.query.username;
  if (!targetUsername) return redirectBack(req, res, '/account,favchannels');
  try {
    const connection = await pool.getConnection();
    const [users] = await connection.query('SELECT id FROM users WHERE username = ?', [targetUsername]);
    if (users.length > 0) {
      const targetId = users[0].id;
      const myId = req.session.user.id;
      await connection.query(
        `UPDATE friendships 
         SET requester_hidden = CASE WHEN requester_id = ? THEN 0 ELSE requester_hidden END,
             receiver_hidden = CASE WHEN receiver_id = ? THEN 0 ELSE receiver_hidden END
         WHERE ((requester_id = ? AND receiver_id = ?) OR (requester_id = ? AND receiver_id = ?))
           AND status = 'accepted'`,
        [myId, myId, myId, targetId, targetId, myId]
      );
    }
    connection.release();
    redirectBack(req, res, '/account,favchannels');
  } catch(e) {
    console.error(e);
    res.status(500).send('Database error');
  }
}

router.post('/friends/unhide', requireAuth, friendsUnhideHandler);

module.exports = router;
