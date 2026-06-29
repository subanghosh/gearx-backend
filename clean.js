const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function clean() {
    try {
        const res = await pool.query("DELETE FROM service_requests WHERE id='req_test_999'");
        console.log('Deleted test requests:', res.rowCount);
    } catch (e) {
        console.error(e);
    } finally {
        pool.end();
    }
}
clean();
