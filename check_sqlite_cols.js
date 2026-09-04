const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('c:/Users/Suban/OneDrive/Documents/redrivo-backend/redrivo.db');

db.all("PRAGMA table_info(service_requests)", [], (err, rows) => {
    if (err) {
        console.error(err);
    } else {
        console.log("service_requests columns in SQLite:");
        rows.forEach(r => console.log(`- ${r.name}: ${r.type}`));
    }
    db.close();
});
