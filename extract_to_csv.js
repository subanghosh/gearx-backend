const XLSX = require('xlsx');
const fs = require('fs');

const filePath = 'c:\\Users\\Suban\\OneDrive\\Documents\\Anti_Gravity\\Vroomer_250_Point_Detailed_Car_Inspection.xlsx';
const workbook = XLSX.readFile(filePath);
const sheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[sheetName];
const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

const header = "Vehicle Type,Category,Item,Condition,Status,Priority,Garage Cost,Our Cost,Commission %,Frequency";
const rows = [header];

// Add the summary row first
rows.push("Car,General Inspection,250 Point Health Report,Done,Replace,P1,500,500,0,1 Year");

data.forEach((row, index) => {
    if (index === 0) return; // Skip header
    if (row.length < 3) return; // Skip if no category/item

    const category = row[1] || 'General';
    const item = row[2] || 'Item';

    // escaping commas in item names just in case
    const cleanItem = item.replace(/,/g, '');
    const cleanCategory = category.replace(/,/g, '');

    rows.push(`Car,${cleanCategory},${cleanItem},Normal,Not Required,-,0,0,0,-`);
});

const csvContent = rows.join('\n');
fs.writeFileSync('c:\\Users\\Suban\\OneDrive\\Documents\\redrivo-backend\\extracted_checklist.csv', csvContent);
console.log('Successfully extracted', rows.length - 1, 'items.');
