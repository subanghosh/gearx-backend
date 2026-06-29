const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function main() {
    try {
        console.log("Searching for marshal_1782608426482 details...");
        const users = await pool.query("SELECT * FROM users WHERE id = 'marshal_1782608426482'");
        console.log("User details:", users.rows[0]);
    } catch (e) {
        console.error("Error:", e);
    } finally {
        await pool.end();
    }
}

main();
