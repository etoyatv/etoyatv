CREATE TABLE IF NOT EXISTS complaints (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reporter_id INT NOT NULL,
  target_type ENUM('channel', 'record', 'channel_comment', 'record_comment', 'pm', 'user') NOT NULL,
  target_id INT NOT NULL,
  reason TEXT,
  status ENUM('pending', 'resolved', 'rejected') DEFAULT 'pending',
  verdict TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP NULL,
  resolved_by INT NULL
);

ALTER TABLE users ADD COLUMN report_banned_until DATETIME NULL;
ALTER TABLE users ADD COLUMN report_ban_reason VARCHAR(255) NULL;
