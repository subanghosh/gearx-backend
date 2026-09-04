const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function checkIncentiveTables() {
    try {
        console.log("Connecting to PostgreSQL...");
        
        // 1. Check if tables exist
        const tableCheck = await pool.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
              AND table_name IN ('incentive_slabs', 'system_settings', 'incentives')
        `);
        console.log("\n--- Existing Tables in PG ---");
        console.log(tableCheck.rows);

        // 2. Describe columns
        for (const tbl of ['incentive_slabs', 'system_settings', 'incentives']) {
            const colCheck = await pool.query(`
                SELECT column_name, data_type 
                FROM information_schema.columns 
                WHERE table_name = $1
            `, [tbl]);
            console.log(`\nColumns of ${tbl}:`);
            console.log(colCheck.rows);
        }

        // 3. Query some data
        const settingsRes = await pool.query("SELECT * FROM system_settings LIMIT 5");
        console.log("\n--- System Settings Data ---");
        console.log(settingsRes.rows);

        try {
            const slabsRes = await pool.query("SELECT * FROM incentive_slabs LIMIT 5");
            console.log("\n--- Incentive Slabs Data ---");
            console.log(slabsRes.rows);
        } catch (eSlab) {
            console.error("Failed to query incentive_slabs:", eSlab.message);
        }

    } catch (e) {
        console.error("Check failed:", e);
    } finally {
        await pool.end();
    }
}

checkIncentiveTables();
