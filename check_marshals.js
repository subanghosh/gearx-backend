require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.query(`
    SELECT id, name, role, status, kycstatus, 'garage_workers' as source FROM garage_workers WHERE role ILIKE '%marshal%'
    UNION ALL
    SELECT id, name, role, status, kycstatus, 'users' as source FROM users WHERE role ILIKE '%marshal%'
`).then(res => {
    console.table(res.rows);
    process.exit(0);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
