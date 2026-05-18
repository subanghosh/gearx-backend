const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
    try {
        const res = await pool.query("SELECT id, name, role, phone, email, garageid FROM users");
        console.log('--- Postgres Users ---');
        console.log(res.rows);
        pool.end();
    } catch (e) {
        console.error(e);
        pool.end();
    }
}
run();
