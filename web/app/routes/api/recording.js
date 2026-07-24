const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { pool } = require('../../../config/db');
const { logAction } = require('../../../utils/logger');
const { panelMiddleware } = require('../../../middlewares/panel');

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

    const streamUrl = `${process.env.RTMP_LOCAL_STREAM_URL || process.env.RTMP_STREAM_URL || 'http://localhost:8080/live'}/${shortname.toLowerCase()}/index.m3u8`;

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

    const storageRoot = path.join(__dirname, '..', '..', '..', 'public');
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

module.exports = router;
