const fs = require('fs');
const path = 'C:/Users/Suban/OneDrive/Documents/redrivo-backend/index.js';
let code = fs.readFileSync(path, 'utf8');

// 1. Add lat/lng columns to the service_requests table definition
const oldSchema = `id TEXT PRIMARY KEY, customerId TEXT, vehicleId TEXT, garageId TEXT, date TEXT, status TEXT,
            totalCustomerPrice REAL DEFAULT 0, workerId TEXT, auditStatus TEXT DEFAULT 'pending',
            service_category TEXT DEFAULT 'Standard Service', inspection_fee REAL DEFAULT 299,
            parts_cost REAL DEFAULT 0, labor_cost REAL DEFAULT 0, marshal_commission REAL DEFAULT 0,
            FOREIGN KEY(workerId) REFERENCES users(id)`;

const newSchema = `id TEXT PRIMARY KEY, customerId TEXT, vehicleId TEXT, garageId TEXT, date TEXT, status TEXT,
            totalCustomerPrice REAL DEFAULT 0, workerId TEXT, auditStatus TEXT DEFAULT 'pending',
            service_category TEXT DEFAULT 'Standard Service', inspection_fee REAL DEFAULT 299,
            parts_cost REAL DEFAULT 0, labor_cost REAL DEFAULT 0, marshal_commission REAL DEFAULT 0,
            lat REAL, lng REAL,
            FOREIGN KEY(workerId) REFERENCES users(id)`;

if (code.includes(oldSchema)) {
    code = code.replace(oldSchema, newSchema);
    console.log('Schema updated with lat/lng');
} else {
    console.log('Schema NOT found - trying alternate');
}

// 2. Fix the available-pickups SQL to remove lat/lng (since old rows won't have them - use COALESCE)
const oldPickupSQL = `SELECT 
            sr.id,
            sr.lat as pickupLat,
            sr.lng as pickupLng,
            c.name as customerName,`;
const newPickupSQL = `SELECT 
            sr.id,
            COALESCE(sr.lat, 0) as pickupLat,
            COALESCE(sr.lng, 0) as pickupLng,
            c.name as customerName,`;

if (code.includes(oldPickupSQL)) {
    code = code.replace(oldPickupSQL, newPickupSQL);
    console.log('Pickup SQL fixed with COALESCE');
} else {
    console.log('Pickup SQL not found with that exact text');
    // Try to find it
    const idx = code.indexOf('available-pickups');
    console.log('Found route at char:', idx);
    console.log(code.substring(idx, idx + 300));
}

// 3. Also add ALTER TABLE statements to add lat/lng if missing
const alterPos = code.indexOf('db.run("ALTER TABLE service_requests ADD COLUMN workerId TEXT"');
if (alterPos !== -1) {
    const insertAfter = code.indexOf('\n', alterPos) + 1;
    const newAlters = `        db.run("ALTER TABLE service_requests ADD COLUMN lat REAL", () => {});\n        db.run("ALTER TABLE service_requests ADD COLUMN lng REAL", () => {});\n`;
    code = code.substring(0, insertAfter) + newAlters + code.substring(insertAfter);
    console.log('ALTER TABLE statements added for lat/lng');
}

fs.writeFileSync(path, code);
console.log('Done');
