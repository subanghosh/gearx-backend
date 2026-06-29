const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://neondb_owner:npg_I3q2cfjCLbWN@ep-misty-fire-angs4p3i.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require' });
async function test() {
    try {
        await pool.query(`UPDATE users SET phoneverified = 1 WHERE id = $1`, ['test_marshal_id']);
        console.log('Update successful');
    } catch (err) {
        console.error('Error:', err.message);
    }
    process.exit(0);
}
test();
