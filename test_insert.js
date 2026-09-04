const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('redrivo2.sqlite');
db.run("INSERT INTO vehicles (id, customerId, make, model, type, plate, photo) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ['test_1', 'cust_1', 'Honda', 'Civic', 'Car', 'XYZ123', null], (err) => {
    console.log('Insert error:', err ? err.message : 'Success!');
});
