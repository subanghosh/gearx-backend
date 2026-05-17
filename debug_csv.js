const fs = require('fs');
const csv = fs.readFileSync('../Anti_Gravity/Vroomer_AutoParts_Master_Data_Expanded.csv', 'utf8');
const lines = csv.split(/\r\n|\n|\r/);
console.log('Total lines:', lines.length);
console.log('Header:', lines[0]);
console.log('Line 1:', lines[1]);
console.log('Line 2:', lines[2]);
