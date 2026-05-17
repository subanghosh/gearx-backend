require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const csv = fs.readFileSync('../Anti_Gravity/Vroomer_AutoParts_Master_Data_Expanded.csv', 'utf8');
  const lines = csv.split(/\r\n|\n|\r/);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS master_skus (
      id TEXT PRIMARY KEY, vehicleType TEXT, category TEXT, subcategory TEXT,
      itemName TEXT, sparePartBrand TEXT, compatibleBrands TEXT, basePrice REAL,
      partType TEXT, oemType TEXT, unit TEXT
    )
  `);

  // Build bulk values
  const values = [];
  const params = [];
  let paramIdx = 1;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const row = [];
    let cur = '', inQuote = false;
    for (const c of line) {
      if (c === '"') inQuote = !inQuote;
      else if (c === ',' && !inQuote) { row.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    row.push(cur.trim());

    if (row.length < 9) continue;

    const [vehicleType, category, subcategory, itemName, partType, compatibleBrands, sparePartBrand, oemType, skuCode, unit, estimatedPrice] = row;
    const basePrice = parseFloat(estimatedPrice) || 0;
    const skuId = skuCode && skuCode.trim() ? skuCode.trim() : ('SKU-' + i);

    values.push(`($${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++})`);
    params.push(skuId, vehicleType, category, subcategory, itemName, sparePartBrand, compatibleBrands, basePrice, partType, oemType, unit || 'Piece');
  }

  if (values.length === 0) { console.log('No rows to insert!'); process.exit(0); }

  const sql = `
    INSERT INTO master_skus (id, vehicleType, category, subcategory, itemName, sparePartBrand, compatibleBrands, basePrice, partType, oemType, unit)
    VALUES ${values.join(',')}
    ON CONFLICT (id) DO UPDATE SET
      vehicleType = EXCLUDED.vehicleType, category = EXCLUDED.category,
      itemName = EXCLUDED.itemName, basePrice = EXCLUDED.basePrice
  `;

  await pool.query(sql, params);
  console.log(`✓ Inserted/updated ${values.length} SKUs into master_skus`);
  process.exit(0);
}

run().catch(err => { console.error(err.message); process.exit(1); });
