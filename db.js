const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://admin:password@db:5432/profit_db'
});

const initDb = async () => {
    try {
        // Drop old tables to apply new schema
        await pool.query(`DROP TABLE IF EXISTS truck_settings;`);
        
        await pool.query(`
            CREATE TABLE truck_settings (
                id SERIAL PRIMARY KEY,
                truck_type VARCHAR(50),
                fuel_type VARCHAR(20),
                fair_load_score_threshold INTEGER DEFAULT 75,
                default_mpg NUMERIC DEFAULT 6.5,
                target_net_per_mile NUMERIC DEFAULT 2.00
            );

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
        console.log("🐘 Database Updated with Truck Types and Fuel Settings");
    } catch (err) {
        console.error("DB Init Error:", err);
    }
};

initDb();
module.exports = pool;