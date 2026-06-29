const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='users'").then(res => console.log(res.rows.map(r=>r.column_name))).finally(() => pool.end());
