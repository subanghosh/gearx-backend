require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query('SELECT id, filePath AS "filePath", fileName AS "fileName", docType AS "docType" FROM media WHERE referenceId = $1', ['gar_1776577804675'])
  .then(res => { console.log(res.rows); process.exit(0); })
  .catch(err => { console.error(err); process.exit(1); });
