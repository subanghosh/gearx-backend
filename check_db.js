require('dotenv').config();
const {Pool} = require('pg');
const pool = new Pool({connectionString: process.env.DATABASE_URL});
pool.query("UPDATE users SET phoneverified = 1 WHERE name = 'Mike Marshal'")
  .then(() => pool.query("SELECT id, name, kycstatus, phoneverified, emailverified FROM users WHERE name = 'Mike Marshal'"))
  .then(r => { console.log(r.rows); pool.end(); })
  .catch(e => { console.error(e); pool.end(); });
