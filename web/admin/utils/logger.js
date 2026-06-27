const { pool } = require('../config/db');
const { sendAdminNotification } = require('../../utils/telegram');

/**
 * Запись действия в лог
 * @param {string} logType - 'user', 'team', 'admin', 'system' или 'rtmp'
 * @param {string} username - Юзернейм пользователя
 * @param {string} actionText - Описание действия
 * @param {string} ipAddress - IP-адрес
 */
async function logAction(logType, username, actionText, ipAddress) {
  try {
    await pool.query(
      'INSERT INTO system_logs (log_type, username, action_text, ip_address) VALUES (?, ?, ?, ?)',
      [logType, username || 'Неизвестный', actionText, ipAddress || '127.0.0.1']
    );

    // Telegram Notifications interceptor
    try {
      let eventType = null;
      let emoji = 'ℹ️';

      if (/Зарегистрировал новый аккаунт/i.test(actionText)) {
        eventType = 'registration';
        emoji = '👤';
      } else if (/Создал новую запись|Создал новый телеканал|Добавил новость|Создал анонс/i.test(actionText)) {
        eventType = 'creation';
        emoji = '🆕';
      } else if (/Начата трансляция|Завершил запись эфира|Начал запись эфира/i.test(actionText)) {
        eventType = 'stream';
        emoji = '📺';
      } else if (/Удалил запись|Удалил телеканал|Удалил новость|Удалил пользователя|Удалил анонс/i.test(actionText)) {
        eventType = 'deletion';
        emoji = '❌';
      }

      if (eventType) {
        const formattedMsg = `<b>[Лог]</b> ${emoji} <code>${username || 'Неизвестный'}</code>: ${actionText}`;
        // fire and forget
        sendAdminNotification(eventType, formattedMsg).catch(err => 
          console.error('Telegram Notification failed:', err.message)
        );
      }
    } catch (tgError) {
      console.error('Error in Telegram notification interceptor:', tgError);
    }
  } catch (err) {
    console.error('Ошибка записи лога:', err);
  }
}

module.exports = { logAction };

