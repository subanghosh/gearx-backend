// google-leaflet-shim.js
// Intercepts Google Maps API calls and redirects visual components to Leaflet

window.onGoogleMapsLoaded = function() {
    console.log("Initializing Google-to-Leaflet Shim...");
    window.googleMapsReady = true;

    // Save originals
    const originalMaps = window.google.maps;

    // We override Map, Marker, Polyline, LatLngBounds, DirectionsRenderer
    
    window.google.maps.Map = function(element, options) {
        console.log("Leaflet Shim: Initializing Map");
        // Clear any Google injected error UI
        element.innerHTML = '';
        
        const center = options.center || {lat: 0, lng: 0};
        const map = L.map(element, {zoomControl: false, attributionControl: false}).setView([center.lat, center.lng], options.zoom || 13);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png').addTo(map);
        
        map.addListener = function(event, callback) {
            if (event === 'idle') map.on('moveend', callback);
            else map.on(event, callback);
        };
        map.setCenter = function(latlng) {
            map.setView([latlng.lat || latlng.lat(), latlng.lng || latlng.lng()]);
        };
        map.getCenter = function() {
            const c = map.getCenter();
            return {
                lat: () => c.lat,
                lng: () => c.lng,
                toJSON: () => ({lat: c.lat, lng: c.lng})
            };
        };
        map.fitBounds = function(bounds, padding) {
            if (bounds && bounds._leafletBounds && bounds._leafletBounds.isValid()) {
                map.fitBounds(bounds._leafletBounds, {padding: [padding||0, padding||0]});
            }
        };
        map.setOptions = function() {};
        
        return map;
    };

    window.google.maps.Marker = function(options) {
        let icon = options.icon;
        if (!icon || !icon.createIcon) {
            icon = new L.Icon.Default();
        }
        
        const lat = typeof options.position.lat === 'function' ? options.position.lat() : options.position.lat;
        const lng = typeof options.position.lng === 'function' ? options.position.lng() : options.position.lng;
        
        const marker = L.marker([lat, lng], {
            icon: icon,
            draggable: options.draggable || false
        });
        
        if (options.map) marker.addTo(options.map);
        
        marker.setMap = function(m) {
            if (m) marker.addTo(m);
            else marker.remove();
        };
        marker.addListener = function(event, callback) {
            marker.on(event, callback);
        };
        marker.getPosition = function() {
            const p = marker.getLatLng();
            return { lat: () => p.lat, lng: () => p.lng, toJSON: () => ({lat: p.lat, lng: p.lng}) };
        };
        return marker;
    };

    window.google.maps.LatLngBounds = function(sw, ne) {
        this._leafletBounds = L.latLngBounds([]);
        if (sw && ne) {
            this.extend(sw);
            this.extend(ne);
        }
        this.extend = function(latlng) {
            const lat = typeof latlng.lat === 'function' ? latlng.lat() : latlng.lat;
            const lng = typeof latlng.lng === 'function' ? latlng.lng() : latlng.lng;
            if (!isNaN(lat) && !isNaN(lng)) {
                this._leafletBounds.extend([lat, lng]);
            }
        };
    };

    window.google.maps.Polyline = function(options) {
        const latlngs = (options.path || []).map(p => {
            return [typeof p.lat === 'function' ? p.lat() : p.lat, typeof p.lng === 'function' ? p.lng() : p.lng];
        });
        const poly = L.polyline(latlngs, {
            color: options.strokeColor || '#0f172a',
            weight: options.strokeWeight || 5,
            opacity: options.strokeOpacity || 0.9
        });
        if (options.map) poly.addTo(options.map);
        
        poly.setMap = function(m) {
            if (m) poly.addTo(m);
            else poly.remove();
        };
        poly.setPath = function(path) {
            const newLatlngs = path.map(p => [typeof p.lat === 'function' ? p.lat() : p.lat, typeof p.lng === 'function' ? p.lng() : p.lng]);
            poly.setLatLngs(newLatlngs);
        };
        return poly;
    };

    window.google.maps.DirectionsRenderer = function(options) {
        this.map = options.map;
        this.poly = null;
        this.setMap = function(m) { this.map = m; };
        this.setDirections = function(result) {
            if (this.poly) this.poly.remove();
            if (!result || !result.routes || !result.routes[0]) return;
            const path = result.routes[0].overview_path;
            const latlngs = path.map(p => [typeof p.lat === 'function' ? p.lat() : p.lat, typeof p.lng === 'function' ? p.lng() : p.lng]);
            this.poly = L.polyline(latlngs, {color: '#0f172a', weight: 6, opacity: 0.8}).addTo(this.map);
        };
    };

    window.google.maps.Size = function(w, h) { return [w, h]; };
    window.google.maps.Point = function(x, y) { return [x, y]; };

    window.createGoogleIcon = function(color) {
        return L.divIcon({
            html: \`<svg width="24" height="34" viewBox="0 0 24 34" xmlns="http://www.w3.org/2000/svg"><path d="M12 0C5.373 0 0 5.373 0 12C0 21 12 34 12 34C12 34 24 21 24 12C24 5.373 18.627 0 12 0Z" fill="\${color}" stroke="#ffffff" stroke-width="2"/><circle cx="12" cy="12" r="5" fill="#ffffff"/></svg>\`,
            className: '',
            iconSize: [24, 34],
            iconAnchor: [12, 34]
        });
    };

    // Proceed with init
    if (typeof window.initCustomerMap === 'function') {
        window.initCustomerMap();
    }
};
