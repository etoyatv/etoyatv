const { pool } = require('../../config/db');
const { sendBroadcastEmail } = require('../../emailService');

let isProcessing = false;

async function processPendingBroadcasts() {
  if (isProcessing) return;
  isProcessing = true;

  let connection;
  try {
    connection = await pool.getConnection();

    // 1. Find a pending broadcast
    const [broadcasts] = await connection.query(`
      SELECT * FROM system_broadcasts 
      WHERE status = 'pending' 
      ORDER BY id ASC LIMIT 1
    `);

    if (broadcasts.length === 0) {
      connection.release();
      isProcessing = false;
      return;
    }

    const broadcast = broadcasts[0];
    const broadcastId = broadcast.id;
    const messageText = broadcast.message_text;
    const shouldSendEmail = !!broadcast.send_email;

    // 2. Fetch all registered users to count total target users
    const systemUsername = 'Администрация ЭтоЯTV';
    const [userRows] = await connection.query(`
      SELECT id, username, email, system_emails_enabled FROM users 
      WHERE deleted_at IS NULL AND username != ? AND is_banned = 0
    `, [systemUsername]);

    const targetUsers = userRows.map(row => ({
      id: row.id,
      username: row.username,
      email: row.email,
      system_emails_enabled: !!row.system_emails_enabled
    }));
    const totalUsers = targetUsers.length;

    // 3. Update status to 'processing' and set total_users
    await connection.query(`
      UPDATE system_broadcasts 
      SET total_users = ?, status = 'processing' 
      WHERE id = ?
    `, [totalUsers, broadcastId]);

    console.log(`[BROADCAST] Started processing broadcast ID: ${broadcastId} for ${totalUsers} users (emails: ${shouldSendEmail})`);

    // Get official system user ID
    const [systemUserRows] = await connection.query('SELECT id FROM users WHERE username = ?', [systemUsername]);
    let systemUserId;

    if (systemUserRows.length > 0) {
      systemUserId = systemUserRows[0].id;
    } else {
      const [insertSystemResult] = await connection.query(`
        INSERT INTO users (username, email, password, role, is_verified, created_at, avatar) 
        VALUES (?, ?, ?, ?, ?, NOW(), ?)
      `, [
        systemUsername, 
        'system@etoyatv.ru', 
        'system_no_login_pw', 
        'admin', 
        1,
        '/images/default_user_avatar.png'
      ]);
      systemUserId = insertSystemResult.insertId;
    }

    // 4. Send messages in chunks
    const chunkSize = 20;
    let sentCount = 0;

    for (let i = 0; i < targetUsers.length; i += chunkSize) {
      const chunk = targetUsers.slice(i, i + chunkSize);
      
      // Perform batch inserts for the direct messages
      const insertValues = [];
      const queryParams = [];

      for (const user of chunk) {
        insertValues.push('(?, ?, ?, NOW())');
        queryParams.push(systemUserId, user.id, messageText);
      }

      if (insertValues.length > 0) {
        const queryStr = `INSERT INTO messages (sender_id, receiver_id, content, created_at) VALUES ${insertValues.join(', ')}`;
        await connection.query(queryStr, queryParams);
        sentCount += chunk.length;

        // Update progress in database
        await connection.query('UPDATE system_broadcasts SET sent_count = ? WHERE id = ?', [sentCount, broadcastId]);
      }

      // If requested, duplicate to email for subscribed users in this chunk
      if (shouldSendEmail) {
        for (const user of chunk) {
          if (user.system_emails_enabled && user.email) {
            sendBroadcastEmail(user.email, user.username, user.id, messageText).catch(mailErr => {
              console.error(`Failed to send broadcast email to ${user.email}:`, mailErr.message);
            });
          }
        }
      }

      // Delay for 50ms to prevent CPU & DB spike
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Update broadcast status to completed
    await connection.query(`
      UPDATE system_broadcasts 
      SET status = 'completed', completed_at = NOW() 
      WHERE id = ?
    `, [broadcastId]);

    console.log(`[BROADCAST] Completed processing broadcast ID: ${broadcastId}`);
    connection.release();
  } catch (error) {
    console.error('Error processing system broadcast:', error);
    if (connection) {
      try {
        await connection.query(`
          UPDATE system_broadcasts 
          SET status = 'failed' 
          WHERE id = ?
        `, [broadcastId]);
      } catch (dbErr) {
        console.error('Failed to update broadcast status to failed:', dbErr);
      }
      connection.release();
    }
  } finally {
    isProcessing = false;
  }
}

function startBroadcastProcessor() {
  // Check for pending broadcasts every 5 seconds
  setInterval(processPendingBroadcasts, 5000);
  console.log('[BROADCAST] Background processor started.');
}

module.exports = { startBroadcastProcessor };
