const axios = require('axios');
const { pool } = require('../config/db');

let isPollingRunning = false;
let lastOffset = 0;

/**
 * Sends a Telegram message to a specific chat ID.
 */
async function sendMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML'
    });
  } catch (error) {
    console.error(`Telegram: failed to send message to ${chatId}:`, error.message);
  }
}

/**
 * Sends notifications to all administrators who have subscribed to the given event type.
 * @param {string} eventType - 'registration', 'creation', 'stream', or 'deletion'
 * @param {string} message - HTML formatted message to send
 */
async function sendAdminNotification(eventType, message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const columnMap = {
    registration: 'notify_registration',
    creation: 'notify_creation',
    stream: 'notify_stream',
    deletion: 'notify_deletion'
  };

  const dbColumn = columnMap[eventType];
  if (!dbColumn) {
    console.error(`Telegram: unknown event type "${eventType}"`);
    return;
  }

  try {
    // Select admins who have bound TG and have the corresponding notification enabled
    const [rows] = await pool.query(
      `SELECT tg_chat_id FROM admin_notification_settings WHERE tg_chat_id != '' AND ${dbColumn} = 1`
    );

    if (rows.length === 0) return;

    // Send notifications in parallel
    await Promise.all(rows.map(row => sendMessage(row.tg_chat_id, message)));
  } catch (error) {
    console.error('Telegram: failed to send admin notification:', error.message);
  }
}

/**
 * Polls Telegram Bot API getUpdates to process bind commands.
 */
async function pollTelegramUpdates() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn('Telegram: TELEGRAM_BOT_TOKEN is not defined. Polling disabled.');
    isPollingRunning = false;
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${lastOffset}&timeout=10`;
    const response = await axios.get(url, { timeout: 15000 });
    const updates = response.data.result || [];

    for (const update of updates) {
      lastOffset = update.update_id + 1;

      const message = update.message;
      if (message && message.text && message.text.startsWith('/start ')) {
        const textParts = message.text.split(' ');
        const bindCode = textParts[1];

        if (bindCode && bindCode.startsWith('tgbind_')) {
          const chatId = message.chat.id.toString();

          // Find admin by bind code
          const [settings] = await pool.query(
            'SELECT user_id FROM admin_notification_settings WHERE tg_bind_code = ?',
            [bindCode]
          );

          if (settings.length > 0) {
            const userId = settings[0].user_id;

            // Bind the chat ID
            await pool.query(
              'UPDATE admin_notification_settings SET tg_chat_id = ?, tg_bind_code = NULL WHERE user_id = ?',
              [chatId, userId]
            );

            console.log(`Telegram: Bound user ID ${userId} to Telegram Chat ID ${chatId}`);

            // Send confirmation
            await sendMessage(
              chatId,
              `<b>Успешно!</b> 🎉\nВаш Telegram-аккаунт привязан к панели администратора ЭтоЯTV для получения логов.`
            );
          }
        }
      }
    }
  } catch (error) {
    // If it's a conflict or unauthorized error (like 409 or 401), wait longer before retrying
    console.error('Telegram polling error:', error.message);
    if (error.response && (error.response.status === 409 || error.response.status === 401)) {
      console.warn('Telegram polling: encountered 409/401, pausing for 15 seconds...');
      setTimeout(pollTelegramUpdates, 15000);
      return;
    }
  }

  // Continue polling after a short break
  setTimeout(pollTelegramUpdates, 3000);
}

/**
 * Starts background polling for Telegram updates.
 */
function startTelegramBotPolling() {
  if (isPollingRunning) return;
  isPollingRunning = true;
  console.log('Telegram: Starting bot long polling...');
  pollTelegramUpdates();
}

module.exports = {
  sendAdminNotification,
  startTelegramBotPolling,
  sendMessage
};
