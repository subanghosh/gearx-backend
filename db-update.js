require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  try {
    console.log("Checking DB connection...");
    
    // 1. Drop existing incentive_settings to recreate with new schema
    await pool.query("DROP TABLE IF EXISTS incentive_settings");
    console.log("Dropped incentive_settings");

    // 2. Create the new schema
    await pool.query(`
        CREATE TABLE incentive_settings (
            id SERIAL PRIMARY KEY,
            minDistance REAL,
            maxDistance REAL,
            baseRate REAL,
            actualRate REAL,
            commissionPct REAL
        )
    `);
    console.log("Created new incentive_settings table");

    // 3. Insert default settings per user requirement
    await pool.query(`
        INSERT INTO incentive_settings (minDistance, maxDistance, baseRate, actualRate, commissionPct) VALUES 
        (0, 10, 25, 35, 50),
        (10, 15, 25, 30, 60),
        (15, 50, 25, 27, 70),
        (50, 9999, 25, 25, 80)
    `);
    console.log("Inserted slabs into incentive_settings");

    // 4. Create global_settings if it doesn't exist
    await pool.query(`
        CREATE TABLE IF NOT EXISTS global_settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    `);
    console.log("Created global_settings table");

    // 5. Insert default global settings
    await pool.query(`
        INSERT INTO global_settings (key, value) VALUES 
        ('five_star_bonus', '50'),
        ('payout_days', '3')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `);
    console.log("Inserted global_settings");

    // 6. Update service_requests table to add distance/base/extra amounts
    await pool.query(`
        ALTER TABLE service_requests 
        ADD COLUMN IF NOT EXISTS distanceKm REAL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS baseAmount REAL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS extraAmount REAL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS totalCustomerPrice REAL DEFAULT 0
    `);
    console.log("Updated service_requests schema");

  } catch (err) {
    console.error("DB Error:", err);
  } finally {
    pool.end();
  }
}
run();
