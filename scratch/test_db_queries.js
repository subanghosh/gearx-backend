const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const db = {
    convertQuery: (sql) => {
        let i = 1;
        return sql.replace(/\?/g, () => "\$" + (i++));
    },
    run: (sql, params) => {
        return pool.query(db.convertQuery(sql), params || []);
    },
    get: (sql, params) => {
        return pool.query(db.convertQuery(sql), params || []).then(res => res.rows[0]);
    }
};

async function test() {
    try {
        console.log('--- Checking existing worker ---');
        const existing = await db.get("SELECT id FROM garage_workers WHERE garageId = ? AND phone = ?", ['Test001', '+919094567876']);
        console.log('Existing:', existing);

        console.log('--- Inserting into users ---');
        const res1 = await db.run("INSERT INTO users (id, name, phone, password, role, garageId) VALUES (?, ?, ?, ?, ?, ?)", 
            ['wkr_test1', 'Rafikul Test', '+919094567876', '', 'mechanic|Engine System', 'Test001']);
        console.log('Users insert success!');

        console.log('--- Inserting into garage_workers ---');
        const res2 = await db.run("INSERT INTO garage_workers (id, garageId, name, phone, role) VALUES (?, ?, ?, ?, ?)", 
            ['wkr_test1', 'Test001', 'Rafikul Test', '+919094567876', 'mechanic|Engine System']);
        console.log('Garage workers insert success!');

        pool.end();
    } catch (e) {
        console.error('FAILED WITH ERROR:', e);
        pool.end();
    }
}
test();
