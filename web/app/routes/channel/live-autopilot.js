// Live autopilot status API
const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const { canViewChannelContent } = require('../../../utils/channelAccess');

router.get('/api/channels/:id/autopilot_status', async (req, res) => {
  try {
    const channelId = req.params.id;
    const [channels] = await pool.query('SELECT id, user_id, shortname, access_level, autopilot_enabled, autopilot_album_id, autopilot_start_time, is_live, is_live_1, is_live_2, is_live_3, live_title, live_started_at, hide_live_badge, max_streams FROM channels WHERE id = ?', [channelId]);

    if (channels.length === 0) {
      console.log(`[AUTOPILOT] Channel ${channelId} not found`);
      return res.json({ active: false });
    }

    const channel = channels[0];
    if (!canViewChannelContent(req, channel)) {
      return res.status(403).json({ active: false, error: 'locked' });
    }

    let totalPrograms = 0;
    try {
      const [pCountRows] = await pool.query('SELECT COUNT(*) as cnt FROM programs WHERE channel_id = ? AND start_time >= NOW() - INTERVAL 2 HOUR AND (is_hidden = 0 OR is_hidden IS NULL)', [channelId]);
      totalPrograms = pCountRows[0].cnt;
    } catch (e) {
      console.error(e);
    }

    const isOwner = req.session && req.session.user && req.session.user.id === channel.user_id;

    if (channel.is_live === 1) {
      const activeStreams = [];
      if (channel.is_live_1) activeStreams.push(1);
      if (channel.is_live_2) activeStreams.push(2);
      if (channel.is_live_3) activeStreams.push(3);
      if (activeStreams.length === 0) activeStreams.push(1);

      const highUrl = `${process.env.RTMP_STREAM_URL || 'http://localhost:8080/live'}/${channel.shortname.toLowerCase()}/index.m3u8`;
      const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
      const rtmp_url = (process.env.LIVE_ABR_ENABLED === '1' && appUrl)
        ? `${appUrl}/api/channels/${channelId}/live_master.m3u8`
        : highUrl;

      // Stream is live, override autopilot and return RTMP HLS stream URL
      return res.json({
        active: true,
        is_live: true,
        abr_enabled: process.env.LIVE_ABR_ENABLED === '1',
        autopilot_enabled: channel.autopilot_enabled,
        live_title: channel.live_title,
        live_started_at: channel.live_started_at,
        is_owner: isOwner,
        shortname: channel.shortname,
        totalPrograms: totalPrograms,
        hide_live_badge: channel.hide_live_badge === 1,
        active_streams: activeStreams,
        max_streams: channel.max_streams || 1,
        rtmp_url
      });
    }

    if (!channel.autopilot_enabled || !channel.autopilot_album_id) {
      console.log(`[AUTOPILOT] Channel ${channelId} inactive because is_live=${channel.is_live}, enabled=${channel.autopilot_enabled}, album_id=${channel.autopilot_album_id}`);
      return res.json({ active: false, autopilot_enabled: channel.autopilot_enabled, totalPrograms: totalPrograms });
    }

    const [records] = await pool.query(`
      SELECT r.id, r.title, r.video_url, r.hls_url, r.duration, ar.order_index 
      FROM album_records ar 
      JOIN records r ON ar.record_id = r.id 
      WHERE ar.album_id = ? AND ((r.video_url IS NOT NULL AND r.video_url != '') OR (r.hls_url IS NOT NULL AND r.hls_url != ''))
        AND (r.access_level = 'public' OR r.access_level IS NULL OR r.access_level = '')
      ORDER BY ar.order_index ASC, ar.created_at ASC
    `, [channel.autopilot_album_id]);

    if (records.length === 0) {
      console.log(`[AUTOPILOT] Album ${channel.autopilot_album_id} has no valid records`);
      return res.json({ active: false, totalPrograms: totalPrograms });
    }

    let totalDuration = 0;
    for (const rec of records) {
      if (!rec.duration || rec.duration <= 0) rec.duration = 3600; // 1 hour fallback
      totalDuration += rec.duration;
    }

    const startTime = new Date(channel.autopilot_start_time || Date.now()).getTime();
    const now = Date.now();
    let deltaSecs = Math.floor((now - startTime) / 1000);

    if (deltaSecs < 0) deltaSecs = 0;

    let currentOffset = deltaSecs % totalDuration;

    let currentVideo = null;
    let offsetInVideo = 0;

    let runningSum = 0;
    for (const rec of records) {
      const dur = rec.duration || 0;
      if (currentOffset >= runningSum && currentOffset < runningSum + dur) {
        currentVideo = rec;
        offsetInVideo = currentOffset - runningSum;
        break;
      }
      runningSum += dur;
    }

    if (!currentVideo) {
      currentVideo = records[0];
      offsetInVideo = 0;
    }

    const nextUpdateIn = (currentVideo.duration || 0) - offsetInVideo;

    res.json({
      active: true,
      autopilot_enabled: channel.autopilot_enabled,
      video: {
        id: currentVideo.id,
        title: currentVideo.title,
        video_url: currentVideo.video_url ? `${process.env.CDN_BASE_URL || ''}${currentVideo.video_url}` : null,
        hls_url: currentVideo.hls_url ? `${process.env.CDN_BASE_URL || ''}${currentVideo.hls_url}` : null,
        duration: currentVideo.duration
      },
      offset: offsetInVideo,
      nextUpdateIn: nextUpdateIn,
      totalPrograms: totalPrograms,
      hide_live_badge: channel.hide_live_badge === 1
    });

  } catch (e) {
    console.error('[AUTOPILOT] Error:', e);
    res.json({ active: false, error: e.message, totalPrograms: 0 });
  }
});

module.exports = router;
