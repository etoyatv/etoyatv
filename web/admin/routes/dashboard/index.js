const express = require('express');
const router = express.Router();
const { requireAdminAuth } = require('../../middlewares/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configure multer for ads
const adStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = path.join(__dirname, '../../../public/uploads/ads');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    cb(null, 'ad_' + Date.now() + path.extname(file.originalname));
  }
});

const adUpload = multer({
  storage: adStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: function (req, file, cb) {
    const filetypes = /jpeg|jpg|png|gif/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Только изображения!'));
  }
});

// Apply auth middleware to all routes in this router
router.use(requireAdminAuth);

async function renderDashboard(req, res) {
  try {
    const { pool } = require('../../config/db');
    const connection = await pool.getConnection();

    const [[{ total_users }]] = await connection.query('SELECT COUNT(*) as total_users FROM users');
    const [[{ total_channels }]] = await connection.query('SELECT COUNT(*) as total_channels FROM channels');
    const [[{ total_news }]] = await connection.query('SELECT (SELECT COUNT(*) FROM news) + (SELECT COUNT(*) FROM channel_news) as total_news');
    const [[{ total_records }]] = await connection.query('SELECT COUNT(*) as total_records FROM records');

    const [[today_stats]] = await connection.query(`
      SELECT 
        COALESCE(ROUND(AVG(NULLIF(users_online, 0))), 0) as avg_users, MAX(users_online) as max_users,
        COALESCE(ROUND(AVG(NULLIF(viewers_online, 0))), 0) as avg_viewers, MAX(viewers_online) as max_viewers
      FROM stats_snapshots 
      WHERE timestamp >= NOW() - INTERVAL 24 HOUR
    `);

    const [graph_data] = await connection.query(`
      SELECT timestamp, users_online, viewers_online 
      FROM stats_snapshots 
      WHERE timestamp >= NOW() - INTERVAL 24 HOUR 
      ORDER BY timestamp ASC
    `);

    connection.release();

    res.render('dashboard', {
      currentPath: req.path,
      total_users,
      total_channels,
      total_news,
      total_records,
      today_stats: today_stats || { avg_users: 0, max_users: 0, avg_viewers: 0, max_viewers: 0 },
      graph_data: JSON.stringify(graph_data)
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сервера' });
  }
}

router.get('/', renderDashboard);

// Admin logout
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    // Redirect back to main site after logout
    res.redirect(process.env.APP_URL || 'http://localhost:3001/');
  });
});

// Mock routes for the top menu to prevent 404s
const mockPages = [];
mockPages.forEach(page => {
  router.get(page, renderDashboard);
});

router.use(require('./settings')(adUpload));
router.use(require('./users'));
router.use(require('./invites'));

module.exports = router;
