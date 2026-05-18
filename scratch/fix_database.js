const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
    try {
        console.log('--- Step 1: Altering garage_workers table ---');
        const alters = [
            "ALTER TABLE garage_workers ADD COLUMN email TEXT",
            "ALTER TABLE garage_workers ADD COLUMN panNumber TEXT",
            "ALTER TABLE garage_workers ADD COLUMN aadhaarNumber TEXT",
            "ALTER TABLE garage_workers ADD COLUMN panUrl TEXT",
            "ALTER TABLE garage_workers ADD COLUMN aadhaarUrl TEXT",
            "ALTER TABLE garage_workers ADD COLUMN facePhotoUrl TEXT",
            "ALTER TABLE garage_workers ADD COLUMN kycStatus TEXT DEFAULT 'pending_submission'"
        ];

        for (const sql of alters) {
            try {
                await pool.query(sql);
                console.log(`Executed: ${sql}`);
            } catch (err) {
                // If column already exists, it will throw an error, which we safely ignore
                if (err.code === '42701') {
                    console.log(`Column already exists: ${sql.split(' ').pop()}`);
                } else {
                    console.error(`Error executing ${sql}:`, err.message);
                }
            }
        }

        console.log('--- Step 2: Healing missing garages in garages table ---');
        const usersRes = await pool.query("SELECT DISTINCT garageid FROM users WHERE garageid IS NOT NULL");
        console.log(`Found ${usersRes.rows.length} referenced garage IDs in users table.`);

        for (const row of usersRes.rows) {
            const gid = row.garageid;
            const gCheck = await pool.query("SELECT id FROM garages WHERE id = $1", [gid]);
            if (gCheck.rows.length === 0) {
                console.log(`Self-healing: Inserting missing garage for ID: ${gid}`);
                await pool.query(
                    `INSERT INTO garages (id, name, status) VALUES ($1, 'Self-Healed Partner Garage', 'active')`,
                    [gid]
                );
            } else {
                console.log(`Garage ID ${gid} already exists in garages table.`);
            }
        }

        console.log('Self-healing complete!');
        pool.end();
    } catch (e) {
        console.error(e);
        pool.end();
    }
}
run();
