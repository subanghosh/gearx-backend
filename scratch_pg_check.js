const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function main() {
    try {
        console.log("Checking columns of users table in Postgres...");
        const res = await pool.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'users'
        `);
        console.log("Columns:", res.rows);
    } catch (e) {
        console.error("Error:", e);
    } finally {
        await pool.end();
    }
}

main();
