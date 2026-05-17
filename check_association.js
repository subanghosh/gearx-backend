require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
    const phone = '9096184966';
    const resU = await pool.query("SELECT * FROM users WHERE phone = $1 OR email = $1", [phone]);
    console.log('User:', resU.rows[0]);
    if (resU.rows[0]) {
        const resG = await pool.query("SELECT * FROM garages WHERE id = $1", [resU.rows[0].garageId]);
        console.log('Garage:', resG.rows[0]);
    }
    await pool.end();
}
check();
