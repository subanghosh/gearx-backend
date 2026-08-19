const fs = require('fs');
let code = fs.readFileSync('app.js', 'utf8');

const rogueBlock = `    function initCustomerMap() {
    // Caching guard removed temporarily to force re-initialization
    const mapEl = document.getElementById('leaflet-map');
    if (!mapEl) return;
    
    // Default to Mumbai BKC
    customerMap = L.map('leaflet-map').setView([19.0664, 72.8680], 13);
    
    
    // L.tileLayer removed
    }`;

code = code.replace(rogueBlock, '');
fs.writeFileSync('app.js', code);
console.log('Rogue block removed successfully');
