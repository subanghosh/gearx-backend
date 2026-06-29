const fs = require('fs');
const lines = fs.readFileSync('C:/Users/Suban/OneDrive/Documents/Anti_Gravity/app.js', 'utf8').split('\n');
lines.forEach((l, i) => { 
    if (l.includes("kycStatus === 'verified'")) console.log(i + ': ' + l); 
});
