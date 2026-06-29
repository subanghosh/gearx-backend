const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function test() {
    try {
        await pool.query("UPDATE service_requests SET status = 'pending' WHERE id='req_9pkx3ba4w'");
        
        require('http').get('http://localhost:3000/api/marshals/available-pickups', res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', async () => {
                const requests = JSON.parse(data);
                const req = requests.find(r => r.id === 'req_9pkx3ba4w');
                console.log('API RESPONSE for req_9pkx3ba4w:');
                console.log('pickupLat:', req.pickupLat);
                console.log('pickupLng:', req.pickupLng);
                console.log('pickupAddress:', req.pickupAddress);
                console.log('keys:', Object.keys(req));
                await pool.query("UPDATE service_requests SET status = 'cancelled' WHERE id='req_9pkx3ba4w'");
                pool.end();
            });
        });
    } catch (e) {
        console.error(e);
        pool.end();
    }
}
test();
