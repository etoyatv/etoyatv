const express = require('express');
const router = express.Router();
const { pool } = require('../../config/db');
const { logAction } = require('../../utils/logger');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const emailService = require('../../emailService');
const { requireAuth } = require('../../middlewares/auth');
const { panelMiddleware, recordUploadMiddleware, designUploadMiddleware } = require('../../middlewares/panel');

router.get('/api/users/search', requireAuth, async (req, res) => {
  const q = req.query.q || '';
  if (q.length < 1) return res.json([]);

  try {
    const connection = await pool.getConnection();
    const searchPattern = q + '%';
    const [users] = await connection.query('SELECT username, avatar FROM users WHERE username LIKE ? AND id != ? AND deleted_at IS NULL AND is_banned = 0 LIMIT 10', [searchPattern, req.session.user.id]);
    connection.release();
    res.json(users);
  } catch (e) {
    res.status(500).json([]);
  }
});

router.get('/api/panel/stat/viewers', panelMiddleware, async (req, res) => {
  try {
    const channelId = res.locals.panelChannel.id;
    const period = req.query.period || '24h';
    let timeClause = '>= NOW() - INTERVAL 24 HOUR';
    let groupClause = '';
    let selectClause = 'viewer_count, created_at';
    
    if (period === 'week') {
      timeClause = '>= NOW() - INTERVAL 7 DAY';
      selectClause = 'MAX(viewer_count) as viewer_count, DATE(created_at) as created_at';
      groupClause = 'GROUP BY DATE(created_at)';
    } else if (period === 'month') {
      timeClause = '>= NOW() - INTERVAL 1 MONTH';
      selectClause = 'MAX(viewer_count) as viewer_count, DATE(created_at) as created_at';
      groupClause = 'GROUP BY DATE(created_at)';
    } else if (period === 'year') {
      timeClause = '>= NOW() - INTERVAL 1 YEAR';
      selectClause = 'MAX(viewer_count) as viewer_count, DATE(created_at) as created_at';
      groupClause = 'GROUP BY DATE(created_at)';
    } else if (period === 'all') {
      timeClause = 'IS NOT NULL';
      selectClause = 'MAX(viewer_count) as viewer_count, DATE(created_at) as created_at';
      groupClause = 'GROUP BY DATE(created_at)';
    }
    
    const query = `SELECT ${selectClause} FROM channel_viewer_stats WHERE channel_id = ? AND created_at ${timeClause} ${groupClause} ORDER BY created_at ASC`;
    const [rows] = await pool.query(query, [channelId]);
    res.json({ success: true, data: rows });
  } catch (e) {
    console.error('Error fetching viewer stats:', e);
    res.status(500).json({ success: false });
  }
});

router.get('/api/panel/stat/records', panelMiddleware, async (req, res) => {
  try {
    const channelId = res.locals.panelChannel.id;
    const period = req.query.period || '6m';
    let timeClause = '>= DATE_SUB(NOW(), INTERVAL 6 MONTH)';
    
    if (period === 'year') {
      timeClause = '>= DATE_SUB(NOW(), INTERVAL 1 YEAR)';
    } else if (period === 'all') {
      timeClause = 'IS NOT NULL';
    }
    
    const [rows] = await pool.query(`SELECT DATE_FORMAT(created_at, "%Y-%m") as month, COUNT(*) as views FROM record_view_stats WHERE channel_id = ? AND created_at ${timeClause} GROUP BY month ORDER BY month ASC`, [channelId]);
    res.json({ success: true, data: rows });
  } catch (e) {
    console.error('Error fetching record stats:', e);
    res.status(500).json({ success: false });
  }
});

router.get('/api/panel/stat/audience', panelMiddleware, async (req, res) => {
  try {
    const channelId = res.locals.panelChannel.id;
    const period = req.query.period || '24h';
    let timeClause = '>= NOW() - INTERVAL 24 HOUR';
    
    if (period === 'week') timeClause = '>= NOW() - INTERVAL 7 DAY';
    else if (period === 'month') timeClause = '>= NOW() - INTERVAL 1 MONTH';
    else if (period === 'year') timeClause = '>= NOW() - INTERVAL 1 YEAR';
    else if (period === 'all') timeClause = 'IS NOT NULL';
    
    const [rows] = await pool.query(`SELECT country_code, COUNT(*) as views FROM record_view_stats WHERE channel_id = ? AND created_at ${timeClause} GROUP BY country_code ORDER BY views DESC`, [channelId]);
    res.json({ success: true, data: rows });
  } catch (e) {
    console.error('Error fetching audience stats:', e);
    res.status(500).json({ success: false });
  }
});

