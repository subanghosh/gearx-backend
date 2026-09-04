const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./redrivo2.sqlite');

db.serialize(() => {
    db.all("SELECT * FROM garages", [], (err, rows) => {
        console.log("GARAGES:", JSON.stringify(rows, null, 2));
    });
    db.all("SELECT * FROM users WHERE role = 'garage'", [], (err, rows) => {
        console.log("GARAGE USERS:", JSON.stringify(rows, null, 2));
    });
});
db.close();
