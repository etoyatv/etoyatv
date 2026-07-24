const axios = require('axios');
const { pool } = require('../config/db');
const { logAction } = require('./logger');
const sendSystemMessage = require('./systemMessage');
const { kickStream } = require('./mediaServer');

const RTMP_SERVER_IP = process.env.RTMP_SERVER_IP || '192.168.90.5';
const RTMP_API_PORT = process.env.RTMP_API_PORT || '9997';
const BASE_URL = `http://${RTMP_SERVER_IP}:${RTMP_API_PORT}`;

// Cooldown tracker to prevent duplicate notifications
const recentlyKicked = new Set();

// Map to track stream byte stats for calculating instantaneous bitrate
// Key: streamName (e.g. 'live/erlandrid'), Value: { bytesReceived, timestamp }
const streamStats = new Map();

async function validateStreams() {
  try {
    const url = `${BASE_URL}/v3/paths/list`;
    const response = await axios.get(url, { timeout: 3000 });
    if (response.status !== 200 || !response.data || !response.data.items) return;

    // Track active streams for cleanup
    const activeStreamNames = new Set();

    for (const item of response.data.items) {
      if (!item.ready || !item.name.startsWith('live/')) continue;

      activeStreamNames.add(item.name);

      const pathParts = item.name.split('/');
      const shortname = pathParts[pathParts.length - 1];
      if (!shortname) continue;

      let cleanShortname = shortname;
      const match = shortname.match(/^(.+)_(1|2|3)$/);
      if (match) {
        cleanShortname = match[1];
      }

      // Calculate bitrate
      const now = Date.now();
      const currentBytes = item.bytesReceived || 0;
      const prevStats = streamStats.get(item.name);
      
      let bitrateKbps = 0;
      if (prevStats) {
        const deltaBytes = currentBytes - prevStats.bytesReceived;
        const deltaTimeMs = now - prevStats.timestamp;
        if (deltaTimeMs > 1000 && deltaBytes >= 0) {
          bitrateKbps = Math.round((deltaBytes * 8) / deltaTimeMs);
        }
      } else {
        // Fallback: average bitrate since start
        const readyTime = new Date(item.readyTime).getTime();
        const elapsedMs = now - readyTime;
        if (elapsedMs > 5000) {
          bitrateKbps = Math.round((currentBytes * 8) / elapsedMs);
        }
      }

      // Update stats for next cycle
      streamStats.set(item.name, { bytesReceived: currentBytes, timestamp: now });

      const tracks = item.tracks2 || [];
      const videoTrack = tracks.find(t => t.codec === 'H264' || t.codec === 'H265' || t.codec === 'VP8' || t.codec === 'VP9' || t.codec === 'AV1');
      const audioTrack = tracks.find(t => t.codec === 'MPEG-4 Audio' || t.codec === 'MPEG-1/2 Audio' || t.codec === 'Opus');

      let rejectReason = null;

      if (videoTrack) {
        if (videoTrack.codec !== 'H264') {
          rejectReason = `неподдерживаемый видеокодек (${videoTrack.codec}). Разрешен только кодек H.264 (AVC)`;
        } else {
          const props = videoTrack.codecProps || {};
          const width = props.width || 0;
          const height = props.height || 0;
          if (width > 1920 || height > 1080) {
            rejectReason = `разрешение трансляции (${width}x${height}) превышает допустимый лимит 1920x1080 (1080p)`;
          }
        }
      }

      // Check bitrate limit (8500 Kbps limit, allowing up to 8800 Kbps to buffer OBS encoder spikes)
      if (!rejectReason && bitrateKbps > 8800) {
        rejectReason = `битрейт трансляции (${bitrateKbps} Кбит/с) превышает допустимый лимит 8500 Кбит/с`;
      }

      // AAC/MP3 for OBS/RTMP; Opus is normal for browser WebRTC (MediaMTX remuxes into HLS)
      if (!rejectReason && audioTrack) {
        const okAudio = audioTrack.codec === 'MPEG-4 Audio'
          || audioTrack.codec === 'MPEG-1/2 Audio'
          || audioTrack.codec === 'Opus';
        if (!okAudio) {
          rejectReason = `неподдерживаемый аудиокодек (${audioTrack.codec}). Разрешены AAC, MP3 и Opus (WebRTC)`;
        }
      }

      if (rejectReason) {
        const cacheKey = `${shortname}:${rejectReason}`;
        if (recentlyKicked.has(cacheKey)) continue;

        console.log(`[Stream Validator] Rejecting stream for ${shortname}: ${rejectReason}`);

        // 1. Kick/disconnect the stream on media server first to capture the streamer's IP
        const kickResult = await kickStream(shortname);
        const clientIp = (kickResult && kickResult.ip) || '127.0.0.1';

        const [channels] = await pool.query('SELECT id, name, user_id FROM channels WHERE shortname = ?', [cleanShortname]);
        let userId = null;
        let channelName = '';
        if (channels.length > 0) {
          channelName = channels[0].name;
          userId = channels[0].user_id;

          // 2. Send system message to channel owner
          const messageContent = `Трансляция телеканала "${channelName}" была автоматически остановлена. Причина: ${rejectReason}. Пожалуйста, проверьте настройки кодировщика (OBS) и повторите попытку.`;
          await sendSystemMessage(userId, messageContent);

          // 3. Log system action with real client IP
          const logIdentifier = `Система(${channelName})`;
          await logAction('rtmp', logIdentifier, `Автоматический сброс трансляции: ${rejectReason}`, clientIp);
        }

        recentlyKicked.add(cacheKey);
        setTimeout(() => recentlyKicked.delete(cacheKey), 60000); // 1-minute cooldown per specific rejection

        // 4. Track repeated violations to apply 3-minute cooldown if kicked 8 times
        global.streamKickCounts = global.streamKickCounts || new Map();
        global.streamCooldowns = global.streamCooldowns || new Map();

        const cleanKey = cleanShortname.toLowerCase();
        const stats = global.streamKickCounts.get(cleanKey) || { count: 0, lastKickTime: 0 };

        // If last kick was more than 10 minutes ago, reset the count
        if (Date.now() - stats.lastKickTime > 600000) {
          stats.count = 0;
        }

        stats.count += 1;
        stats.lastKickTime = Date.now();
        global.streamKickCounts.set(cleanKey, stats);

        console.log(`[Stream Validator] Channel ${cleanKey} has been kicked ${stats.count} times recently.`);

        if (stats.count >= 8) {
          global.streamCooldowns.set(cleanKey, {
            expires: Date.now() + 180000, // 3 minutes
            reason: rejectReason
          });
          
          // Reset count
          stats.count = 0;
          global.streamKickCounts.set(cleanKey, stats);

          console.log(`[Stream Validator] Channel ${cleanKey} is placed on a 3-minute cooldown due to repeated violations.`);

          if (userId) {
            const cooldownMessage = `Временная блокировка: В связи с многочисленными повторными сбросами трансляции (8 раз подряд) из-за нарушения настроек, подключение новых трансляций для вашего канала заблокировано на 3 минуты. Пожалуйста, настройте ваш кодировщик (OBS) в соответствии с правилами (разрешен кодек H.264, битрейт до 8500 Кбит/с, разрешение до 1080p).`;
            await sendSystemMessage(userId, cooldownMessage);
            const logIdentifier = `Система(${channelName})`;
            await logAction('rtmp', logIdentifier, `Активирован кулдаун на 3 минуты за 8 повторных сбросов`, clientIp);
          }
        }
      }
    }

    // Clean up stale entries in streamStats map for disconnected streams
    for (const key of streamStats.keys()) {
      if (!activeStreamNames.has(key)) {
        streamStats.delete(key);
      }
    }
  } catch (err) {
    if (err.code !== 'ECONNREFUSED') {
      console.error('[Stream Validator] Error validating active streams:', err.message);
    }
  }
}

