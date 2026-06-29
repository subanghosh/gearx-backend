const { Pool } = require('pg'); 
require('dotenv').config(); 
const pool = new Pool({ connectionString: process.env.DATABASE_URL }); 
async function run() { 
    try { 
        await pool.query(`INSERT INTO service_requests (id, customerid, date, status) VALUES ('req_test_1', 'cust_1', '2026-06-06', 'pending')`); 
        const http = require('http'); 
        http.get('http://localhost:3000/api/marshals/available-pickups', res => { 
            let data = ''; 
            res.on('data', chunk => data += chunk); 
            res.on('end', async () => { 
                console.log('API Response:', data); 
                await pool.query(`DELETE FROM service_requests WHERE id='req_test_1'`); 
                pool.end(); 
            }); 
        }); 
    } catch (err) { 
        console.error('Error:', err.message); 
        pool.end(); 
    } 
} 
run();
