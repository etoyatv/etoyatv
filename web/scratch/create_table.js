require('dotenv').config();
const { pool } = require('../config/db');

async function run() {
  try {
    console.log('Connecting to database...');
    const query = `
      CREATE TABLE IF NOT EXISTS admin_notification_settings (
        user_id INT PRIMARY KEY,
        tg_chat_id VARCHAR(255) DEFAULT '',
        tg_bind_code VARCHAR(255) NULL,
        notify_registration TINYINT(1) DEFAULT 0,
        notify_creation TINYINT(1) DEFAULT 0,
        notify_stream TINYINT(1) DEFAULT 0,
        notify_deletion TINYINT(1) DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `;
    await pool.query(query);
    console.log('Table admin_notification_settings successfully created or already exists.');
    process.exit(0);
  } catch (error) {
    console.error('Failed to create table:', error);
    process.exit(1);
  }
}

run();
