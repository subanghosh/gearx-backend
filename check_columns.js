require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
    try {
        const res = await pool.query("SELECT * FROM garages LIMIT 1");
        console.log('Columns:', Object.keys(res.rows[0] || {}));
    } catch (e) {
        console.error('Query error:', e.message);
    } finally {
        await pool.end();
    }
}
check();
