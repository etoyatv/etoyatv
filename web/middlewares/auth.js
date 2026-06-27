const { pool } = require('../config/db');

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

const globalAuthMiddleware = async (req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.unreadMessagesCount = 0;
  if (req.session.user && req.session.user.id) {
    try {
      const connection = await pool.getConnection();
      const [u] = await connection.query('SELECT role, chat_color, is_banned, banned_until, deleted_at FROM users WHERE id = ?', [req.session.user.id]);
      if (u.length > 0) {
        const userData = u[0];
        
        // Check if user is deleted or banned
        const now = new Date();
        const isBanned = userData.is_banned && (!userData.banned_until || new Date(userData.banned_until) > now);
        
        if (userData.deleted_at || isBanned || (req.ip_ban && req.ip_ban.ban_type === 'account')) {
          connection.release();
          req.session.destroy();
          return res.redirect('/');
        }

        req.session.user.role = userData.role;
        req.session.user.chat_color = userData.chat_color;
      } else {
        // User not found in DB
        connection.release();
        req.session.destroy();
        return res.redirect('/login');
      }
      const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
      await connection.query('UPDATE users SET last_active = NOW(), last_ip = ? WHERE id = ?', [userIp, req.session.user.id]);
      const [unreadRows] = await connection.query('SELECT COUNT(*) as count FROM messages WHERE receiver_id = ? AND is_read = 0', [req.session.user.id]);
      res.locals.unreadMessagesCount = unreadRows[0].count;

      const [newsRows] = await connection.query('SELECT * FROM news ORDER BY created_at DESC LIMIT 5');

      const [channelRows] = await connection.query("SELECT * FROM channels WHERE user_id = ? AND status IN ('active', 'banned') LIMIT 1", [req.session.user.id]);
      res.locals.userChannel = channelRows.length > 0 ? channelRows[0] : null;

      const [teamRows] = await connection.query("SELECT c.id FROM channels c JOIN channel_team t ON c.id = t.channel_id WHERE t.user_id = ? AND c.status IN ('active', 'banned') AND (t.is_editor = 1 OR t.is_reporter = 1) LIMIT 1", [req.session.user.id]);
      res.locals.hasPanelAccess = res.locals.userChannel !== null || teamRows.length > 0;

      const [staffRows] = await connection.query("SELECT role, mask_mode FROM staff WHERE user_id = ?", [req.session.user.id]);
      if (staffRows.length > 0) {
        req.session.user.staff_role = staffRows[0].role;
        req.session.user.mask_mode = staffRows[0].mask_mode;
        res.locals.user.staff_role = staffRows[0].role;
        res.locals.user.mask_mode = staffRows[0].mask_mode;
      }

      connection.release();
    } catch (e) {
      console.error('Error in global middleware:', e);
    }
  }
  next();
};

module.exports = { requireAuth, globalAuthMiddleware };
