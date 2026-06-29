const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query("SELECT * FROM otp_verifications ORDER BY id DESC LIMIT 5").then(res => console.log(res.rows)).finally(() => pool.end());
