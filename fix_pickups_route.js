const fs = require('fs');
const path = 'C:/Users/Suban/OneDrive/Documents/vroomly-backend/index.js';
let code = fs.readFileSync(path, 'utf8');

// Replace the available-pickups route
const oldRoute = `apiRouter.get('/marshals/available-pickups', (req, res) => {
    db.all(
        \`SELECT 
            sr.id,
            c.name as "customerName",
            sr.service_category as "issue",
            sr.inspection_fee as "pickupDropCost",
            sr.service_category as "serviceType",
            'Home Pickup' as "pickupDropType",
            v.make || ' ' || v.model as "vehicleModel",
            v.plate as "vehicleRegNumber"
         FROM service_requests sr 
         LEFT JOIN customers c ON sr.customerId = c.id 
         LEFT JOIN vehicles v ON sr.vehicleId = v.id
         WHERE sr.status = 'pending' AND (sr.workerId IS NULL OR sr.workerId = '')\`,
        [],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});`;

const newRoute = `apiRouter.get('/marshals/available-pickups', (req, res) => {
    db.all(
        \`SELECT 
            sr.id,
            sr.lat as pickupLat,
            sr.lng as pickupLng,
            c.name as customerName,
            sr.service_category as issue,
            sr.service_category as serviceType,
            'Home Pickup' as pickupDropType,
            v.make as vehicleMake,
            v.model as vehicleModel,
            v.make || ' ' || v.model as vehicleFullName,
            v.type as vehicleSubType,
            v.plate as vehicleRegNumber,
            v.photo as vehiclePhoto
         FROM service_requests sr 
         LEFT JOIN customers c ON sr.customerId = c.id 
         LEFT JOIN vehicles v ON sr.vehicleId = v.id
         WHERE sr.status = 'pending' AND (sr.workerId IS NULL OR sr.workerId = '')\`,
        [],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});`;

if (code.includes("apiRouter.get('/marshals/available-pickups'")) {
    // Find the start and end of this route
    const startIdx = code.indexOf("apiRouter.get('/marshals/available-pickups'");
    // Find the closing }); of the route - look for the pattern
    let endIdx = startIdx;
    let depth = 0;
    let foundFirst = false;
    for (let i = startIdx; i < code.length; i++) {
        if (code[i] === '(') { depth++; foundFirst = true; }
        if (code[i] === ')') { depth--; }
        if (foundFirst && depth === 0) {
            endIdx = i + 2; // include ;
            break;
        }
    }
    const existingRoute = code.substring(startIdx, endIdx);
    console.log('Found route, length:', existingRoute.length);
    code = code.substring(0, startIdx) + newRoute + code.substring(endIdx);
    fs.writeFileSync(path, code);
    console.log('Done - backend route updated');
} else {
    console.log('Route NOT found!');
}
