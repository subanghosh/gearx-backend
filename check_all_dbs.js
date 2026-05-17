const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const phone = '7003540798';
const namePart = 'Suban';

const files = fs.readdirSync('.').filter(f => f.endsWith('.sqlite'));

files.forEach(file => {
    console.log(`--- Checking ${file} ---`);
    const db = new sqlite3.Database(file);

    db.all("SELECT id, name, contact, email, password FROM garages WHERE name LIKE ? OR contact LIKE ?", [`%${namePart}%`, `%${phone}%`], (err, rows) => {
        if (!err && rows && rows.length > 0) {
            console.log(`[${file}] Garages found:`, JSON.stringify(rows, null, 2));
        }

        db.all("SELECT id, name, phone, email, password FROM users WHERE name LIKE ? OR phone LIKE ?", [`%${namePart}%`, `%${phone}%`], (err2, rows2) => {
            if (!err2 && rows2 && rows2.length > 0) {
                console.log(`[${file}] Users found:`, JSON.stringify(rows2, null, 2));
            }
            db.close();
        });
    });
});
