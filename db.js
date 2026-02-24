const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const initDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS truck_settings (
        id SERIAL PRIMARY KEY,
        truck_type VARCHAR(50),
        fuel_type VARCHAR(20),
        fair_load_score_threshold INTEGER DEFAULT 75,
        default_mpg NUMERIC DEFAULT 6.5,
        target_net_per_mile NUMERIC DEFAULT 2.00
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS loads (
        id SERIAL PRIMARY KEY,
        rate NUMERIC,
        miles NUMERIC,
        fuel_cost NUMERIC,
        net_profit NUMERIC,
        net_per_mile NUMERIC,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ✅ Add new fields without wiping data
    await pool.query(`ALTER TABLE loads ADD COLUMN IF NOT EXISTS avg_gas_price NUMERIC;`);
    await pool.query(`ALTER TABLE loads ADD COLUMN IF NOT EXISTS fuel_price NUMERIC;`);

    console.log('🐘 Database ready (safe init + migrations applied)');
  } catch (err) {
    console.error('DB Init Error:', err);
  }
};

initDb();
module.exports = pool;