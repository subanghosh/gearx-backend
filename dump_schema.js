const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('vroomly2.sqlite');

db.all("SELECT name, sql FROM sqlite_master WHERE type='table'", [], (err, rows) => {
    if (err) console.error(err);
    rows.forEach(row => {
        console.log(`Table: ${row.name}`);
        console.log(row.sql);
        console.log('---');
    });
    db.close();
});
