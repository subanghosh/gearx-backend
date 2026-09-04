require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
    try {
        console.log('Inserting test marshal m_1 into PostgreSQL database...');
        
        // Delete if already exists
        await pool.query("DELETE FROM users WHERE id = 'm_1'");
        
        // Insert new marshal user
        const query = `
            INSERT INTO users (
                id, name, role, email, phone, status, 
                emailverified, phoneverified, dlverified, kycstatus
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `;
        const values = [
            'm_1',
            'Test Marshal',
            'marshal',
            'marshal@redrivo.in',
            '+919999999999',
            'active',
            1, // emailVerified
            1, // phoneVerified
            1, // dlVerified
            'approved' // kycStatus
        ];
        
        await pool.query(query, values);
        console.log('SUCCESS: Test marshal m_1 created successfully in PostgreSQL.');
    } catch (err) {
        console.error('Error inserting test marshal:', err.message);
    } finally {
        await pool.end();
    }
}

run();
