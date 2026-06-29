require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcrypt');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const crypto = require('crypto');
const emailService = require('../emailService');
const http = require('http');
const { Server } = require('socket.io');

const geoip = require('geoip-lite');
const port = process.env.PORT || 3001;

const app = express();
app.set('trust proxy', 1);

app.use((req, res, next) => {
  let ipHeader = req.headers['x-forwarded-for'];
  if (ipHeader) {
    if (Array.isArray(ipHeader)) {
      ipHeader = ipHeader[0];
    }
    if (typeof ipHeader === 'string') {
      req.headers['x-forwarded-for'] = ipHeader.split(',')[0].trim();
    }
  }
  next();
});

app.locals.CDN_BASE_URL = process.env.CDN_BASE_URL || '';
app.locals.RTMP_STREAM_URL = process.env.RTMP_STREAM_URL || 'http://localhost:8080/live';
app.locals.RTMP_INGEST_URL = process.env.RTMP_INGEST_URL || 'rtmp://localhost/live';
app.locals.ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:3002';


const server = http.createServer(app);
const { requireAuth, globalAuthMiddleware } = require('../middlewares/auth');
const { panelMiddleware, recordUploadMiddleware, designUploadMiddleware } = require('../middlewares/panel');
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});
app.set('io', io);

const { upload, uploadDesign, uploadRecord } = require('../config/upload');
// Set EJS as templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use('/chat-assets', express.static(path.join(__dirname, '../public/js')));

