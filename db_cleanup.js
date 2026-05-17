require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function cleanup() {
    try {
        // Delete the duplicates that don't have PAN data or are named "New Partner"
        // specifically for the test phone numbers we saw.
        const res = await pool.query(`
            DELETE FROM garages 
            WHERE (name = 'New Partner' AND contact IN ('9093184965', '+919093184965', '9096184966', '+919096184966'))
               OR id = 'gar_001'
        `);
        console.log('Deleted rows:', res.rowCount);
        
        // Final check of what's left
        const final = await pool.query("SELECT id, name, contact, \"panNumber\", \"pannumber\" FROM garages WHERE contact LIKE '%9093184965%'");
        console.log('Remaining Suban Garages:', JSON.stringify(final.rows, null, 2));
        
    } catch (e) {
        console.error('Cleanup error:', e.message);
    } finally {
        await pool.end();
    }
}
cleanup();
