require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function query() {
    try {
        const res = await pool.query("SELECT id, name, \"panNumber\", \"accountType\", \"govIdNumber\", status FROM garages WHERE name ILIKE '%Suban%'");
        console.log('Results:', JSON.stringify(res.rows, null, 2));
    } catch (e) {
        console.error('Query error:', e.message);
    } finally {
        await pool.end();
    }
}
query();
