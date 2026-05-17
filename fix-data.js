const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./vroomly2.sqlite');

db.serialize(() => {
    db.get("SELECT id, name, phone, email, password FROM users WHERE role = 'garage' AND garageId IS NULL", (err, user) => {
        if (err) {
            console.error("User search error:", err.message);
            db.close();
            return;
        }

        if (user) {
            console.log("Fixing user:", user.id);
            const garageId = 'g_1';

            db.run("INSERT INTO garages (id, name, contact, email, password, status) VALUES (?, ?, ?, ?, ?, 'active')",
                [garageId, user.name, user.phone, user.email, user.password], (e) => {
                    if (e) {
                        console.error("Error creating garage:", e.message);
                        // If it already exists, still try to link
                    } else {
                        console.log("Garage created:", garageId);
                    }

                    db.run("UPDATE users SET garageId = ? WHERE id = ?", [garageId, user.id], (e2) => {
                        if (e2) console.error("Error linking user:", e2.message);
                        else console.log("User linked to garage!");
                        db.close();
                    });
                });
        } else {
            console.log("No broken garage users found.");
            db.close();
        }
    });
});
