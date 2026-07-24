const { pool } = require('../../config/db');
const { isIpInBanRecord } = require('../../utils/ipChecker');
const { spawn } = require('child_process');
const { decryptUser } = require('../../utils/chatCrypto');
const { formatChatMessage } = require('../../utils/chatFormatter');
const { canViewChannelContent, isPlatformStaff } = require('../../utils/channelAccess');
const activeStudioStreams = {};
const activeChannelOverlays = {};
const pendingStudioStreamEnds = {};

function createDefaultOverlays() {
  const single = {
    source: 'webcam',
    bumper: { active: false, text1: '', text2: '', color1: '#ffffff', color2: '#ffffff', bgColor1: '#ff0055', bgColor2: '#ffcc00', style: 'double-stripe', activatedAt: 0 },
    intro: { active: false, text1: '', text2: '', color1: '#ffffff', color2: '#ffffff', bgColor1: '#1f1c2c', bgColor2: '#928dab', style: 'gradient-pulse' },
    ticker: { active: false, text: '', color: '#ffffff', bgColor: '#007af5', style: 'standard', speed: 2, offset: 1280 }
  };
  return {
    source: 'webcam',
    bumper: { active: false, text1: '', text2: '', color1: '#ffffff', color2: '#ffffff', bgColor1: '#ff0055', bgColor2: '#ffcc00', style: 'double-stripe', activatedAt: 0 },
    intro: { active: false, text1: '', text2: '', color1: '#ffffff', color2: '#ffffff', bgColor1: '#1f1c2c', bgColor2: '#928dab', style: 'gradient-pulse' },
    ticker: { active: false, text: '', color: '#ffffff', bgColor: '#007af5', style: 'standard', speed: 2, offset: 1280 },
    common: JSON.parse(JSON.stringify(single)),
    1: JSON.parse(JSON.stringify(single)),
    2: JSON.parse(JSON.stringify(single)),
    3: JSON.parse(JSON.stringify(single))
  };
}

function sanitizeNickname(name) {
  if (typeof name !== 'string') return 'Гость';
  let cleaned = name.replace(/<[^>]*>/g, '');
  cleaned = cleaned.replace(/[<>]/g, '');
  cleaned = cleaned.trim().substring(0, 13);
  return cleaned || 'Гость';
}

/** Resolve channel chat role from DB only — never trust client/token role claims. */
async function resolveChannelRole(channelId, userId) {
  if (!userId || !channelId) return 'registered';
  const [chanRows] = await pool.query('SELECT user_id FROM channels WHERE id = ?', [channelId]);
  if (chanRows.length === 0) return 'registered';
  if (Number(chanRows[0].user_id) === Number(userId)) return 'owner';
  const [teamRows] = await pool.query(
    'SELECT is_editor, is_reporter, is_moderator, is_coowner FROM channel_team WHERE channel_id = ? AND user_id = ?',
    [channelId, userId]
  );
  if (teamRows.length === 0) return 'registered';
  const t = teamRows[0];
  if (t.is_coowner) return 'coowner';
  if (t.is_moderator) return 'moderator';
  if (t.is_editor) return 'editor';
  if (t.is_reporter) return 'reporter';
  return 'registered';
}

const STUDIO_ROLES = ['owner', 'coowner', 'editor', 'reporter'];

async function assertStudioAccess(userId, channelId) {
  if (!userId || !channelId) return false;
  const role = await resolveChannelRole(channelId, userId);
  return STUDIO_ROLES.includes(role);
}

