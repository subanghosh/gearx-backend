const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('vroomly2.sqlite');

function query(sql) {
    return new Promise((resolve, reject) => {
        db.all(sql, [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function run() {
    try {
        const users = await query("SELECT id, name, role FROM users");
        console.log('--- USERS ---', users.length);
        console.log(users);

        const customers = await query("SELECT id, name FROM customers");
        console.log('--- CUSTOMERS ---', customers.length);
        console.log(customers);

        const vehicles = await query("SELECT id, plate, makeModel FROM vehicles");
        console.log('--- VEHICLES ---', vehicles.length);
        console.log(vehicles);

        const requests = await query("SELECT id, status FROM service_requests");
        console.log('--- SERVICE REQUESTS ---', requests.length);
        console.log(requests);

        const garages = await query("SELECT id, name FROM garages");
        console.log('--- GARAGES ---', garages.length);
        console.log(garages);

    } catch (err) {
        console.error(err);
    } finally {
        db.close();
    }
}

run();
