const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    console.log("expiresAt (Node JS):", expiresAt);
    
    // Insert OTP
    const insertRes = await pool.query(
        "INSERT INTO otp_verifications (entityid, entitytype, phone, email, otp, expiresat) VALUES ('TEMP', 'auth', '9999999999', null, '123456', $1) RETURNING *", 
        [expiresAt]
    );
    console.log('Inserted:', insertRes.rows[0]);
    
    // Check if it is immediately expired
    const delRes = await pool.query("DELETE FROM otp_verifications WHERE expiresat < NOW() RETURNING *");
    console.log('Deleted by NOW():', delRes.rows.map(r => r.phone));
    
    pool.end();
})().catch(err => {
    console.error(err);
    pool.end();
});
