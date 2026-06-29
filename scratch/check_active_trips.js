const { Pool } = require('pg');
require('dotenv').config({ path: '../.env' });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function main() {
    try {
        console.log('Querying marshals in Neon...');
        const res = await pool.query("SELECT id, name, phone, role FROM users WHERE role = 'marshal'");
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (err) {
        console.error('Error querying database:', err);
    } finally {
        await pool.end();
    }
}

main();
