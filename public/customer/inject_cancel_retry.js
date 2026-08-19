const fs = require('fs');
const path = 'C:/Users/Suban/OneDrive/Documents/redrivo-customer-app/app.js';
let code = fs.readFileSync(path, 'utf8');

const newFunc = `
async function cancelOldRequestAndRetry() {
    // Cancel any stale/returned request so it disappears from Marshal feed
    if (window.currentPendingRequestId) {
        try {
            await apiPatch('/service-requests/' + window.currentPendingRequestId, { status: 'cancelled' });
        } catch (e) {
            console.warn('Could not cancel old request:', e);
        }
        window.currentPendingRequestId = null;
    }
    // Now retry with the same vehicle
    findMarshal(activeBookingVehicleId);
}

`;

// Insert the new function just before findMarshal
code = code.replace('async function findMarshal(vehicleId) {', newFunc + 'async function findMarshal(vehicleId) {');
fs.writeFileSync(path, code);
console.log('Done - cancelOldRequestAndRetry function added');
console.log('Count:', (code.match(/cancelOldRequestAndRetry/g) || []).length);
