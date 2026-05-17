const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const db = new sqlite3.Database('./vroomly2.sqlite');

const tablesToWipe = [
    'customers',
    'vehicles',
    'service_requests',
    'garages',
    'trips',
    'otp_verifications',
    'garage_rates',
    'audits'
];

db.serialize(() => {
    console.log('--- Starting Full Reset ---');

    tablesToWipe.forEach(table => {
        db.run(`DELETE FROM ${table}`, (err) => {
            if (err) console.error(`Failed to wipe ${table}:`, err.message);
            else console.log(`Wiped table: ${table}`);
        });
    });

    db.run("DELETE FROM users WHERE id != 'u_admin'", (err) => {
        if (err) console.error('Failed to wipe users:', err.message);
        else console.log('Wiped table: users (preserved u_admin)');
    });

    // Reset admin password to 'admin' just in case
    db.run("UPDATE users SET password = 'admin' WHERE id = 'u_admin'", (err) => {
        if (err) console.error('Failed to reset admin pass:', err.message);
        else console.log('Reset admin password to "admin"');
    });

    console.log('--- Database Wipe Complete ---');
});

db.close((err) => {
    if (err) console.error(err.message);

    // Clear uploads
    const uploadsDir = './uploads';
    if (fs.existsSync(uploadsDir)) {
        const files = fs.readdirSync(uploadsDir);
        files.forEach(file => {
            const filePath = path.join(uploadsDir, file);
            if (fs.statSync(filePath).isFile()) {
                fs.unlinkSync(filePath);
                console.log(`Deleted upload: ${file}`);
            }
        });
    }

    // Delete obsolete DBs
    const obsoleteDbs = ['./database.sqlite', './vroomly.sqlite'];
    obsoleteDbs.forEach(dbPath => {
        if (fs.existsSync(dbPath)) {
            try {
                fs.unlinkSync(dbPath);
                console.log(`Deleted obsolete DB: ${dbPath}`);
            } catch (e) {
                console.warn(`Could not delete ${dbPath} (might be in use)`);
            }
        }
    });

    console.log('--- All cleanup done ---');
});
