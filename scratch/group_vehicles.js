require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function dump() {
    try {
        const res = await pool.query("SELECT customerid, COUNT(*) FROM vehicles GROUP BY customerid");
        console.log("Vehicles per customer:");
        console.log(res.rows);
        
        const res2 = await pool.query("SELECT id, customerid, make, model, plate FROM vehicles");
        console.log("All vehicles:");
        console.log(res2.rows);

        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
dump();
