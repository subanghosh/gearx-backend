const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');

code = code.replace(/const sqlite3 = require\('sqlite3'\)\.verbose\(\);/, `require('dotenv').config();
const { Pool } = require('pg');`);

const dbReplacement = `const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = {
    convertQuery: (sql) => {
        let i = 1;
        return sql.replace(/\\?/g, () => "\\$" + (i++));
    },
    run: (sql, params, cb) => {
        if (typeof params === 'function') { cb = params; params = []; }
        pool.query(db.convertQuery(sql), params || [])
            .then(res => cb && cb(null))
            .catch(err => {
                if (err.code === '42701' || err.code === '42P07') return cb && cb(null);
                cb && cb(err);
            });
    },
    get: (sql, params, cb) => {
        if (typeof params === 'function') { cb = params; params = []; }
        pool.query(db.convertQuery(sql), params || [])
            .then(res => cb && cb(null, res.rows[0]))
            .catch(err => cb && cb(err));
    },
    all: (sql, params, cb) => {
        if (typeof params === 'function') { cb = params; params = []; }
        pool.query(db.convertQuery(sql), params || [])
            .then(res => cb && cb(null, res.rows))
            .catch(err => cb && cb(err));
    },
    serialize: (cb) => { cb(); },
    prepare: (sql) => {
        return {
            run: (params) => {
                pool.query(db.convertQuery(sql), params || []).catch(console.error);
            },
            finalize: () => {}
        };
    }
};

pool.connect((err, client, release) => {
    if (err) return console.error('Error acquiring client', err.stack);
    console.log('Connected to Neon PostgreSQL.');
    release();
    initializeDatabase();
});
`;

code = code.replace(/const db = new sqlite3\.Database\('\.\/vroomly2\.sqlite', \(err\) => {[\s\S]*?}\);/, dbReplacement);

code = code.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY');
code = code.replace(/DATETIME/g, 'TIMESTAMP');
code = code.replace(/datetime\('now'\)/g, 'CURRENT_TIMESTAMP');

fs.writeFileSync('index.js', code);
console.log('Migration complete');