app.use(express.static(path.join(__dirname, '../public'), {
  maxAge: '30d',
  etag: true,
  lastModified: true,
  setHeaders: (res, path) => {
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  }
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Disable caching for all dynamic routes
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

const { pool, initDbPromise } = require('../config/db');

const MySQLStore = require('express-mysql-session')(session);
const sessionStore = new MySQLStore({
  clearExpired: true,
  checkExpirationInterval: 900000,
  expiration: 2592000000, // 30 days
  createDatabaseTable: false
}, pool);

app.use(session({
  key: 'etoyatv_session_v2',
  secret: process.env.SESSION_SECRET || 'etoyatv_secret_key',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 2592000000, domain: '.etoyatv.top' } // 30 days
}));

// Override res.redirect to always save session first
// This fixes the "double click" bug where the redirect happens before session is written to DB
app.use((req, res, next) => {
  const originalRedirect = res.redirect;
  res.redirect = function() {
    const args = arguments;
    if (req.session) {
      req.session.save(() => {
        originalRedirect.apply(res, args);
      });
    } else {
      originalRedirect.apply(res, args);
    }
  };
  next();
});

// Middleware to log 500 errors from the main app into system_logs
app.use((req, res, next) => {
  const originalStatus = res.status;
  res.status = function(code) {
    if (code === 500) {
      const { logAction } = require('../utils/logger');
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
      const user = req.session && req.session.user ? req.session.user.username : 'Неизвестный';
      const action = `Произошла внутренняя ошибка сервера (500) в главном приложении при запросе к ${req.originalUrl}`;
      
      logAction('system', user, action, ip).catch(err => console.error('Error logging system event:', err));
    }
    return originalStatus.apply(res, arguments);
  };
  next();
});

// Pass variables to all templates
app.use(async (req, res, next) => {
  if (req.session && req.session.user) {
    try {
      const { pool } = require('../config/db');
      const [users] = await pool.query('SELECT username, email, role, timezone, chat_color, avatar FROM users WHERE id = ?', [req.session.user.id]);
      if (users.length > 0) {
        const u = users[0];
        req.session.user.username = u.username;
        req.session.user.email = u.email;
        req.session.user.role = u.role;
        req.session.user.timezone = u.timezone;
        req.session.user.chat_color = u.chat_color;
        req.session.user.avatar = u.avatar;
      }
    } catch (e) {
      console.error('Error refreshing user session:', e);
    }
  }

  if (req.session && req.session.user && req.session.user.staff_role) {
    try {
      const { pool } = require('../config/db');
      const [staff] = await pool.query('SELECT role, is_superadmin, mask_mode FROM staff WHERE user_id = ?', [req.session.user.id]);
      if (staff.length === 0) {
        delete req.session.user.staff_role;
        delete req.session.user.is_superadmin;
        delete req.session.user.mask_mode;
      } else {
        req.session.user.staff_role = staff[0].role;
        req.session.user.is_superadmin = staff[0].is_superadmin === 1;
        req.session.user.mask_mode = staff[0].mask_mode;
      }
    } catch (e) {
      console.error('Error verifying staff session status:', e);
    }
  }

  res.locals.user = req.session && req.session.user ? req.session.user : null;
  res.locals.currentPath = req.path;
  res.locals.CDN_BASE_URL = process.env.CDN_BASE_URL || '';
  res.locals.APP_URL = process.env.APP_URL || 'http://localhost:3001';
  res.locals.ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:3002';
  res.locals.HCAPTCHA_SITEKEY = process.env.HCAPTCHA_SITEKEY || '7d8ab54a-d248-41ac-89b8-abecc204de9e';
  try {
    const { pool } = require('../config/db');
    const [rows] = await pool.query('SELECT setting_key, setting_value FROM system_settings');
    const settings = {};
    for (const row of rows) {
      settings[row.setting_key] = row.setting_value;
    }
    res.locals.systemSettings = settings;
    res.locals.invite_system_enabled = settings['invite_system_enabled'] === '1';
    
    let parsedAds = {};
    try {
      if (settings['ads_config']) {
        const rawAds = JSON.parse(settings['ads_config']);
        for (const [slot, ads] of Object.entries(rawAds)) {
          let selectedAd = null;
          if (Array.isArray(ads) && ads.length > 0) {
            selectedAd = ads[Math.floor(Math.random() * ads.length)];
          } else if (!Array.isArray(ads)) {
            selectedAd = ads;
          }
          if (selectedAd && selectedAd.image && selectedAd.image.startsWith('/')) {
            selectedAd.image = res.locals.CDN_BASE_URL + selectedAd.image;
          }
          parsedAds[slot] = selectedAd;
        }
      }
    } catch(e) {}
    res.locals.adsConfig = parsedAds;
    res.locals.adsEnabled = settings['ads_enabled'] === '1';

  } catch (err) {
    res.locals.systemSettings = {};
    res.locals.invite_system_enabled = false;
    res.locals.adsConfig = {};
    res.locals.adsEnabled = false;
  }
  next();
});

// Site disabled middleware
app.use(async (req, res, next) => {
  if (req.path.startsWith('/api/internal/')) return next();
  const isSiteDisabled = res.locals.systemSettings && res.locals.systemSettings['site_disabled'] === '1';
  if (isSiteDisabled) {
    const user = res.locals.user;
    if (user) {
      try {
        const { pool } = require('../config/db');
        const [staff] = await pool.query('SELECT role FROM staff WHERE user_id = ?', [user.id]);
        if (staff.length > 0) {
          return next(); // Staff can access
        }
      } catch (e) {
        console.error('Error checking staff role for site_disabled:', e);
      }
    }
    // For non-staff or guests, show disabled message
    const msg = res.locals.systemSettings['site_disabled_message'] || 'Сайт временно отключен.';
    return res.status(503).render('error', { 
      status: 503, 
      title: 'Сайт отключен', 
      message: msg 
    });
  }
  next();
});

// --- TIMEZONE SYSTEM ---
app.locals.formatDate = (dateString, timezone = 'Europe/Moscow', formatStr = 'DD.MM.YYYY') => {
  if (!dateString) return '';
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return '';

  try {
    if (formatStr === 'DD.MM.YYYY') {
      const options = { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: timezone };
      return new Intl.DateTimeFormat('ru-RU', options).format(date);
    } else if (formatStr === 'DD.MM.YYYY HH:mm') {
      const options = { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: timezone };
      return new Intl.DateTimeFormat('ru-RU', options).format(date).replace(',', ' в');
    } else if (formatStr === 'DD MMMM YYYY') {
      const options = { day: '2-digit', month: 'long', year: 'numeric', timeZone: timezone };
      return new Intl.DateTimeFormat('ru-RU', options).format(date);
    } else if (formatStr === 'HH:mm') {
      const options = { hour: '2-digit', minute: '2-digit', timeZone: timezone };
      return new Intl.DateTimeFormat('ru-RU', options).format(date);
    } else if (formatStr === 'DD.MM') {
      const options = { day: '2-digit', month: '2-digit', timeZone: timezone };
      return new Intl.DateTimeFormat('ru-RU', options).format(date);
    } else if (formatStr === 'DD MMM') {
      const options = { day: '2-digit', month: 'short', timeZone: timezone };
      return new Intl.DateTimeFormat('ru-RU', options).format(date);
    } else if (formatStr === 'DD MMMM') {
      const options = { day: '2-digit', month: 'long', timeZone: timezone };
      return new Intl.DateTimeFormat('ru-RU', options).format(date);
    }
  } catch (e) {
    return new Intl.DateTimeFormat('ru-RU').format(date);
  }
  return '';
};

app.locals.escapeHtml = (unsafe) => {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

app.use((req, res, next) => {
  res.locals.userTimezone = (req.session && req.session.user && req.session.user.timezone) 
                            ? req.session.user.timezone 
                            : 'Europe/Moscow';
  next();
});
// -----------------------

const { isIpInBanRecord } = require('../utils/ipChecker');

app.use(async (req, res, next) => {
  const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
  if (!userIp) return next();
  try {
    const { pool } = require('../config/db');
    const connection = await pool.getConnection();
    
    const [bans] = await connection.query('SELECT ip_address, ban_type, reason FROM ip_bans');
    connection.release();

    const matchedBan = bans.find(b => isIpInBanRecord(userIp, b.ip_address));

    if (matchedBan) {
      req.ip_ban = matchedBan;
      if (matchedBan.ban_type === 'full') {
        return res.status(403).send(`
          <div style="font-family: sans-serif; text-align: center; padding: 50px; background: #121212; color: white; height: 100vh;">
            <h1>Доступ запрещен</h1>
            <p>Ваш IP-адрес был полностью заблокирован администрацией сайта.</p>
            <p>Причина: <strong>${matchedBan.reason || 'не указана'}</strong></p>
          </div>
        `);
      }
    }
  } catch (e) {
    console.error('IP check error:', e);
  }
  next();
});

app.use(globalAuthMiddleware);




// Background job to collect viewer stats every 5 minutes
async function collectViewerStats() {
  try {
    const connection = await pool.getConnection();
    const [activeChannels] = await connection.query("SELECT id, viewers, is_live FROM channels WHERE status = 'active'");
    let totalViewers = 0;
    if (activeChannels.length > 0) {
      const values = activeChannels.map(c => {
        const v = c.is_live ? (c.viewers || 0) : 0;
        totalViewers += v;
        return [c.id, v];
      });
      await connection.query("INSERT INTO channel_viewer_stats (channel_id, viewer_count) VALUES ?", [values]);
    }
    
    // Save site-wide stats
    const totalConnections = io.engine.clientsCount || 0;
    await connection.query("INSERT INTO stats_snapshots (users_online, viewers_online) VALUES (?, ?)", [totalConnections, totalViewers]);
    
    connection.release();
  } catch (err) {
    console.error('Error collecting stats:', err);
  }
}
setInterval(collectViewerStats, 5 * 60 * 1000);
setTimeout(collectViewerStats, 5000); // Run slightly after start

async function autoUnbanChannels() {
  try {
    const connection = await pool.getConnection();
    await connection.query('UPDATE channels SET status = ?, banned_until = NULL, ban_reason = NULL WHERE status = ? AND banned_until IS NOT NULL AND banned_until < NOW()', ['active', 'banned']);
    connection.release();
  } catch (err) {
    console.error('Error auto-unbanning channels:', err);
  }
}
setInterval(autoUnbanChannels, 60 * 1000); // Check every minute

const { runCleanup } = require('../utils/cleanup');
setInterval(runCleanup, 5 * 60 * 60 * 1000); // Check every 5 hours
setTimeout(runCleanup, 10000); // Run once shortly after startup

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const csrf = require('csurf');

// Helmet for basic security headers (disabling CSP to not break inline scripts)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  frameguard: false
}));

