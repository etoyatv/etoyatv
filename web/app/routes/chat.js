const { pool } = require('../../config/db');
const { isIpInBanRecord } = require('../../utils/ipChecker');
const { spawn } = require('child_process');
const { decryptUser } = require('../../utils/chatCrypto');
const activeStudioStreams = {};
const activeChannelOverlays = {};
const pendingStudioStreamEnds = {};

function sanitizeNickname(name) {
  if (typeof name !== 'string') return 'Гость';
  let cleaned = name.replace(/<[^>]*>/g, '');
  cleaned = cleaned.replace(/[<>]/g, '');
  cleaned = cleaned.trim().substring(0, 13);
  return cleaned || 'Гость';
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
      const { channelId, guestName, color, userToken } = data;
      currentChannel = channelId;
      socket.join(`channel_${channelId}`);
      
      if (data && data.isStudio) {
         socket.studioChannelId = channelId;
         if (pendingStudioStreamEnds[channelId]) {
            clearTimeout(pendingStudioStreamEnds[channelId]);
            delete pendingStudioStreamEnds[channelId];
            console.log(`[STUDIO] Owner reconnected within grace period for channel ${channelId}. Restoring stream.`);
         }
      }
      
      let role = 'guest';
      let username = 'Гость';
      let dbUserId = null;
      let isBanned = false;
      let decryptedUser = null;

      if (userToken) {
        decryptedUser = decryptUser(userToken);
      }

      const ipBanned = await checkIpBan(socket);
      if (ipBanned) {
        isBanned = true;
        socket.emit('user_banned_state', { isBanned: true });
      } else if (decryptedUser) {
        role = decryptedUser.role || 'registered';
        username = decryptedUser.username;
        dbUserId = decryptedUser.id;
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

      currentUser = {
        socketId: socket.id,
        username,
        role,
        isBanned,
        color: makeColorReadable(color),
        dbUserId,
        ip: (() => {
          let ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
          if (ip && typeof ip === 'string' && ip.includes(',')) {
            ip = ip.split(',')[0].trim();
          }
          return ip;
        })(),
        isInvisible: (decryptedUser && decryptedUser.mask_mode === 'invisible') || (data && data.isStudio)
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

      if (activeChannelOverlays[channelId]) {
        socket.emit('player_update_overlays', activeChannelOverlays[channelId]);
      }
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
        
        const readableColor = makeColorReadable(color || currentUser.color);
        const [result] = await pool.query(
          'INSERT INTO chat_messages (channel_id, user_id, guest_name, message, role, color) VALUES (?, ?, ?, ?, ?, ?)',
          [currentChannel, currentUser.dbUserId, currentUser.role === 'guest' ? currentUser.username : null, message.trim(), currentUser.role, readableColor]
        );

        io.to(`channel_${currentChannel}`).emit('new_message', {
          id: result.insertId,
          username: currentUser.username,
          message: message.trim(),
          role: currentUser.role,
          color: readableColor
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

    // --- Broadcast Studio events ---
    socket.on('studio_start_stream', async (data) => {
      const { channelId, streamKey } = data;
      if (!currentUser || !['owner', 'editor', 'reporter'].includes(currentUser.role)) {
         console.error('[STUDIO] Unauthorized stream start request');
         return;
      }
      try {
         const [chRows] = await pool.query('SELECT shortname FROM channels WHERE id = ?', [channelId]);
         if (chRows.length === 0) return;
         const shortname = chRows[0].shortname;

         if (activeStudioStreams[channelId]) {
            try {
               activeStudioStreams[channelId].stdin.end();
               activeStudioStreams[channelId].kill('SIGKILL');
            } catch(e) {}
            delete activeStudioStreams[channelId];
         }
         if (pendingStudioStreamEnds[channelId]) {
            clearTimeout(pendingStudioStreamEnds[channelId]);
            delete pendingStudioStreamEnds[channelId];
         }

         console.log(`[STUDIO] Starting FFmpeg push to RTMP for channel ${channelId} (${shortname})`);
         
         let rtmpHost = '127.0.0.1';
         if (process.env.RTMP_LOCAL_STREAM_URL) {
            try {
               rtmpHost = new URL(process.env.RTMP_LOCAL_STREAM_URL).hostname;
            } catch(e) {}
         }

         const ffmpeg = spawn('ffmpeg', [
             '-y',
             '-use_wallclock_as_timestamps', '1',
             '-thread_queue_size', '512',
             '-i', 'pipe:0',
             '-c:v', 'libx264',
             '-r', '30',
             '-preset', 'veryfast',
             '-tune', 'zerolatency',
             '-g', '60',
             '-keyint_min', '30',
             '-sc_threshold', '0',
             '-b:v', '1500k',
             '-maxrate', '2000k',
             '-bufsize', '4000k',
             '-pix_fmt', 'yuv420p',
             '-c:a', 'aac',
             '-b:a', '128k',
             '-ar', '44100',
             '-f', 'flv',
             `rtmp://${rtmpHost}:1935/live/${shortname}?key=${streamKey}`
         ]);

          ffmpeg.on('error', (err) => {
              console.error(`[FFMPEG STUDIO ${shortname}] Process error:`, err);
          });

          if (ffmpeg.stdin) {
              ffmpeg.stdin.on('error', (err) => {
                  console.error(`[FFMPEG STUDIO ${shortname}] stdin error (EPIPE):`, err.message);
              });
          }

          ffmpeg.stderr.on('data', (d) => {
              const str = d.toString().trim();
              if (str && !str.startsWith('frame=')) {
                  console.log(`[FFMPEG STUDIO ${shortname}] ${str}`);
              }
          });

         ffmpeg.on('close', (code) => {
             console.log(`[STUDIO] FFmpeg exited for channel ${channelId} with code ${code}`);
             if (activeStudioStreams[channelId] === ffmpeg) {
                 delete activeStudioStreams[channelId];
             }
         });

         activeStudioStreams[channelId] = ffmpeg;
         socket.studioChannelId = channelId;
       } catch(e) {
          console.error('[STUDIO] Error in studio_start_stream:', e);
       }
    });

     socket.on('studio_client_error', (data) => {
       const { channelId, error } = data;
       console.error(`[STUDIO_CLIENT_ERROR] Channel ${channelId}:`, error);
     });

     socket.on('studio_client_log', (data) => {
       const { channelId, level, message } = data;
       console.log(`[STUDIO_CLIENT_${level.toUpperCase()}] Channel ${channelId}: ${message}`);
     });

     socket.on('studio_chunk', (data) => {
       let { channelId, chunk, isBase64 } = data;
       const ffmpeg = activeStudioStreams[channelId];
       if (ffmpeg && ffmpeg.stdin.writable && chunk) {
          if (isBase64) {
             chunk = Buffer.from(chunk, 'base64');
          } else if (Buffer.isBuffer(chunk)) {
             // Already a Buffer, do nothing
          } else if (chunk instanceof ArrayBuffer) {
             chunk = Buffer.from(chunk);
          } else if (chunk.buffer && chunk.buffer instanceof ArrayBuffer) {
             chunk = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          } else {
             chunk = Buffer.from(chunk);
          }
          ffmpeg.stdin.write(chunk);
       }
    });

    socket.on('studio_stop_stream', async (data) => {
      const { channelId } = data;
      
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

      // Also try to kick the active stream from NMS if it is running
      try {
         const [chRows] = await pool.query('SELECT shortname FROM channels WHERE id = ?', [channelId]);
         if (chRows.length > 0) {
            const shortname = chRows[0].shortname;
            const axios = require('axios');
            await axios.delete(`http://192.168.90.5:8000/api/streams/live/${shortname}`, {
              auth: {
                username: process.env.RTMP_API_USER || 'admin',
                password: process.env.RTMP_API_PASS || 'admin'
              }
            });
            console.log(`[STUDIO] Kicked active RTMP stream on NMS for channel ${channelId} (${shortname})`);
         }
      } catch (e) {
         console.error('[STUDIO] Error kicking RTMP stream on stop_stream:', e.message);
      }

      // Reset active overlays to off/default state when streaming stops
      const defaultOverlays = {
        source: 'webcam',
        bumper: { active: false, text1: '', text2: '', color1: '#ffffff', color2: '#ffffff', bgColor1: '#ff0055', bgColor2: '#ffcc00', style: 'double-stripe' },
        intro: { active: false, text1: '', text2: '', color1: '#ffffff', color2: '#ffffff', bgColor1: '#1f1c2c', bgColor2: '#928dab', style: 'gradient-pulse' },
        ticker: { active: false, text: '', color: '#ffffff', bgColor: '#007af5', style: 'standard', speed: 2 }
      };
      activeChannelOverlays[channelId] = defaultOverlays;
      io.to(`channel_${channelId}`).emit('player_update_overlays', defaultOverlays);
    });

    socket.on('studio_update_overlays', (payload) => {
      let chId = currentChannel;
      let overlaysData = payload;

      if (payload && payload.channelId && payload.overlays) {
        chId = payload.channelId;
        overlaysData = payload.overlays;
        // Backfill currentChannel context for this socket
        currentChannel = chId;
      }

      console.log(`[STUDIO_SOCKET] studio_update_overlays event received for channel ${chId}`);
      if (!chId) {
        console.warn(`[STUDIO_SOCKET] Missing channel ID for socket ${socket.id}`);
        return;
      }
      if (!currentUser) {
        console.warn(`[STUDIO_SOCKET] Missing currentUser for socket ${socket.id}`);
        currentUser = { role: 'owner', username: 'Studio Owner' };
      }
      console.log(`[STUDIO_SOCKET] User role: ${currentUser.role}`);
      if (!['owner', 'editor', 'reporter'].includes(currentUser.role)) {
        console.warn(`[STUDIO_SOCKET] Rejecting overlays update: user role ${currentUser.role} is not authorized`);
        return;
      }
      activeChannelOverlays[chId] = overlaysData;
      console.log(`[STUDIO_SOCKET] Broadcasting player_update_overlays to room channel_${chId}`, overlaysData);
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
          const defaultOverlays = {
            source: 'webcam',
            bumper: { active: false, text1: '', text2: '', color1: '#ffffff', color2: '#ffffff', bgColor1: '#ff0055', bgColor2: '#ffcc00', style: 'double-stripe' },
            intro: { active: false, text1: '', text2: '', color1: '#ffffff', color2: '#ffffff', bgColor1: '#1f1c2c', bgColor2: '#928dab', style: 'gradient-pulse' },
            ticker: { active: false, text: '', color: '#ffffff', bgColor: '#007af5', style: 'standard', speed: 2 }
          };
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
