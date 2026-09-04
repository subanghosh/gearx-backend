const fs = require('fs');
const lines = fs.readFileSync('C:/Users/Suban/OneDrive/Documents/redrivo-backend/index.js', 'utf8').split('\n');
for (let i = 990; i < 1030; i++) {
    console.log(i + ': ' + lines[i]);
}
