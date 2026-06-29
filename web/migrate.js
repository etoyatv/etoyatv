const { pool } = require('./config/db.js');

pool.query('ALTER TABLE channels ADD COLUMN shortname_changed_at DATETIME NULL')
  .then(() => {
    console.log('Колонка shortname_changed_at успешно добавлена!');
    process.exit(0);
  })
  .catch(err => {
    if (err.code === 'ER_DUP_FIELDNAME') {
      console.log('Колонка уже существует, все ок!');
      process.exit(0);
    } else {
      console.error('Ошибка:', err);
      process.exit(1);
    }
  });
