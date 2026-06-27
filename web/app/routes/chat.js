const { pool } = require('../../config/db');
const { isIpInBanRecord } = require('../../utils/ipChecker');

function sanitizeNickname(name) {
  if (typeof name !== 'string') return 'Гость';
  let cleaned = name.replace(/<[^>]*>/g, '');
  cleaned = cleaned.replace(/[<>]/g, '');
  cleaned = cleaned.trim().substring(0, 13);
  return cleaned || 'Гость';
}

module.exports = function(io) {
  const channelUsers = {};

  const emitUpdateUsers = (channelId) => {
    if (!channelUsers[channelId]) return 0;
    const uniqueUsersList = [];
    const uniqueKeys = new Set();
    channelUsers[channelId].forEach(u => {
       let key = '';
       if (u.dbUserId) {
           key = 'user_' + u.dbUserId;
       } else if (u.username === 'Гость') {
           key = 'guest_ip_' + u.ip;
       } else {
           key = 'guest_name_' + u.username;
       }
       if (!uniqueKeys.has(key)) {
           uniqueKeys.add(key);
           uniqueUsersList.push(u);
       }
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

    socket.on('join_channel', async (data) => {
      const { channelId, user, guestName, color } = data;
      currentChannel = channelId;
      socket.join(`channel_${channelId}`);
      
      let role = 'guest';
      let username = sanitizeNickname(guestName || 'Гость');
      let dbUserId = null;
      let isBanned = false;

      const ipBanned = await checkIpBan(socket);
      if (ipBanned) {
        isBanned = true;
        socket.emit('user_banned_state', { isBanned: true });
      } else if (user) {
        role = user.role || 'registered';
        username = user.username;
        dbUserId = user.id;
        try {
          const [bans] = await pool.query('SELECT * FROM channel_bans WHERE channel_id = ? AND user_id = ? AND banned_until > NOW()', [channelId, dbUserId]);
          if (bans.length > 0) {
            isBanned = true;
            socket.emit('user_banned_state', { isBanned: true, banned_until: bans[0].banned_until });
          } else {
            socket.emit('user_banned_state', { isBanned: false });
          }
        } catch (e) { console.error(e); }
      } else {
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

      currentUser = {
        socketId: socket.id,
        username,
        role,
        isBanned,
        color,
        dbUserId,
        ip: (() => {
          let ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
          if (ip && typeof ip === 'string' && ip.includes(',')) {
            ip = ip.split(',')[0].trim();
          }
          return ip;
        })(),
        isInvisible: user && user.mask_mode === 'invisible'
      };

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
    });

    socket.on('send_message', async (data) => {
      if (!currentChannel || !currentUser) return;
      const { message, color } = data;
      if (!message || message.trim() === '') return;
      if (message.length > 400) return;
      
      const ipBanned = await checkIpBan(socket);
      if (ipBanned) {
        currentUser.isBanned = true;
        socket.emit('user_banned_state', { isBanned: true });
        return;
      }
      if (currentUser.isBanned) return;

      try {
        const [channels] = await pool.query('SELECT chat_enabled, guests_allowed FROM channels WHERE id = ?', [currentChannel]);
        if (channels.length > 0) {
          if (!channels[0].chat_enabled) return;
          if (!channels[0].guests_allowed && currentUser.role === 'guest') return;
        }
        
        const [result] = await pool.query(
          'INSERT INTO chat_messages (channel_id, user_id, guest_name, message, role, color) VALUES (?, ?, ?, ?, ?, ?)',
          [currentChannel, currentUser.dbUserId, currentUser.role === 'guest' ? currentUser.username : null, message.trim(), currentUser.role, color]
        );

        io.to(`channel_${currentChannel}`).emit('new_message', {
          id: result.insertId,
          username: currentUser.username,
          message: message.trim(),
          role: currentUser.role,
          color: color
        });
      } catch(e) { console.error(e); }
    });

    socket.on('update_chat_color', async (data) => {
      if (currentUser) {
         currentUser.color = data.color;

         // Persist to database for registered users
         if (currentUser.dbUserId) {
           try {
             await pool.query('UPDATE users SET chat_color = ? WHERE id = ?', [data.color, currentUser.dbUserId]);
           } catch(e) {
             console.error('Error updating user chat color in DB:', e);
           }
         }

         // Update all active connections for the same user in the current channel
         if (currentChannel && channelUsers[currentChannel]) {
            channelUsers[currentChannel].forEach(u => {
              if (u.dbUserId && u.dbUserId === currentUser.dbUserId) {
                 u.color = data.color;
              } else if (!u.dbUserId && u.username === currentUser.username) {
                 u.color = data.color;
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
         currentUser.username = sanitizeNickname(data.newName || 'Гость');
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
      if (currentUser.role === 'owner' || currentUser.role === 'admin' || currentUser.role === 'mod' || currentUser.role === 'moderator' || currentUser.role === 'alien') {
        try {
          await pool.query('DELETE FROM chat_messages WHERE channel_id = ?', [currentChannel]);
          await pool.query('UPDATE channels SET pinned_message_id = NULL WHERE id = ?', [currentChannel]);
          io.to(`channel_${currentChannel}`).emit('chat_cleared');
          io.to(`channel_${currentChannel}`).emit('message_unpinned');
        } catch(e) {}
      }
    });

    socket.on('pin_message', async (data) => {
      if (!currentChannel || !currentUser) return;
      const role = currentUser.role;
      const isAllowed = ['owner', 'admin', 'mod', 'moderator', 'alien', 'editor'].includes(role);
      if (!isAllowed) return;

      try {
        const { messageId } = data;
        if (!messageId) return;

        // Verify the message exists and belongs to the current channel
        const [messages] = await pool.query('SELECT * FROM chat_messages WHERE id = ? AND channel_id = ?', [messageId, currentChannel]);
        if (messages.length === 0) return;

        await pool.query('UPDATE channels SET pinned_message_id = ? WHERE id = ?', [messageId, currentChannel]);

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
            username: msg.username || msg.guest_name
          });
        }
      } catch (e) {
        console.error('Error pinning message:', e);
      }
    });

    socket.on('unpin_message', async () => {
      if (!currentChannel || !currentUser) return;
      const role = currentUser.role;
      const isAllowed = ['owner', 'admin', 'mod', 'moderator', 'alien', 'editor'].includes(role);
      if (!isAllowed) return;

      try {
        await pool.query('UPDATE channels SET pinned_message_id = NULL WHERE id = ?', [currentChannel]);
        io.to(`channel_${currentChannel}`).emit('message_unpinned');
      } catch (e) {
        console.error('Error unpinning message:', e);
      }
    });

    socket.on('toggle_guests', async (data) => {
      if (!currentChannel || !currentUser) return;
      if (currentUser.role === 'owner' || currentUser.role === 'admin' || currentUser.role === 'mod' || currentUser.role === 'moderator' || currentUser.role === 'alien') {
        try {
          await pool.query('UPDATE channels SET guests_allowed = ? WHERE id = ?', [data.allowed ? 1 : 0, currentChannel]);
          io.to(`channel_${currentChannel}`).emit('guests_toggled', data.allowed);
        } catch(e) {}
      }
    });

    socket.on('toggle_chat', async (data) => {
      if (!currentChannel || !currentUser) return;
      if (currentUser.role === 'owner' || currentUser.role === 'admin' || currentUser.role === 'mod' || currentUser.role === 'moderator' || currentUser.role === 'alien') {
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
       if (currentUser.role === 'owner' || currentUser.role === 'admin' || currentUser.role === 'mod' || currentUser.role === 'moderator' || currentUser.role === 'alien') {
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
           if (channelUsers[currentChannel]) {
              const target = channelUsers[currentChannel].find(u => u.username === targetUsername);
              if (target) {
                 targetUserDbId = target.dbUserId;
                 target.isBanned = true;
                 io.to(target.socketId).emit('user_banned_state', { isBanned: true, banned_until: new Date(Date.now() + msToAdd) });
              }
           }
           await pool.query(`INSERT INTO channel_bans (channel_id, user_id, username, banned_until) VALUES (?, ?, ?, DATE_ADD(NOW(), ${queryInterval}))`, [currentChannel, targetUserDbId, targetUsername]);
           if (channelUsers[currentChannel]) {
              emitUpdateUsers(currentChannel);
           }
         } catch(e) { console.error(e); }
       }
    });

    socket.on('unban_user', async (data) => {
       if (!currentChannel || !currentUser) return;
       if (currentUser.role === 'owner' || currentUser.role === 'admin' || currentUser.role === 'mod' || currentUser.role === 'moderator' || currentUser.role === 'alien') {
         try {
           const targetUsername = data.targetUsername;
           await pool.query('DELETE FROM channel_bans WHERE channel_id = ? AND username = ?', [currentChannel, targetUsername]);
           if (channelUsers[currentChannel]) {
              const target = channelUsers[currentChannel].find(u => u.username === targetUsername);
              if (target) {
                 target.isBanned = false;
                 io.to(target.socketId).emit('user_banned_state', { isBanned: false });
              }
              emitUpdateUsers(currentChannel);
           }
         } catch(e) {}
       }
    });

    socket.on('disconnect', async () => {
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
