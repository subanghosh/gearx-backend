const fs = require('fs');

let content = fs.readFileSync('C:/Users/Suban/OneDrive/Documents/vroomly-backend/index.js', 'utf8');

// 1. Add POST /users
if (!content.includes("apiRouter.post('/users'")) {
    const postUsersRoute = `
apiRouter.post('/users', async (req, res) => {
    try {
        const { id, name, phone, email, role, password, status } = req.body;
        if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required' });
        
        const existing = await pool.query(
            "SELECT id FROM users WHERE phone = $1 UNION ALL SELECT id FROM garage_workers WHERE phone = $1", 
            [phone]
        );
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'A user with this phone number already exists.' });
        }
        
        await pool.query(
            "INSERT INTO users (id, name, phone, email, role, password, status) VALUES ($1, $2, $3, $4, $5, $6, $7)",
            [id || 'u_' + Date.now(), name, phone, email, role || 'customer', password, status || 'active']
        );
        res.json({ success: true, id });
    } catch (err) {
        console.error('POST /users error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});
`;
    content = content.replace("apiRouter.get('/users', async (req, res) => {", postUsersRoute + "\napiRouter.get('/users', async (req, res) => {");
}

// 2. Update POST /garages/:id/workers uniqueness
const oldWorkersRoute = `    db.get("SELECT id FROM garage_workers WHERE garageId = ? AND phone = ?", [req.params.id, phone], (err, existing) => {
        if (existing) {
            return res.status(400).json({ error: 'A team member with this phone number already exists.' });
        }`;

const newWorkersRoute = `    pool.query("SELECT id FROM users WHERE phone = $1 UNION ALL SELECT id FROM garage_workers WHERE phone = $1", [phone]).then(result => {
        if (result.rows.length > 0) {
            return res.status(400).json({ error: 'A user with this phone number already exists in the system.' });
        }`;

if (content.includes(oldWorkersRoute)) {
    content = content.replace(oldWorkersRoute, newWorkersRoute);
}

fs.writeFileSync('C:/Users/Suban/OneDrive/Documents/vroomly-backend/index.js', content);
console.log('Backend routes updated successfully');
