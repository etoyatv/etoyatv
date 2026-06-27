const { pool } = require('../config/db');

async function sendSystemMessage(receiverId, content) {
  try {
    const systemUsername = 'Администрация ЭтоЯTV';
    const [rows] = await pool.query('SELECT id FROM users WHERE username = ?', [systemUsername]);
    let systemUserId;
    
    if (rows.length > 0) {
      systemUserId = rows[0].id;
    } else {
      // Create system user
      const [insertResult] = await pool.query(`
        INSERT INTO users (username, email, password, role, is_verified, created_at, avatar) 
        VALUES (?, ?, ?, ?, ?, NOW(), ?)
      `, [
        systemUsername, 
        'system@etoyatv.ru', 
        'system_no_login_pw', 
        'admin', 
        1,
        '/images/default_avatar.png'
      ]);
      systemUserId = insertResult.insertId;
    }

    await pool.query(
      'INSERT INTO messages (sender_id, receiver_id, content, created_at) VALUES (?, ?, ?, NOW())', 
      [systemUserId, receiverId, content]
    );
  } catch (error) {
    console.error('Failed to send system message:', error);
  }
}

module.exports = sendSystemMessage;
