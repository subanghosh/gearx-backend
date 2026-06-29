const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, 'vroomly.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
        return;
    }
    
    db.run("DELETE FROM service_requests WHERE id LIKE 'test_%' OR id LIKE 'req_real_%'", function(err) {
        if (err) {
            console.error('Error deleting rows:', err.message);
        } else {
            console.log(`Deleted ${this.changes} rows.`);
        }
        db.close();
    });
});
