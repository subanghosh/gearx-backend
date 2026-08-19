const fs = require('fs');
let code = fs.readFileSync('app.js', 'utf8');

const missingCode = `    if (window.routeStops && Array.isArray(window.routeStops)) {
        window.routeStops.forEach(stop => {
            gWaypoints.push({
                location: new google.maps.LatLng(stop.lat, stop.lng),
                stopover: true
            });
        });
    }

    const request = {
        origin: new google.maps.LatLng(window.routePickup.lat, window.routePickup.lng),
        destination: new google.maps.LatLng(window.routeDrop.lat, window.routeDrop.lng),
        waypoints: gWaypoints,
        travelMode: 'DRIVING'
    };`;

code = code.replace(/const gWaypoints = \[\];\n/, 'const gWaypoints = [];\n' + missingCode + '\n');
fs.writeFileSync('app.js', code);
console.log('Restored routing code successfully.');