function makeColorReadable(hex) {
  if (!hex || typeof hex !== 'string') return '#3b9cd9';
  let cleanHex = hex.replace('#', '');
  if (cleanHex.length === 3) {
    cleanHex = cleanHex[0] + cleanHex[0] + cleanHex[1] + cleanHex[1] + cleanHex[2] + cleanHex[2];
  }
  if (cleanHex.length !== 6) return '#3b9cd9';
  let r = parseInt(cleanHex.substring(0, 2), 16);
  let g = parseInt(cleanHex.substring(2, 4), 16);
  let b = parseInt(cleanHex.substring(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return '#3b9cd9';
  if (r === 0 && g === 0 && b === 0) {
    r = 100; g = 100; b = 100;
  }
  let brightness = 0.299 * r + 0.587 * g + 0.114 * b;
  let iterations = 0;
  while (brightness < 70 && iterations < 15) {
    r = Math.round(r + (255 - r) * 0.2);
    g = Math.round(g + (255 - g) * 0.2);
    b = Math.round(b + (255 - b) * 0.2);
    brightness = 0.299 * r + 0.587 * g + 0.114 * b;
    iterations++;
  }
  const toHex = (c) => {
    const h = c.toString(16);
    return h.length === 1 ? '0' + h : h;
  };
  return '#' + toHex(r) + toHex(g) + toHex(b);
}

module.exports = function(io) {
  const channelUsers = {};

  io.unbanUser = function(channelId, username) {
    if (channelUsers[channelId]) {
      channelUsers[channelId].forEach(u => {
        if (u.username && username && u.username.toLowerCase() === username.toLowerCase()) {
          u.isBanned = false;
          io.to(u.socketId).emit('user_banned_state', { isBanned: false });
        }
      });
      emitUpdateUsers(channelId);
    }
  };

  io.banUser = function(channelId, username, msToAdd) {
    if (channelUsers[channelId]) {
      channelUsers[channelId].forEach(u => {
        if (u.username && username && u.username.toLowerCase() === username.toLowerCase()) {
          u.isBanned = true;
          io.to(u.socketId).emit('user_banned_state', { isBanned: true, banned_until: new Date(Date.now() + msToAdd) });
        }
      });
      emitUpdateUsers(channelId);
    }
  };

  const emitUpdateUsers = (channelId) => {
    if (!channelUsers[channelId]) return 0;
    
    const userGroups = {};
    channelUsers[channelId].forEach(u => {
       let key = '';
       if (u.dbUserId) {
           key = 'user_' + u.dbUserId;
       } else if (u.username === 'Гость') {
           key = 'guest_ip_' + u.ip;
       } else {
           key = 'guest_name_' + u.username;
       }
       
       if (!userGroups[key]) {
           userGroups[key] = {
               ...u,
               streamIndexes: []
           };
       }
       const currentIdx = u.streamIndex || 1;
       if (!userGroups[key].streamIndexes.includes(currentIdx)) {
           userGroups[key].streamIndexes.push(currentIdx);
       }
    });

    const uniqueUsersList = Object.values(userGroups);
    uniqueUsersList.forEach(u => {
        u.streamIndex = u.streamIndexes[0] || 1;
    });
    
    io.to(`channel_${channelId}`).emit('update_users', {
      count: uniqueUsersList.length,
      users: uniqueUsersList
    });
    return uniqueUsersList.length;
  };

  const checkIpBan = async (socket) => {
    let ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    if (ip && typeof ip === 'string' && ip.includes(',')) {
      ip = ip.split(',')[0].trim();
    }
    try {
      const [ipBans] = await pool.query("SELECT ip_address, ban_type FROM ip_bans WHERE ban_type IN ('account', 'all', 'full')");
      return ipBans.some(b => isIpInBanRecord(ip, b.ip_address));
    } catch (e) {
      console.error('IP ban check error in chat:', e);
      return false;
    }
  };

  io.on('connection', (socket) => {
    let currentChannel = null;
    let currentUser = null;
    const hasRole = (allowed) => currentUser && (allowed.includes(currentUser.role) || (currentUser.staffRole && allowed.includes(currentUser.staffRole)));

    socket.on('join_channel', async (data) => {
      const { channelId, guestName, color, userToken } = data;
      currentChannel = channelId;

      let role = 'guest';
      let username = 'Гость';
      let dbUserId = null;
      let isBanned = false;
      let decryptedUser = null;
      let verifiedStudio = false;

      if (userToken) {
        decryptedUser = decryptUser(userToken);
      }

      const ipBanned = await checkIpBan(socket);
      if (ipBanned) {
        isBanned = true;
        socket.emit('user_banned_state', { isBanned: true });
      } else if (decryptedUser && decryptedUser.id) {
        // Trust only user id from token; username/role come from DB.
        dbUserId = Number(decryptedUser.id);
        role = 'registered';
        try {
          const [userRows] = await pool.query('SELECT username, chat_color FROM users WHERE id = ? AND deleted_at IS NULL', [dbUserId]);
          if (userRows.length === 0) {
            decryptedUser = null;
            dbUserId = null;
            role = 'guest';
          } else {
            username = userRows[0].username;
            role = await resolveChannelRole(channelId, dbUserId);
            verifiedStudio = STUDIO_ROLES.includes(role);

            const [bans] = await pool.query('SELECT * FROM channel_bans WHERE channel_id = ? AND user_id = ? AND banned_until > NOW()', [channelId, dbUserId]);
            if (bans.length > 0) {
              isBanned = true;
              socket.emit('user_banned_state', { isBanned: true, banned_until: bans[0].banned_until });
            } else {
              socket.emit('user_banned_state', { isBanned: false });
            }
          }
        } catch (e) { console.error(e); }
      } else {
         // Guest path: check username collision with registered users
         let proposedName = sanitizeNickname(guestName || 'Гость');
         if (proposedName.toLowerCase() !== 'гость') {
            try {
               const [existingUsers] = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER(?)', [proposedName]);
               if (existingUsers.length > 0) {
                  proposedName = 'Гость_' + Math.floor(Math.random() * 10000);
                  socket.emit('guest_name_changed', { name: proposedName });
               }
            } catch(e) {
               console.error('Error checking guest username collision:', e);
            }
         }
         username = proposedName;
         try {
           const [bans] = await pool.query('SELECT * FROM channel_bans WHERE channel_id = ? AND username = ? AND banned_until > NOW()', [channelId, username]);
           if (bans.length > 0) {
             isBanned = true;
             socket.emit('user_banned_state', { isBanned: true, banned_until: bans[0].banned_until });
           } else {
             socket.emit('user_banned_state', { isBanned: false });
           }
         } catch (e) {}
      }

      // Gate password/private channels before joining the room
      try {
        const [chanAccess] = await pool.query('SELECT id, access_level, user_id FROM channels WHERE id = ?', [channelId]);
        if (chanAccess.length > 0) {
          const ch = chanAccess[0];
          const level = ch.access_level || 'public';
          if (level === 'password' || level === 'private') {
            const teamRoles = ['owner', 'coowner', 'editor', 'reporter', 'moderator'];
            const isTeamOrOwner = teamRoles.includes(role);
            const sockReq = socket.request || {};
            const sessionUser = sockReq.session && sockReq.session.user;
            const staffOk = isPlatformStaff(sessionUser);
            const unlockedOk = sockReq.session && canViewChannelContent(sockReq, ch);
            if (!isTeamOrOwner && !staffOk && !unlockedOk) {
              socket.emit('error', { message: 'Channel is locked' });
              currentChannel = null;
              return;
            }
          }
        }
      } catch (e) {
        console.error('join_channel access check error:', e);
      }

      socket.join(`channel_${channelId}`);

      // Studio flag is only honored after DB-verified channel studio access.
      if (data && data.isStudio && verifiedStudio) {
         socket.studioChannelId = channelId;
         if (pendingStudioStreamEnds[channelId]) {
            clearTimeout(pendingStudioStreamEnds[channelId]);
            delete pendingStudioStreamEnds[channelId];
            console.log(`[STUDIO] Owner reconnected within grace period for channel ${channelId}. Restoring stream.`);
         }
      }

      currentUser = {
        socketId: socket.id,
        username,
        role,
        isBanned,
        color: makeColorReadable(color || (decryptedUser && decryptedUser.chat_color)),
        dbUserId,
        ip: (() => {
          let ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
          if (ip && typeof ip === 'string' && ip.includes(',')) {
            ip = ip.split(',')[0].trim();
          }
          return ip;
        })(),
        isInvisible: (decryptedUser && decryptedUser.mask_mode === 'invisible') || (data && data.isStudio && verifiedStudio),
        streamIndex: (data && (Number(data.streamIndex) === 1 || Number(data.streamIndex) === 2 || Number(data.streamIndex) === 3)) ? Number(data.streamIndex) : 1
      };

      if (dbUserId) {
        try {
          const [staffRows] = await pool.query('SELECT role, mask_mode FROM staff WHERE user_id = ?', [dbUserId]);
          if (staffRows.length > 0) {
            currentUser.staffRole = staffRows[0].role;
            const maskMode = staffRows[0].mask_mode || 'disabled';
            // Platform staff show the admin mask (alien) in chat user list —
            // unless they explicitly mask as a normal user. Keep channel owner crown.
            if (
              maskMode !== 'user_mask' &&
              ['admin', 'moderator', 'mod'].includes(staffRows[0].role) &&
              currentUser.role !== 'owner'
            ) {
              currentUser.role = 'alien';
            }
          }
        } catch (e) {
          console.error('Error fetching staff role for chat connection:', e);
        }
      }

      if (!channelUsers[channelId]) channelUsers[channelId] = [];
      
      // Remove any existing socket for this connection to prevent duplication
      channelUsers[channelId] = channelUsers[channelId].filter(u => u.socketId !== socket.id);
      
      if (!currentUser.isInvisible) {
        channelUsers[channelId].push(currentUser);
      }

      const count = emitUpdateUsers(channelId);
      
      try {
        await pool.query('UPDATE channels SET viewers = ? WHERE id = ?', [count, channelId]);
      } catch(e) {}

      if (!activeChannelOverlays[channelId]) {
        activeChannelOverlays[channelId] = createDefaultOverlays();
      }
      socket.emit('player_update_overlays', activeChannelOverlays[channelId]);
    });

    socket.on('change_stream', (data) => {
      if (!currentChannel || !currentUser) return;
      const streamIndex = Number(data && data.streamIndex);
      currentUser.streamIndex = (streamIndex === 1 || streamIndex === 2 || streamIndex === 3) ? streamIndex : 1;
      emitUpdateUsers(currentChannel);
    });

    socket.on('send_message', async (data) => {
      if (!currentChannel || !currentUser) return;
      const { message, color, streamIndex } = data;
      if (!message || message.trim() === '') return;
      if (message.length > 400) return;
      
      const ipBanned = await checkIpBan(socket);
      if (ipBanned) {
        currentUser.isBanned = true;
        socket.emit('user_banned_state', { isBanned: true });
        return;
      }
      if (currentUser.isBanned) return;

      let validStreamIndex = null;
      if (streamIndex === 1 || streamIndex === 2 || streamIndex === 3) {
        validStreamIndex = streamIndex;
      }

      try {
        const [channels] = await pool.query('SELECT chat_enabled, guests_allowed FROM channels WHERE id = ?', [currentChannel]);
        if (channels.length > 0) {
          if (!channels[0].chat_enabled) return;
          if (!channels[0].guests_allowed && currentUser.role === 'guest') return;
        }
        
        const readableColor = makeColorReadable(color || currentUser.color);
        const formattedMsg = formatChatMessage(message.trim());
        const [result] = await pool.query(
          'INSERT INTO chat_messages (channel_id, user_id, guest_name, message, role, color, stream_index) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [currentChannel, currentUser.dbUserId, currentUser.role === 'guest' ? currentUser.username : null, formattedMsg, currentUser.role, readableColor, validStreamIndex]
        );

        io.to(`channel_${currentChannel}`).emit('new_message', {
          id: result.insertId,
          username: currentUser.username,
          guest_name: currentUser.role === 'guest' ? currentUser.username : null,
          message: formattedMsg,
          role: currentUser.role,
          color: readableColor,
          stream_index: validStreamIndex
        });
      } catch(e) { console.error(e); }
    });

    socket.on('update_chat_color', async (data) => {
      if (currentUser) {
         const readableColor = makeColorReadable(data.color);
         currentUser.color = readableColor;

         // Persist to database for registered users
         if (currentUser.dbUserId) {
           try {
             await pool.query('UPDATE users SET chat_color = ? WHERE id = ?', [readableColor, currentUser.dbUserId]);
           } catch(e) {
             console.error('Error updating user chat color in DB:', e);
           }
         }

         // Update all active connections for the same user in the current channel
         if (currentChannel && channelUsers[currentChannel]) {
            channelUsers[currentChannel].forEach(u => {
              if (u.dbUserId && String(u.dbUserId) === String(currentUser.dbUserId)) {
                 u.color = readableColor;
              } else if (!u.dbUserId && u.username === currentUser.username) {
                 u.color = readableColor;
              }
            });
            emitUpdateUsers(currentChannel);
         }
      }
    });

    socket.on('change_guest_name', async (data) => {
      if (currentUser && currentUser.role === 'guest') {
         const ipBanned = await checkIpBan(socket);
         if (ipBanned) {
           currentUser.isBanned = true;
           socket.emit('user_banned_state', { isBanned: true });
           return;
         }
         
         const proposedName = sanitizeNickname(data.newName || 'Гость');
         if (proposedName.toLowerCase() === 'гость') {
            currentUser.username = 'Гость';
         } else {
            try {
               const [existingUsers] = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER(?)', [proposedName]);
               if (existingUsers.length > 0) {
                  socket.emit('guest_name_error', { error: 'Этот никнейм занят зарегистрированным пользователем' });
                  return;
               }
               currentUser.username = proposedName;
            } catch(e) {
               console.error('Error checking guest name change collision:', e);
               return;
            }
         }
         
         try {
           const [bans] = await pool.query('SELECT * FROM channel_bans WHERE channel_id = ? AND username = ? AND banned_until > NOW()', [currentChannel, currentUser.username]);
           if (bans.length > 0) {
             currentUser.isBanned = true;
             socket.emit('user_banned_state', { isBanned: true, banned_until: bans[0].banned_until });
           } else {
             currentUser.isBanned = false;
             socket.emit('user_banned_state', { isBanned: false });
           }
         } catch(e) {}
         
         socket.emit('guest_name_changed', { name: currentUser.username });
         if (currentChannel && channelUsers[currentChannel]) {
            emitUpdateUsers(currentChannel);
         }
      }
    });

    socket.on('clear_chat', async () => {
      if (!currentChannel || !currentUser) return;
      if (hasRole(['owner', 'coowner', 'admin', 'mod', 'moderator', 'alien'])) {
        try {
          await pool.query('DELETE FROM chat_messages WHERE channel_id = ?', [currentChannel]);
          await pool.query('UPDATE channels SET pinned_message_id = NULL, pinned_message_id_1 = NULL, pinned_message_id_2 = NULL, pinned_message_id_3 = NULL WHERE id = ?', [currentChannel]);
          io.to(`channel_${currentChannel}`).emit('chat_cleared');
          io.to(`channel_${currentChannel}`).emit('message_unpinned', { streamIndex: 'all' });
        } catch(e) {}
      }
    });

    socket.on('pin_message', async (data) => {
      if (!currentChannel || !currentUser) return;
      const isAllowed = hasRole(['owner', 'admin', 'mod', 'moderator', 'alien', 'editor']);
      if (!isAllowed) return;

      try {
        const { messageId } = data;
        if (!messageId) return;

        let streamIndex = data.streamIndex;
        if (streamIndex === 'common') streamIndex = null;

        let columnName = 'pinned_message_id';
        if (streamIndex == 1) columnName = 'pinned_message_id_1';
        else if (streamIndex == 2) columnName = 'pinned_message_id_2';
        else if (streamIndex == 3) columnName = 'pinned_message_id_3';

        // Verify the message exists and belongs to the current channel
        const [messages] = await pool.query('SELECT * FROM chat_messages WHERE id = ? AND channel_id = ?', [messageId, currentChannel]);
        if (messages.length === 0) return;

        await pool.query(`UPDATE channels SET ${columnName} = ? WHERE id = ?`, [messageId, currentChannel]);

        // Get details of the message
        const [msgDetails] = await pool.query(`
          SELECT m.id, m.message, m.guest_name, u.username, m.role, m.color
          FROM chat_messages m
          LEFT JOIN users u ON m.user_id = u.id
          WHERE m.id = ?
        `, [messageId]);

        if (msgDetails.length > 0) {
          const msg = msgDetails[0];
          io.to(`channel_${currentChannel}`).emit('message_pinned', {
            id: msg.id,
            message: msg.message,
            role: msg.role,
            color: msg.color,
            username: msg.username || msg.guest_name,
            streamIndex: (streamIndex == 1 || streamIndex == 2 || streamIndex == 3) ? String(streamIndex) : 'common'
          });
        }
      } catch (e) {
        console.error('Error pinning message:', e);
      }
    });

    socket.on('unpin_message', async (data) => {
      if (!currentChannel || !currentUser) return;
      const isAllowed = hasRole(['owner', 'admin', 'mod', 'moderator', 'alien', 'editor']);
      if (!isAllowed) return;

      try {
        let streamIndex = data && data.streamIndex;
        if (streamIndex === 'common') streamIndex = null;

        let columnName = 'pinned_message_id';
        if (streamIndex == 1) columnName = 'pinned_message_id_1';
        else if (streamIndex == 2) columnName = 'pinned_message_id_2';
        else if (streamIndex == 3) columnName = 'pinned_message_id_3';

        await pool.query(`UPDATE channels SET ${columnName} = NULL WHERE id = ?`, [currentChannel]);
        io.to(`channel_${currentChannel}`).emit('message_unpinned', {
          streamIndex: (streamIndex == 1 || streamIndex == 2 || streamIndex == 3) ? String(streamIndex) : 'common'
        });
      } catch (e) {
        console.error('Error unpinning message:', e);
      }
    });

    socket.on('delete_message', async (data) => {
      if (!currentChannel || !currentUser) return;
      const isAllowed = hasRole(['owner', 'coowner', 'admin', 'mod', 'moderator', 'alien', 'editor']);
      if (!isAllowed) return;

      try {
        const { messageId } = data;
        if (!messageId) return;

        // Verify the message exists and belongs to the current channel
        const [messages] = await pool.query('SELECT id FROM chat_messages WHERE id = ? AND channel_id = ?', [messageId, currentChannel]);
        if (messages.length === 0) return;

        // Delete from database
        await pool.query('DELETE FROM chat_messages WHERE id = ?', [messageId]);

        // If this message was pinned, unpin it
        const [updateResult] = await pool.query('UPDATE channels SET pinned_message_id = NULL WHERE id = ? AND pinned_message_id = ?', [currentChannel, messageId]);
        if (updateResult.affectedRows > 0) {
          io.to(`channel_${currentChannel}`).emit('message_unpinned');
        }

        // Notify room
        io.to(`channel_${currentChannel}`).emit('message_deleted', { messageId });
      } catch (e) {
        console.error('Error deleting message:', e);
      }
    });

    socket.on('toggle_guests', async (data) => {
      if (!currentChannel || !currentUser) return;
      if (hasRole(['owner', 'coowner', 'admin', 'mod', 'moderator', 'alien'])) {
        try {
          await pool.query('UPDATE channels SET guests_allowed = ? WHERE id = ?', [data.allowed ? 1 : 0, currentChannel]);
          io.to(`channel_${currentChannel}`).emit('guests_toggled', data.allowed);
        } catch(e) {}
      }
    });

    socket.on('toggle_chat', async (data) => {
      if (!currentChannel || !currentUser) return;
      if (hasRole(['owner', 'coowner', 'admin', 'mod', 'moderator', 'alien'])) {
        try {
          const [ch] = await pool.query('SELECT chat_disabled FROM channels WHERE id = ?', [currentChannel]);
          if (ch.length > 0 && ch[0].chat_disabled) return;
          await pool.query('UPDATE channels SET chat_enabled = ? WHERE id = ?', [data.enabled ? 1 : 0, currentChannel]);
          io.to(`channel_${currentChannel}`).emit('chat_toggled', data.enabled);
        } catch(e) {}
      }
    });

    socket.on('ban_user', async (data) => {
       if (!currentChannel || !currentUser) return;
       if (hasRole(['owner', 'coowner', 'admin', 'mod', 'moderator', 'alien'])) {
         try {
           const targetUsername = data.targetUsername;
           const durationStr = data.duration || '60';
           let queryInterval = 'INTERVAL 1 HOUR';
           let msToAdd = 3600000;
           
           if (durationStr === '10') {
              queryInterval = 'INTERVAL 10 MINUTE';
              msToAdd = 10 * 60000;
           } else if (durationStr === '60') {
              queryInterval = 'INTERVAL 1 HOUR';
              msToAdd = 60 * 60000;
           } else if (durationStr === '1440') {
              queryInterval = 'INTERVAL 1 DAY';
              msToAdd = 1440 * 60000;
           } else if (durationStr === 'perm') {
              queryInterval = 'INTERVAL 100 YEAR';
              msToAdd = 100 * 365 * 24 * 60 * 60000;
           }

           let targetUserDbId = null;
           const [users] = await pool.query('SELECT id FROM users WHERE username = ?', [targetUsername]);
           if (users.length > 0) {
              targetUserDbId = users[0].id;
           }

           await pool.query('DELETE FROM channel_bans WHERE channel_id = ? AND username = ?', [currentChannel, targetUsername]);
           await pool.query(`INSERT INTO channel_bans (channel_id, user_id, username, banned_until) VALUES (?, ?, ?, DATE_ADD(NOW(), ${queryInterval}))`, [currentChannel, targetUserDbId, targetUsername]);
           
           io.banUser(currentChannel, targetUsername, msToAdd);
         } catch(e) { console.error(e); }
       }
    });

    socket.on('unban_user', async (data) => {
       if (!currentChannel || !currentUser) return;
       if (hasRole(['owner', 'coowner', 'admin', 'mod', 'moderator', 'alien'])) {
         try {
           const targetUsername = data.targetUsername;
           await pool.query('DELETE FROM channel_bans WHERE channel_id = ? AND username = ?', [currentChannel, targetUsername]);
           io.unbanUser(currentChannel, targetUsername);
         } catch(e) {}
       }
    });

    // Legacy MediaRecorder→ffmpeg path removed. Studio publishes via WHIP/WebRTC.

    socket.on('studio_client_error', (data) => {
      const { channelId, error } = data;
      console.error(`[STUDIO_CLIENT_ERROR] Channel ${channelId}:`, error);
    });

     socket.on('studio_client_log', (data) => {
       const { channelId, level, message } = data;
       console.log(`[STUDIO_CLIENT_${(level || 'info').toUpperCase()}] Channel ${channelId}: ${message}`);
     });

    socket.on('studio_stop_stream', async (data) => {
      const { channelId } = data;
      if (!currentUser || !currentUser.dbUserId) {
        console.warn('[STUDIO] Rejecting stop_stream: unauthenticated');
        return;
      }
      if (!(await assertStudioAccess(currentUser.dbUserId, channelId))) {
        console.warn('[STUDIO] Rejecting stop_stream: no channel access');
        return;
      }
      
      // Cancel any pending grace period teardown and request immediate end
      global.immediateStreamEnds = global.immediateStreamEnds || {};
      global.immediateStreamEnds[channelId] = true;
      if (global.pendingStreamEnds && global.pendingStreamEnds[channelId]) {
         clearTimeout(global.pendingStreamEnds[channelId]);
         delete global.pendingStreamEnds[channelId];
      }
      try {
         await pool.query('UPDATE channels SET is_live = 0, current_streamer_id = NULL WHERE id = ?', [channelId]);
         io.to(`channel_${channelId}`).emit('stream_ended');
         console.log(`[STUDIO] Set immediate offline state for channel ${channelId}`);
      } catch (err) {
         console.error('[STUDIO] Error setting immediate offline state:', err);
      }

      const ffmpeg = activeStudioStreams[channelId];
      if (ffmpeg) {
         console.log(`[STUDIO] Stopping stream for channel ${channelId}`);
         try { ffmpeg.stdin.end(); } catch(e) {}
         setTimeout(() => {
            if (activeStudioStreams[channelId] === ffmpeg) {
                try { ffmpeg.kill('SIGKILL'); } catch(e) {}
                delete activeStudioStreams[channelId];
            }
         }, 1500);
      }

      // Also try to kick the active stream from MediaMTX if it is running
      try {
         const [chRows] = await pool.query('SELECT shortname FROM channels WHERE id = ?', [channelId]);
         if (chRows.length > 0) {
            const shortname = chRows[0].shortname;
            const { kickStream } = require('../../utils/mediaServer');
            await kickStream(shortname);
         }
      } catch (e) {
         console.error('[STUDIO] Error kicking RTMP stream on stop_stream:', e.message);
      }

      // Reset active overlays to off/default state when streaming stops
      const defaultOverlays = createDefaultOverlays();
      activeChannelOverlays[channelId] = defaultOverlays;
      io.to(`channel_${channelId}`).emit('player_update_overlays', defaultOverlays);
    });

    socket.on('studio_update_overlays', async (payload) => {
      let chId = currentChannel;
      let overlaysData = payload;

      if (payload && payload.channelId && payload.overlays) {
        chId = payload.channelId;
        overlaysData = payload.overlays;
      }

      console.log(`[STUDIO_SOCKET] studio_update_overlays event received for channel ${chId}`);
      if (!chId) {
        console.warn(`[STUDIO_SOCKET] Missing channel ID for socket ${socket.id}`);
        return;
      }
      if (!currentUser || !currentUser.dbUserId) {
        console.warn(`[STUDIO_SOCKET] Missing authenticated user for socket ${socket.id}`);
        return;
      }
      if (!(await assertStudioAccess(currentUser.dbUserId, chId))) {
        console.warn(`[STUDIO_SOCKET] Rejecting overlays update: no studio access for user ${currentUser.dbUserId} on channel ${chId}`);
        return;
      }
      currentChannel = chId;
      activeChannelOverlays[chId] = overlaysData;
      console.log(`[STUDIO_SOCKET] Broadcasting player_update_overlays to room channel_${chId}`);
      io.to(`channel_${chId}`).emit('player_update_overlays', overlaysData);
    });

    socket.on('disconnect', async () => {
      if (socket.studioChannelId) {
          const chId = socket.studioChannelId;
          const ffmpeg = activeStudioStreams[chId];
          if (ffmpeg) {
             console.log(`[STUDIO] Owner disconnected, stopping stream for channel ${chId}`);
             try {
                ffmpeg.stdin.end();
                ffmpeg.kill('SIGKILL');
             } catch(e) {}
             delete activeStudioStreams[chId];
          }

          // Clear overlays on owner disconnect (stream closed)
          const defaultOverlays = createDefaultOverlays();
          activeChannelOverlays[chId] = defaultOverlays;
          io.to(`channel_${chId}`).emit('player_update_overlays', defaultOverlays);
      }

      if (currentChannel && currentUser) {
        if (channelUsers[currentChannel]) {
          channelUsers[currentChannel] = channelUsers[currentChannel].filter(u => u.socketId !== socket.id);
          const count = emitUpdateUsers(currentChannel);
          try {
            await pool.query('UPDATE channels SET viewers = ? WHERE id = ?', [count, currentChannel]);
          } catch(e) {}
        }
      }
    });
  });
};
