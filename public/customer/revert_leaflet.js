const fs = require('fs');
let code = fs.readFileSync('app.js', 'utf8');

// 1. Map Initialization
code = code.replace(/customerMap\s*=\s*L\.map\('leaflet-map',\s*\{zoomControl:\s*false\}\)\.setView\(\[19\.0664,\s*72\.8680\],\s*13\);/g, 
"customerMap = new google.maps.Map(document.getElementById('leaflet-map'), { center: {lat: 19.0664, lng: 72.8680}, zoom: 13, disableDefaultUI: true, styles: lightMapStyle });");

code = code.replace(/window\.homeTrackMap\s*=\s*L\.map\('home-track-map',\s*\{zoomControl:\s*false\}\)\.setView\(\[19\.076,\s*72\.877\],\s*14\);/g, 
"window.homeTrackMap = new google.maps.Map(document.getElementById('home-track-map'), { center: {lat: 19.076, lng: 72.877}, zoom: 14, disableDefaultUI: true, styles: lightMapStyle });");

code = code.replace(/enRouteMap\s*=\s*L\.map\('enroute-map',\s*\{zoomControl:\s*false\}\)\.setView\(\[19\.0760,\s*72\.8777\],\s*14\);/g, 
"enRouteMap = new google.maps.Map(document.getElementById('enroute-map'), { center: {lat: 19.0760, lng: 72.8777}, zoom: 14, disableDefaultUI: true });");

// 2. Remove Tile Layers
code = code.replace(/L\.tileLayer\('https:\/\/{s}\.basemaps\.cartocdn\.com[^;]+;\n?/g, "");
code = code.replace(/L\.tileLayer\('https:\/\/{s}\.tile\.openstreetmap\.org[^;]+;\n?/g, "");
code = code.replace(/\s*\/\/ L\.tileLayer removed\n/g, "\n");

// 3. Markers
// Replace L.marker with draggable
code = code.replace(/L\.marker\(\[([^,]+),\s*([^\]]+)\],\s*\{icon:\s*([^,}]+),\s*draggable:\s*([^}]+)\}\)\.addTo\(([^)]+)\)/g, 
"new google.maps.Marker({ position: {lat: $1, lng: $2}, map: $5, icon: $3, draggable: $4 })");

// Replace L.marker with no draggable but addTo
code = code.replace(/L\.marker\(\[([^,]+),\s*([^\]]+)\],\s*\{icon:\s*([^}]+)\s*\}\)\.addTo\(([^)]+)\)/g, 
"new google.maps.Marker({ position: {lat: $1, lng: $2}, map: $4, icon: $3 })");

// Replace L.marker with no addTo
code = code.replace(/L\.marker\(\[([^,]+),\s*([^\]]+)\],\s*\{icon:\s*([^}]+)\s*\}\)/g, 
"new google.maps.Marker({ position: {lat: $1, lng: $2}, icon: $3 })");

// 4. LatLngBounds
code = code.replace(/let\s+bounds\s*=\s*L\.latLngBounds\(\[\]\);/g, "const bounds = new google.maps.LatLngBounds();");
code = code.replace(/bounds\.extend\(customerMarker\.getLatLng\(\)\);/g, "bounds.extend(customerMarker.getPosition());");
code = code.replace(/bounds\.extend\(\[([^,]+),\s*([^\]]+)\]\);/g, "bounds.extend({lat: $1, lng: $2});");
code = code.replace(/customerMap\.fitBounds\(bounds,\s*50\);/g, "customerMap.fitBounds(bounds, {padding: 50});");

// 5. Polyline
code = code.replace(/L\.polyline\(([^,]+),\s*\{color:\s*'([^']+)',\s*opacity:\s*([^,]+),\s*weight:\s*([^}]+)\}\)\.addTo\(([^)]+)\)/g, 
"new google.maps.Polyline({ path: $1, strokeColor: '$2', strokeOpacity: $3, strokeWeight: $4 }).setMap($5)");

// 6. createGoogleIcon Reversion
code = code.replace(/return\s+L\.divIcon\(\{\s*html:\s*`<svg[^>]+><path\s+d="M12\s+0C5\.373\s+0\s+0\s+5\.373\s+0\s+12C0\s+21\s+12\s+34\s+12\s+34C12\s+34\s+24\s+21\s+24\s+12C24\s+5\.373\s+18\.627\s+0\s+12\s+0Z"\s+fill="\$\{color\}"\s+stroke="#ffffff"\s+stroke-width="2"\/><circle\s+cx="12"\s+cy="12"\s+r="5"\s+fill="#ffffff"\/><\/svg>`,\s*className:\s*'',\s*iconSize:\s*\[24,\s*34\],\s*iconAnchor:\s*\[12,\s*34\],\s*popupAnchor:\s*\[0,\s*-34\]\s*\}\);/g, 
"return { path: 'M12 0C5.373 0 0 5.373 0 12C0 21 12 34 12 34C12 34 24 21 24 12C24 5.373 18.627 0 12 0Z', fillColor: color, fillOpacity: 1, strokeWeight: 2, strokeColor: '#ffffff', scale: 1, anchor: new google.maps.Point(12, 34) };");

code = code.replace(/return\s+L\.divIcon\(\{[\s\S]*?\}\);/g, 
"return { path: 'M12 0C5.373 0 0 5.373 0 12C0 21 12 34 12 34C12 34 24 21 24 12C24 5.373 18.627 0 12 0Z', fillColor: color, fillOpacity: 1, strokeWeight: 2, strokeColor: '#ffffff', scale: 1, anchor: new google.maps.Point(12, 34) };");


// 7. Cleanup remaining minor issues
// .remove() -> .setMap(null)
code = code.replace(/(\w+)\.remove\(\);/g, (match, p1) => {
    // Only replace if it's a known map marker/polyline variable
    if (['customerMarker', 'dropMarker', 'pickupMarker', 'marshalMarker', 'enRouteCustomerMarker', 'enRouteMarshalMarker', 'routePolylineControl'].includes(p1)) {
        return `${p1}.setMap(null);`;
    }
    return match;
});

// .on('moveend', ...) -> .addListener('idle', ...)
code = code.replace(/customerMap\.on\('moveend',\s*/g, "customerMap.addListener('idle', ");
code = code.replace(/customerMarker\.on\('dragend',\s*/g, "customerMarker.addListener('dragend', ");

fs.writeFileSync('app.js', code);
console.log('Revert script executed successfully.');
