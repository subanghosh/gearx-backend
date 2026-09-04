const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config({ path: '../.env' });

async function clearNeon() {
    console.log('--- Clearing Neon DB ---');
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        const tables = [
            'trips',
            'service_progress',
            'repair_evidence',
            'audit_items',
            'media',
            'otp_verifications',
            'audits',
            'incentives',
            'marshal_bonuses',
            'service_requests'
        ];
        
        for (const table of tables) {
            try {
                const res = await pool.query(`DELETE FROM ${table}`);
                console.log(`Deleted rows from Neon table "${table}":`, res.rowCount);
            } catch (tableErr) {
                console.warn(`Warning/Error clearing Neon table "${table}":`, tableErr.message);
            }
        }
    } catch (err) {
        console.error('Error clearing Neon DB:', err);
    } finally {
        await pool.end();
    }
}

function clearSQLite() {
    return new Promise((resolve) => {
        console.log('--- Clearing SQLite DB (redrivo2.sqlite) ---');
        const db = new sqlite3.Database('../redrivo2.sqlite', (err) => {
            if (err) {
                console.error('Error opening SQLite DB:', err.message);
                resolve();
                return;
            }
        });

        db.serialize(() => {
            const tables = [
                'trips',
                'service_progress',
                'repair_evidence',
                'audit_items',
                'media',
                'otp_verifications',
                'audits',
                'incentives',
                'marshal_bonuses',
                'service_requests'
            ];
            let completed = 0;

            tables.forEach(table => {
                db.run(`DELETE FROM ${table}`, function(err) {
                    if (err) {
                        console.warn(`Warning/Error clearing SQLite table "${table}":`, err.message);
                    } else {
                        console.log(`Deleted rows from SQLite table "${table}":`, this.changes);
                    }
                    completed++;
                    if (completed === tables.length) {
                        db.close(() => {
                            resolve();
                        });
                    }
                });
            });
        });
    });
}

async function main() {
    await clearNeon();
    await clearSQLite();
    console.log('--- All Cleared ---');
}

main();
