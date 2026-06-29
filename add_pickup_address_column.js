require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function migrate() {
    try {
        console.log('Connecting to Neon database...');
        // Add pickup_address column to service_requests
        await pool.query('ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS pickup_address TEXT');
        console.log('Successfully added column "pickup_address" to service_requests table.');
    } catch (err) {
        console.error('Migration error:', err.message);
    } finally {
        await pool.end();
    }
}

migrate();
