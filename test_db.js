const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./vroomly2.sqlite');
db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='otp_verifications'", (err, rows) => {
    if (err) console.error(err);
    console.log("Database Probe - Tables found:", rows);
    process.exit();
});
