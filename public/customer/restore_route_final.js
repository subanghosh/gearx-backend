const fs = require('fs');
let code = fs.readFileSync('app.js', 'utf8');

const correctFunction = `function recalculateAndDrawRoute() {
    if (!window.routePickup || !window.routeDrop) return;

    const centerPin = document.getElementById('center-pickup-pin');
    if (centerPin) centerPin.style.display = 'none';

    // Clear old route control
    if (window.routePolylineControl) {
        if(window.routePolylineControl.setMap) window.routePolylineControl.setMap(null);
        window.routePolylineControl = null;
    }

    // Clear previous markers from customerMap
    if (customerMarker) {
        if (customerMarker.setMap) customerMarker.setMap(null);
        customerMarker = null;
    }
    if (dropMarker) {
        if (dropMarker.setMap) dropMarker.setMap(null);
        dropMarker = null;
    }
    if (window.stopMarkers) {
        window.stopMarkers.forEach(m => { if (m && m.setMap) m.setMap(null); });
    }
    window.stopMarkers = [];

    // Create markers programmatically
    // Pickup marker: Pulsing green dot
    const pickupIcon = createGoogleIcon('#22c55e');
    customerMarker = new google.maps.Marker({ position: {lat: window.routePickup.lat, lng: window.routePickup.lng}, map: customerMap, icon: pickupIcon });

    // Stop markers: Yellow circles
    if (window.routeStops && Array.isArray(window.routeStops)) {
        window.routeStops.forEach((stop) => {
            const stopIcon = createGoogleIcon('#facc15');
            const sm = new google.maps.Marker({ position: {lat: stop.lat, lng: stop.lng}, map: customerMap, icon: stopIcon });
            window.stopMarkers.push(sm);
        });
    }

    // Drop marker: Pulsing red dot
    const dropIcon = createGoogleIcon('#ef4444');
    dropMarker = new google.maps.Marker({ position: {lat: window.routeDrop.lat, lng: window.routeDrop.lng}, map: customerMap, icon: dropIcon });

    // Initialize Routing using Google Maps DirectionsService
    if (typeof google === 'undefined' || !google.maps) {
        console.warn("Google Maps API not loaded, cannot draw route.");
        return;
    }

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
            
            // Extract native Google Maps coordinates path
            const latLngs = route.overview_path;
            
            // Draw Polyline natively
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

            // Auto fit bounds natively
            customerMap.fitBounds(route.bounds, {padding: 80});
        } else {
            console.error("Directions request failed due to " + status);
        }
    });
}`;

// Use regex to replace from 'function recalculateAndDrawRoute()' up to 'window.routeStops = [];'
const regex = /function\s+recalculateAndDrawRoute\(\)\s*\{[\s\S]*?(?=\nwindow\.routeStops = \[\];)/;
code = code.replace(regex, correctFunction + '\n');

fs.writeFileSync('app.js', code);
console.log('Restored entire route function successfully');
