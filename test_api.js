const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function test() {
    try {
        await pool.query("INSERT INTO service_requests (id, lat, lng, pickup_address, status) VALUES ('req_test_location', 22.56, 88.51, 'Test Address', 'pending') ON CONFLICT (id) DO UPDATE SET status = 'pending', lat = EXCLUDED.lat, lng = EXCLUDED.lng");
        const res = await pool.query("SELECT * FROM service_requests WHERE id='req_test_location'");
        console.log('INSERTED:', res.rows[0]);
        
        require('http').get('http://localhost:3000/api/marshals/available-pickups', res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                console.log('API RESPONSE:', JSON.stringify(JSON.parse(data), null, 2));
                pool.query("DELETE FROM service_requests WHERE id='req_test_location'").finally(() => pool.end());
            });
        });
    } catch (e) {
        console.error(e);
        pool.end();
    }
}
test();
