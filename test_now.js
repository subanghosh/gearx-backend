const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query("SELECT NOW(), CURRENT_TIMESTAMP, LOCALTIMESTAMP").then(res => console.log(res.rows[0])).finally(() => pool.end());
