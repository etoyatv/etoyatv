const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const { panelMiddleware } = require('../../../middlewares/panel');

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

module.exports = router;
