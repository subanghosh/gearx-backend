const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://neondb_owner:npg_I3q2cfjCLbWN@ep-misty-fire-angs4p3i.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require' });
async function test() {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    console.log('Sending expiresAt:', expiresAt);
    const res = await pool.query("INSERT INTO otp_verifications (entityid, entitytype, phone, otp, expiresat) VALUES ('TEST', 'auth', 'test', '000000', $1) RETURNING *", [expiresAt]);
    console.log('Returned expiresat:', res.rows[0].expiresat.toISOString());
    console.log('Returned createdat:', res.rows[0].createdat.toISOString());
    const res2 = await pool.query("SELECT NOW() as db_now, CURRENT_TIMESTAMP as db_curr");
    console.log('DB NOW():', res2.rows[0].db_now.toISOString());
    process.exit(0);
}
test();
