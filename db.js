const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const initDb = async () => {
  try {
    // Existing table (kept) — we will migrate it to per-user preferences
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
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

    // ✅ Existing migrations you already had
    await pool.query(`ALTER TABLE loads ADD COLUMN IF NOT EXISTS avg_gas_price NUMERIC;`);
    await pool.query(`ALTER TABLE loads ADD COLUMN IF NOT EXISTS fuel_price NUMERIC;`);
    await pool.query(`ALTER TABLE loads ADD COLUMN IF NOT EXISTS decision VARCHAR(20);`);
    await pool.query(`ALTER TABLE loads ADD COLUMN IF NOT EXISTS origin TEXT;`);
    await pool.query(`ALTER TABLE loads ADD COLUMN IF NOT EXISTS destination TEXT;`);

    /* ---------------------------------------------------------------------- */
    /* ✅ NEW: Make loads per-user (safe migrations)                           */
    /* ---------------------------------------------------------------------- */

    await pool.query(`
      ALTER TABLE loads
      ADD COLUMN IF NOT EXISTS user_id INTEGER;
    `);

    // Add FK only if it doesn't exist (safe-ish via DO block)
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'loads_user_id_fkey'
        ) THEN
          ALTER TABLE loads
          ADD CONSTRAINT loads_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
        END IF;
      END $$;
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_loads_user_id ON loads(user_id);
    `);

    /* ---------------------------------------------------------------------- */
    /* ✅ NEW: Make truck_settings per-user preferences (safe migrations)      */
    /* ---------------------------------------------------------------------- */

    await pool.query(`
      ALTER TABLE truck_settings
      ADD COLUMN IF NOT EXISTS user_id INTEGER;
    `);

    // FK if missing
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'truck_settings_user_id_fkey'
        ) THEN
          ALTER TABLE truck_settings
          ADD CONSTRAINT truck_settings_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
        END IF;
      END $$;
    `);

    // One settings row per user
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'truck_settings_user_id_key'
        ) THEN
          ALTER TABLE truck_settings
          ADD CONSTRAINT truck_settings_user_id_key UNIQUE (user_id);
        END IF;
      END $$;
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_truck_settings_user_id ON truck_settings(user_id);
    `);

    // ✅ Idempotency: one decision save per Analyze run
    await pool.query(`ALTER TABLE loads ADD COLUMN IF NOT EXISTS analysis_id TEXT;`);

    // Unique per user + analysis run (prevents double saves)
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'loads_user_analysis_id_key'
        ) THEN
          ALTER TABLE loads
          ADD CONSTRAINT loads_user_analysis_id_key UNIQUE (user_id, analysis_id);
        END IF;
      END $$;
    `);

    // Optional: index to speed up lookups
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_loads_user_analysis_id ON loads(user_id, analysis_id);
    `);
    await pool.query(`ALTER TABLE loads ADD COLUMN IF NOT EXISTS anon_id TEXT;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_loads_anon_id ON loads(anon_id);`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS loads_anon_analysis_unique
      ON loads(anon_id, analysis_id)
      WHERE user_id IS NULL AND anon_id IS NOT NULL AND analysis_id IS NOT NULL;
    `);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_is_admin ON users(is_admin);`);

    console.log('🐘 Database ready (safe init + migrations applied)');
  } catch (err) {
    console.error('DB Init Error:', err);
  }
};

initDb();
module.exports = pool;