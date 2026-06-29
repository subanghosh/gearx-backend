const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://neondb_owner:npg_I3q2cfjCLbWN@ep-misty-fire-angs4p3i.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require' });
async function test() {
    try {
        await pool.query(
            `INSERT INTO users (id, name, role, phone, email, status, kycstatus) VALUES ($1, 'New Marshal', 'marshal', $2, $3, 'active', 'pending_submission')`,
            ['marshal_' + Date.now(), '+911112223334', null]
        );
        console.log('Insert successful');
    } catch (err) {
        console.error('Error:', err.message);
    }
    process.exit(0);
}
test();
