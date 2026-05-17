require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function find() {
    try {
        const res = await pool.query("SELECT id, name, contact FROM garages");
        console.log('Garages:', JSON.stringify(res.rows, null, 2));
        
        const resU = await pool.query("SELECT id, name, contact, phone, \"garageId\" FROM users");
        console.log('Users:', JSON.stringify(resU.rows, null, 2));
    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await pool.end();
    }
}
find();
