const fs = require('fs');
const lines = fs.readFileSync('C:/Users/Suban/OneDrive/Documents/redrivo-backend/index.js', 'utf8').split('\n');
let start = lines.findIndex(l => l.includes("post('/garages/:id/workers'"));
if (start !== -1) {
    for (let i = start; i < start + 30; i++) console.log(i + ': ' + lines[i]);
}
