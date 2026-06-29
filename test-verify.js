const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://neondb_owner:npg_I3q2cfjCLbWN@ep-misty-fire-angs4p3i.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require' });
async function test() {
    const val = '+917787878787';
    const otp = '317100'; // the one that was inserted recently!
    const otpResult = await pool.query(
        `SELECT * FROM otp_verifications WHERE (phone = $1 OR email = $1) AND otp = $2 AND verifiedat IS NULL AND expiresat > NOW() ORDER BY id DESC LIMIT 1`,
        [val, otp]
    );
    console.log('Result:', otpResult.rows);
    process.exit(0);
}
test();
