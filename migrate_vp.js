require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(`ALTER TABLE master_skus ADD COLUMN IF NOT EXISTS vroomerPrice REAL DEFAULT 0`)
  .then(() => { console.log('vroomerPrice column added.'); process.exit(0); })
  .catch(e => { console.error(e.message); process.exit(1); });
