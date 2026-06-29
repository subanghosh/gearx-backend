const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query("SELECT id, name, kycstatus, role FROM users WHERE name = 'Suban Test Marshal'").then(res => console.table(res.rows)).finally(() => pool.end());