router.post('/api/programs', panelMiddleware, async (req, res) => {
  const { channel_id, title, description, start_time } = req.body;
  if (channel_id != res.locals.panelChannel.id) return res.status(403).json({ error: 'Access denied' });
  try {
    const [result] = await pool.query('INSERT INTO programs (channel_id, title, description, start_time) VALUES (?, ?, ?, ?)', [channel_id, title, description || '', start_time]);
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Создал анонс (ID: ${result.insertId}, Название: ${title})`, userIp);
    res.json({ success: true, id: result.insertId });
  } catch (e) {
    console.error(e);
    res.json({ success: false, error: 'Database error' });
  }
});

router.put('/api/programs/:id', panelMiddleware, async (req, res) => {
  const { id } = req.params;
  const { title, description, start_time } = req.body;
  const channel_id = res.locals.panelChannel.id;
  try {
    const [result] = await pool.query('UPDATE programs SET title = ?, description = ?, start_time = ? WHERE id = ? AND channel_id = ?', [title, description || '', start_time, id, channel_id]);
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Изменил анонс (ID: ${id})`, userIp);
    res.json({ success: result.affectedRows > 0 });
  } catch (e) {
    console.error(e);
    res.json({ success: false, error: 'Database error' });
  }
});

router.delete('/api/programs/:id', panelMiddleware, async (req, res) => {
  const { id } = req.params;
  const channel_id = res.locals.panelChannel.id;
  try {
    const [result] = await pool.query('DELETE FROM programs WHERE id = ? AND channel_id = ?', [id, channel_id]);
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Удалил анонс (ID: ${id})`, userIp);
    res.json({ success: result.affectedRows > 0 });
  } catch (e) {
    console.error(e);
    res.json({ success: false, error: 'Database error' });
  }
});

router.post('/api/report', (req, res) => {
  console.log('--- REPORT RECEIVED ---');
  console.log('Record ID:', req.body.record_id);
  console.log('URL:', req.body.url);
  console.log('User:', req.session.user ? req.session.user.login : 'Guest');
  console.log('-----------------------');
  res.json({ success: true });
});

router.post('/api/channel/live_title', async (req, res) => {
  try {
    if (!req.session || !req.session.user) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const { shortname, title } = req.body;
    if (!shortname || typeof title !== 'string') return res.status(400).json({ success: false, error: 'Bad Request' });
    
    const [channels] = await pool.query('SELECT id, user_id FROM channels WHERE shortname = ?', [shortname]);
    if (channels.length === 0) return res.status(404).json({ success: false, error: 'Channel not found' });
    
    // Check if user is owner
    let isAuthorized = (channels[0].user_id == req.session.user.id);
    
    // If not owner, check if team member with editor/reporter/moderator role
    if (!isAuthorized) {
      const [team] = await pool.query(
        'SELECT id FROM channel_team WHERE channel_id = ? AND user_id = ? AND (is_editor = 1 OR is_reporter = 1 OR is_moderator = 1)',
        [channels[0].id, req.session.user.id]
      );
      if (team.length > 0) isAuthorized = true;
    }
    
    // Or if staff admin
    if (!isAuthorized && req.session.user.staff_role && req.session.user.mask_mode !== 'user_mask') {
      isAuthorized = true;
    }

    if (!isAuthorized) return res.status(403).json({ success: false, error: 'Forbidden' });
    
    await pool.query('UPDATE channels SET live_title = ? WHERE shortname = ?', [title.substring(0, 255), shortname]);
    res.json({ success: true });
  } catch (e) {
    console.error('[API] live_title update error:', e);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

router.post('/api/internal/rtmp/on_publish', async (req, res) => {
  const { shortname, key, streamId, ip } = req.body;
  try {
    // 1. Find channel & check global settings
    const [settings] = await pool.query('SELECT setting_value FROM system_settings WHERE setting_key = "rtmp_disabled"');
    if (settings.length > 0 && settings[0].setting_value === '1') {
      return res.status(403).json({ error: 'RTMP streaming is globally disabled' });
    }

    const [channels] = await pool.query('SELECT id, name, user_id, rtmp_disabled FROM channels WHERE shortname = ? AND status = "active"', [shortname]);
    if (channels.length === 0) return res.status(403).json({ error: 'Channel not found' });
    if (channels[0].rtmp_disabled) return res.status(403).json({ error: 'RTMP streaming is disabled for this channel' });
    const channelId = channels[0].id;
    const channelName = channels[0].name;

    // 2. Disconnect stale publisher if active
    try {
      const axios = require('axios');
      const response = await axios.get('http://192.168.90.5:8000/api/streams', {
        auth: {
          username: process.env.RTMP_API_USER || 'admin',
          password: process.env.RTMP_API_PASS || 'admin'
        }
      });
      const liveStreams = response.data.live;
      if (liveStreams && liveStreams[shortname] && liveStreams[shortname].publisher) {
        const oldClientId = liveStreams[shortname].publisher.clientId;
        if (oldClientId !== streamId) {
          console.log(`[RTMP] Stale publisher detected for channel ${shortname} (Client: ${oldClientId}). Disconnecting...`);
          try {
            await axios.delete(`http://192.168.90.5:8000/api/clients/${oldClientId}`, {
              auth: {
                username: process.env.RTMP_API_USER || 'admin',
                password: process.env.RTMP_API_PASS || 'admin'
              }
            });
            console.log(`[RTMP] Disconnected stale client ${oldClientId} for channel ${shortname}`);
          } catch (delErr) {
            console.error(`[RTMP] Failed to disconnect stale client ${oldClientId}:`, delErr.message);
            // Fallback: delete the entire stream if client delete fails
            try {
              await axios.delete(`http://192.168.90.5:8000/api/streams/live/${shortname}`, {
                auth: {
                  username: process.env.RTMP_API_USER || 'admin',
                  password: process.env.RTMP_API_PASS || 'admin'
                }
              });
              console.log(`[RTMP] Fallback: dropped stream for channel ${shortname}`);
            } catch (fallbackErr) {
              console.error(`[RTMP] Fallback stream drop also failed:`, fallbackErr.message);
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

    res.json({ success: true });
  } catch (e) {
    console.error('[RTMP API] on_publish Error:', e);
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


router.post('/api/programs/:id/bookmark', requireAuth, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const programId = req.params.id;
    const userId = req.session.user.id;
    const [existing] = await connection.query('SELECT * FROM personal_schedules WHERE user_id=? AND program_id=?', [userId, programId]);
    if(existing.length > 0) {
      await connection.query('DELETE FROM personal_schedules WHERE user_id=? AND program_id=?', [userId, programId]);
      connection.release();
      res.json({ success: true, action: 'removed' });
    } else {
      await connection.query('INSERT INTO personal_schedules (user_id, program_id) VALUES (?, ?)', [userId, programId]);
      connection.release();
      res.json({ success: true, action: 'added' });
    }
  } catch(e) { 
    console.error('Error toggling schedule:', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

router.get('/api/debug_autopilot/:id', async (req, res) => {
  res.json({ status: 'ok' });
});

router.get('/api/programs', async (req, res) => {
  res.json([]);
});

router.post('/api/programs', requireAuth, async (req, res) => {
  res.json({ success: true });
});

router.put('/api/programs/:id', requireAuth, async (req, res) => {
  res.json({ success: true });
});

router.delete('/api/programs/:id', requireAuth, async (req, res) => {
  res.json({ success: true });
});

router.post('/api/complaints', requireAuth, async (req, res) => {
  const { target_type, target_id, reason } = req.body;
  const reporter_id = req.session.user.id;
  
  if (!target_type || !target_id || !reason) {
    return res.status(400).json({ success: false, error: 'Все поля обязательны' });
  }

  // Check if reporter is report_banned
  try {
    const connection = await pool.getConnection();
    const [users] = await connection.query('SELECT report_banned_until FROM users WHERE id = ?', [reporter_id]);
    
    if (users.length > 0 && users[0].report_banned_until && new Date(users[0].report_banned_until) > new Date()) {
      // User is shadowbanned, pretend it succeeded
      connection.release();
      return res.json({ success: true, message: 'Жалоба успешно отправлена' });
    }
    
    let targetContent = null;
    if (target_type === 'pm') {
      const [r] = await connection.query('SELECT content FROM messages WHERE id = ?', [target_id]);
      if (r.length) targetContent = r[0].content;
    } else if (target_type === 'channel_comment') {
      const [r] = await connection.query('SELECT text FROM channel_comments WHERE id = ?', [target_id]);
      if (r.length) targetContent = r[0].text;
    } else if (target_type === 'record_comment') {
      const [r] = await connection.query('SELECT text FROM record_comments WHERE id = ?', [target_id]);
      if (r.length) targetContent = r[0].text;
    } else if (target_type === 'profile_comment') {
      const [r] = await connection.query('SELECT text FROM profile_comments WHERE id = ?', [target_id]);
      if (r.length) targetContent = r[0].text;
    }

    // Insert complaint
    await connection.query(
      'INSERT INTO complaints (reporter_id, target_type, target_id, reason, target_content) VALUES (?, ?, ?, ?, ?)',
      [reporter_id, target_type, target_id, reason.substring(0, 200), targetContent]
    );
    connection.release();
    
    res.json({ success: true, message: 'Жалоба успешно отправлена' });
  } catch (e) {
    console.error('Error submitting complaint:', e);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

const activeRecordings = new Map(); // channelId -> { process, startTime, title, recordId }

// Graceful cleanup on process exit
function cleanupActiveRecordings() {
  for (const [channelId, recording] of activeRecordings.entries()) {
    try {
      console.log(`Force stopping active recording for channel ${channelId} due to process exit`);
      recording.process.kill('SIGINT');
    } catch (e) {
      console.error(`Error killing record process for channel ${channelId}:`, e);
    }
  }
}
process.on('SIGTERM', cleanupActiveRecordings);
process.on('SIGINT', cleanupActiveRecordings);

router.post('/api/panel/records/record/start', panelMiddleware, async (req, res) => {
  const channelId = res.locals.panelChannel.id;
  const channelName = res.locals.panelChannel.name;
  const shortname = res.locals.panelChannel.shortname;
  
  const isVerified = res.locals.panelChannel.is_verified;
  const isPremium = res.locals.panelChannel.is_premium;
  const recordLimitSeconds = (isVerified || isPremium) ? 3600 : 300;
  
  if (activeRecordings.has(channelId)) {
    return res.status(400).json({ success: false, error: 'Запись этого эфира уже идет.' });
  }

  try {
    const [channelRows] = await pool.query('SELECT is_live FROM channels WHERE id = ?', [channelId]);
    if (channelRows.length === 0 || !channelRows[0].is_live) {
      return res.status(400).json({ success: false, error: 'Трансляция не запущена.' });
    }

    const streamUrl = `${process.env.RTMP_LOCAL_STREAM_URL || process.env.RTMP_STREAM_URL || 'http://localhost:8080/live'}/${shortname}/index.m3u8`;

    const now = new Date();
    const formattedDate = now.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' +
                          now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const recordTitle = `Запись эфира от ${formattedDate}`;
    const recordDesc = `Записано через панель управления.`;
    
    const timestamp = Date.now();
    const videoFilename = `record_live_${channelId}_${timestamp}.mp4`;
    const videoUrl = `/uploads/records/${videoFilename}`;
    const thumbnailFilename = `thumb_record_live_${channelId}_${timestamp}.jpg`;
    const thumbnailUrl = `/uploads/records/${thumbnailFilename}`;

    const storageRoot = path.join(__dirname, '..', '..', 'public');
    const outputPath = path.join(storageRoot, 'uploads', 'records', videoFilename);

    const recordsDir = path.dirname(outputPath);
    if (!fs.existsSync(recordsDir)) {
      fs.mkdirSync(recordsDir, { recursive: true });
    }

    const [insertResult] = await pool.query(
      'INSERT INTO records (channel_id, title, description, video_url, thumbnail_url, duration, size_bytes, processing_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [channelId, recordTitle, recordDesc, videoUrl, thumbnailUrl, 0, 0, 'recording']
    );
    const recordId = insertResult.insertId;

    const ffmpeg = require('fluent-ffmpeg');
    
    const ffmpegProcess = ffmpeg(streamUrl)
      .output(outputPath)
      .outputOptions([
        '-c', 'copy',
        '-t', recordLimitSeconds.toString()
      ])
      .on('start', (cmd) => {
        console.log(`Started ffmpeg recording for channel ${channelId}: ${cmd}`);
      })
      .on('end', async () => {
        console.log(`FFmpeg recording ended for channel ${channelId}, record ID: ${recordId}`);
        activeRecordings.delete(channelId);

        let sizeBytes = 0;
        try {
          if (fs.existsSync(outputPath)) {
            const stats = fs.statSync(outputPath);
            sizeBytes = stats.size;
          }
        } catch (e) {
          console.error('Error getting recorded file size:', e);
        }

        if (sizeBytes > 0) {
          await pool.query('UPDATE records SET size_bytes = ?, processing_status = ? WHERE id = ?', [sizeBytes, 'pending', recordId]);
          const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
          logAction('team', req.session.user.username, `Завершил запись эфира (ID: ${recordId}, Название: "${recordTitle}") на канале ${shortname}`, userIp);
        } else {
          await pool.query('UPDATE records SET processing_status = ? WHERE id = ?', ['error', recordId]);
          try {
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
          } catch(e) {}
        }
      })
      .on('error', async (err) => {
        console.log(`FFmpeg recording error/exit for channel ${channelId}, record ID: ${recordId}:`, err.message);
        activeRecordings.delete(channelId);

        let sizeBytes = 0;
        try {
          if (fs.existsSync(outputPath)) {
            const stats = fs.statSync(outputPath);
            sizeBytes = stats.size;
          }
        } catch (e) {}

        if (sizeBytes > 0) {
          await pool.query('UPDATE records SET size_bytes = ?, processing_status = ? WHERE id = ?', [sizeBytes, 'pending', recordId]);
          const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
          logAction('team', req.session.user.username, `Завершил запись эфира (ID: ${recordId}, Название: "${recordTitle}") на канале ${shortname}`, userIp);
        } else {
          await pool.query('UPDATE records SET processing_status = ? WHERE id = ?', ['error', recordId]);
          try {
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
          } catch(e) {}
        }
      });

    ffmpegProcess.run();

    activeRecordings.set(channelId, {
      process: ffmpegProcess,
      startTime: Date.now(),
      title: recordTitle,
      recordId: recordId
    });

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Начал запись эфира (ID: ${recordId}, Название: "${recordTitle}") на канале ${shortname}`, userIp);

    res.json({ success: true, recordId });
  } catch (e) {
    console.error('Error starting record:', e);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера.' });
  }
});

router.post('/api/panel/records/record/stop', panelMiddleware, async (req, res) => {
  const channelId = res.locals.panelChannel.id;
  const recording = activeRecordings.get(channelId);

  if (!recording) {
    return res.status(400).json({ success: false, error: 'Активная запись не найдена.' });
  }

  try {
    console.log(`Manually stopping recording for channel ${channelId}`);
    recording.process.kill('SIGINT');
    res.json({ success: true });
  } catch (e) {
    console.error('Error stopping record:', e);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера.' });
  }
});

router.get('/api/panel/records/record/status', panelMiddleware, async (req, res) => {
  const channelId = res.locals.panelChannel.id;
  const recording = activeRecordings.get(channelId);

  if (recording) {
    const elapsedSeconds = Math.floor((Date.now() - recording.startTime) / 1000);
    res.json({
      success: true,
      recording: true,
      elapsed: elapsedSeconds,
      maxDuration: 300,
      title: recording.title,
      recordId: recording.recordId
    });
  } else {
    res.json({
      success: true,
      recording: false
    });
  }
});

router.get('/api/admin/check-media-server', async (req, res) => {
  if (!req.session.user || !['admin', 'moderator', 'mod'].includes(req.session.user.staff_role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const axios = require('axios');
    const response = await axios.get('http://192.168.90.5:8000/api/streams', {
      auth: {
        username: process.env.RTMP_API_USER || 'admin',
        password: process.env.RTMP_API_PASS || 'admin'
      },
      timeout: 3000
    });
    if (response.status === 200) {
      return res.json({ success: true, message: 'Подключение к медиасерверу успешно выполнено' });
    } else {
      return res.json({ success: false, message: `Медиасервер вернул статус: ${response.status}` });
    }
  } catch (error) {
    return res.json({ success: false, message: `Ошибка подключения к медиасерверу: ${error.message}` });
  }
});

module.exports = router;
