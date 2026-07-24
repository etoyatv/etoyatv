const express = require('express');
const router = express.Router();
const { pool } = require('../../config/db');

// Helper function to resolve relative paths to absolute URLs (CDN or APP base)
function getFullUrl(relativeUrl) {
  if (!relativeUrl) return null;
  if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) return relativeUrl;
  const baseUrl = (process.env.CDN_BASE_URL || process.env.APP_URL || '').replace(/\/+$/, '');
  const cleanRelative = relativeUrl.startsWith('/') ? relativeUrl : `/${relativeUrl}`;
  return `${baseUrl}${cleanRelative}`;
}

// Format channel data with absolute URLs
function formatChannel(channel) {
  return {
    id: channel.id,
    name: channel.name,
    shortname: channel.shortname,
    description: channel.description,
    is_live: Boolean(channel.is_live),
    viewers: channel.viewers || 0,
    logo_url: getFullUrl(channel.logo_url),
    banner_url: getFullUrl(channel.banner_url),
    is_18_plus: Boolean(channel.is_18_plus),
    is_verified: Boolean(channel.is_verified),
    is_premium: Boolean(channel.is_premium),
    bg_color: channel.bg_color,
    text_color: channel.text_color,
    player_bg_url: getFullUrl(channel.player_bg_url),
    player_bg_color: channel.player_bg_color,
    live_title: channel.live_title || null,
    created_at: channel.created_at
  };
}

// -------------------------------------------------------------
// PUBLIC DEVELOPER API ENDPOINTS
// -------------------------------------------------------------

