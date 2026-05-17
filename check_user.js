const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const db = new sqlite3.Database('vroomly2.sqlite');

console.log(`Dumping all records to file...`);

db.all("SELECT id, name, contact, email, password, status FROM garages", [], (err, garages) => {
    if (err) console.error('Garages Error:', err);

    db.all("SELECT id, name, phone, email, password, role, status FROM users", [], (err2, users) => {
        if (err2) console.error('Users Error:', err2);

        const output = {
            garages,
            users
        };

        fs.writeFileSync('db_dump.json', JSON.stringify(output, null, 2));
        console.log('Dump written to db_dump.json');
        db.close();
    });
});
