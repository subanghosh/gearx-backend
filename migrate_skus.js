const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const db = new sqlite3.Database('./redrivo2.sqlite');
const csvPath = path.join(__dirname, '../Anti_Gravity/Vroomer_AutoParts_Master_Data_Expanded.csv');

function importSKUs() {
    console.log('Reading SKU data from:', csvPath);
    let content = fs.readFileSync(csvPath, 'utf8');

    // Normalize Macintosh (\r) + Windows (\r\n) + Linux (\n)
    content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    const rows = content.split('\n').filter(line => line.trim().length > 0);
    const dataLines = rows.slice(1); // Skip header
    console.log(`Total rows to import: ${dataLines.length}`);

    db.serialize(() => {
        // Create table first if it doesn't exist
        db.run(`CREATE TABLE IF NOT EXISTS master_skus (
            id TEXT PRIMARY KEY, vehicleType TEXT, category TEXT, subcategory TEXT,
            itemName TEXT, partType TEXT, compatibleBrands TEXT, sparePartBrand TEXT,
            oemType TEXT, unit TEXT, basePrice REAL, warrantyMonths INTEGER DEFAULT 0,
            serviceTimeMin INTEGER DEFAULT 0, supplierType TEXT, remarks TEXT
        )`, (err) => {
            if (err) { console.error('Table creation error:', err.message); return; }

            db.run("DELETE FROM master_skus");

            const stmt = db.prepare(`INSERT OR REPLACE INTO master_skus (
                id, vehicleType, category, subcategory, itemName, partType,
                compatibleBrands, sparePartBrand, oemType, unit, basePrice,
                supplierType, warrantyMonths, serviceTimeMin, remarks
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

            let count = 0;
            dataLines.forEach(line => {
                const row = line.split(',');
                if (row.length < 9) return;

                // Columns: [0]VehicleType,[1]Category,[2]Subcategory,[3]ItemName,
                //          [4]PartType,[5]CompatibleBrands,[6]SparePartBrand,
                //          [7]OEM,[8]SKU Code,[9]Unit,[10]Price,[11]Supplier,
                //          [12]WarrantyMonths,[13]ServiceTime,[14]StockStatus,[15]Remarks
                const skuId = (row[8] || '').trim();
                if (!skuId) return;

                stmt.run([
                    skuId,
                    (row[0] || '').trim(),
                    (row[1] || '').trim(),
                    (row[2] || '').trim(),
                    (row[3] || '').trim(),
                    (row[4] || '').trim(),
                    (row[5] || '').trim(),
                    (row[6] || '').trim(),
                    (row[7] || '').trim(),
                    (row[9] || '').trim(),
                    parseFloat(row[10]) || 0,
                    (row[11] || '').trim(),
                    parseInt(row[12]) || 0,
                    parseInt(row[13]) || 0,
                    (row[15] || '').trim()
                ], (err) => { if (err) console.error('Row error:', err.message, '| Row:', row[8]); });
                count++;
            });

            stmt.finalize(() => {
                console.log(`✅ Successfully imported ${count} Master SKUs into redrivo2.sqlite`);
                db.close();
            });
        });
    });
}

importSKUs();
