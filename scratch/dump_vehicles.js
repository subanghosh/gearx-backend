require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function dump() {
    try {
        const res = await pool.query("SELECT * FROM vehicles");
        console.log("Vehicles in PostgreSQL:");
        console.log(res.rows);
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
dump();
