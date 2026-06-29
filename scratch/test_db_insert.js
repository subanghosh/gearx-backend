require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
    try {
        const res = await pool.query(
            `INSERT INTO vehicles (id, customerId, make, model, type, plate, photo) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            ['test_veh_123', 'cust_final_test_3', 'Hyundai', 'i10', 'Car', 'MH12AB1234', 'photo_data']
        );
        console.log('Success!', res);
    } catch (e) {
        console.error('Error details:', e);
    } finally {
        await pool.end();
    }
}
run();
