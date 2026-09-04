const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('redrivo2.sqlite');

db.serialize(() => {
    console.log('Purging all data except for admin user...');

    const tablesToWipe = [
        'customers',
        'vehicles',
        'service_requests',
        'garages',
        'trips',
        'media',
        'audits',
        'marshal_bonuses',
        'incentives',
        'garage_rates',
        'garage_documents',
        'garage_rate_requests',
        'otp_verifications'
    ];

    tablesToWipe.forEach(table => {
        db.run(`DELETE FROM ${table}`, (err) => {
            if (err) console.error(`Error wiping ${table}:`, err.message);
            else console.log(`Wiped ${table}`);
        });
    });

    // For users, we keep only 'admin'
    db.run("DELETE FROM users WHERE id != 'admin'", (err) => {
        if (err) console.error('Error wiping users:', err.message);
        else console.log('Wiped users (preserved admin)');
    });
});

db.close();
