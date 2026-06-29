const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query("SELECT id, name, role, phone, status, kycstatus FROM users WHERE role='marshal'").then(res => console.log(res.rows)).finally(() => pool.end());
