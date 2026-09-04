const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'redrivo2.sqlite');
const db = new sqlite3.Database(dbPath);

const marshal = {
    id: 'marshal_1',
    name: 'Test Marshal',
    phone: '9999999999',
    email: 'marshal@vroomer.com',
    role: 'marshal',
    password: 'marshal123',
    status: 'active',
    emailVerified: 1,
    phoneVerified: 1,
    dlBikeVerified: 1,
    dlCarVerified: 1,
    dlNumber: 'DL-IND-2026-0001'
};

db.serialize(() => {
    // Delete existing if any
    db.run("DELETE FROM users WHERE id = ?", [marshal.id], (err) => {
        if (err) console.error("Error deleting old marshal:", err.message);
    });

    const sql = `INSERT INTO users (
        id, name, phone, email, role, password, status, 
        emailVerified, phoneVerified, dlBikeVerified, dlCarVerified, dlNumber
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    db.run(sql, [
        marshal.id, marshal.name, marshal.phone, marshal.email, marshal.role, marshal.password, marshal.status,
        marshal.emailVerified, marshal.phoneVerified, marshal.dlBikeVerified, marshal.dlCarVerified, marshal.dlNumber
    ], function (err) {
        if (err) {
            console.error("Error creating marshal:", err.message);
        } else {
            console.log("Test Marshal created successfully with ID: marshal_1");
            console.log("Credentials: marshal@vroomer.com / marshal123");
        }
        db.close();
    });
});
