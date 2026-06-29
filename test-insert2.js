const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://neondb_owner:npg_I3q2cfjCLbWN@ep-misty-fire-angs4p3i.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require' });
pool.query("INSERT INTO users (id, name, role, phone, email, status, kycstatus) VALUES ('test1', 'test', 'marshal', '123', null, 'active', 'pending_submission')").then(res => { console.log('success'); process.exit(0); }).catch(err => { console.log('Error:', err.message); process.exit(1); });
