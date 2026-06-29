const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const db = new sqlite3.Database(path.join(__dirname, 'gearx.db'));
db.all("SELECT id, name, role, phone, kycStatus FROM users WHERE role='marshal'", (err, rows) => {
    if (err) console.error(err);
    else console.log('Marshal in SQLite:', rows);
    db.close();
});
