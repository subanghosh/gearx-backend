const fs = require('fs');
let code = fs.readFileSync('app.js', 'utf8');

const missingBlock = `    }

    const directionsService = new google.maps.DirectionsService();
    
    // Map waypoints for Google
    const gWaypoints = [];
    if (window.routeStops && Array.isArray(window.routeStops)) {
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
    };
    directionsService.route(request, function(response, status) {
        if (status === 'OK') {
            const route = response.routes[0];
            
            // Extract coordinates for Leaflet Polyline
            const latLngs = route.overview_path;
            
            if (window.routePolylineControl) {
                if(window.routePolylineControl) window.routePolylineControl.setMap(null);
            }
            
            // Draw standard Leaflet Polyline
            window.routePolylineControl = new google.maps.Polyline({ path: latLngs, strokeColor: '#0f172a', strokeOpacity: 0.95, strokeWeight: 7 });
            window.routePolylineControl.setMap(customerMap);
            
            // Update UI badge
            let totalMeters = 0;
            let totalSeconds = 0;
            route.legs.forEach(leg => {
                totalMeters += leg.distance.value;
                totalSeconds += leg.duration.value;
            });

            const km = (totalMeters / 1000).toFixed(1);
            const mins = Math.round(totalSeconds / 60);
            window.calculatedRouteDistance = parseFloat(km);

            const distEl = document.getElementById('route-est-distance');
            const durEl = document.getElementById('route-est-duration');
            const badge = document.getElementById('route-stats-badge');
            if (distEl) distEl.textContent = \`\${km} km\`;
            if (durEl) durEl.textContent = \`\${mins} mins\`;
            if (badge) badge.style.display = 'flex';

            // Auto fit bounds using native route bounds
            customerMap.fitBounds(route.bounds, {padding: 80});`;

// Find the corrupted section where it jumps straight to `customerMap.fitBounds`
const corruptedBlockRegex = /\s*\}\s*\/\/ Auto fit bounds using Polyline bounds\s*customerMap\.fitBounds\(window\.routePolylineControl\.getBounds\(\),\s*80\);/m;

code = code.replace(corruptedBlockRegex, missingBlock);
fs.writeFileSync('app.js', code);
console.log("Restoration successful");
