const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function main() {
    try {
        console.log("Checking customer vehicles...");
        const res = await pool.query(`
            SELECT customerid, COUNT(*) as count 
            FROM vehicles 
            GROUP BY customerid 
            HAVING COUNT(*) > 1
        `);
        console.log("Customers with multiple vehicles:", res.rows);
        
        for (const r of res.rows) {
            const customerId = r.customerid;
            const vehs = await pool.query("SELECT * FROM vehicles WHERE customerid = $1", [customerId]);
            console.log(`Vehicles for customer ${customerId}:`, vehs.rows);
        }
    } catch (e) {
        console.error("Error:", e);
    } finally {
        await pool.end();
    }
}

main();
