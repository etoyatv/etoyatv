const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');

// Helper to update .env on disk
function updateEnvFile(newValues) {
  const envPath = path.resolve(__dirname, '../.env');
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  }
  
  let lines = content.split('\n');
  for (const [key, val] of Object.entries(newValues)) {
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith(`${key}=`)) {
        lines[i] = `${key}=${val}`;
        found = true;
        break;
      }
    }
    if (!found) {
      lines.push(`${key}=${val}`);
    }
  }
  
  fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
}

// Token refresh function
async function ensureValidToken() {
  const accessToken = process.env.BOOSTY_ACCESS_TOKEN;
  const refreshToken = process.env.BOOSTY_REFRESH_TOKEN;
  const deviceId = process.env.BOOSTY_DEVICE_ID || '12996069-5b2c-403a-a87c-eb111d215b5f';
  const expiresAt = parseInt(process.env.BOOSTY_EXPIRES_AT || '0', 10);
  
  let refreshedAt = parseInt(process.env.BOOSTY_REFRESHED_AT || '0', 10);
  if (!refreshedAt && expiresAt) {
    // Estimate refreshedAt based on expiresAt assuming typical 30 days duration
    refreshedAt = expiresAt - 30 * 24 * 60 * 60 * 1000;
  }
  
  if (!refreshToken) {
    console.error('[BOOSTY] No refreshToken found in environment variables!');
    return false;
  }
  
  const urgentBufferTime = 5 * 60 * 1000; // 5 minutes buffer
  const scheduledInterval = 14 * 24 * 60 * 60 * 1000; // 14 days
  
  const isUrgent = Date.now() + urgentBufferTime >= expiresAt;
  const isTimeForScheduledRefresh = refreshedAt > 0 && (Date.now() - refreshedAt >= scheduledInterval);
  
  if (isUrgent || isTimeForScheduledRefresh) {
    if (isUrgent) {
      console.log('[BOOSTY] Access token expired or expiring soon. Refreshing programmatically...');
    } else {
      console.log('[BOOSTY] Access token is older than 14 days. Refreshing proactively to keep it fresh...');
    }
    
    const payload = {
      device_id: deviceId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      device_os: 'web'
    };
    
    try {
      const response = await fetch('https://api.boosty.to/oauth/token/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'X-From-Id': deviceId,
          'X-App': 'web',
          'Origin': 'https://boosty.to',
          'Referer': 'https://boosty.to/'
        },
        body: new URLSearchParams(payload).toString()
      });
      
      if (!response.ok) {
        console.error('[BOOSTY] Token refresh failed with status:', response.status);
        const errText = await response.text();
        console.error('[BOOSTY] Response details:', errText);
        return false;
      }
      
      const data = await response.json();
      const newExpiresAt = Date.now() + (data.expires_in * 1000);
      const nowStr = String(Date.now());
      
      // Update in-memory
      process.env.BOOSTY_ACCESS_TOKEN = data.access_token;
      process.env.BOOSTY_REFRESH_TOKEN = data.refresh_token;
      process.env.BOOSTY_EXPIRES_AT = String(newExpiresAt);
      process.env.BOOSTY_REFRESHED_AT = nowStr;
      
      // Update .env file
      updateEnvFile({
        BOOSTY_ACCESS_TOKEN: data.access_token,
        BOOSTY_REFRESH_TOKEN: data.refresh_token,
        BOOSTY_EXPIRES_AT: String(newExpiresAt),
        BOOSTY_REFRESHED_AT: nowStr
      });
      
      console.log('[BOOSTY] Tokens refreshed and updated successfully in memory and .env!');
      return true;
    } catch (err) {
      console.error('[BOOSTY] Network error during token refresh:', err.message);
      return false;
    }
  }
  return true;
}

// Check a specific email address in the Boosty subscribers list
async function checkSubscriberByEmail(email) {
  const blogName = process.env.BOOSTY_BLOG_NAME;
  if (!blogName) {
    throw new Error('BOOSTY_BLOG_NAME is not configured');
  }
  
  let offset = 0;
  const limit = 50;
  const targetEmail = email.toLowerCase().trim();
  const deviceId = process.env.BOOSTY_DEVICE_ID || '12996069-5b2c-403a-a87c-eb111d215b5f';
  
  while (true) {
    await ensureValidToken();
    const accessToken = process.env.BOOSTY_ACCESS_TOKEN;
    if (!accessToken) {
      throw new Error('No active access token for Boosty');
    }
    
    const url = `https://api.boosty.to/v1/blog/${blogName}/subscribers?limit=${limit}&offset=${offset}&sort_by=on_time&order=gt`;
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'X-App': 'web',
        'X-From-Id': deviceId
      }
    });
    
    if (!response.ok) {
      throw new Error(`Boosty API error: ${response.status}`);
    }
    
    const resData = await response.json();
    if (!resData || !resData.data || resData.data.length === 0) {
      break;
    }
    
    // Scan current page
    const found = resData.data.find(item => item.email && item.email.toLowerCase().trim() === targetEmail);
    if (found) {
      return found;
    }
    
    offset += resData.data.length;
    if (offset >= resData.total) {
      break;
    }
  }
  return null;
}

