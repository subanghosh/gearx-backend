require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function finalCheck() {
    try {
        const phone = '9093184965';
        const cleanVal = phone.replace('+91', '');
        const prefixedVal = '+91' + cleanVal;
        
        // Find the garage that will be selected by the auth logic
        const res = await pool.query("SELECT id, name, contact, pannumber FROM garages WHERE contact IN ($1, $2)", [cleanVal, prefixedVal]);
        console.log('Garages found for this phone:', JSON.stringify(res.rows, null, 2));
        
        if (res.rows.length === 1) {
            console.log('SUCCESS: Only one garage remains. Identity confusion resolved.');
        } else {
            console.warn('WARNING:', res.rows.length, 'garages still exist for this phone.');
        }
        
    } catch (e) {
        console.error('Final check error:', e.message);
    } finally {
        await pool.end();
    }
}
finalCheck();