// Apply X-Frame-Options: SAMEORIGIN to all routes except widget views
app.use((req, res, next) => {
  if (!req.path.startsWith('/widget/')) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  }
  next();
});

// Rate limiting for auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 requests per IP
  message: 'Слишком много попыток входа с этого IP, пожалуйста, подождите 15 минут.'
});
app.use('/login', authLimiter);
app.use('/register', authLimiter);
app.use('/forgot-password', authLimiter);
app.use('/reset-password', authLimiter);
app.use('/account/2fa/verify', authLimiter);

// CSRF Protection
const csrfProtection = csrf({ cookie: false });
app.use((req, res, next) => {
  // Exclude API routes and internal webhooks from CSRF
  if (req.path.startsWith('/api/internal/rtmp') || req.path.startsWith('/api/')) return next();
  csrfProtection(req, res, next);
});

// CSRF error handler
app.use((err, req, res, next) => {
  if (err.code !== 'EBADCSRFTOKEN') return next(err);
  res.status(403).send('Отказано в доступе: недействительный CSRF токен. Пожалуйста, вернитесь назад, обновите страницу и попробуйте еще раз.');
});

// Transparent CSRF injection into forms
app.use((req, res, next) => {
  if (req.csrfToken) {
    const token = req.csrfToken();
    res.locals.csrfToken = token;
    
    const originalRender = res.render;
    res.render = function(view, options, callback) {
      const self = this;
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      options = options || {};
      options.csrfToken = token;
      
      originalRender.call(this, view, options, function(err, html) {
        if (err) {
          if (callback) return callback(err);
          return self.req.next(err);
        }
        
        // Inject CSRF token into all POST forms automatically using robust regex
        if (html && html.includes('<form')) {
          html = html.replace(/(<form\b(?:[^>"']|"[^"]*"|'[^']*')*>)/gi, (match) => {
            if (/method=['"]?POST['"]?/i.test(match)) {
              if (/enctype=['"]?multipart\/form-data['"]?/i.test(match)) {
                if (/action=['"]([^'"]*)['"]/i.test(match)) {
                  match = match.replace(/(action=['"])([^'"]*)(['"])/i, (m, p1, p2, p3) => {
                    const sep = p2.includes('?') ? '&' : '?';
                    return `${p1}${p2}${sep}_csrf=${token}${p3}`;
                  });
                }
              } else {
                match = match + `\n<input type="hidden" name="_csrf" value="${token}">`;
              }
            }
            return match;
          });
        }

        // Inject fetch override to automatically send CSRF token
        if (html && html.includes('</head>')) {
          const fetchOverride = `
<script>
  window.csrfToken = "${token}";
  const originalFetch = window.fetch;
  window.fetch = function(resource, config) {
    config = config || {};
    if (config.method && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(config.method.toUpperCase())) {
      config.headers = config.headers || {};
      if (config.headers instanceof Headers) {
        config.headers.append('X-CSRF-Token', window.csrfToken);
      } else {
        config.headers['X-CSRF-Token'] = window.csrfToken;
      }
    }
    return originalFetch(resource, config);
  };
</script>`;
          html = html.replace('</head>', fetchOverride + '\n</head>');
        }
        
        if (callback) return callback(null, html);
        self.send(html);
      });
    };
  }
  next();
});

// Mounting all route modules
app.use('/', require('./routes/public'));
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/account'));
app.use('/', require('./routes/panel'));
app.use('/', require('./routes/channel'));
app.use('/', require('./routes/records'));
app.use('/', require('./routes/api'));
app.use('/', require('./routes/404'));

require('./routes/chat')(io);

// Start the server
initDbPromise.then(() => {
  // Reset any records with 'recording' status (e.g. if the server crashed or was restarted)
  pool.query("UPDATE records SET processing_status = 'error' WHERE processing_status = 'recording'")
    .then(([result]) => {
      if (result.affectedRows > 0) {
        console.log(`Reset ${result.affectedRows} stuck 'recording' records to 'error'.`);
      }
    })
    .catch(err => {
      console.error('Error resetting stuck recording records:', err);
    });

  server.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on port ${port}`);
  });
});
