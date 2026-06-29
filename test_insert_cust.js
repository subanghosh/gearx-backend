require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query('INSERT INTO customers (id, name, phone, email) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, email = EXCLUDED.email', ['cust_manual_test_3', 'Manual Test 3', '1234567890', 'test@test.com'], (err, res) => {
    console.log(err ? err.message : res.rowCount);
    pool.end();
});
