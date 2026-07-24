const mysql = require('mysql2/promise');
const { runMigrations } = require('./migrations');

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
    await runMigrations(connection);
    connection.release();
  } catch (err) {
    console.error('Error initializing database:', err);
    if (connection) connection.release();
  }
}

const initDbPromise = initDb();

module.exports = { pool, initDb, initDbPromise };
