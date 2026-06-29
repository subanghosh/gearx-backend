const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://neondb_owner:npg_I3q2cfjCLbWN@ep-misty-fire-angs4p3i.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require' });
pool.query("SHOW TIMEZONE").then(res => { console.log(res.rows); process.exit(0); });
