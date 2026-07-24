const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const { logAction } = require('../../../utils/logger');
const { requireRtmpInternalAuth } = require('../../../middlewares/rtmpInternalAuth');

// Gate all MediaMTX / legacy RTMP internal webhooks behind shared credentials.
router.use('/api/internal/rtmp', requireRtmpInternalAuth);


router.post('/api/internal/rtmp/on_publish', async (req, res) => {
  const { shortname, key, streamId, ip } = req.body;
  try {
    // 1. Find channel & check global settings
    const [settings] = await pool.query('SELECT setting_value FROM system_settings WHERE setting_key = "rtmp_disabled"');
    if (settings.length > 0 && settings[0].setting_value === '1') {
      return res.status(403).json({ error: 'RTMP streaming is globally disabled' });
    }

    const [channels] = await pool.query('SELECT id, name, user_id, rtmp_disabled, stream_delay FROM channels WHERE shortname = ? AND status = "active"', [shortname]);
    if (channels.length === 0) return res.status(403).json({ error: 'Channel not found' });
    if (channels[0].rtmp_disabled) return res.status(403).json({ error: 'RTMP streaming is disabled for this channel' });
    const channelId = channels[0].id;
    const channelName = channels[0].name;
    const streamDelay = 12;

    // 2. Disconnect stale publisher if active
    try {
      const axios = require('axios');
  const response = await axios.get(`http://${process.env.RTMP_SERVER_IP || '127.0.0.1'}:${process.env.RTMP_API_PORT || '9997'}/v3/paths/list`, {
        auth: {
          username: process.env.RTMP_API_USER,
          password: process.env.RTMP_API_PASS
        }
      });
      // Legacy NMS-shaped handling below is best-effort; MediaMTX path list differs.
      const liveStreams = (response.data && response.data.live) || {};
      if (liveStreams && liveStreams[shortname] && liveStreams[shortname].publisher) {
        const oldClientId = liveStreams[shortname].publisher.clientId;
        if (oldClientId !== streamId) {
          console.log(`[RTMP] Stale publisher detected for channel ${shortname} (Client: ${oldClientId}). Disconnecting...`);
          try {
            await axios.post(`http://${process.env.RTMP_SERVER_IP || '127.0.0.1'}:${process.env.RTMP_API_PORT || '9997'}/v3/paths/kick/${encodeURIComponent('live/' + shortname)}`, {}, {
              auth: {
                username: process.env.RTMP_API_USER,
                password: process.env.RTMP_API_PASS
              }
            });
            console.log(`[RTMP] Disconnected stale client ${oldClientId} for channel ${shortname}`);
          } catch (delErr) {
            console.error(`[RTMP] Failed to disconnect stale client ${oldClientId}:`, delErr.message);
            try {
              await axios.post(`http://${process.env.RTMP_SERVER_IP || '127.0.0.1'}:${process.env.RTMP_API_PORT || '9997'}/v3/paths/kick/${encodeURIComponent('live/' + shortname)}`, {}, {
                auth: {
                  username: process.env.RTMP_API_USER,
                  password: process.env.RTMP_API_PASS
                }
              });
              console.log(`[RTMP] Fallback: kicked path for channel ${shortname}`);
            } catch (fallbackErr) {
              console.error(`[RTMP] Fallback path kick also failed:`, fallbackErr.message);
            }
          }
        }
      }
    } catch (e) {
      console.error('[RTMP API] Error checking active streams:', e.message);
    }

    // 3. Verify key and get username of key owner
    const [keys] = await pool.query(`
      SELECT sk.user_id, sk.is_active, u.username 
      FROM stream_keys sk 
      JOIN users u ON sk.user_id = u.id 
      WHERE sk.channel_id = ? AND sk.stream_key = ?`, [channelId, key]);

    if (keys.length === 0 || !keys[0].is_active) {
      logAction('rtmp', `Неизвестный(${channelName})`, 'Неудачная попытка публикации (Неверный ключ трансляции)', ip);
      return res.status(403).json({ error: 'Invalid key' });
    }

    const streamerUsername = keys[0].username;
    const logIdentifier = `${streamerUsername}(${channelName})`;

    // Cancel grace period if active
    global.pendingStreamEnds = global.pendingStreamEnds || {};
    if (global.pendingStreamEnds[channelId]) {
      console.log(`[RTMP] Reconnected within grace period for channel ${channelId}. Cancelling teardown.`);
      clearTimeout(global.pendingStreamEnds[channelId]);
      delete global.pendingStreamEnds[channelId];
    }

    // Clear any stale immediate stream end flags
    global.immediateStreamEnds = global.immediateStreamEnds || {};
    if (global.immediateStreamEnds[channelId]) {
      console.log(`[RTMP] Found and cleared stale immediate stream end flag for channel ${channelId}`);
      delete global.immediateStreamEnds[channelId];
    }

    // 4. Start stream
    const [chRows] = await pool.query('SELECT is_live FROM channels WHERE id = ?', [channelId]);
    if (chRows.length > 0 && chRows[0].is_live === 0) {
      await pool.query('UPDATE channels SET is_live = 1, live_title = NULL, live_started_at = NOW(), current_streamer_id = ? WHERE id = ?', [keys[0].user_id, channelId]);
    } else {
      await pool.query('UPDATE channels SET is_live = 1, live_started_at = NOW(), current_streamer_id = ? WHERE id = ?', [keys[0].user_id, channelId]);
    }

    // Emit socket event to notify players
    req.app.get('io').to(`channel_${channelId}`).emit('stream_started');

    logAction('rtmp', logIdentifier, 'Начата трансляция', ip);

    res.json({ success: true, delay: streamDelay });
  } catch (e) {
    console.error('[RTMP API] on_publish Error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/api/internal/rtmp/on_reject', async (req, res) => {
  const { shortname, reason } = req.body;
  try {
    const [channels] = await pool.query('SELECT id, name, user_id FROM channels WHERE shortname = ? AND status = "active"', [shortname]);
    if (channels.length > 0) {
      const channelName = channels[0].name;
      const userId = channels[0].user_id;
      
      const sendSystemMessage = require('../../../utils/systemMessage');
      const messageContent = `Неуспешно запущена трансляция телеканала "${channelName}". Причина: ${reason}. Пожалуйста, проверьте настройки кодировщика (OBS) и повторите попытку.`;
      
      await sendSystemMessage(userId, messageContent);
      console.log(`[RTMP REJECT] Sent system message to user ${userId} for channel ${channelName}. Reason: ${reason}`);

      // Log system action and trigger Telegram notification
      const logIdentifier = `Система(${channelName})`;
      await logAction('rtmp', logIdentifier, `Неуспешный запуск трансляции (Сброс): ${reason}`, '127.0.0.1');
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[RTMP API] on_reject Error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/api/internal/rtmp/on_done', async (req, res) => {
  const { shortname, streamId, ip } = req.body;
  try {
    const [channels] = await pool.query(`
      SELECT c.id, c.name, u.username 
      FROM channels c 
      LEFT JOIN users u ON c.current_streamer_id = u.id 
      WHERE c.shortname = ?`, [shortname]);

    if (channels.length > 0) {
      const channelId = channels[0].id;
      const channelName = channels[0].name;
      const streamerUsername = channels[0].username || 'Неизвестный';
      const logIdentifier = `${streamerUsername}(${channelName})`;

      global.immediateStreamEnds = global.immediateStreamEnds || {};
      global.pendingStreamEnds = global.pendingStreamEnds || {};

      if (global.immediateStreamEnds[channelId]) {
        console.log(`[RTMP] Immediate teardown requested for channel ${channelId}`);
        delete global.immediateStreamEnds[channelId];
        if (global.pendingStreamEnds[channelId]) {
          clearTimeout(global.pendingStreamEnds[channelId]);
          delete global.pendingStreamEnds[channelId];
        }
        await pool.query('UPDATE channels SET is_live = 0, current_streamer_id = NULL WHERE id = ?', [channelId]);
        req.app.get('io').to(`channel_${channelId}`).emit('stream_ended');
        logAction('rtmp', logIdentifier, 'Окончена трансляция', ip);
      } else {
        console.log(`[RTMP] Connection closed for channel ${channelId}. Starting 14s grace period.`);
        if (global.pendingStreamEnds[channelId]) {
          clearTimeout(global.pendingStreamEnds[channelId]);
        }
        global.pendingStreamEnds[channelId] = setTimeout(async () => {
          try {
            delete global.pendingStreamEnds[channelId];
            await pool.query('UPDATE channels SET is_live = 0, current_streamer_id = NULL WHERE id = ?', [channelId]);
            req.app.get('io').to(`channel_${channelId}`).emit('stream_ended');
            logAction('rtmp', logIdentifier, 'Окончена трансляция', ip);
            console.log(`[RTMP] Grace period expired. Closed stream for channel ${channelId}`);
          } catch (err) {
            console.error('[RTMP] Error executing delayed stream teardown:', err);
          }
        }, 14000);
      }
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[RTMP API] on_done Error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/api/internal/rtmp/mediamtx_auth', async (req, res) => {
  const { ip, user, path, action } = req.body || {};
  console.log(`[MediaMTX Auth] action=${action} path=${path} user=${user ? '[set]' : '[empty]'} ip=${ip || ''}`);
  const { password, query } = req.body;

  if (action !== 'publish') {
    return res.status(200).send();
  }

  const pathParts = path.split('/');
  const shortname = pathParts[pathParts.length - 1];

  console.log(`[MediaMTX Auth Debug] Incoming path: ${path}, shortname: ${shortname}`);

  let key = null;
  if (query) {
    const querystring = require('querystring');
    const parsedQuery = querystring.parse(query);
    key = parsedQuery.key;
  }
  if (!key) {
    key = password || user;
  }

  if (!shortname || !key) {
    console.log('[MediaMTX Auth] Rejected: missing shortname or stream key');
    return res.status(401).json({ error: 'Missing shortname or stream key' });
  }

  try {
    const [settings] = await pool.query('SELECT setting_value FROM system_settings WHERE setting_key = "rtmp_disabled"');
    if (settings.length > 0 && settings[0].setting_value === '1') {
      return res.status(403).json({ error: 'RTMP streaming is globally disabled' });
    }

    let cleanShortname = shortname;
    let streamIndex = 1;

    // 1. Try exact match first
    let [channels] = await pool.query('SELECT id, name, user_id, rtmp_disabled, max_streams, is_premium, is_verified FROM channels WHERE shortname = ? AND status = "active"', [shortname]);

    if (channels.length === 0) {
      // 2. Try suffix match if exact name not found (e.g. shortname_2 or shortname_3)
      const match = shortname.match(/^(.+)_(1|2|3)$/);
      if (match) {
        cleanShortname = match[1];
        streamIndex = parseInt(match[2], 10);
        [channels] = await pool.query('SELECT id, name, user_id, rtmp_disabled, max_streams, is_premium, is_verified FROM channels WHERE shortname = ? AND status = "active"', [cleanShortname]);
      }
    }

    if (channels.length === 0) return res.status(403).json({ error: 'Channel not found' });

    // Check if the channel is in cooldown
    global.streamCooldowns = global.streamCooldowns || new Map();
    const cooldownKey = cleanShortname.toLowerCase();
    const cooldown = global.streamCooldowns.get(cooldownKey);
    if (cooldown) {
      if (Date.now() < cooldown.expires) {
        const remainingSec = Math.ceil((cooldown.expires - Date.now()) / 1000);
        console.log(`[MediaMTX Auth] Rejected connection for ${cleanShortname} (IP: ${ip}) due to active cooldown. Reason: ${cooldown.reason}. Remaining time: ${remainingSec}s`);
        
        // Log system action with client IP
        const channelName = channels[0].name;
        logAction('rtmp', `Система(${channelName})`, `Отклонено подключение: кулдаун (осталось ${remainingSec} сек)`, ip);

        return res.status(403).json({ error: `Канал временно заблокирован на ${remainingSec} сек за нарушение правил трансляции.` });
      } else {
        // Cooldown has expired, clean up the Map
        global.streamCooldowns.delete(cooldownKey);
      }
    }

    if (channels[0].rtmp_disabled) return res.status(403).json({ error: 'RTMP streaming is disabled for this channel' });
    const channelId = channels[0].id;
    const channelName = channels[0].name;

    // Stream index > 1 requires Premium or Verified status, and must be within max_streams setting
    const [settingsRows] = await pool.query("SELECT setting_value FROM system_settings WHERE setting_key = 'allow_multistream_for_everyone'");
    const allowEveryone = settingsRows.length > 0 && settingsRows[0].setting_value === '1';

    const maxStreams = (channels[0].is_premium || channels[0].is_verified || allowEveryone) ? (channels[0].max_streams || 1) : 1;
    if (streamIndex > maxStreams) {
      console.log(`[MediaMTX Auth] Rejected: Channel "${channelName}" requested stream index ${streamIndex} but max streams is set to ${maxStreams}`);
      return res.status(403).json({ error: `Multi-stream is not allowed or stream index ${streamIndex} exceeds allowed max_streams (${maxStreams})` });
    }

    const [keys] = await pool.query(`
      SELECT sk.user_id, sk.is_active, u.username 
      FROM stream_keys sk 
      JOIN users u ON sk.user_id = u.id 
      WHERE sk.channel_id = ? AND sk.stream_key = ?`, [channelId, key]);

    if (keys.length === 0 || !keys[0].is_active) {
      logAction('rtmp', `Неизвестный(${channelName})`, 'Неудачная попытка публикации (Неверный ключ трансляции)', ip);
      return res.status(403).json({ error: 'Invalid key' });
    }

    const streamerUsername = keys[0].username;
    const logIdentifier = `${streamerUsername}(${channelName})`;

    // Reconnected within grace period: clear the timeout for this specific stream index
    global.pendingStreamEnds = global.pendingStreamEnds || {};
    const teardownKey = `${channelId}_${streamIndex}`;
    if (global.pendingStreamEnds[teardownKey]) {
      console.log(`[MediaMTX] Reconnected within grace period for channel ${channelId} stream ${streamIndex}. Cancelling teardown.`);
      clearTimeout(global.pendingStreamEnds[teardownKey]);
      delete global.pendingStreamEnds[teardownKey];
    }

    global.immediateStreamEnds = global.immediateStreamEnds || {};
    const immediateKey = `${channelId}_${streamIndex}`;
    if (global.immediateStreamEnds[immediateKey]) {
      delete global.immediateStreamEnds[immediateKey];
    }

    // Set specific stream status and global live status
    const isLiveCol = `is_live_${streamIndex}`;
    await pool.query(`UPDATE channels SET is_live = 1, ${isLiveCol} = 1, live_title = IF(live_started_at IS NULL, NULL, live_title), live_started_at = IFNULL(live_started_at, NOW()), current_streamer_id = ? WHERE id = ?`, [keys[0].user_id, channelId]);

    // Emit event to notify client updates
    req.app.get('io').to(`channel_${channelId}`).emit('stream_started');

    logAction('rtmp', logIdentifier, `Начата трансляция (Камера ${streamIndex})`, ip);

    res.status(200).send();
  } catch (e) {
    console.error('[MediaMTX Auth] Error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/api/internal/rtmp/mediamtx_unpublish', async (req, res) => {
  const { path, ip } = req.body;
  
  if (!path) {
    return res.status(400).json({ error: 'Missing path' });
  }

  console.log(`[MediaMTX Unpublish] path=${path} ip=${ip || ''}`);
  const pathParts = (req.body.path || req.body.name || '').split('/');
  const shortname = pathParts[pathParts.length - 1];

  try {
    let cleanShortname = shortname;
    let streamIndex = 1;

    let [channels] = await pool.query(`
      SELECT c.id, c.name, u.username 
      FROM channels c 
      LEFT JOIN users u ON c.current_streamer_id = u.id 
      WHERE c.shortname = ?`, [shortname]);

    if (channels.length === 0) {
      const match = shortname.match(/^(.+)_(1|2|3)$/);
      if (match) {
        cleanShortname = match[1];
        streamIndex = parseInt(match[2], 10);
        [channels] = await pool.query(`
          SELECT c.id, c.name, u.username 
          FROM channels c 
          LEFT JOIN users u ON c.current_streamer_id = u.id 
          WHERE c.shortname = ?`, [cleanShortname]);
      }
    }

    if (channels.length > 0) {
      const channelId = channels[0].id;
      const channelName = channels[0].name;
      const streamerUsername = channels[0].username || 'Неизвестный';
      const logIdentifier = `${streamerUsername}(${channelName})`;

      global.immediateStreamEnds = global.immediateStreamEnds || {};
      global.pendingStreamEnds = global.pendingStreamEnds || {};

      const immediateKey = `${channelId}_${streamIndex}`;
      const teardownKey = `${channelId}_${streamIndex}`;

      if (global.immediateStreamEnds[immediateKey]) {
        console.log(`[MediaMTX] Immediate teardown requested for channel ${channelId} stream ${streamIndex}`);
        delete global.immediateStreamEnds[immediateKey];
        if (global.pendingStreamEnds[teardownKey]) {
          clearTimeout(global.pendingStreamEnds[teardownKey]);
          delete global.pendingStreamEnds[teardownKey];
        }
        
        const isLiveCol = `is_live_${streamIndex}`;
        await pool.query(`UPDATE channels SET ${isLiveCol} = 0 WHERE id = ?`, [channelId]);

        // Check if any other streams are still active
        const [chState] = await pool.query(`SELECT is_live_1, is_live_2, is_live_3 FROM channels WHERE id = ?`, [channelId]);
        if (chState.length > 0) {
          const isAnyLive = chState[0].is_live_1 || chState[0].is_live_2 || chState[0].is_live_3;
          if (!isAnyLive) {
            await pool.query('UPDATE channels SET is_live = 0, live_title = NULL, current_streamer_id = NULL, live_started_at = NULL WHERE id = ?', [channelId]);
            req.app.get('io').to(`channel_${channelId}`).emit('stream_ended');
          } else {
            req.app.get('io').to(`channel_${channelId}`).emit('stream_updated');
          }
        }
        
        logAction('rtmp', logIdentifier, `Окончена трансляция (Камера ${streamIndex})`, ip);
      } else {
        console.log(`[MediaMTX] Connection closed for channel ${channelId} stream ${streamIndex}. Starting 14s grace period.`);
        if (global.pendingStreamEnds[teardownKey]) {
          clearTimeout(global.pendingStreamEnds[teardownKey]);
        }
        global.pendingStreamEnds[teardownKey] = setTimeout(async () => {
          try {
            delete global.pendingStreamEnds[teardownKey];
            const isLiveCol = `is_live_${streamIndex}`;
            await pool.query(`UPDATE channels SET ${isLiveCol} = 0 WHERE id = ?`, [channelId]);

            // Check if any other streams are still active
            const [chState] = await pool.query(`SELECT is_live_1, is_live_2, is_live_3 FROM channels WHERE id = ?`, [channelId]);
            if (chState.length > 0) {
              const isAnyLive = chState[0].is_live_1 || chState[0].is_live_2 || chState[0].is_live_3;
              if (!isAnyLive) {
                await pool.query('UPDATE channels SET is_live = 0, live_title = NULL, current_streamer_id = NULL, live_started_at = NULL WHERE id = ?', [channelId]);
                req.app.get('io').to(`channel_${channelId}`).emit('stream_ended');
              } else {
                req.app.get('io').to(`channel_${channelId}`).emit('stream_updated');
              }
            }
            logAction('rtmp', logIdentifier, `Окончена трансляция (Камера ${streamIndex})`, ip);
            console.log(`[MediaMTX] Grace period expired. Closed stream ${streamIndex} for channel ${channelId}`);
          } catch (err) {
            console.error('[MediaMTX] Error executing delayed stream teardown:', err);
          }
        }, 14000);
      }
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[MediaMTX Unpublish] Error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
