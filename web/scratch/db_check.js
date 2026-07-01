const { pool } = require('../config/db');

async function run() {
  try {
    const [columns] = await pool.query("SHOW COLUMNS FROM staff");
    console.log("Current staff table columns:", columns.map(c => c.Field));
    
    const hasCol = columns.some(c => c.Field === 'hide_admin_tools');
    if (!hasCol) {
      console.log("hide_admin_tools is missing. Altering table...");
      await pool.query("ALTER TABLE staff ADD COLUMN hide_admin_tools BOOLEAN DEFAULT 0");
      console.log("Table altered successfully!");
    } else {
      console.log("hide_admin_tools column already exists.");
    }
  } catch (error) {
    console.error("Database check failed:", error);
  } finally {
    process.exit(0);
  }
}

run();