// Send a direct message on Boosty
async function sendVerificationCode(userId, code) {
  const deviceId = process.env.BOOSTY_DEVICE_ID || '12996069-5b2c-403a-a87c-eb111d215b5f';
  
  await ensureValidToken();
  const accessToken = process.env.BOOSTY_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error('No active access token for Boosty DMs');
  }
  
  // 1. Create/Retrieve Dialogue
  const dialogRes = await fetch('https://api.boosty.to/v1/dialog/', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'X-App': 'web',
      'X-From-Id': deviceId
    },
    body: new URLSearchParams({ user_id: String(userId) }).toString()
  });
  
  if (!dialogRes.ok) {
    throw new Error(`Failed to create dialogue on Boosty: ${dialogRes.status}`);
  }
  
  const dialog = await dialogRes.json();
  const dialogId = dialog.id;
  
  // 2. Format and Send Message
  const messageText = `Код подтверждения для привязки подписки Boosty к вашему аккаунту на ЭтоЯTV: ${code}`;
  const messageData = [
    {
      type: 'text',
      modificator: '',
      content: JSON.stringify([messageText, 'unstyled', []])
    }
  ];
  
  const msgRes = await fetch(`https://api.boosty.to/v1/dialog/${dialogId}/message`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'X-App': 'web',
      'X-From-Id': deviceId
    },
    body: new URLSearchParams({
      data: JSON.stringify(messageData),
      price: '0'
    }).toString()
  });
  
  if (!msgRes.ok) {
    throw new Error(`Failed to send DM on Boosty: ${msgRes.status}`);
  }
  
  return true;
}

// Background sync function for linked users
async function syncLinkedUsers() {
  const blogName = process.env.BOOSTY_BLOG_NAME;
  if (!blogName) {
    return { success: false, error: 'BOOSTY_BLOG_NAME is not configured' };
  }
  
  console.log('[BOOSTY] Running background sync for linked users...');
  let connection;
  let successCount = 0;
  try {
    connection = await pool.getConnection();
    const [users] = await connection.query('SELECT id, username, boosty_email, boosty_channel_id FROM users WHERE boosty_email IS NOT NULL');
    console.log(`[BOOSTY] Found ${users.length} users with linked Boosty accounts.`);
    
    for (const user of users) {
      try {
        const subscriber = await checkSubscriberByEmail(user.boosty_email);
        if (subscriber) {
          const isActive = subscriber.subscribed === true && 
                           subscriber.status === 'active' && 
                           subscriber.level && 
                           subscriber.level.price > 0;
          if (isActive) {
            const nextPayTimeDate = new Date((subscriber.offTime || subscriber.nextPayTime || 0) * 1000);
            
            const [chRows] = await connection.query('SELECT id, is_personal, is_premium, premium_until FROM channels WHERE user_id = ? AND status IN (\'active\', \'banned\')', [user.id]);
            
            // Determine which channel should get the premium
            let targetChannelId = null;
            if (user.boosty_channel_id) {
              const hasSelected = chRows.find(c => c.id === user.boosty_channel_id);
              if (hasSelected) {
                targetChannelId = user.boosty_channel_id;
              }
            }
            
            if (!targetChannelId && chRows.length > 0) {
              const personalCh = chRows.find(c => c.is_personal === 1 || c.is_personal === true);
              if (personalCh) {
                targetChannelId = personalCh.id;
              } else {
                targetChannelId = chRows[0].id;
              }
            }
            
            for (const ch of chRows) {
              if (ch.id === targetChannelId) {
                const currentUntil = ch.premium_until ? new Date(ch.premium_until).getTime() : 0;
                const newUntil = nextPayTimeDate.getTime();
                
                if (ch.is_premium !== 1 || Math.abs(currentUntil - newUntil) > 5000) {
                  console.log(`[BOOSTY] Granting/renewing premium for user ${user.username} (Channel ID: ${ch.id}) until ${nextPayTimeDate.toLocaleString()}`);
                  await connection.query('UPDATE channels SET is_premium = 1, is_verified = 1, premium_until = ? WHERE id = ?', [nextPayTimeDate, ch.id]);
                  successCount++;
                }
              } else {
                if (ch.is_premium === 1) {
                  console.log(`[BOOSTY] Removing premium from secondary channel ${ch.id} of user ${user.username}`);
                  await connection.query('UPDATE channels SET is_premium = 0, is_verified = 0, premium_until = NULL WHERE id = ?', [ch.id]);
                }
              }
            }
          } else {
            // Demote all channels
            await connection.query('UPDATE channels SET is_premium = 0, is_verified = 0, premium_until = NULL WHERE user_id = ?', [user.id]);
          }
        } else {
          // Demote all channels
          await connection.query('UPDATE channels SET is_premium = 0, is_verified = 0, premium_until = NULL WHERE user_id = ?', [user.id]);
        }
      } catch (err) {
        console.error(`[BOOSTY] Failed to sync user ${user.username}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[BOOSTY] Error in syncLinkedUsers:', err);
    return { success: false, error: err.message };
  } finally {
    if (connection) connection.release();
  }
  return { success: true, updatedCount: successCount };
}

module.exports = {
  ensureValidToken,
  checkSubscriberByEmail,
  sendVerificationCode,
  syncLinkedUsers
};
