require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const queries = [
    "ALTER TABLE garages ADD COLUMN IF NOT EXISTS accountType TEXT;",
    "ALTER TABLE garages ADD COLUMN IF NOT EXISTS govIdNumber TEXT;"
];

async function migrate() {
    console.log('Connecting to database...');
    const client = await pool.connect();
    try {
        for (const q of queries) {
            console.log(`Executing: ${q}`);
            await client.query(q).catch(err => {
                if (err.code === '42701') {
                    console.log('Column already exists, skipping.');
                } else {
                    console.error('Error executing query:', err.message);
                }
            });
        }
        console.log('Migration complete!');
    } finally {
        client.release();
        await pool.end();
    }
}

migrate();
