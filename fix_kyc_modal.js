const fs = require('fs');
let content = fs.readFileSync('C:/Users/Suban/OneDrive/Documents/Anti_Gravity/app.js', 'utf8');

// Replace panNumber
content = content.replace(/\$\{m\.panNumber \|\|/g, '${(m.panNumber || m.pannumber) ||');
// Replace panUrl
content = content.replace(/\$\{m\.panUrl \?/g, '${(m.panUrl || m.panurl) ?');
content = content.replace(/\$\{m\.panUrl\}/g, '${m.panUrl || m.panurl}');

// Replace aadhaarNumber
content = content.replace(/\$\{m\.aadhaarNumber \|\|/g, '${(m.aadhaarNumber || m.aadhaarnumber) ||');
// Replace aadhaarUrl
content = content.replace(/\$\{m\.aadhaarUrl \?/g, '${(m.aadhaarUrl || m.aadhaarurl) ?');
content = content.replace(/\$\{m\.aadhaarUrl\}/g, '${m.aadhaarUrl || m.aadhaarurl}');

// Replace Bank Details
content = content.replace(/\$\{m\.bankAccountName \|\|/g, '${(m.bankAccountName || m.bankaccountname) ||');
content = content.replace(/\$\{m\.bankAccountNumber \|\|/g, '${(m.bankAccountNumber || m.bankaccountnumber) ||');
content = content.replace(/\$\{m\.bankIFSC \|\|/g, '${(m.bankIFSC || m.bankifsc) ||');

// Save the fixed app.js
fs.writeFileSync('C:/Users/Suban/OneDrive/Documents/Anti_Gravity/app.js', content);
console.log('Fixed KYC modal properties.');

// Cache bust index.html
let html = fs.readFileSync('C:/Users/Suban/OneDrive/Documents/Anti_Gravity/index.html', 'utf8');
html = html.replace(/app\.js\?v=\d+/, 'app.js?v=9');
fs.writeFileSync('C:/Users/Suban/OneDrive/Documents/Anti_Gravity/index.html', html);
console.log('Cache busted index.html to v=9.');
