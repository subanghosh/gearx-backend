const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
    // What does the users table have for this phone?
    const r1 = await pool.query("SELECT id, name, role, phone FROM users WHERE phone IN ($1, $2)", ['7003567876', '+917003567876']);
    console.log('Users table match:', r1.rows);

    // What does garages table have?
    const r2 = await pool.query("SELECT id, name, contact, email FROM garages WHERE contact IN ($1, $2)", ['7003567876', '+917003567876']);
    console.log('Garages table match:', r2.rows);

    pool.end();
})().catch(err => { console.error(err); pool.end(); });
