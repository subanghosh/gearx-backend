require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function dump() {
    try {
        const res = await pool.query("SELECT id, name, role, email, phone, kycstatus FROM users WHERE role = 'marshal'");
        console.log("Marshals in PostgreSQL:");
        console.log(res.rows);
        
        const res2 = await pool.query("SELECT id, name, role, email, phone FROM users WHERE role = 'customer'");
        console.log("Customers in PostgreSQL:");
        console.log(res2.rows);

        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
dump();