// Map to track how long a stream has been inactive in MediaMTX before we force-clear it from DB
const inactiveTracker = new Map();

async function selfHealStreams() {
  try {
    const url = `${BASE_URL}/v3/paths/list`;
    const response = await axios.get(url, { timeout: 3000 });
    if (response.status !== 200 || !response.data || !response.data.items) return;

    // Build set of active paths from MediaMTX
    const activePaths = new Set();
    for (const item of response.data.items) {
      if (item.ready && item.name) {
        activePaths.add(item.name.toLowerCase());
      }
    }

    // Get all channels marked as live
    const [liveChannels] = await pool.query(
      'SELECT id, shortname, is_live, is_live_1, is_live_2, is_live_3 FROM channels WHERE is_live = 1 OR is_live_1 = 1 OR is_live_2 = 1 OR is_live_3 = 1'
    );

    const now = Date.now();

    for (const channel of liveChannels) {
      const channelId = channel.id;
      const shortnameLower = channel.shortname.toLowerCase();
      
      const columnsToClear = [];

      // Check stream index 1, 2, and 3
      for (let idx = 1; idx <= 3; idx++) {
        const dbCol = `is_live_${idx}`;
        const isLiveInDb = channel[dbCol] === 1;

        if (isLiveInDb) {
          // Expected path in MediaMTX
          const expectedPath = idx === 1 ? `live/${shortnameLower}` : `live/${shortnameLower}_${idx}`;
          const isActiveOnServer = activePaths.has(expectedPath);

          if (!isActiveOnServer) {
            // Check if there is a pending teardown timeout in global.pendingStreamEnds
            global.pendingStreamEnds = global.pendingStreamEnds || {};
            const teardownKey = `${channelId}_${idx}`;
            const legacyTeardownKey = channelId.toString();
            
            const hasTeardown = global.pendingStreamEnds[teardownKey] || (idx === 1 && global.pendingStreamEnds[legacyTeardownKey]);

            if (!hasTeardown) {
              const trackerKey = `${channelId}_${idx}`;
              if (!inactiveTracker.has(trackerKey)) {
                inactiveTracker.set(trackerKey, now);
              } else {
                const inactiveSince = inactiveTracker.get(trackerKey);
                if (now - inactiveSince > 30000) { // Inactive for > 30 seconds and no grace period active
                  console.log(`[Self-Heal] Detected stuck stream ${idx} for channel ${channel.shortname} (ID: ${channelId}). Force clearing.`);
                  columnsToClear.push(dbCol);
                  inactiveTracker.delete(trackerKey);
                }
              }
            } else {
              // If there is a teardown pending, clear any tracker entry
              inactiveTracker.delete(`${channelId}_${idx}`);
            }
          } else {
            // Stream is active, clear tracker entry
            inactiveTracker.delete(`${channelId}_${idx}`);
          }
        } else {
          // Stream is not live in DB, clear tracker entry
          inactiveTracker.delete(`${channelId}_${idx}`);
        }
      }

      if (columnsToClear.length > 0) {
        // Clear columns in DB
        const updates = columnsToClear.map(col => `${col} = 0`).join(', ');
        await pool.query(`UPDATE channels SET ${updates} WHERE id = ?`, [channelId]);

        // Query new status to check if any stream is still active
        const [chState] = await pool.query('SELECT is_live_1, is_live_2, is_live_3 FROM channels WHERE id = ?', [channelId]);
        if (chState.length > 0) {
          const isAnyLive = chState[0].is_live_1 || chState[0].is_live_2 || chState[0].is_live_3;
          if (!isAnyLive) {
            await pool.query('UPDATE channels SET is_live = 0, live_title = NULL, current_streamer_id = NULL, live_started_at = NULL WHERE id = ?', [channelId]);
            // Notify players & studio
            if (global.io) {
              global.io.to(`channel_${channelId}`).emit('stream_ended');
            }
            console.log(`[Self-Heal] Channel ${channel.shortname} is now completely offline.`);
          } else {
            if (global.io) {
              global.io.to(`channel_${channelId}`).emit('stream_updated');
            }
            console.log(`[Self-Heal] Channel ${channel.shortname} streams updated (some still active).`);
          }
        }
      }
    }
  } catch (err) {
    if (err.code !== 'ECONNREFUSED') {
      console.error('[Self-Heal] Error in self-healing routine:', err.message);
    }
  }
}

function startStreamValidator() {
  setInterval(validateStreams, 10000); // Run check every 10 seconds
  setInterval(selfHealStreams, 10000);  // Run self-healing check every 10 seconds
}

module.exports = {
  startStreamValidator
};
