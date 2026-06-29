const fs = require('fs');
let content = fs.readFileSync('C:/Users/Suban/OneDrive/Documents/Anti_Gravity/app.js', 'utf8');
content = content.replace(/m\.kycStatus === 'verified' \? 'badge-success'/g, "isVerified(m) ? 'badge-success'");
content = content.replace(/\$\{m\.kycStatus === 'verified' \? `/g, "${isVerified(m) ? `");
fs.writeFileSync('C:/Users/Suban/OneDrive/Documents/Anti_Gravity/app.js', content);
console.log('Fixed badges.');
