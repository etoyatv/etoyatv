const { pool } = require('../config/db');
const crypto = require('crypto');

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.log('Использование: node create_channel.js <username> <channel_name> <shortname> [is_personal (true/false, по умолчанию true)]');
    process.exit(1);
  }

  const [username, channelName, shortname, isPersonalStr] = args;
  const isPersonal = isPersonalStr !== 'false';

  try {
    const connection = await pool.getConnection();

    // 1. Find user
    const [users] = await connection.query('SELECT id FROM users WHERE username = ?', [username]);
    if (users.length === 0) {
      console.error(`Ошибка: Пользователь "${username}" не найден.`);
      connection.release();
      process.exit(1);
    }
    const userId = users[0].id;

    // 2. Validate shortname regex
    const slugRegex = /^[a-zA-Z0-9_-]+$/;
    if (!slugRegex.test(shortname)) {
      console.error('Ошибка: Короткое имя может содержать только латинские буквы, цифры, дефис и подчеркивание.');
      connection.release();
      process.exit(1);
    }

    // 3. Check shortname uniqueness
    const [existing] = await connection.query('SELECT id FROM channels WHERE shortname = ?', [shortname]);
    if (existing.length > 0) {
      console.error('Ошибка: Короткое имя уже занято.');
      connection.release();
      process.exit(1);
    }

    // 4. Create channel and stream key inside a transaction
    await connection.beginTransaction();

    const [channelResult] = await connection.query(
      'INSERT INTO channels (user_id, name, description, shortname, status, is_personal, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
      [userId, channelName, '', shortname.toLowerCase(), 'active', isPersonal ? 1 : 0]
    );
    const channelId = channelResult.insertId;

    const streamKey = 'sk_live_' + crypto.randomBytes(16).toString('hex');
    await connection.query(
      'INSERT INTO stream_keys (channel_id, user_id, stream_key, is_active) VALUES (?, ?, ?, 1)',
      [channelId, userId, streamKey]
    );

    await connection.commit();
    connection.release();

    console.log(`\nТелеканал успешно создан!`);
    console.log(`------------------------------------`);
    console.log(`ID канала:     ${channelId}`);
    console.log(`Название:      ${channelName}`);
    console.log(`Короткое имя:  ${shortname}`);
    console.log(`Тип:           ${isPersonal ? 'Личный' : 'Кооперативный'}`);
    console.log(`Владелец:      ${username} (ID: ${userId})`);
    console.log(`Ключ потока:   ${streamKey}`);
    console.log(`------------------------------------\n`);

    process.exit(0);
  } catch (err) {
    console.error('Произошла ошибка:', err.message);
    process.exit(1);
  }
}

main();
