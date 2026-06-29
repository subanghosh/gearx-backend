require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.query("SELECT pannumber, aadhaarnumber, panurl, aadhaarurl FROM users WHERE id = 'm_1'").then(res => {
    console.table(res.rows);
    process.exit(0);
});
