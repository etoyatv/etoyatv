const { pool } = require('../config/db');
const fs = require('fs');
const path = require('path');

async function logSystem(connection, actionText) {
  try {
    await connection.query('INSERT INTO system_logs (log_type, username, action_text, ip_address) VALUES (?, ?, ?, ?)', ['system', 'Система', actionText, '127.0.0.1']);
  } catch (err) {
    console.error('Failed to log system action:', err);
  }
}

/**
 * Удаление физического файла.
 */
function deleteFileIfExists(fileUrl) {
  if (!fileUrl) return;
  // Игнорируем дефолтные файлы, чтобы не удалить их случайно
  if (fileUrl.includes('default_channel_logo') || fileUrl.includes('default_bg')) {
    return;
  }
  
  // Файлы обычно хранятся в public/
  // Убираем начальный слэш, чтобы путь был относительным
  const relativePath = fileUrl.startsWith('/') ? fileUrl.substring(1) : fileUrl;
  const absolutePath = path.join(__dirname, '..', 'public', relativePath);
  
  if (fs.existsSync(absolutePath)) {
    try {
      fs.unlinkSync(absolutePath);
      console.log(`[CLEANUP] Успешно удален файл: ${absolutePath}`);
    } catch (e) {
      console.error(`[CLEANUP] Ошибка при удалении файла ${absolutePath}:`, e);
    }
  }
}

async function deleteChannelData(connection, channelId) {
  console.log(`[CLEANUP] Начинается физическое удаление данных канала ID: ${channelId}`);
  await logSystem(connection, `Начинается физическое удаление данных удаленного канала (ID: ${channelId})`);
  
  const [channels] = await connection.query('SELECT id, name, logo_url, bg_url FROM channels WHERE id = ?', [channelId]);
  if (channels.length === 0) return;
  const channel = channels[0];

  // 1. Удаляем файлы видеозаписей этого канала
  const [records] = await connection.query('SELECT video_url, thumbnail_url FROM records WHERE channel_id = ?', [channelId]);
  for (const record of records) {
    deleteFileIfExists(record.video_url);
    deleteFileIfExists(record.thumbnail_url);
  }
  
  // 2. Удаляем файлы дизайна канала
  deleteFileIfExists(channel.logo_url);
  deleteFileIfExists(channel.bg_url);
  
  // 3. Удаляем канал из БД (КАСКАДНО удалит записи в records, programs, messages и т.д.)
  await connection.query('DELETE FROM channels WHERE id = ?', [channelId]);
  
  console.log(`[CLEANUP] Канал ID: ${channelId} полностью удален из системы.`);
  await logSystem(connection, `Канал (ID: ${channelId}) полностью удален из системы со всеми файлами`);
}

async function runCleanup() {
  console.log(`[CLEANUP] Запуск фоновой очистки старых удаленных каналов...`);
  try {
    const connection = await pool.getConnection();

    // Находим каналы, подлежащие физическому удалению:
    // 1. Удаленные админом более 3 дней назад
    // 2. Удаленные пользователем более 30 дней назад
    const [channelsToDelete] = await connection.query(`
      SELECT id 
      FROM channels 
      WHERE status = 'deleted' AND (
        (deleted_by_admin = 1 AND deleted_at <= DATE_SUB(NOW(), INTERVAL 3 DAY))
        OR 
        (deleted_by_admin = 0 AND deleted_at <= DATE_SUB(NOW(), INTERVAL 30 DAY))
      )
    `);

    if (channelsToDelete.length === 0) {
      console.log(`[CLEANUP] Нет каналов, подлежащих очистке.`);
      connection.release();
      return;
    }

    console.log(`[CLEANUP] Найдено каналов для полного удаления: ${channelsToDelete.length}`);
    await logSystem(connection, `Фоновая очистка: найдено каналов для удаления (${channelsToDelete.length})`);

    for (const channel of channelsToDelete) {
      await deleteChannelData(connection, channel.id);
    }

    connection.release();
  } catch (error) {
    console.error(`[CLEANUP] Ошибка во время выполнения очистки:`, error);
  }
}

module.exports = { runCleanup, deleteChannelData };
