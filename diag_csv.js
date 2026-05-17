const fs = require('fs');
const path = require('path');

const csvPath = path.join(__dirname, '../Anti_Gravity/Vroomer_AutoParts_Master_Data_Expanded.csv');
const data = fs.readFileSync(csvPath);
const first200 = data.slice(0, 200).toString('hex');
console.log('Hex dump of first 200 bytes:', first200);

const stringData = data.slice(0, 500).toString('utf8');
console.log('String segment:', stringData);

// Check if \r (0D) or \n (0A) is present
const hasR = data.includes(0x0D);
const hasN = data.includes(0x0A);
console.log('Contains \\r (Mac/Win):', hasR);
console.log('Contains \\n (Linux/Win):', hasN);
