const fs = require('fs');
const lines = fs.readFileSync('C:/Users/Suban/OneDrive/Documents/redrivo-backend/index.js', 'utf8').split('\n');
lines.forEach((l, i) => {
    if (l.includes("'/users'") || l.includes('"/users"')) {
        console.log(i + ': ' + l);
    }
});
