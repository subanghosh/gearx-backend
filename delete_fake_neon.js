require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function run() {
    try {
        console.log('Connecting to Neon DB...');
        const res = await pool.query("DELETE FROM service_requests WHERE id LIKE 'test_%' OR id LIKE 'req_real_%' RETURNING id");
        console.log(`Deleted ${res.rowCount} rows. IDs:`, res.rows.map(r => r.id));
    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

run();
