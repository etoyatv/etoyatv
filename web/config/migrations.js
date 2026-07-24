async function runMigrations(connection) {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) NOT NULL UNIQUE,
        email VARCHAR(255) NOT NULL,
        password VARCHAR(255) NOT NULL
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS admin_notification_settings (
        user_id INT PRIMARY KEY,
        tg_chat_id VARCHAR(255) DEFAULT '',
        tg_bind_code VARCHAR(255) NULL,
        notify_registration TINYINT(1) DEFAULT 0,
        notify_creation TINYINT(1) DEFAULT 0,
        notify_stream TINYINT(1) DEFAULT 0,
        notify_deletion TINYINT(1) DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
    try { await connection.query(`ALTER TABLE channels ADD COLUMN premium_until DATETIME DEFAULT NULL`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN hide_live_badge BOOLEAN DEFAULT FALSE`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN shortname_changed_at DATETIME DEFAULT NULL`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN max_streams INT DEFAULT 1`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN is_live_1 TINYINT DEFAULT 0`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN is_live_2 TINYINT DEFAULT 0`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channels ADD COLUMN is_live_3 TINYINT DEFAULT 0`); } catch (e) { }
    try { await connection.query(`UPDATE channels SET is_live_1 = 1 WHERE is_live = 1`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channel_team ADD COLUMN is_coowner BOOLEAN DEFAULT FALSE`); } catch (e) { }
    try { await connection.query(`ALTER TABLE channel_team ADD COLUMN order_index INT DEFAULT 0`); } catch (e) { }
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
        stream_index INT NULL DEFAULT NULL,
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
        user_id INT NULL,
        author_name VARCHAR(255) NULL,
        text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
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
        is_18_plus BOOLEAN DEFAULT FALSE,
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
      'invite_system_enabled': '0',
      'news_source': 'service_channel'
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

    await connection.query(`
      CREATE TABLE IF NOT EXISTS record_comments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        record_id INT NOT NULL,
        user_id INT NULL,
        author_name VARCHAR(255) NULL,
        text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    await connection.query(`
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

    // personal_schedules already created above (UNIQUE idx_user_program)

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
      "last_email_change DATETIME NULL",
      "reg_ip VARCHAR(255) DEFAULT NULL",
      "last_ip VARCHAR(255) DEFAULT NULL",
      "boosty_email VARCHAR(255) DEFAULT NULL",
      "boosty_channel_id INT DEFAULT NULL",
      "privacy_profile VARCHAR(20) DEFAULT 'public'",
      "privacy_messages VARCHAR(20) DEFAULT 'all'",
      "privacy_friends_list VARCHAR(20) DEFAULT 'all'",
      "system_emails_enabled TINYINT(1) DEFAULT 1",
      "created_at DATETIME DEFAULT CURRENT_TIMESTAMP"
    ];
    for (let col of columns) {
      try {
        await connection.query(`ALTER TABLE users ADD COLUMN ${col}`);
      } catch (e) {
        // Ignore duplicate column errors
      }
    }

    try {
      await connection.query('UPDATE users SET system_emails_enabled = 1 WHERE system_emails_enabled IS NULL');
    } catch (e) {
      console.error('Error updating system_emails_enabled defaults:', e.message);
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
      "current_streamer_id INT NULL",
      "logo_fit VARCHAR(50) DEFAULT 'cover'"
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
      CREATE TABLE IF NOT EXISTS system_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        log_type VARCHAR(50) NOT NULL,
        username VARCHAR(255) NOT NULL,
        action_text TEXT NOT NULL,
        ip_address VARCHAR(255) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS system_broadcasts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        admin_id INT NOT NULL,
        message_text TEXT NOT NULL,
        broadcast_token VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        send_email TINYINT(1) DEFAULT 0,
        sent_count INT DEFAULT 0,
        total_users INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME NULL,
        FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    try {
      await connection.query('ALTER TABLE system_broadcasts ADD COLUMN send_email TINYINT(1) DEFAULT 0');
    } catch (e) {
      // Ignore duplicate column errors
    }


    try {
      await connection.query('ALTER TABLE users ADD COLUMN deleted_at DATETIME NULL');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') {
        console.error('Error adding deleted_at to users:', e);
      }
    }

    try {
      await connection.query("ALTER TABLE users ADD COLUMN lang VARCHAR(5) DEFAULT 'ru'");
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') {
        console.error('Error adding lang to users:', e);
      }
    }

    try {
      await connection.query("ALTER TABLE staff ADD COLUMN mask_mode VARCHAR(20) DEFAULT 'disabled'");
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') {
        console.error('Error adding mask_mode to staff:', e);
      }
    }

    try {
      await connection.query("ALTER TABLE staff ADD COLUMN hide_admin_tools BOOLEAN DEFAULT 0");
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') {
        console.error('Error adding hide_admin_tools to staff:', e);
      }
    }

    try {
      await connection.query("ALTER TABLE friendships ADD COLUMN requester_hidden BOOLEAN DEFAULT FALSE");
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') {
        console.error('Error adding requester_hidden to friendships:', e);
      }
    }

    try {
      await connection.query("ALTER TABLE friendships ADD COLUMN receiver_hidden BOOLEAN DEFAULT FALSE");
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') {
        console.error('Error adding receiver_hidden to friendships:', e);
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
      "size_bytes BIGINT DEFAULT 0",
      "access_level VARCHAR(20) DEFAULT 'public'",
      "is_18_plus BOOLEAN DEFAULT FALSE"
    ];
    for (const col of recordColumns) {
      try {
        await connection.query(`ALTER TABLE records ADD COLUMN ${col}`);
      } catch (e) {
        // Ignore duplicate column errors
      }
    }

    const tablesWithHidden = ['channel_comments', 'record_comments', 'channel_news', 'profile_comments', 'programs'];
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

    try {
      await connection.query("ALTER TABLE chat_messages ADD COLUMN stream_index INT NULL DEFAULT NULL");
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') {
        console.error('Error adding stream_index to chat_messages:', e);
      }
    }

    const pinnedCols = ["pinned_message_id_1 INT NULL DEFAULT NULL", "pinned_message_id_2 INT NULL DEFAULT NULL", "pinned_message_id_3 INT NULL DEFAULT NULL"];
    for (const col of pinnedCols) {
      try {
        await connection.query(`ALTER TABLE channels ADD COLUMN ${col}`);
      } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') {
          console.error(`Error adding column ${col} to channels:`, e);
        }
      }
    }

    // Create record_permissions table for user ID-based video restrictions
    await connection.query(`
      CREATE TABLE IF NOT EXISTS record_permissions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        record_id INT NOT NULL,
        user_id INT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE KEY unique_record_user (record_id, user_id)
      )
    `);

    // Performance indexes for privacy modules
    try {
      await connection.query("CREATE INDEX idx_friendships_status_hidden ON friendships (status, requester_hidden, receiver_hidden)");
    } catch (e) {}

    try {
      await connection.query("CREATE INDEX idx_records_access_status ON records (access_level, status)");
    } catch (e) {}

    try {
      await connection.query("CREATE INDEX idx_record_perms_user ON record_permissions (user_id)");
    } catch (e) {}

    await connection.query(`
      CREATE TABLE IF NOT EXISTS profile_export_jobs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        export_type ENUM('personal','transfer') NOT NULL,
        status ENUM('queued','processing','zipping','ready','failed','expired') NOT NULL DEFAULT 'queued',
        progress_current INT NOT NULL DEFAULT 0,
        progress_total INT NOT NULL DEFAULT 0,
        eta_seconds INT NULL,
        estimated_bytes BIGINT NULL,
        actual_bytes BIGINT NULL,
        zip_path VARCHAR(512) NULL,
        zip_token VARCHAR(64) NULL,
        dl_token VARCHAR(64) NULL,
        dl_token_expires DATETIME NULL,
        error_text TEXT NULL,
        skipped_json TEXT NULL,
        expires_at DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_export_jobs_user_status (user_id, status),
        INDEX idx_export_jobs_status (status),
        INDEX idx_export_jobs_expires (expires_at)
      )
    `);

    try { await connection.query(`ALTER TABLE profile_export_jobs ADD COLUMN dl_token VARCHAR(64) NULL`); } catch (e) {}
    try { await connection.query(`ALTER TABLE profile_export_jobs ADD COLUMN dl_token_expires DATETIME NULL`); } catch (e) {}

    await connection.query(`
      CREATE TABLE IF NOT EXISTS profile_transfer_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        submitter_user_id INT NULL,
        source_username VARCHAR(255) NULL,
        source_email VARCHAR(255) NULL,
        zip_path VARCHAR(512) NULL,
        manifest_json MEDIUMTEXT NULL,
        status ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
        was_premium TINYINT(1) NOT NULL DEFAULT 0,
        was_verified TINYINT(1) NOT NULL DEFAULT 0,
        grant_premium TINYINT(1) NULL,
        grant_verified TINYINT(1) NULL,
        admin_note TEXT NULL,
        reviewed_by INT NULL,
        reviewed_at DATETIME NULL,
        error_text TEXT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (submitter_user_id) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_transfer_req_status (status)
      )
    `);

    try {
      await connection.query(`ALTER TABLE profile_transfer_requests MODIFY COLUMN zip_path VARCHAR(512) NULL`);
    } catch (e) {}

    // Stub authors for transferred comments when the user does not exist on this instance
    for (const table of ['channel_comments', 'record_comments']) {
      try {
        await connection.query(`ALTER TABLE ${table} ADD COLUMN author_name VARCHAR(255) NULL`);
      } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') {
          console.error(`Error adding author_name to ${table}:`, e);
        }
      }
      try {
        const [fks] = await connection.query(
          `SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = ?
             AND COLUMN_NAME = 'user_id'
             AND REFERENCED_TABLE_NAME = 'users'`,
          [table]
        );
        for (const fk of fks) {
          try {
            await connection.query(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${fk.CONSTRAINT_NAME}\``);
          } catch (e) {}
        }
      } catch (e) {
        console.error(`Error dropping user_id FK on ${table}:`, e);
      }
      try {
        await connection.query(`ALTER TABLE \`${table}\` MODIFY COLUMN user_id INT NULL`);
      } catch (e) {
        console.error(`Error making user_id nullable on ${table}:`, e);
      }
      try {
        await connection.query(
          `ALTER TABLE \`${table}\`
           ADD CONSTRAINT \`fk_${table}_user_stub\`
           FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL`
        );
      } catch (e) {
        if (e.code !== 'ER_DUP_KEYNAME' && e.code !== 'ER_FK_DUP_NAME') {
          // ignore if constraint already exists under another name
        }
      }
    }
}

module.exports = { runMigrations };
