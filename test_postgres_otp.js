require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
    console.log('--- Postgres Connection & Table Test ---');
    try {
        const client = await pool.connect();
        console.log('Connected successfully!');
        
        // 1. Let's see if the table exists and check its columns
        const colRes = await pool.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'otp_verifications'
        `);
        console.log('Current columns in otp_verifications table:');
        console.log(colRes.rows);

        // 2. Try the insert query
        const phone = '9093184965';
        const otp = '123456';
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        
        console.log('Attempting insert query...');
        await pool.query(
            `INSERT INTO otp_verifications (entityid, entitytype, phone, email, otp, expiresat) VALUES ('TEMP', 'auth', $1, $2, $3, $4)`,
            [phone, null, otp, expiresAt]
        );
        console.log('INSERT SUCCESSFUL!');
        
        client.release();
        process.exit(0);
    } catch (e) {
        console.error('ERROR OCCURRED:', e);
        process.exit(1);
    }
}

check();
