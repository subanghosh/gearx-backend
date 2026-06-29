const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function main() {
    try {
        console.log("Connecting to Neon Postgres...");
        
        const vehicles = await pool.query("SELECT * FROM vehicles ORDER BY id DESC LIMIT 20");
        console.log("Latest vehicles in database:", vehicles.rows);

        const customers = await pool.query("SELECT * FROM customers ORDER BY id DESC LIMIT 20");
        console.log("Latest customers in database:", customers.rows);

    } catch (e) {
        console.error("Error:", e);
    } finally {
        await pool.end();
    }
}

main();
