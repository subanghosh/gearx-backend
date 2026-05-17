const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.query("SELECT * FROM information_schema.columns WHERE table_name = 'garages'", (err, res) => {
    if (err) { console.error(err); process.exit(1); }
    console.log(JSON.stringify(res.rows.map(r => r.column_name), null, 2));
    pool.end();
});
