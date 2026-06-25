const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function test() {
    try {
        const res = await pool.query("SELECT * FROM vehicles WHERE id='veh_8mwj3p1km'");
        console.log(res.rows);
    } catch (e) {
        console.error(e);
    } finally {
        pool.end();
    }
}
test();
