const fs = require('fs');
const path = require('path');

const targetBase = path.join(__dirname, '../public');

const syncMapping = [
    {
        name: 'garage',
        src: path.join(__dirname, '../../redrivo-garage-portal'),
        dest: path.join(targetBase, 'garage'),
        filter: (f) => !f.endsWith('.md') && f !== 'scratch' && !f.endsWith('.orig')
    },
    {
        name: 'customer',
        src: path.join(__dirname, '../../vroomly-customer-app/www'),
        dest: path.join(targetBase, 'customer'),
        filter: (f) => !f.endsWith('.orig') && !f.includes('.backup-')
    },
    {
        name: 'marshal',
        src: path.join(__dirname, '../../vroomly-marshal-app/www'),
        dest: path.join(targetBase, 'marshal'),
        filter: (f) => !f.endsWith('.orig') && !f.includes('.backup-')
    },
    {
        name: 'crm',
        src: path.join(__dirname, '../../Anti_Gravity'),
        dest: path.join(targetBase, 'crm'),
        filter: (f) => !f.endsWith('.py') && !f.endsWith('.md') && f !== 'scratch' && f !== '.git'
    }
];

function copyRecursiveSync(src, dest, filter) {
    if (!fs.existsSync(src)) return 0;
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    
    let count = 0;
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (filter && !filter(entry.name)) continue;

        if (entry.isDirectory()) {
            count += copyRecursiveSync(srcPath, destPath, filter);
        } else {
            fs.copyFileSync(srcPath, destPath);
            count++;
        }
    }
    return count;
}

console.log('[SYNC] Synchronizing local frontend folders to vroomly-backend/public...');
if (!fs.existsSync(targetBase)) fs.mkdirSync(targetBase, { recursive: true });

syncMapping.forEach(item => {
    if (fs.existsSync(item.src)) {
        const copied = copyRecursiveSync(item.src, item.dest, item.filter);
        console.log(`[SYNC] ✓ Copied ${copied} files from ${item.name} -> public/${item.name}`);
    } else {
        console.log(`[SYNC] Skipping ${item.name} (Source not found: ${item.src})`);
    }
});
console.log('[SYNC] Frontend sync complete.');
