const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('redrivo2.sqlite');

db.serialize(() => {
    console.log('Starting migration...');

    // 1. Rename existing table
    db.run("ALTER TABLE users RENAME TO users_old", (err) => {
        if (err) {
            console.error('Rename failed (maybe table already renamed?):', err.message);
            return;
        }

        // 2. Create new table without NOT NULL on email, and removing the UNIQUE if needed (though NULLs are fine in UNIQUE)
        db.run(`CREATE TABLE users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            email TEXT, -- Removed NOT NULL and UNIQUE for flexibility
            role TEXT NOT NULL CHECK(role IN ('admin', 'marshal', 'mechanic', 'customer')),
            password TEXT NOT NULL,
            garageId TEXT,
            status TEXT DEFAULT 'active',
            phoneVerified INTEGER DEFAULT 0
        )`, (err2) => {
            if (err2) {
                console.error('Create new table failed:', err2.message);
                return;
            }

            // 3. Copy data
            db.run(`INSERT INTO users (id, name, phone, email, role, password, garageId, status, phoneVerified)
                    SELECT id, name, phone, email, role, password, garageId, status, phoneVerified FROM users_old`, (err3) => {
                if (err3) {
                    console.error('Data copy failed:', err3.message);
                } else {
                    console.log('Data migrated successfully.');
                    // 4. Drop old table
                    db.run("DROP TABLE users_old", (err4) => {
                        if (err4) console.error('Drop old table failed:', err4.message);
                        else console.log('Migration complete.');
                    });
                }
            });
        });
    });
});
