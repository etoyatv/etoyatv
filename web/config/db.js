const mysql = require('mysql2/promise');

// Database connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'etoyatv',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
});

// Initialize database
async function initDb() {
  let connection;
  let retries = 10;
  while (retries > 0) {
    try {
      connection = await pool.getConnection();
      // Test the connection
      await connection.query('SELECT 1');
      break;
    } catch (err) {
      console.error(`Error connecting to database (retries left: ${retries - 1}):`, err.message);
      retries -= 1;
      if (connection) {
        connection.release();
        connection = null;
      }
      if (retries === 0) {
        console.error('Fatal: Could not initialize database after multiple attempts.');
        return;
      }
      await new Promise(res => setTimeout(res, 3000));
    }
  }

  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) NOT NULL UNIQUE,
        email VARCHAR(255) NOT NULL,
        password VARCHAR(255) NOT NULL
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS staff (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL UNIQUE,
        role ENUM('admin', 'moderator') NOT NULL,
        is_superadmin BOOLEAN DEFAULT 0,
        blur_18_plus BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS friendships (
        id INT AUTO_INCREMENT PRIMARY KEY,
        requester_id INT NOT NULL,
        receiver_id INT NOT NULL,
        status ENUM('pending', 'accepted') NOT NULL DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE KEY unique_friendship (requester_id, receiver_id)
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender_id INT NOT NULL,
        receiver_id INT NOT NULL,
        content TEXT NOT NULL,
        is_read TINYINT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_blocks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        blocker_id INT NOT NULL,
        blocked_id INT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE KEY unique_block (blocker_id, blocked_id)
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_reports (
        id INT AUTO_INCREMENT PRIMARY KEY,
        reporter_id INT NOT NULL,
        reported_id INT NOT NULL,
        reason TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (reported_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS channels (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        shortname VARCHAR(100) UNIQUE,
        description TEXT,
        status VARCHAR(50) DEFAULT 'offline',
        chat_enabled TINYINT DEFAULT 1,
        guests_allowed TINYINT DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        deleted_at DATETIME DEFAULT NULL,
        deleted_by_admin BOOLEAN DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Add columns if they don't exist
    try { await connection.query(`ALTER TABLE channels ADD COLUMN access_level VARCHAR(20) DEFAULT 'public'`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN password VARCHAR(255) DEFAULT ''`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN is_18_plus BOOLEAN DEFAULT FALSE`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN live_title VARCHAR(255) DEFAULT NULL`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN rtmp_disabled BOOLEAN DEFAULT FALSE`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN last_live DATETIME DEFAULT NULL`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN autopilot_disabled BOOLEAN DEFAULT FALSE`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN design_disabled BOOLEAN DEFAULT FALSE`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN chat_disabled BOOLEAN DEFAULT FALSE`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN banned_until DATETIME DEFAULT NULL`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN ban_reason TEXT DEFAULT NULL`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN deleted_by_admin BOOLEAN DEFAULT 0`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN cdn_quota_mb INT DEFAULT 2048`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN pinned_message_id INT NULL`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN is_verified BOOLEAN DEFAULT FALSE`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN is_premium BOOLEAN DEFAULT FALSE`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN player_bg_url VARCHAR(255) DEFAULT NULL`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN player_bg_color VARCHAR(50) DEFAULT NULL`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN player_bg_fit VARCHAR(50) DEFAULT 'stretch'`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN bg_fit VARCHAR(50) DEFAULT 'stretch'`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN player_link_color VARCHAR(50) DEFAULT NULL`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN is_personal BOOLEAN DEFAULT TRUE`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channel_team ADD COLUMN is_coowner BOOLEAN DEFAULT FALSE`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channel_team ADD COLUMN order_index INT DEFAULT 0`); } catch (e) { }
    try { await connection.query(`ALTER TABLE records ADD COLUMN is_18_plus BOOLEAN DEFAULT FALSE`); } catch (e) { }
    try { await connection.query(`ALTER TABLE users ADD COLUMN report_banned_until DATETIME DEFAULT NULL`); } catch (e) { }
    try { await connection.query(`ALTER TABLE users ADD COLUMN banned_by INT DEFAULT NULL`); } catch (e) { }
    try { await connection.query(`ALTER TABLE ip_bans MODIFY COLUMN ban_type ENUM('registration', 'all', 'full', 'account') DEFAULT 'registration'`); } catch (e) { }
    await connection.query(`
      CREATE TABLE IF NOT EXISTS complaints (
        id INT AUTO_INCREMENT PRIMARY KEY,
        reporter_id INT NOT NULL,
        target_type VARCHAR(50) NOT NULL,
        target_id VARCHAR(255) DEFAULT NULL,
        reason TEXT NOT NULL,
        target_content TEXT DEFAULT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        verdict TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS invite_codes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        creator_id INT NOT NULL,
        used_by_id INT NULL,
        used_at DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (used_by_id) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS news (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS programs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        channel_id INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        start_time DATETIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS personal_schedules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        program_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE,
        UNIQUE KEY idx_user_program (user_id, program_id)
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS channel_fans (
        id INT AUTO_INCREMENT PRIMARY KEY,
        channel_id INT NOT NULL,
        user_id INT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE KEY unique_fan (channel_id, user_id)
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS channel_team (
        id INT AUTO_INCREMENT PRIMARY KEY,
        channel_id INT NOT NULL,
        user_id INT NOT NULL,
        is_reporter BOOLEAN DEFAULT FALSE,
        is_moderator BOOLEAN DEFAULT FALSE,
        is_editor BOOLEAN DEFAULT FALSE,
        is_coowner BOOLEAN DEFAULT FALSE,
        order_index INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE KEY unique_team_member (channel_id, user_id)
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        channel_id INT NOT NULL,
        user_id INT, -- NULL if guest
        guest_name VARCHAR(100),
        message TEXT NOT NULL,
        role VARCHAR(50) DEFAULT 'guest', -- owner, mod, admin, registered, guest
        color VARCHAR(50) DEFAULT '#3b9cd9',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS channel_bans (
        id INT AUTO_INCREMENT PRIMARY KEY,
        channel_id INT NOT NULL,
        user_id INT NULL,
        guest_ip VARCHAR(255) NULL,
        username VARCHAR(255) NOT NULL,
        banned_until DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS pending_channel_transfers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        channel_id INT NOT NULL,
        old_owner_id INT NOT NULL,
        new_owner_id INT NOT NULL,
        token VARCHAR(255) NOT NULL,
        email_confirmed BOOLEAN DEFAULT FALSE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
        FOREIGN KEY (old_owner_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (new_owner_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS channel_comments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        channel_id INT NOT NULL,
        user_id INT NOT NULL,
        text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS profile_comments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        profile_user_id INT NOT NULL,
        author_id INT NOT NULL,
        text TEXT NOT NULL,
        is_hidden BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (profile_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS stream_keys (
        id INT AUTO_INCREMENT PRIMARY KEY,
        channel_id INT NOT NULL,
        user_id INT NOT NULL,
        stream_key VARCHAR(100) NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE KEY idx_channel_user (channel_id, user_id)
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS channel_news (
        id INT AUTO_INCREMENT PRIMARY KEY,
        channel_id INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        announce TEXT,
        content TEXT,
        author_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
        FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS records (
        id INT AUTO_INCREMENT PRIMARY KEY,
        channel_id INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        video_url VARCHAR(255) NOT NULL,
        thumbnail_url VARCHAR(255),
        is_processed BOOLEAN DEFAULT FALSE,
        duration INT DEFAULT 0,
        views INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS stats_snapshots (
        id INT AUTO_INCREMENT PRIMARY KEY,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        users_online INT DEFAULT 0,
        viewers_online INT DEFAULT 0
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id varchar(128) COLLATE utf8mb4_bin NOT NULL,
        expires int(11) unsigned NOT NULL,
        data mediumtext COLLATE utf8mb4_bin,
        PRIMARY KEY (session_id)
      ) ENGINE=InnoDB;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        setting_key VARCHAR(255) PRIMARY KEY,
        setting_value TEXT
      )
    `);

    // Auto-fix for duplicate rows if primary key is missing
    try {
      const [indexRows] = await connection.query("SHOW INDEX FROM system_settings WHERE Key_name = 'PRIMARY'");
      if (indexRows.length === 0) {
        console.log("Fixing system_settings missing PRIMARY KEY...");
        const [allSettings] = await connection.query("SELECT setting_key, setting_value FROM system_settings");
        const uniqueSettings = {};
        for (const row of allSettings) {
           // Prefer non-default values ('1' over '0', or non-empty strings over empty) to save user settings
           if (!uniqueSettings[row.setting_key] || (row.setting_value !== '0' && row.setting_value !== '')) {
             uniqueSettings[row.setting_key] = row.setting_value;
           }
        }
        await connection.query("TRUNCATE TABLE system_settings");
        
        // Ensure the setting_key column is a valid primary key length
        await connection.query("ALTER TABLE system_settings MODIFY setting_key VARCHAR(255)");
        await connection.query("ALTER TABLE system_settings ADD PRIMARY KEY (setting_key)");
        
        for (const [k, v] of Object.entries(uniqueSettings)) {
           await connection.query("INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)", [k, v]);
        }
        console.log("system_settings primary key fixed.");
      }
    } catch(e) {
      console.error('Error fixing system_settings PK:', e);
    }

    const defaultSettings = {
      'site_disabled': '0',
      'site_disabled_message': '',
      'rtmp_disabled': '0',
      'banner_enabled': '0',
      'banner_text_short': '',
      'banner_text_full': '',
      'registration_disabled': '0',
      'ads_enabled': '0',
      'ads_config': '[]',
      'forbidden_words': '',
      'invite_system_enabled': '0'
    };
    for (const [key, value] of Object.entries(defaultSettings)) {
      await connection.query('INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES (?, ?)', [key, value]);
    }

    await connection.query(`
      CREATE TABLE IF NOT EXISTS ip_bans (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ip_address VARCHAR(255) NOT NULL UNIQUE,
        banned_by INT NOT NULL,
        ban_type ENUM('registration', 'all', 'full', 'account') DEFAULT 'registration',
        reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (banned_by) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS record_likes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        record_id INT NOT NULL,
        user_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE KEY unique_like (record_id, user_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS record_comments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        record_id INT NOT NULL,
        user_id INT NOT NULL,
        text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS record_favorites (
        id INT AUTO_INCREMENT PRIMARY KEY,
        record_id INT NOT NULL,
        user_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE KEY user_record (user_id, record_id)
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS nickname_change_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        old_nickname VARCHAR(255) NOT NULL,
        new_nickname VARCHAR(255) NOT NULL,
        changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS albums (
        id INT AUTO_INCREMENT PRIMARY KEY,
        channel_id INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS album_records (
        id INT AUTO_INCREMENT PRIMARY KEY,
        album_id INT NOT NULL,
        record_id INT NOT NULL,
        order_index INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE,
        FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE
      )
    `);

    try {
      await connection.query('ALTER TABLE album_records ADD INDEX idx_album_id (album_id)');
    } catch (e) {
      // Index might already exist
    }

    try {
      await connection.query('ALTER TABLE album_records DROP INDEX unique_album_record');
      console.log('Dropped unique_album_record index to allow duplicate videos in playlist.');
    } catch (e) {
      // Index might already be dropped or not exist
    }

    await connection.query(`
      CREATE TABLE IF NOT EXISTS personal_schedules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        program_id INT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE,
        UNIQUE KEY unique_schedule (user_id, program_id)
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS channel_viewer_stats (
        id INT AUTO_INCREMENT PRIMARY KEY,
        channel_id INT NOT NULL,
        viewer_count INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS record_view_stats (
        id INT AUTO_INCREMENT PRIMARY KEY,
        record_id INT NOT NULL,
        channel_id INT NOT NULL,
        country_code VARCHAR(2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      )
    `);

    console.log('Database initialized.');

    // Modify table to add profile fields
    const columns = [
      "avatar VARCHAR(255) DEFAULT '/images/default_user_avatar.png'",
      "timezone VARCHAR(100) DEFAULT ''",
      "birthdate DATE NULL",
      "about TEXT NULL",
      "telegram VARCHAR(255) DEFAULT ''",
      "discord VARCHAR(255) DEFAULT ''",
      "last_active DATETIME NULL",
      "is_verified TINYINT DEFAULT 1",
      "verification_token VARCHAR(255) NULL",
      "verification_expires DATETIME NULL",
      "last_email_sent DATETIME NULL",
      "reset_token VARCHAR(255) NULL",
      "reset_expires DATETIME NULL",
      "last_reset_sent DATETIME NULL",
      "chat_color VARCHAR(50) DEFAULT '#3b9cd9'",
      "last_nickname_change TIMESTAMP NULL",
      "role VARCHAR(50) DEFAULT 'user'",
      "is_banned BOOLEAN DEFAULT 0",
      "banned_until DATETIME DEFAULT NULL",
      "ban_reason VARCHAR(255) DEFAULT NULL",
      "show_ban_reason BOOLEAN DEFAULT 1",
      "deleted_at DATETIME DEFAULT NULL",
      "delete_reason TEXT DEFAULT NULL",
      "deleted_by_admin BOOLEAN DEFAULT 0",
      "wipe_date DATETIME DEFAULT NULL",
      "totp_secret VARCHAR(255) DEFAULT NULL",
      "is_totp_enabled BOOLEAN DEFAULT 0",
      "totp_backup_codes TEXT DEFAULT NULL",
      "invited_by INT NULL",
      "last_password_change DATETIME NULL",
      "reg_ip VARCHAR(255) DEFAULT NULL",
      "last_ip VARCHAR(255) DEFAULT NULL",
      "created_at DATETIME DEFAULT CURRENT_TIMESTAMP"
    ];
    for (let col of columns) {
      try {
        await connection.query(`ALTER TABLE users ADD COLUMN ${col}`);
      } catch (e) {
        // Ignore duplicate column errors
      }
    }

    const channelColumns = [
      "shortname VARCHAR(100) UNIQUE",
      "status VARCHAR(50) DEFAULT 'offline'",
      "is_live BOOLEAN DEFAULT FALSE",
      "viewers INT DEFAULT 0",
      "logo_url VARCHAR(255) DEFAULT '/images/logo_cort.png'",
      "banner_url VARCHAR(255) NULL",
      "bg_url VARCHAR(255) NULL",
      "is_personal BOOLEAN DEFAULT TRUE",
      "bg_fit VARCHAR(50) DEFAULT 'stretch'",
      "bg_repeat VARCHAR(50) DEFAULT 'no-repeat'",
      "bg_color VARCHAR(50) DEFAULT '#000000'",
      "text_color VARCHAR(50) DEFAULT '#ffffff'",
      "player_color VARCHAR(50) DEFAULT '#00a0e3'",
      "player_logo VARCHAR(255) NULL",
      "player_bg_url VARCHAR(255) DEFAULT NULL",
      "player_bg_color VARCHAR(50) DEFAULT NULL",
      "player_menu_color VARCHAR(50) DEFAULT NULL",
      "player_link_color VARCHAR(50) DEFAULT NULL",
      "chat_enabled TINYINT DEFAULT 1",
      "guests_allowed TINYINT DEFAULT 1",
      "deleted_at TIMESTAMP NULL",
      "autopilot_enabled TINYINT DEFAULT 0",
      "autopilot_album_id INT NULL",
      "autopilot_start_time DATETIME NULL",
      "live_started_at DATETIME NULL",
      "current_streamer_id INT NULL"
    ];
    for (let col of channelColumns) {
      try {
        await connection.query(`ALTER TABLE channels ADD COLUMN ${col}`);
      } catch (e) {
        // Ignore duplicate column errors
      }
    }
    await connection.query(`
      CREATE TABLE IF NOT EXISTS rtmp_ip_blocks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ip_address VARCHAR(255) NOT NULL UNIQUE,
        attempts INT DEFAULT 0,
        blocked_until DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_deletion_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        username VARCHAR(255) NOT NULL,
        deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        restored_at DATETIME NULL
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS record_view_stats (
        id INT AUTO_INCREMENT PRIMARY KEY,
        record_id INT NOT NULL,
        channel_id INT NOT NULL,
        country_code VARCHAR(10) NULL,
        viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS system_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        log_type VARCHAR(50) NOT NULL,
        username VARCHAR(255) NOT NULL,
        action_text TEXT NOT NULL,
        ip_address VARCHAR(255) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    try {
      await connection.query('ALTER TABLE users ADD COLUMN deleted_at DATETIME NULL');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') {
        console.error('Error adding deleted_at to users:', e);
      }
    }

    try {
      await connection.query("ALTER TABLE staff ADD COLUMN mask_mode VARCHAR(20) DEFAULT 'disabled'");
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') {
        console.error('Error adding mask_mode to staff:', e);
      }
    }

    const recordColumns = [
      "description TEXT",
      "video_url VARCHAR(255) NOT NULL DEFAULT ''",
      "thumbnail_url VARCHAR(255)",
      "duration INT DEFAULT 0",
      "hls_url VARCHAR(255)",
      "processing_status VARCHAR(50) DEFAULT 'pending'",
      "status VARCHAR(50) DEFAULT 'active'",
      "size_bytes BIGINT DEFAULT 0"
    ];
    for (const col of recordColumns) {
      try {
        await connection.query(`ALTER TABLE records ADD COLUMN ${col}`);
      } catch (e) {
        // Ignore duplicate column errors
      }
    }

    const tablesWithHidden = ['channel_comments', 'record_comments', 'channel_news', 'profile_comments'];
    for (const table of tablesWithHidden) {
      try {
        await connection.query(`ALTER TABLE ${table} ADD COLUMN is_hidden BOOLEAN DEFAULT FALSE`);
      } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') {
          console.error(`Error adding is_hidden to ${table}:`, e);
        }
      }
    }
    // Auto-fix for channels that were restored but kept rtmp_disabled = 1
    try {
      await connection.query("UPDATE channels SET rtmp_disabled = 0 WHERE status = 'active' AND rtmp_disabled = 1");
    } catch (e) {
      console.error('Error auto-fixing rtmp_disabled:', e);
    }

    connection.release();
  } catch (err) {
    console.error('Error initializing database:', err);
    if (connection) connection.release();
  }
}

const initDbPromise = initDb();

module.exports = { pool, initDb, initDbPromise };
