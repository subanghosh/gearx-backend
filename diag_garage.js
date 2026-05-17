require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
    try {
        const res = await pool.query("SELECT * FROM garages WHERE name ILIKE '%Suban_Test Garage%'");
        console.log('Record:', JSON.stringify(res.rows[0], null, 2));
    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await pool.end();
    }
}
check();
