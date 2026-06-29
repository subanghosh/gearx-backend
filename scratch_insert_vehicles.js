const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function main() {
    const custId = 'gar_1776661087321_owner';
    try {
        console.log("Checking vehicles for customer:", custId);
        const res = await pool.query("SELECT * FROM vehicles WHERE customerid = $1", [custId]);
        console.log("Vehicles:", res.rows);
        
        if (res.rows.length < 2) {
            console.log("Inserting a second vehicle for testing...");
            const newVehId = 'v_' + Date.now();
            await pool.query(`
                INSERT INTO vehicles (id, customerid, plate, makemodel, color, vin, make, model, type, photo, fuel, transmission)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            `, [
                newVehId,
                custId,
                'MH 12 AA 1234',
                'Tata Nexon',
                'Blue',
                'VIN1234567890',
                'Tata',
                'Nexon',
                'SUV',
                null,
                'Diesel',
                'Automatic'
            ]);
            console.log("Inserted vehicle:", newVehId);
            
            // If they had 0, let's insert another one just to have at least 2
            if (res.rows.length === 0) {
                const secondVehId = 'v_' + (Date.now() + 1);
                await pool.query(`
                    INSERT INTO vehicles (id, customerid, plate, makemodel, color, vin, make, model, type, photo, fuel, transmission)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                `, [
                    secondVehId,
                    custId,
                    'MH 12 BB 5678',
                    'Honda City',
                    'White',
                    'VIN9876543210',
                    'Honda',
                    'City',
                    'Sedan',
                    null,
                    'Petrol',
                    'Manual'
                ]);
                console.log("Inserted second vehicle:", secondVehId);
            }
        }
    } catch (e) {
        console.error("Error:", e);
    } finally {
        await pool.end();
    }
}

main();
