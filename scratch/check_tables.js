const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
    try {
        const usersCols = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'users'");
        console.log('--- users columns ---');
        console.log(usersCols.rows.map(r => `${r.column_name} (${r.data_type})`));

        const workersCols = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'garage_workers'");
        console.log('--- garage_workers columns ---');
        console.log(workersCols.rows.map(r => `${r.column_name} (${r.data_type})`));

        const constraintRes = await pool.query(`
            SELECT conname, pg_get_constraintdef(c.oid) 
            FROM pg_constraint c 
            JOIN pg_namespace n ON n.oid = c.connamespace 
            WHERE n.nspname = 'public' AND c.conrelid::regclass::text IN ('users', 'garage_workers')
        `);
        console.log('--- constraints ---');
        console.log(constraintRes.rows);

        pool.end();
    } catch (e) {
        console.error(e);
        pool.end();
    }
}
run();