// GET /api/public/channels - List of active public channels
router.get('/api/public/channels', async (req, res) => {
  try {
    let query = `
      FROM channels 
      WHERE status = 'active' AND access_level = 'public'
    `;
    const params = [];

    // Filter by name/shortname search query
    if (req.query.q) {
      query += ' AND (name LIKE ? OR shortname LIKE ?)';
      const pattern = `%${req.query.q}%`;
      params.push(pattern, pattern);
    }

    // Filter by live status
    if (req.query.live === '1') {
      query += ' AND (is_live = 1 OR autopilot_enabled = 1)';
    } else if (req.query.live === '0') {
      query += ' AND is_live = 0 AND autopilot_enabled = 0';
    }

    // Get total count for pagination
    const [countRows] = await pool.query(`SELECT COUNT(*) as count ${query}`, params);
    const total = countRows[0].count;

    // Pagination limits
    let limit = parseInt(req.query.limit) || 20;
    if (limit < 1) limit = 20;
    if (limit > 100) limit = 100;
    let offset = parseInt(req.query.offset) || 0;
    if (offset < 0) offset = 0;

    // Retrieve channels
    const channelsQuery = `
      SELECT id, name, shortname, description, is_live, viewers, logo_url, banner_url, 
             is_18_plus, is_verified, is_premium, bg_color, text_color, player_bg_url, player_bg_color, live_title, created_at
      ${query}
      ORDER BY is_live DESC, is_verified DESC, is_premium ASC, viewers DESC 
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);

    const [rows] = await pool.query(channelsQuery, params);
    const formattedChannels = rows.map(formatChannel);

    res.json({
      success: true,
      channels: formattedChannels,
      pagination: {
        limit,
        offset,
        total
      }
    });
  } catch (e) {
    console.error('Error fetching public channels API:', e);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/public/channels/:shortname - Single channel detailed info
router.get('/api/public/channels/:shortname', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT id, name, shortname, description, is_live, viewers, logo_url, banner_url, 
             is_18_plus, is_verified, is_premium, bg_color, text_color, player_bg_url, player_bg_color, live_title, created_at
      FROM channels
      WHERE shortname = ? AND status = 'active' AND access_level = 'public'
    `, [req.params.shortname]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Channel not found' });
    }

    res.json({
      success: true,
      channel: formatChannel(rows[0])
    });
  } catch (e) {
    console.error('Error fetching public channel details API:', e);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/public/channels/:shortname/schedule - Program guide for the channel
router.get('/api/public/channels/:shortname/schedule', async (req, res) => {
  try {
    const [chan] = await pool.query(`
      SELECT id FROM channels 
      WHERE shortname = ? AND status = 'active' AND access_level = 'public'
    `, [req.params.shortname]);

    if (chan.length === 0) {
      return res.status(404).json({ success: false, error: 'Channel not found' });
    }

    const channelId = chan[0].id;
    let query = 'SELECT id, title, description, start_time, created_at FROM programs WHERE channel_id = ?';
    const params = [channelId];

    if (req.query.date) {
      query += ' AND DATE(start_time) = ?';
      params.push(req.query.date);
    } else {
      query += ' AND start_time >= DATE_SUB(NOW(), INTERVAL 2 HOUR)';
    }

    query += ' ORDER BY start_time ASC';
    const [programs] = await pool.query(query, params);

    res.json({
      success: true,
      schedule: programs
    });
  } catch (e) {
    console.error('Error fetching public channel schedule API:', e);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/public/channels/:shortname/news - Channel-specific news
router.get('/api/public/channels/:shortname/news', async (req, res) => {
  try {
    const [chan] = await pool.query(`
      SELECT id FROM channels 
      WHERE shortname = ? AND status = 'active' AND access_level = 'public'
    `, [req.params.shortname]);

    if (chan.length === 0) {
      return res.status(404).json({ success: false, error: 'Channel not found' });
    }

    const [news] = await pool.query(`
      SELECT id, title, announce, content, created_at 
      FROM channel_news 
      WHERE channel_id = ? AND is_hidden = 0 
      ORDER BY created_at DESC
    `, [chan[0].id]);

    res.json({
      success: true,
      news
    });
  } catch (e) {
    console.error('Error fetching public channel news API:', e);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/public/channels/:shortname/records - Processed broadcast records
router.get('/api/public/channels/:shortname/records', async (req, res) => {
  try {
    const [chan] = await pool.query(`
      SELECT id FROM channels 
      WHERE shortname = ? AND status = 'active' AND access_level = 'public'
    `, [req.params.shortname]);

    if (chan.length === 0) {
      return res.status(404).json({ success: false, error: 'Channel not found' });
    }

    const [records] = await pool.query(`
      SELECT id, title, description, video_url, thumbnail_url, duration, views, created_at 
      FROM records 
      WHERE channel_id = ? AND status NOT IN ('deleted', 'banned') AND access_level = 'public'
      ORDER BY created_at DESC
    `, [chan[0].id]);

    const formattedRecords = records.map(r => ({
      id: r.id,
      title: r.title,
      description: r.description,
      video_url: getFullUrl(r.video_url),
      thumbnail_url: getFullUrl(r.thumbnail_url),
      duration: r.duration,
      views: r.views,
      created_at: r.created_at
    }));

    res.json({
      success: true,
      records: formattedRecords
    });
  } catch (e) {
    console.error('Error fetching public channel records API:', e);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/public/streams - Current live streams list
router.get('/api/public/streams', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT id, name, shortname, description, is_live, viewers, logo_url, banner_url, 
             is_18_plus, is_verified, is_premium, bg_color, text_color, player_bg_url, player_bg_color, live_title, created_at
      FROM channels 
      WHERE status = 'active' AND access_level = 'public' AND (is_live = 1 OR autopilot_enabled = 1)
      ORDER BY viewers DESC
    `);

    res.json({
      success: true,
      streams: rows.map(formatChannel)
    });
  } catch (e) {
    console.error('Error fetching public streams API:', e);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/public/stats - Global statistics snapshot
router.get('/api/public/stats', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [chRows] = await connection.query("SELECT COUNT(*) as count FROM channels WHERE status = 'active' AND access_level = 'public'");
    const [liveRows] = await connection.query("SELECT COUNT(*) as count, SUM(viewers) as vCount FROM channels WHERE (is_live = 1 OR autopilot_enabled = 1) AND status = 'active' AND access_level = 'public'");
    const [recRows] = await connection.query("SELECT COUNT(*) as count FROM records WHERE status NOT IN ('deleted', 'banned')");
    connection.release();

    res.json({
      success: true,
      stats: {
        total_channels: chRows[0].count,
        live_channels: liveRows[0].count || 0,
        total_viewers: liveRows[0].vCount || 0,
        total_records: recRows[0].count
      }
    });
  } catch (e) {
    console.error('Error fetching public stats API:', e);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// -------------------------------------------------------------
// DEVELOPER DOCUMENTATION PAGE
// -------------------------------------------------------------

router.get('/developer', async (req, res) => {
  try {
    let hasChannel = false;
    if (req.session && req.session.user) {
      const [channelsData] = await pool.query("SELECT id FROM channels WHERE user_id = ? LIMIT 1", [req.session.user.id]);
      if (channelsData.length > 0) hasChannel = true;
    }
    
    res.render('developer_docs', {
      pageTitle: 'Документация API | ЭтоЯTV - Я есть телевидение!',
      hasChannel,
      APP_URL: process.env.APP_URL || 'https://etoyatv.top',
      CDN_BASE_URL: process.env.CDN_BASE_URL || 'https://cdn.etoyatv.top'
    });
  } catch (e) {
    console.error('Error rendering developer docs:', e);
    res.status(500).send('Server Error');
  }
});

module.exports = router;
