const fs = require('fs');
let content = fs.readFileSync('C:/Users/Suban/OneDrive/Documents/vroomly-backend/index.js', 'utf8');

// Replace PAN check
const oldPan = `            const panCheck = await pool.query(\`SELECT id FROM users WHERE pannumber = $1 AND id != $2\`, [cleanPan, req.params.id]);`;
const newPan = `            const panCheck = await pool.query(\`SELECT id FROM users WHERE pannumber = $1 AND id != $2 UNION ALL SELECT id FROM garage_workers WHERE pannumber = $1 AND id != $2\`, [cleanPan, req.params.id]);`;
if (content.includes(oldPan)) content = content.replace(oldPan, newPan);

// Replace Aadhaar check
const oldAadhaar = `            const aadhaarCheck = await pool.query(\`SELECT id FROM users WHERE aadhaarnumber = $1 AND id != $2\`, [cleanAadhaar, req.params.id]);`;
const newAadhaar = `            const aadhaarCheck = await pool.query(\`SELECT id FROM users WHERE aadhaarnumber = $1 AND id != $2 UNION ALL SELECT id FROM garage_workers WHERE aadhaarnumber = $1 AND id != $2\`, [cleanAadhaar, req.params.id]);`;
if (content.includes(oldAadhaar)) content = content.replace(oldAadhaar, newAadhaar);

// Add uniqueness to POST /customers
const oldCustomerStart = `apiRouter.post('/customers', (req, res) => {
    const { name, phone, email, address } = req.body;
    const id = 'cust_' + Date.now();`;

const newCustomerStart = `apiRouter.post('/customers', async (req, res) => {
    const { name, phone, email, address } = req.body;
    const id = 'cust_' + Date.now();
    try {
        const existing = await checkUniqueEntity(phone);
        if (existing) {
            return res.status(400).json({ error: 'A ' + (existing.role || 'user') + ' with this phone number already exists in the system.' });
        }
    } catch(e) {}`;
    
if (content.includes(oldCustomerStart)) {
    content = content.replace(oldCustomerStart, newCustomerStart);
}

fs.writeFileSync('C:/Users/Suban/OneDrive/Documents/vroomly-backend/update_kyc_checks.js', content);
console.log('Update script prepared.');
