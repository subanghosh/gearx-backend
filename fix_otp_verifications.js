require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function fix() {
    console.log('Connecting to database...');
    try {
        await pool.query('DROP TABLE IF EXISTS otp_verifications CASCADE');
        console.log('Successfully dropped old otp_verifications table.');
        
        // Recreate it properly with lowercase columns
        await pool.query(`
            CREATE TABLE otp_verifications (
                id SERIAL PRIMARY KEY,
                entityid TEXT,
                entitytype TEXT,
                phone TEXT,
                email TEXT,
                otp TEXT NOT NULL,
                createdat TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expiresat TIMESTAMP,
                verifiedat TIMESTAMP
            )
        `);
        console.log('Successfully recreated otp_verifications with lowercase columns.');
        process.exit(0);
    } catch (e) {
        console.error('Error during migration:', e.message);
        process.exit(1);
    }
}

fix();
