const fs = require('fs');
let content = fs.readFileSync('C:/Users/Suban/OneDrive/Documents/vroomly-backend/index.js', 'utf8');

// 1. Add global unique function
if (!content.includes('async function checkUniqueEntity')) {
    const fnDef = `
// --- GLOBAL UNIQUE ENTITY VALIDATION ---
async function checkUniqueEntity(phone, options = {}) {
    if (!phone) return false;
    const cleanPhone = phone.replace('+91', '').trim();
    const prefixedPhone = phone.startsWith('+91') ? phone : '+91' + phone.trim();
    
    let checks = [
        pool.query("SELECT id, role FROM users WHERE phone IN ($1, $2)", [cleanPhone, prefixedPhone]),
        pool.query("SELECT id, role FROM garage_workers WHERE phone IN ($1, $2)", [cleanPhone, prefixedPhone]),
        pool.query("SELECT id, 'customer' as role FROM customers WHERE phone IN ($1, $2)", [cleanPhone, prefixedPhone]),
        pool.query("SELECT id, 'garage' as role FROM garages WHERE contact IN ($1, $2)", [cleanPhone, prefixedPhone])
    ];

    if (options.aadhaar) {
        const cleanAadhaar = options.aadhaar.replace(/\\D/g, '');
        checks.push(pool.query("SELECT id, role FROM users WHERE aadhaarnumber = $1", [cleanAadhaar]));
        checks.push(pool.query("SELECT id, role FROM garage_workers WHERE aadhaarnumber = $1", [cleanAadhaar]));
    }
    if (options.pan) {
        const cleanPan = options.pan.trim().toUpperCase();
        checks.push(pool.query("SELECT id, role FROM users WHERE pannumber = $1", [cleanPan]));
        checks.push(pool.query("SELECT id, role FROM garage_workers WHERE pannumber = $1", [cleanPan]));
    }

    const results = await Promise.all(checks);
    for (let r of results) {
        if (r.rows && r.rows.length > 0) {
            return r.rows[0]; // returns {id, role}
        }
    }
    return null;
}
`;
    content = content.replace('// --- SECURITY MIDDLEWARE ---', fnDef + '\n// --- SECURITY MIDDLEWARE ---');
}

// 2. Fix POST /auth/verify-otp
// Find where it checks userResult, workerResult, garageResult
const verifyOtpStart = `apiRouter.post('/auth/verify-otp', async (req, res) => {`;
if (content.includes(verifyOtpStart)) {
    // Instead of completely replacing verify-otp, I will replace the section after Step 1.
    // Wait, it's easier to just do it at the start of verify-otp:
    const newVerifyStart = `apiRouter.post('/auth/verify-otp', async (req, res) => {
    const { phone, email, otp, role } = req.body;
    if (!otp || otp.length !== 6) return res.status(400).json({ error: 'OTP must be 6 digits' });
    const val = phone || email;
    if (!val) return res.status(400).json({ error: 'Phone or email required' });

    try {
        const existingEntity = await checkUniqueEntity(phone);
        if (existingEntity && role) {
            let eRole = existingEntity.role || 'customer';
            let reqRole = role || 'customer';
            if (eRole === 'admin') eRole = 'marshal'; // Admin apps might share login, ignore
            if (reqRole === 'admin') reqRole = 'marshal';
            
            // Allow mechanic/garage worker to login as marshal if roles match roughly
            if (eRole === 'mechanic') eRole = 'marshal'; 
            
            if (eRole !== reqRole && eRole !== 'customer' /*allow customers to become marshal? No, strict error.*/) {
                 if (eRole !== reqRole) {
                     return res.status(400).json({ error: \`This phone number is registered as a \${eRole.toUpperCase()}. You cannot log in as a \${reqRole.toUpperCase()}.\` });
                 }
            }
        }
`;
    
    // Replace the start block up to try {
    const oldVerifyStart = `apiRouter.post('/auth/verify-otp', async (req, res) => {
    const { phone, email, otp, role } = req.body;
    if (!otp || otp.length !== 6) return res.status(400).json({ error: 'OTP must be 6 digits' });
    const val = phone || email;
    if (!val) return res.status(400).json({ error: 'Phone or email required' });

    try {`;
    content = content.replace(oldVerifyStart, newVerifyStart);
}

// 3. Fix POST /users
if (content.includes("apiRouter.post('/users', async (req, res) => {")) {
    content = content.replace(
        /const existing = await pool\.query\([\s\S]*?if \(existing\.rows\.length > 0\) \{[\s\S]*?\}/,
        `const existing = await checkUniqueEntity(phone);
        if (existing) {
            return res.status(400).json({ error: 'A ' + (existing.role || 'user') + ' with this phone number already exists in the system.' });
        }`
    );
}

// 4. Fix POST /garages/:id/workers
if (content.includes("pool.query(\"SELECT id FROM users WHERE phone = $1 UNION ALL SELECT id FROM garage_workers WHERE phone = $1\"")) {
    content = content.replace(
        /pool\.query\("SELECT id FROM users WHERE phone = \$1 UNION ALL SELECT id FROM garage_workers WHERE phone = \$1", \[phone\]\)\.then\(result => \{[\s\S]*?if \(result\.rows\.length > 0\) \{[\s\S]*?\}/,
        `checkUniqueEntity(phone).then(existing => {
        if (existing) {
            return res.status(400).json({ error: 'A ' + (existing.role || 'user') + ' with this phone number already exists in the system.' });
        }`
    );
}

fs.writeFileSync('C:/Users/Suban/OneDrive/Documents/vroomly-backend/index.js', content);
console.log('Update successful.');
