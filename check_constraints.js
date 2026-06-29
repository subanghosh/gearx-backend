const { Pool } = require('pg'); 
require('dotenv').config(); 
const pool = new Pool({ connectionString: process.env.DATABASE_URL }); 
async function run() { 
    try { 
        const res = await pool.query(`SELECT conname, pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE conrelid::regclass::text = 'service_requests'`); 
        console.log(res.rows); 
    } catch (err) { 
        console.error('Error:', err.message); 
    } finally { 
        pool.end(); 
    } 
} 
run();
