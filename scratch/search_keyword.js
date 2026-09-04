const fs = require('fs');
const content = fs.readFileSync('c:/Users/Suban/OneDrive/Documents/redrivo-garage-portal/app.js', 'utf8');
const lines = content.split('\n');

const keywords = ['team', 'worker', 'invite', 'member', 'otp', 'add'];
keywords.forEach(keyword => {
    console.log(`=== Matches for "${keyword}" ===`);
    lines.forEach((line, idx) => {
        if (line.toLowerCase().includes(keyword)) {
            console.log(`${idx + 1}: ${line.trim()}`);
        }
    });
});
