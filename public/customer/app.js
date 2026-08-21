// Global ngrok bypass patch for WebViews
const originalFetch = window.fetch;
window.fetch = function (input, init) {
    let url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    if (typeof url === 'string' && url.includes('ngrok-free.dev')) {
        console.log('[DEBUG-TRACKING] Injecting ngrok bypass header for URL:', url);
        init = init || {};
        init.headers = init.headers || {};
        if (init.headers instanceof Headers) {
            init.headers.set('ngrok-skip-browser-warning', 'true');
        } else if (Array.isArray(init.headers)) {
            init.headers.push(['ngrok-skip-browser-warning', 'true']);
        } else {
            init.headers['ngrok-skip-browser-warning'] = 'true';
        }
    }
    return originalFetch(input, init);
};

const isNativeApp = typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
const API_URL = isNativeApp
    ? 'https://api.redrivo.in/api'
    : (window.location.protocol === 'file:' ? 'http://localhost:3000/api' : `${window.location.origin}/api`);

// Safety Kill Switch: Customer advance payments disabled by default in production
window.ENABLE_CUSTOMER_ADVANCE_PAYMENT = false;

// Initialize Socket.io connection
window.socket = null;
if (typeof io !== 'undefined') {
    window.socket = io(API_URL.replace('/api', ''));
    console.log('Socket.io connected in Customer app');
    console.log("[DEBUG-TRACKING] Socket initialized with endpoint:", API_URL.replace('/api', ''));

    window.socket.on('marshalLocationUpdate', (data) => {
        console.log("[DEBUG-TRACKING] Socket event 'marshalLocationUpdate' received:", data);
        // Find if this trip is currently active
        const tripId = data.tripId;
        const lat = parseFloat(data.lat);
        const lng = parseFloat(data.lng);
        
        // Update home map marker if exists
        if (typeof customerMap !== 'undefined' && customerMap && typeof marshalMarker !== 'undefined' && marshalMarker) {
            let prevLat, prevLng;
            if (marshalMarker._prevLatLng) {
                prevLat = marshalMarker._prevLatLng[0];
                prevLng = marshalMarker._prevLatLng[1];
            } else {
                const pos = marshalMarker.getPosition();
                prevLat = pos ? pos.lat() : lat;
                prevLng = pos ? pos.lng() : lng;
            }
            if (prevLat !== lat || prevLng !== lng) {
                if (typeof animateMarkerSmoothly === 'function') animateMarkerSmoothly(marshalMarker, prevLat, prevLng, lat, lng, 3800);
                marshalMarker._prevLatLng = [lat, lng];
            }
        }
        
        // Update enRouteMap marker if exists
        const enRouteScreen = document.getElementById('marshal-en-route-screen');
        if (enRouteScreen && enRouteScreen.style.display !== 'none' && typeof enRouteMap !== 'undefined' && enRouteMap) {
            if (typeof enRouteMarshalMarker !== 'undefined' && enRouteMarshalMarker) {
                let prevLat, prevLng;
                if (enRouteMarshalMarker._prevLatLng) {
                    prevLat = enRouteMarshalMarker._prevLatLng[0];
                    prevLng = enRouteMarshalMarker._prevLatLng[1];
                } else {
                    const pos = enRouteMarshalMarker.getPosition();
                    prevLat = pos ? pos.lat() : lat;
                    prevLng = pos ? pos.lng() : lng;
                }
                if (prevLat !== lat || prevLng !== lng) {
                    if (typeof animateMarkerSmoothly === 'function') animateMarkerSmoothly(enRouteMarshalMarker, prevLat, prevLng, lat, lng, 3800);
                    enRouteMarshalMarker._prevLatLng = [lat, lng];
                }
            } else {
                const marshalIcon = create3DVehicleIcon(0);
                enRouteMarshalMarker = new google.maps.Marker({ position: {lat: lat, lng: lng}, map: enRouteMap, icon: marshalIcon });
                enRouteMarshalMarker._prevLatLng = [lat, lng];
            }
            // Note: ETA / distance update could be calculated here as well
        }
    });

    window.socket.on('tripCancelled', async (data) => {
        if (window.currentActiveTripId === data.tripId || window.currentPendingRequestId === data.serviceRequestId) {
            if (window.paymentCountdownInterval) {
                clearInterval(window.paymentCountdownInterval);
                window.paymentCountdownInterval = null;
            }
            
            const paymentModal = document.getElementById('payment-modal');
            if (paymentModal) paymentModal.style.display = 'none';
            
            showToast('Booking cancelled due to payment timeout (5 minutes).', 'error');
            
            const btn = document.getElementById('btn-request-service');
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = 'Search for Nearby Driver';
            }
            
            window.currentActiveTripId = null;
            window.currentPendingRequestId = null;
            
            await loadDashboard();
        }
    });
} else {
    console.warn('Socket.io library not loaded');
}



const lightMapStyle = [
  { "featureType": "poi", "elementType": "labels", "stylers": [{ "visibility": "off" }] },
  { "featureType": "transit", "elementType": "labels.icon", "stylers": [{ "visibility": "off" }] },
  { "featureType": "landscape", "stylers": [{ "color": "#f1f3f4" }] },
  { "featureType": "road", "elementType": "geometry", "stylers": [{ "color": "#ffffff" }] },
  { "featureType": "road.arterial", "elementType": "geometry", "stylers": [{ "color": "#fefefe" }] },
  { "featureType": "road.highway", "elementType": "geometry", "stylers": [{ "color": "#dadada" }] },
  { "featureType": "road.highway", "elementType": "geometry.stroke", "stylers": [{ "color": "#d0d0d0" }] },
  { "featureType": "water", "elementType": "geometry", "stylers": [{ "color": "#e0e0e0" }] }
];
const createGoogleIcon = (color, label = '') => {
    let svg = '<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">';
    svg += '<circle cx="12" cy="12" r="10" fill="' + color + '" stroke="white" stroke-width="2" />';
    if (label) {
        svg += '<text x="12" y="16" font-family="Arial" font-size="12" font-weight="bold" fill="white" text-anchor="middle">' + label + '</text>';
    }
    svg += '</svg>';
    return {
        url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
        scaledSize: new google.maps.Size(24, 24),
        anchor: new google.maps.Point(12, 12)
    };
};

const create3DVehicleIcon = (rotation = 0) => {
    const svg = `<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <linearGradient id="car-grad" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" style="stop-color:#facc15;stop-opacity:1" />
                <stop offset="100%" style="stop-color:#d97706;stop-opacity:1" />
            </linearGradient>
            <filter id="car-shadow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="1.5" stdDeviation="1.5" flood-color="#000" flood-opacity="0.5" />
            </filter>
        </defs>
        <g transform="rotate(${rotation}, 16, 16)">
            <!-- Wheels -->
            <!-- Wheels (Tucked flush under body silhouette) -->
            <rect x="9" y="7" width="3" height="5" rx="1.5" fill="#1e293b" />
            <rect x="20" y="7" width="3" height="5" rx="1.5" fill="#1e293b" />
            <rect x="9" y="20" width="3" height="5" rx="1.5" fill="#1e293b" />
            <rect x="20" y="20" width="3" height="5" rx="1.5" fill="#1e293b" />
            
            <!-- Car Body -->
            <path d="M 11 5 C 11 4, 21 4, 21 5 L 22 10 C 22 11, 23 12, 23 14 L 23 24 C 23 26, 22 27, 21 28 L 11 28 C 10 27, 9 26, 9 24 L 9 14 C 9 12, 10 11, 10 10 Z" fill="url(#car-grad)" filter="url(#car-shadow)" />
            
            <!-- Windshield -->
            <path d="M 12 10 L 20 10 C 21 10, 21.5 11, 21.8 12 L 22.2 13.5 L 9.8 13.5 L 10.2 12 C 10.5 11, 11 10, 12 10 Z" fill="#1e293b" />
            
            <!-- Side Windows -->
            <path d="M 9.6 15 L 10.8 15.5 L 10.8 19.5 L 9.6 20 Z" fill="#1e293b" />
            <path d="M 22.4 15 L 21.2 15.5 L 21.2 19.5 L 22.4 20 Z" fill="#1e293b" />
            
            <!-- Rear Window -->
            <path d="M 12 22 L 20 22 C 20.8 22, 21.2 22.5, 21.5 23 L 21.8 24.5 L 10.2 24.5 L 10.5 23 C 10.8 22.5, 11.2 22, 12 22 Z" fill="#1e293b" />
            
            <!-- Headlights -->
            <rect x="11.5" y="4.2" width="2" height="1" rx="0.5" fill="#fff" opacity="0.9" />
            <rect x="18.5" y="4.2" width="2" height="1" rx="0.5" fill="#fff" opacity="0.9" />
            
            <!-- Taillights -->
            <rect x="10.5" y="27.2" width="2" height="1" rx="0.5" fill="#ef4444" />
            <rect x="19.5" y="27.2" width="2" height="1" rx="0.5" fill="#ef4444" />
        </g>
    </svg>`;
    return {
        url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
        scaledSize: new google.maps.Size(48, 48),
        anchor: new google.maps.Point(24, 24)
    };
};

function animateGoogleMarkerSmoothly(marker, toLat, toLng, duration = 3000) {
    const start = performance.now();
    const fromLat = marker.getPosition().lat();
    const fromLng = marker.getPosition().lng();
    const bearing = typeof getBearing === 'function' ? getBearing(fromLat, fromLng, toLat, toLng) : Math.floor(Math.random() * 360);

    // Turn vehicle to face direction of travel
    marker.setIcon(create3DVehicleIcon(bearing));

    function step(timestamp) {
        const elapsed = timestamp - start;
        const progress = Math.min(elapsed / duration, 1);

        const currentLat = fromLat + (toLat - fromLat) * progress;
        const currentLng = fromLng + (toLng - fromLng) * progress;

        marker.setPosition(new google.maps.LatLng(currentLat, currentLng));

        if (progress < 1) {
            requestAnimationFrame(step);
        }
    }
    requestAnimationFrame(step);
}

const nativeFetch = window.fetch;

window.fetch = async function(resource, init) {
    init = init || {};
    init.headers = init.headers || {};
    
    const token = localStorage.getItem('redrivo_token') || localStorage.getItem('token') || localStorage.getItem('authToken');
    if (token) {
        init.headers['Authorization'] = `Bearer ${token}`;
    }

    // 1. Inject bypass headers for our development tunnels
    if (typeof resource === 'string' && (resource.includes('loca.lt') || resource.includes('ngrok-free.dev') || resource.includes('ngrok-free.app'))) {
        init.headers['Bypass-Tunnel-Reminder'] = 'true';
        init.headers['ngrok-skip-browser-warning'] = 'true';
    }

    // 2. If running natively and CapacitorHttp is available, route directly to native HTTP
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) {
        try {
            const method = (init && init.method) ? init.method.toUpperCase() : 'GET';
            const headers = (init && init.headers) ? init.headers : {};
            const body = (init && init.body) ? init.body : undefined;

            const nativeRes = await window.Capacitor.Plugins.CapacitorHttp.request({
                url: resource,
                method: method,
                headers: headers,
                data: body
            });

            // Map native response back to standard fetch Response object
            return new Response(typeof nativeRes.data === 'string' ? nativeRes.data : JSON.stringify(nativeRes.data), {
                status: nativeRes.status,
                headers: new Headers(nativeRes.headers)
            });
        } catch (err) {
            console.error("CapacitorHttp native request failed, falling back to browser fetch:", err);
        }
    }

    // 3. Fallback to browser's standard fetch
    return nativeFetch(resource, init);
};

window.redrivoSystemSettings = {};
window.customerRatePerKm = 15;
async function loadSystemSettings() {
    try {
        const [sysRes, globalRes] = await Promise.all([
            fetch(`${API_URL}/system-settings`),
            fetch(`${API_URL}/settings/global`)
        ]);
        const sys = await sysRes.json();
        const glob = await globalRes.json();
        window.redrivoSystemSettings = { ...sys, ...glob };
        if (typeof updatePricingSummary === 'function') updatePricingSummary();
    } catch (e) {
        console.error("Error loading system settings:", e);
    }
}

let currentUser = null;
let lastVerifiedOtp = '';
let pickupLocationResolved = false;
let dropLocationResolved = false;
let userVehicles = [];
let userRequests = [];
let activeVehicleIndex = 0;
let activeBookedVehicleIds = [];
let activeBookingVehicleId = null;
let enRouteMap = null;
let enRouteMarshalMarker = null;
let enRouteCustomerMarker = null;
let currentTripId = null;
let currentOtp1 = null;
let currentOtp2 = null; // Store final OTP
let currentInvoiceAmount = 0;
let currentServiceType = 'TrackA';
let currentPDType = 'None';
let allCategories = [];

window.bookingFlow = 'p2p';
window.selectedGarageId = null;
window.pickupDropType = 'Pickup';

window.selectedVehicleCondition = 'Working';
window.selectedPricingMode = 'distance';
window.selectedEstimatedHours = 4;
window.activeBookingTab = 'instant';
window.selectedScheduleDate = '';
window.selectedScheduleTime = '';
window.activeGarageTypeTab = 'car';
window.cachedNearbyGarages = [];
window.bookingSubView = '2A';

const ICONS = {
    home: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>`,
    office: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>`,
    other: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`,
    manual: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
    gps: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line></svg>`,
    camera: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>`,
    video: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`
};

const HECTOR_SMALL_SVG = `
<svg class="hector-small-svg" width="22" height="22" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" style="vertical-align: middle; display: inline-block;">
  <rect x="11" y="5" width="18" height="30" rx="4" fill="#E53E3E" stroke="#9B2C2C" stroke-width="1.5"/>
  <path d="M13 11C13 10 14 9 16 9H24C26 9 27 10 27 11L26 15H14L13 11Z" fill="#1A202C"/>
  <rect x="14" y="16" width="12" height="9" rx="1.5" fill="#2D3748"/>
  <rect x="16" y="17" width="8" height="6" rx="1" fill="#4299E1" fill-opacity="0.7"/>
  <rect x="12" y="5" width="2" height="1" rx="0.5" fill="#FFF"/>
  <rect x="26" y="5" width="2" height="1" rx="0.5" fill="#FFF"/>
</svg>`;

const HECTOR_MAP_SVG = `<div style="width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; position: relative;">
    <svg class="hector-map-icon" width="36" height="36" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" style="transition: transform 0.2s ease; transform-origin: center;">
      <rect x="10" y="4" width="20" height="32" rx="5" fill="black" fill-opacity="0.35" filter="blur(2px)"/>
      <rect x="11" y="5" width="18" height="30" rx="4" fill="#FBBF24" stroke="#B45309" stroke-width="1.5"/>
      <path d="M13 11C13 10 14 9 16 9H24C26 9 27 10 27 11L26 15H14L13 11Z" fill="#1A202C" stroke="#2D3748" stroke-width="0.5"/>
      <rect x="14" y="16" width="12" height="9" rx="1.5" fill="#2D3748" stroke="#1A202C" stroke-width="0.5"/>
      <rect x="16" y="17" width="8" height="6" rx="1" fill="#4299E1" fill-opacity="0.7"/>
      <path d="M14 5H26L25 9H15L14 5Z" fill="#B45309"/>
      <rect x="12" y="5" width="2" height="1" rx="0.5" fill="#FFF"/>
      <rect x="26" y="5" width="2" height="1" rx="0.5" fill="#FFF"/>
      <path d="M14 26L13 28C13 29 14 29 16 29H24C26 29 27 29 27 28L26 26H14Z" fill="#1A202C" stroke="#2D3748" stroke-width="0.5"/>
      <rect x="9" y="11" width="2" height="3" rx="0.5" fill="#B45309"/>
      <rect x="29" y="11" width="2" height="3" rx="0.5" fill="#B45309"/>
    </svg>
</div>`;

function getBearing(lat1, lng1, lat2, lng2) {
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const lat1Rad = lat1 * Math.PI / 180;
    const lat2Rad = lat2 * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2Rad);
    const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLng);
    const brng = Math.atan2(y, x) * 180 / Math.PI;
    return (brng + 360) % 360;
}

function animateMarkerSmoothly(marker, fromLat, fromLng, toLat, toLng, duration = 4000) {
    if (!marker) return;
    
    if (typeof marker.setPosition === 'function') {
        const start = performance.now();
        const bearing = typeof getBearing === 'function' ? getBearing(fromLat, fromLng, toLat, toLng) : 0;
        
        if (typeof create3DVehicleIcon === 'function') {
            marker.setIcon(create3DVehicleIcon(bearing));
        }
        
        function step(timestamp) {
            const elapsed = timestamp - start;
            const progress = Math.min(elapsed / duration, 1);
            
            const currentLat = fromLat + (toLat - fromLat) * progress;
            const currentLng = fromLng + (toLng - fromLng) * progress;
            
            marker.setPosition(new google.maps.LatLng(currentLat, currentLng));
            
            if (progress < 1) {
                requestAnimationFrame(step);
            }
        }
        requestAnimationFrame(step);
    } else if (typeof marker.setLatLng === 'function') {
        const start = performance.now();
        const bearing = typeof getBearing === 'function' ? getBearing(fromLat, fromLng, toLat, toLng) : 0;
        
        const updateRotation = () => {
            if (typeof marker.getElement === 'function') {
                const element = marker.getElement();
                if (element) {
                    const carImg = element.querySelector('.hector-map-icon');
                    if (carImg) {
                        carImg.style.transform = `rotate(${bearing}deg)`;
                    }
                }
            }
        };
        updateRotation();
        setTimeout(updateRotation, 100);
        
        function step(timestamp) {
            const elapsed = timestamp - start;
            const progress = Math.min(elapsed / duration, 1);
            
            const currentLat = fromLat + (toLat - fromLat) * progress;
            const currentLng = fromLng + (toLng - fromLng) * progress;
            
            marker.setLatLng([currentLat, currentLng]);
            updateRotation();
            
            if (progress < 1) {
                requestAnimationFrame(step);
            }
        }
        requestAnimationFrame(step);
    }
}

function selectServiceType(type) {
    currentServiceType = type;
    document.getElementById('v-service-type').value = type;

    // Toggle UI
    document.getElementById('st-track-a').className = type === 'TrackA' ? 'vtype-btn active' : 'vtype-btn inactive';
    document.getElementById('st-track-b').className = type === 'TrackB' ? 'vtype-btn active' : 'vtype-btn inactive';

    // UI Styling manual adjust
    document.getElementById('st-track-a').style.background = type === 'TrackA' ? 'rgba(250,204,21,0.08)' : 'rgba(255,255,255,0.02)';
    document.getElementById('st-track-a').style.borderColor = type === 'TrackA' ? 'var(--primary)' : 'var(--border)';
    document.getElementById('st-track-a').style.color = type === 'TrackA' ? 'var(--primary)' : 'var(--text-muted)';

    document.getElementById('st-track-b').style.background = type === 'TrackB' ? 'rgba(250,204,21,0.08)' : 'rgba(255,255,255,0.02)';
    document.getElementById('st-track-b').style.borderColor = type === 'TrackB' ? 'var(--primary)' : 'var(--border)';
    document.getElementById('st-track-b').style.color = type === 'TrackB' ? 'var(--primary)' : 'var(--text-muted)';

    updatePricingSummary();
}

function selectPD(type) {
    currentPDType = type;
    document.getElementById('v-pd-type').value = type;

    // Toggle UI
    const ids = ['pd-none', 'pd-both', 'pd-pickup', 'pd-drop'];
    ids.forEach(id => {
        const btn = document.getElementById(id);
        const isActive = id === `pd-${type.toLowerCase()}`;
        btn.className = isActive ? 'vtype-btn active' : 'vtype-btn inactive';
        btn.style.background = isActive ? 'rgba(250,204,21,0.08)' : 'rgba(255,255,255,0.02)';
        btn.style.borderColor = isActive ? 'var(--primary)' : 'var(--border)';
        btn.style.color = isActive ? 'var(--primary)' : 'var(--text-muted)';
    });

    updatePricingSummary();
}

function updatePricingSummary() {
    // ReDrivo Pricing Model:
    // Track A (500-pt Check): ReDrivo Service Charge 299, Labor 0 (for now), Inspection 0, QA 0.
    // Track B (Targeted Repair): ReDrivo Service Charge 99, Labor 0, Inspection 250 (waived if quote approved), QA 0
    // Parts are 0 until quote is approved.
    
    let redrivoServiceCharge = currentServiceType === 'TrackA' ? 299 : 99;
    let inspectionFee = currentServiceType === 'TrackB' ? 250 : 0;
    
    const activeVehicle = userVehicles[activeVehicleIndex];
    const isBike = activeVehicle && (String(activeVehicle.type).toLowerCase() === 'bike' || String(activeVehicle.category).toLowerCase() === 'bike');
    const vehicleType = isBike ? 'bike' : 'car';

    const rateKey = `${vehicleType}_customer_rate_per_km`;
    const baseFareKey = `${vehicleType}_base_fare`;
    const haltRateKey = `${vehicleType}_halt_rate_per_min`;
    
    const ratePerKm = window.redrivoSystemSettings?.[rateKey] !== undefined ? parseFloat(window.redrivoSystemSettings[rateKey]) : (vehicleType === 'car' ? 15 : 8);
    const baseFare = window.redrivoSystemSettings?.[baseFareKey] !== undefined ? parseFloat(window.redrivoSystemSettings[baseFareKey]) : (vehicleType === 'car' ? 150 : 50);
    const haltRate = window.redrivoSystemSettings?.[haltRateKey] !== undefined ? parseFloat(window.redrivoSystemSettings[haltRateKey]) : (vehicleType === 'car' ? 5 : 3);
    
    window.customerRatePerKm = ratePerKm;

    // Add logistics charge (calculated dynamically using coordinate distance)
    let pdCharge = 0;
    if (currentPDType !== 'None') {
        const pickupInput = document.getElementById('pickup-location-global');
        const dropInput = document.getElementById('drop-location-global');
        let distance = window.calculatedRouteDistance || 0;
        if (distance === 0 && pickupInput && dropInput) {
            const pLat = parseFloat(pickupInput.getAttribute('data-lat'));
            const pLng = parseFloat(pickupInput.getAttribute('data-lng'));
            const dLat = parseFloat(dropInput.getAttribute('data-lat'));
            const dLng = parseFloat(dropInput.getAttribute('data-lng'));
            if (!isNaN(pLat) && !isNaN(pLng) && !isNaN(dLat) && !isNaN(dLng)) {
                distance = calcDistanceKm(pLat, pLng, dLat, dLng);
            }
        }
        // Base charge of minimum fare, dynamic per-KM rate otherwise
        const baseCharge = Math.max(baseFare, Math.round(distance * ratePerKm));
        pdCharge = currentPDType === 'Both' ? baseCharge * 2 : baseCharge;
    }

    // Calculate halt charge
    let totalHaltMinutes = 0;
    if (window.routeStops && Array.isArray(window.routeStops)) {
        window.routeStops.forEach(stop => {
            totalHaltMinutes += parseInt(stop.haltTime) || 0;
        });
    }
    const haltCharge = totalHaltMinutes * haltRate;

    let laborCharge = pdCharge + haltCharge; // using logistics + halt charge as labor proxy

    let partsCharge = 0;
    let qaFee = 0;

    let total = redrivoServiceCharge + inspectionFee + laborCharge + partsCharge + qaFee;

    const rupeeSymbol = String.fromCharCode(8377);
    const elLabor = document.getElementById('summary-labor'); if (elLabor) elLabor.textContent = rupeeSymbol + laborCharge;
    const elSC = document.getElementById('summary-service-charge'); if (elSC) elSC.textContent = rupeeSymbol + redrivoServiceCharge;
    const elParts = document.getElementById('summary-parts'); if (elParts) elParts.textContent = rupeeSymbol + partsCharge;
    const elInsp = document.getElementById('summary-inspection'); if (elInsp) elInsp.textContent = rupeeSymbol + inspectionFee;
    const elQA = document.getElementById('summary-qa'); if (elQA) elQA.textContent = rupeeSymbol + qaFee;
    const elTotal = document.getElementById('summary-total'); if (elTotal) elTotal.textContent = rupeeSymbol + total;
}

// Ensure summary is updated on load
setTimeout(updatePricingSummary, 1000);

function showToast(message, type = 'info') {
    // type: 'success' | 'error' | 'info'
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.style.cssText = 'position:fixed; top:24px; left:50%; transform:translateX(-50%); z-index:9999; display:flex; flex-direction:column; gap:12px; max-width:90%; width:380px; align-items:center; pointer-events:none;';
        document.body.appendChild(container);
    }

    const colors = {
        success: { 
            bg: 'rgba(6, 78, 59, 0.85)', 
            border: 'rgba(16, 185, 129, 0.3)',
            glow: 'rgba(16, 185, 129, 0.25)',
            iconColor: '#34d399',
            icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>` 
        },
        error: { 
            bg: 'rgba(127, 29, 29, 0.85)', 
            border: 'rgba(239, 68, 68, 0.3)',
            glow: 'rgba(239, 68, 68, 0.25)',
            iconColor: '#f87171',
            icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>` 
        },
        info: { 
            bg: 'rgba(15, 23, 42, 0.85)', 
            border: 'rgba(250, 204, 21, 0.3)',
            glow: 'rgba(250, 204, 21, 0.25)',
            iconColor: '#facc15',
            icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#facc15" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>` 
        }
    };
    const { bg, border, glow, icon, iconColor } = colors[type] || colors.info;

    const toast = document.createElement('div');
    toast.style.cssText = `
        background: ${bg};
        border: 1px solid ${border};
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        color: #fff;
        padding: 12px 16px;
        border-radius: 16px;
        font-family: 'Manrope', sans-serif;
        font-size: 0.9rem;
        font-weight: 600;
        line-height: 1.4;
        display: flex;
        align-items: center;
        gap: 12px;
        box-shadow: 0 12px 30px rgba(0, 0, 0, 0.4), 0 0 15px ${glow};
        animation: toastSlideIn 0.35s cubic-bezier(0.16, 1, 0.3, 1);
        opacity: 1;
        transition: all 0.3s ease;
        width: 100%;
        pointer-events: auto;
    `;
    toast.innerHTML = `
        <span style="display:flex; align-items:center; justify-content:center; flex-shrink:0; width: 28px; height: 28px; background: rgba(255, 255, 255, 0.04); border-radius: 50%; border: 1.5px solid ${border};">${icon}</span>
        <span style="flex-grow: 1; letter-spacing: -0.1px;">${message}</span>
    `;
    container.appendChild(toast);

    if (!document.getElementById('toast-style')) {
        const style = document.createElement('style');
        style.id = 'toast-style';
        style.textContent = `
            @keyframes toastSlideIn {
                from { transform: translateY(-20px); opacity: 0; filter: blur(4px); }
                to { transform: translateY(0); opacity: 1; filter: blur(0); }
            }
        `;
        document.head.appendChild(style);
    }

    // Auto dismiss
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-10px) scale(0.95)';
        toast.style.filter = 'blur(4px)';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// --- API Helpers ---
function forceLogout(message) {
    currentUser = null;
    localStorage.removeItem('redrivo_current_user');
    localStorage.removeItem('redrivo_token');
    
    // Clear inputs and reset UI state of signup
    document.getElementById('su-phone').value = '';
    if (window.clearOtpBoxes) clearOtpBoxes('su-otp'); else document.getElementById('su-otp').value = '';
    document.getElementById('su-otp-area').style.display = 'none';
    const btn1 = document.getElementById('btn-signup-step1');
    if (btn1) {
        btn1.style.display = 'block';
        btn1.innerHTML = 'Send OTP';
        btn1.disabled = false;
    }
    const btn2 = document.getElementById('btn-signup-step2');
    if (btn2) btn2.style.display = 'none';

    // Toggle main app state immediately to the auth screen
    document.getElementById('app-container').classList.add('hidden');
    document.getElementById('login-container').classList.remove('hidden');

    if (message) {
        showToast(message, 'error');
    }
}

async function handleApiError(res) {
    let errMsg = `API Error: ${res.statusText}`;
    try {
        const errJson = await res.json();
        errMsg = errJson.error || errJson.message || errMsg;
    } catch (e) { /* ignore */ }
    
    if (res.status === 401 || res.status === 403 || errMsg.includes('foreign key constraint') || errMsg.includes('customer_not_found') || errMsg.includes('violates foreign key')) {
        forceLogout('Your session has expired, please log in again.');
        throw new Error('Session expired. Redirecting to login...');
    }
    throw new Error(errMsg);
}

async function apiGet(endpoint) {
    const res = await fetch(`${API_URL}${endpoint}`);
    if (!res.ok) await handleApiError(res);
    return res.json();
}
async function apiPost(endpoint, data, init = {}) {
    const res = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        ...init
    });
    if (!res.ok) await handleApiError(res);
    return res.json();
}

async function apiPut(endpoint, data) {
    const res = await fetch(`${API_URL}${endpoint}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    if (!res.ok) await handleApiError(res);
    return res.json();
}

async function apiDelete(endpoint) {
    const res = await fetch(`${API_URL}${endpoint}`, {
        method: 'DELETE'
    });
    if (!res.ok) await handleApiError(res);
    return res.json();
}

async function apiPatch(endpoint, data) {
    const res = await fetch(`${API_URL}${endpoint}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    if (!res.ok) await handleApiError(res);
    return res.json();
}
const generateId = () => Math.random().toString(36).substr(2, 9);

// OTP cooldown state
let otpCooldownTimer = null;
let otpCooldownSeconds = 0;

function startOtpCooldown(linkEl) {
    if (otpCooldownTimer) clearInterval(otpCooldownTimer);
    otpCooldownSeconds = 60;
    if (linkEl) {
        linkEl.style.pointerEvents = 'none';
        linkEl.style.opacity = '0.5';
        linkEl.textContent = `Resend OTP (60s)`;
    }
    otpCooldownTimer = setInterval(() => {
        otpCooldownSeconds--;
        if (linkEl) linkEl.textContent = `Resend OTP (${otpCooldownSeconds}s)`;
        if (otpCooldownSeconds <= 0) {
            clearInterval(otpCooldownTimer);
            otpCooldownTimer = null;
            if (linkEl) {
                linkEl.style.pointerEvents = 'auto';
                linkEl.style.opacity = '1';
                linkEl.textContent = 'Resend OTP';
            }
        }
    }, 1000);
}

// Passwordless Auth Flow
let lastSentPhone = '';

async function handleSignupStep1() {
    if (otpCooldownSeconds > 0) {
        showToast(`Please wait ${otpCooldownSeconds} seconds before requesting a new OTP.`, 'error');
        return;
    }
    const phoneInput = document.getElementById('su-phone');
    const phone = phoneInput ? phoneInput.value.trim() : '';

    if (!phone) {
        showToast('Please enter your phone number.', 'error');
        return;
    }
    if (!/^\d{10}$/.test(phone)) {
        showToast('Please enter a valid 10-digit phone number.', 'error');
        return;
    }

    // Set lastSentPhone immediately after validation passes to cover both auto-advance and manual retry links
    lastSentPhone = phone;

    // Hide retry container if visible
    const retryContainer = document.getElementById('phone-retry-container');
    if (retryContainer) retryContainer.style.display = 'none';

    // Disable input while request is in flight to prevent concurrent edits/triggers
    if (phoneInput) phoneInput.disabled = true;

    const btn = document.getElementById('btn-signup-step1');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = 'Sending OTP...';
    }

    // 20-second timeout to handle Render cold start
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    try {
        const res = await fetch(`${API_URL}/auth/send-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({ phone, countryCode: '+91' })
        });
        clearTimeout(timeoutId);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to send OTP');

        document.getElementById('su-otp-area').style.display = 'block';
        if (btn) btn.style.display = 'none';
        document.getElementById('btn-signup-step2').style.display = 'block';

        // Start 60-second cooldown on resend link
        const resendLink = document.getElementById('resend-otp-link');
        startOtpCooldown(resendLink);

        showToast(`OTP sent! For testing, your code is: ${data.otp}`, 'success');
        if (data.otp) { console.log('DEV OTP:', data.otp); if (window.fillOtpBoxes) fillOtpBoxes('su-otp', data.otp); }
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') {
            showToast('Request timed out. The server may be starting up — please try again in 30 seconds.', 'error');
        } else {
            showToast(e.message, 'error');
        }
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = 'Send OTP';
        }
        // Unlock input on failure so they can edit or try again
        if (phoneInput) phoneInput.disabled = false;
        lastSentPhone = '';
        
        // Show retry button
        if (retryContainer) retryContainer.style.display = 'block';
    }
}

async function resendOTP() {
    if (otpCooldownSeconds > 0) {
        showToast(`Please wait ${otpCooldownSeconds} seconds before requesting a new OTP.`, 'error');
        return;
    }

    const phoneNum = document.getElementById('su-phone').value.trim();
    if (!phoneNum || phoneNum.length !== 10) { showToast('Valid phone required', 'error'); return; }

    showToast('Resending OTP...', 'info');
    const resendLink = document.getElementById('resend-otp-link');
    if (resendLink) { resendLink.style.pointerEvents = 'none'; resendLink.style.opacity = '0.5'; }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    try {
        const res = await fetch(`${API_URL}/auth/send-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({ phone: phoneNum, countryCode: '+91' })
        });
        clearTimeout(timeoutId);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to resend OTP');

        // Restart 60-second cooldown
        startOtpCooldown(resendLink);

        showToast(`New OTP sent! Code: ${data.otp}`, 'success');
        if (data.otp) console.log('DEV OTP:', data.otp);
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') {
            showToast('Request timed out. Please try again.', 'error');
        } else {
            showToast(e.message, 'error');
        }
        if (resendLink) { resendLink.style.pointerEvents = 'auto'; resendLink.style.opacity = '1'; }
    }
}

async function handleSignupStep2() {
    const otp = document.getElementById('su-otp').value.trim();
    if (otp.length !== 6) { showToast('Enter 6-digit OTP', 'error'); return; }

    const btn = document.getElementById('btn-signup-step2');
    if (btn && btn.disabled) return; // Prevent double-triggering if already verifying
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = 'Verifying...';
    }

    const phoneNum = document.getElementById('su-phone').value.trim();

    try {
        // 1. Verify OTP & Auto-Login
        const verifyRes = await fetch(`${API_URL}/auth/verify-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: phoneNum, otp, role: 'customer' })
        });
        const verifyData = await verifyRes.json();
        if (!verifyRes.ok) throw new Error(verifyData.error || 'OTP verification failed');

        showToast('Verification successful! Logging in...', 'success');

        // Setup User Session
        currentUser = {
            id: verifyData.user.id.replace('_user', ''),
            name: verifyData.user.name,
            role: verifyData.user.role,
            phone: verifyData.user.phone || '',
            email: verifyData.user.email || '',
            emailVerified: verifyData.user.emailVerified || verifyData.user.emailverified || 0,
            phoneVerified: verifyData.user.phoneVerified || verifyData.user.phoneverified || 0
        };
        localStorage.setItem('redrivo_current_user', JSON.stringify(currentUser));
        if (verifyData.token) {
            localStorage.setItem('redrivo_token', verifyData.token);
        }
        updateUserAvatar();

        // Reset UI for future use
        document.getElementById('su-otp-area').style.display = 'none';
        const btn1 = document.getElementById('btn-signup-step1');
        if (btn1) {
            btn1.style.display = 'block';
            btn1.disabled = false;
        }
        document.getElementById('btn-signup-step2').style.display = 'none';

        // Redirect to Dashboard
        document.getElementById('display-name').textContent = currentUser.name;
        document.getElementById('login-container').classList.add('hidden');
        document.getElementById('app-container').classList.remove('hidden');

        loadDashboard();
        loadCategories();

    } catch (e) {
        lastVerifiedOtp = ''; // Clear guard on failure so they can try again
        if (typeof showToast === 'function') showToast(e.message, 'error');
        const btn = document.getElementById('btn-signup-step2');
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = 'Verify OTP';
        }
    }
}

function logout() {
    document.getElementById('logout-modal').style.display = 'flex';
}

function closeLogoutModal() {
    document.getElementById('logout-modal').style.display = 'none';
}

function confirmLogout() {
    document.getElementById('logout-modal').style.display = 'none';
    currentUser = null;
    localStorage.removeItem('redrivo_current_user');
    localStorage.removeItem('redrivo_token');
    
    // Clear inputs and reset UI state of signup
    document.getElementById('su-phone').value = '';
    if (window.clearOtpBoxes) clearOtpBoxes('su-otp'); else document.getElementById('su-otp').value = '';
    document.getElementById('su-otp-area').style.display = 'none';
    const btn1 = document.getElementById('btn-signup-step1');
    if (btn1) {
        btn1.style.display = 'block';
        btn1.innerHTML = 'Send OTP';
        btn1.disabled = false;
    }
    document.getElementById('btn-signup-step2').style.display = 'none';

    // Toggle main app state immediately to the auth screen
    document.getElementById('app-container').classList.add('hidden');
    document.getElementById('login-container').classList.remove('hidden');
}

async function loadCategories() {
    try {
        allCategories = await apiGet('/categories');
        const select = document.getElementById('booking-category');
        if (select) {
            allCategories.forEach(c => {
                select.innerHTML += `<option value="${c}">${c}</option>`;
            });
        }
    } catch (e) {
        console.error("Failed loading categories", e);
    }
}

let customerMap = null;
let customerMarker = null;
let marshalMarker = null;
let nearbyMarshalMarkers = [];

function initCustomerMap(attempts = 0) {
    console.log("[DEBUG-MAP] initCustomerMap started, attempts:", attempts);
    if (customerMap) {
        console.log("[DEBUG-MAP] initCustomerMap: customerMap already exists, returning");
        return;
    }
    const mapEl = document.getElementById('leaflet-map');
    if (!mapEl) {
        console.warn("[DEBUG-MAP] initCustomerMap: leaflet-map DOM element not found, returning");
        return;
    }
    
    if (typeof google === 'undefined' || !google.maps) {
        console.log("[DEBUG-MAP] google maps object undefined, setting retry timeout");
        if (attempts < 50) {
            setTimeout(() => initCustomerMap(attempts + 1), 100);
        } else {
            console.error("[DEBUG-MAP] Google maps library failed to load after 50 attempts");
            showToast('Unable to load maps, please check your connection', 'error');
        }
        return;
    }
    
    // Default to Mumbai BKC
    customerMap = new google.maps.Map(document.getElementById('leaflet-map'), { center: {lat: 19.0664, lng: 72.8680}, zoom: 13, disableDefaultUI: true, styles: lightMapStyle });
    console.log("[DEBUG-MAP] customerMap successfully instantiated");
    
    // L.tileLayer removed;

    // Show center pin on startup for pickup location selection (Rapido style)
    const centerPin = document.getElementById('center-pickup-pin');
    if (centerPin) centerPin.style.display = 'flex';

    // Map moveend event listener to dynamically update pickup location on pan/drag
    let isUserDraggingMap = false;
    customerMap.addListener('dragstart', () => { isUserDraggingMap = true; });
    customerMap.addListener('dragend', () => { isUserDraggingMap = false; });

    customerMap.addListener('idle', () => {
        if (!isUserDraggingMap) return;
        const routeStatsBadge = document.getElementById('route-stats-badge');
        if (routeStatsBadge && routeStatsBadge.style.display === 'flex') return;
        const centerPin = document.getElementById('center-pickup-pin');
        if (centerPin && centerPin.style.display === 'none') return;
        
        const center = customerMap.getCenter();
        const lat = typeof center.lat === 'function' ? center.lat() : center.lat;
        const lng = typeof center.lng === 'function' ? center.lng() : center.lng;

        const tooltip = document.getElementById('center-pin-tooltip');
        if (tooltip) tooltip.innerHTML = `<span style="display: inline-block; width: 6px; height: 6px; background: #facc15; border-radius: 50%; animation: pulse 1s infinite ease-in-out;"></span>Locating...`;

        fetch(`${API_URL}/maps/reverse-geocode?lat=${lat}&lng=${lng}`)
            .then(res => res.json())
            .then(data => {
                if (data && data.address) {
                    console.log("[DEBUG] idle listener setting pickup address to:", data.address);
                    const pickupInput = document.getElementById('pickup-location-global');
                    if (pickupInput) {
                        pickupInput.value = data.address;
                        pickupInput.setAttribute('data-address', data.address);
                        pickupInput.setAttribute('data-lat', lat);
                        pickupInput.setAttribute('data-lng', lng);
                    }
                    if (tooltip) {
                        tooltip.innerHTML = `<span style="display: inline-block; width: 6px; height: 6px; background: #22c55e; border-radius: 50%;"></span>${data.address.split(',')[0]}`;
                    }
                }
            })
            .catch(() => {
                if (tooltip) tooltip.innerHTML = `<span style="display: inline-block; width: 6px; height: 6px; background: #38bdf8; border-radius: 50%;"></span>Pin Pickup Location`;
            });

        showNearbyMarshalsOnMap(lat, lng);
        loadNearbyGarages(lat, lng);
    });

    // Removed OSMBuildings as it causes significant main thread blocking and slows map initialization

    // Map click event listener for manual pinpointing
    customerMap.addListener('click', (e) => {
        const lat = e.latLng.lat();
        const lng = e.latLng.lng();
        const popupContent = `
            <div style="font-family: 'Manrope', sans-serif; padding: 4px; min-width: 130px;">
                <h4 style="margin: 0 0 8px 0; font-size: 0.85rem; color: #000; text-align: center;">Pinpoint Location</h4>
                <button onclick="setMapLocation('pickup', ${lat}, ${lng})" style="display: block; width: 100%; padding: 6px 10px; margin-bottom: 6px; background: #facc15; border: none; border-radius: 6px; color: #000; font-weight: 700; cursor: pointer; font-size: 0.75rem;">Set as Pickup</button>
                <button onclick="setMapLocation('drop', ${lat}, ${lng})" style="display: block; width: 100%; padding: 6px 10px; background: #22c55e; border: none; border-radius: 6px; color: #fff; font-weight: 700; cursor: pointer; font-size: 0.75rem;">Set as Drop</button>
            </div>
        `;
        
        if (window.activeInfoWindow) { window.activeInfoWindow.close(); }
        window.activeInfoWindow = new google.maps.InfoWindow({
            position: e.latLng,
            content: popupContent
        });
        window.activeInfoWindow.open(customerMap);
    });
    // Automatically trigger native GPS / IP geolocation to populate pickup address immediately on startup
    console.log("[DEBUG-MAP] Calling triggerGeolocation() from initCustomerMap()");
    triggerGeolocation();
}

window.showGpsDisclosureModal = function() {
    const modal = document.getElementById('gps-disclosure-modal');
    if (modal) modal.style.display = 'flex';
};

window.acceptGpsConsent = function() {
    localStorage.setItem('redrivo_gps_consent', 'true');
    const modal = document.getElementById('gps-disclosure-modal');
    if (modal) modal.style.display = 'none';
    triggerGeolocation();
};

window.denyGpsConsent = function() {
    localStorage.setItem('redrivo_gps_consent', 'false');
    const modal = document.getElementById('gps-disclosure-modal');
    if (modal) modal.style.display = 'none';
    handleGpsFallback();
};

async function fastReverseGeocode(lat, lng) {
    if (window.google && window.google.maps && window.google.maps.Geocoder) {
        try {
            const geocoder = new google.maps.Geocoder();
            const res = await geocoder.geocode({ location: { lat, lng } });
            if (res.results && res.results.length > 0) {
                return res.results[0].formatted_address;
            }
        } catch (e) {
            console.warn("Client Google Maps Geocoder failed, falling back to API", e);
        }
    }
    try {
        const res = await fetch(`${API_URL}/maps/reverse-geocode?lat=${lat}&lng=${lng}`);
        if (res.ok) {
            const data = await res.json();
            if (data && data.address) return data.address;
        }
    } catch (e) {
        console.warn("API Reverse geocode failed", e);
    }
    return `GPS Coordinates: ${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

function handleGeolocationSuccess(lat, lng, isIP = false) {
    console.log("[DEBUG-GEO] handleGeolocationSuccess resolved coords:", {lat, lng, isIP}, "customerMap present:", !!customerMap);
    pickupLocationResolved = true;
    if (customerMap) {
        customerMap.setCenter({lat: lat, lng: lng}); customerMap.setZoom(15);
        
        const customerIcon = createGoogleIcon('#38bdf8');
        if (customerMarker) if (customerMarker) customerMarker.setMap(null);
        customerMarker = new google.maps.Marker({ position: {lat: parseFloat(lat), lng: parseFloat(lng)}, map: customerMap, icon: customerIcon, draggable: true });
        customerMarker.addListener('dragend', function(e) {
    const pos = customerMarker.getPosition();
    window.setMapLocation('pickup', typeof pos.lat === 'function' ? pos.lat() : pos.lat, typeof pos.lng === 'function' ? pos.lng() : pos.lng);
});
    }
    
    const pickupInput = document.getElementById('pickup-location-global');
    if (pickupInput) {
        pickupInput.setAttribute('data-lat', lat);
        pickupInput.setAttribute('data-lng', lng);
        pickupInput.value = isIP ? "Approximate Location" : "Detecting location...";
        pickupInput.setAttribute('data-address', isIP ? "Approximate Location" : "Current Location");
        
        // Reverse geocode to get actual street name
        fastReverseGeocode(lat, lng).then(address => {
            if (address && !address.startsWith('GPS')) {
                pickupInput.value = address;
                pickupInput.setAttribute('data-address', address);
                
                const garageManualLoc = document.getElementById('garage-manual-location');
                if (garageManualLoc) {
                    garageManualLoc.value = address;
                    garageManualLoc.setAttribute('data-lat', lat);
                    garageManualLoc.setAttribute('data-lng', lng);
                }
            } else {
                pickupInput.value = isIP ? "Approximate Location" : "Current Location";
            }
        }).catch(err => {
            console.warn("Failed reverse geocode on startup", err);
            pickupInput.value = isIP ? "Approximate Location" : "Current Location";
        });
    }
    showNearbyMarshalsOnMap(lat, lng);
    loadNearbyGarages(lat, lng);
}

function fallbackToIpGeolocation() {
    fetch('https://ipapi.co/json/')
        .then(res => res.json())
        .then(data => {
            if (data && data.latitude && data.longitude) {
                console.log("IP Geolocation success:", data.latitude, data.longitude);
                handleGeolocationSuccess(data.latitude, data.longitude, true);
            } else {
                handleGpsFallback();
            }
        })
        .catch(err => {
            console.error("IP Geolocation failed:", err);
            handleGpsFallback();
        });
}

async function getNativeGpsLocation(highAccuracy = true) {
    console.log("[DEBUG-GEO] getNativeGpsLocation started");
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Geolocation) {
        const Geolocation = window.Capacitor.Plugins.Geolocation;
        try {
            console.log("[DEBUG-GEO] Checking Geolocation permissions...");
            let perm = await Geolocation.checkPermissions();
            console.log("[DEBUG-GEO] checkPermissions result:", perm.location);
            if (perm.location === 'prompt' || perm.location === 'prompt-with-rationale') {
                console.log("[DEBUG-GEO] Geolocation permissions prompt required. Requesting...");
                perm = await Geolocation.requestPermissions();
                console.log("[DEBUG-GEO] requestPermissions result:", perm.location);
            }
            if (perm.location === 'granted') {
                console.log("[DEBUG-GEO] Permission granted, calling getCurrentPosition...");
                const pos = await Geolocation.getCurrentPosition({
                    enableHighAccuracy: highAccuracy,
                    timeout: 4000
                });
                console.log("[DEBUG-GEO] getCurrentPosition success:", pos?.coords ? "coords resolved" : "empty");
                if (pos && pos.coords) {
                    return {
                        lat: pos.coords.latitude,
                        lng: pos.coords.longitude,
                        accuracy: pos.coords.accuracy || 0
                    };
                }
            } else {
                console.warn("Native GPS permission not granted:", perm.location);
            }
        } catch (e) {
            console.error("Native Geolocation plugin error:", e);
        }
    }
    return null;
}

async function triggerGeolocation() {
    console.log("[DEBUG-GEO] triggerGeolocation auto-pickup started");
    try {
        const nativePos = await getNativeGpsLocation(true);
        if (nativePos) {
            console.log("Acquired native GPS coordinates:", nativePos);
            handleGeolocationSuccess(nativePos.lat, nativePos.lng, false);
            return;
        }
    } catch (e) {
        console.warn("Native GPS attempt failed, trying browser GPS...", e);
    }

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(pos => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;
            handleGeolocationSuccess(lat, lng, false);
        }, () => {
            console.warn("Startup GPS geolocation failed or blocked. Trying IP geolocation...");
            fallbackToIpGeolocation();
        }, { enableHighAccuracy: true, timeout: 4000, maximumAge: 600000 });
    } else {
        fallbackToIpGeolocation();
    }
}

function handleGpsFallback() {
    const lat = 19.0664;
    const lng = 72.8680;
    if (customerMap) {
        customerMap.setCenter({lat: parseFloat(lat), lng: parseFloat(lng)});
        customerMap.setZoom(13);
    }
    const pickupInput = document.getElementById('pickup-location-global');
    if (pickupInput) {
        pickupInput.setAttribute('data-lat', lat);
        pickupInput.setAttribute('data-lng', lng);
        pickupInput.setAttribute('data-address', "BKC, Mumbai");
        // Do not pre-fill value, keep it blank so placeholder shows and vanishes on focus
    }
    showNearbyMarshalsOnMap(lat, lng);
    
    // Fetch nearby garages based on fallback location
    loadNearbyGarages(lat, lng);
}

function showNearbyMarshalsOnMap(lat, lng) {
    if (!customerMap) {
        initCustomerMap();
    }
    if (!customerMap) return;

    // Clear any existing nearby marshal markers
    clearNearbyMarshalMarkers();

    // 1. Update customerMarker position (pickup location)
    const customerIcon = createGoogleIcon('#38bdf8');
    
    const routeStatsBadge = document.getElementById('route-stats-badge');
    const isRouteActive = routeStatsBadge && routeStatsBadge.style.display === 'flex';
    
    if (isRouteActive) {
        if (customerMarker) {
            customerMarker.setPosition({lat: parseFloat(lat), lng: parseFloat(lng)});
            if (!(customerMarker && customerMarker.getMap() != null)) customerMarker;
        } else {
            customerMarker = new google.maps.Marker({ position: {lat: parseFloat(lat), lng: parseFloat(lng)}, map: customerMap, icon: customerIcon });
        }
    } else {
        if (customerMarker) {
            if (customerMarker) customerMarker.setMap(null);
        }
    }

    // 2. Generate 3 mock marshals around this location
    const offsets = [
        { dLat: 0.003, dLng: -0.004, name: "Sirajuddin" },
        { dLat: -0.005, dLng: 0.003, name: "Mike Marshal" },
        { dLat: 0.002, dLng: 0.005, name: "Alu Arjun" }
    ];

    const points = [[lat, lng]];

    offsets.forEach(offset => {
        const mLat = lat + offset.dLat;
        const mLng = lng + offset.dLng;
        points.push([mLat, mLng]);

        const randomHeading = Math.floor(Math.random() * 360);
        const marshalIcon = create3DVehicleIcon(randomHeading);

        const marker = new google.maps.Marker({ position: {lat: parseFloat(mLat), lng: parseFloat(mLng)}, map: customerMap, icon: marshalIcon });
        marker;
        nearbyMarshalMarkers.push(marker);
    });

    // 3. Set up simulation loop for live marshal movement
    if (window.marshalAnimationInterval) {
        clearInterval(window.marshalAnimationInterval);
    }
    window.marshalAnimationInterval = setInterval(() => {
        if (nearbyMarshalMarkers && nearbyMarshalMarkers.length > 0) {
            nearbyMarshalMarkers.forEach(marker => {
                if (!marker || !marker.getPosition) return;
                const pos = marker.getPosition();
                const currentLat = pos.lat();
                const currentLng = pos.lng();
                
                // Nudge coordinates slightly (approx 5-10 meters random drift)
                const nudgeLat = (Math.random() - 0.5) * 0.0001;
                const nudgeLng = (Math.random() - 0.5) * 0.0001;
                
                animateGoogleMarkerSmoothly(marker, currentLat + nudgeLat, currentLng + nudgeLng, 3000);
            });
        }
    }, 4000);

    // Commented out to prevent infinite moveend triggering loop
    // const bounds = L.latLngBounds(points);
    // customerMap.fitBounds(bounds, { padding: [50, 50] });
}

function clearNearbyMarshalMarkers() {
    if (window.marshalAnimationInterval) {
        clearInterval(window.marshalAnimationInterval);
        window.marshalAnimationInterval = null;
    }
    if (nearbyMarshalMarkers && nearbyMarshalMarkers.length > 0) {
        nearbyMarshalMarkers.forEach(m => {
            if (customerMap) if (m) m.setMap(null);
        });
        nearbyMarshalMarkers = [];
    }
}

let liveTrackingInterval = null;
let isAppActive = true;

// Haversine formula — returns distance in km between two lat/lng points
function calcDistanceKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng/2) * Math.sin(dLng/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function updateEtaBanner(marshalLat, marshalLng, targetLat, targetLng, statusLabel) {
    console.log("[DEBUG-TRACKING] updateEtaBanner called. Status:", statusLabel, "Coords:", {marshalLat, marshalLng, targetLat, targetLng});
    const etaTime = document.getElementById('enroute-eta-time');
    const etaDist = document.getElementById('enroute-eta-dist');
    const etaStatus = document.getElementById('enroute-status-label');
    
    const homeEtaTime = document.getElementById('home-eta-time');
    const homeEtaDist = document.getElementById('home-eta-dist');
    const homeStatusText = document.getElementById('home-status-text');

    if (marshalLat && marshalLng && targetLat && targetLng) {
        const lat1 = parseFloat(marshalLat);
        const lng1 = parseFloat(marshalLng);
        const lat2 = parseFloat(targetLat);
        const lng2 = parseFloat(targetLng);

        // Fallback straight-line calculation
        const distHaversine = calcDistanceKm(lat1, lng1, lat2, lng2);
        const minsHaversine = Math.max(1, Math.round(distHaversine * 3.5));

        const applyValues = (dKm, mVal) => {
            if (dKm <= 0.1) {
                if (etaTime) etaTime.textContent = 'Reached';
                if (etaDist) etaDist.textContent = '0.0 km';
                if (etaStatus) etaStatus.innerHTML = `<span style="background: #22c55e; color: #fff; padding: 2px 8px; border-radius: 8px; font-weight: bold; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 4px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> Reached Location</span>`;
                
                if (homeEtaTime) homeEtaTime.textContent = 'Reached';
                if (homeEtaDist) homeEtaDist.textContent = '0.0 km';
                if (homeStatusText) homeStatusText.innerHTML = `<span style="background: #22c55e; color: #fff; padding: 2px 6px; border-radius: 6px; font-weight: bold;">Reached Location</span>`;
            } else {
                if (etaTime) etaTime.textContent = mVal + ' min';
                if (etaDist) etaDist.textContent = dKm.toFixed(1) + ' km';
                if (etaStatus && statusLabel) etaStatus.textContent = statusLabel;
                
                if (homeEtaTime) homeEtaTime.textContent = mVal + ' min';
                if (homeEtaDist) homeEtaDist.textContent = dKm.toFixed(1) + ' km';
                if (homeStatusText && statusLabel) homeStatusText.textContent = statusLabel;
            }
        };

        // Render fallback immediately ONLY if Google Maps isn't loaded/available, otherwise show loading
        if (typeof google === 'undefined' || !google.maps) {
            applyValues(distHaversine, minsHaversine);
        } else {
            // Set loading state to prevent flickering
            if (etaTime) etaTime.textContent = '-- min';
            if (etaDist) etaDist.textContent = '-- km';
            if (homeEtaTime) homeEtaTime.textContent = '-- min';
            if (homeEtaDist) homeEtaDist.textContent = '-- km';
        }

        // Query driving directions for precise values if Google Maps is loaded
        if (typeof google !== 'undefined' && google.maps) {
            try {
                const directionsService = new google.maps.DirectionsService();
                directionsService.route({
                    origin: { lat: lat1, lng: lng1 },
                    destination: { lat: lat2, lng: lng2 },
                    travelMode: google.maps.TravelMode.DRIVING
                }, (response, status) => {
                    console.log("[DEBUG-TRACKING] updateEtaBanner Google Directions route status:", status);
                    if (status === 'OK' && response.routes[0] && response.routes[0].legs[0]) {
                        const leg = response.routes[0].legs[0];
                        if (leg.distance && leg.duration) {
                            const driveDistKm = leg.distance.value / 1000;
                            const driveMins = Math.max(1, Math.round(leg.duration.value / 60));
                            // Apply precise driving directions values
                            applyValues(driveDistKm, driveMins);
                        }
                    }
                });
            } catch (err) {
                console.error('Error fetching driving directions in updateEtaBanner:', err);
            }
        }
    } else {
        if (etaTime) etaTime.textContent = '-- min';
        if (etaDist) etaDist.textContent = '-- km';
        if (etaStatus && statusLabel) etaStatus.textContent = statusLabel;
        
        if (homeEtaTime) homeEtaTime.textContent = '-- min';
        if (homeEtaDist) homeEtaDist.textContent = '-- km';
        if (homeStatusText && statusLabel) homeStatusText.textContent = statusLabel;
    }
}

async function updateLiveTracking() {
    console.log("[DEBUG-TRACKING] updateLiveTracking polling tick initiated.");
    if (!isAppActive) return;
    if (!currentUser) return;
    try {
        const allTrips = await apiGet('/trips');
        const myTrips = allTrips.filter(t => (t.customerId || t.customerid) === currentUser.id && ['assigned', 'pending_otp_1', 'in_transit', 'out_for_delivery', 'pending_delivery', 'at_garage', 'in_service'].includes(t.status));
        
        if (myTrips.length === 0 && window._prevActiveTripId) {
            const completedTrip = allTrips.find(t => t.id === window._prevActiveTripId);
            if (completedTrip && completedTrip.status === 'completed') {
                window.openRatingModal(window._prevActiveTripId, window._prevActiveTripMarshalName || 'Mike Marshal');
            }
            window._prevActiveTripId = null;
            window._prevActiveTripMarshalName = null;

            const enRouteScreen = document.getElementById('marshal-en-route-screen');
            if (enRouteScreen) enRouteScreen.style.display = 'none';
            const dash = document.getElementById('dashboard');
            if (dash) dash.style.display = 'block';
            if (typeof loadDashboard === 'function') loadDashboard();
        }

        if (myTrips.length > 0) {
            const activeTrip = myTrips[0];
            console.log("[DEBUG-TRACKING] updateLiveTracking: Found active trip:", activeTrip.id, "Status:", activeTrip.status);
            updateOtpCardDisplay(activeTrip);
            window._prevActiveTripId = activeTrip.id;
            window._prevActiveTripMarshalName = activeTrip.marshalName || 'Mike Marshal';
            // PostgreSQL lowercases camelCase: marshalLat → marshallat
            const marshalLat = activeTrip.marshalLat || activeTrip.marshallat;
            const marshalLng = activeTrip.marshalLng || activeTrip.marshallng;
            
            // Determine target coordinates based on trip status
            const status = activeTrip.status;
            let targetLat, targetLng, etaLabel;
            const tripReq = userRequests ? userRequests.find(r => r.id === (activeTrip.serviceRequestId || activeTrip.servicerequestid)) : null;

            let pickupLat = 19.0760;
            let pickupLng = 72.8777;
            let dropLat, dropLng;
            if (tripReq) {
                if (tripReq.lat || tripReq.pickuplat || tripReq.pickup_lat) { pickupLat = parseFloat(tripReq.lat || tripReq.pickuplat || tripReq.pickup_lat); }
                if (tripReq.lng || tripReq.pickuplng || tripReq.pickup_lng) { pickupLng = parseFloat(tripReq.lng || tripReq.pickuplng || tripReq.pickup_lng); }
                if (tripReq.droplat || tripReq.drop_lat) { dropLat = parseFloat(tripReq.droplat || tripReq.drop_lat); }
                if (tripReq.droplng || tripReq.drop_lng) { dropLng = parseFloat(tripReq.droplng || tripReq.drop_lng); }
            } else if (customerMarker) {
                pickupLat = customerMarker.getPosition().lat();
                pickupLng = customerMarker.getPosition().lng();
            } else {
                const locInput = document.getElementById('pickup-location-global');
                const dataLat = locInput ? locInput.getAttribute('data-lat') : null;
                const dataLng = locInput ? locInput.getAttribute('data-lng') : null;
                if (dataLat && dataLng) { pickupLat = parseFloat(dataLat); pickupLng = parseFloat(dataLng); }
            }

            if (['pending_otp_1'].includes(status)) {
                targetLat = pickupLat; targetLng = pickupLng;
                etaLabel = 'To Pickup';
            } else if (['in_transit', 'at_garage', 'in_service'].includes(status)) {
                targetLat = dropLat || pickupLat; targetLng = dropLng || pickupLng;
                etaLabel = 'To Garage';
            } else if (['out_for_delivery', 'pending_delivery'].includes(status)) {
                targetLat = pickupLat; targetLng = pickupLng;
                etaLabel = status === 'out_for_delivery' ? 'To Delivery' : 'Arriving Soon';
            } else {
                targetLat = pickupLat; targetLng = pickupLng;
                etaLabel = 'En Route';
            }

            // Update ETA Banner
            updateEtaBanner(marshalLat, marshalLng, targetLat, targetLng, etaLabel);

            // Handle enRouteCustomerMarker
            const enRouteScreen = document.getElementById('marshal-en-route-screen');
            if (enRouteScreen && enRouteScreen.style.display !== 'none' && enRouteMap) {
                const customerIcon = createGoogleIcon('#38bdf8');
                if (!enRouteCustomerMarker) {
                    enRouteCustomerMarker = new google.maps.Marker({ position: {lat: parseFloat(targetLat || pickupLat), lng: parseFloat(targetLng || pickupLng)}, map: enRouteMap, icon: customerIcon });
                } else {
                    enRouteCustomerMarker.setPosition({lat: parseFloat(targetLat || pickupLat), lng: parseFloat(targetLng || pickupLng)});
                }
            }

            if (marshalLat && marshalLng) {
                const lat = parseFloat(marshalLat);
                const lng = parseFloat(marshalLng);
                const marshalIcon = create3DVehicleIcon();
                
                if (customerMap) {
                    if (!marshalMarker) {
                        marshalMarker = new google.maps.Marker({ position: {lat, lng}, map: customerMap, icon: marshalIcon });
                        marshalMarker._prevLatLng = [lat, lng];
                        if (customerMarker) {
                            const bounds = new google.maps.LatLngBounds(); bounds.extend(customerMarker.getPosition()); bounds.extend({lat, lng}); customerMap.fitBounds(bounds, 50);
                        } else {
                            customerMap.setCenter({lat, lng}); customerMap.setZoom(15);
                        }
                    } else {
                        let prevLat, prevLng;
                        if (marshalMarker._prevLatLng) {
                            prevLat = marshalMarker._prevLatLng[0];
                            prevLng = marshalMarker._prevLatLng[1];
                        } else {
                            const pos = marshalMarker.getPosition();
                            prevLat = pos ? pos.lat() : lat;
                            prevLng = pos ? pos.lng() : lng;
                        }
                        if (prevLat !== lat || prevLng !== lng) {
                            animateMarkerSmoothly(marshalMarker, prevLat, prevLng, lat, lng, 4800);
                            marshalMarker._prevLatLng = [lat, lng];
                        }
                    }
                }

                if (enRouteScreen && enRouteScreen.style.display !== 'none' && enRouteMap) {
                    if (!enRouteMarshalMarker) {
                        enRouteMarshalMarker = new google.maps.Marker({ position: {lat, lng}, map: enRouteMap, icon: marshalIcon });
                        enRouteMarshalMarker._prevLatLng = [lat, lng];
                    } else {
                        let prevLat, prevLng;
                        if (enRouteMarshalMarker._prevLatLng) {
                            prevLat = enRouteMarshalMarker._prevLatLng[0];
                            prevLng = enRouteMarshalMarker._prevLatLng[1];
                        } else {
                            const pos = enRouteMarshalMarker.getPosition();
                            prevLat = pos ? pos.lat() : lat;
                            prevLng = pos ? pos.lng() : lng;
                        }
                        if (prevLat !== lat || prevLng !== lng) {
                            animateMarkerSmoothly(enRouteMarshalMarker, prevLat, prevLng, lat, lng, 4800);
                            enRouteMarshalMarker._prevLatLng = [lat, lng];
                        }
                    }

                    // Draw live route
                    try {
                        if (window.enRouteDirectionsRenderer) {
                            window.enRouteDirectionsRenderer.setMap(null);
                        }
                        window.enRouteDirectionsRenderer = new google.maps.DirectionsRenderer({ map: enRouteMap, suppressMarkers: true });
                        const directionsService = new google.maps.DirectionsService();
                        directionsService.route({
                            origin: { lat, lng },
                            destination: { lat: targetLat || pickupLat, lng: targetLng || pickupLng },
                            travelMode: google.maps.TravelMode.DRIVING
                        }, (response, status) => {
                            console.log("[DEBUG-TRACKING] enRouteMap Directions route status:", status);
                            if (status === 'OK') {
                                window.enRouteDirectionsRenderer.setDirections(response);
                            }
                        });
                    } catch (err) {
                        console.error('Error drawing enRouteRoute:', err);
                    }

                    try {
                        const bounds = new google.maps.LatLngBounds();
                        bounds.extend({lat: parseFloat(targetLat || pickupLat), lng: parseFloat(targetLng || pickupLng)});
                        bounds.extend({lat, lng});
                        enRouteMap.fitBounds(bounds, {padding: [40, 40]});
                    } catch (err) {}
                }
            } else {
                // If marshal GPS location is not available yet, center on target location
                if (customerMap) {
                    customerMap.setCenter({ lat: parseFloat(targetLat || pickupLat), lng: parseFloat(targetLng || pickupLng) });
                    customerMap.setZoom(15);
                }
                if (enRouteScreen && enRouteScreen.style.display !== 'none' && enRouteMap) {
                    enRouteMap.setCenter({ lat: parseFloat(targetLat || pickupLat), lng: parseFloat(targetLng || pickupLng) });
                    enRouteMap.setZoom(15);
                }
                // Clear marshal markers if any (stale)
                if (marshalMarker) { marshalMarker.setMap(null); marshalMarker = null; }
                if (enRouteMarshalMarker) { enRouteMarshalMarker.setMap(null); enRouteMarshalMarker = null; }
                if (window.enRouteDirectionsRenderer) { window.enRouteDirectionsRenderer.setMap(null); window.enRouteDirectionsRenderer = null; }
            }
        } else {
            if (marshalMarker && customerMap) {
                if (marshalMarker) marshalMarker.setMap(null);
                marshalMarker = null;
            }
            if (enRouteMarshalMarker && enRouteMap) {
                if (enRouteMarshalMarker) enRouteMarshalMarker.setMap(null);
                enRouteMarshalMarker = null;
            }
            if (enRouteCustomerMarker && enRouteMap) {
                if (enRouteCustomerMarker) enRouteCustomerMarker.setMap(null);
                enRouteCustomerMarker = null;
            }
            if (window.enRouteRouteControl && enRouteMap) {
                try {
                    window.enRouteRouteControl = null;
                } catch(e) {}
                window.enRouteRouteControl = null;
            }
        }
    } catch (e) {
        console.error('[DEBUG-TRACKING] LIVE TRACKING ERROR:', e);
    }
}

function startLiveTracking() {
    console.log("[DEBUG-TRACKING] startLiveTracking loop configured.");
    clearNearbyMarshalMarkers();
    if (liveTrackingInterval) clearInterval(liveTrackingInterval);
    updateLiveTracking();
    liveTrackingInterval = setInterval(updateLiveTracking, 15000);
}

if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    window.Capacitor.Plugins.App.addListener('appStateChange', (state) => {
        console.log('[DEBUG-TRACKING] App state changed. isActive:', state.isActive);
        isAppActive = state.isActive;
        if (isAppActive) {
            startLiveTracking();
        } else {
            if (liveTrackingInterval) {
                clearInterval(liveTrackingInterval);
                liveTrackingInterval = null;
            }
        }
    });
}

// --- Dashboard ---
async function loadDashboard() {
    if (!currentUser) return;
    
    initCustomerMap();

    try {
        // Load Vehicles — list endpoint may omit large fields like photo
        const allVehicles = await apiGet('/vehicles');
        const myVehiclesBasic = allVehicles.filter(v => (v.customerId || v.customerid) === currentUser.id);
        // Fetch full vehicle records individually to recover the photo field
        userVehicles = await Promise.all(myVehiclesBasic.map(async (v) => {
            try {
                const full = await apiGet(`/vehicles/${v.id}`);
                return full || v;
            } catch (e) {
                return v; // fallback to basic record if individual fetch fails
            }
        }));
        renderVehicles();
        if (typeof renderProfileVehicles === 'function') renderProfileVehicles();

        // Load Requests
        const allRequests = await apiGet('/requests');
        const myRequests = allRequests.filter(r => (r.customerId || r.customerid) === currentUser.id);
        userRequests = myRequests;
        renderRequests(myRequests.filter(r => !['pending', 'scheduled', 'completed', 'cancelled', 'returned', 'drop_completed', 'marshal_assigned'].includes(r.status)));

        // Track active booked vehicles (Exclude pending/scheduled as they are not accepted by marshal yet)
        const activeRequests = myRequests.filter(r => !['pending', 'scheduled', 'completed', 'cancelled', 'returned', 'drop_completed'].includes(r.status));
        activeBookedVehicleIds = activeRequests.map(r => r.vehicleId || r.vehicleid);
        renderVehicles(); // Re-render to show disabled state for active vehicles
        if (typeof renderProfileVehicles === 'function') renderProfileVehicles();

        // Load Trips (Handovers)
        const allTrips = await apiGet('/trips');
        // A trip belongs to a user if its serviceRequestId is in myRequests
        const myTrips = allTrips.filter(t => myRequests.some(r => r.id === (t.serviceRequestId || t.servicerequestid)));
        window._myTrips = myTrips;
        


        renderTrips(myTrips);
        renderHistory(myTrips);

        // Load Approvals
        const pendingApprovals = myTrips.filter(t => t.status === 'pending_approval');
        if (pendingApprovals.length > 0) {
            const approvalsWithData = await Promise.all(pendingApprovals.map(async (t) => {
                try {
                    const audit = await apiGet(`/trips/${t.id}/audit`);
                    return { trip: t, audit };
                } catch (e) { return null; }
            }));
            renderApprovals(approvalsWithData.filter(Boolean));
        } else {
            document.getElementById('approval-section').style.display = 'none';
        }

        // Load Pending Inspections
        const pendingInspections = myRequests.filter(r => r.status === 'pending_inspection_approval');
        if (pendingInspections.length > 0) {
            renderInspectionApprovals(pendingInspections);
        } else {
            const section = document.getElementById('inspection-approval-section');
            if (section) section.style.display = 'none';
        }

        // Auto-show Marshal En Route screen if there is an active trip
        const activeTrip = myTrips.find(t => ['assigned', 'pending_otp_1', 'in_transit', 'at_garage', 'in_service', 'pending_delivery', 'pending_approval', 'out_for_delivery'].includes(t.status));
        window._activeTrip = activeTrip || null;

        // Resume payment modal if request is marshal_assigned and trip is pending_payment
        const pendingPaymentRequest = myRequests.find(r => r.status === 'marshal_assigned');
        if (pendingPaymentRequest) {
            const correspondingTrip = myTrips.find(t => (t.serviceRequestId || t.servicerequestid) === pendingPaymentRequest.id && t.status === 'pending_payment');
            if (correspondingTrip) {
                window.currentActiveTripId = correspondingTrip.id;
                window.currentPendingRequestId = pendingPaymentRequest.id;
                
                await selectRandomMarshal(pendingPaymentRequest.workerId || pendingPaymentRequest.workerid);
                
                const payTextEl = document.getElementById('payment-btn-text');
                const price = pendingPaymentRequest.totalcustomerprice || pendingPaymentRequest.totalCustomerPrice;
                if (payTextEl && price) {
                    payTextEl.textContent = `PAY ₹${Math.round(price)} & CONFIRM`;
                }
                
                if (typeof window.startPaymentCountdown === 'function') {
                    window.startPaymentCountdown(correspondingTrip.id);
                }
                
                const paymentModal = document.getElementById('payment-modal');
                if (paymentModal) paymentModal.style.display = 'flex';
            }
        }

        // Remove any old inline active card
        const oldCard = document.getElementById('home-active-order-card');
        if (oldCard) oldCard.remove();

        // Populate active trips lookup by vehicle ID
        window._activeTripsByVehicle = {};
        myTrips.forEach(t => {
            if (['assigned', 'pending_otp_1', 'in_transit', 'at_garage', 'in_service', 'pending_delivery', 'pending_approval', 'out_for_delivery'].includes(t.status)) {
                const req = myRequests.find(r => r.id === (t.serviceRequestId || t.servicerequestid));
                if (req) {
                    const vId = req.vehicleId || req.vehicleid;
                    if (vId) {
                        window._activeTripsByVehicle[vId] = t;
                    }
                }
            }
        });

        // Ensure normal home screen elements are always displayed
        const locContainer = document.querySelector('.location-select-container');
        const garageSection = document.getElementById('garage-container');
        if (locContainer) locContainer.style.display = '';
        if (garageSection) garageSection.style.display = '';
        if (window.homeTrackMap) { window.homeTrackMap = null; }

        // Auto-show full tracking overlay on startup if not minimized
        if (activeTrip && sessionStorage.getItem('minimizeEnRoute') !== 'true') {
            showMarshalEnRoute(activeTrip);
        }

        startLiveTracking();
        updateBookingTabVisibility();


    } catch (err) {
        console.error("Dashboard load failed:", err);
        console.log('[DEBUG-TRACKING] Dashboard load error details:', err);
        if (typeof showToast === 'function') {
            showToast("Dashboard load error: " + err.message, "error");
        }
    }
}

function getTimelineStatusHtml(status, flow = 'p2p') {
    const isDriver = flow === 'p2p' || flow === 'garage_driver';
    
    let steps = [];
    let activeIdx = 0;
    
    if (isDriver) {
        steps = [
            { key: 'ordered', label: 'Ordered', desc: 'Request received' },
            { key: 'assigned', label: 'Assigned', desc: 'Driver confirmed' },
            { key: 'arriving', label: 'Arriving', desc: 'Driver picking up' },
            { key: 'in_transit', label: 'In Transit', desc: 'Heading to Drop Location' },
            { key: 'completed', label: 'Completed', desc: 'Vehicle delivered' }
        ];
        
        if (status === 'waiting_for_marshal' || status === 'scheduled') activeIdx = 0;
        else if (status === 'marshal_assigned' || status === 'assigned') activeIdx = 1;
        else if (status === 'pending_otp_1' || status === 'arriving') activeIdx = 2;
        else if (['in_transit', 'pending_delivery', 'pending_approval', 'at_garage', 'in_service'].includes(status)) activeIdx = 3;
        else if (status === 'completed' || status === 'drop_completed' || status === 'returned') activeIdx = 4;
    } else {
        steps = [
            { key: 'ordered', label: 'Ordered', desc: 'Request received' },
            { key: 'assigned', label: 'Assigned', desc: 'Driver confirmed' },
            { key: 'arriving', label: 'Arriving', desc: 'Driver picking up' },
            { key: 'in_transit', label: 'In Transit', desc: 'Heading to garage' },
            { key: 'on_spanner', label: 'On Spanner', desc: 'Service in progress' },
            { key: 'completed', label: 'Completed', desc: 'Vehicle returned' }
        ];
        
        if (status === 'waiting_for_marshal' || status === 'scheduled') activeIdx = 0;
        else if (status === 'marshal_assigned' || status === 'assigned') activeIdx = 1;
        else if (status === 'pending_otp_1' || status === 'arriving') activeIdx = 2;
        else if (status === 'in_transit') activeIdx = 3;
        else if (['at_garage', 'in_service', 'pending_delivery', 'pending_approval'].includes(status)) activeIdx = 4;
        else if (status === 'completed' || status === 'drop_completed' || status === 'returned') activeIdx = 5;
    }
    
    return `
    <div class="vertical-timeline" style="display: flex; flex-direction: column; gap: 16px; padding: 4px 0;">
        ${steps.map((step, idx) => {
            const isDone = idx < activeIdx;
            const isActive = idx === activeIdx;
            
            let bulletColor = 'rgba(255,255,255,0.1)';
            let bulletBorder = '1.5px solid rgba(255,255,255,0.15)';
            let titleColor = 'var(--text-muted)';
            let descColor = '#555';
            let pulseHtml = '';
            
            if (isDone) {
                bulletColor = 'var(--primary)';
                bulletBorder = '1.5px solid var(--primary)';
                titleColor = '#fff';
                descColor = 'var(--text-muted)';
            } else if (isActive) {
                bulletColor = 'var(--primary)';
                bulletBorder = '1.5px solid var(--primary)';
                titleColor = 'var(--primary)';
                descColor = '#eee';
                pulseHtml = `<div style="position: absolute; width: 22px; height: 22px; border: 1.5px solid var(--primary); border-radius: 50%; animation: pulse 2s infinite ease-in-out; opacity: 0.5;"></div>`;
            }
            
            return `
            <div style="display: flex; gap: 14px; position: relative;">
                <!-- Timeline Line -->
                ${idx < steps.length - 1 ? `
                    <div style="position: absolute; left: 8px; top: 18px; bottom: -28px; width: 2px; background: ${idx < activeIdx ? 'var(--primary)' : 'rgba(255,255,255,0.06)'}; z-index: 1;"></div>
                ` : ''}
                
                <!-- Bullet -->
                <div style="width: 18px; height: 18px; border-radius: 50%; background: ${bulletColor}; border: ${bulletBorder}; display: flex; align-items: center; justify-content: center; z-index: 2; position: relative; margin-top: 3px; flex-shrink: 0;">
                    ${pulseHtml}
                    ${isDone ? `
                        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    ` : isActive ? `
                        <div style="width: 5px; height: 5px; border-radius: 50%; background: #000;"></div>
                    ` : ''}
                </div>
                
                <!-- Content -->
                <div style="display: flex; flex-direction: column; gap: 1px;">
                    <span style="font-size: 0.85rem; font-weight: 700; color: ${titleColor};">${step.label}</span>
                    <span style="font-size: 0.68rem; color: ${descColor}; font-weight: 500;">${step.desc}</span>
                </div>
            </div>
            `;
        }).join('')}
    </div>
    `;
}

function updateOtpCardDisplay(trip) {
    if (!trip) return;
    const otpCard = document.getElementById('enroute-otp-card');
    const otpLabel = document.getElementById('enroute-otp-label');
    const otpEl = document.getElementById('enroute-otp');
    
    // PostgreSQL lowercases all column names — use fallbacks for both casings
    const otp1Val = trip.otp1 || trip.otp_1;
    const deliveryOtpVal = trip.deliveryOtp || trip.deliveryotp || trip.delivery_otp;
    if (trip.status === 'assigned' || trip.status === 'pending_otp_1') {
        if (otpCard) otpCard.style.display = 'flex';
        if (otpLabel) otpLabel.textContent = 'Pickup OTP';
        if (otpEl) otpEl.textContent = otp1Val || '----';
    } else if (trip.status === 'pending_delivery') {
        if (otpCard) otpCard.style.display = 'flex';
        if (otpLabel) otpLabel.textContent = 'Delivery OTP';
        if (otpEl) otpEl.textContent = deliveryOtpVal || '----';
    } else if (['in_transit', 'at_garage', 'in_service', 'out_for_delivery'].includes(trip.status)) {
        if (otpCard) otpCard.style.display = 'none';
    } else {
        if (otpCard) otpCard.style.display = 'none';
    }
}

function initEnRouteMap(mapLat, mapLng, attempts = 0) {
    if (enRouteMap) return;
    if (typeof google === 'undefined' || !google.maps) {
        if (attempts < 50) {
            setTimeout(() => initEnRouteMap(mapLat, mapLng, attempts + 1), 100);
        } else {
            console.error('Google Maps SDK failed to load for enRouteMap.');
        }
        return;
    }
    try {
        enRouteMap = new google.maps.Map(document.getElementById('enroute-map'), { 
            center: { lat: mapLat, lng: mapLng }, 
            zoom: 15, 
            disableDefaultUI: true, 
            styles: lightMapStyle 
        });
    } catch (err) {
        console.error('Error loading enRouteMap:', err);
    }
}

function showMarshalEnRoute(trip) {
    const enRouteScreen = document.getElementById('marshal-en-route-screen');
    const dash = document.getElementById('dashboard');
    if (!enRouteScreen) return;
    
    try {
        enRouteScreen.style.display = 'flex';
        // Join the socket room for live tracking
        if (window.socket && trip && trip.id) {
            window.socket.emit('joinTripRoom', trip.id);
        }

        // Hide dashboard
        if (dash) dash.style.display = 'none';
        
        // Find associated request
        const req = userRequests.find(r => r.id === (trip.serviceRequestId || trip.servicerequestid));
        const pickupAddr = req ? (req.pickup_address || req.pickupAddress || 'Pickup Point') : 'Pickup Point';
        const dropAddr = req ? (req.drop_address || req.dropAddress || 'Drop Point') : 'Drop Point';
        
        const pAddrEl = document.getElementById('enroute-pickup-addr');
        const dAddrEl = document.getElementById('enroute-drop-addr');
        if (pAddrEl) pAddrEl.textContent = pickupAddr;
        if (dAddrEl) dAddrEl.textContent = dropAddr;

        const weatherLat = req ? (req.pickuplat || req.lat || trip.lat) : 19.0760;
        const weatherLng = req ? (req.pickuplng || req.lng || trip.lng) : 72.8777;
        if (typeof checkWeatherDelay === 'function') {
            checkWeatherDelay(weatherLat, weatherLng);
        }

        // Render intermediate stops if any
        const stopsCard = document.getElementById('enroute-stops-card');
        const stopsList = document.getElementById('enroute-stops-list');
        if (stopsCard && stopsList) {
            let stops = [];
            try {
                if (req && req.route_stops) {
                    stops = typeof req.route_stops === 'string' ? JSON.parse(req.route_stops) : req.route_stops;
                }
            } catch (e) {
                console.warn("Failed to parse route_stops in customer active view:", e);
            }

            if (Array.isArray(stops) && stops.length > 0) {
                stopsCard.style.display = 'flex';
                stopsList.innerHTML = stops.map((stop, idx) => {
                    const isHalt = (parseInt(stop.haltTime) || 0) > 0;
                    const verifiedBadge = stop.otpVerified 
                        ? `<span style="font-size: 0.65rem; color: #22c55e; background: rgba(34, 197, 94, 0.15); border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 4px; padding: 1px 6px; font-weight: 700;">Verified</span>`
                        : (isHalt 
                            ? `<span style="font-size: 0.65rem; color: #facc15; background: rgba(250, 204, 21, 0.15); border: 1px solid rgba(250, 204, 21, 0.3); border-radius: 4px; padding: 1px 6px; font-weight: 700;">OTP: ${stop.otp}</span>`
                            : `<span style="font-size: 0.65rem; color: #38bdf8; background: rgba(56, 189, 248, 0.15); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 4px; padding: 1px 6px; font-weight: 700;">Passing</span>`);

                    const display = (stop.address && stop.address.split(',')[0]) || stop.address || 'Stop';
                    const titleText = isHalt ? `${display} (Halt: ${stop.haltTime} min)` : display;

                    let timerHtml = '';
                    if (isHalt && stop.haltStartedAt && !stop.otpVerified) {
                        timerHtml = `
                            <div style="font-size: 0.72rem; color: #a1a1aa; margin-top: 6px; display: flex; align-items: center; justify-content: space-between; width: 100%; border-top: 1px dashed rgba(255,255,255,0.05); padding-top: 6px;">
                                <span>Halt Time Left:</span>
                                <span class="cust-halt-countdown-timer" data-started="${stop.haltStartedAt}" data-duration="${stop.haltTime}" style="color: #facc15; font-weight: 800; font-family: monospace;">Calculating...</span>
                            </div>
                        `;
                    } else if (isHalt && stop.otpVerified && stop.actualHaltMins !== undefined) {
                        timerHtml = `
                            <div style="font-size: 0.72rem; color: #a1a1aa; margin-top: 6px; display: flex; align-items: center; justify-content: space-between; width: 100%; border-top: 1px dashed rgba(255,255,255,0.05); padding-top: 6px;">
                                <span>Actual Halt: <strong style="color: #fff;">${stop.actualHaltMins} mins</strong></span>
                                <span>Halt Cost: <strong style="color: #22c55e;">₹${stop.finalHaltCost || 0}</strong></span>
                            </div>
                        `;
                    }

                    return `
                        <div style="display: flex; flex-direction: column; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 10px 14px; gap: 4px;">
                            <div style="display: flex; align-items: center; justify-content: justify-content: space-between; width: 100%;">
                                <div style="display: flex; align-items: center; gap: 8px; flex: 1; overflow: hidden;">
                                    <span style="display: flex; align-items: center; justify-content: center; width: 18px; height: 18px; background: #facc15; border-radius: 50%; color: #000; font-size: 0.68rem; font-weight: 800;">${idx + 1}</span>
                                    <span style="color: #fff; font-size: 0.8rem; font-weight: 600; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${titleText}</span>
                                </div>
                                ${verifiedBadge}
                            </div>
                            ${timerHtml}
                        </div>
                    `;
                }).join('');
            } else {
                stopsCard.style.display = 'none';
            }
        }

        // Handle OTP display based on status
        updateOtpCardDisplay(trip);
        
        // Populate details
        const mName = trip.marshalName || trip.marshalname || 'Assigning...';
        const mPhoto = trip.marshalPhoto || trip.marshalphoto || null;
        const mPhone = trip.marshalPhone || trip.marshalphone || '';

        const nameEl = document.getElementById('enroute-marshal-name');
        if (nameEl) nameEl.textContent = mName;
        
        // Retrieve flow details
        const flow = trip.bookingFlow || trip.booking_flow || (req ? req.booking_flow || req.bookingFlow : '') || 'p2p';
        const isDriver = flow === 'p2p' || flow === 'garage_driver';

        const vehicleEl = document.getElementById('enroute-marshal-vehicle');
        if (vehicleEl) {
            let vehicleLabel = '';
            if (isDriver) {
                vehicleLabel = `<span class="material-symbols-outlined" style="font-size: 14px; vertical-align: middle; margin-right: 4px; color: var(--primary);">directions_car</span> Assigned Driver`;
            } else {
                vehicleLabel = `<span class="material-symbols-outlined" style="font-size: 14px; vertical-align: middle; margin-right: 4px; color: var(--primary);">local_shipping</span> Assigned Marshal`;
            }
            vehicleEl.innerHTML = vehicleLabel;
        }
        
        const photoEl = document.getElementById('enroute-marshal-photo');
        if (photoEl) {
            const host = API_URL.substring(0, API_URL.lastIndexOf('/api'));
            const photoUrl = mPhoto 
                ? (mPhoto.startsWith('http') ? mPhoto : `${host}/${mPhoto}`)
                : getInitialsAvatar(mName);
            photoEl.src = photoUrl;
        }
        
        const contactBtn = document.getElementById('enroute-contact-btn');
        if (contactBtn) {
            const labelText = 'CALL DRIVER';
            contactBtn.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                ${labelText}
            `;
            contactBtn.onclick = () => {
                const targetRole = 'Driver';
                if (!mPhone) {
                    showToast(`${targetRole} contact details unavailable`, 'warning');
                    return;
                }
                showToast(`Calling ${targetRole}: ${mPhone}`, 'info');
                window.open(`tel:${mPhone}`, '_system');
            };
        }

        // Update OTP subtext instruction dynamically
        const otpSubtext = document.querySelector('#enroute-otp-card div div');
        if (otpSubtext) {
            const targetRole = 'Driver';
            otpSubtext.textContent = `Provide this to the ${targetRole} for verification`;
        }
        
        // Render Vertical Timeline
        const timelineContainer = document.getElementById('enroute-timeline-container');
        if (timelineContainer) {
            timelineContainer.innerHTML = getTimelineStatusHtml(trip.status, flow);
        }
        
        enRouteScreen.style.display = 'flex';
        
        // Initialize Map Tracking
        let mapLat = 19.0760;
        let mapLng = 72.8777;
        // PostgreSQL lowercases camelCase columns: marshalLat → marshallat
        const mLat = trip.marshalLat || trip.marshallat;
        const mLng = trip.marshalLng || trip.marshallng;
        if (mLat && mLng) {
            mapLat = parseFloat(mLat);
            mapLng = parseFloat(mLng);
        } else if (req && (req.pickuplat || req.lat)) {
            mapLat = parseFloat(req.pickuplat || req.lat);
            mapLng = parseFloat(req.pickuplng || req.lng);
        }
        
        setTimeout(() => {
            if (!enRouteMap) {
                initEnRouteMap(mapLat, mapLng);
            } else {
                google.maps.event.trigger(enRouteMap, 'resize');
                enRouteMap.setCenter({lat: mapLat, lng: mapLng}); 
                enRouteMap.setZoom(15);
            }
            
            // Force refresh markers immediately
            startLiveTracking();
        }, 100);
    } catch (e) {
        console.error("[DEBUG-TRACKING] Error in showMarshalEnRoute:", e);
        if (typeof showToast === 'function') {
            showToast("Tracking display error: " + e.message, "error");
        }
    }
}

function checkWeatherDelay(lat, lng) {
    const banner = document.getElementById('enroute-weather-delay-banner');
    const delayText = document.getElementById('enroute-weather-delay-text');
    const statusLabel = document.getElementById('enroute-status-label');
    if (!banner || !delayText) return;

    if (window.SIMULATE_RAIN) {
        banner.style.display = 'flex';
        delayText.textContent = "It is Patchy rain nearby near your pickup location. The Driver may arrive slightly later to ensure safety.";
        if (statusLabel) {
            statusLabel.textContent = "Delayed due to weather";
            statusLabel.style.color = '#facc15';
        }
        return;
    }

    apiGet(`/weather?lat=${lat}&lng=${lng}`)
        .then(res => {
            if (res && res.isDelayed) {
                banner.style.display = 'flex';
                delayText.textContent = `It is ${res.conditionText || 'raining'} near your pickup location. The Driver may arrive slightly later to ensure safety.`;
                if (statusLabel) {
                    statusLabel.textContent = "Delayed due to weather";
                    statusLabel.style.color = '#facc15';
                }
            } else {
                banner.style.display = 'none';
                if (statusLabel) {
                    statusLabel.textContent = "En Route";
                    statusLabel.style.color = '#22c55e';
                }
            }
        })
        .catch(err => {
            console.warn("Failed to check weather delay status:", err);
            banner.style.display = 'none';
        });
}

function renderVehicles() {
    const list = document.getElementById('vehicles-list');
    const select = document.getElementById('booking-vehicle');
    const formElements = document.getElementById('vehicle-form-elements');
    const addMoreContainer = document.getElementById('add-more-container');
    const garageContainer = document.getElementById('garage-container');
    const placeholderCard = document.getElementById('location-placeholder-card');

    if (userVehicles.length === 0) {
        if (list) {
            list.innerHTML = `
                <div style="background: rgba(18, 22, 29, 0.85); backdrop-filter: blur(20px); border-radius: 16px; padding: 24px; text-align: center; border: 1px dashed rgba(255, 255, 255, 0.15);">
                    <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 12px;">You haven't added any vehicles yet.</p>
                    <button onclick="showVehicleForm()" class="btn" style="background: rgba(255, 255, 255, 0.1); color: #fff; border: 1px solid rgba(255, 255, 255, 0.2); padding: 8px 16px; border-radius: 8px; font-size: 0.8rem; font-weight: 600;">Add Your First Vehicle</button>
                </div>
            `;
        }
        if (select) select.innerHTML = '<option value="">No vehicles available</option>';
        if (garageContainer) garageContainer.style.display = 'block';
        if (addMoreContainer) addMoreContainer.style.display = 'block';
        if (formElements) formElements.style.display = 'none';
        return;
    }

    // Always show garage container
    if (placeholderCard) placeholderCard.style.display = 'none';
    if (garageContainer) {
        garageContainer.style.display = 'block';
        garageContainer.style.opacity = '1';
        garageContainer.style.transform = 'translateY(0)';
    }
    if (addMoreContainer) addMoreContainer.style.display = 'block';
    if (formElements) formElements.style.display = 'none';

    // Clamp active index
    if (activeVehicleIndex >= userVehicles.length) {
        activeVehicleIndex = userVehicles.length - 1;
    }
    if (activeVehicleIndex < 0) {
        activeVehicleIndex = 0;
    }

    // Generate cards HTML for all vehicles
    const cardsHtml = userVehicles.map((v, idx) => {
        const fuel = v.fuel || 'Petrol';
        const transmission = v.transmission || 'Manual';
        const type = v.type || 'Hatchback';
        const carColor = v.color || 'White';
        const seats = v.seats || '5';
        // Generate a CSS color value from the color name
        const colorMap = { 'White': '#f1f5f9', 'Black': '#1e293b', 'Silver': '#94a3b8', 'Grey': '#6b7280', 'Red': '#ef4444', 'Blue': '#3b82f6', 'Green': '#22c55e', 'Brown': '#92400e', 'Orange': '#f97316', 'Yellow': '#facc15', 'Purple': '#a855f7', 'Beige': '#d4b896', 'Gold': '#d4af37', 'Maroon': '#7f1d1d', 'Navy': '#1e3a5f' };
        const colorDot = colorMap[carColor] || '#94a3b8';

        let imageSrc = 'images/sedan.png';
        if (v.photo) {
            imageSrc = v.photo;
        } else {
            const lowerType = type.toLowerCase();
            if (lowerType.includes('bike') || lowerType.includes('motorcycle')) {
                imageSrc = 'images/bike.png';
            } else if (lowerType.includes('suv')) {
                imageSrc = 'images/suv.png';
            } else if (lowerType.includes('hatchback')) {
                imageSrc = 'images/hatchback.png';
            } else {
                imageSrc = 'images/sedan.png';
            }
        }

        // actionBtn logic is moved outside the card map

        return `
        <div class="vehicle-slide-card-wrapper" style="flex: 0 0 100%; width: 100%; box-sizing: border-box; padding: 0; scroll-snap-align: start;">
            <div class="vehicle-card" style="display: flex; flex-direction: column; position: relative; overflow: hidden; padding: 24px; width: 100%; margin: 0; box-sizing: border-box; background: linear-gradient(145deg, rgba(39, 39, 42, 0.9) 0%, rgba(18, 18, 22, 0.95) 100%); border: 1px solid rgba(250, 204, 21, 0.15); border-radius: 20px; box-shadow: 0 12px 40px rgba(0,0,0,0.5);">
                
                <!-- Glowing Accent -->
                <div style="position: absolute; top: -50px; right: -50px; width: 150px; height: 150px; background: radial-gradient(circle, rgba(250, 204, 21, 0.12) 0%, transparent 70%); pointer-events: none;"></div>

                <!-- Top Section: Header -->
                <div style="display: flex; justify-content: space-between; align-items: flex-start; z-index: 2; margin-bottom: 12px;">
                    <div class="vehicle-meta-info" style="display: flex; flex-direction: column; gap: 4px;">
                        <span class="vehicle-title" style="font-size: 1.45rem; font-weight: 800; color: #ffffff; letter-spacing: -0.5px; line-height: 1.1; text-shadow: 0 2px 10px rgba(0,0,0,0.5);">${v.make} <br><span style="color: var(--primary); font-size: 1.15rem;">${v.model}</span></span>
                        <div style="display: inline-block; background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.1); padding: 4px 10px; border-radius: 6px; margin-top: 6px; width: fit-content; box-shadow: inset 0 2px 4px rgba(0,0,0,0.3);">
                            <span class="vehicle-plate-badge" style="font-size: 0.85rem; color: #fff; font-weight: 700; letter-spacing: 2px; text-transform: uppercase;">${v.plate}</span>
                        </div>
                    </div>
                    
                    <button onclick="editVehicle('${v.id}')" style="background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.1); width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; cursor: pointer; transition: all 0.2s;" title="Edit Vehicle">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    </button>
                </div>

                <!-- Middle Section: Image Frame (always fits, any aspect ratio) -->
                <div class="vehicle-card-image-wrapper" style="width: 100%; height: 190px; border-radius: 16px; overflow: hidden; background: ${v.photo ? '#0d1017' : 'transparent'}; display: flex; align-items: center; justify-content: center; z-index: 1; margin: 0; position: relative; border: ${v.photo ? '1px solid rgba(255,255,255,0.06)' : 'none'};">
                    ${v.photo ? '' : '<div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 280px; height: 150px; background: radial-gradient(ellipse, rgba(250, 204, 21, 0.2) 0%, transparent 70%); z-index: 0; pointer-events: none;"></div>'}
                    <img src="${imageSrc}" alt="${v.model}" class="vehicle-card-image" style="width: 100%; height: 100%; object-fit: cover; ${v.photo ? '' : 'filter: drop-shadow(0 20px 25px rgba(0,0,0,0.6));'} position: relative; z-index: 1; display: block;">
                </div>

                <!-- Premium 2x2 details grid below the image -->
                <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 14px; z-index: 2; width: 100%; box-sizing: border-box;">
                    <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); padding: 8px 10px; border-radius: 12px; display: flex; flex-direction: column; gap: 3px; min-width: 0;">
                        <span style="font-size: 0.58rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; white-space: nowrap;">Color</span>
                        <span style="font-size: 0.78rem; color: #fff; font-weight: 700; display: flex; align-items: center; gap: 5px; overflow: hidden;">
                            <span style="width: 11px; height: 11px; border-radius: 50%; background: ${colorDot}; display: inline-block; border: 1px solid rgba(255,255,255,0.2); flex-shrink: 0;"></span>
                            <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${carColor}</span>
                        </span>
                    </div>
                    <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); padding: 8px 10px; border-radius: 12px; display: flex; flex-direction: column; gap: 3px; min-width: 0;">
                        <span style="font-size: 0.58rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; white-space: nowrap;">Energy Source</span>
                        <span style="font-size: 0.78rem; color: #fff; font-weight: 700; text-transform: capitalize; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${fuel}</span>
                    </div>
                    <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); padding: 8px 10px; border-radius: 12px; display: flex; flex-direction: column; gap: 3px; min-width: 0;">
                        <span style="font-size: 0.58rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; white-space: nowrap;">Shift Type</span>
                        <span style="font-size: 0.78rem; color: #fff; font-weight: 700; text-transform: capitalize; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${transmission}</span>
                    </div>
                    <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); padding: 8px 10px; border-radius: 12px; display: flex; flex-direction: column; gap: 3px; min-width: 0;">
                        <span style="font-size: 0.58rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; white-space: nowrap;">Seats</span>
                        <span style="font-size: 0.78rem; color: #fff; font-weight: 700; display: flex; align-items: center; gap: 4px;">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#facc15" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
                            <span style="white-space: nowrap;">${seats} Seater</span>
                        </span>
                    </div>
                </div>


            </div>
        </div>
        `;
    }).join('');

    let html = '';
    if (userVehicles.length > 1) {
        const dotsHtml = userVehicles.map((veh, idx) => {
            const isActive = idx === activeVehicleIndex;
            return `<button id="dot-${idx}" onclick="jumpToVehicle(${idx})" style="
                width: 34px;
                height: 34px;
                border-radius: 50%;
                border: 2px solid ${isActive ? '#facc15' : 'rgba(255,255,255,0.2)'};
                background: ${isActive ? '#facc15' : 'rgba(255,255,255,0.07)'};
                color: ${isActive ? '#0b0e14' : 'rgba(255,255,255,0.45)'};
                font-size: 0.8rem;
                font-weight: ${isActive ? '800' : '600'};
                cursor: pointer;
                transition: all 0.25s ease;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
                box-shadow: ${isActive ? '0 4px 14px rgba(250,204,21,0.35)' : 'none'};
                padding: 0;
                line-height: 1;
            ">${idx + 1}</button>`;
        }).join('');

        html = `
        <div style="width: 100%; position: relative;">
            <div id="vehicle-slide-container" style="display: flex; overflow-x: auto; scroll-snap-type: x mandatory; scroll-behavior: smooth; width: 100%; border-radius: 20px; padding-bottom: 4px; -webkit-overflow-scrolling: touch;" onscroll="handleVehicleScroll(this)" class="no-scrollbar">
                ${cardsHtml}
            </div>
            <div id="vehicle-slide-dots" style="display: flex; justify-content: center; align-items: center; gap: 10px; margin-top: 14px; margin-bottom: 2px;">
                ${dotsHtml}
            </div>
        </div>
        `;
    } else {
        html = cardsHtml;
    }

    // Append wrapped views and action container
    list.innerHTML = `
    <div id="step2-vehicle-details" style="display: ${window.bookingSubView === '2A' ? 'block' : 'none'}; width: 100%;">
        ${html}
    </div>
    <div id="step2-service-config" style="display: ${window.bookingSubView === '2B' ? 'flex' : 'none'}; flex-direction: column; gap: 14px; width: 100%;">
        <button type="button" onclick="window.goToBookingSubView('2A')" style="align-self: flex-start; background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.1); color: #fff; padding: 8px 14px; border-radius: 10px; font-size: 0.78rem; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 6px; transition: all 0.2s; outline: none; margin-bottom: 2px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
            Change Vehicle
        </button>
        <div id="booking-options-inline-panel" style="width: 100%; display: none; background: rgba(18, 22, 29, 0.85); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; padding: 16px; box-sizing: border-box; flex-direction: column; gap: 14px; position: relative; z-index: 20;"></div>
    </div>
    <div id="fixed-action-btn-container" style="width: 100%; margin-top: 16px; z-index: 20; position: relative;"></div>
    `;

    // Immediately render the button for the active vehicle
    updateFixedActionButton();

    // Immediate innerHTML was already set above, no need to overwrite it

    // Dropdown for booking
    if (select) {
        select.innerHTML = `<option value="">Select a vehicle...</option>` + userVehicles.map(v => {
            if (activeBookedVehicleIds.includes(v.id)) return '';
            return `<option value="${v.id}">${v.make} ${v.model} (${v.plate})</option>`;
        }).join('');
    }
}

// Flag to suppress scroll events during programmatic scrolls
let _isProgrammaticScroll = false;

window.jumpToVehicle = function(idx) {
    if (idx < 0 || idx >= userVehicles.length) return;
    activeVehicleIndex = idx;
    _isProgrammaticScroll = true;
    slideVehicleToActive();
    // Clear the flag after animation completes (~450ms)
    setTimeout(() => { _isProgrammaticScroll = false; }, 500);
};

function slideVehicleToActive() {
    const slideContainer = document.getElementById('vehicle-slide-container');
    if (slideContainer) {
        const cardWidth = slideContainer.clientWidth;
        slideContainer.scrollTo({ left: activeVehicleIndex * cardWidth, behavior: 'smooth' });
    }
    
    // Update numbered nav buttons
    const dotsContainer = document.getElementById('vehicle-slide-dots');
    if (dotsContainer) {
        const dots = dotsContainer.children;
        for (let i = 0; i < dots.length; i++) {
            const isActive = i === activeVehicleIndex;
            if (dots[i]) {
                dots[i].style.width = '34px';
                dots[i].style.height = '34px';
                dots[i].style.background = isActive ? '#facc15' : 'rgba(255,255,255,0.07)';
                dots[i].style.border = isActive ? '2px solid #facc15' : '2px solid rgba(255,255,255,0.2)';
                dots[i].style.color = isActive ? '#0b0e14' : 'rgba(255,255,255,0.45)';
                dots[i].style.fontWeight = isActive ? '800' : '600';
                dots[i].style.boxShadow = isActive ? '0 4px 14px rgba(250,204,21,0.35)' : 'none';
            }
        }
    }
    updateFixedActionButton();
}

window.handleVehicleScroll = function(el) {
    if (_isProgrammaticScroll) return; // Ignore mid-animation events
    if (!userVehicles || userVehicles.length <= 1) return;
    const scrollLeft = el.scrollLeft;
    const cardWidth = el.clientWidth;
    // Calculate which card is centered
    const newIndex = Math.round(scrollLeft / cardWidth);
    if (newIndex !== activeVehicleIndex && newIndex >= 0 && newIndex < userVehicles.length) {
        activeVehicleIndex = newIndex;
        slideVehicleToActive();
    }
};

window.goToBookingSubView = function(target) {
    window.bookingSubView = target;
    if (target === '2A') {
        window.userManuallySelectedHours = false;
        lastRenderedVehicleId = null;
    }
    window.updateFixedActionButton();
};

window.updateFixedActionButton = function() {
    const container = document.getElementById('fixed-action-btn-container');
    if (!container) return;
    const v = userVehicles[activeVehicleIndex];
    if (!v) return;
    
    const isBooked = activeBookedVehicleIds.includes(v.id);
    const activeTripForVehicle = window._activeTripsByVehicle ? window._activeTripsByVehicle[v.id] : null;
    const inlinePanel = document.getElementById('booking-options-inline-panel');
    const detailsContainer = document.getElementById('step2-vehicle-details');
    const configContainer = document.getElementById('step2-service-config');

    // Sync subview element displays
    if (window.bookingSubView === '2A') {
        if (detailsContainer) detailsContainer.style.display = 'block';
        if (configContainer) configContainer.style.display = 'none';
        if (inlinePanel) inlinePanel.style.display = 'none';
    } else {
        if (detailsContainer) detailsContainer.style.display = 'none';
        if (configContainer) configContainer.style.display = 'flex';
    }

    if (activeTripForVehicle) {
        if (inlinePanel) inlinePanel.style.display = 'none';
        container.innerHTML = `
            <button class="yellow-btn" onclick="sessionStorage.removeItem('minimizeEnRoute'); showMarshalEnRoute(window._activeTripsByVehicle['${v.id}']);" style="background: #facc15; color: #0b0e14; font-weight: 800; font-size: 1rem; padding: 14px 20px; border-radius: 14px; box-shadow: 0 8px 25px rgba(250, 204, 21, 0.3); border: none; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 8px; width: 100%; justify-content: center; position: relative; z-index: 20;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
                Track Booking
            </button>
        `;
        return;
    }
    
    if (isBooked) {
        if (inlinePanel) inlinePanel.style.display = 'none';
        container.innerHTML = `
            <button class="yellow-btn" disabled style="background: rgba(255, 255, 255, 0.05); color: var(--text-muted); border: 1px solid rgba(255,255,255,0.08); box-shadow: none; cursor: not-allowed; pointer-events: none; font-weight: 800; font-size: 1rem; padding: 14px 20px; border-radius: 14px; display: flex; align-items: center; gap: 8px; width: 100%; justify-content: center; position: relative;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                Active Booking
            </button>
        `;
        return;
    }

    // Available for Booking
    const locInput = document.getElementById(`pickup-location-global`);
    const dropInput = document.getElementById(`drop-location-global`);
    const pickupAddress = locInput ? (locInput.value.trim() || locInput.getAttribute('data-address') || '').trim() : '';
    const dropAddress = dropInput ? dropInput.value.trim() : '';
    const locationsSet = pickupAddress && dropAddress;

    if (!locationsSet) {
        if (inlinePanel) inlinePanel.style.display = 'none';
        container.innerHTML = `
            <button class="yellow-btn" disabled style="background: rgba(255, 255, 255, 0.05); color: var(--text-muted); border: 1px solid rgba(255,255,255,0.08); box-shadow: none; cursor: not-allowed; pointer-events: none; font-weight: 800; font-size: 0.9rem; padding: 14px 20px; border-radius: 14px; display: flex; align-items: center; gap: 8px; width: 100%; justify-content: center; position: relative;">
                Enter Pickup & Drop Address Above to Book
            </button>
        `;
        return;
    }

    // Locations are set: handle depending on view substate
    if (window.bookingSubView === '2A') {
        container.innerHTML = `
            <button class="yellow-btn" onclick="window.goToBookingSubView('2B')" style="background: #facc15; color: #0b0e14; font-weight: 800; font-size: 1rem; padding: 14px 20px; border-radius: 14px; box-shadow: 0 8px 25px rgba(250, 204, 21, 0.3); border: none; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 8px; width: 100%; justify-content: center; position: relative; z-index: 20;">
                Select Vehicle
            </button>
        `;
    } else {
        if (inlinePanel) {
            inlinePanel.style.display = 'flex';
            window.renderInlineBookingPanel(v.id);
        }

        // Render confirm slider inside container
        if (window.activeBookingTab === 'instant') {
            container.innerHTML = `
                <button type="button" id="btn-request-service-instant" onclick="confirmInstantBooking()" class="yellow-btn" style="width: 100%; height: 52px; border-radius: 26px; background: var(--primary); color: #000; font-size: 0.9rem; font-weight: 800; border: none; text-transform: uppercase; letter-spacing: 0.5px; cursor: pointer; transition: all 0.2s; box-shadow: 0 4px 15px rgba(250, 204, 21, 0.3); outline: none;">
                    Search Driver
                </button>
            `;
        } else {
            container.innerHTML = `
                <div id="slide-confirm-schedule" class="slide-to-confirm-container" style="position: relative; width: 100%; height: 52px; border-radius: 26px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); overflow: hidden; display: flex; align-items: center; justify-content: center; user-select: none; z-index: 20;">
                    <span class="slide-text" style="font-size: 0.78rem; font-weight: 800; color: var(--text-muted); pointer-events: none; z-index: 1; letter-spacing: 0.5px; text-transform: uppercase;">Slide to Confirm Schedule</span>
                    <div class="slide-handle" style="position: absolute; left: 4px; top: 4px; width: 44px; height: 44px; border-radius: 22px; background: #22c55e; display: flex; align-items: center; justify-content: center; cursor: grab; z-index: 2; box-shadow: 0 4px 15px rgba(34, 197, 94, 0.3);">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
                    </div>
                    <div class="slide-highlight" style="position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: rgba(34, 197, 94, 0.15); border-radius: 26px 0 0 26px; pointer-events: none; z-index: 0;"></div>
                </div>
            `;
            setTimeout(() => {
                initSlideToConfirm(document.getElementById('slide-confirm-schedule'), () => {
                    confirmScheduleBooking();
                });
            }, 50);
        }
    }
};

window.prevVehicle = function() {
    if (userVehicles.length === 0) return;
    activeVehicleIndex = (activeVehicleIndex - 1 + userVehicles.length) % userVehicles.length;
    slideVehicleToActive();
};

window.nextVehicle = function() {
    if (userVehicles.length === 0) return;
    activeVehicleIndex = (activeVehicleIndex + 1) % userVehicles.length;
    slideVehicleToActive();
};

window.setVehicleIndex = function(idx) {
    activeVehicleIndex = idx;
    slideVehicleToActive();
};

let locationSearchTimeouts = {};

function getDynamicPresets() {
    const defaultHome = { name: 'Home', address: '45, Linking Road, Bandra West, Mumbai', lat: 19.0544, lng: 72.8402, icon: 'home' };
    const defaultOffice = { name: 'Office', address: 'Maker Chambers IV, Nariman Point, Mumbai', lat: 18.9281, lng: 72.8224, icon: 'office' };
    const defaultOther = { name: 'Other', address: 'Phoenix Palladium, Lower Parel, Mumbai', lat: 18.9942, lng: 72.8267, icon: 'other' };

    let home = defaultHome;
    let office = defaultOffice;
    let other = defaultOther;

    try {
        const savedHome = localStorage.getItem('redrivo_preset_home');
        if (savedHome) home = JSON.parse(savedHome);

        const savedOffice = localStorage.getItem('redrivo_preset_office');
        if (savedOffice) office = JSON.parse(savedOffice);

        const savedOther = localStorage.getItem('redrivo_preset_other');
        if (savedOther) other = JSON.parse(savedOther);
    } catch (e) {
        console.warn('Failed to load presets from localStorage', e);
    }

    return { home, office, other };
}

function getCurrentPickupAndDropHtml(vehicleId) {
    const pickupInput = document.getElementById('pickup-location-global');
    const dropInput = document.getElementById('drop-location-global');
    let html = '';

    if (pickupInput) {
        const val = pickupInput.value.trim();
        const lat = parseFloat(pickupInput.getAttribute('data-lat'));
        const lng = parseFloat(pickupInput.getAttribute('data-lng'));
        if (val && val !== 'Detecting current location...' && !isNaN(lat) && !isNaN(lng)) {
            html += `
                <div class="suggestion-item" onclick="selectLocationSuggestion('${vehicleId}', '${val.replace(/'/g, "\\'")}', ${lat}, ${lng}, false, 'saved')">
                    <span class="suggestion-icon" style="color:#facc15;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 0 0-8-8z"></path><circle cx="12" cy="10" r="3"></circle></svg></span>
                    <div class="suggestion-details">
                        <span class="suggestion-name" style="font-weight:700; color: #facc15;">Pickup Address</span>
                        <span class="suggestion-address">${val}</span>
                    </div>
                </div>
            `;
        }
    }

    if (dropInput) {
        const val = dropInput.value.trim();
        const lat = parseFloat(dropInput.getAttribute('data-lat'));
        const lng = parseFloat(dropInput.getAttribute('data-lng'));
        if (val && !isNaN(lat) && !isNaN(lng)) {
            html += `
                <div class="suggestion-item" onclick="selectLocationSuggestion('${vehicleId}', '${val.replace(/'/g, "\\'")}', ${lat}, ${lng}, false, 'saved')">
                    <span class="suggestion-icon" style="color:#22c55e;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 0 0-8-8z"></path><circle cx="12" cy="10" r="3"></circle></svg></span>
                    <div class="suggestion-details">
                        <span class="suggestion-name" style="font-weight:700; color: #22c55e;">Drop Address</span>
                        <span class="suggestion-address">${val}</span>
                    </div>
                </div>
            `;
        }
    }

    return html;
}

function getCustomSavedAddressesHtml(vehicleId) {
    let customAddresses = [];
    try {
        const stored = localStorage.getItem('redrivo_custom_saved_addresses');
        if (stored) customAddresses = JSON.parse(stored);
    } catch (e) {}

    if (customAddresses.length === 0) return '';

    return customAddresses.map(item => {
        const displayName = item.flat;
        const subName = item.landmark ? `${item.area} (Landmark: ${item.landmark})` : item.area;
        return `
            <div class="suggestion-item" onclick="selectLocationSuggestion('${vehicleId}', '${item.address.replace(/'/g, "\\'")}', ${item.lat}, ${item.lng}, false, 'saved')">
                <span class="suggestion-icon">${ICONS.other}</span>
                <div class="suggestion-details">
                    <span class="suggestion-name" style="font-weight:700;">${displayName}</span>
                    <span class="suggestion-address">${subName}</span>
                </div>
            </div>
        `;
    }).join('');
}

// Search History Storage and rendering (Rapido Style)
function addToSearchHistory(name, address, lat, lng, placeId) {
    if (!address) return;
    let history = [];
    try {
        history = JSON.parse(localStorage.getItem('search_history') || '[]');
    } catch(e) {}
    
    const displayName = name || address.split(',')[0];
    const normalizedNewAddress = address.trim().toLowerCase();

    // Deduplicate based on name, address, place_id, or coordinate proximity (within ~100m)
    history = history.filter(item => {
        const normalizedItemAddress = (item.address || '').trim().toLowerCase();
        
        // 1. Exact address string match
        if (normalizedItemAddress === normalizedNewAddress) return false;
        
        // 2. Exact place_id match (if available)
        if (placeId && item.place_id === placeId) return false;
        
        // 3. Coordinate proximity (under 100 meters)
        if (item.lat && item.lng && lat && lng) {
            const dist = calcDistanceKm(parseFloat(item.lat), parseFloat(item.lng), parseFloat(lat), parseFloat(lng));
            if (dist < 0.1) return false; // 100 meters
        }
        
        // 4. Same display name
        const itemDisplayName = item.name || item.address.split(',')[0];
        if (itemDisplayName.toLowerCase().trim() === displayName.toLowerCase().trim()) return false;

        return true;
    });
    
    history.unshift({
        name: displayName,
        address: address,
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        place_id: placeId
    });
    
    // Keep only last 3
    history = history.slice(0, 3);
    localStorage.setItem('search_history', JSON.stringify(history));
}

window.handleSearchItemClick = function(vehicleId, address, lat, lng, placeId) {
    if (window.routeSearchModalOpen && window.currentSearchType) {
        window.selectRouteSearchSuggestion(window.currentSearchType, window.currentSearchIndex, address, placeId, lat, lng);
    } else {
        selectLocationSuggestion(vehicleId, address, lat, lng, false, null, placeId);
    }
};

function getSearchHistoryHtml(vehicleId) {
    let history = [];
    try {
        history = JSON.parse(localStorage.getItem('search_history') || '[]');
        if (Array.isArray(history)) {
            history = history.filter(item => item && item.address && !item.address.includes('+'));
        }
    } catch(e) {}
    
    if (!history || history.length === 0) {
        return `
            <div style="padding: 24px 16px; text-align: center; color: #a1a1aa;">
                <span class="material-symbols-outlined" style="font-size: 2rem; color: #71717a; margin-bottom: 8px;">history</span>
                <div style="font-size: 0.85rem; font-weight: 600;">No recent searches</div>
                <div style="font-size: 0.72rem; color: #71717a; margin-top: 4px;">Type above to search locations</div>
            </div>
        `;
    }

    // Get saved presets to check if item is saved
    const presets = getDynamicPresets();
    const homeAddr = presets.home?.address || '';
    const officeAddr = presets.office?.address || '';
    const otherAddr = presets.other?.address || '';

    return history.map(item => {
        const displayAddr = item.address || '';
        const displayName = item.name || item.address.split(',')[0];
        
        // Determine heart icon status
        const isSaved = displayAddr === homeAddr || displayAddr === officeAddr || displayAddr === otherAddr;
        const heartIcon = isSaved ? 'favorite' : 'favorite_border';
        const heartColor = isSaved ? '#facc15' : '#94a3b8'; // Gold heart if saved, blue-grey otherwise
        
        let clickHandler = `window.handleSearchItemClick('${vehicleId}', '${displayAddr.replace(/'/g, "\\'")}', ${item.lat}, ${item.lng}, '${item.place_id || ''}')`;

        return `
            <div class="suggestion-item" 
                 onclick="${clickHandler}" 
                 style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px dashed rgba(255,255,255,0.08); cursor: pointer;">
                
                <div style="display: flex; align-items: center; gap: 12px; flex: 1; overflow: hidden;">
                    <span class="material-symbols-outlined" style="color: #a1a1aa; font-size: 1.25rem;">history</span>
                    <div style="display: flex; flex-direction: column; gap: 2px; overflow: hidden;">
                        <span style="color: #ffffff; font-weight: 700; font-size: 0.9rem; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${displayName}</span>
                        <span style="color: #a1a1aa; font-size: 0.75rem; line-height: 1.2; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; font-weight: 500;">${displayAddr}</span>
                    </div>
                </div>
                
                <span class="material-symbols-outlined" style="color: ${heartColor}; font-size: 1.2rem; cursor: pointer; padding: 8px;" onclick="event.stopPropagation(); window.toggleFavoriteAddress('${item.place_id || ''}', '${displayName.replace(/'/g, "\\'")}', '${displayAddr.replace(/'/g, "\\'")}', ${item.lat}, ${item.lng}, '${vehicleId}')">
                    ${heartIcon}
                </span>
            </div>
        `;
    }).join('');
}

window.toggleFavoriteAddress = function(placeId, name, address, lat, lng, vehicleId) {
    Swal.fire({
        title: 'Save Location',
        text: `Choose a label to save "${name}":`,
        icon: 'question',
        background: '#1C1F26',
        color: '#fff',
        showDenyButton: true,
        showCancelButton: true,
        confirmButtonText: '🏠 Home',
        denyButtonText: '💼 Office',
        cancelButtonText: '📍 Other',
        confirmButtonColor: '#facc15',
        denyButtonColor: '#0284c7',
        cancelButtonColor: '#4b5563',
        customClass: {
            popup: 'sweet-alert-dark-popup'
        }
    }).then((result) => {
        let presetType = null;
        if (result.isConfirmed) {
            presetType = 'home';
        } else if (result.isDenied) {
            presetType = 'office';
        } else if (result.dismiss === Swal.DismissReason.cancel) {
            presetType = 'other';
        } else {
            return;
        }

        const presetKey = `redrivo_preset_${presetType}`;
        const presetObj = {
            name: presetType.charAt(0).toUpperCase() + presetType.slice(1),
            address: address,
            lat: parseFloat(lat),
            lng: parseFloat(lng),
            place_id: placeId
        };
        
        localStorage.setItem(presetKey, JSON.stringify(presetObj));
        showToast(`Saved to ${presetType.toUpperCase()} successfully!`, "success");
        
        // Refresh presets list
        showLocationPresets(vehicleId);
    });
};

function showLocationPresets(vehicleId) {
    const isDrop = String(vehicleId).endsWith('-drop');
    const cleanId = isDrop ? vehicleId.replace('-drop', '') : vehicleId;
    const suggestionsDiv = document.getElementById(isDrop ? `drop-suggestions-${cleanId}` : `pickup-suggestions-${cleanId}`);
    if (!suggestionsDiv) return;

    suggestionsDiv.innerHTML = getSearchHistoryHtml(vehicleId);
    suggestionsDiv.style.display = 'block';
}

function handleLocationFocus(vehicleId) {
    const isDrop = String(vehicleId).endsWith('-drop');
    const cleanId = isDrop ? vehicleId.replace('-drop', '') : vehicleId;
    const input = document.getElementById(isDrop ? `drop-location-${cleanId}` : `pickup-location-${cleanId}`);
    if (input) {
        const query = input.value.trim();
        if (query.length < 2) {
            showLocationPresets(vehicleId);
        } else {
            handleLocationInput(vehicleId);
        }
    }
}

function handleLocationInput(vehicleId) {
    const isDrop = String(vehicleId).endsWith('-drop');
    const cleanId = isDrop ? vehicleId.replace('-drop', '') : vehicleId;
    const input = document.getElementById(isDrop ? `drop-location-${cleanId}` : `pickup-location-${cleanId}`);
    const suggestionsDiv = document.getElementById(isDrop ? `drop-suggestions-${cleanId}` : `pickup-suggestions-${cleanId}`);
    if (!input || !suggestionsDiv) return;

    const query = input.value.trim();

    if (locationSearchTimeouts[vehicleId]) {
        clearTimeout(locationSearchTimeouts[vehicleId]);
    }

    if (query.length < 2) {
        showLocationPresets(vehicleId);
        return;
    }

    locationSearchTimeouts[vehicleId] = setTimeout(async () => {
        try {
            suggestionsDiv.innerHTML = `<div style="padding: 10px; color: var(--text-muted); font-size: 0.75rem; text-align: center;">Searching...</div>`;
            suggestionsDiv.style.display = 'block';

            // Retrieve bias parameters from the pickup location input
            let biasParams = '';
            const pickupInput = document.getElementById('pickup-location-global');
            if (pickupInput) {
                const pLat = pickupInput.getAttribute('data-lat');
                const pLng = pickupInput.getAttribute('data-lng');
                if (pLat && pLng) {
                    biasParams = `&lat=${pLat}&lng=${pLng}`;
                }
            }

            const res = await fetch(`${API_URL}/maps/autocomplete?q=${encodeURIComponent(query)}${biasParams}`);
            if (!res.ok) throw new Error('API Error');
            const data = await res.json();
            
            // Temporary console log for verification
            console.log("[Places API Raw Autocomplete Response (Drop/Pickup)]:", data);

            let html = '';

            // Render Select on Map and Add Stops Header
            html += `
                <div style="display: flex; gap: 12px; padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.02); justify-content: flex-start;">
                    <button onclick="selectOnMapDirect('${vehicleId}')" style="display: flex; align-items: center; gap: 6px; padding: 6px 14px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 20px; color: #fff; font-size: 0.75rem; font-weight: 600; cursor: pointer; transition: all 0.2s;">
                        <span class="material-symbols-outlined" style="font-size: 1.1rem; color: #facc15;">map</span> Select on map
                    </button>
                    <button onclick="addStopsDirect('${vehicleId}')" style="display: flex; align-items: center; gap: 6px; padding: 6px 14px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 20px; color: #fff; font-size: 0.75rem; font-weight: 600; cursor: pointer; transition: all 0.2s;">
                        <span class="material-symbols-outlined" style="font-size: 1.1rem; color: #facc15;">add_circle</span> Add stops
                    </button>
                </div>
            `;

            // 1. Google Autocomplete suggestions at the top
            if (data && data.length > 0) {
                html += data.map(item => {
                    const lat = item.lat || 0;
                    const lng = item.lng || 0;
                    const placeId = item.place_id || '';
                    
                    let displayAddr = item.address;
                    if (item.name && item.name !== item.address && !item.address.includes(item.name)) {
                        displayAddr = item.name + ', ' + item.address;
                    }
                    
                    let distanceBadge = '';
                    if (item.distance_meters) {
                        const km = (item.distance_meters / 1000).toFixed(1);
                        distanceBadge = `<span style="font-size: 0.7rem; color: #facc15; background: rgba(250,204,21,0.15); border: 1px solid rgba(250,204,21,0.3); border-radius: 4px; padding: 1px 4px; font-weight: 700; margin-right: 6px; white-space: nowrap;">${km} km</span>`;
                    }
                    
                    return `
                        <div class="suggestion-item" onclick="selectLocationSuggestion('${vehicleId}', '${displayAddr.replace(/'/g, "\\'")}', ${lat}, ${lng}, false, null, '${placeId}')" style="display: flex; align-items: flex-start; gap: 12px; padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.04); cursor: pointer;">
                            <span class="suggestion-icon" style="color: #71717a; margin-top: 2px;">
                                <span class="material-symbols-outlined" style="font-size: 1.25rem;">location_on</span>
                            </span>
                            <div class="suggestion-details" style="display: flex; flex-direction: column; gap: 2px; flex: 1;">
                                <span class="suggestion-name" style="color: #ffffff; font-weight: 700; font-size: 0.88rem;">${item.name}</span>
                                <div style="display: flex; align-items: center; gap: 4px; flex-wrap: wrap;">
                                    ${distanceBadge}
                                    <span class="suggestion-address" style="color: #a1a1aa; font-size: 0.75rem; line-height: 1.2;">${item.address}</span>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');
            }

            // 2. Saved coordinates shortcuts
            html += getCurrentPickupAndDropHtml(vehicleId);

            // 3. Current Geo Location
            html += `
                <div class="suggestion-item" onclick="chooseCurrentGeoLocation('${vehicleId}')">
                    <span class="suggestion-icon">${ICONS.gps}</span>
                    <div class="suggestion-details">
                        <span class="suggestion-name" style="font-weight:700;">Use Current Geo Location</span>
                        <span class="suggestion-address">Detect your location automatically using GPS</span>
                    </div>
                </div>
            `;
            
            // 4. Custom typed text (ONLY as fallback if zero suggestions are found)
            if (!data || data.length === 0) {
                html += `
                    <div class="suggestion-item" onclick="selectLocationSuggestion('${vehicleId}', '${query.replace(/'/g, "\\'")}', 19.0760, 72.8777, true)">
                        <span class="suggestion-icon">${ICONS.manual}</span>
                        <div class="suggestion-details">
                            <span class="suggestion-name">Use custom: "${query}"</span>
                            <span class="suggestion-address">Use typed text as location (coordinates will be generated)</span>
                        </div>
                    </div>
                `;
            }

            suggestionsDiv.innerHTML = html;
        } catch (e) {
            console.error('Maps autocomplete failed', e);
            let html = `
                <div style="padding: 12px 16px; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.2); border-radius: 8px; margin: 8px; color: #f87171; font-size: 0.75rem;">
                    <strong style="display: block; margin-bottom: 2px;">Maps API Error:</strong>
                    ${e.message || e}
                </div>
            `;
            html += getCurrentPickupAndDropHtml(vehicleId);
            html += `
                <div class="suggestion-item" onclick="chooseCurrentGeoLocation('${vehicleId}')">
                    <span class="suggestion-icon">${ICONS.gps}</span>
                    <div class="suggestion-details">
                        <span class="suggestion-name" style="font-weight:700;">Use Current Geo Location</span>
                        <span class="suggestion-address">Detect your location automatically using GPS</span>
                    </div>
                </div>
                <div class="suggestion-item" onclick="selectLocationSuggestion('${vehicleId}', '${query.replace(/'/g, "\\'")}', 19.0760, 72.8777, true)">
                    <span class="suggestion-icon">${ICONS.manual}</span>
                    <div class="suggestion-details">
                        <span class="suggestion-name">Use custom: "${query}"</span>
                        <span class="suggestion-address">Geocoding offline. Click to proceed with coordinates fallback.</span>
                    </div>
                </div>
            `;
            suggestionsDiv.innerHTML = html;
        }
    }, 300);
}

async function chooseCurrentGeoLocation(vehicleId) {
    const isDrop = String(vehicleId).endsWith('-drop');
    const cleanId = isDrop ? vehicleId.replace('-drop', '') : vehicleId;
    const input = document.getElementById(isDrop ? `drop-location-${cleanId}` : `pickup-location-${cleanId}`);
    const suggestionsDiv = document.getElementById(isDrop ? `drop-suggestions-${cleanId}` : `pickup-suggestions-${cleanId}`);
    if (suggestionsDiv) suggestionsDiv.style.display = 'none';

    if (input) {
        input.value = "Detecting current location...";
    }

    showToast("Detecting your GPS location...", "info");

    // 1. Try Native Capacitor GPS
    try {
        const nativePos = await getNativeGpsLocation(true);
        if (nativePos) {
            const lat = nativePos.lat;
            const lng = nativePos.lng;
            const accuracy = nativePos.accuracy || 0;
            
            if (accuracy > 50) {
                showToast(`Low GPS accuracy detected (±${Math.round(accuracy)}m). Please verify your exact spot.`, "warning");
            }

            if (input) {
                input.value = `Current Location (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
                input.setAttribute('data-lat', lat);
                input.setAttribute('data-lng', lng);
                input.setAttribute('data-address', `GPS Coordinates: ${lat.toFixed(6)}, ${lng.toFixed(6)}`);
            }
            showToast("Geocoding coordinates...", "info");
            let resolvedAddr = await fastReverseGeocode(lat, lng);
            selectLocationSuggestion(vehicleId, resolvedAddr, lat, lng, false, null, null, false, accuracy);
            return;
        }
    } catch (e) {
        console.warn("Native GPS choose location failed", e);
    }

    // 2. Fallback to Browser Geolocation
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(async (position) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            const accuracy = position.coords.accuracy || 0;
            
            if (accuracy > 50) {
                showToast(`Low GPS accuracy detected (±${Math.round(accuracy)}m). Please verify your exact spot.`, "warning");
            }

            if (input) {
                input.value = `Current Location (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
                input.setAttribute('data-lat', lat);
                input.setAttribute('data-lng', lng);
                input.setAttribute('data-address', `GPS Coordinates: ${lat.toFixed(6)}, ${lng.toFixed(6)}`);
            }

            try {
                showToast("Geocoding current coordinates...", "info");
                const res = await fetch(`${API_URL}/maps/reverse-geocode?lat=${lat}&lng=${lng}`);
                if (res.ok) {
                    const data = await res.json();
                    const resolvedAddr = (data && data.address) ? data.address : `GPS Coordinates: ${lat.toFixed(6)}, ${lng.toFixed(6)}`;
                    selectLocationSuggestion(vehicleId, resolvedAddr, lat, lng, false, null, null, false, accuracy);
                } else {
                    selectLocationSuggestion(vehicleId, `GPS Coordinates: ${lat.toFixed(6)}, ${lng.toFixed(6)}`, lat, lng, false, null, null, false, accuracy);
                }
            } catch (e) {
                selectLocationSuggestion(vehicleId, `GPS Coordinates: ${lat.toFixed(6)}, ${lng.toFixed(6)}`, lat, lng, false, null, null, false, accuracy);
            }
        }, async (error) => {
            console.warn("Geolocation API permission denied or failed, trying IP fallback...", error);
            showToast("GPS failed. Trying network-based location...", "info");
            
            try {
                const ipRes = await fetch('https://ipapi.co/json/');
                if (ipRes.ok) {
                    const ipData = await ipRes.json();
                    if (ipData && ipData.latitude && ipData.longitude) {
                        const lat = ipData.latitude;
                        const lng = ipData.longitude;
                        let resolvedAddr = await fastReverseGeocode(lat, lng);
                        
                        selectLocationSuggestion(vehicleId, resolvedAddr, lat, lng);
                        return;
                    }
                }
            } catch (ipErr) {
                console.error("IP fallback failed:", ipErr);
            }
            
            showToast("GPS access failed. Falling back to default GPS Location (BKC).", "warning");
            selectLocationSuggestion(vehicleId, 'Trident Hotel, BKC, Mumbai', 19.0664, 72.8680, false, null, null, true);
        }, { enableHighAccuracy: true, timeout: 4000, maximumAge: 600000 });
    } else {
        showToast("Geolocation is not supported by your browser.", "error");
        selectLocationSuggestion(vehicleId, 'Trident Hotel, BKC, Mumbai', 19.0664, 72.8680, false, null, null, true);
    }
}

window.setMapLocation = async function(type, lat, lng) {
    const isDrop = (type === 'drop');
    const inGarageFlow = (window.redrivoCurrentTab === 'focus-garage' || window.redrivoCurrentTab === 'garage');
    
    let vehicleId;
    if (inGarageFlow) {
        vehicleId = isDrop ? 'garage-drop' : 'garage';
    } else {
        vehicleId = isDrop ? 'global-drop' : 'global';
    }
    
    // Close Leaflet popup
    if (customerMap) if (window.activeInfoWindow) window.activeInfoWindow.close();
    
    // Set loading indicator
    showToast(`Reverse geocoding pinpoint location...`, 'info');
    
    let displayName = `GPS Pinpoint: ${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    
    try {
        const res = await fetch(`${API_URL}/maps/reverse-geocode?lat=${lat}&lng=${lng}`);
        if (res.ok) {
            const data = await res.json();
            if (data && data.address) {
                displayName = data.address;
            }
        }
    } catch (e) {
        console.warn("Reverse geocoding failed", e);
    }
    
    selectLocationSuggestion(vehicleId, displayName, lat, lng);
};

function focusFindAddressManually(vehicleId) {
    const isDrop = String(vehicleId).endsWith('-drop');
    const cleanId = isDrop ? vehicleId.replace('-drop', '') : vehicleId;
    const input = document.getElementById(isDrop ? `drop-location-${cleanId}` : `pickup-location-${cleanId}`);
    const suggestionsDiv = document.getElementById(isDrop ? `drop-suggestions-${cleanId}` : `pickup-suggestions-${cleanId}`);
    if (input) {
        input.value = "";
        input.focus();
        showToast("Start typing to search for any address manually.", "info");
    }
    if (suggestionsDiv) suggestionsDiv.style.display = 'none';
}

function showAddressTaggingUI(vehicleId, address, lat, lng) {
    const tagger = document.getElementById(`address-tagger-${vehicleId}`);
    if (tagger) {
        tagger.style.display = 'flex';
        tagger.setAttribute('data-tag-address', address);
        tagger.setAttribute('data-tag-lat', lat);
        tagger.setAttribute('data-tag-lng', lng);
        
        const buttons = tagger.querySelectorAll('button');
        buttons.forEach(btn => {
            btn.style.background = 'rgba(255, 255, 255, 0.04)';
            btn.style.borderColor = 'rgba(255, 255, 255, 0.08)';
            btn.style.color = 'var(--text-muted)';
        });
    }
}

function tagCurrentAddress(vehicleId, type) {
    const tagger = document.getElementById(`address-tagger-${vehicleId}`);
    if (!tagger) return;

    const address = tagger.getAttribute('data-tag-address');
    const lat = parseFloat(tagger.getAttribute('data-tag-lat'));
    const lng = parseFloat(tagger.getAttribute('data-tag-lng'));

    if (!address || isNaN(lat) || isNaN(lng)) {
        showToast('No active address to save', 'error');
        return;
    }

    const key = `redrivo_preset_${type}`;
    const presetData = {
        name: type.charAt(0).toUpperCase() + type.slice(1),
        address,
        lat,
        lng
    };

    try {
        localStorage.setItem(key, JSON.stringify(presetData));
        showToast(`Address saved as your ${presetData.name}!`, 'success');
        
        const buttons = tagger.querySelectorAll('button');
        const labels = { home: 'Home', office: 'Office', other: 'Other' };
        buttons.forEach(btn => {
            if (btn.textContent.includes(labels[type])) {
                btn.style.background = 'rgba(250, 204, 21, 0.1)';
                btn.style.borderColor = 'var(--primary)';
                btn.style.color = 'var(--primary)';
            } else {
                btn.style.background = 'rgba(255, 255, 255, 0.04)';
                btn.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                btn.style.color = 'var(--text-muted)';
            }
        });

        setTimeout(() => {
            tagger.style.display = 'none';
        }, 2000);
    } catch (e) {
        showToast('Failed to save address preset', 'error');
    }
}

function openAddressModal(vehicleId, address, lat, lng) {
    const modal = document.getElementById('address-details-modal');
    if(modal) modal.style.display = 'flex';
    document.getElementById('address-modal-type').value = vehicleId;
    document.getElementById('address-modal-area').value = address;
    document.getElementById('address-modal-lat').value = lat;
    document.getElementById('address-modal-lng').value = lng;
    document.getElementById('address-modal-flat').value = '';
    document.getElementById('address-modal-landmark').value = '';
}

function closeAddressModal() {
    const modal = document.getElementById('address-details-modal');
    if(modal) modal.style.display = 'none';
}

function saveAddressDetails() {
    const vehicleId = document.getElementById('address-modal-type').value;
    const flat = document.getElementById('address-modal-flat').value.trim();
    const area = document.getElementById('address-modal-area').value.trim();
    const landmark = document.getElementById('address-modal-landmark').value.trim();
    const lat = document.getElementById('address-modal-lat').value;
    const lng = document.getElementById('address-modal-lng').value;

    if (!flat) {
        showToast('Flat / House No is required', 'error');
        return;
    }

    const isDrop = String(vehicleId).endsWith('-drop');
    const cleanId = isDrop ? vehicleId.replace('-drop', '') : vehicleId;
    const input = document.getElementById(isDrop ? `drop-location-${cleanId}` : `pickup-location-${cleanId}`);
    if (input) {
        let fullAddress = `${flat}, ${area}`;
        if (landmark) fullAddress += ` (Landmark: ${landmark})`;
        
        input.value = fullAddress;
        input.setAttribute('data-address', area);
        input.setAttribute('data-flat', flat);
        input.setAttribute('data-landmark', landmark);
        input.setAttribute('data-lat', lat);
        input.setAttribute('data-lng', lng);

        // Save to custom saved addresses in local storage
        let customAddresses = [];
        try {
            const stored = localStorage.getItem('redrivo_custom_saved_addresses');
            if (stored) customAddresses = JSON.parse(stored);
        } catch (e) {}

        const duplicate = customAddresses.find(a => a.flat === flat && a.area === area);
        if (!duplicate) {
            customAddresses.push({
                flat,
                area,
                landmark,
                address: fullAddress,
                lat: parseFloat(lat),
                lng: parseFloat(lng)
            });
            localStorage.setItem('redrivo_custom_saved_addresses', JSON.stringify(customAddresses));
        }
        // If it's a pickup address, update the map and show nearby marshals
        if (!isDrop && customerMap) {
            showNearbyMarshalsOnMap(parseFloat(lat), parseFloat(lng));
        }
        renderVehicles();
    }
    
    closeAddressModal();
}


async function selectLocationSuggestion(vehicleId, address, lat, lng, isCustom = false, presetType = null, placeId = null, isFallback = false, accuracy = 0) {
    const isDrop = String(vehicleId).endsWith('-drop');
    const cleanId = isDrop ? vehicleId.replace('-drop', '') : vehicleId;
    
    const suggestionsDiv = document.getElementById(isDrop ? `drop-suggestions-${cleanId}` : `pickup-suggestions-${cleanId}`);
    
    let finalLat = lat;
    let finalLng = lng;
    let finalAddress = address;
    let resolved = !isFallback;
    let forcePinConfirm = false;

    if (placeId && placeId !== 'undefined' && placeId !== 'null' && placeId !== '') {
        showToast("Resolving location coordinates...", "info");
        try {
            const res = await fetch(`${API_URL}/maps/details?place_id=${placeId}`);
            if (res.ok) {
                const details = await res.json();
                if (details && details.lat !== undefined && details.lng !== undefined) {
                    finalLat = details.lat;
                    finalLng = details.lng;
                    console.log('[DEBUG] Details API returned. Preserving user autocomplete selection:', finalAddress);
                    
                    if (details.isLargePoi && !isFallback) {
                        forcePinConfirm = true;
                    }
                } else {
                    console.warn("Details API response missing coordinates:", details);
                    if (isNaN(parseFloat(finalLat)) || isNaN(parseFloat(finalLng))) {
                        showToast("Failed to resolve coordinates. Using fallback BKC.", "warning");
                        finalLat = 19.0664;
                        finalLng = 72.8680;
                        resolved = false;
                    }
                }
            } else {
                if (isNaN(parseFloat(finalLat)) || isNaN(parseFloat(finalLng))) {
                    showToast("Failed to resolve coordinates. Using fallback BKC.", "warning");
                    finalLat = 19.0664;
                    finalLng = 72.8680;
                    resolved = false;
                }
            }
        } catch (e) {
            console.error("Place details resolution error:", e);
            if (isNaN(parseFloat(finalLat)) || isNaN(parseFloat(finalLng))) {
                showToast("Failed to resolve coordinates. Using fallback BKC.", "warning");
                finalLat = 19.0664;
                finalLng = 72.8680;
                resolved = false;
            }
        }
    } else if (isCustom) {
        // Do not randomize coordinates. Try to use current map center or fallback.
        if (window.customerMap) {
            const center = window.customerMap.getCenter();
            if (center && center.lat !== undefined && center.lng !== undefined) {
                finalLat = center.lat;
                finalLng = center.lng;
            } else {
                finalLat = 19.0664;
                finalLng = 72.8680;
                resolved = false;
            }
        } else {
            finalLat = 19.0664;
            finalLng = 72.8680;
            resolved = false;
        }
    }

    // Auto-trigger pin confirmation modal if GPS accuracy is poor
    if (!isDrop && accuracy > 50) {
        forcePinConfirm = true;
    }

    if (resolved) {
        if (isDrop) dropLocationResolved = true;
        else pickupLocationResolved = true;
    } else {
        if (isDrop) dropLocationResolved = false;
        else pickupLocationResolved = false;
    }

    // Check for duplicate pickup/drop locations
    const otherInput = document.getElementById(isDrop ? `pickup-location-${cleanId}` : `drop-location-${cleanId}`);
    if (otherInput) {
        const oLat = parseFloat(otherInput.getAttribute('data-lat'));
        const oLng = parseFloat(otherInput.getAttribute('data-lng'));
        const oAddr = (otherInput.value || otherInput.getAttribute('data-address') || '').trim();
        
        const coordsMatch = !isNaN(oLat) && !isNaN(oLng) && (Math.abs(finalLat - oLat) < 0.0001 && Math.abs(finalLng - oLng) < 0.0001);
        const addressMatch = oAddr && finalAddress && (oAddr.toLowerCase() === finalAddress.toLowerCase());
        
        if ((coordsMatch || addressMatch) && (!window.routeStops || window.routeStops.length === 0)) {
            showToast("Pickup and drop location cannot be the same unless a route stop is added.", "warning");
            if (suggestionsDiv) suggestionsDiv.style.display = 'none';
            return;
        }
    }

    const input = document.getElementById(isDrop ? `drop-location-${cleanId}` : `pickup-location-${cleanId}`);
    if (input) {
        console.log(`[DEBUG] Finalizing DOM assignment for input:`, finalAddress);
        input.value = finalAddress;
        input.setAttribute('data-address', finalAddress);
        input.setAttribute('data-lat', finalLat);
        input.setAttribute('data-lng', finalLng);
        input.setAttribute('data-flat', '');
        input.setAttribute('data-landmark', '');



        // Auto-trigger confirmation modal if marked as forced (low accuracy or large complex)
        if (forcePinConfirm) {
            setTimeout(() => {
                const targetInputId = isDrop ? `drop-location-${cleanId}` : `pickup-location-${cleanId}`;
                openConfirmPinModal(targetInputId, finalAddress, finalLat, finalLng);
            }, 300);
        }

        // If it's a pickup address, update the map, show nearby marshals, and load nearby garages
        if (!isDrop) {
            if (cleanId === 'rpservice') {
                if (suggestionsDiv) suggestionsDiv.style.display = 'none';
                return;
            }
            if (customerMap) {
                customerMap.setCenter({lat: parseFloat(finalLat), lng: parseFloat(finalLng)});
        customerMap.setZoom(14);
                
                const customerIcon = createGoogleIcon('#38bdf8');
                
                if (customerMarker) if (customerMarker) customerMarker.setMap(null);
                
                const routeStatsBadge = document.getElementById('route-stats-badge');
                const isRouteActive = routeStatsBadge && routeStatsBadge.style.display === 'flex';
                if (isRouteActive) {
                    customerMarker = new google.maps.Marker({ position: {lat: parseFloat(finalLat), lng: parseFloat(finalLng)}, map: customerMap, icon: customerIcon
                    , draggable: true });
                    customerMarker.addListener('dragend', function(e) {
    const pos = customerMarker.getPosition();
    window.setMapLocation('pickup', typeof pos.lat === 'function' ? pos.lat() : pos.lat, typeof pos.lng === 'function' ? pos.lng() : pos.lng);
});
                }
                showNearbyMarshalsOnMap(finalLat, finalLng);
            }
            loadNearbyGarages(finalLat, finalLng);
        } else {
            // If it's a drop location, also update the drop marker on the map!
            if (customerMap) {
                const dropIcon = createGoogleIcon('#ef4444');
                if (dropMarker) if (dropMarker) dropMarker.setMap(null);
                dropMarker = new google.maps.Marker({ position: {lat: parseFloat(finalLat), lng: parseFloat(finalLng)}, map: customerMap, 
                    draggable: true,
                    icon: dropIcon
                });
                dropMarker;
                dropMarker.addListener('dragend', function(e) {
    const pos = dropMarker.getPosition();
    window.setMapLocation('drop', typeof pos.lat === 'function' ? pos.lat() : pos.lat, typeof pos.lng === 'function' ? pos.lng() : pos.lng);
});
                
                // Fit bounds handled asynchronously in recalculateAndDrawRoute to prevent layout conflict
            }
        }
    }
    
    if (suggestionsDiv) {
        suggestionsDiv.style.display = 'none';
    }
    closeAddressModal();
    
    // Update route line and stats dynamically when coordinates are selected/changed
    updateRouteVisibility();
    
    // Add to local storage search history
    addToSearchHistory(finalAddress.split(',')[0], finalAddress, finalLat, finalLng, placeId);

    // Auto-focus drop input if pickup was selected on Home tab
    if (vehicleId === 'global') {
        const dropInput = document.getElementById('drop-location-global');
        if (dropInput) {
            setTimeout(() => { dropInput.focus(); }, 150);
        }
    }

    // Dynamic Step 4 map redrawing for garage-specific location changes
    if (String(vehicleId).startsWith('garage')) {
        if (typeof initFlowStep4Map === 'function') {
            initFlowStep4Map();
        }
    }

    renderVehicles();
}

// Global outside click handler to dismiss dropdowns
document.addEventListener('click', (e) => {
    const dropdowns = document.querySelectorAll('.suggestions-dropdown');
    dropdowns.forEach(dropdown => {
        const isDrop = dropdown.id.startsWith('drop-suggestions-');
        const prefix = isDrop ? 'drop-suggestions-' : 'pickup-suggestions-';
        const vehicleId = dropdown.id.replace(prefix, '');
        const input = document.getElementById(isDrop ? `drop-location-${vehicleId}` : `pickup-location-${vehicleId}`);
        if (input && !dropdown.contains(e.target) && e.target !== input) {
            dropdown.style.display = 'none';
        }
    });
});

function showVehicleForm(preSelectedCategory = 'Car') {
    const addMoreContainer = document.getElementById('add-more-container');
    if (addMoreContainer) addMoreContainer.style.display = 'none';
    
    document.getElementById('vehicle-form-elements').style.display = 'block';
    document.getElementById('vehicle-form-title').textContent = 'Add New Vehicle';
    document.getElementById('btn-submit-vehicle').textContent = 'Add Vehicle';
    const cancelBtn = document.getElementById('btn-cancel-vehicle');
    if (cancelBtn) cancelBtn.style.display = userVehicles.length > 0 ? 'block' : 'none';

    // Clear form
    document.getElementById('v-edit-id').value = '';
    document.getElementById('v-plate').value = '';
    document.getElementById('v-make').value = '';
    document.getElementById('v-model').value = '';
    window.activePhotoFile = null;
    const preview = document.getElementById('v-photo-preview');
    if (preview) preview.style.display = 'none';
    const labelText = document.getElementById('photo-label-text');
    if (labelText) labelText.textContent = 'Tap to upload vehicle photo';
    
    // Reset category and fields
    changeVehicleCategory(preSelectedCategory);
    if (preSelectedCategory === 'Car') {
        selectCarSubtype('Hatchback');
        selectFuel('Petrol');
    } else {
        selectFuel('Petrol');
    }
    selectTransmission('Manual');

    const photoPreview = document.getElementById('v-photo-preview');
    if (photoPreview) {
        photoPreview.style.display = 'none';
        photoPreview.src = '';
    }
    const photoText = document.getElementById('photo-label-text');
    if (photoText) photoText.textContent = 'Click to upload a photo';
}

function hideVehicleForm() {
    const addMoreContainer = document.getElementById('add-more-container');
    if (addMoreContainer && userVehicles.length > 0) addMoreContainer.style.display = 'block';
    
    const formEls = document.getElementById('vehicle-form-elements');
    if (formEls) formEls.style.display = 'none';
}

function renderRequests(reqs) {
    const list = document.getElementById('requests-list');
    if (!list) return;
    const section = document.getElementById('requests-section');
    if (reqs.length === 0) {
        if (section) section.style.display = 'none';
        list.innerHTML = `<div class="list-item" style="justify-content:center; color: var(--text-muted)">No active service requests.</div>`;
        return;
    }

    if (section) section.style.display = 'block';
    list.innerHTML = reqs.map(r => {
        const vehicle = userVehicles.find(v => v.id === r.vehicleId);
        const vName = vehicle ? `${vehicle.make} ${vehicle.model}` : 'Unknown Vehicle';

        let statusText = r.status;
        let statusClass = r.status.toLowerCase().replace(/ /g, '-');
        let actionButtons = '';

        if (r.status === 'waiting_for_marshal') {
            statusText = 'Finding Driver...';
            statusClass = 'pending';
        } else if (r.status === 'scheduled') {
            statusText = 'Scheduled';
            statusClass = 'Pending';
        } else if (r.status === 'marshal_assigned') {
            if (!r.assignedGarageId) {
                statusText = 'Driver Found!';
                statusClass = 'success';
                actionButtons = `<button class="btn btn-primary btn-sm" style="margin-top:10px; width:100%" onclick="openGarageSelector('${r.id}', ${r.lat}, ${r.lng})">Select Nearby Garage</button>`;
            } else {
                statusText = 'Driver Assigned';
                statusClass = 'in-transit';
            }
        } else if (r.status === 'drop_completed') {
            statusText = 'Completed';
            statusClass = 'Completed';
        }

        const pricingHtml = `
            <div style="font-size:0.75rem; color:var(--text-muted); margin-top:5px; padding-top:5px; border-top:1px solid rgba(255,255,255,0.05);">
                Service: ₹${r.garageServiceCharge || 0} | ${r.pickupDropType}: ₹${r.pickupDropCost || 0} | GST: ₹${r.gstAmount || 0}
                <div style="font-weight:700; color:var(--primary); margin-top:2px;">Total: ₹${r.totalCustomerPrice || 0}</div>
            </div>
        `;

        return `
            <div class="list-item" style="flex-direction:column; align-items:flex-start; gap:8px;">
                <div style="display:flex; justify-content:space-between; width:100%; align-items:center;">
                    <div>
                        <div style="font-weight:600">${vName}</div>
                        <div style="font-size:0.8rem; color:var(--text-muted)">${new Date(r.date).toLocaleDateString()} - ${r.issue}</div>
                    </div>
                    <div class="badge badge-${statusClass}">${statusText}</div>
                </div>
                ${pricingHtml}
                ${actionButtons}
            </div>
        `;
    }).reverse().join(''); // Show newest first
}

async function openGarageSelector(reqId, lat, lng) {
    try {
        const res = await fetch(`${API_URL}/garages/nearby?lat=${lat}&lng=${lng}`);
        const garages = await res.json();

        if (garages.length === 0) {
            showToast('No garages found within 15KM. Please contact support.', 'error');
            return;
        }

        // Create a simple modal for garage selection
        const modal = document.createElement('div');
        modal.id = 'garage-selector-modal';
        modal.className = 'v-modal';
        modal.style.display = 'flex';
        modal.innerHTML = `
            <div class="v-modal-content" style="max-width:400px">
                <div class="v-modal-header">
                    <h3>Select Nearby Garage</h3>
                    <button class="v-close" onclick="this.closest('#garage-selector-modal').remove()">×</button>
                </div>
                <div style="max-height: 400px; overflow-y: auto; padding: 15px;">
                    ${garages.map(g => `
                        <div class="list-item" style="margin-bottom:10px; padding:12px; border:1px solid var(--border); border-radius:var(--radius-md); cursor:pointer" onclick="selectGarageForRequest('${reqId}', '${g.id}')">
                            <div>
                                <div style="font-weight:600">${g.name}</div>
                                <div style="font-size:0.8rem; color:var(--text-muted)">${g.address}</div>
                            </div>
                            <div class="badge badge-success">Select</div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    } catch (err) {
        showToast('Failed to load nearby garages', 'error');
    }
}

async function selectGarageForRequest(reqId, garageId) {
    if (!confirm('Assign this garage to your service?')) return;
    try {
        const res = await fetch(`${API_URL}/service-requests/${reqId}/assign-garage`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ garageId })
        });
        if (!res.ok) throw new Error('Failed to assign garage');

        showToast('Garage assigned! Trip is now being prepared.', 'success');
        document.getElementById('garage-selector-modal')?.remove();
        loadDashboard();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function renderInspectionApprovals(reqs) {
    const section = document.getElementById('inspection-approval-section');
    const list = document.getElementById('inspection-approval-list');
    if (!list) return;
    if (section) section.style.display = 'block';

    list.innerHTML = reqs.map(r => {
        let quote = r.inspectionQuote || 2500;
        return `
            <div class="list-item" style="border-left: 4px solid var(--warning); display:flex; flex-direction:column; gap:10px;">
                <div style="display:flex; justify-content:space-between; align-items:center; width: 100%;">
                    <div>
                        <div style="font-weight:700">${r.inspectionCategory || 'Brakes & Suspension'}</div>
                        <div style="font-size: 0.85rem; color: var(--text-muted);">Failed: Brake Pads (Front)</div>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-size: 0.85rem; color: var(--text-muted); text-decoration: line-through;">MRP: ₹${quote + 500}</div>
                        <div style="font-weight: 700; color: var(--primary);">Re<span style="color: #FACC15;">D</span>rivo: ₹${quote}</div>
                    </div>
                </div>
                
                <div style="display:flex; gap:8px;">
                    <div style="width: 50px; height: 50px; background: rgba(255,255,255,0.05); border-radius: var(--radius-md); border: 1px dashed var(--border); display:flex; align-items:center; justify-content:center;" title="View Photo Evidence">${ICONS.camera}</div>
                    <div style="width: 50px; height: 50px; background: rgba(255,255,255,0.05); border-radius: var(--radius-md); border: 1px dashed var(--border); display:flex; align-items:center; justify-content:center;" title="View Video Evidence">${ICONS.video}</div>
                </div>

                <div style="display:flex; gap:10px; align-items:center; margin-top:5px;">
                    <select style="flex:1; padding: 8px; background: rgba(255,255,255,0.05); border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--text-main);">
                        <option>Bosch (OEM) - ₹${quote}</option>
                        <option>Brembo (Performance) - ₹${quote + 1200}</option>
                    </select>
                    <button class="btn btn-warning btn-sm" onclick="approveInspection('${r.id}')" style="padding: 8px 16px;">Approve</button>
                </div>
            </div>
        `;
    }).join('');
}

async function approveInspection(reqId) {
    try {
        await apiPost(`/requests/${reqId}/approve-inspection`, {});
        showToast('Inspection approved! We will proceed shortly.', 'success');
        loadDashboard();
    } catch (e) { showToast('Failed to approve inspection', 'error'); }
}

function renderTrips(trips) {
    const list = document.getElementById('trips-list');
    const section = document.getElementById('trips-section');
    if (!list || !section) return;

    const activeTrips = trips.filter(t => t.status !== 'completed' && t.status !== 'cancelled' && t.status !== 'drop_completed' && t.status !== 'pending_payment');

    if (activeTrips.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';

    list.innerHTML = activeTrips.map(t => {
        let statusBadge = '';
        let actionBtn = '';

        if (t.status === 'pending_otp_1') {
            statusBadge = `<span class="badge pending">Marshal Arriving</span>`;
            actionBtn = `<button class="btn btn-primary" style="padding: 6px 12px; font-size: 0.8rem;" onclick='reviewTripMedia("${t.id}", "${t.otp1}")'>Show Handover OTP</button>`;
        } else if (t.status === 'in_transit') {
            statusBadge = `<span class="badge in-transit">In Transit to Garage</span>`;
        } else if (t.status === 'at_garage') {
            statusBadge = `<span class="badge in-service" style="background: rgba(16, 185, 129, 0.1); color: var(--success);">Delivered to Garage</span>`;
        } else if (t.status === 'in_service') {
            statusBadge = `<span class="badge in-service">Service in Progress</span>`;
        } else if (t.status === 'pending_delivery') {
            statusBadge = `<span class="badge in-transit" style="background: rgba(59, 130, 246, 0.1); color: var(--primary);">Pending Final Delivery</span>`;
            actionBtn = `<button class="btn btn-success" style="padding: 6px 12px; font-size: 0.8rem;" onclick='finalizeDelivery("${t.id}", "${t.deliveryOtp || t.deliveryotp || ''}")'>Pay & Get OTP</button>`;
        } else {
            statusBadge = `<span class="badge pending">${t.status.replace('_', ' ')}</span>`;
        }
        
        // Add map tracking button for active trip
        actionBtn += `<button class="btn btn-outline" style="padding: 6px 12px; font-size: 0.8rem; border-color: var(--primary); color: var(--primary); margin-left: 6px; font-weight: 700;" onclick="sessionStorage.removeItem('minimizeEnRoute'); showMarshalEnRoute(window._activeTrip)">Track on Map</button>`;

        const isVerified = t.emailVerified && t.phoneVerified && (t.dlVerified || t.dlBikeVerified || t.dlCarVerified);
        const marshalHtml = t.marshalName ? `
            <div style="font-size:0.75rem; color: #10b981; margin-top: 4px; display:flex; align-items:center; gap:4px">
                <i data-lucide="shield-check" style="width:12px; height:12px"></i>
                Verified Marshal: ${t.marshalName}
                <span title="Phone, Email, and DL Verified" style="cursor:help; font-size:0.7rem; color: #10b981; margin-left: 2px;">(Verified)</span>
            </div>
        ` : '';

        return `
            <div class="list-item" style="align-items: center; border-left: 4px solid var(--primary);">
                <div>
                    <div style="font-weight:600">Handover Ready</div>
                    <div style="font-size:0.8rem; color:var(--text-muted)">Trip: ${t.id} &bull; Start Odo: ${t.startOdometer !== undefined ? t.startOdometer : t.startodometer} km</div>
                    ${marshalHtml}
                </div>
                ${statusBadge}
                ${actionBtn}
            </div>
        `;
    }).reverse().join('');
    lucide.createIcons();
}

function renderApprovals(approvals) {
    const list = document.getElementById('approval-list');
    const section = document.getElementById('approval-section');
    if (!list || !section) return;

    if (approvals.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';

    list.innerHTML = approvals.map(app => {
        return `
            <div class="list-item" style="flex-direction:column; align-items: stretch; border-left: 4px solid #22c55e;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <div>
                        <div style="font-weight:700">Trip: ${app.trip.id}</div>
                        <div style="font-size:0.8rem; color:var(--text-muted)">Verified by Garage & Marshal</div>
                    </div>
                    <div style="display:flex; gap:4px;">
                        <span class="badge" style="background: rgba(34, 197, 94, 0.1); color: #22c55e; border: 1px solid #22c55e;">Garage Verified</span>
                        <span class="badge" style="background: rgba(34, 197, 94, 0.1); color: #22c55e; border: 1px solid #22c55e;">Marshal Verified</span>
                    </div>
                </div>

                <div style="background:rgba(255,255,255,0.02); padding:10px; border-radius:var(--radius-md); border:1px solid var(--border); margin-bottom:10px; font-size: 0.9rem;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:4px; color: var(--text-main);"><span>Labor</span><span>₹1200</span></div>
                    <div style="display:flex; justify-content:space-between; margin-bottom:4px; color: var(--text-main);"><span>Service Charge</span><span>₹299</span></div>
                    <div style="display:flex; justify-content:space-between; margin-bottom:4px; color: var(--text-main);"><span>Parts (Bosch Pads)</span><span>₹2500</span></div>
                    <div style="display:flex; justify-content:space-between; margin-bottom:4px; color: var(--text-main);"><span>Inspection Fee</span><span>₹0</span></div>
                    <div style="display:flex; justify-content:space-between; margin-bottom:8px; color: var(--text-main);"><span>QA Fee</span><span>₹0</span></div>
                    <div style="display:flex; justify-content:space-between; font-weight:700; color:var(--primary); border-top:1px dashed var(--border); padding-top:8px;"><span>Final Total</span><span>₹3999</span></div>
                </div>

                <button class="btn btn-success" style="width:100%; padding: 12px; font-weight:700; background: #22c55e; color: #fff; border:none; border-radius: var(--radius-md); cursor: pointer;" onclick='openAuditModal(${JSON.stringify(app)})'>Pay & View Delivery 360°</button>
            </div>
        `;
    }).reverse().join('');
}

// --- Video Review Modal ---
async function reviewTripMedia(tripId, otp) {
    const modal = document.getElementById('video-modal');
    const videoObj = document.getElementById('customer-review-video');
    const revealBox = document.getElementById('otp-reveal-box');
    const revealedOtpText = document.getElementById('revealed-otp');

    // Reset Modal
    revealBox.style.display = 'none';
    revealedOtpText.textContent = '';
    
    document.querySelector('#video-modal h3').textContent = "Handover OTP";
    document.querySelector('#video-modal p').textContent = "Please share this OTP with the Driver so they can begin the 360° walkaround and start your service.";

    if(videoObj) {
        videoObj.src = '';
        videoObj.style.display = 'none'; // Hide video element
    }

    // Immediately reveal OTP
    revealedOtpText.textContent = otp;
    revealBox.style.display = 'block';
    modal.style.display = 'flex';
}

function closeVideoModal() {
    const modal = document.getElementById('video-modal');
    const videoObj = document.getElementById('customer-review-video');
    if (videoObj) {
        videoObj.pause();
        videoObj.src = '';
    }
    modal.style.display = 'none';
}

// --- Audit Review Modal ---
async function openAuditModal(appData) {
    const modal = document.getElementById('audit-modal');
    const detailsContainer = document.getElementById('audit-details-content');
    const costContainer = document.getElementById('audit-total-cost');
    const approveBtn = document.getElementById('modal-btn-approve-audit');

    const tripId = appData.trip.id;
    const audit = appData.audit;
    let auditData = [];
    try {
        auditData = JSON.parse(audit.data);
    } catch (e) {
        console.error("Failed to parse audit data JSON", e);
    }

    const flagHtml = (status) => {
        if (status === 'Replace') return `<span class="badge badge-danger">Replace</span>`;
        if (status === 'Monitor') return `<span class="badge badge-warning">Monitor</span>`;
        return `<span class="badge badge-success">Not Required</span>`;
    };

    if (Array.isArray(auditData)) {
        detailsContainer.innerHTML = auditData.map(item => {
            const videoBtn = item.videoMediaId && item.videoMediaId !== `mock_video_for_${item.item}` && item.videoMediaId !== null
                ? `<button class="btn btn-outline" style="padding: 4px 8px; font-size: 0.75rem;" onclick="playAuditEvidence('${item.videoMediaId}')"><i data-lucide="play" style="width:14px; height:14px;"></i> View</button>`
                : `<span style="font-size: 0.75rem; color: var(--text-muted);">No Video</span>`;

            return `
                <div class="audit-row" style="border-left: 4px solid ${item.status === 'Replace' ? 'var(--danger)' : (item.status === 'Monitor' ? 'var(--warning)' : 'var(--success)')}">
                    <div style="width: 25%">
                        <div style="font-weight: 500">${item.item}</div>
                        <div style="font-size: 0.75rem; color: var(--text-muted);">${item.category}</div>
                    </div>
                    <div style="width: 20%; font-size: 0.9rem;">${item.condition}</div>
                    <div style="width: 15%; text-align: center;">${flagHtml(item.status)}</div>
                    <div style="width: 20%; text-align: center;">${videoBtn}</div>
                    <div style="width: 20%; text-align: right; font-weight: 700; color: var(--text-main);">₹${item.finalPrice || 0}</div>
                </div>
            `;
        }).join('');
    } else {
        // Fallback for old object structure
        detailsContainer.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted)">Legacy Audit Format</div>`;
    }

    costContainer.textContent = audit.customerEstimate || 0;

    if (approveBtn) {
        if (appData.trip.status === 'completed') {
            approveBtn.style.display = 'none';
        } else {
            approveBtn.style.display = 'block';
            approveBtn.onclick = () => approveAudit(tripId);
        }
    }

    modal.style.display = 'flex';
    lucide.createIcons();
}

function playAuditEvidence(mediaId) {
    const videoModal = document.getElementById('video-modal');
    const videoObj = document.getElementById('customer-review-video');
    const revealBox = document.getElementById('otp-reveal-box');

    // Hide OTP box for audit clips
    revealBox.style.display = 'none';
    
    document.querySelector('#video-modal h3').textContent = "Zero-Trust Evidence";
    document.querySelector('#video-modal p').textContent = "Please review the video evidence recorded by the Driver.";

    // Stream directly via API
    if (videoObj) {
        videoObj.src = `${API_URL}/media/stream/${mediaId}`;
        videoObj.style.display = 'block';
        videoObj.play().catch(e => console.log(e));
    }

    videoModal.style.zIndex = 1001; // Ensure it overlays the audit modal
    videoModal.style.display = 'flex';
}

function closeAuditModal() {
    const modal = document.getElementById('audit-modal');
    modal.style.display = 'none';
}

async function approveAudit(tripId) {
    try {
        const res = await fetch(`${API_URL}/trips/${tripId}/approve-audit`, {
            method: 'POST'
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        showToast('Service Approved! Mechanics will now begin work.', 'success');
        closeAuditModal();
        loadDashboard(); // Refresh
    } catch (e) {
        showToast('Error approving audit: ' + e.message, 'error');
    }
}

// --- Customer Final Payment & Delivery ---
async function finalizeDelivery(tripId, otp2) {
    currentTripId = tripId;
    currentOtp2 = otp2;

    const modal = document.getElementById('audit-modal');
    if (modal) modal.style.display = 'flex';

    // Hide start approval sections
    const approvalSection = document.getElementById('service-approval-section');
    if (approvalSection) approvalSection.style.display = 'none';
    const approveBtn = document.getElementById('modal-btn-approve-audit');
    if (approveBtn) approveBtn.style.display = 'none';

    // Show Final Payment section
    const finalPaymentSection = document.getElementById('final-payment-section');
    if (finalPaymentSection) finalPaymentSection.style.display = 'block';

    const otpDisplay = document.getElementById('final-otp-display');
    if (otpDisplay) otpDisplay.style.display = 'none';
    const payBtn = document.getElementById('btn-pay-invoice');
    if (payBtn) payBtn.style.display = 'block';

    try {
        // Fetch Audit details to get the final bill and render audit items
        const auditRes = await fetch(`${API_URL}/trips/${tripId}/audit`);
        if (auditRes.ok) {
            const auditData = await auditRes.json();
            currentInvoiceAmount = auditData.customerEstimate || 600;

            const detailsContainer = document.getElementById('audit-details-content');
            const costContainer = document.getElementById('audit-total-cost');
            if (costContainer) costContainer.textContent = currentInvoiceAmount;

            let items = [];
            try {
                items = JSON.parse(auditData.data);
            } catch (e) {
                console.error("Failed parsing audit items", e);
            }

            const flagHtml = (status) => {
                if (status === 'Replace') return `<span class="badge badge-danger">Replace</span>`;
                if (status === 'Monitor') return `<span class="badge badge-warning">Monitor</span>`;
                return `<span class="badge badge-success">Not Required</span>`;
            };

            if (detailsContainer && Array.isArray(items)) {
                detailsContainer.innerHTML = items.map(item => {
                    const videoBtn = item.videoMediaId && item.videoMediaId !== `mock_video_for_${item.item}` && item.videoMediaId !== null
                        ? `<button class="btn btn-outline" style="padding: 4px 8px; font-size: 0.75rem;" onclick="playAuditEvidence('${item.videoMediaId}')"><i data-lucide="play" style="width:14px; height:14px;"></i> View</button>`
                        : `<span style="font-size: 0.75rem; color: var(--text-muted);">No Video</span>`;

                    return `
                        <div class="audit-row" style="border-left: 4px solid ${item.status === 'Replace' ? 'var(--danger)' : (item.status === 'Monitor' ? 'var(--warning)' : 'var(--success)')}">
                            <div style="width: 25%">
                                <div style="font-weight: 500">${item.item}</div>
                                <div style="font-size: 0.75rem; color: var(--text-muted);">${item.category}</div>
                            </div>
                            <div style="width: 20%; font-size: 0.9rem;">${item.condition}</div>
                            <div style="width: 15%; text-align: center;">${flagHtml(item.status)}</div>
                            <div style="width: 20%; text-align: center;">${videoBtn}</div>
                            <div style="width: 20%; text-align: right; font-weight: 700; color: var(--text-main);">₹${item.finalPrice || 0}</div>
                        </div>
                    `;
                }).join('');
            }

            const paymentContainer = document.getElementById('payment-details-container');
            if (paymentContainer) {
                paymentContainer.innerHTML = `
                    <div style="display:flex; justify-content:space-between; margin-bottom: 5px;">
                        <span>Total Service Bill:</span>
                        <strong>₹${currentInvoiceAmount}</strong>
                    </div>
                    <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 10px;">
                        Payment will be securely processed. Once paid, your Delivery OTP will be revealed.
                    </div>
                `;
            }
            const finalPayAmt = document.getElementById('final-pay-amt');
            if (finalPayAmt) finalPayAmt.textContent = `₹${currentInvoiceAmount}`;
        }
    } catch (e) {
        console.error("Failed fetching bill details", e);
    }

    lucide.createIcons();
}

function payFinalInvoice() {
    // Mock Payment Gateway flow
    const btn = document.getElementById('btn-pay-invoice');
    btn.innerHTML = `<i data-lucide="loader"></i> Processing...`;
    lucide.createIcons();

    setTimeout(() => {
        btn.style.display = 'none';

        const otpBox = document.getElementById('final-otp-display');
        otpBox.style.display = 'block';
        document.getElementById('the-otp-2').textContent = currentOtp2;

        showToast('Payment Successful! Please provide the OTP to the Driver.', 'success');
    }, 1500);
}

function viewReceipt(tripId) {
    // showToast('Receipt for Trip ' + tripId + ' would be downloaded here.', 'info');
}

// --- Vehicle Brand Data ---
const VEHICLE_BRANDS = {
    Car: [
        'Maruti Suzuki', 'Hyundai', 'Tata', 'Mahindra', 'Honda', 'Toyota', 'Kia',
        'MG', 'Skoda', 'Volkswagen', 'Renault', 'Nissan', 'Ford', 'Jeep', 'BMW',
        'Mercedes-Benz', 'Audi', 'Volvo', 'Jaguar', 'Land Rover', 'Porsche',
        'Ferrari', 'Lamborghini', 'Rolls-Royce', 'Bentley', 'Maserati',
        'Citroën', 'Peugeot', 'MINI', 'Fiat', 'Chevrolet', 'Datsun',
        'Isuzu', 'Lexus', 'Mitsubishi', 'Subaru', 'Mazda', 'Opel',
        'Seat', 'BYD', 'Haval', 'Geely', 'ORA'
    ],
    Bike: [
        'Hero', 'Bajaj', 'Honda', 'TVS', 'Royal Enfield', 'Yamaha', 'Suzuki',
        'KTM', 'Kawasaki', 'Ducati', 'Triumph', 'Harley-Davidson', 'BMW Motorrad',
        'Aprilia', 'Vespa', 'Jawa', 'Yezdi', 'Benelli', 'Husqvarna', 'Indian',
        'CFMoto', 'Revolt', 'Ather', 'Ola Electric', 'Hero Electric', 'Pure EV',
        'Okaya', 'Ampere', 'Bounce', 'Okinawa', 'Ultraviolette', 'Tork Motors'
    ]
};

const FUEL_OPTIONS = {
    Car: ['Petrol', 'Diesel', 'EV', 'CNG', 'Hybrid'],
    Bike: ['Petrol', 'Battery']
};

// --- Category toggle (Car vs Bike) ---
function changeVehicleCategory(category) {
    document.getElementById('v-main-category').value = category;
    document.getElementById('v-make').value = '';
    document.getElementById('make-dropdown').style.display = 'none';

    const carBtn = document.getElementById('vtype-Car');
    const bikeBtn = document.getElementById('vtype-Bike');
    const carSubtypeGroup = document.getElementById('car-subtype-group');
    const seatsGroup = document.getElementById('car-seats-group');

    if (category === 'Car') {
        if (carBtn) carBtn.className = 'vtype-btn active';
        if (bikeBtn) bikeBtn.className = 'vtype-btn inactive';
        if (carSubtypeGroup) carSubtypeGroup.style.display = 'block';
        if (seatsGroup) seatsGroup.style.display = 'block';
        selectCarSubtype('Hatchback');
    } else {
        if (bikeBtn) bikeBtn.className = 'vtype-btn active';
        if (carBtn) carBtn.className = 'vtype-btn inactive';
        if (carSubtypeGroup) carSubtypeGroup.style.display = 'none';
        if (seatsGroup) seatsGroup.style.display = 'none';
        document.getElementById('v-type').value = 'Bike';
    }

    // Populate fuel container dynamically
    const fuelContainer = document.getElementById('fuel-container');
    if (fuelContainer) {
        const options = FUEL_OPTIONS[category] || [];
        fuelContainer.innerHTML = options.map((f, index) => `
            <button type="button" id="fuel-${f}" class="fuel-btn ${index === 0 ? 'active' : 'inactive'}" style="flex: 1 0 auto; min-width: 90px;" onclick="selectFuel('${f}')">${f}</button>
        `).join('');
        selectFuel(options[0]);
    }
}

function selectCarSubtype(subtype) {
    document.getElementById('v-type').value = subtype;
    const subtypes = ['Hatchback', 'Sedan', 'SUV'];
    subtypes.forEach(s => {
        const btn = document.getElementById(`subtype-${s}`);
        if (btn) {
            btn.className = s === subtype ? 'fuel-btn active' : 'fuel-btn inactive';
        }
    });
}

function selectFuel(fuel) {
    document.getElementById('v-fuel').value = fuel;
    const category = document.getElementById('v-main-category').value;
    const options = FUEL_OPTIONS[category] || [];
    options.forEach(f => {
        const btn = document.getElementById(`fuel-${f}`);
        if (btn) {
            btn.className = f === fuel ? 'fuel-btn active' : 'fuel-btn inactive';
        }
    });
}

function selectTransmission(transmission) {
    document.getElementById('v-transmission').value = transmission;
    const options = ['Manual', 'Automatic'];
    options.forEach(o => {
        const cleanId = o.replace(/\s+/g, '');
        const btn = document.getElementById(`trans-${cleanId}`);
        if (btn) {
            btn.className = o === transmission ? 'fuel-btn active' : 'fuel-btn inactive';
        }
    });
}

function selectVehicleColor(colorName) {
    const colorInput = document.getElementById('v-color');
    if (colorInput) {
        colorInput.value = colorName;
        const picker = document.getElementById('v-color-picker');
        if (picker && /^#[0-9A-F]{6}$/i.test(colorName)) {
            picker.value = colorName;
        }
    }
}

function selectVehicleSeats(count) {
    const hiddenInput = document.getElementById('v-seats');
    if (hiddenInput) hiddenInput.value = count;
    ['2','4','5','6','7','8'].forEach(n => {
        const btn = document.getElementById(`seats-${n}`);
        if (btn) btn.className = n === String(count) ? 'fuel-btn active' : 'fuel-btn inactive';
    });
}

// --- Brand favicon domains (Google Favicon API) ---
const BRAND_FAVICON = {
    'Maruti Suzuki':  'marutisuzuki.com',
    'Hyundai':        'hyundai.com',
    'Tata':           'tatamotors.com',
    'Mahindra':       'mahindra.com',
    'Honda':          'honda.com',
    'Toyota':         'toyota.com',
    'Kia':            'kia.com',
    'MG':             'mgmotor.co.in',
    'Skoda':          'skoda-auto.com',
    'Volkswagen':     'volkswagen.com',
    'Renault':        'renault.com',
    'Nissan':         'nissan.com',
    'Ford':           'ford.com',
    'Jeep':           'jeep.com',
    'BMW':            'bmw.in',
    'Mercedes-Benz':  'mercedes-benz.com',
    'Audi':           'audi.com',
    'Volvo':          'volvocars.com',
    'Jaguar':         'jaguar.com',
    'Land Rover':     'landrover.com',
    'Porsche':        'porsche.com',
    'Ferrari':        'ferrari.com',
    'Lamborghini':    'lamborghini.com',
    'Rolls-Royce':    'rolls-roycemotorcars.com',
    'Bentley':        'bentleymotors.com',
    'Maserati':       'maserati.com',
    'MINI':           'mini.com',
    'Fiat':           'fiat.com',
    'Chevrolet':      'chevrolet.com',
    'Isuzu':          'isuzu.com',
    'Lexus':          'lexus.com',
    'Mitsubishi':     'mitsubishi-motors.com',
    'Subaru':         'subaru.com',
    'Mazda':          'mazda.com',
    'BYD':            'byd.com',
    'Peugeot':        'peugeot.com',
    'Haval':          'haval.com',
    'Opel':           'opel.com',
    'Datsun':         'datsun.com',
    // Bikes
    'Hero':           'heromotocorp.com',
    'Bajaj':          'bajajauto.com',
    'TVS':            'tvsmotor.com',
    'Royal Enfield':  'royalenfield.com',
    'Yamaha':         'yamaha-motor.com',
    'Suzuki':         'suzuki.com',
    'KTM':            'ktm.com',
    'Kawasaki':       'kawasaki.com',
    'Ducati':         'ducati.com',
    'Triumph':        'triumphmotorcycles.com',
    'Harley-Davidson':'harley-davidson.com',
    'BMW Motorrad':   'bmw-motorrad.com',
    'Aprilia':        'aprilia.com',
    'Vespa':          'vespa.com',
    'Jawa':           'jawamotorcycles.com',
    'Ather':          'atherenergy.com',
    'Ola Electric':   'olaelectric.com',
    'Revolt':         'revoltmotors.com',
    'Benelli':        'benelli.com',
    'Husqvarna':      'husqvarna.com',
    'Indian':         'indianmotorcycle.com',
};

function getBrandInitials(name) {
    return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

// --- Make Searchable Dropdown Autocomplete Filter ---
function filterMakes(query) {
    const mainCategory = document.getElementById('v-main-category').value || 'Car';
    const brands = VEHICLE_BRANDS[mainCategory] || [];
    const dropdown = document.getElementById('make-dropdown');
    if (!dropdown) return;

    const filtered = brands.filter(b => b.toLowerCase().includes(query.toLowerCase()));
    if (filtered.length === 0) { dropdown.style.display = 'none'; return; }

    dropdown.innerHTML = filtered.map(b => {
        const initials = getBrandInitials(b);
        const domain   = BRAND_FAVICON[b];
        const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=128` : null;
        
        const innerHtml = faviconUrl
            ? `<img src="${faviconUrl}" alt="${b}" class="brand-favicon-img"
                   onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
               <span class="brand-favicon-fallback" style="display:none; color: #a1a1aa;">${initials}</span>`
            : `<span class="brand-favicon-fallback" style="color: #a1a1aa;">${initials}</span>`;
            
        return `
        <div class="search-dropdown-item" onclick="selectMake('${b.replace(/'/g, "\\'")}')"> 
            <div class="brand-favicon-wrap">${innerHtml}</div>
            <span>${b}</span>
        </div>`;
    }).join('');
    dropdown.style.display = 'block';
}





function selectMake(make) {
    document.getElementById('v-make').value = make;
    document.getElementById('make-dropdown').style.display = 'none';
    document.getElementById('v-model').focus();
}

// Hide dropdown when clicking outside
document.addEventListener('click', (e) => {
    const makeDropdown = document.getElementById('make-dropdown');
    if (makeDropdown && !e.target.closest('#v-make') && !e.target.closest('#make-dropdown')) {
        makeDropdown.style.display = 'none';
    }
});

// --- Photo Preview ---
window.activePhotoFile = null;
function previewVehiclePhoto(input) {
    const file = input.files[0];
    if (!file) return;
    window.activePhotoFile = file;
    const reader = new FileReader();
    reader.onload = (e) => {
        const preview = document.getElementById('v-photo-preview');
        if (preview) {
            preview.src = e.target.result;
            preview.style.display = 'block';
        }
        const labelText = document.getElementById('photo-label-text');
        if (labelText) labelText.textContent = file.name;
    };
    reader.readAsDataURL(file);
}

// --- Actions ---
async function saveVehicle() {
    const editId = document.getElementById('v-edit-id')?.value;
    const rawPlate = document.getElementById('v-plate').value.trim().toUpperCase();
    const plate = rawPlate.replace(/\s+/g, '');
    const make = document.getElementById('v-make').value.trim();
    const model = document.getElementById('v-model').value.trim();
    const typeEl = document.querySelector('input[name="v-type"]:checked');
    const type = typeEl ? typeEl.value : 'Car';
    const fuel = document.getElementById('v-fuel') ? document.getElementById('v-fuel').value : 'Petrol';
    const transmission = document.getElementById('v-transmission') ? document.getElementById('v-transmission').value : 'Manual';
    const color = document.getElementById('v-color') ? document.getElementById('v-color').value : 'White';
    const seats = document.getElementById('v-seats') ? document.getElementById('v-seats').value : '5';
    const photoFile = window.activePhotoFile;

    if (!plate || !make || !model) {
        showToast('Please fill in all vehicle details.', 'error');
        return;
    }

    const plateRegex = /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{1,4}$/;
    if (!plateRegex.test(plate)) {
        showToast('Invalid Registration Number format. E.g. MH 12 AB 1234', 'error');
        return;
    }

    // Read photo as base64 if provided
    let photoBase64 = null;
    if (photoFile) {
        photoBase64 = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.readAsDataURL(photoFile);
        });
    }

    // Double-click guard
    const saveBtn = document.querySelector('.vehicle-form-container .btn');
    const origBtnText = saveBtn ? saveBtn.innerHTML : 'Save Vehicle';
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = 'Saving...';
    }

    try {
        // Frontend duplicate check
        const cleanNewPlate = plate.replace(/\s+/g, '').toUpperCase();
        if (!editId) {
            const isDup = userVehicles.some(v => v.plate && v.plate.replace(/\s+/g, '').toUpperCase() === cleanNewPlate);
            if (isDup) {
                showToast('You have already added a vehicle with this registration number.', 'error');
                if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = origBtnText; }
                return;
            }
        }

        const payload = {
            customerId: currentUser.id,
            plate, make, model, type, fuel, transmission, color, seats,
            makeModel: `${make} ${model}`,
        };
        if (photoBase64) payload.photo = photoBase64;

        if (editId) {
            await apiPut(`/vehicles/${editId}`, payload);
            showToast('Vehicle updated successfully!', 'success');
            // Update local array
            const idx = userVehicles.findIndex(v => v.id === editId);
            if (idx !== -1) Object.assign(userVehicles[idx], payload);
        } else {
            payload.id = `veh_${generateId()}`;
            await apiPost('/vehicles', payload);
            userVehicles.push(payload);
            showToast('Vehicle added successfully!', 'success');
        }

        hideVehicleForm();
        if (!editId && (!currentUser.name || currentUser.name === 'New Partner' || !currentUser.email)) {
            document.getElementById('ud-pending-vehicle-id').value = payload.id;
            window.userProfileTriggeredByBooking = false;
            document.getElementById('user-details-modal').style.display = 'flex';
        } else {
            loadDashboard();
        }
    } catch (err) {
        console.error("Save Vehicle Error:", err);
        showToast(err.message || 'Failed to save vehicle', 'error');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = origBtnText;
        }
    }
}

function editVehicle(id) {
    const v = userVehicles.find(v => v.id === id);
    if (!v) return;

    showVehicleForm();
    document.getElementById('vehicle-form-title').textContent = 'Edit Vehicle';
    document.getElementById('btn-submit-vehicle').textContent = 'Update Vehicle';

    document.getElementById('v-edit-id').value = v.id;
    document.getElementById('v-plate').value = v.plate;
    // Note: v-make and v-model are set AFTER changeVehicleCategory()
    // because changeVehicleCategory() clears v-make

    // Detect category from v.type — must happen before restoring make/model
    const isBike = v.type === 'Bike';
    if (isBike) {
        changeVehicleCategory('Bike');
        selectTransmission(v.transmission || 'Gear');
    } else {
        changeVehicleCategory('Car');
        selectCarSubtype(v.type || 'Hatchback');
    }
    selectFuel(v.fuel || 'Petrol');

    // Restore color selection
    if (v.color) selectVehicleColor(v.color);

    // Restore seats selection
    if (v.seats) selectVehicleSeats(v.seats);

    // Restore make and model LAST (after changeVehicleCategory clears them)
    document.getElementById('v-make').value = v.make || '';
    document.getElementById('v-model').value = v.model || '';

    let displayPhoto = v.photo;
    if (!displayPhoto) {
        const lowerType = (v.type || 'Hatchback').toLowerCase();
        if (lowerType.includes('bike') || lowerType.includes('motorcycle')) {
            displayPhoto = 'images/bike.png';
        } else if (lowerType.includes('suv')) {
            displayPhoto = 'images/suv.png';
        } else if (lowerType.includes('sedan')) {
            displayPhoto = 'images/sedan.png';
        } else {
            displayPhoto = 'images/sedan.png';
        }
    }

    if (displayPhoto) {
        const preview = document.getElementById('v-photo-preview');
        preview.src = displayPhoto;
        preview.style.display = 'block';
        document.getElementById('photo-label-text').textContent = v.photo ? 'Click to change photo' : 'Tap to upload vehicle photo';
    }
}

async function deleteVehicle(id) {
    const result = await Swal.fire({
        title: 'Delete Vehicle?',
        text: 'Are you sure you want to delete this vehicle?',
        icon: 'warning',
        background: '#1C1F26',
        color: '#fff',
        showCancelButton: true,
        confirmButtonText: 'Delete',
        cancelButtonText: 'Cancel',
        confirmButtonColor: '#ef4444',
        cancelButtonColor: '#4b5563',
        customClass: { popup: 'sweet-alert-dark-popup' }
    });
    
    if (!result.isConfirmed) return;

    try {
        await apiDelete(`/vehicles/${id}`);
        showToast('Vehicle deleted', 'success');
        loadDashboard();
    } catch (err) {
        console.error(err);
        showToast('Failed to delete vehicle', 'error');
    }
}



function cancelOldRequestAndRetry() {
    // Cancel any stale/returned request so it disappears from Marshal feed
    if (window.currentPendingRequestId) {
        const oldId = window.currentPendingRequestId;
        apiPatch('/service-requests/' + oldId, { status: 'cancelled' })
            .catch(e => console.warn('Could not cancel old request:', e));
        window.currentPendingRequestId = null;
    }
    // Now retry with the same vehicle immediately without blocking
    findMarshal(activeBookingVehicleId, true);
}

async function findMarshal(vehicleId, bypassActiveCheck = false) {
    if (!vehicleId || vehicleId.startsWith('Please') || vehicleId === '') {
        showToast('Please add and select a vehicle first.', 'error');
        return;
    }

    if (!bypassActiveCheck) {
        // ── ORDER CYCLE: Block re-booking if vehicle already has active trip ─────
        try {
            const allRequests = await apiGet('/requests');
            const myReqs = allRequests.filter(r => (r.customerId || r.customerid) === currentUser.id);
            const existingActive = myReqs.find(r =>
                (r.vehicleId || r.vehicleid) === vehicleId &&
                !['pending', 'scheduled', 'completed', 'cancelled', 'returned', 'drop_completed'].includes(r.status)
            );
            if (existingActive) {
                showToast('This vehicle already has an active service request. Track your current order.', 'error');
                // If there's an active trip for this request, jump to tracking screen
                const allTrips = await apiGet('/trips');
                const activeTrip = allTrips.find(t =>
                    (t.serviceRequestId || t.servicerequestid) === existingActive.id &&
                    !['completed'].includes(t.status)
                );
                if (activeTrip) {
                    sessionStorage.removeItem('minimizeEnRoute');
                    showMarshalEnRoute(activeTrip);
                }
                return;
            }
        } catch(e) { console.warn('Pre-booking check failed:', e); }
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (window.bookingFlow !== 'p2p' && !window.selectedGarageId) {
        showToast('Please select a nearby partner garage from the Garage menu first.', 'error');
        switchTab('focus-garage');
        return;
    }


    // Retrieve selected location selector details (lat, lng, pickup address)
    const locInput = document.getElementById(`pickup-location-global`);
    const dropInput = document.getElementById(`drop-location-global`);
    let lat = 19.0760; // fallback Mumbai lat
    let lng = 72.8777; // fallback Mumbai lng
    let pickupAddress = '';
    let dropAddress = '';
    
    if (locInput) {
        pickupAddress = (locInput.value.trim() || locInput.getAttribute('data-address') || '').trim();
        const dataLat = locInput.getAttribute('data-lat');
        const dataLng = locInput.getAttribute('data-lng');
        if (dataLat && dataLng) {
            lat = parseFloat(dataLat);
            lng = parseFloat(dataLng);
        } else {
            lat = 19.0760 + (Math.random() - 0.5) * 0.02;
            lng = 72.8777 + (Math.random() - 0.5) * 0.02;
        }
    }
    
    if (dropInput) {
        dropAddress = dropInput.value.trim();
    }
    
    if (!pickupAddress || !dropAddress) {
        showToast('Please choose location', 'error');
        return;
    }

    // Validation: Pickup and Drop location cannot be the same without stops
    if (locInput && dropInput) {
        const pLat = parseFloat(locInput.getAttribute('data-lat'));
        const pLng = parseFloat(locInput.getAttribute('data-lng'));
        const dLat = parseFloat(dropInput.getAttribute('data-lat'));
        const dLng = parseFloat(dropInput.getAttribute('data-lng'));
        
        const coordsMatch = !isNaN(pLat) && !isNaN(pLng) && !isNaN(dLat) && !isNaN(dLng) && (Math.abs(pLat - dLat) < 0.0001 && Math.abs(pLng - dLng) < 0.0001);
        const addressMatch = pickupAddress.toLowerCase() === dropAddress.toLowerCase();
        
        if ((coordsMatch || addressMatch) && (!window.routeStops || window.routeStops.length === 0)) {
            showToast("Pickup and drop location cannot be the same unless a route stop is added.", "error");
            return;
        }
    }
    
    // If there is an active pending request already, cancel it first
    if (window.currentPendingRequestId) {
        apiPatch(`/service-requests/${window.currentPendingRequestId}`, { status: 'cancelled' })
            .catch(e => console.warn('Failed to cancel request on backend:', e));
        window.currentPendingRequestId = null;
    }

    activeBookingVehicleId = vehicleId;

    const btn = document.getElementById('btn-request-service');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<svg class="spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:middle; margin-right:8px;"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg> Searching for Nearby Driver...';
    } else {
        showToast('Searching for Nearby Driver...', 'info');
    }

    const instantBtn = document.getElementById('btn-request-service-instant') || document.getElementById('flow-btn-confirm-instant');
    if (instantBtn) {
        instantBtn.disabled = true;
        instantBtn.innerHTML = '<svg class="spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:middle; margin-right:8px;"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg> Searching...';
    }

    // Show new map overlay
    const fmScreen = document.getElementById('finding-marshal-screen');
    if (fmScreen) fmScreen.style.display = 'flex';
    
    const backBtn = document.getElementById('btn-back-marshal-search');
    if (backBtn) backBtn.style.display = 'none';
    
    // Set vehicle name and image
    const v = userVehicles.find(v => v.id === vehicleId);
    if (v) {
        const fmName = document.getElementById('fm-vehicle-name');
        if (fmName) fmName.textContent = `${v.make} ${v.model}`;

        const fmImg = document.getElementById('fm-vehicle-image');
        const fmImgContainer = fmImg ? fmImg.parentElement : null;
        if (fmImg && fmImgContainer) {
            // Build image src same way vehicle card does
            let imgSrc = '';
            if (v.photo) {
                imgSrc = v.photo;
            } else {
                const lowerType = (v.type || '').toLowerCase();
                if (lowerType.includes('bike') || lowerType.includes('motorcycle')) imgSrc = 'images/bike.png';
                else if (lowerType.includes('suv')) imgSrc = 'images/suv.png';
                else if (lowerType.includes('hatchback')) imgSrc = 'images/hatchback.png';
                else imgSrc = 'images/sedan.png';
            }
            if (imgSrc) {
                fmImg.src = imgSrc;
                fmImgContainer.style.display = 'flex';
            } else {
                fmImgContainer.style.display = 'none';
            }
        }
    }

    // Restore radar animation and stop/retry button visibility
    const pulses = document.querySelectorAll('.radar-pulse');
    pulses.forEach((p, idx) => {
        p.style.animation = 'radar-ping 2s cubic-bezier(0, 0, 0.2, 1) infinite';
        p.style.animationDelay = idx === 0 ? '0s' : (idx === 1 ? '0.6s' : '1.2s');
    });

    const stopContainer = document.getElementById('fm-stop-container');
    if (stopContainer) stopContainer.style.display = 'flex';

    // Reset UI states
    const statusText = document.getElementById('fm-status-text');
    if (statusText) statusText.textContent = 'Searching for nearby drivers within 5 KM...';

    const progContainer = document.getElementById('fm-progress-container');
    if (progContainer) progContainer.style.display = 'flex';

    const retryContainer = document.getElementById('fm-retry-container');
    if (retryContainer) retryContainer.style.display = 'none';

    // Animate progress bar with 60s countdown
    let remainingSeconds = 60;
    const bar = document.getElementById('fm-progress-bar');
    const text = document.getElementById('fm-progress-text');
    
    if (bar && text) {
        bar.style.width = '0%';
        text.textContent = '60s';

        window.fmInterval = setInterval(() => {
            remainingSeconds -= 1;
            if (remainingSeconds < 0) remainingSeconds = 0;
            text.textContent = remainingSeconds + 's';
            
            const elapsed = 60 - remainingSeconds;
            const pct = (elapsed / 60) * 100;
            bar.style.width = pct + '%';
        }, 1000);
    }

    let elapsedSeconds = 0;
    let searchStage = 1;
    const reqId = 'req_' + generateId();

    try {
        const activeVehicle = userVehicles.find(v => v.id === vehicleId);
        const isBike = activeVehicle && (String(activeVehicle.type).toLowerCase() === 'bike' || String(activeVehicle.category).toLowerCase() === 'bike');
        const vehicleType = isBike ? 'bike' : 'car';

        const rateKey = `${vehicleType}_customer_rate_per_km`;
        const baseFareKey = `${vehicleType}_base_fare`;
        const haltRateKey = `${vehicleType}_halt_rate_per_min`;
        
        const ratePerKm = window.redrivoSystemSettings?.[rateKey] !== undefined ? parseFloat(window.redrivoSystemSettings[rateKey]) : (vehicleType === 'car' ? 15 : 8);
        const baseFare = window.redrivoSystemSettings?.[baseFareKey] !== undefined ? parseFloat(window.redrivoSystemSettings[baseFareKey]) : (vehicleType === 'car' ? 150 : 50);
        const haltRate = window.redrivoSystemSettings?.[haltRateKey] !== undefined ? parseFloat(window.redrivoSystemSettings[haltRateKey]) : (vehicleType === 'car' ? 5 : 3);

        let redrivoServiceCharge = currentServiceType === 'TrackA' ? 299 : 99;
        let inspectionFee = currentServiceType === 'TrackB' ? 250 : 0;
        let distance = 0;
        const pickupInput = document.getElementById('pickup-location-global');
        const dropInput = document.getElementById('drop-location-global');
        if (pickupInput && dropInput) {
            const pLat = parseFloat(pickupInput.getAttribute('data-lat'));
            const pLng = parseFloat(pickupInput.getAttribute('data-lng'));
            const dLat = parseFloat(dropInput.getAttribute('data-lat'));
            const dLng = parseFloat(dropInput.getAttribute('data-lng'));
            if (!isNaN(pLat) && !isNaN(pLng) && !isNaN(dLat) && !isNaN(dLng)) {
                distance = window.calculatedRouteDistance || calcDistanceKm(pLat, pLng, dLat, dLng);
            }
        }
        let pdCharge = 0;
        if (currentPDType !== 'None') {
            const baseCharge = Math.max(baseFare, Math.round(distance * ratePerKm));
            pdCharge = currentPDType === 'Both' ? baseCharge * 2 : baseCharge;
        }

        // Calculate halt charge
        let totalHaltMinutes = 0;
        if (window.routeStops && Array.isArray(window.routeStops)) {
            window.routeStops.forEach(stop => {
                totalHaltMinutes += parseInt(stop.haltTime) || 0;
            });
        }
        const haltCharge = totalHaltMinutes * haltRate;

        const pricingMode = document.getElementById('booking-pricing-mode') ? document.getElementById('booking-pricing-mode').value : 'distance';
        const estimatedHours = document.getElementById('booking-estimated-hours') ? parseFloat(document.getElementById('booking-estimated-hours').value) : 4;

        let total = 0;
        if (pricingMode === 'hourly') {
            const hourlyRate = parseFloat(window.redrivoSystemSettings?.[`${vehicleType}_hourly_rate`] || (vehicleType === 'car' ? 150 : 80));
            total = estimatedHours * hourlyRate;
        } else {
            total = redrivoServiceCharge + inspectionFee + pdCharge + haltCharge;
        }

        // Definition of 60s driver search countdown & bid polling
        const proceedWithSearch = (verifiedRequestId, paidAmount) => {
            window.currentPendingRequestId = verifiedRequestId;

            // Show finding marshal screen
            const fmScreen = document.getElementById('finding-marshal-screen');
            if (fmScreen) fmScreen.style.display = 'block';

            const statusText = document.getElementById('fm-status-text');
            if (statusText) {
                statusText.innerHTML = `Searching for verified nearby drivers...<br><span style="font-size:0.75rem; color:#22c55e; font-weight:700;">✓ ₹${paidAmount} Advance Held in Escrow (100% Auto-Refunded if unmatched)</span>`;
            }

            // Start 60s countdown timer
            let remainingSeconds = 60;
            const bar = document.getElementById('fm-progress-bar');
            const text = document.getElementById('fm-progress-text');
            if (bar && text) {
                bar.style.width = '0%';
                text.textContent = '60s';
                if (window.fmInterval) clearInterval(window.fmInterval);
                window.fmInterval = setInterval(() => {
                    remainingSeconds -= 1;
                    if (remainingSeconds < 0) remainingSeconds = 0;
                    text.textContent = remainingSeconds + 's';
                    const elapsed = 60 - remainingSeconds;
                    bar.style.width = ((elapsed / 60) * 100) + '%';
                }, 1000);
            }

            let elapsedSeconds = 0;
            let searchStage = 1;

            if (window.bookingPollInterval) clearInterval(window.bookingPollInterval);
            window.bookingPollInterval = setInterval(async () => {
                elapsedSeconds += 2;

                if (searchStage === 1 && elapsedSeconds >= 10) {
                    searchStage = 2;
                    if (statusText) statusText.innerHTML = `Expanding search radius to 10 KM...<br><span style="font-size:0.75rem; color:#22c55e; font-weight:700;">✓ ₹${paidAmount} Advance in Escrow</span>`;
                } else if (searchStage === 2 && elapsedSeconds >= 20) {
                    searchStage = 3;
                    if (statusText) statusText.innerHTML = `Expanding search radius to 15 KM...<br><span style="font-size:0.75rem; color:#22c55e; font-weight:700;">✓ ₹${paidAmount} Advance in Escrow</span>`;
                } else if (searchStage === 3 && elapsedSeconds >= 60) {
                    searchStage = 4;
                    clearInterval(window.bookingPollInterval);
                    if (window.fmInterval) clearInterval(window.fmInterval);

                    const progContainer = document.getElementById('fm-progress-container');
                    if (progContainer) progContainer.style.display = 'none';
                    const stopContainer = document.getElementById('fm-stop-container');
                    if (stopContainer) stopContainer.style.display = 'none';
                    const retryContainer = document.getElementById('fm-retry-container');
                    if (retryContainer) retryContainer.style.display = 'block';

                    const backBtn = document.getElementById('btn-back-marshal-search');
                    if (backBtn) backBtn.style.display = 'block';

                    try {
                        const refundRes = await apiPost('/customer/booking/timeout-refund', { requestId: verifiedRequestId });
                        if (statusText) {
                            statusText.innerHTML = `All drivers are currently busy.<br><span style="color:#22c55e; font-weight:700;">✓ ₹${paidAmount} 100% Refunded to your original payment method.</span>`;
                        }
                        showToast(`Search timed out. ₹${paidAmount} refunded automatically.`, 'success');
                    } catch (eRef) {
                        console.warn('Timeout refund error:', eRef);
                        if (statusText) statusText.textContent = 'All drivers are currently busy.';
                    }
                    return;
                }

                try {
                    const bids = await apiGet(`/service-requests/${verifiedRequestId}/bids`);
                    const bidsContainer = document.getElementById('fm-bids-container');
                    const bidsList = document.getElementById('fm-bids-list');
                    if (bids && bids.length > 0) {
                        if (bidsContainer) bidsContainer.style.display = 'flex';
                        bids.sort((a, b) => a.distance - b.distance);
                        if (bidsList) {
                            bidsList.innerHTML = bids.map(bid => {
                                const photoUrl = bid.photo || `https://i.pravatar.cc/100?img=${Math.floor(10 + Math.random() * 20)}`;
                                return `
                                    <div style="display:flex; justify-content:space-between; align-items:center; background: rgba(255,255,255,0.05); padding: 10px 14px; border-radius: 12px; margin-bottom: 8px; border: 1px solid rgba(255,255,255,0.08);">
                                        <div style="display:flex; align-items:center; gap: 10px;">
                                            <img src="${photoUrl}" style="width:36px; height:36px; border-radius:50%; object-fit:cover;">
                                            <div>
                                                <div style="font-weight:700; font-size:0.85rem; color:#fff;">${bid.marshalName || 'Verified Driver'}</div>
                                                <div style="font-size:0.7rem; color:var(--text-muted);">${bid.distance ? bid.distance.toFixed(1) + ' km away' : 'Nearby'} • ⭐ ${bid.rating || '5.0'}</div>
                                            </div>
                                        </div>
                                        <div style="text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 4px;">
                                            <div style="font-size: 0.75rem; color: var(--text-muted); font-weight: 500;">
                                                ${bid.distance ? bid.distance.toFixed(1) + ' km' : 'Nearby'} (${bid.eta || 5} mins)
                                            </div>
                                            <button onclick="selectMarshalForRequest('${verifiedRequestId}', '${bid.marshalId}', ${paidAmount})" style="background: #10B981; color: #000; font-weight: 800; border: none; padding: 6px 14px; border-radius: 30px; font-size: 0.75rem; cursor: pointer; transition: all 0.2s; box-shadow: 0 4px 10px rgba(16, 185, 129, 0.2);">
                                                ACCEPT
                                            </button>
                                        </div>
                                    </div>
                                `;
                            }).join('');
                        }
                    }
                } catch (errPoll) {
                    console.warn('Error polling for marshal bids:', errPoll);
                }
            }, 2000);

            // Global select function definition
            window.selectMarshalForRequest = async function(reqId, marshalId, totalVal) {
                const buttons = document.querySelectorAll('#fm-bids-list button');
                buttons.forEach(btnEl => {
                    btnEl.disabled = true;
                    btnEl.textContent = '...';
                });
                
                try {
                    const res = await apiPost(`/service-requests/${reqId}/select-marshal`, { marshalId });
                    if (res && res.tripId) {
                        clearInterval(window.bookingPollInterval);
                        if (window.fmInterval) clearInterval(window.fmInterval);
                        
                        const fmScreen = document.getElementById('finding-marshal-screen');
                        if (fmScreen) fmScreen.style.display = 'none';
                        
                        const btn = document.getElementById('btn-request-service');
                        if (btn) {
                            btn.disabled = false;
                            btn.innerHTML = 'Search for Nearby Driver';
                        }
                        
                        window.currentActiveTripId = res.tripId;
                        
                        const amtDisplay = document.getElementById('payment-amount-display');
                        if (amtDisplay) {
                            amtDisplay.textContent = `₹${Math.round(totalVal)}`;
                        }
                        
                        if (typeof window.startPaymentCountdown === 'function') {
                            window.startPaymentCountdown(res.tripId);
                        }
                        
                        const paymentModal = document.getElementById('payment-modal');
                        if (paymentModal) paymentModal.style.display = 'flex';
                    } else {
                        showToast('Failed to select driver. Please try again.', 'error');
                        buttons.forEach(btnEl => { btnEl.disabled = false; btnEl.textContent = 'ACCEPT'; });
                    }
                } catch (e) {
                    console.error('Error selecting marshal:', e);
                    showToast('Selection failed: ' + e.message, 'error');
                    buttons.forEach(btnEl => { btnEl.disabled = false; btnEl.textContent = 'ACCEPT'; });
                }
            };
        };

        // Safety Kill Switch: Active only if global flag is true, OR strictly for test user (phone 9999999999 / ?test_advance=true)
        const isAdvancePaymentActive = window.ENABLE_CUSTOMER_ADVANCE_PAYMENT ||
            (currentUser && (currentUser.phone === '9999999999' || currentUser.phone === '+919999999999' || String(currentUser.phone).endsWith('9999999999'))) ||
            new URLSearchParams(window.location.search).get('test_advance') === 'true';

        if (!isAdvancePaymentActive) {
            const reqRes = await apiPost('/service-requests', {
                id: reqId,
                customerId: currentUser.id,
                vehicleId,
                garageId: window.selectedGarageId,
                date: new Date().toISOString().split('T')[0],
                issue: 'Pending Driver Inspection',
                serviceType: 'HealthCheck',
                bookingFlow: window.bookingFlow || 'p2p',
                pickupDropType: window.pickupDropType || 'Pickup',
                pickupDropCost: pdCharge,
                garageServiceCharge: 0,
                gstAmount: 0,
                totalCustomerPrice: total,
                lat,
                lng,
                pickup_address: pickupAddress,
                drop_address: dropAddress,
                route_stops: window.routeStops || [],
                vehicle_condition: window.selectedVehicleCondition || 'Working',
                status: 'pending',
                distanceKm: distance,
                pricingMode,
                estimatedHours
            });
            proceedWithSearch(reqId, total);
            return;
        }

        // Advance Payment Enabled (Gated / Verified mode)
        const orderPayload = {
            customerId: currentUser.id,
            vehicleId,
            garageId: window.selectedGarageId,
            lat,
            lng,
            pickup_address: pickupAddress,
            drop_address: dropAddress,
            distanceKm: distance,
            pricingMode,
            estimatedHours,
            vehicleType,
            vehicleCondition: window.selectedVehicleCondition || 'Working',
            routeStops: window.routeStops || [],
            issue: 'Pending Driver Inspection',
            serviceType: 'HealthCheck',
            bookingFlow: window.bookingFlow || 'p2p',
            pickupDropType: window.pickupDropType || 'Pickup'
        };

        const orderRes = await apiPost('/customer/booking/create-order', orderPayload);
        if (!orderRes || !orderRes.orderId) {
            throw new Error(orderRes?.error || 'Failed to initialize payment order');
        }

        if (window.Razorpay) {
            const options = {
                key: orderRes.keyId,
                amount: orderRes.amount,
                currency: orderRes.currency || 'INR',
                name: 'ReDrivo — Ride Advance Payment',
                description: 'Advance Fare Deposit (100% Escrow Guarantee)',
                order_id: orderRes.orderId,
                prefill: {
                    name: currentUser.name || 'Valued Customer',
                    contact: currentUser.phone || '9999999999',
                    email: currentUser.email || 'customer@redrivo.com'
                },
                theme: { color: '#FACC15' },
                handler: async function (response) {
                    try {
                        showToast('Verifying advance payment...', 'info');
                        const verifyRes = await apiPost('/customer/booking/verify-advance', {
                            orderId: response.razorpay_order_id || orderRes.orderId,
                            paymentId: response.razorpay_payment_id,
                            signature: response.razorpay_signature,
                            draftRequestId: orderRes.draftRequestId
                        });
                        if (!verifyRes.success) throw new Error(verifyRes.error || 'Signature verification failed');
                        showToast('Advance payment secured! Searching drivers...', 'success');
                        proceedWithSearch(orderRes.draftRequestId, orderRes.amountInRupees);
                    } catch (eVer) {
                        console.error('Advance verification failed:', eVer);
                        showToast('Payment verification failed: ' + eVer.message, 'error');
                        const btn = document.getElementById('btn-request-service');
                        if (btn) { btn.disabled = false; btn.innerHTML = 'Search for Nearby Driver'; }
                    }
                },
                modal: {
                    ondismiss: function() {
                        showToast('Advance payment cancelled. Booking not placed.', 'info');
                        const btn = document.getElementById('btn-request-service');
                        if (btn) { btn.disabled = false; btn.innerHTML = 'Search for Nearby Driver'; }
                    }
                }
            };
            const rzp = new Razorpay(options);
            rzp.on('payment.failed', function (resp) {
                showToast('Payment Failed: ' + (resp.error?.description || 'Gateway error'), 'error');
                const btn = document.getElementById('btn-request-service');
                if (btn) { btn.disabled = false; btn.innerHTML = 'Search for Nearby Driver'; }
            });
            rzp.open();
        } else {
            proceedWithSearch(orderRes.draftRequestId, orderRes.amountInRupees);
        }
    } catch (errCreate) {
        // Network error (server may be starting) — retry with friendlier message
        const statusText = document.getElementById('fm-status-text');
        const retryContainer = document.getElementById('fm-retry-container');
        const progContainer = document.getElementById('fm-progress-container');
        const stopContainer = document.getElementById('fm-stop-container');
        if (window.fmInterval) clearInterval(window.fmInterval);
        if (statusText) statusText.textContent = 'Unable to connect to server. Please check your connection.';
        if (progContainer) progContainer.style.display = 'none';
        if (stopContainer) stopContainer.style.display = 'none';
        if (retryContainer) retryContainer.style.display = 'block';
        console.error('Marshal search creation failed:', errCreate.message);
    }
}

async function cancelMarshalSearch() {
    if (window.fmTimeout) clearTimeout(window.fmTimeout);
    if (window.fmInterval) clearInterval(window.fmInterval);
    if (window.bookingPollInterval) clearInterval(window.bookingPollInterval);
    
    if (window.currentPendingRequestId) {
        try {
            const cancelRes = await apiPost('/customer/booking/cancel', {
                requestId: window.currentPendingRequestId,
                customerId: currentUser.id,
                reason: 'Customer stopped search'
            });
            if (cancelRes.refundAmount > 0) {
                showToast(`Booking cancelled. ₹${cancelRes.refundAmount.toFixed(2)} refunded automatically.`, 'success');
            } else {
                showToast('Booking search cancelled.', 'info');
            }
        } catch (e) {
            console.warn('Failed to cancel request with refund:', e);
            apiPatch(`/service-requests/${window.currentPendingRequestId}`, { status: 'cancelled' }).catch(() => {});
        }
        window.currentPendingRequestId = null;
    }

    window.bookingSubView = '2A';
    const instantBtn = document.getElementById('btn-request-service-instant') || document.getElementById('flow-btn-confirm-instant');
    if (instantBtn) {
        instantBtn.disabled = false;
        instantBtn.innerHTML = 'Search Driver';
    }

    const fmScreen = document.getElementById('finding-marshal-screen');
    if (fmScreen) fmScreen.style.display = 'none';
    const btn = document.getElementById('btn-request-service');
    if (btn) {
        btn.disabled = false;
        btn.innerHTML = 'Search for Nearby Driver';
    }
}
window.stopMarshalSearch = cancelMarshalSearch;

function closePaymentModal() {
    document.getElementById('payment-modal').style.display = 'none';
}

let selectedBookingMarshal = null;

async function selectRandomMarshal(workerId = null) {
    selectedBookingMarshal = null;
    if (workerId) {
        try {
            selectedBookingMarshal = await apiGet(`/users/${workerId}`);
        } catch (e) {
            console.warn('Failed to load specific marshal from database, using fallback', e);
        }
    }
    
    if (!selectedBookingMarshal) {
        try {
            const users = await apiGet('/users');
            const marshals = users.filter(u => u.role === 'marshal');
            if (workerId) {
                selectedBookingMarshal = marshals.find(u => u.id === workerId);
            } else if (marshals.length > 0) {
                selectedBookingMarshal = marshals[Math.floor(Math.random() * marshals.length)];
            }
        } catch (e) {
            console.warn('Failed to load marshals list', e);
        }
    }
    
    if (!selectedBookingMarshal) {
        selectedBookingMarshal = {
            id: workerId || 'm_1',
            name: 'Test Marshal',
            phone: '+919999999999',
            facephotourl: null
        };
    }
    
    // Determine vehicle details
    let vehicle = 'Honda Unicorn | MH 12 AB 9999';
    const lowerName = (selectedBookingMarshal.name || '').toLowerCase();
    if (selectedBookingMarshal.id === 'wkr_1776645406550' || lowerName.includes('mike')) {
        vehicle = 'Royal Enfield Classic 350 | MH 14 PQ 7777';
    } else if (selectedBookingMarshal.id === 'wkr_1779349297586' || lowerName.includes('siraj')) {
        vehicle = 'Hero Glamour | MH 12 CD 4444';
    } else if (selectedBookingMarshal.id === 'marshal_1780260781958' || selectedBookingMarshal.id === 'marshal_1782608426482' || lowerName.includes('alu')) {
        vehicle = 'KTM Duke 390 | MH 12 EF 1234';
    }
    
    // Set text details
    const nameEl = document.getElementById('found-marshal-name');
    if (nameEl) nameEl.textContent = selectedBookingMarshal.name;
    
    const vehEl = document.getElementById('found-marshal-vehicle');
    if (vehEl) vehEl.textContent = vehicle;
    
    // Set photo
    const photoEl = document.getElementById('found-marshal-photo');
    if (photoEl) {
        const host = API_URL.substring(0, API_URL.lastIndexOf('/api'));
        const activePhoto = selectedBookingMarshal.profilepictureurl || selectedBookingMarshal.profilePictureUrl || selectedBookingMarshal.facephotourl || selectedBookingMarshal.facePhotoUrl;
        const photoUrl = activePhoto 
            ? (activePhoto.startsWith('data:') ? activePhoto : `${host}/${activePhoto}`) 
            : getInitialsAvatar(selectedBookingMarshal.name);
        photoEl.src = photoUrl;
    }
}

async function simulatePayment() {
    sessionStorage.removeItem('minimizeEnRoute');
    if (window.paymentCountdownInterval) {
        clearInterval(window.paymentCountdownInterval);
    }
    
    // Disable payment button to prevent double-clicks
    const payBtn = document.querySelector('#payment-modal button.btn-success');
    if (payBtn) payBtn.disabled = true;

    try {
        if (window.currentActiveTripId) {
            await apiPost(`/trips/${window.currentActiveTripId}/confirm-payment`);
        } else {
            console.warn('No activeTripId found to confirm payment');
        }

        // 1. Close payment modal immediately
        const paymentModal = document.getElementById('payment-modal');
        if (paymentModal) paymentModal.style.display = 'none';
        const vehicleFormEl = document.getElementById('vehicle-form-elements');
        if (vehicleFormEl) vehicleFormEl.style.display = 'none';

        // 2. Show a loading overlay on the en-route screen while data fetches
        const enRouteScreen = document.getElementById('marshal-en-route-screen');
        const pickupAddrEl = document.getElementById('enroute-pickup-addr');
        const dropAddrEl = document.getElementById('enroute-drop-addr');
        const otpEl = document.getElementById('enroute-otp');
        if (enRouteScreen) enRouteScreen.style.display = 'flex';
        if (pickupAddrEl) pickupAddrEl.textContent = 'Loading…';
        if (dropAddrEl) dropAddrEl.textContent = 'Loading…';
        if (otpEl) otpEl.textContent = '----';

        const btn = document.getElementById('btn-request-service');
        if (btn) { btn.disabled = true; btn.innerHTML = 'Confirming…'; }

        window.currentPendingRequestId = null;
        window.bookingSubView = '2A';
        window.userManuallySelectedHours = false;
        // 3. Reload dashboard — this will find the active trip and call showMarshalEnRoute(trip)
        //    which populates addresses, OTP, timeline and starts map tracking
        await loadDashboard();
        showToast('Payment confirmed! Driver is on the way 🏁', 'success');
    } catch (e) {
        showToast(e.message || 'Failed to confirm payment. Please try again.', 'error');
        const enRouteScreen = document.getElementById('marshal-en-route-screen');
        if (enRouteScreen) enRouteScreen.style.display = 'none';
    } finally {
        if (payBtn) payBtn.disabled = false;
        const btn = document.getElementById('btn-request-service');
        if (btn) { btn.disabled = false; btn.innerHTML = 'Search for Nearby Driver'; }
    }
}

window.startPaymentCountdown = function(tripId) {
    if (window.paymentCountdownInterval) {
        clearInterval(window.paymentCountdownInterval);
    }
    
    let createdAtTime = Date.now();
    const timerText = document.getElementById('payment-countdown-timer');
    if (timerText) {
        timerText.textContent = '05:00';
    }

    // Asynchronously sync absolute creation time with backend to prevent timer drift
    fetch(`${API_URL}/trips`, { cache: 'no-store' })
        .then(res => {
            if (res.ok) return res.json();
        })
        .then(allTrips => {
            if (allTrips) {
                const trip = allTrips.find(t => t.id === tripId);
                if (trip && trip.createdAt) {
                    const parsed = Number(trip.createdAt) || Date.parse(trip.createdAt);
                    if (!isNaN(parsed)) {
                        createdAtTime = parsed;
                    }
                }
            }
        })
        .catch(e => console.warn('Failed to sync countdown timer with backend:', e));
    
    const updateCountdown = () => {
        const elapsed = Math.floor((Date.now() - createdAtTime) / 1000);
        const secondsLeft = Math.max(0, 300 - elapsed);
        
        if (secondsLeft <= 0) {
            clearInterval(window.paymentCountdownInterval);
            
            // Payment timed out! Close payment modal
            const paymentModal = document.getElementById('payment-modal');
            if (paymentModal) paymentModal.style.display = 'none';
            
            try {
                if (tripId) {
                    apiPost(`/trips/${tripId}/cancel-timeout`);
                }
                showToast('Booking cancelled due to payment timeout (5 minutes).', 'error');
            } catch (err) {
                console.warn('Failed to cancel timeout:', err);
            }
            
            // Reset search button
            const btn = document.getElementById('btn-request-service');
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = 'Search for Nearby Driver';
            }
            
            window.bookingSubView = '2A';
            window.userManuallySelectedHours = false;
            loadDashboard();
            return;
        }
        
        const min = Math.floor(secondsLeft / 60);
        const sec = secondsLeft % 60;
        if (timerText) {
            timerText.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
        }
    };
    
    updateCountdown();
    window.paymentCountdownInterval = setInterval(updateCountdown, 1000);
};

async function submitUserDetails() {
    const name = document.getElementById('ud-name').value.trim();
    const email = document.getElementById('ud-email').value.trim();
    
    if (!name && !email) {
        showToast('Please enter your full name and email.', 'error');
        return;
    } else if (!name) {
        showToast('Please enter your full name.', 'error');
        return;
    } else if (!email) {
        showToast('Please enter your email.', 'error');
        return;
    }
    
    // Update local user object
    currentUser.name = name;
    currentUser.email = email;
    localStorage.setItem('redrivo_current_user', JSON.stringify(currentUser));
    updateUserAvatar();
    
    // Dynamically update display name in UI
    const dispNameEl = document.getElementById('display-name');
    if (dispNameEl) dispNameEl.textContent = name;
    
    // Attempt backend update (non-blocking if it fails for demo)
    try {
        await apiPut(`/users/${currentUser.id}`, { name, email });
    } catch (e) {
        console.warn('Backend update failed for user details', e);
    }
    
    document.getElementById('user-details-modal').style.display = 'none';
    
    // Find marshal using the stored pending vehicle ID
    const pendingVehId = document.getElementById('ud-pending-vehicle-id').value;
    
    loadDashboard(); // make sure we're on the dashboard
    
    // Only proceed to booking options if userProfileTriggeredByBooking is true
    if (window.userProfileTriggeredByBooking && pendingVehId) {
        askVehicleCondition(pendingVehId, (condition) => {
            window.selectedVehicleCondition = condition;
            window.openBookingOptions(pendingVehId);
        });
    }
    window.userProfileTriggeredByBooking = false; // Reset unconditionally
}

// --- Session Persistence ---
document.addEventListener('DOMContentLoaded', () => {
    // Run system settings load now that Capacitor is fully ready
    loadSystemSettings();

    // Auto-select text on focus and show suggestions for pickup and drop inputs only if they are EDITABLE
    const globalPickupInput = document.getElementById('pickup-location-global');
    if (globalPickupInput) {
        globalPickupInput.addEventListener('focus', function() {
            if (!this.readOnly) {
                setTimeout(() => { this.select(); }, 50);
                showLocationPresets('global');
            }
        });
    }
    const globalDropInput = document.getElementById('drop-location-global');
    if (globalDropInput) {
        globalDropInput.addEventListener('focus', function() {
            if (!this.readOnly) {
                setTimeout(() => { this.select(); }, 50);
                showLocationPresets('global-drop');
            }
        });
    }
    const garagePickupInput = document.getElementById('pickup-location-garage');
    if (garagePickupInput) {
        garagePickupInput.addEventListener('focus', function() {
            if (!this.readOnly) {
                setTimeout(() => { this.select(); }, 50);
                showLocationPresets('garage');
            }
        });
    }
    const garageDropInput = document.getElementById('drop-location-garage');
    if (garageDropInput) {
        garageDropInput.addEventListener('focus', function() {
            if (!this.readOnly) {
                setTimeout(() => { this.select(); }, 50);
                showLocationPresets('garage-drop');
            }
        });
    }

    // Auto-advance to OTP when exactly 10 digits are entered
    const phoneInput = document.getElementById('su-phone');
    if (phoneInput) {
        phoneInput.addEventListener('input', () => {
            const val = phoneInput.value.trim();
            // Automatically trigger when exactly 10 digits are entered
            if (/^\d{10}$/.test(val) && val !== lastSentPhone) {
                if (otpCooldownSeconds > 0) return;
                lastSentPhone = val;
                handleSignupStep1();
            }
        });

        // Auto-verify OTP when exactly 6 digits are entered
        const suOtpInput = document.getElementById('su-otp');
        if (suOtpInput) {
            suOtpInput.addEventListener('input', () => {
                const val = suOtpInput.value.trim();
                if (/^\d{6}$/.test(val) && val !== lastVerifiedOtp) {
                    lastVerifiedOtp = val;
                    handleSignupStep2();
                }
            });
        }

        // Trigger Google Phone Number Hint API on focus (only on Android, once per session, when empty)
        let hasPromptedPhoneHint = false;
        phoneInput.addEventListener('focus', async () => {
            const val = phoneInput.value.trim();
            if (!val && !hasPromptedPhoneHint && window.Capacitor && window.Capacitor.isNativePlatform() && window.Capacitor.Plugins.AndroidSmsRetriever) {
                hasPromptedPhoneHint = true;
                try {
                    const result = await window.Capacitor.Plugins.AndroidSmsRetriever.getPhoneNumber();
                    if (result && result.phoneNumber) {
                        let cleaned = result.phoneNumber.trim();
                        // Strip +91 country code if present
                        if (cleaned.startsWith('+91')) {
                            cleaned = cleaned.substring(3);
                        }
                        // Clean non-digits
                        cleaned = cleaned.replace(/\D/g, '');
                        if (/^\d{10}$/.test(cleaned)) {
                            phoneInput.value = cleaned;
                            // Set lastSentPhone to prevent double calls from the input listener
                            lastSentPhone = cleaned;
                            // Explicitly trigger the OTP request
                            handleSignupStep1();
                        }
                    }
                } catch (err) {
                    console.warn('Google Phone Number Hint failed or was dismissed:', err);
                }
            }
        });
    }

    // Initialize Slide to Confirm elements
    const instantSlider = document.getElementById('slide-confirm-instant');
    if (instantSlider) {
        initSlideToConfirm(instantSlider, () => {
            confirmInstantBooking();
        });
    }
    const scheduleSlider = document.getElementById('slide-confirm-schedule');
    if (scheduleSlider) {
        initSlideToConfirm(scheduleSlider, () => {
            confirmScheduleBooking();
        });
    }

    // Initialize Unified Flow Slide to Confirm elements
    const flowInstantSlider = document.getElementById('flow-slide-confirm-instant');
    if (flowInstantSlider) {
        initSlideToConfirm(flowInstantSlider, () => {
            confirmGarageFlowInstantBooking();
        });
    }
    const flowScheduleSlider = document.getElementById('flow-slide-confirm-schedule');
    if (flowScheduleSlider) {
        initSlideToConfirm(flowScheduleSlider, () => {
            confirmGarageFlowScheduleBooking();
        });
    }

    // Validate token expiration on boot. If expired or missing, clear the stored session.
    (function validateTokenOnBoot() {
        const token = localStorage.getItem('redrivo_token');
        if (token) {
            try {
                const payload = JSON.parse(atob(token.split('.')[1]));
                if (payload && payload.exp) {
                    const nowSec = Math.floor(Date.now() / 1000);
                    if (payload.exp < nowSec) {
                        console.warn("Session expired on boot. Clearing storage credentials.");
                        localStorage.removeItem('redrivo_current_user');
                        localStorage.removeItem('redrivo_token');
                    }
                } else {
                    localStorage.removeItem('redrivo_current_user');
                    localStorage.removeItem('redrivo_token');
                }
            } catch (e) {
                localStorage.removeItem('redrivo_current_user');
                localStorage.removeItem('redrivo_token');
            }
        } else {
            localStorage.removeItem('redrivo_current_user');
        }
    })();

    const savedUser = localStorage.getItem('redrivo_current_user');
    if (savedUser) {
        currentUser = JSON.parse(savedUser);
        // Correcting ID mapping if necessary
        if (currentUser.id.includes('_user')) {
            currentUser.id = currentUser.id.replace('_user', '');
        }
        
        document.getElementById('display-name').textContent = currentUser.name;
        document.getElementById('login-container').classList.add('hidden');
        document.getElementById('app-container').classList.remove('hidden');

        updateUserAvatar();
        loadDashboard();
        loadCategories();
        setTimeout(() => {
            const splash = document.getElementById('splash-screen');
            if(splash) {
                splash.style.opacity = '0';
                setTimeout(() => splash.style.display = 'none', 500);
            }
        }, 2000);
    } else {
        setTimeout(() => {
            const splash = document.getElementById('splash-screen');
            if(splash) {
                splash.style.opacity = '0';
                setTimeout(() => splash.style.display = 'none', 500);
            }
        }, 2000);
    }

    // Strict Real-time Plate Formatting
    const plateInput = document.getElementById('v-plate');
    if (plateInput) {
        plateInput.addEventListener('input', function(e) {
            let val = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
            let formatted = '';
            
            // 1. State Code (2 Letters)
            let stateMatch = val.match(/^[A-Z]{0,2}/);
            let state = stateMatch ? stateMatch[0] : '';
            formatted += state;
            val = val.slice(state.length);
            
            if (state.length === 2 && val.length > 0) {
                formatted += ' ';
                // 2. District (2 Numbers)
                let distMatch = val.match(/^[0-9]{0,2}/);
                let dist = distMatch ? distMatch[0] : '';
                formatted += dist;
                val = val.slice(dist.length);
                
                if (dist.length === 2 && val.length > 0) {
                    formatted += ' ';
                    
                    // 3. Series (up to 3 Letters)
                    let seriesMatch = val.match(/^[A-Z]{0,3}/);
                    let series = seriesMatch ? seriesMatch[0] : '';
                    if (series.length > 0) {
                        formatted += series;
                        val = val.slice(series.length);
                        if (val.length > 0) {
                            formatted += ' ';
                        }
                    }
                    
                    // 4. Number (up to 4 Numbers)
                    let numMatch = val.match(/^[0-9]{0,4}/);
                    if (numMatch && numMatch[0].length > 0) {
                        formatted += numMatch[0];
                    }
                }
            }
            
            this.value = formatted;
        });
    }
});

window.selectedGarageId = null;
let dropMarker = null;
let pickupMarker = null;

function switchTab(tabId) {
    window.redrivoCurrentTab = tabId;
    
    // Dynamically update the logo title in the top navbar (vertical stack)
    const logoEl = document.querySelector('#app-container .logo-text');
    if (logoEl) {
        if (tabId === 'history') {
            logoEl.innerHTML = '<div style="display: flex; flex-direction: column; align-items: flex-start; line-height: 1.1;"><div style="overflow: hidden; height: 52px; display: flex;"><img src="assets/redrivo_logo_transparent_dark_bg.png" alt="ReDrivo Logo" style="height: 110px; width: auto; margin: -33px -9px -25px -6px;" /></div><span style="font-size: 0.8rem; font-weight: 700; color: var(--primary); letter-spacing: 0.5px; text-transform: uppercase; margin-top: 2px; font-family: \'Plus Jakarta Sans\', sans-serif;">My Rides</span></div>';
        } else if (tabId === 'vehicles') {
            logoEl.innerHTML = '<div style="display: flex; flex-direction: column; align-items: flex-start; line-height: 1.1;"><div style="overflow: hidden; height: 52px; display: flex;"><img src="assets/redrivo_logo_transparent_dark_bg.png" alt="ReDrivo Logo" style="height: 110px; width: auto; margin: -33px -9px -25px -6px;" /></div><span style="font-size: 0.8rem; font-weight: 700; color: var(--primary); letter-spacing: 0.5px; text-transform: uppercase; margin-top: 2px; font-family: \'Plus Jakarta Sans\', sans-serif;">Vehicles</span></div>';
        } else if (tabId === 'rental') {
            logoEl.innerHTML = '<div style="display: flex; flex-direction: column; align-items: flex-start; line-height: 1.1;"><div style="overflow: hidden; height: 52px; display: flex;"><img src="assets/redrivo_logo_transparent_dark_bg.png" alt="ReDrivo Logo" style="height: 110px; width: auto; margin: -33px -9px -25px -6px;" /></div><span style="font-size: 0.8rem; font-weight: 700; color: var(--primary); letter-spacing: 0.5px; text-transform: uppercase; margin-top: 2px; font-family: \'Plus Jakarta Sans\', sans-serif;">Vehicle Rental</span></div>';
        } else if (tabId === 'profile') {
            logoEl.innerHTML = '<div style="display: flex; flex-direction: column; align-items: flex-start; line-height: 1.1;"><div style="overflow: hidden; height: 52px; display: flex;"><img src="assets/redrivo_logo_transparent_dark_bg.png" alt="ReDrivo Logo" style="height: 110px; width: auto; margin: -33px -9px -25px -6px;" /></div><span style="font-size: 0.8rem; font-weight: 700; color: var(--primary); letter-spacing: 0.5px; text-transform: uppercase; margin-top: 2px; font-family: \'Plus Jakarta Sans\', sans-serif;">Profile</span></div>';
        } else if (tabId === 'focus-garage') {
            logoEl.innerHTML = '<div style="display: flex; flex-direction: column; align-items: flex-start; line-height: 1.1;"><div style="overflow: hidden; height: 52px; display: flex;"><img src="assets/redrivo_logo_transparent_dark_bg.png" alt="ReDrivo Logo" style="height: 110px; width: auto; margin: -33px -9px -25px -6px;" /></div><span style="font-size: 0.8rem; font-weight: 700; color: var(--primary); letter-spacing: 0.5px; text-transform: uppercase; margin-top: 2px; font-family: \'Plus Jakarta Sans\', sans-serif;">Partner Garages</span></div>';
        } else {
            logoEl.innerHTML = '<div style="overflow: hidden; height: 52px; display: flex;"><img src="assets/redrivo_logo_transparent.png" alt="ReDrivo Logo" style="height: 110px; width: auto; margin: -33px -9px -25px -6px;" /></div>';
        }
    }
    const garageWrapper = document.getElementById('garage-container-wrapper');
    const historyContainer = document.getElementById('history-container');
    const profileContainer = document.getElementById('profile-container');
    const vehiclesContainer = document.getElementById('vehicles-container');
    const focusGarageContainer = document.getElementById('focus-garage-container');
    const rentalContainer = document.getElementById('rental-container');
    const mapBg = document.getElementById('leaflet-map');
    const btnGarage = document.getElementById('nav-btn-garage');
    const btnRental = document.getElementById('nav-btn-rental');
    const btnVehicles = document.getElementById('nav-btn-vehicles');
    const btnFocusGarage = document.getElementById('nav-btn-focus-garage');
    const btnProfile = document.getElementById('nav-btn-profile');

    const centerPin = document.getElementById('center-pickup-pin');
    if (centerPin && tabId !== 'garage' && tabId !== 'focus-garage') {
        centerPin.style.display = 'none';
    }

    if (tabId === 'garage') {
        window.bookingSubView = '2A';
        window.userManuallySelectedHours = false;
        if (garageWrapper) garageWrapper.classList.remove('hidden');
        if (historyContainer) historyContainer.classList.add('hidden');
        if (profileContainer) profileContainer.classList.add('hidden');
        if (vehiclesContainer) vehiclesContainer.classList.add('hidden');
        if (focusGarageContainer) focusGarageContainer.classList.add('hidden');
        if (rentalContainer) rentalContainer.classList.add('hidden');
        if (mapBg) mapBg.style.display = 'block';
        if (btnGarage) btnGarage.classList.add('active');
        if (btnFocusGarage) btnFocusGarage.classList.remove('active');
        if (btnRental) btnRental.classList.remove('active');
        if (btnVehicles) btnVehicles.classList.remove('active');
        if (btnProfile) btnProfile.classList.remove('active');
    } else if (tabId === 'history') {
        if (garageWrapper) garageWrapper.classList.add('hidden');
        if (historyContainer) historyContainer.classList.remove('hidden');
        if (profileContainer) profileContainer.classList.add('hidden');
        if (vehiclesContainer) vehiclesContainer.classList.add('hidden');
        if (focusGarageContainer) focusGarageContainer.classList.add('hidden');
        if (rentalContainer) rentalContainer.classList.add('hidden');
        if (mapBg) mapBg.style.display = 'none';
        
        if (btnGarage) btnGarage.classList.remove('active');
        if (btnFocusGarage) btnFocusGarage.classList.remove('active');
        if (btnRental) btnRental.classList.remove('active');
        if (btnVehicles) btnVehicles.classList.remove('active');
        if (btnProfile) btnProfile.classList.add('active');
        
        loadDashboard();
    } else if (tabId === 'vehicles') {
        if (garageWrapper) garageWrapper.classList.add('hidden');
        if (historyContainer) historyContainer.classList.add('hidden');
        if (profileContainer) profileContainer.classList.add('hidden');
        if (vehiclesContainer) vehiclesContainer.classList.remove('hidden');
        if (focusGarageContainer) focusGarageContainer.classList.add('hidden');
        if (rentalContainer) rentalContainer.classList.add('hidden');
        if (mapBg) mapBg.style.display = 'none';
        
        if (btnGarage) btnGarage.classList.remove('active');
        if (btnFocusGarage) btnFocusGarage.classList.remove('active');
        if (btnRental) btnRental.classList.remove('active');
        if (btnVehicles) btnVehicles.classList.add('active');
        if (btnProfile) btnProfile.classList.remove('active');
    } else if (tabId === 'rental') {
        if (garageWrapper) garageWrapper.classList.add('hidden');
        if (historyContainer) historyContainer.classList.add('hidden');
        if (profileContainer) profileContainer.classList.add('hidden');
        if (vehiclesContainer) vehiclesContainer.classList.add('hidden');
        if (focusGarageContainer) focusGarageContainer.classList.add('hidden');
        if (rentalContainer) rentalContainer.classList.remove('hidden');
        if (mapBg) mapBg.style.display = 'none';
        
        if (btnGarage) btnGarage.classList.remove('active');
        if (btnFocusGarage) btnFocusGarage.classList.remove('active');
        if (btnRental) btnRental.classList.add('active');
        if (btnVehicles) btnVehicles.classList.remove('active');
        if (btnProfile) btnProfile.classList.remove('active');

        fetchRentalData();
    } else if (tabId === 'profile') {
        if (garageWrapper) garageWrapper.classList.add('hidden');
        if (historyContainer) historyContainer.classList.add('hidden');
        if (profileContainer) profileContainer.classList.remove('hidden');
        if (vehiclesContainer) vehiclesContainer.classList.add('hidden');
        if (focusGarageContainer) focusGarageContainer.classList.add('hidden');
        if (rentalContainer) rentalContainer.classList.add('hidden');
        if (mapBg) mapBg.style.display = 'none';
        
        if (btnGarage) btnGarage.classList.remove('active');
        if (btnFocusGarage) btnFocusGarage.classList.remove('active');
        if (btnRental) btnRental.classList.remove('active');
        if (btnVehicles) btnVehicles.classList.remove('active');
        if (btnProfile) btnProfile.classList.add('active');
        
        loadProfileTab();
    } else if (tabId === 'focus-garage') {
        if (garageWrapper) garageWrapper.classList.add('hidden');
        if (historyContainer) historyContainer.classList.add('hidden');
        if (profileContainer) profileContainer.classList.add('hidden');
        if (vehiclesContainer) vehiclesContainer.classList.add('hidden');
        if (focusGarageContainer) focusGarageContainer.classList.remove('hidden');
        if (rentalContainer) rentalContainer.classList.add('hidden');
        if (mapBg) mapBg.style.display = 'none';
        
        if (btnGarage) btnGarage.classList.remove('active');
        if (btnFocusGarage) btnFocusGarage.classList.add('active');
        if (btnRental) btnRental.classList.remove('active');
        if (btnVehicles) btnVehicles.classList.remove('active');
        if (btnProfile) btnProfile.classList.remove('active');
        
        // Auto default tab to match active vehicle type
        let defaultTab = 'car';
        if (typeof userVehicles !== 'undefined' && userVehicles[activeVehicleIndex]) {
            const v = userVehicles[activeVehicleIndex];
            const isBike = String(v.type || '').toLowerCase().includes('bike') || 
                           String(v.category || '').toLowerCase().includes('bike') || 
                           String(v.type || '').toLowerCase().includes('motorcycle');
            if (isBike) defaultTab = 'bike';
        }
        window.activeGarageTypeTab = defaultTab;

        // Get current pickup coordinates to query garages sorted by proximity
        const locInput = document.getElementById('pickup-location-global');
        let lat = 19.0664;
        let lng = 72.8680;
        if (locInput) {
            const dataLat = locInput.getAttribute('data-lat');
            const dataLng = locInput.getAttribute('data-lng');
            if (dataLat && dataLng) {
                lat = parseFloat(dataLat);
                lng = parseFloat(dataLng);
            }
        }
        loadNearbyGarages(lat, lng);
    }
}



window.loadedNearbyGaragesMap = window.loadedNearbyGaragesMap || {};
window.selectGarageForBookingById = function(id) {
    const g = window.loadedNearbyGaragesMap[id];
    if (!g) return;
    
    window.selectedGarageData = g;
    window.selectedGarageId = g.id;
    
    // Initialize temporary flow state variables
    window.tempGarageData = g;
    window.tempFlowType = null;
    window.tempSelectedVehicleId = null;
    window.tempSelectedVehicleCondition = null;
    
    const container = document.getElementById('garage-flow-container');
    if (container) {
        container.style.display = 'flex';
        window.goToGarageFlowStep(1);
    } else {
        // Fallback to legacy modal
        const modal = document.getElementById('garage-booking-options-modal');
        if (modal) {
            modal.style.display = 'flex';
        }
    }
};

window.closeGarageOptionsModal = function() {
    const modal = document.getElementById('garage-booking-options-modal');
    if (modal) modal.style.display = 'none';
};

function applyLockedStyles(input, isLocked, type) {
    if (!input) return;
    if (isLocked) {
        input.readOnly = true;
        input.style.background = 'rgba(255, 255, 255, 0.02)';
        input.style.color = '#a1a1aa';
        input.style.cursor = 'not-allowed';
        input.style.border = '1px solid rgba(255, 255, 255, 0.05)';
    } else {
        input.readOnly = false;
        input.style.background = 'rgba(0, 0, 0, 0.5)';
        input.style.color = '#fff';
        input.style.cursor = 'text';
        input.style.border = type === 'drop' ? '1px solid rgba(34, 197, 94, 0.4)' : '1px solid rgba(250, 204, 21, 0.4)';
    }
}

window.askVehicleCondition = function(vehicleId, callback) {
    callback(window.selectedVehicleCondition || 'Working');
};

window.selectVehicleCondition = function(condition) {
    window.selectedVehicleCondition = condition;
    
    const btnWorking = document.getElementById('btn-cond-working');
    const btnNotworking = document.getElementById('btn-cond-notworking');
    if (btnWorking && btnNotworking) {
        if (condition === 'Not Working') {
            btnNotworking.style.background = 'var(--primary)';
            btnNotworking.style.color = '#000';
            btnNotworking.style.fontWeight = '700';
            
            btnWorking.style.background = 'transparent';
            btnWorking.style.color = '#fff';
            btnWorking.style.fontWeight = '600';
        } else {
            btnWorking.style.background = 'var(--primary)';
            btnWorking.style.color = '#000';
            btnWorking.style.fontWeight = '700';
            
            btnNotworking.style.background = 'transparent';
            btnNotworking.style.color = '#fff';
            btnNotworking.style.fontWeight = '600';
        }
    }
    
    const vehicleId = (document.getElementById('booking-opt-vehicle-id') ? document.getElementById('booking-opt-vehicle-id').value : '') || (userVehicles[activeVehicleIndex] ? userVehicles[activeVehicleIndex].id : '');
    if (vehicleId && typeof window.updateBookingFareBreakdown === 'function') {
        window.updateBookingFareBreakdown(vehicleId);
    }
};

window.confirmGarageFlowSelection = function(g, flowType) {
    if (userVehicles.length === 0) {
        showToast('Please add a vehicle first.', 'error');
        switchTab('vehicles');
        return;
    }

    if (userVehicles.length === 1) {
        askVehicleCondition(userVehicles[0].id, (condition) => {
            proceedWithGarageBooking(g, flowType, userVehicles[0].id, condition);
        });
    } else {
        showGarageVehicleSelection(g, flowType);
    }
};

window.showGarageVehicleSelection = function(g, flowType) {
    const modal = document.getElementById('garage-vehicle-selection-modal');
    const container = document.getElementById('garage-vehicle-list-container');
    if (!modal || !container) return;

    container.innerHTML = userVehicles.map(v => {
        let imageSrc = 'images/sedan.png';
        const lowerType = (v.type || '').toLowerCase();
        if (v.photo) {
            imageSrc = v.photo;
        } else {
            if (lowerType.includes('bike') || lowerType.includes('motorcycle')) imageSrc = 'images/bike.png';
            else if (lowerType.includes('suv')) imageSrc = 'images/suv.png';
            else if (lowerType.includes('hatchback')) imageSrc = 'images/hatchback.png';
        }

        return `
            <div onclick="selectVehicleForGarageFlow('${v.id}')" style="display: flex; align-items: center; gap: 14px; padding: 14px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 14px; cursor: pointer; transition: all 0.2s;">
                <img src="${imageSrc}" style="width: 50px; height: 35px; object-fit: contain; flex-shrink: 0;" />
                <div style="flex: 1; min-width: 0;">
                    <div style="font-weight: 700; color: #fff; font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${v.make} ${v.model}</div>
                    <div style="font-size: 0.72rem; color: var(--text-muted); font-weight: 600;">${v.plate}</div>
                </div>
                <span class="material-symbols-outlined" style="color: var(--primary); font-size: 1.25rem; flex-shrink: 0;">chevron_right</span>
            </div>
        `;
    }).join('');

    window.tempGarageData = g;
    window.tempFlowType = flowType;
    modal.style.display = 'flex';
};

window.closeGarageVehicleSelectionModal = function() {
    const modal = document.getElementById('garage-vehicle-selection-modal');
    if (modal) modal.style.display = 'none';
};

window.selectVehicleForGarageFlow = function(vehicleId) {
    closeGarageVehicleSelectionModal();
    if (window.tempGarageData && window.tempFlowType) {
        askVehicleCondition(vehicleId, (condition) => {
            proceedWithGarageBooking(window.tempGarageData, window.tempFlowType, vehicleId, condition);
        });
    }
};

window.proceedWithGarageBooking = function(g, flowType, vehicleId, condition) {
    window.selectedGarageId = g.id;
    window.bookingFlow = flowType === 'pickup' ? 'garage_standard' : 'garage_return';
    window.pickupDropType = flowType === 'pickup' ? 'Pickup' : 'Drop';
    window.selectedVehicleCondition = condition || 'Working';

    // Update active vehicle index
    const index = userVehicles.findIndex(v => v.id === vehicleId);
    if (index !== -1) {
        activeVehicleIndex = index;
    }

    const pickupInput = document.getElementById('pickup-location-global');
    const dropInput = document.getElementById('drop-location-global');
    const clearContainer = document.getElementById('clear-garage-selection-container');

    if (clearContainer) {
        clearContainer.style.display = 'block';
    }

    if (customerMap) {
        if (pickupMarker) pickupMarker.setMap(null);
        if (dropMarker) dropMarker.setMap(null);
    }

    // Extract customer location
    let customerAddress = '';
    let customerLat = '';
    let customerLng = '';
    if (pickupInput) {
        customerAddress = pickupInput.getAttribute('data-address') || pickupInput.value || '';
        customerLat = pickupInput.getAttribute('data-lat') || '';
        customerLng = pickupInput.getAttribute('data-lng') || '';
    }

    // Fallback if empty/detecting
    if (!customerAddress || customerAddress.startsWith("Detecting") || customerAddress.startsWith("Approximate")) {
        customerAddress = "Trident Hotel, BKC, Mumbai";
        customerLat = "19.0664";
        customerLng = "72.8680";
    }

    if (flowType === 'pickup') {
        if (pickupInput) {
            pickupInput.value = customerAddress;
            pickupInput.setAttribute('data-address', customerAddress);
            pickupInput.setAttribute('data-lat', customerLat);
            pickupInput.setAttribute('data-lng', customerLng);
            applyLockedStyles(pickupInput, false, 'pickup');
        }
        if (dropInput) {
            dropInput.value = g.name + " (" + g.address + ")";
            dropInput.setAttribute('data-address', g.address);
            dropInput.setAttribute('data-lat', g.lat);
            dropInput.setAttribute('data-lng', g.lng);
            applyLockedStyles(dropInput, true, 'drop');
        }

        const lat = parseFloat(g.lat);
        const lng = parseFloat(g.lng);
        if (customerMap && !isNaN(lat) && !isNaN(lng)) {
            const dropIcon = createGoogleIcon('#ef4444');
            dropMarker = new google.maps.Marker({ position: {lat, lng}, map: customerMap, icon: dropIcon});
        }
    } else {
        if (pickupInput) {
            pickupInput.value = g.name + " (" + g.address + ")";
            pickupInput.setAttribute('data-address', g.address);
            pickupInput.setAttribute('data-lat', g.lat);
            pickupInput.setAttribute('data-lng', g.lng);
            applyLockedStyles(pickupInput, true, 'pickup');
        }
        if (dropInput) {
            dropInput.value = customerAddress;
            dropInput.setAttribute('data-address', customerAddress);
            dropInput.setAttribute('data-lat', customerLat);
            dropInput.setAttribute('data-lng', customerLng);
            applyLockedStyles(dropInput, false, 'drop');
        }

        const lat = parseFloat(g.lat);
        const lng = parseFloat(g.lng);
        if (customerMap && !isNaN(lat) && !isNaN(lng)) {
            const pickupIcon = createGoogleIcon('#22c55e');
            pickupMarker = new google.maps.Marker({ position: {lat, lng}, map: customerMap, icon: pickupIcon });
        }
    }

    pickupLocationResolved = true;
    dropLocationResolved = true;

    updateRouteVisibility();

    showToast(`Garage routing configured.`, 'success');
    window.openBookingOptions(vehicleId);
};

window.clearGarageSelection = function() {
    window.selectedGarageId = null;
    window.bookingFlow = 'p2p';
    window.pickupDropType = 'Pickup';
    
    const pickupInput = document.getElementById('pickup-location-global');
    const dropInput = document.getElementById('drop-location-global');
    const clearContainer = document.getElementById('clear-garage-selection-container');
    
    if (clearContainer) {
        clearContainer.style.display = 'none';
    }
    
    if (pickupInput) {
        pickupInput.value = '';
        pickupInput.readOnly = false;
        pickupInput.removeAttribute('data-address');
        pickupInput.removeAttribute('data-lat');
        pickupInput.removeAttribute('data-lng');
        pickupInput.style.border = '1px solid rgba(250, 204, 21, 0.4)';
    }
    
    if (dropInput) {
        dropInput.value = '';
        dropInput.readOnly = false;
        dropInput.removeAttribute('data-address');
        dropInput.removeAttribute('data-lat');
        dropInput.removeAttribute('data-lng');
        dropInput.style.border = '1px solid rgba(34, 197, 94, 0.4)';
    }
    
    if (customerMap) {
        if (pickupMarker) if (pickupMarker) pickupMarker.setMap(null);
        if (dropMarker) if (dropMarker) dropMarker.setMap(null);
    }
    
    showToast('Switched to Point-to-Point logistics. Garage selection cleared.', 'info');
    if (typeof updateFixedActionButton === 'function') {
        updateFixedActionButton();
    }
};

window.loadNearbyGarages = async function(lat, lng) {
    const listContainer = document.getElementById('nearby-garages-list');
    if (!listContainer) return;

    if (!lat || !lng) {
        const pickupInput = document.getElementById('pickup-location-global');
        if (pickupInput) {
            const dataLat = pickupInput.getAttribute('data-lat');
            const dataLng = pickupInput.getAttribute('data-lng');
            if (dataLat && dataLng) {
                lat = parseFloat(dataLat);
                lng = parseFloat(dataLng);
            }
        }
    }

    if (!lat || !lng) {
        lat = 19.0664;
        lng = 72.8680;
    }

    try {
        listContainer.innerHTML = `
            <div style="text-align: center; padding: 25px; color: var(--text-muted); font-size: 0.85rem;">
                <svg class="spin" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; color:var(--primary); margin-bottom:10px;"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg>
                <br>Searching for nearby partner garages...
            </div>
        `;

        const res = await fetch(`${API_URL}/garages/nearby?lat=${lat}&lng=${lng}`);
        if (!res.ok) throw new Error('Failed to fetch garages');
        const garages = await res.json();

        // Cache garages globally
        window.cachedNearbyGarages = garages || [];
        
        if (!garages || garages.length === 0) {
            listContainer.innerHTML = `
                <div style="text-align: center; padding: 30px; background: rgba(255,255,255,0.02); border-radius: 16px; border: 1px dashed rgba(255,255,255,0.1); color: var(--text-muted); font-size: 0.85rem;">
                    No partner garages found within 15 KM of this location. Try changing your search coordinates.
                </div>
            `;
            return;
        }

        // Cache garages by ID for safe onClick binding
        garages.forEach(g => {
            window.loadedNearbyGaragesMap[g.id] = g;
        });

        // Trigger rendering of filtered list
        window.renderNearbyGaragesListUI();

    } catch (e) {
        console.error('Failed loading nearby garages:', e);
        listContainer.innerHTML = `
            <div style="text-align: center; padding: 20px; color: var(--danger); font-size: 0.85rem;">
                Failed to load nearby garages. Please check your network connection.
            </div>
        `;
    }
};

window.renderNearbyGaragesListUI = function() {
    const listContainer = document.getElementById('nearby-garages-list');
    if (!listContainer || !window.cachedNearbyGarages) return;

    const garages = window.cachedNearbyGarages;
    const tab = window.activeGarageTypeTab || 'car';

    // Update Tab buttons styling
    const btnCar = document.getElementById('btn-gt-car');
    const btnBike = document.getElementById('btn-gt-bike');
    if (btnCar && btnBike) {
        if (tab === 'car') {
            btnCar.style.background = 'var(--primary)';
            btnCar.style.color = '#000';
            btnCar.style.fontWeight = '700';
            btnBike.style.background = 'transparent';
            btnBike.style.color = '#fff';
            btnBike.style.fontWeight = '600';
        } else {
            btnBike.style.background = 'var(--primary)';
            btnBike.style.color = '#000';
            btnBike.style.fontWeight = '700';
            btnCar.style.background = 'transparent';
            btnCar.style.color = '#fff';
            btnCar.style.fontWeight = '600';
        }
    }

    const filtered = garages.filter(g => {
        const sType = (g.serviceType || g.servicetype || 'Both').trim().toLowerCase();
        if (tab === 'car') {
            return sType === 'car' || sType === 'both';
        } else {
            return sType === 'bike' || sType === 'motorcycle' || sType === 'both';
        }
    });

    if (filtered.length === 0) {
        listContainer.innerHTML = `
            <div style="text-align: center; padding: 30px; background: rgba(255,255,255,0.02); border-radius: 16px; border: 1px dashed rgba(255,255,255,0.1); color: var(--text-muted); font-size: 0.85rem;">
                No ${tab === 'car' ? 'Car' : 'Motorcycle & Bike'} service garages found in this area.
            </div>
        `;
        return;
    }

    const getGarageCardHtml = (g) => {
        const distanceText = g.distance !== undefined ? `${g.distance.toFixed(1)} km away` : '';
        const isSelected = window.selectedGarageId === g.id;
        const selectBtnText = isSelected ? 'Selected' : 'Select Garage';
        const selectBtnStyle = isSelected 
            ? 'background: var(--primary); color: #000; font-weight: 700;' 
            : 'background: rgba(255,255,255,0.05); color: #fff; font-weight: 600;';

        const name = g.name || '';
        const owner = g.owner || 'N/A';
        const address = g.address || 'No address details';
        const contact = g.contact || 'N/A';
        const serviceTypeVal = g.serviceType || g.servicetype || 'Both';
        const isAuth = (g.serviceCenterType || g.servicecentertype) === 'authorized';
        const carBrands = (g.authorizedCarBrands || g.authorizedcarbrands || '').split(',').map(s => s.trim()).filter(Boolean);
        const bikeBrands = (g.authorizedBikeBrands || g.authorizedbikebrands || '').split(',').map(s => s.trim()).filter(Boolean);
        const allBrands = [...carBrands, ...bikeBrands];
        const authBadgeHtml = isAuth && allBrands.length > 0
            ? `<div style="display:inline-flex; align-items:center; gap:4px; font-size:0.72rem; color:var(--primary); background:rgba(250,204,21,0.12); border:1px solid rgba(250,204,21,0.25); padding:3px 8px; border-radius:12px; font-weight:700; margin-top:4px;">
                 ⭐ OEM Authorized: ${allBrands.slice(0, 2).join(', ')}${allBrands.length > 2 ? ' +' + (allBrands.length - 2) : ''}
               </div>`
            : '';

        return `
            <div class="card fade-in" style="background: rgba(18, 22, 29, 0.7); backdrop-filter: blur(20px); border: 1.5px solid ${isSelected ? 'var(--primary)' : 'rgba(255,255,255,0.06)'}; border-radius: 20px; padding: 20px; margin-bottom: 14px; display: flex; flex-direction: column; gap: 12px; transition: all 0.3s ease; box-shadow: 0 4px 15px rgba(0,0,0,0.2);">
                <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                    <div>
                        <h4 style="font-weight: 800; font-size: 1.15rem; color: #fff; margin-bottom: 4px;">${name}</h4>
                        <p style="font-size: 0.8rem; color: var(--text-muted); font-weight: 500;">👤 Owner: ${owner}</p>
                        ${authBadgeHtml}
                    </div>
                    <span style="font-size: 0.75rem; color: var(--primary); background: rgba(250, 204, 21, 0.15); padding: 4px 10px; border-radius: 20px; font-weight: 700; border: 1px solid rgba(250, 204, 21, 0.3);">
                        ${distanceText}
                    </span>
                </div>
                <div style="display: flex; flex-direction: column; gap: 6px; font-size: 0.82rem; color: var(--text-muted); border-top: 1px solid rgba(255,255,255,0.04); padding-top: 10px;">
                    <div style="display: flex; align-items: flex-start; gap: 6px;">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0; margin-top: 2px;"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
                        <span style="color: #fff; font-weight: 500;">${address}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
                        <span style="color: #fff; font-weight: 500;">+91 ${contact}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px; margin-top: 2px;">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
                        <span>Service: <span style="color: var(--primary); font-weight: 600;">${serviceTypeVal}</span></span>
                    </div>
                </div>
                <div style="display: flex; gap: 8px; margin-top: 8px;">
                    <button onclick="selectGarageForBookingById('${g.id}')" 
                            style="flex: 1; padding: 10px 16px; border-radius: 10px; border: none; font-size: 0.85rem; cursor: pointer; transition: all 0.2s; ${selectBtnStyle}">
                        ${selectBtnText}
                    </button>
                </div>
            </div>
        `;
    };

    let html = '<div style="display: flex; flex-direction: column; gap: 4px;">';
    filtered.forEach(g => {
        html += getGarageCardHtml(g);
    });
    html += '</div>';

    listContainer.innerHTML = html;
};

window.selectGarageTypeTab = function(tab) {
    window.activeGarageTypeTab = tab;
    window.renderNearbyGaragesListUI();
};

let garageSearchTimeout = null;
window.handleGarageLocationInput = function() {
    const input = document.getElementById('garage-manual-location');
    const suggestionsDiv = document.getElementById('garage-manual-suggestions');
    if (!input || !suggestionsDiv) return;

    const query = input.value.trim();
    if (garageSearchTimeout) clearTimeout(garageSearchTimeout);

    if (query.length < 2) {
        suggestionsDiv.innerHTML = '';
        suggestionsDiv.style.display = 'none';
        return;
    }

    garageSearchTimeout = setTimeout(async () => {
        try {
            suggestionsDiv.innerHTML = `<div style="padding: 10px; color: var(--text-muted); font-size: 0.75rem; text-align: center;">Searching...</div>`;
            suggestionsDiv.style.display = 'block';

            const res = await fetch(`${API_URL}/maps/autocomplete?q=${encodeURIComponent(query)}`);
            if (!res.ok) throw new Error('API Error');
            const data = await res.json();
            
            // Temporary console log for verification
            console.log("[Places API Raw Autocomplete Response (Garage Search)]:", data);

            let html = '';
            if (data && data.length > 0) {
                html += data.map(item => {
                    const lat = item.lat || 0;
                    const lng = item.lng || 0;
                    const placeId = item.place_id || '';
                    return `
                        <div class="suggestion-item" style="padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05); cursor: pointer;" 
                             onclick="selectGarageLocationSuggestion('${item.address.replace(/'/g, "\\'")}', ${lat}, ${lng}, '${placeId}')">
                            <div style="font-weight: 700; color: var(--primary); font-size: 0.9rem;">${item.name}</div>
                            <div style="font-size: 0.75rem; color: var(--text-muted);">${item.address}</div>
                        </div>
                    `;
                }).join('');
            } else {
                html = `<div style="padding: 10px; color: var(--text-muted); font-size: 0.75rem; text-align: center;">No results found.</div>`;
            }

            suggestionsDiv.innerHTML = html;
        } catch (e) {
            console.error('Garage manual search failed:', e);
            suggestionsDiv.innerHTML = `<div style="padding: 10px; color: var(--danger); font-size: 0.75rem; text-align: center;">Error loading suggestions.</div>`;
        }
    }, 400);
};

window.selectGarageLocationSuggestion = async function(address, lat, lng, placeId) {
    const input = document.getElementById('garage-manual-location');
    const suggestionsDiv = document.getElementById('garage-manual-suggestions');
    if (suggestionsDiv) {
        suggestionsDiv.innerHTML = '';
        suggestionsDiv.style.display = 'none';
    }

    let finalLat = lat;
    let finalLng = lng;
    let finalAddress = address;

    if (placeId) {
        showToast("Resolving location coordinates...", "info");
        try {
            const res = await fetch(`${API_URL}/maps/details?place_id=${placeId}`);
            if (res.ok) {
                const details = await res.json();
                finalLat = details.lat;
                finalLng = details.lng;
                // We keep the address from the dropdown so the user sees exactly what they clicked!
                // if (details.address) finalAddress = details.address;
            }
        } catch (e) {
            console.error("Garage manual search geocoding details error:", e);
        }
    }

    if (input) {
        input.value = finalAddress;
    }

    const pickupInput = document.getElementById('pickup-location-global');
    if (pickupInput) {
        pickupInput.value = finalAddress;
        pickupInput.setAttribute('data-address', finalAddress);
        pickupInput.setAttribute('data-lat', finalLat);
        pickupInput.setAttribute('data-lng', finalLng);
    }

    if (customerMap) {
        customerMap.setCenter({lat: parseFloat(finalLat), lng: parseFloat(finalLng)});
        customerMap.setZoom(14);
        if (customerMarker) {
            customerMarker.setPosition({lat: parseFloat(finalLat), lng: parseFloat(finalLng)});
        }
        showNearbyMarshalsOnMap(finalLat, finalLng);
    }

    loadNearbyGarages(finalLat, finalLng);
};

window.selectGarageForBooking = function(g) {
    window.selectedGarageId = g.id;
    
    const dropInput = document.getElementById('drop-location-global');
    if (dropInput) {
        dropInput.value = g.name + " (" + g.address + ")";
        dropInput.setAttribute('data-address', g.address);
        dropInput.setAttribute('data-lat', g.lat);
        dropInput.setAttribute('data-lng', g.lng);
        dropInput.readOnly = false;
    }

    const lat = parseFloat(g.lat);
    const lng = parseFloat(g.lng);

    if (customerMap) {
        const dropIcon = createGoogleIcon('#ef4444');
        if (dropMarker) if (dropMarker) dropMarker.setMap(null);
        dropMarker = new google.maps.Marker({ position: {lat: parseFloat(lat), lng: parseFloat(lng)}, map: customerMap, icon: dropIcon});
        dropMarker;

        const pickupInput = document.getElementById('pickup-location-global');
        if (pickupInput) {
            const pLat = parseFloat(pickupInput.getAttribute('data-lat'));
            const pLng = parseFloat(pickupInput.getAttribute('data-lng'));
            if (!isNaN(pLat) && !isNaN(pLng) && pickupLocationResolved) {
                const bounds = new google.maps.LatLngBounds(); bounds.extend({lat: parseFloat(pLat), lng: parseFloat(pLng)}); bounds.extend({lat: parseFloat(lat), lng: parseFloat(lng)});
                customerMap.fitBounds(bounds, 80);
            }
        }
    }

    showToast(`Garage "${g.name}" selected as drop-off.`, 'success');
    switchTab('garage');

    const vehiclesList = document.getElementById('vehicles-list');
    if (vehiclesList) {
        vehiclesList.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
};

window.openTermsModal = function() {
    const modal = document.getElementById('terms-modal');
    if (modal) modal.style.display = 'flex';
};

window.closeTermsModal = function() {
    const modal = document.getElementById('terms-modal');
    if (modal) modal.style.display = 'none';
};

window.openPrivacyModal = function() {
    const modal = document.getElementById('privacy-modal');
    if (modal) modal.style.display = 'flex';
};

window.closePrivacyModal = function() {
    const modal = document.getElementById('privacy-modal');
    if (modal) modal.style.display = 'none';
};

window.selectScheduleDate = function(element) {
    const container = document.getElementById('booking-schedule-date-container');
    if (!container) return;
    const cards = container.getElementsByClassName('date-card');
    for (let card of cards) {
        card.classList.remove('active');
        card.style.background = 'rgba(255, 255, 255, 0.03)';
        card.style.borderColor = 'rgba(255, 255, 255, 0.08)';
        const label = card.querySelector('span');
        if (label) label.style.color = 'var(--text-muted)';
    }
    element.classList.add('active');
    element.style.background = 'rgba(250, 204, 21, 0.15)';
    element.style.borderColor = 'var(--primary)';
    const label = element.querySelector('span');
    if (label) label.style.color = 'var(--primary)';
    
    document.getElementById('booking-schedule-date').value = element.getAttribute('data-date');
    element.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
};

window.selectScheduleTime = function(element) {
    const container = document.getElementById('booking-schedule-time-container');
    if (!container) return;
    const cards = container.getElementsByClassName('time-card');
    for (let card of cards) {
        card.classList.remove('active');
        card.style.background = 'rgba(255, 255, 255, 0.03)';
        card.style.borderColor = 'rgba(255, 255, 255, 0.08)';
        card.style.color = '#eee';
    }
    element.classList.add('active');
    element.style.background = 'rgba(250, 204, 21, 0.1)';
    element.style.borderColor = 'var(--primary)';
    element.style.color = 'var(--primary)';
    
    document.getElementById('booking-schedule-time').value = element.getAttribute('data-time');
};

window.resetSlideToConfirm = function(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.classList.remove('confirmed');
    const handle = container.querySelector('.slide-handle');
    const text = container.querySelector('.slide-text');
    const highlight = container.querySelector('.slide-highlight');
    if (handle) {
        handle.style.transform = 'translateX(0px)';
        handle.style.transition = 'transform 0.2s ease';
    }
    if (highlight) {
        highlight.style.width = '0px';
        highlight.style.transition = 'width 0.2s ease';
    }
    if (text) {
        text.style.opacity = 1;
        if (containerId.includes('instant')) {
            text.innerHTML = 'Slide to Book Instantly';
        } else {
            text.innerHTML = 'Slide to Confirm Schedule';
        }
    }
};

async function bookExistingVehicle(vehicleId) {
    if (!vehicleId) return;

    // ── HARD GUARD: block re-booking an already-active vehicle ───────────────
    try {
        const reqs = await apiGet('/requests');
        const myReqs = reqs.filter(r => (r.customerId || r.customerid) === currentUser.id);
        const activeReq = myReqs.find(r => (r.vehicleId || r.vehicleid) === vehicleId && !['pending', 'scheduled', 'completed','cancelled','returned','drop_completed'].includes(r.status));
        
        if (activeReq) {
            showToast('This vehicle already has an active booking. Track your current order.', 'error');
            const trips = await apiGet('/trips');
            const trip = trips.find(t => (t.serviceRequestId || t.servicerequestid) === activeReq.id && !['completed'].includes(t.status));
            if (trip) {
                sessionStorage.removeItem('minimizeEnRoute');
                showMarshalEnRoute(trip);
            }
            return;
        }
    } catch(e) {
        console.warn('Booking guard check failed:', e);
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Check if user details are missing (stub values check)
    if (!currentUser.name || currentUser.name === 'New Partner' || !currentUser.email || currentUser.email === 'pending@redrivo.com') {
        document.getElementById('ud-pending-vehicle-id').value = vehicleId;
        window.userProfileTriggeredByBooking = true;
        document.getElementById('user-details-modal').style.display = 'flex';
    } else {
        askVehicleCondition(vehicleId, (condition) => {
            window.selectedVehicleCondition = condition;
            window.openBookingOptions(vehicleId);
        });
    }
}

window.openBookingOptions = function(vehicleId) {
    // Modal is retired, so this is a no-op to prevent exceptions.
    window.updateFixedActionButton();
};

window.closeBookingOptionsModal = function() {
    // Modal is retired, so this is a no-op to prevent exceptions.
};

let lastRenderedVehicleId = null;

window.renderInlineBookingPanel = function(vehicleId) {
    const panel = document.getElementById('booking-options-inline-panel');
    if (!panel) return;
    
    if (lastRenderedVehicleId !== vehicleId) {
        lastRenderedVehicleId = vehicleId;
        
        // Render options structure
        panel.innerHTML = `
            <input type="hidden" id="booking-opt-vehicle-id" value="${vehicleId}">
            <input type="hidden" id="booking-pricing-mode" value="${window.selectedPricingMode}">
            
            <div style="margin-bottom: 2px;">
                <label style="font-size: 0.7rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; display: block;">Vehicle Condition</label>
                <div style="display: flex; gap: 8px; background: rgba(0, 0, 0, 0.2); padding: 4px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.05);">
                    <button type="button" id="btn-cond-working" onclick="selectVehicleCondition('Working')" style="flex: 1; padding: 7px; border-radius: 8px; border: none; background: ${window.selectedVehicleCondition === 'Working' ? 'var(--primary)' : 'transparent'}; color: ${window.selectedVehicleCondition === 'Working' ? '#000' : '#fff'}; font-weight: 700; font-size: 0.78rem; cursor: pointer; transition: all 0.2s; outline: none;">
                        Starts & Runs
                    </button>
                    <button type="button" id="btn-cond-notworking" onclick="selectVehicleCondition('Not Working')" style="flex: 1; padding: 7px; border-radius: 8px; border: none; background: ${window.selectedVehicleCondition === 'Not Working' ? 'var(--primary)' : 'transparent'}; color: ${window.selectedVehicleCondition === 'Not Working' ? '#000' : '#fff'}; font-weight: 700; font-size: 0.78rem; cursor: pointer; transition: all 0.2s; outline: none;">
                        Needs Towing
                    </button>
                </div>
            </div>

            <div style="margin-bottom: 2px;">
                <label style="font-size: 0.7rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; display: block;">Hire Driver</label>
                <div style="display: flex; gap: 10px; width: 100%;">
                    <!-- Card A: Distance -->
                    <div id="card-pm-distance" onclick="selectPricingModel('distance')" style="flex: 1; padding: 10px; border-radius: 14px; border: 2px solid ${window.selectedPricingMode === 'distance' ? 'var(--primary)' : 'rgba(255,255,255,0.08)'}; background: ${window.selectedPricingMode === 'distance' ? 'rgba(250, 204, 21, 0.05)' : 'rgba(255,255,255,0.02)'}; cursor: pointer; transition: all 0.2s; display: flex; flex-direction: column; align-items: center; text-align: center;">
                        <span style="font-size: 0.78rem; font-weight: 800; color: #fff;">One-way Ride</span>
                        <span style="font-size: 0.6rem; color: var(--text-muted); margin-top: 1px;">Point-to-point</span>
                        <span id="inline-distance-fare" style="font-size: 1rem; font-weight: 800; color: ${window.selectedPricingMode === 'distance' ? 'var(--primary)' : 'var(--text-muted)'}; margin-top: 4px;">₹0</span>
                    </div>
                    <!-- Card B: Hourly -->
                    <div id="card-pm-hourly" onclick="selectPricingModel('hourly')" style="flex: 1; padding: 10px; border-radius: 14px; border: 2px solid ${window.selectedPricingMode === 'hourly' ? 'var(--primary)' : 'rgba(255,255,255,0.08)'}; background: ${window.selectedPricingMode === 'hourly' ? 'rgba(250, 204, 21, 0.05)' : 'rgba(255,255,255,0.02)'}; cursor: pointer; transition: all 0.2s; display: flex; flex-direction: column; align-items: center; text-align: center;">
                        <span style="font-size: 0.78rem; font-weight: 800; color: #fff;">Hourly Rental</span>
                        <span style="font-size: 0.6rem; color: var(--text-muted); margin-top: 1px;">By the hour</span>
                        <span id="inline-hourly-fare" style="font-size: 1rem; font-weight: 800; color: ${window.selectedPricingMode === 'hourly' ? 'var(--primary)' : 'var(--text-muted)'}; margin-top: 4px;">₹0</span>
                    </div>
                </div>
            </div>

            <div id="booking-hourly-duration-group" style="margin-bottom: 2px; display: ${window.selectedPricingMode === 'hourly' ? 'block' : 'none'};">
                <label style="font-size: 0.7rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; display: block;">Booking Duration</label>
                <select id="booking-estimated-hours" onchange="changeEstimatedHours()" style="width: 100%; padding: 10px; border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0,0,0,0.4); color: #fff; font-size: 0.85rem; font-weight: 600; outline: none; -webkit-appearance: none;">
                    <option value="1" ${window.selectedEstimatedHours === 1 ? 'selected' : ''}>1 Hour</option>
                    <option value="2" ${window.selectedEstimatedHours === 2 ? 'selected' : ''}>2 Hours</option>
                    <option value="3" ${window.selectedEstimatedHours === 3 ? 'selected' : ''}>3 Hours</option>
                    <option value="4" ${window.selectedEstimatedHours === 4 ? 'selected' : ''}>4 Hours (Default)</option>
                    <option value="6" ${window.selectedEstimatedHours === 6 ? 'selected' : ''}>6 Hours</option>
                    <option value="8" ${window.selectedEstimatedHours === 8 ? 'selected' : ''}>8 Hours</option>
                    <option value="12" ${window.selectedEstimatedHours === 12 ? 'selected' : ''}>12 Hours</option>
                </select>
            </div>

            <div style="margin-bottom: 2px;">
                <label style="font-size: 0.7rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; display: block;">Pickup Schedule</label>
                <div style="display: flex; gap: 8px; background: rgba(0, 0, 0, 0.2); padding: 4px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.05);">
                    <button type="button" id="btn-opt-instant" onclick="selectBookingOptionTab('instant')" style="flex: 1; padding: 7px; border-radius: 8px; border: none; background: ${window.activeBookingTab === 'instant' ? 'var(--primary)' : 'transparent'}; color: ${window.activeBookingTab === 'instant' ? '#000' : '#fff'}; font-weight: 700; font-size: 0.78rem; cursor: pointer; transition: all 0.2s; outline: none;">
                        Instant Pickup
                    </button>
                    <button type="button" id="btn-opt-schedule" onclick="selectBookingOptionTab('schedule')" style="flex: 1; padding: 7px; border-radius: 8px; border: none; background: ${window.activeBookingTab === 'schedule' ? 'var(--primary)' : 'transparent'}; color: ${window.activeBookingTab === 'schedule' ? '#000' : '#fff'}; font-weight: 700; font-size: 0.78rem; cursor: pointer; transition: all 0.2s; outline: none;">
                        Schedule
                    </button>
                </div>
            </div>

            <div id="booking-opt-schedule-section" style="display: ${window.activeBookingTab === 'schedule' ? 'flex' : 'none'}; flex-direction: column; gap: 10px; margin-bottom: 2px;">
                <div>
                    <label style="font-size: 0.68rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; display: block;">Select Date</label>
                    <div id="booking-schedule-date-container" style="display: flex; gap: 8px; overflow-x: auto; padding: 2px 0; width: 100%;" class="no-scrollbar"></div>
                    <input type="hidden" id="booking-schedule-date" value="${window.selectedScheduleDate || ''}">
                </div>
                <div>
                    <label style="font-size: 0.68rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; display: block;">Select Time Slot</label>
                    <div id="booking-schedule-time-container" style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; max-height: 120px; overflow-y: auto; padding: 2px 0;" class="no-scrollbar"></div>
                    <input type="hidden" id="booking-schedule-time" value="${window.selectedScheduleTime || ''}">
                </div>
            </div>

            <div id="booking-fare-breakdown" style="background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 14px; padding: 12px; display: flex; flex-direction: column; gap: 6px;">
                <div style="font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; font-weight: 700; border-bottom: 1px solid rgba(255, 255, 255, 0.05); padding-bottom: 6px; margin-bottom: 2px;">Fare Estimate Breakdown</div>
                <div id="breakdown-details" style="display: flex; flex-direction: column; gap: 6px;">
                    <div style="color:var(--text-muted); font-size:0.8rem; text-align:center;">Calculating fare...</div>
                </div>
            </div>
        `;
        
        window.initScheduleDatesAndTimes();
    }
    
    window.updateBookingFareBreakdown(vehicleId);
};

window.initScheduleDatesAndTimes = function() {
    const dateContainer = document.getElementById('booking-schedule-date-container');
    const hiddenDateInput = document.getElementById('booking-schedule-date');
    if (dateContainer && hiddenDateInput) {
        const dates = [];
        const today = new Date();
        for (let i = 0; i < 7; i++) {
            const d = new Date();
            d.setDate(today.getDate() + i);
            dates.push(d);
        }
        
        dateContainer.innerHTML = dates.map((d, idx) => {
            const dateStr = d.toISOString().split('T')[0];
            let label = '';
            if (idx === 0) label = 'Today';
            else if (idx === 1) label = 'Tomorrow';
            else {
                label = d.toLocaleDateString('en-US', { weekday: 'short' });
            }
            const dayNum = d.getDate();
            const month = d.toLocaleDateString('en-US', { month: 'short' });
            const isActive = window.selectedScheduleDate ? (window.selectedScheduleDate === dateStr) : (idx === 0);
            if (isActive) {
                hiddenDateInput.value = dateStr;
                window.selectedScheduleDate = dateStr;
            }
            return `
            <div class="date-card ${isActive ? 'active' : ''}" data-date="${dateStr}" onclick="selectScheduleDate(this)" style="flex: 0 0 64px; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 8px 4px; border-radius: 12px; background: ${isActive ? 'rgba(250, 204, 21, 0.15)' : 'rgba(255, 255, 255, 0.03)'}; border: 1.5px solid ${isActive ? 'var(--primary)' : 'rgba(255, 255, 255, 0.08)'}; cursor: pointer; transition: all 0.2s;">
                <span style="font-size: 0.6rem; color: ${isActive ? 'var(--primary)' : 'var(--text-muted)'}; font-weight: 700; text-transform: uppercase;">${label}</span>
                <span style="font-size: 1rem; color: #fff; font-weight: 800; margin: 2px 0;">${dayNum}</span>
                <span style="font-size: 0.58rem; color: var(--text-muted); font-weight: 500;">${month}</span>
            </div>
            `;
        }).join('');
    }

    const timeContainer = document.getElementById('booking-schedule-time-container');
    const hiddenTimeInput = document.getElementById('booking-schedule-time');
    if (timeContainer && hiddenTimeInput) {
        const slots = [
            "09:00 AM - 10:00 AM", "10:00 AM - 11:00 AM", "11:00 AM - 12:00 PM",
            "12:00 PM - 01:00 PM", "01:00 PM - 02:00 PM", "02:00 PM - 03:00 PM",
            "03:00 PM - 04:00 PM", "04:00 PM - 05:00 PM", "05:00 PM - 06:00 PM",
            "06:00 PM - 07:00 PM", "07:00 PM - 08:00 PM", "08:00 PM - 09:00 PM"
        ];
        timeContainer.innerHTML = slots.map((slot, idx) => {
            const isActive = window.selectedScheduleTime ? (window.selectedScheduleTime === slot) : (idx === 0);
            if (isActive) {
                hiddenTimeInput.value = slot;
                window.selectedScheduleTime = slot;
            }
            return `
            <div class="time-card ${isActive ? 'active' : ''}" data-time="${slot}" onclick="selectScheduleTime(this)" style="display: flex; align-items: center; justify-content: center; padding: 8px; border-radius: 12px; background: ${isActive ? 'rgba(250, 204, 21, 0.1)' : 'rgba(255,255,255,0.03)'}; border: 1.5px solid ${isActive ? 'var(--primary)' : 'rgba(255,255,255,0.08)'}; cursor: pointer; transition: all 0.2s; font-size: 0.7rem; font-weight: 700; color: ${isActive ? 'var(--primary)' : '#eee'};">
                ${slot}
            </div>
            `;
        }).join('');
    }
};

window.updateBookingFareBreakdown = async function(vehicleId) {
    const details = document.getElementById('breakdown-details');
    if (!details) return;

    try {
        await loadSystemSettings(); // Refresh settings live from database before rendering
        
        const v = userVehicles.find(veh => veh.id === vehicleId);
        if (!v) return;

        const isBike = String(v.type).toLowerCase().includes('bike') || String(v.type).toLowerCase().includes('motorcycle') || String(v.category).toLowerCase().includes('bike');
        const vehicleType = isBike ? 'bike' : 'car';

        // Get distance
        const locInput = document.getElementById('pickup-location-global');
        const dropInput = document.getElementById('drop-location-global');
        let distance = window.calculatedRouteDistance || 0;
        if (distance === 0 && locInput && dropInput) {
            const pLat = parseFloat(locInput.getAttribute('data-lat'));
            const pLng = parseFloat(locInput.getAttribute('data-lng'));
            const dLat = parseFloat(dropInput.getAttribute('data-lat'));
            const dLng = parseFloat(dropInput.getAttribute('data-lng'));
            if (!isNaN(pLat) && !isNaN(pLng) && !isNaN(dLat) && !isNaN(dLng)) {
                distance = calcDistanceKm(pLat, pLng, dLat, dLng);
            }
        }

        const settings = window.redrivoSystemSettings || {};
        const minFare = parseFloat(settings['base_fare'] || '150.0');
        const baseRatePerKm = parseFloat(settings['customer_rate_per_km'] || '15.0');
        const haltRate = parseFloat(settings[`${vehicleType}_halt_rate_per_min`] || (vehicleType === 'car' ? '6.0' : '2.0'));

        let slabRate = baseRatePerKm;
        try {
            const slabs = await apiGet(`/settings/incentives?type=${vehicleType}`);
            if (slabs && slabs.length > 0) {
                const matchingSlab = slabs.find(s => distance <= (s.maxDistance || s.maxdistance));
                if (matchingSlab) {
                    slabRate = matchingSlab.ratePerKm || matchingSlab.rateperkm;
                } else {
                    slabRate = slabs[slabs.length - 1].ratePerKm || slabs[slabs.length - 1].rateperkm;
                }
            }
        } catch (eSlab) {
            console.warn("Failed to fetch slabs for preview:", eSlab.message);
        }

        const pricingMode = window.selectedPricingMode || 'distance';
        const estimatedHours = window.selectedEstimatedHours || 4;

        // Common Towing calculation
        let towingFee = 0;
        if (window.selectedVehicleCondition === 'Not Working') {
            const towingBase = parseFloat(settings['towing_base_fee'] || '500.0');
            const towingRatePerKm = parseFloat(settings['towing_rate_per_km'] || '30.0');
            towingFee = towingBase + (distance * towingRatePerKm);
        }

        // 1. Compute Distance total price
        const distanceCharge = distance * slabRate;
        const finalDistanceCharge = Math.max(minFare, distanceCharge);
        let totalHaltMinutes = 0;
        if (window.routeStops && Array.isArray(window.routeStops)) {
            window.routeStops.forEach(stop => {
                totalHaltMinutes += parseInt(stop.haltTime) || 0;
            });
        }
        const haltCharge = totalHaltMinutes * haltRate;
        const distanceTotal = finalDistanceCharge + haltCharge + towingFee;

        // 2. Compute Hourly total price
        const hourlyRate = parseFloat(settings[`${vehicleType}_hourly_rate`] || (vehicleType === 'car' ? '150.0' : '80.0'));
        const hourlyTotal = (estimatedHours * hourlyRate) + towingFee;

        // Update card pricing elements
        const distPriceEl = document.getElementById('inline-distance-fare');
        const hourPriceEl = document.getElementById('inline-hourly-fare');
        if (distPriceEl) distPriceEl.textContent = `₹${distanceTotal.toFixed(0)}`;
        if (hourPriceEl) hourPriceEl.textContent = `₹${hourlyTotal.toFixed(0)}`;

        let totalFare = pricingMode === 'hourly' ? hourlyTotal : distanceTotal;
        let html = '';

        if (pricingMode === 'hourly') {
            html += `
                <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.8rem; color:#fff;">
                    <span style="color:var(--text-muted);">Hire Driver Type</span>
                    <span style="font-weight:700;">Hourly Rental</span>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.8rem; color:#fff;">
                    <span style="color:var(--text-muted);">Duration Rate</span>
                    <span style="font-weight:700;">₹${hourlyRate.toFixed(0)}/hr</span>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.8rem; color:#fff;">
                    <span style="color:var(--text-muted);">Estimated Hours</span>
                    <span style="font-weight:700;">${estimatedHours} Hours</span>
                </div>
            `;
        } else {
            if (distanceCharge < minFare) {
                html += `
                    <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.8rem; color:#fff;">
                        <span style="color:var(--text-muted);">Min Fare Floor (applied)</span>
                        <span style="font-weight:700;">₹${minFare.toFixed(0)}</span>
                    </div>
                `;
            } else {
                html += `
                    <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.8rem; color:#fff;">
                        <span style="color:var(--text-muted);">Distance Charge (${distance.toFixed(1)} km)</span>
                        <span style="font-weight:700;">₹${distanceCharge.toFixed(0)}</span>
                    </div>
                `;
            }

            if (haltCharge > 0) {
                html += `
                    <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.8rem; color:#fff;">
                        <span style="color:var(--text-muted);">Stops Halt Charge (${totalHaltMinutes} mins)</span>
                        <span style="font-weight:700;">₹${haltCharge.toFixed(0)}</span>
                    </div>
                `;
            }
        }

        if (towingFee > 0) {
            html += `
                <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.8rem; color:#fff;">
                    <span style="color:#ef4444; font-weight:600;">Towing Assistance Surcharge</span>
                    <span style="font-weight:700; color:#ef4444;">+ ₹${towingFee.toFixed(0)}</span>
                </div>
            `;
        }

        html += `
            <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid rgba(255,255,255,0.05); padding-top:6px; margin-top:2px; font-size:0.9rem; color:#fff;">
                <span style="font-weight:700; color:var(--primary);">Estimated Total</span>
                <span style="font-weight:800; color:var(--primary);">₹${totalFare.toFixed(0)}</span>
            </div>
        `;

        details.innerHTML = html;

    } catch (err) {
        console.error("Failed to load fare breakdown:", err);
        details.innerHTML = '<div style="color:var(--danger); font-size:0.75rem; text-align:center;">Failed to calculate fare breakdown.</div>';
    }
};

window.selectPricingModel = function(mode) {
    window.selectedPricingMode = mode;
    const input = document.getElementById('booking-pricing-mode');
    if (input) input.value = mode;

    const cardDistance = document.getElementById('card-pm-distance');
    const cardHourly = document.getElementById('card-pm-hourly');
    const durationGroup = document.getElementById('booking-hourly-duration-group');

    if (cardDistance && cardHourly) {
        if (mode === 'hourly') {
            cardHourly.style.borderColor = 'var(--primary)';
            cardHourly.style.background = 'rgba(250, 204, 21, 0.05)';
            cardHourly.querySelector('#inline-hourly-fare').style.color = 'var(--primary)';

            cardDistance.style.borderColor = 'rgba(255,255,255,0.08)';
            cardDistance.style.background = 'rgba(255,255,255,0.02)';
            cardDistance.querySelector('#inline-distance-fare').style.color = 'var(--text-muted)';

            if (durationGroup) durationGroup.style.display = 'block';
        } else {
            cardDistance.style.borderColor = 'var(--primary)';
            cardDistance.style.background = 'rgba(250, 204, 21, 0.05)';
            cardDistance.querySelector('#inline-distance-fare').style.color = 'var(--primary)';

            cardHourly.style.borderColor = 'rgba(255,255,255,0.08)';
            cardHourly.style.background = 'rgba(255,255,255,0.02)';
            cardHourly.querySelector('#inline-hourly-fare').style.color = 'var(--text-muted)';

            if (durationGroup) durationGroup.style.display = 'none';
        }
    }
    
    const vehicleId = userVehicles[activeVehicleIndex] ? userVehicles[activeVehicleIndex].id : '';
    if (vehicleId) {
        window.updateBookingFareBreakdown(vehicleId);
    }
};

window.changeEstimatedHours = function() {
    const select = document.getElementById('booking-estimated-hours');
    if (select) {
        window.selectedEstimatedHours = parseInt(select.value) || 4;
    }
    const vehicleId = userVehicles[activeVehicleIndex] ? userVehicles[activeVehicleIndex].id : '';
    if (vehicleId) {
        window.updateBookingFareBreakdown(vehicleId);
    }
};

function renderHistory(trips) {
    const list = document.getElementById('history-list');
    if (!list) return;
    
    const completed = trips.filter(t => t.status === 'completed');
    
    if (completed.length === 0) {
        list.innerHTML = `<div class="list-item" style="justify-content:center; color: var(--text-muted); padding: 30px; text-align: center;">No previous service history found.</div>`;
        return;
    }
    
    list.innerHTML = completed.map(t => {
        const vehicle = userVehicles.find(v => v.id === t.vehicleId);
        const vName = vehicle ? `${vehicle.make} ${vehicle.model}` : 'Unknown Vehicle';
        const vPlate = vehicle ? vehicle.plate : '';
        const req = userRequests.find(r => r.id === (t.serviceRequestId || t.servicerequestid));
        const pickupAddr = req ? (req.pickup_address || req.pickupAddress || 'Pickup Point') : 'Pickup Point';
        const dropAddr = req ? (req.drop_address || req.dropAddress || 'Drop Point') : 'Drop Point';
        const formattedDate = req ? new Date(req.date).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) : new Date().toLocaleDateString();
        
        // Price and Distance
        const rawPrice = req ? (req.totalcustomerprice || req.totalCustomerPrice || 0) : 0;
        const formattedPrice = Math.round(rawPrice);
        const rawDistance = req ? (req.distancekm || req.distanceKm || 0) : 0;
        const formattedDistance = parseFloat(rawDistance).toFixed(1);

        // Vehicle Photo
        let imageSrc = 'images/sedan.png';
        if (vehicle && vehicle.photo) {
            imageSrc = vehicle.photo;
        } else if (vehicle) {
            const lowerType = (vehicle.type || 'Hatchback').toLowerCase();
            if (lowerType.includes('bike') || lowerType.includes('motorcycle')) {
                imageSrc = 'images/bike.png';
            } else if (lowerType.includes('suv')) {
                imageSrc = 'images/suv.png';
            } else if (lowerType.includes('hatchback')) {
                imageSrc = 'images/hatchback.png';
            } else {
                imageSrc = 'images/sedan.png';
            }
        }
        
        const marshalHtml = t.marshalName ? `
            <div style="display: flex; align-items: center; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.05);">
                <div style="width: 28px; height: 28px; border-radius: 50%; overflow: hidden; background: rgba(255,255,255,0.1);">
                    <img src="${t.marshalPhoto ? (t.marshalPhoto.startsWith('http') ? t.marshalPhoto : `${API_URL.substring(0, API_URL.lastIndexOf('/api'))}/${t.marshalPhoto}`) : getInitialsAvatar(t.marshalName)}" style="width: 100%; height: 100%; object-fit: cover;">
                </div>
                <div style="display: flex; flex-direction: column;">
                    <span style="font-size: 0.75rem; color: #fff; font-weight: 700;">${t.marshalName}</span>
                    <span style="font-size: 0.65rem; color: #10b981; font-weight: 600; display: flex; align-items: center; gap: 2px;">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Certified Marshal
                    </span>
                </div>
            </div>
        ` : '';

        return `
            <div class="vehicle-card" style="margin-bottom: 16px; padding: 20px; display: flex; flex-direction: column; gap: 14px; position: relative; background: linear-gradient(145deg, rgba(39, 39, 42, 0.4) 0%, rgba(18, 18, 22, 0.6) 100%); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 20px;">
                <!-- Header: Completed Run -->
                <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                    <span style="font-size: 0.65rem; font-weight: 800; color: #10b981; letter-spacing: 1.5px; text-transform: uppercase; background: rgba(16, 185, 129, 0.1); padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(16, 185, 129, 0.15);">Completed Run</span>
                    <span style="font-size: 0.72rem; color: var(--text-muted); font-weight: 600;">${formattedDate}</span>
                </div>

                <!-- Vehicle Details + Image Row -->
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px;">
                    <div>
                        <div style="font-size: 1.15rem; font-weight: 800; color: #ffffff; letter-spacing: -0.3px;">${vName}</div>
                        <span style="font-size: 0.75rem; color: var(--text-muted); font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase; margin-top: 2px; display: block;">${vPlate}</span>
                    </div>
                    <div style="width: 90px; height: 60px; overflow: hidden; background: rgba(255,255,255,0.02); display: flex; align-items: center; justify-content: center; border-radius: 12px; border: 1px solid rgba(255,255,255,0.05); flex-shrink: 0;">
                        <img src="${imageSrc}" alt="${vName}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 12px;">
                    </div>
                </div>

                <!-- Stats Row: Distance & Price -->
                <div style="display: flex; gap: 10px;">
                    <div style="flex: 1; background: rgba(56,189,248,0.07); border: 1px solid rgba(56,189,248,0.15); border-radius: 12px; padding: 10px; display: flex; flex-direction: column; align-items: center; gap: 2px;">
                        <span style="font-size: 0.58rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">Distance</span>
                        <span style="font-size: 1.05rem; font-weight: 800; color: #38bdf8; font-family: 'Montserrat', sans-serif;">${formattedDistance} km</span>
                    </div>
                    <div style="flex: 1; background: rgba(250, 204, 21, 0.07); border: 1px solid rgba(250, 204, 21, 0.15); border-radius: 12px; padding: 10px; display: flex; flex-direction: column; align-items: center; gap: 2px;">
                        <span style="font-size: 0.58rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">Total Price</span>
                        <span style="font-size: 1.05rem; font-weight: 800; color: var(--primary); font-family: 'Montserrat', sans-serif;">₹${formattedPrice}</span>
                    </div>
                </div>

                <!-- Pickup / Drop Addresses -->
                <div style="display: flex; flex-direction: column; gap: 8px; background: rgba(0,0,0,0.15); padding: 12px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.03);">
                    <div style="display: flex; gap: 8px; align-items: flex-start;">
                        <span style="width: 6px; height: 6px; border-radius: 50%; background: var(--primary); display: inline-block; margin-top: 5px;"></span>
                        <div style="display: flex; flex-direction: column;">
                            <span style="font-size: 0.65rem; color: var(--text-muted); font-weight: 600; text-transform: uppercase;">Pickup</span>
                            <span style="font-size: 0.78rem; color: #eee; font-weight: 500; line-height: 1.2;">${pickupAddr}</span>
                        </div>
                    </div>
                    <div style="height: 10px; border-left: 1px dashed rgba(255,255,255,0.15); margin-left: 2.5px;"></div>
                    <div style="display: flex; gap: 8px; align-items: flex-start;">
                        <span style="width: 6px; height: 6px; border-radius: 50%; background: #22c55e; display: inline-block; margin-top: 5px;"></span>
                        <div style="display: flex; flex-direction: column;">
                            <span style="font-size: 0.65rem; color: var(--text-muted); font-weight: 600; text-transform: uppercase;">Drop</span>
                            <span style="font-size: 0.78rem; color: #eee; font-weight: 500; line-height: 1.2;">${dropAddr}</span>
                        </div>
                    </div>
                </div>

                <!-- Marshal Info -->
                ${marshalHtml}

                <!-- Action Buttons -->
                <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px;">
                    <button class="btn btn-danger" onclick="openDisputeFormForPastTrip('${t.id}', '${t.marshalId || t.marshalid || ''}')" style="background: rgba(239, 68, 68, 0.1); border: 1px solid var(--danger); color: var(--danger); font-weight: 800; font-size: 0.8rem; padding: 8px 16px; border-radius: 14px; cursor: pointer; display: flex; align-items: center; gap: 6px; width: fit-content; text-transform: uppercase; letter-spacing: 0.5px;">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                        Help / Support
                    </button>
                    <button class="yellow-btn" onclick="openReceiptModal('${t.id}')" style="background: rgba(250, 204, 21, 0.1); border: 1px solid var(--primary); color: var(--primary); font-weight: 800; font-size: 0.8rem; padding: 8px 16px; border-radius: 14px; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 6px; width: fit-content; text-transform: uppercase; letter-spacing: 0.5px;">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
                        Invoice / Report
                    </button>
                </div>
            </div>
        `;
    }).reverse().join('');
}

window.switchBookingSubTab = function(tab) {
    window.currentBookingSubTab = tab;
    
    const activeBtn = document.getElementById('btn-booking-active');
    const completedBtn = document.getElementById('btn-booking-completed');
    if (activeBtn && completedBtn) {
        if (tab === 'active') {
            activeBtn.style.background = 'var(--primary)';
            activeBtn.style.color = '#000';
            activeBtn.style.fontWeight = '700';
            
            completedBtn.style.background = 'transparent';
            completedBtn.style.color = '#fff';
            completedBtn.style.fontWeight = '600';
        } else {
            completedBtn.style.background = 'var(--primary)';
            completedBtn.style.color = '#000';
            completedBtn.style.fontWeight = '700';
            
            activeBtn.style.background = 'transparent';
            activeBtn.style.color = '#fff';
            activeBtn.style.fontWeight = '600';
        }
    }
    
    updateBookingTabVisibility();
};

function updateBookingTabVisibility() {
    const tab = window.currentBookingSubTab || 'active';
    
    const activeSections = [
        document.getElementById('requests-section'),
        document.getElementById('trips-section'),
        document.getElementById('inspection-approval-section'),
        document.getElementById('approval-section')
    ];
    const completedSection = document.getElementById('history-list');
    const historyHeader = document.getElementById('completed-history-header');
    
    if (tab === 'active') {
        if (completedSection) completedSection.style.display = 'none';
        if (historyHeader) historyHeader.style.display = 'none';
        
        const myRequests = window.userRequests || [];
        const activeReqs = myRequests.filter(r => !['pending', 'scheduled', 'completed', 'cancelled', 'returned', 'drop_completed', 'marshal_assigned'].includes(r.status));
        const activeTrips = (window._myTrips || []).filter(t => t.status !== 'completed' && t.status !== 'cancelled' && t.status !== 'drop_completed' && t.status !== 'pending_payment');
        const pendingApprovals = activeTrips.filter(t => t.status === 'pending_approval');
        const pendingInspections = myRequests.filter(r => r.status === 'pending_inspection_approval');
        
        const reqSection = document.getElementById('requests-section');
        const tripSection = document.getElementById('trips-section');
        const appSection = document.getElementById('approval-section');
        const insSection = document.getElementById('inspection-approval-section');
        
        if (reqSection) reqSection.style.display = activeReqs.length > 0 ? 'block' : 'none';
        if (tripSection) tripSection.style.display = activeTrips.length > 0 ? 'block' : 'none';
        if (appSection) appSection.style.display = pendingApprovals.length > 0 ? 'block' : 'none';
        if (insSection) insSection.style.display = pendingInspections.length > 0 ? 'block' : 'none';
    } else {
        activeSections.forEach(sec => {
            if (sec) sec.style.display = 'none';
        });
        if (completedSection) completedSection.style.display = 'block';
        if (historyHeader) historyHeader.style.display = 'block';
    }
}

async function openReceiptModal(tripId) {
    try {
        const audit = await apiGet(`/trips/${tripId}/audit`);
        const allTrips = await apiGet('/trips');
        const trip = allTrips.find(t => t.id === tripId);
        if (trip && audit) {
            openAuditModal({ trip, audit });
        } else {
            showToast('Audit report data not found.', 'error');
        }
    } catch (e) {
        showToast('Error loading service report: ' + e.message, 'error');
    }
}

function focusGarage() {
    switchTab('garage');
    const btnGarage = document.getElementById('nav-btn-garage');
    const btnFocusGarage = document.getElementById('nav-btn-focus-garage');
    if (btnGarage) btnGarage.classList.remove('active');
    if (btnFocusGarage) btnFocusGarage.classList.add('active');

    const sheet = document.getElementById('garage-container');
    if (sheet) {
        sheet.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
}

function getInitialsAvatar(name) {
    const initials = (name || 'U').split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
    const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
            <defs>
                <linearGradient id="yellow-gold-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#FBBF24" />
                    <stop offset="50%" stop-color="#F59E0B" />
                    <stop offset="100%" stop-color="#D97706" />
                </linearGradient>
            </defs>
            <circle cx="50" cy="50" r="50" fill="url(#yellow-gold-grad)" />
            <text x="50" y="54" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="36" font-weight="bold" fill="#000000" text-anchor="middle" dominant-baseline="middle">${initials}</text>
        </svg>
    `.trim().replace(/\s+/g, ' ');
    
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function updateUserAvatar() {
    if (!currentUser) return;
    let avatarUrl = currentUser.photo || currentUser.facePhotoUrl || getInitialsAvatar(currentUser.name);
    
    if (avatarUrl && !avatarUrl.startsWith('http') && !avatarUrl.startsWith('data:')) {
        const baseUrl = API_URL.replace('/api', '');
        avatarUrl = `${baseUrl}/${avatarUrl}`;
    }
    
    const headerAvatar = document.getElementById('header-user-avatar');
    if (headerAvatar) headerAvatar.src = avatarUrl;
    
    const modalAvatar = document.getElementById('profile-modal-avatar');
    if (modalAvatar) modalAvatar.src = avatarUrl;
}

function openProfileModal() {
    if (!currentUser) return;
    switchTab('profile');
}

function closeProfileModal() {
    // No-op for backward compatibility
}

function loadProfileTab() {
    console.log('[DEBUG-DEVICE] loadProfileTab executed on tab navigation');
    if (!currentUser) return;
    updateUserAvatar();
    
    const nameEl = document.getElementById('profile-modal-name');
    if (nameEl) nameEl.textContent = currentUser.name || 'New Partner';
    const roleEl = document.getElementById('profile-modal-role');
    if (roleEl) roleEl.textContent = 'Customer'; // Force role display to Customer
    
    const phoneEl = document.getElementById('profile-modal-phone');
    if (phoneEl) phoneEl.textContent = currentUser.phone || 'N/A';
    const emailEl = document.getElementById('profile-modal-email');
    if (emailEl) emailEl.textContent = currentUser.email || 'N/A';

    // Show/hide email verified badge
    const emailBadge = document.getElementById('profile-email-badge');
    if (emailBadge) {
        emailBadge.style.display = (currentUser.email && currentUser.email !== 'N/A' && (currentUser.emailVerified || currentUser.emailverified)) ? 'flex' : 'none';
    }

    // Hide edit forms on open
    const phoneForm = document.getElementById('phone-edit-form');
    if (phoneForm) phoneForm.style.display = 'none';
    const emailForm = document.getElementById('email-edit-form');
    if (emailForm) emailForm.style.display = 'none';

    renderProfileVehicles();
    if (typeof checkRentalPartnerStatus === 'function') {
        console.log('[DEBUG-DEVICE] Calling checkRentalPartnerStatus from loadProfileTab');
        checkRentalPartnerStatus();
    }
}

function renderProfileVehicles() {
    const list = document.getElementById('profile-vehicles-list');
    if (!list) return;

    if (userVehicles.length === 0) {
        list.innerHTML = `<div style="text-align: center; color: var(--text-muted); font-size: 0.9rem; padding: 20px; border: 1px dashed rgba(255, 255, 255, 0.1); border-radius: 12px;">No vehicles added yet.</div>`;
        return;
    }

    list.innerHTML = userVehicles.map(v => {
        const fuel = v.fuel || 'Petrol';
        const transmission = v.transmission || 'Manual';
        const type = v.type || 'Hatchback';

        let imageSrc = 'images/sedan.png';
        if (v.photo) {
            imageSrc = v.photo;
        } else {
            const lowerType = type.toLowerCase();
            if (lowerType.includes('bike') || lowerType.includes('motorcycle')) {
                imageSrc = 'images/bike.png';
            } else if (lowerType.includes('suv')) {
                imageSrc = 'images/suv.png';
            } else if (lowerType.includes('hatchback')) {
                imageSrc = 'images/hatchback.png';
            } else {
                imageSrc = 'images/sedan.png';
            }
        }

        return `
        <div class="vehicle-card" style="display: flex; position: relative; overflow: hidden; align-items: stretch; min-height: 130px; padding: 16px; margin-bottom: 4px; border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 16px; background: rgba(255, 255, 255, 0.02);">
            <div class="vehicle-card-content-left" style="flex: 1; display: flex; flex-direction: column; justify-content: space-between; z-index: 2; max-width: 60%;">
                <div class="vehicle-meta-info" style="display: flex; flex-direction: column; gap: 2px;">
                    <span class="vehicle-title" style="font-size: 1.15rem; font-weight: 800; color: #ffffff; letter-spacing: -0.3px; line-height: 1.2;">${v.make} ${v.model}</span>
                    <span class="vehicle-plate-badge" style="font-size: 0.75rem; color: var(--text-muted); font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase; margin-top: 4px;">${v.plate}</span>
                </div>
                
                <div class="vehicle-tags-row" style="display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0 12px 0;">
                    <span class="vehicle-tag" style="font-size: 0.65rem; font-weight: 700; padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); color: var(--text-muted); text-transform: uppercase;">${fuel}</span>
                    <span class="vehicle-tag" style="font-size: 0.65rem; font-weight: 700; padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); color: var(--text-muted); text-transform: uppercase;">${transmission}</span>
                    <span class="vehicle-tag" style="font-size: 0.65rem; font-weight: 700; padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); color: var(--text-muted); text-transform: uppercase;">${type}</span>
                </div>

                <div style="display: flex; gap: 8px; margin-top: auto; z-index: 10;">
                    <button onclick="editVehicle('${v.id}')" style="background: rgba(250, 204, 21, 0.1); color: var(--primary); font-weight: 800; font-size: 0.72rem; padding: 6px 12px; border-radius: 16px; border: 1px solid var(--primary); cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 4px;">
                        Edit
                    </button>
                    <button onclick="deleteVehicle('${v.id}')" style="background: rgba(239, 68, 68, 0.1); color: #ef4444; font-weight: 800; font-size: 0.72rem; padding: 6px 12px; border-radius: 16px; border: 1px solid #ef4444; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 4px;">
                        Delete
                    </button>
                </div>
            </div>

            <!-- Floating car/bike image on the right -->
            <div class="vehicle-card-right-image-wrapper" style="position: absolute; right: 10px; bottom: 10px; top: 10px; width: 40%; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 1;">
                <img src="${imageSrc}" alt="${v.model}" class="vehicle-card-image" style="width: 100%; height: 100%; object-fit: cover; border-radius: 12px; filter: drop-shadow(0 8px 12px rgba(0,0,0,0.2));">
            </div>
        </div>
        `;
    }).join('');
}

function startEditProfileField(field) {
    const formId = `${field}-edit-form`;
    const inputId = `edit-${field}-input`;
    const form = document.getElementById(formId);
    if (form) {
        const isHidden = form.style.display === 'none';
        form.style.display = isHidden ? 'flex' : 'none';
        if (isHidden) {
            const input = document.getElementById(inputId);
            if (input) {
                input.value = field === 'name' ? currentUser.name : (field === 'phone' ? currentUser.phone : currentUser.email) || '';
                input.focus();
            }
            // Hide the other edit forms
            ['name', 'phone', 'email'].forEach(f => {
                if (f !== field) {
                    const otherForm = document.getElementById(`${f}-edit-form`);
                    if (otherForm) otherForm.style.display = 'none';
                }
            });
        }
    }
}

async function saveProfileName() {
    const inputId = `edit-name-input`;
    const val = document.getElementById(inputId).value.trim();
    if (!val) { showToast(`Please enter your full name`, 'error'); return; }

    const btn = document.querySelector('#name-edit-form button');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
        await apiPatch(`/users/${currentUser.id}`, { name: val });
        showToast('Name updated successfully!', 'success');
        
        currentUser.name = val;
        localStorage.setItem('redrivo_current_user', JSON.stringify(currentUser));
        
        document.getElementById(`name-edit-form`).style.display = 'none';
        
        const nameEl = document.getElementById('profile-modal-name');
        if (nameEl) nameEl.textContent = val;
        
        const headerName = document.getElementById('display-name');
        if (headerName) headerName.textContent = val;
        
        updateUserAvatar();
    } catch (e) {
        showToast(e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Save Name';
    }
}

async function uploadProfilePicture(input) {
    if (!input.files || !input.files[0]) return;
    let file = input.files[0];
    
    // Client-side compression to ~50kb
    if (file.size > 50 * 1024) {
        showToast("Compressing image...", "info");
        try {
            const bitmap = await createImageBitmap(file);
            const canvas = document.createElement('canvas');
            const MAX_WIDTH = 500;
            const MAX_HEIGHT = 500;
            let width = bitmap.width;
            let height = bitmap.height;
            if (width > height) {
                if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; }
            } else {
                if (height > MAX_HEIGHT) { width *= MAX_HEIGHT / height; height = MAX_HEIGHT; }
            }
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0, width, height);
            
            const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.6));
            if (blob) {
                file = new File([blob], file.name.replace(/\.[^/.]+$/, "") + ".jpg", { type: 'image/jpeg' });
            }
        } catch(e) {
            console.error('Compression failed', e);
        }
    }
    
    const formData = new FormData();
    formData.append('file', file);
    formData.append('referenceId', currentUser.id);
    formData.append('type', 'profile_picture');
    
    showToast("Uploading profile picture...", "info");
    
    try {
        const res = await fetch(`${API_URL}/media`, {
            method: 'POST',
            body: formData
        });
        
        if (!res.ok) {
            let errMsg = "Upload failed";
            try {
                const errJson = await res.json();
                errMsg = errJson.error || errJson.message || errMsg;
            } catch (e) {}
            throw new Error(errMsg);
        }
        
        const data = await res.json();
        const filePath = data.filePath;
        
        await apiPatch(`/users/${currentUser.id}`, { facePhotoUrl: filePath });
        
        currentUser.facePhotoUrl = filePath;
        localStorage.setItem('redrivo_current_user', JSON.stringify(currentUser));
        
        updateUserAvatar();
        showToast("Profile picture updated successfully!", "success");
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function sendEditFieldOtp(field) {
    const inputId = `edit-${field}-input`;
    const val = document.getElementById(inputId).value.trim();
    if (!val) { showToast(`Please enter a valid ${field}`, 'error'); return; }

    if (field === 'phone' && !/^\d{10}$/.test(val)) {
        showToast('Please enter exactly a 10-digit phone number', 'error');
        return;
    }
    if (field === 'email' && !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4}$/.test(val)) {
        showToast('Please enter a valid email address ending with a proper domain (e.g. .com)', 'error');
        return;
    }

    const btnId = `btn-send-${field}-otp`;
    const btn = document.getElementById(btnId);
    btn.disabled = true;
    btn.textContent = 'Sending...';

    try {
        const res = await apiPost(`/users/${currentUser.id}/send-update-otp`, { field, value: val });
        showToast(`OTP sent! Code: ${res.otp || '(Check details)'}`, 'success');
        if (res.otp) console.log('DEV OTP:', res.otp);
        
        // Show OTP area
        const otpAreaId = `${field}-otp-area`;
        const otpArea = document.getElementById(otpAreaId);
        if (otpArea) otpArea.style.display = 'flex';
    } catch (e) {
        showToast(e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Send OTP';
    }
}

async function verifyEditFieldOtp(field) {
    const valInputId = `edit-${field}-input`;
    const val = document.getElementById(valInputId).value.trim();
    const otpInputId = `edit-${field}-otp-input`;
    const otp = document.getElementById(otpInputId).value.trim();

    if (otp.length !== 6) { showToast('Enter 6-digit OTP', 'error'); return; }

    const btnId = `btn-verify-${field}-otp`;
    const btn = document.getElementById(btnId);
    btn.disabled = true;
    btn.textContent = 'Verifying...';

    try {
        const res = await apiPost(`/users/${currentUser.id}/verify-update-otp`, { field, value: val, otp });
        showToast('Profile updated and verified!', 'success');
        
        // Update local session
        currentUser.phone = res.user.phone || currentUser.phone;
        currentUser.email = res.user.email || currentUser.email;
        if (field === 'email') currentUser.emailVerified = 1;
        if (field === 'phone') currentUser.phoneVerified = 1;

        localStorage.setItem('redrivo_current_user', JSON.stringify(currentUser));

        // Reset UI
        document.getElementById(`${field}-edit-form`).style.display = 'none';
        document.getElementById(`edit-${field}-otp-input`).value = '';
        document.getElementById(`${field}-otp-area`).style.display = 'none';

        // Refresh Modal
        openProfileModal();
        updateUserAvatar();
    } catch (e) {
        showToast(e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Verify & Save';
    }
}


window.selectBookingOptionTab = function(tab) {
    window.activeBookingTab = tab;
    const btnInstant = document.getElementById('btn-opt-instant');
    const btnSchedule = document.getElementById('btn-opt-schedule');
    const secSchedule = document.getElementById('booking-opt-schedule-section');

    if (tab === 'instant') {
        if (btnInstant) {
            btnInstant.style.background = 'var(--primary)';
            btnInstant.style.color = '#000';
            btnInstant.style.fontWeight = '700';
        }
        if (btnSchedule) {
            btnSchedule.style.background = 'transparent';
            btnSchedule.style.color = '#fff';
            btnSchedule.style.fontWeight = '600';
        }
        if (secSchedule) secSchedule.style.display = 'none';
    } else {
        if (btnInstant) {
            btnInstant.style.background = 'transparent';
            btnInstant.style.color = '#fff';
            btnInstant.style.fontWeight = '600';
        }
        if (btnSchedule) {
            btnSchedule.style.background = 'var(--primary)';
            btnSchedule.style.color = '#000';
            btnSchedule.style.fontWeight = '700';
        }
        if (secSchedule) secSchedule.style.display = 'flex';
    }
    
    // Refresh fixed action button container to render the correct confirm slider
    window.updateFixedActionButton();
};

window.confirmInstantBooking = async function() {
    const vehicleId = userVehicles[activeVehicleIndex] ? userVehicles[activeVehicleIndex].id : '';
    if (!vehicleId) return;

    // Check user profile completion
    if (!currentUser.name || currentUser.name === 'New Partner' || !currentUser.email || currentUser.email === 'pending@redrivo.com') {
        document.getElementById('ud-pending-vehicle-id').value = vehicleId;
        window.userProfileTriggeredByBooking = true;
        document.getElementById('user-details-modal').style.display = 'flex';
        const instantBtn = document.getElementById('btn-request-service-instant') || document.getElementById('flow-btn-confirm-instant');
        if (instantBtn) {
            instantBtn.disabled = false;
            instantBtn.innerHTML = 'Search Driver';
        }
        return;
    }

    // ── HARD GUARD: block re-booking if vehicle already has active trip ─────
    try {
        const allRequests = await apiGet('/requests');
        const myReqs = allRequests.filter(r => (r.customerId || r.customerid) === currentUser.id);
        const existingActive = myReqs.find(r =>
            (r.vehicleId || r.vehicleid) === vehicleId &&
            !['pending', 'scheduled', 'completed', 'cancelled', 'returned', 'drop_completed'].includes(r.status)
        );
        if (existingActive) {
            showToast('This vehicle already has an active service request. Track your current order.', 'error');
            const instantBtn = document.getElementById('btn-request-service-instant') || document.getElementById('flow-btn-confirm-instant');
            if (instantBtn) {
                instantBtn.disabled = false;
                instantBtn.innerHTML = 'Search Driver';
            }
            return;
        }
    } catch(e) { console.warn('Pre-booking check failed:', e); }

    findMarshal(vehicleId);
};

window.confirmScheduleBooking = async function() {
    const vehicleId = userVehicles[activeVehicleIndex] ? userVehicles[activeVehicleIndex].id : '';
    if (!vehicleId) return;

    // Check user profile completion
    if (!currentUser.name || currentUser.name === 'New Partner' || !currentUser.email || currentUser.email === 'pending@redrivo.com') {
        document.getElementById('ud-pending-vehicle-id').value = vehicleId;
        window.userProfileTriggeredByBooking = true;
        document.getElementById('user-details-modal').style.display = 'flex';
        resetSlideToConfirm('slide-confirm-schedule');
        return;
    }

    // ── HARD GUARD: block re-booking if vehicle already has active trip ─────
    try {
        const allRequests = await apiGet('/requests');
        const myReqs = allRequests.filter(r => (r.customerId || r.customerid) === currentUser.id);
        const existingActive = myReqs.find(r =>
            (r.vehicleId || r.vehicleid) === vehicleId &&
            !['pending', 'scheduled', 'completed', 'cancelled', 'returned', 'drop_completed'].includes(r.status)
        );
        if (existingActive) {
            showToast('This vehicle already has an active service request. Track your current order.', 'error');
            resetSlideToConfirm('slide-confirm-schedule');
            return;
        }
    } catch(e) { console.warn('Pre-booking check failed:', e); }

    const dateVal = window.selectedScheduleDate || '';
    const timeVal = window.selectedScheduleTime || '';

    if (window.bookingFlow !== 'p2p' && !window.selectedGarageId) {
        showToast('Please select a nearby partner garage from the Garage menu first.', 'error');
        switchTab('focus-garage');
        resetSlideToConfirm('slide-confirm-schedule');
        return;
    }

    if (!dateVal) {
        showToast('Please select a date for scheduling.', 'error');
        resetSlideToConfirm('slide-confirm-schedule');
        return;
    }

    // Retrieve locations
    const locInput = document.getElementById(`pickup-location-global`);
    const dropInput = document.getElementById(`drop-location-global`);
    let lat = 19.0760;
    let lng = 72.8777;
    let pickupAddress = '';
    let dropAddress = '';
    
    if (locInput) {
        pickupAddress = (locInput.value.trim() || locInput.getAttribute('data-address') || '').trim();
        const dataLat = locInput.getAttribute('data-lat');
        const dataLng = locInput.getAttribute('data-lng');
        if (dataLat && dataLng) {
            lat = parseFloat(dataLat);
            lng = parseFloat(dataLng);
        }
    }
    if (dropInput) {
        dropAddress = dropInput.value.trim();
    }

    if (!pickupAddress || !dropAddress) {
        showToast('Please choose location', 'error');
        resetSlideToConfirm('slide-confirm-schedule');
        return;
    }

    const reqId = 'req_' + generateId();
    
    try {
        let redrivoServiceCharge = currentServiceType === 'TrackA' ? 299 : 99;
        let inspectionFee = currentServiceType === 'TrackB' ? 250 : 0;
        let distance = 0;
        const pickupInput = document.getElementById('pickup-location-global');
        const dropInput = document.getElementById('drop-location-global');
        if (pickupInput && dropInput) {
            const pLat = parseFloat(pickupInput.getAttribute('data-lat'));
            const pLng = parseFloat(pickupInput.getAttribute('data-lng'));
            const dLat = parseFloat(dropInput.getAttribute('data-lat'));
            const dLng = parseFloat(dropInput.getAttribute('data-lng'));
            if (!isNaN(pLat) && !isNaN(pLng) && !isNaN(dLat) && !isNaN(dLng)) {
                distance = calcDistanceKm(pLat, pLng, dLat, dLng);
            }
        }
        let pdCharge = 0;
        if (currentPDType !== 'None') {
            const baseCharge = Math.max(150, Math.round(distance * window.customerRatePerKm));
            pdCharge = currentPDType === 'Both' ? baseCharge * 2 : baseCharge;
        }
        let total = redrivoServiceCharge + inspectionFee + pdCharge;

        await apiPost('/service-requests', {
            id: reqId,
            customerId: currentUser.id,
            vehicleId,
            garageId: window.bookingFlow === 'p2p' ? null : window.selectedGarageId,
            date: dateVal,
            issue: `Scheduled Pickup (${timeVal})`,
            serviceType: 'HealthCheck',
            bookingFlow: window.bookingFlow || 'p2p',
            pickupDropType: window.pickupDropType || 'Pickup',
            pickupDropCost: pdCharge,
            garageServiceCharge: 0,
            gstAmount: 0,
            totalCustomerPrice: total,
            lat,
            lng,
            pickup_address: pickupAddress,
            drop_address: dropAddress,
            vehicle_condition: window.selectedVehicleCondition || 'Working',
            pricingMode: window.selectedPricingMode || 'distance',
            estimatedHours: window.selectedPricingMode === 'hourly' ? (window.selectedEstimatedHours || 4) : null,
            route_stops: window.routeStops || [],
            status: 'scheduled'
        });

        showToast('Service scheduled successfully!', 'success');
        
        // Reset inputs and fields
        window.selectedScheduleDate = '';
        window.selectedScheduleTime = '';
        window.bookingSubView = '2A';
        window.userManuallySelectedHours = false;
        window.routeStops = [];
        if (typeof window.renderRouteStopsUI === 'function') window.renderRouteStopsUI();
        if (typeof window.updateRouteVisibility === 'function') window.updateRouteVisibility();
        
        loadDashboard();
    } catch (e) {
        showToast('Failed to schedule service: ' + e.message, 'error');
        resetSlideToConfirm('slide-confirm-schedule');
    }
};

window.initSlideToConfirm = function(container, onConfirm) {
    const handle = container.querySelector('.slide-handle');
    const text = container.querySelector('.slide-text');
    const highlight = container.querySelector('.slide-highlight');
    if (!handle) return;

    let startX = 0;
    let isDragging = false;
    let maxSlide = 0;

    function onStart(e) {
        if (container.classList.contains('confirmed')) return;
        isDragging = true;
        startX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
        maxSlide = container.clientWidth - handle.clientWidth - 8; // 8px for margins
        handle.style.transition = 'none';
        if (highlight) highlight.style.transition = 'none';
        handle.style.cursor = 'grabbing';
    }

    function onMove(e) {
        if (!isDragging) return;
        const currentX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
        let deltaX = currentX - startX;

        if (deltaX < 0) deltaX = 0;
        if (deltaX > maxSlide) deltaX = maxSlide;

        handle.style.transform = `translateX(${deltaX}px)`;
        if (highlight) highlight.style.width = `${deltaX + 24}px`;

        const pct = deltaX / maxSlide;
        if (text) text.style.opacity = 1 - pct;
    }

    function onEnd() {
        if (!isDragging) return;
        isDragging = false;
        handle.style.cursor = 'grab';

        const transformValue = handle.style.transform;
        const match = transformValue.match(/translateX\(([\d.]+)px\)/);
        const currentX = match ? parseFloat(match[1]) : 0;

        if (currentX >= maxSlide * 0.9) {
            container.classList.add('confirmed');
            handle.style.transition = 'transform 0.2s ease';
            if (highlight) highlight.style.transition = 'width 0.2s ease';
            handle.style.transform = `translateX(${maxSlide}px)`;
            if (highlight) highlight.style.width = '100%';
            if (text) {
                text.innerHTML = '<span style="color: #10b981;">Confirmed ✓</span>';
                text.style.opacity = 1;
            }
            setTimeout(() => {
                onConfirm();
            }, 300);
        } else {
            handle.style.transition = 'transform 0.2s ease';
            if (highlight) highlight.style.transition = 'width 0.2s ease';
            handle.style.transform = 'translateX(0px)';
            if (highlight) highlight.style.width = '0px';
            if (text) text.style.opacity = 1;
        }
    }

    // Touch events
    handle.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);

    // Mouse events
    handle.addEventListener('mousedown', onStart);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
};

// Global Dispute and Rating variables/helpers
window.currentDisputeTripId = null;
window.currentDisputeMarshalId = null;

window.openDisputeForm = function() {
    // Open from Dropoff screen
    window.currentDisputeTripId = window.currentTripId;
    if (window._activeTrip) {
        window.currentDisputeMarshalId = window._activeTrip.marshalId || window._activeTrip.marshalid;
    }
    
    const auditModal = document.getElementById('audit-modal');
    if (auditModal) auditModal.style.display = 'none';
    
    const disputeModal = document.getElementById('dispute-modal');
    if (disputeModal) disputeModal.style.display = 'flex';
    lucide.createIcons();
};

window.openDisputeFormForPastTrip = function(tripId, marshalId) {
    window.currentDisputeTripId = tripId;
    window.currentDisputeMarshalId = marshalId;
    
    const disputeModal = document.getElementById('dispute-modal');
    if (disputeModal) disputeModal.style.display = 'flex';
    lucide.createIcons();
};

window.closeDisputeModal = function() {
    const disputeModal = document.getElementById('dispute-modal');
    if (disputeModal) disputeModal.style.display = 'none';
};

window.submitDispute = async function() {
    const category = document.getElementById('dispute-reason-category').value;
    const details = document.getElementById('dispute-details').value.trim();
    if (!details) {
        showToast('Please enter description details', 'error');
        return;
    }
    
    const reason = `${category}: ${details}`;
    
    try {
        const res = await fetch(`${API_URL}/disputes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tripId: window.currentDisputeTripId,
                customerId: currentUser.id,
                marshalId: window.currentDisputeMarshalId,
                reason: reason
            })
        });
        
        if (res.ok) {
            showToast('Dispute filed successfully. Driver payouts have been frozen pending review.', 'success');
            window.closeDisputeModal();
            const otpDisplay = document.getElementById('final-otp-display');
            if (otpDisplay) {
                otpDisplay.innerHTML = `<p style="margin: 0; font-size: 0.9rem; color: var(--danger); font-weight: bold;">OTP LOCKED DUE TO PENDING DISPUTE</p>`;
                otpDisplay.style.background = 'rgba(239, 68, 68, 0.1)';
            }
            const payBtn = document.getElementById('btn-pay-invoice');
            if (payBtn) payBtn.disabled = true;
            const rejectBtn = document.getElementById('btn-reject-handover');
            if (rejectBtn) rejectBtn.disabled = true;
        } else {
            const data = await res.json();
            showToast(data.error || 'Failed to file dispute', 'error');
        }
    } catch (err) {
        showToast('Network error filing dispute', 'error');
    }
};

// Rating Modal Logic
window.currentRatingValue = 0;
window.currentRatingTripId = null;
window.currentRatingMarshalName = '';

window.openRatingModal = function(tripId, marshalName) {
    window.currentRatingTripId = tripId;
    window.currentRatingMarshalName = marshalName;
    window.currentRatingValue = 0;
    
    const nameEl = document.getElementById('rating-marshal-name');
    if (nameEl) nameEl.textContent = marshalName;
    
    document.querySelectorAll('#rating-modal .star').forEach(star => {
        star.style.color = 'rgba(255, 255, 255, 0.15)';
    });
    
    const modal = document.getElementById('rating-modal');
    if (modal) modal.style.display = 'flex';
};

window.setRating = function(rating) {
    window.currentRatingValue = rating;
    document.querySelectorAll('#rating-modal .star').forEach((star, idx) => {
        if (idx < rating) {
            star.style.color = '#facc15';
        } else {
            star.style.color = 'rgba(255, 255, 255, 0.15)';
        }
    });
};

window.submitRating = async function() {
    if (window.currentRatingValue === 0) {
        showToast('Please select a star rating', 'error');
        return;
    }
    
    try {
        const res = await fetch(`${API_URL}/trips/${window.currentRatingTripId}/rate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rating: window.currentRatingValue })
        });
        
        if (res.ok) {
            showToast('Thank you for rating!', 'success');
            const modal = document.getElementById('rating-modal');
            if (modal) modal.style.display = 'none';
        } else {
            const data = await res.json();
            showToast(data.error || 'Failed to submit rating', 'error');
        }
    } catch (err) {
        showToast('Network error submitting rating', 'error');
    }
};

window.selectedDeletionReason = '';

window.openDeleteAccountModal = function() { // Renamed internally to trigger screen 1
    document.getElementById('delete-screen-1').style.display = 'flex';
};

window.closeDeleteFlow = function() {
    document.getElementById('delete-screen-1').style.display = 'none';
    document.getElementById('delete-screen-2').style.display = 'none';
    document.getElementById('delete-screen-3').style.display = 'none';
};

window.goToDeleteScreen1 = function() {
    document.getElementById('delete-screen-1').style.display = 'flex';
    document.getElementById('delete-screen-2').style.display = 'none';
    document.getElementById('delete-screen-3').style.display = 'none';
};

window.goToDeleteScreen2 = function() {
    document.getElementById('delete-screen-1').style.display = 'none';
    document.getElementById('delete-screen-2').style.display = 'flex';
    document.getElementById('delete-screen-3').style.display = 'none';
};

window.goToDeleteScreen3 = function(reason) {
    window.selectedDeletionReason = reason;
    document.getElementById('delete-selected-reason-title').innerText = reason;
    document.getElementById('delete-final-feedback').value = '';
    
    document.getElementById('delete-screen-1').style.display = 'none';
    document.getElementById('delete-screen-2').style.display = 'none';
    document.getElementById('delete-screen-3').style.display = 'flex';
};

window.submitAccountDeletionFinal = async function() {
    const reason = window.selectedDeletionReason;
    const feedback = document.getElementById('delete-final-feedback').value;
    
    if (!reason) {
        showToast('Please select a reason', 'error');
        return;
    }
    
    try {
        // Send feedback
        const answers = [
            { q: "What is your primary reason for leaving?", a: reason },
            { q: "Feedback", a: feedback }
        ];
        
        await fetch(`${API_URL}/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser ? currentUser.id : null, userRole: 'customer', surveyType: 'account_deletion', answers })
        });
        
        // Execute delete
        const res = await fetch(`${API_URL}/users/${currentUser ? currentUser.id : ''}`, { method: 'DELETE' });
        
        if (res.ok) {
            showToast('Account deleted successfully', 'success');
            setTimeout(logout, 1500);
        } else if (res.status === 409) {
            const data = await res.json();
            showToast(data.error || 'Cannot delete account with active services', 'error');
            closeDeleteFlow();
        } else {
            showToast('Failed to delete account', 'error');
        }
    } catch (err) {
        showToast('Error deleting account', 'error');
    }
};

window.checkAndShowCustomerFeedback = async function() {
    if (!currentUser || !currentUser.id) return;
    try {
        const res = await fetch(`${API_URL}/trips/user/${currentUser ? currentUser.id : ''}`);
        if (!res.ok) return;
        const data = await res.json();
        const trips = data.trips || data;
        const unratedTrip = trips.find(t => t.status === 'completed' && !localStorage.getItem('survey_completed_' + t.id));
        if (unratedTrip) {
            document.getElementById('fb-trip-id').value = unratedTrip.id;
            document.getElementById('post-service-feedback-modal').style.display = 'flex';
        }
    } catch (e) {
        console.error("Survey check error", e);
    }
};

window.submitCustomerFeedback = async function() {
    const tripId = document.getElementById('fb-trip-id').value;
    const rating = document.getElementById('fb-rating').value;
    const punctual = document.getElementById('fb-punctual').value;
    const challenge = document.getElementById('fb-challenge').value;
    const garage = document.getElementById('fb-garage-feature').value;
    const improve = document.getElementById('fb-improve').value;
    
    const answers = [
        { q: "How would you rate your vehicle delivery experience?", a: rating },
        { q: "Was the driver punctual and did they drive safely?", a: punctual },
        { q: "What is the biggest challenge you face when moving your vehicle?", a: challenge },
        { q: "We will soon add trusted Garages. Would you use this?", a: garage },
        { q: "What can we do to improve our service?", a: improve }
    ];
    
    try {
        const res = await fetch(`${API_URL}/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser ? currentUser.id : null, userRole: 'customer', surveyType: 'post_service', answers })
        });
        
        if (res.ok) {
            localStorage.setItem('survey_completed_' + tripId, 'true');
            document.getElementById('post-service-feedback-modal').style.display = 'none';
            showToast('Thank you for your feedback!', 'success');
        } else {
            showToast('Failed to submit feedback', 'error');
        }
    } catch(err) {
        showToast('Network error', 'error');
    }
};

// Hook into loadDashboard
const _oldLoadDashboardSurvey = window.loadDashboard;
window.loadDashboard = async function() {
    if (_oldLoadDashboardSurvey) await _oldLoadDashboardSurvey();
    checkAndShowCustomerFeedback();
};

window.pendingMediaRequestType = null;
window.requestMediaPermission = function(type) {
    document.getElementById('photo-action-sheet').style.display = 'none';
    const hasConsented = localStorage.getItem('redrivo_media_consent');
    if (hasConsented === 'granted') {
        if (type === 'camera') {
            document.getElementById('v-photo-camera').click();
        } else {
            document.getElementById('v-photo-gallery').click();
        }
    } else {
        window.pendingMediaRequestType = type;
        document.getElementById('camera-permission-modal').style.display = 'flex';
    }
};

window.acceptMediaPermission = function() {
    localStorage.setItem('redrivo_media_consent', 'granted');
    document.getElementById('camera-permission-modal').style.display = 'none';
    if (window.pendingMediaRequestType === 'camera') {
        document.getElementById('v-photo-camera').click();
    } else if (window.pendingMediaRequestType === 'gallery') {
        document.getElementById('v-photo-gallery').click();
    }
    window.pendingMediaRequestType = null;
};

window.denyMediaPermission = function() {
    localStorage.setItem('redrivo_media_consent', 'denied');
    document.getElementById('camera-permission-modal').style.display = 'none';
    window.pendingMediaRequestType = null;
    if (typeof showToast === 'function') {
        showToast('Permission denied. You can grant access later.', 'error');
    }
};

// Hardware Back Button Handling with Priority Stack
let lastBackPress = 0;
if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    window.Capacitor.Plugins.App.addListener('backButton', () => {
        // Priority 0: Multi-step Garage Booking Flow Overlay
        const garageFlow = document.getElementById('garage-flow-container');
        if (garageFlow && garageFlow.style.display !== 'none') {
            const currentStep = window.currentGarageFlowStep || 1;
            if (currentStep > 1) {
                if (typeof window.goToGarageFlowStep === 'function') {
                    window.goToGarageFlowStep(currentStep - 1);
                }
            } else {
                if (typeof window.exitGarageFlow === 'function') {
                    window.exitGarageFlow();
                } else {
                    garageFlow.style.display = 'none';
                }
            }
            return;
        }

        // Priority 1: Multi-step Account Deletion/Privacy Overlays
        const del3 = document.getElementById('delete-screen-3');
        if (del3 && del3.style.display !== 'none') {
            if (typeof goToDeleteScreen2 === 'function') goToDeleteScreen2();
            return;
        }
        
        const del2 = document.getElementById('delete-screen-2');
        if (del2 && del2.style.display !== 'none') {
            if (typeof goToDeleteScreen1 === 'function') goToDeleteScreen1();
            return;
        }
        
        const del1 = document.getElementById('delete-screen-1');
        if (del1 && del1.style.display !== 'none') {
            if (typeof closeDeleteFlow === 'function') closeDeleteFlow();
            else del1.style.display = 'none';
            return;
        }

        // Priority 2 & 3: Standard Modals and Overlays
        const modals = [
            'photo-action-sheet', 'camera-permission-modal', 'logout-modal', 'vehicle-form-elements', 'user-details-modal', 
            'finding-marshal-screen', 'marshal-en-route-screen', 'payment-modal', 'video-modal', 
            'audit-modal', 'address-details-modal', 'gps-disclosure-modal', 
            'terms-modal', 'privacy-modal', 'garage-booking-options-modal', 
            'dispute-modal', 'rating-modal', 'delete-account-modal', 'post-service-feedback-modal'
        ];
        
        for (const id of modals) {
            const el = document.getElementById(id);
            if (el) {
                const isVisible = el.style.display === 'flex' || 
                                  el.style.display === 'block' || 
                                  el.style.display === 'grid' || 
                                  (!el.classList.contains('hidden') && el.style.display !== 'none');
                
                if (isVisible) {
                    if (id === 'finding-marshal-screen') {
                        const backBtn = document.getElementById('btn-back-marshal-search');
                        if (backBtn && backBtn.style.display !== 'none') {
                            if (typeof cancelMarshalSearch === 'function') cancelMarshalSearch();
                        } else {
                            if (typeof showToast === 'function') showToast('Please wait or stop the search before going back.', 'warning');
                        }
                    } else if (id === 'marshal-en-route-screen') {
                        el.style.display = 'none';
                        sessionStorage.setItem('minimizeEnRoute', 'true');
                        if (typeof loadDashboard === 'function') loadDashboard();
                    } else if (id === 'vehicle-form-elements') {
                        if (typeof hideVehicleForm === 'function') hideVehicleForm();
                    } else if (id === 'video-modal' && typeof closeVideoModal === 'function') {
                        closeVideoModal();
                    } else if (id === 'audit-modal' && typeof closeAuditModal === 'function') {
                        closeAuditModal();
                    } else if (id === 'dispute-modal' && typeof closeDisputeModal === 'function') {
                        closeDisputeModal();
                    } else if (id === 'rating-modal' && typeof closeRatingModal === 'function') {
                        closeRatingModal();
                    } else {
                        el.style.display = 'none';
                        el.classList.add('hidden');
                    }
                    return; // Stop processing once one modal is handled
                }
            }
        }
        
        // Priority 4: If no modal is open, handle secondary tab back navigation
        if (window.redrivoCurrentTab && window.redrivoCurrentTab !== 'garage') {
            if (typeof switchTab === 'function') switchTab('garage');
        } else {
            // Priority 5: Require double press to exit the app when on home tab (root)
            const now = Date.now();
            if (now - lastBackPress < 2000) {
                window.Capacitor.Plugins.App.exitApp();
            } else {
                lastBackPress = now;
                if (typeof showToast === 'function') {
                    showToast("Press back again to exit", "info");
                } else {
                    alert("Press back again to exit");
                }
            }
        }
    });
}

// --- Point-to-Point Route Flow & Stops ---
window.routePickup = null;
window.routeDrop = null;
window.routeStops = [];
window.routePolylineControl = null;
window.stopMarkers = [];

function truncateAddress(addr) {
    if (!addr) return '';
    const parts = addr.split(',');
    const firstPart = parts[0].trim();
    if (firstPart.length > 15) {
        return firstPart.substring(0, 15) + '...';
    }
    return firstPart;
}

function clearRouteLine() {
    if (window.routePolylineControl) {
        if(window.routePolylineControl) window.routePolylineControl.setMap(null);
        window.routePolylineControl = null;
    }
    const badge = document.getElementById('route-stats-badge');
    if (badge) badge.style.display = 'none';
    const centerPin = document.getElementById('center-pickup-pin');
    if (centerPin) centerPin.style.display = 'flex';
}

window.updateRouteVisibility = updateRouteVisibility;
function updateRouteVisibility() {
    const pickupInput = document.getElementById('pickup-location-global');
    const dropInput = document.getElementById('drop-location-global');
    
    if (pickupInput && dropInput) {
        const pLat = pickupInput.getAttribute('data-lat');
        const pLng = pickupInput.getAttribute('data-lng');
        const dLat = dropInput.getAttribute('data-lat');
        const dLng = dropInput.getAttribute('data-lng');
        
        const pLatNum = parseFloat(pLat);
        const pLngNum = parseFloat(pLng);
        const dLatNum = parseFloat(dLat);
        const dLngNum = parseFloat(dLng);
        
        if (!isNaN(pLatNum) && !isNaN(pLngNum) && !isNaN(dLatNum) && !isNaN(dLngNum) && pickupLocationResolved && dropLocationResolved) {
            window.routePickup = {
                lat: pLatNum,
                lng: pLngNum,
                address: pickupInput.value || pickupInput.getAttribute('data-address')
            };
            window.routeDrop = {
                lat: dLatNum,
                lng: dLngNum,
                address: dropInput.value || dropInput.getAttribute('data-address')
            };
            window.routeStops = window.routeStops || [];
            
            recalculateAndDrawRoute();
            return;
        }
    }
    
    clearRouteLine();
}

function recalculateAndDrawRoute() {
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
    const pickupIcon = createGoogleIcon('#22c55e', 'P');
    customerMarker = new google.maps.Marker({ position: {lat: window.routePickup.lat, lng: window.routePickup.lng}, map: customerMap, icon: pickupIcon });

    // Stop markers: Yellow circles
    if (window.routeStops && Array.isArray(window.routeStops)) {
        window.routeStops.forEach((stop) => {
            const isHalt = stop.haltTime && parseInt(stop.haltTime) > 0;
            const stopIcon = isHalt ? createGoogleIcon('#eab308', 'H') : createGoogleIcon('#f97316', 'R');
            const sm = new google.maps.Marker({ position: {lat: stop.lat, lng: stop.lng}, map: customerMap, icon: stopIcon });
            window.stopMarkers.push(sm);
        });
    }

    // Drop marker: Pulsing red dot
    const dropIcon = createGoogleIcon('#ef4444', 'D');
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

    const v = userVehicles[activeVehicleIndex];
    const isBike = v && (
        String(v.type || '').toLowerCase().includes('bike') || 
        String(v.type || '').toLowerCase().includes('motorcycle') || 
        String(v.category || '').toLowerCase().includes('bike')
    );

    // NOTE ON TRAVEL MODE FOR TWO-WHEELERS:
    // Legacy Google Maps DirectionsService does not natively support a dedicated 'TWO_WHEELER' mode
    // (which is exclusive to the modern Routes API). We use DRIVING (car routes) for both cars and
    // bikes as the closest road-legal route approximation, avoiding BICYCLING which routes via bicycle-only paths.
    const selectedTravelMode = isBike ? google.maps.TravelMode.DRIVING : google.maps.TravelMode.DRIVING;

    const request = {
        origin: new google.maps.LatLng(window.routePickup.lat, window.routePickup.lng),
        destination: new google.maps.LatLng(window.routeDrop.lat, window.routeDrop.lng),
        waypoints: gWaypoints,
        travelMode: selectedTravelMode
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
            
            // Calculate ETA-based duration default
            if (!window.userManuallySelectedHours) {
                let computedHours = Math.ceil(totalSeconds / 3600);
                if (computedHours < 1) computedHours = 1;
                if (computedHours > 12) computedHours = 12;
                window.selectedEstimatedHours = computedHours;
                const hoursSelect = document.getElementById('booking-estimated-hours');
                if (hoursSelect) hoursSelect.value = String(computedHours);
            }

            if (typeof updateFixedActionButton === 'function') {
                updateFixedActionButton();
            }

            const distEl = document.getElementById('route-est-distance');
            const durEl = document.getElementById('route-est-duration');
            const badge = document.getElementById('route-stats-badge');
            if (distEl) distEl.textContent = `${km} km`;
            if (durEl) durEl.textContent = `${mins} mins`;
            if (badge) badge.style.display = 'flex';

            // Auto fit bounds with comfortable, universally compatible number padding
            let paddingVal = 80;
            if (window.calculatedRouteDistance > 15) {
                paddingVal = 60;
            } else if (window.calculatedRouteDistance > 5) {
                paddingVal = 80;
            } else {
                paddingVal = 95;
            }
            customerMap.fitBounds(route.bounds, paddingVal);
        } else {
            console.error("Directions request failed due to " + status);
        }
    });
}
window.routeStops = [];

window.openRouteSearchModal = function(type, indexOrId = null) {
    window.currentSearchType = type;
    window.currentSearchIndex = indexOrId;
    window.routeSearchModalOpen = true;

    let modal = document.getElementById('route-search-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'route-search-modal';
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(18, 22, 29, 0.98);
            backdrop-filter: blur(15px);
            -webkit-backdrop-filter: blur(15px);
            z-index: 99999;
            display: flex;
            flex-direction: column;
            padding: 24px 16px;
            font-family: 'Inter', sans-serif;
            color: #fff;
        `;
        modal.innerHTML = `
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 20px; width: 100%;">
                <div style="position: relative; flex: 1; display: flex; align-items: center;">
                    <span class="material-symbols-outlined" style="position: absolute; left: 14px; color: #facc15;">search</span>
                    <input type="text" id="route-search-input" placeholder="Search location..." style="width: 100%; padding: 14px 14px 14px 44px; border-radius: 12px; border: 1.5px solid rgba(250, 204, 21, 0.3); background: rgba(0,0,0,0.5); color: #fff; font-size: 1rem; font-weight: 600; outline: none; box-shadow: inset 0 2px 4px rgba(0,0,0,0.2);">
                </div>
                <button id="route-search-cancel" style="padding: 10px 14px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); border-radius: 10px; color: #fff; font-size: 0.88rem; font-weight: 600; cursor: pointer; outline: none;">Cancel</button>
            </div>
            <div id="route-search-suggestions" style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;"></div>
        `;
        document.body.appendChild(modal);

        document.getElementById('route-search-cancel').onclick = () => {
            modal.style.display = 'none';
            window.routeSearchModalOpen = false;
        };

        const input = document.getElementById('route-search-input');
        let searchTimeout = null;
        input.oninput = () => {
            const query = input.value.trim();
            const suggestionsDiv = document.getElementById('route-search-suggestions');
            if (searchTimeout) clearTimeout(searchTimeout);

            if (query.length < 2) {
                const targetId = window.currentSearchType === 'pickup' ? 'global' : (window.currentSearchType === 'drop' ? 'global-drop' : 'global');
                suggestionsDiv.innerHTML = getSearchHistoryHtml(targetId);
                return;
            }

            searchTimeout = setTimeout(async () => {
                try {
                    suggestionsDiv.innerHTML = `<div style="padding: 16px; color: #a1a1aa; font-size: 0.85rem; text-align: center;">Searching...</div>`;
                    
                    let biasParams = '';
                    const pickupInput = document.getElementById('pickup-location-global');
                    if (pickupInput && pickupInput.getAttribute('data-lat')) {
                        biasParams = `&lat=${pickupInput.getAttribute('data-lat')}&lng=${pickupInput.getAttribute('data-lng')}`;
                    }
                    const res = await fetch(`${API_URL}/maps/autocomplete?q=${encodeURIComponent(query)}${biasParams}`);
                    if (!res.ok) throw new Error('API Error');
                    const data = await res.json();
                    
                    if (!data || data.length === 0) {
                        suggestionsDiv.innerHTML = `<div style="padding: 16px; color: #a1a1aa; font-size: 0.85rem; text-align: center;">No matches found.</div>`;
                        return;
                    }

                    suggestionsDiv.innerHTML = data.map(item => {
                        let distanceBadge = '';
                        if (item.distance_meters) {
                            const km = (item.distance_meters / 1000).toFixed(1);
                            distanceBadge = `<span style="font-size: 0.7rem; color: #facc15; background: rgba(250, 204, 21, 0.15); border: 1px solid rgba(250, 204, 21, 0.3); border-radius: 4px; padding: 1px 4px; font-weight: 700; margin-right: 6px;">${km} km</span>`;
                        }

                        return `
                            <div class="suggestion-item" style="display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,0.04); cursor: pointer;" onclick="selectRouteSearchSuggestion(window.currentSearchType, window.currentSearchIndex, '${item.address.replace(/'/g, "\\'")}', '${item.place_id}', ${item.lat || 'null'}, ${item.lng || 'null'})">
                                <span class="material-symbols-outlined" style="color: #a1a1aa; font-size: 1.2rem; margin-top: 2px;">location_on</span>
                                <div style="display: flex; flex-direction: column; gap: 2px; flex: 1;">
                                    <span style="color: #ffffff; font-weight: 700; font-size: 0.9rem;">${item.name}</span>
                                    <div style="display: flex; align-items: center; gap: 4px; flex-wrap: wrap;">
                                        ${distanceBadge}
                                        <span style="color: #a1a1aa; font-size: 0.78rem; line-height: 1.2;">${item.address}</span>
                                    </div>
                                </div>
                            </div>
                        `;
                    }).join('');
                } catch (e) {
                    console.error('Route search failed', e);
                    suggestionsDiv.innerHTML = `<div style="padding: 16px; color: #ef4444; font-size: 0.85rem; text-align: center;">Error loading suggestions.</div>`;
                }
            }, 300);
        };
    }

    const searchInput = document.getElementById('route-search-input');
    if (searchInput) {
        searchInput.value = '';
        if (type === 'pickup') {
            searchInput.placeholder = 'Search for pickup location...';
        } else if (type === 'drop') {
            searchInput.placeholder = 'Search for drop location...';
        } else {
            searchInput.placeholder = 'Search for stop location...';
        }
    }

    const suggestionsDiv = document.getElementById('route-search-suggestions');
    if (suggestionsDiv) {
        const targetId = type === 'pickup' ? 'global' : (type === 'drop' ? 'global-drop' : 'global');
        suggestionsDiv.innerHTML = getSearchHistoryHtml(targetId);
    }

    modal.style.display = 'flex';
    window.currentSearchIndex = indexOrId;
    
    setTimeout(() => {
        const activeInput = document.getElementById('route-search-input');
        if (activeInput) activeInput.focus();
    }, 150);
};

window.selectRouteSearchSuggestion = async function(type, indexOrId, address, placeId, defaultLat = null, defaultLng = null) {
    const modal = document.getElementById('route-search-modal');
    if (modal) modal.style.display = 'none';
    window.routeSearchModalOpen = false;

    let lat = defaultLat !== null ? parseFloat(defaultLat) : 19.0664;
    let lng = defaultLng !== null ? parseFloat(defaultLng) : 72.8680;

    if (placeId) {
        showToast("Resolving stop coordinates...", "info");
        try {
            const res = await fetch(`${API_URL}/maps/details?place_id=${placeId}`);
            if (res.ok) {
                const details = await res.json();
                if (details && details.lat !== undefined && details.lng !== undefined) {
                    lat = details.lat;
                    lng = details.lng;
                    if (details.address) {
                        address = details.address;
                    }
                }
            }
        } catch (e) {
            console.error("Resolve coords error:", e);
        }
    }

    if (type === 'pickup') {
        selectLocationSuggestion('global', address, lat, lng, false, null, placeId);
    } else if (type === 'drop') {
        selectLocationSuggestion('global-drop', address, lat, lng, false, null, placeId);
    } else if (type === 'stop') {
        window.showHaltTimePickerModal(address, lat, lng, placeId);
        return;
    }
    
    // Add to local storage search history
    addToSearchHistory(address.split(',')[0], address, lat, lng, placeId);

    window.renderRouteStopsUI();
    window.updateRouteVisibility();
};

window.showHaltTimePickerModal = function(address, lat, lng, placeId) {
    const existing = document.getElementById('halt-picker-modal');
    if (existing) existing.remove();

    const display = address.split(',')[0] || address;

    const activeVehicle = window.userVehicles && window.userVehicles[window.activeVehicleIndex];
    const isBike = activeVehicle && (String(activeVehicle.type).toLowerCase() === 'bike' || String(activeVehicle.category || '').toLowerCase() === 'bike');
    const vehicleType = isBike ? 'bike' : 'car';
    const haltRateKey = `${vehicleType}_halt_rate_per_min`;
    const haltRate = window.redrivoSystemSettings?.[haltRateKey] !== undefined 
        ? parseFloat(window.redrivoSystemSettings[haltRateKey]) 
        : (vehicleType === 'bike' ? 3 : 5);

    const modalHtml = `
        <div id="halt-picker-modal" class="overlay" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 10000; font-family: 'Inter', sans-serif;">
            <div class="glass-card" style="width: 90%; max-width: 360px; padding: 24px; border-radius: 24px; background: rgba(18, 22, 29, 0.95); border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 20px 40px rgba(0,0,0,0.6); text-align: center; backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);">
                <div style="display: flex; justify-content: center; align-items: center; width: 48px; height: 48px; background: rgba(250, 204, 21, 0.1); border-radius: 50%; margin: 0 auto 16px;">
                    <span class="material-symbols-outlined" style="color: #facc15; font-size: 1.8rem; font-weight: bold;">schedule</span>
                </div>
                <h3 style="color: #fff; font-size: 1.15rem; font-weight: 800; margin: 0 0 8px; line-height: 1.2;">Halt Time (Optional)</h3>
                <p style="color: #a1a1aa; font-size: 0.8rem; margin: 0 0 20px; line-height: 1.4;">Halt rate: <strong style="color: #facc15;">₹${haltRate}/min</strong>. Specify how many minutes the Marshal should halt at <br><strong style="color: #fff;">${display}</strong>.</p>
                
                <div style="display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 20px;">
                    <button onclick="adjustHaltPicker(-5)" style="width: 36px; height: 36px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05); color: #fff; font-size: 1.2rem; font-weight: bold; cursor: pointer; outline: none;">-</button>
                    <input type="number" id="halt-picker-input" min="0" value="0" style="width: 80px; height: 44px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.2); color: #fff; font-size: 1.2rem; font-weight: 800; text-align: center; outline: none;">
                    <button onclick="adjustHaltPicker(5)" style="width: 36px; height: 36px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05); color: #fff; font-size: 1.2rem; font-weight: bold; cursor: pointer; outline: none;">+</button>
                </div>
                
                <div style="display: flex; gap: 8px; justify-content: center; margin-bottom: 24px;">
                    <button onclick="setHaltPicker(5)" style="flex: 1; padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(250, 204, 21, 0.2); background: rgba(250, 204, 21, 0.05); color: #facc15; font-size: 0.75rem; font-weight: 700; cursor: pointer; outline: none;">5m</button>
                    <button onclick="setHaltPicker(10)" style="flex: 1; padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(250, 204, 21, 0.2); background: rgba(250, 204, 21, 0.05); color: #facc15; font-size: 0.75rem; font-weight: 700; cursor: pointer; outline: none;">10m</button>
                    <button onclick="setHaltPicker(15)" style="flex: 1; padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(250, 204, 21, 0.2); background: rgba(250, 204, 21, 0.05); color: #facc15; font-size: 0.75rem; font-weight: 700; cursor: pointer; outline: none;">15m</button>
                    <button onclick="setHaltPicker(30)" style="flex: 1; padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(250, 204, 21, 0.2); background: rgba(250, 204, 21, 0.05); color: #facc15; font-size: 0.75rem; font-weight: 700; cursor: pointer; outline: none;">30m</button>
                </div>
                
                <div style="display: flex; gap: 12px;">
                    <button onclick="closeHaltPickerModal()" style="flex: 1; padding: 12px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.05); color: #a1a1aa; font-size: 0.9rem; font-weight: 700; cursor: pointer; outline: none;">Cancel</button>
                    <button onclick="confirmHaltPickerModal('${address.replace(/'/g, "\\'")}', ${lat}, ${lng}, '${placeId}')" style="flex: 1; padding: 12px; border-radius: 12px; border: none; background: #facc15; color: #000; font-size: 0.9rem; font-weight: 800; cursor: pointer; outline: none; box-shadow: 0 4px 12px rgba(250, 204, 21, 0.2);">Confirm</button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    window.adjustHaltPicker = function(amount) {
        const input = document.getElementById('halt-picker-input');
        if (input) {
            let val = parseInt(input.value) || 0;
            val = Math.max(0, val + amount);
            input.value = val;
        }
    };

    window.setHaltPicker = function(val) {
        const input = document.getElementById('halt-picker-input');
        if (input) {
            input.value = val;
        }
    };

    window.closeHaltPickerModal = function() {
        const modal = document.getElementById('halt-picker-modal');
        if (modal) modal.remove();
    };

    window.confirmHaltPickerModal = function(addr, lt, lg, pId) {
        const input = document.getElementById('halt-picker-input');
        const haltTime = input ? (parseInt(input.value) || 0) : 0;
        
        window.routeStops.push({ address: addr, lat: lt, lng: lg, haltTime });
        window.closeHaltPickerModal();
        
        window.renderRouteStopsUI();
        window.updateRouteVisibility();
        
        addToSearchHistory(addr.split(',')[0], addr, lt, lg, pId);
    };
};

window.updateRouteStopHalt = function(idx, val) {
    const mins = Math.max(0, parseInt(val) || 0);
    if (window.routeStops && window.routeStops[idx]) {
        window.routeStops[idx].haltTime = mins;
    }
    if (typeof updatePricingSummary === 'function') updatePricingSummary();
};

window.renderRouteStopsUI = function() {
    const list = document.getElementById('route-stops-list');
    if (!list) return;

    if (window.routeStops.length === 0) {
        list.style.display = 'none';
        list.innerHTML = '';
        return;
    }

    list.style.display = 'flex';
    list.innerHTML = window.routeStops.map((stop, idx) => {
        const display = stop.address.split(',')[0] || stop.address;
        const haltTime = stop.haltTime || 0;
        return `
            <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 8px 12px; font-family: 'Inter', sans-serif;">
                <div style="display: flex; align-items: center; gap: 8px; flex: 1; overflow: hidden;">
                    <span style="display: flex; align-items: center; justify-content: center; width: 18px; height: 18px; background: #facc15; border-radius: 50%; color: #000; font-size: 0.68rem; font-weight: 800;">${idx + 1}</span>
                    <span style="color: #fff; font-size: 0.8rem; font-weight: 600; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">Stop: ${display}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <div style="display: flex; align-items: center; gap: 4px; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 2px 6px;">
                        <span style="color: #a1a1aa; font-size: 0.7rem; font-weight: 600;">Halt:</span>
                        <input type="number" min="0" value="${haltTime}" onchange="window.updateRouteStopHalt(${idx}, this.value)" style="width: 45px; background: transparent; border: none; color: #fff; font-size: 0.8rem; font-weight: 700; outline: none; text-align: center; padding: 0;">
                        <span style="color: #a1a1aa; font-size: 0.7rem; font-weight: 600;">min</span>
                    </div>
                    <button onclick="removeRouteStop(${idx})" style="background: none; border: none; padding: 4px; cursor: pointer; display: flex; align-items: center; outline: none;">
                        <span class="material-symbols-outlined" style="color: #ef4444; font-size: 1.1rem; font-weight: bold;">close</span>
                    </button>
                </div>
            </div>
        `;
    }).join('');
};

window.removeRouteStop = function(idx) {
    window.routeStops.splice(idx, 1);
    
    if (window.routeStops.length === 0) {
        const pickupInput = document.getElementById('pickup-location-global');
        const dropInput = document.getElementById('drop-location-global');
        if (pickupInput && dropInput) {
            const pLat = parseFloat(pickupInput.getAttribute('data-lat'));
            const pLng = parseFloat(pickupInput.getAttribute('data-lng'));
            const dLat = parseFloat(dropInput.getAttribute('data-lat'));
            const dLng = parseFloat(dropInput.getAttribute('data-lng'));
            const pAddr = (pickupInput.value || '').trim();
            const dAddr = (dropInput.value || '').trim();
            
            const coordsMatch = !isNaN(pLat) && !isNaN(pLng) && !isNaN(dLat) && !isNaN(dLng) && (Math.abs(pLat - dLat) < 0.0001 && Math.abs(pLng - dLng) < 0.0001);
            const addressMatch = pAddr.toLowerCase() === dAddr.toLowerCase() && pAddr !== '';
            
            if ((coordsMatch || addressMatch) && (!window.routeStops || window.routeStops.length === 0)) {
                dropInput.value = '';
                dropInput.removeAttribute('data-lat');
                dropInput.removeAttribute('data-lng');
                dropInput.removeAttribute('data-address');
                showToast("Pickup and final drop locations cannot be the same unless intermediate route stops are added.", "error");
            }
        }
    }
    
    window.renderRouteStopsUI();
    window.updateRouteVisibility();
};

// Dynamic Device Orientation Heading (Compass Pointer for Google Maps / Rapido)
let lastHeading = 0;
function handleOrientation(event) {
    let heading = 0;
    if (event.webkitCompassHeading !== undefined && event.webkitCompassHeading !== null) {
        heading = event.webkitCompassHeading; // iOS
    } else if (event.alpha !== null && event.alpha !== undefined) {
        heading = 360 - event.alpha; // Android/standard
    } else {
        return;
    }
    
    // Filter out tiny orientation changes to avoid jitter
    if (Math.abs(heading - lastHeading) < 2) return;
    lastHeading = heading;
    
    const cones = document.querySelectorAll('.heading-cone');
    const arrows = document.querySelectorAll('.heading-arrow');
    cones.forEach(c => c.style.transform = `rotate(${heading}deg)`);
    arrows.forEach(a => a.style.transform = `rotate(${heading}deg)`);
}

window.addEventListener('deviceorientationabsolute', handleOrientation, true);
window.addEventListener('deviceorientation', handleOrientation, true);

// Open Google Maps navigation helper
window.openGoogleMapsNavigation = function() {
    const pickupInput = document.getElementById('pickup-location-global');
    const dropInput = document.getElementById('drop-location-global');
    
    if (!pickupInput || !dropInput) {
        showToast("Navigation inputs not found.", "error");
        return;
    }
    
    const pLat = pickupInput.getAttribute('data-lat');
    const pLng = pickupInput.getAttribute('data-lng');
    const dLat = dropInput.getAttribute('data-lat');
    const dLng = dropInput.getAttribute('data-lng');
    
    if (!pLat || !pLng || !dLat || !dLng) {
        showToast("Please enter both pickup and drop locations to navigate.", "warning");
        return;
    }
    
    // Construct waypoints if there are intermediate stops
    let waypointsParam = '';
    if (window.routeStops && window.routeStops.length > 0) {
        const stopsStr = window.routeStops.map(stop => `${stop.lat},${stop.lng}`).join('|');
        waypointsParam = `&waypoints=${encodeURIComponent(stopsStr)}`;
    }
    
    const url = `https://www.google.com/maps/dir/?api=1&origin=${pLat},${pLng}&destination=${dLat},${dLng}${waypointsParam}&travelmode=driving`;
    window.open(url, '_blank');
};

setInterval(() => {
    const elements = document.querySelectorAll('.cust-halt-countdown-timer');
    elements.forEach(el => {
        const startedStr = el.getAttribute('data-started');
        const durationMins = parseInt(el.getAttribute('data-duration')) || 0;
        if (!startedStr || durationMins <= 0) return;

        const startedAt = new Date(startedStr).getTime();
        const durationMs = durationMins * 60 * 1000;
        const elapsedMs = Date.now() - startedAt;
        const timeLeftMs = Math.max(0, durationMs - elapsedMs);

        if (timeLeftMs <= 0) {
            el.textContent = "00:00 (Waiting for OTP)";
            el.style.color = '#ef4444';
        } else {
            const min = Math.floor(timeLeftMs / 1000 / 60);
            const sec = Math.floor((timeLeftMs / 1000) % 60);
            el.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
            el.style.color = '#facc15';
        }
    });
}, 1000);

// --- UNIFIED FULL-SCREEN GARAGE BOOKING FLOW LOGIC ---
window.currentGarageFlowStep = 1;
let flowMap = null;
let flowPickupMarker = null;
let flowDropMarker = null;

window.goToGarageFlowStep = function(stepNum) {
    window.currentGarageFlowStep = stepNum;
    
    // Update step indicator label
    const label = document.getElementById('flow-step-label-text');
    if (label) label.textContent = `Step ${stepNum} of 4`;
    
    // Update header dots
    for (let i = 1; i <= 4; i++) {
        const dot = document.getElementById(`flow-dot-${i}`);
        if (dot) {
            if (i === stepNum) dot.classList.add('active');
            else dot.classList.remove('active');
        }
    }
    
    // Toggle Summary Chips visibility
    const chipRoute = document.getElementById('flow-chip-route');
    const chipVehicle = document.getElementById('flow-chip-vehicle');
    const chipCondition = document.getElementById('flow-chip-condition');
    
    if (chipRoute) chipRoute.style.display = stepNum > 1 ? 'flex' : 'none';
    if (chipVehicle) chipVehicle.style.display = stepNum > 2 ? 'flex' : 'none';
    if (chipCondition) chipCondition.style.display = stepNum > 3 ? 'flex' : 'none';
    
    // Slide parent container
    const slideshow = document.getElementById('flow-slideshow-parent');
    if (slideshow) {
        slideshow.style.transform = `translateX(-${(stepNum - 1) * 25}%)`;
    }
    
    // Step-specific initialization
    if (stepNum === 2) {
        renderGarageFlowVehicles();
    } else if (stepNum === 3) {
        // Highlight active condition card if already selected
        const cond = window.tempSelectedVehicleCondition || 'Working';
        const cards = document.querySelectorAll('.condition-card');
        cards.forEach(card => card.classList.remove('active'));
        if (cond === 'Working') {
            const card = document.querySelector('.condition-card.working-card');
            if (card) card.classList.add('active');
        } else if (cond === 'Not Working') {
            const card = document.querySelector('.condition-card.towed-card');
            if (card) card.classList.add('active');
        }
    } else if (stepNum === 4) {
        window.setupGarageFlowRouting(window.tempGarageData, window.tempFlowType, window.tempSelectedVehicleId, window.tempSelectedVehicleCondition);
        initFlowStep4Map();
        initGarageFlowStep4Options(window.tempSelectedVehicleId);
    }
};

function renderGarageFlowVehicles() {
    const container = document.getElementById('flow-vehicle-list-container');
    if (!container) return;
    
    const tab = window.activeGarageTypeTab || 'car';
    
    // Filter user vehicles based on type
    const filteredVehicles = userVehicles.filter(v => {
        const isBike = (v.type || '').toLowerCase().includes('bike') || (v.type || '').toLowerCase().includes('motorcycle');
        return tab === 'bike' ? isBike : !isBike;
    });
    
    if (filteredVehicles.length === 0) {
        const typeLabel = tab === 'bike' ? 'bikes' : 'cars';
        const ctaLabel = tab === 'bike' ? 'Add Bike' : 'Add Car';
        const targetCategory = tab === 'bike' ? 'Bike' : 'Car';
        
        container.innerHTML = `
            <div style="background: rgba(18, 22, 29, 0.85); backdrop-filter: blur(20px); border-radius: 16px; padding: 24px; text-align: center; border: 1px dashed rgba(255, 255, 255, 0.15); margin-top: 10px;">
                <p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 12px;">You haven't added any ${typeLabel} yet.</p>
                <button onclick="exitGarageFlow(); switchTab('vehicles'); showVehicleForm('${targetCategory}');" class="btn" style="background: rgba(255, 255, 255, 0.1); color: #fff; border: 1px solid rgba(255, 255, 255, 0.2); padding: 8px 16px; border-radius: 8px; font-size: 0.8rem; font-weight: 600; cursor: pointer;">${ctaLabel}</button>
            </div>
        `;
        return;
    }
    
    container.innerHTML = filteredVehicles.map(v => {
        let imageSrc = 'images/sedan.png';
        const lowerType = (v.type || '').toLowerCase();
        if (v.photo) {
            imageSrc = v.photo;
        } else {
            if (lowerType.includes('bike') || lowerType.includes('motorcycle')) imageSrc = 'images/bike.png';
            else if (lowerType.includes('suv')) imageSrc = 'images/suv.png';
            else if (lowerType.includes('hatchback')) imageSrc = 'images/hatchback.png';
        }
        
        const isSelected = window.tempSelectedVehicleId === v.id;
        
        return `
        <div class="flow-vehicle-card ${isSelected ? 'active' : ''}" onclick="selectGarageFlowVehicle('${v.id}')">
            <div style="width: 80px; height: 56px; border-radius: 10px; overflow: hidden; background: ${v.photo ? '#0d1017' : 'transparent'}; display: flex; align-items: center; justify-content: center; position: relative; border: 1px solid rgba(255,255,255,0.06); flex-shrink: 0;">
                ${v.photo ? '' : '<div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 100px; height: 60px; background: radial-gradient(ellipse, rgba(250, 204, 21, 0.18) 0%, transparent 70%); z-index: 0; pointer-events: none;"></div>'}
                <img src="${imageSrc}" style="width: 100%; height: 100%; object-fit: contain; ${v.photo ? '' : 'filter: drop-shadow(0 6px 8px rgba(0,0,0,0.45));'} position: relative; z-index: 1; display: block;">
            </div>
            <div style="flex: 1; text-align: left;">
                <div style="font-weight: 700; color: #fff; font-size: 0.88rem;">${v.make} ${v.model}</div>
                <div style="font-size: 0.72rem; color: var(--text-muted); font-weight: 500;">${v.plate}</div>
            </div>
            <span class="material-symbols-outlined" style="color: ${isSelected ? 'var(--primary)' : 'rgba(255,255,255,0.1)'}; font-size: 20px;">
                ${isSelected ? 'radio_button_checked' : 'radio_button_unchecked'}
            </span>
        </div>
        `;
    }).join('');
}

window.selectGarageFlowOption = function(flowType) {
    window.tempFlowType = flowType;
    
    window.bookingFlow = flowType === 'pickup' || flowType === 'round_trip' ? 'garage_standard' : 'garage_return';
    window.pickupDropType = flowType === 'pickup' ? 'Pickup_Only' : (flowType === 'round_trip' ? 'Pickup' : 'Drop');
    
    let labelText = "Route: Pickup ✓";
    if (flowType === 'drop_only') labelText = "Route: Return ✓";
    if (flowType === 'round_trip') labelText = "Route: Round Trip ✓";
    
    const chip = document.getElementById('flow-chip-route');
    if (chip) {
        chip.querySelector('span').textContent = labelText;
    }
    
    window.goToGarageFlowStep(2);
};

window.selectGarageFlowVehicle = function(vehicleId) {
    window.tempSelectedVehicleId = vehicleId;
    
    const index = userVehicles.findIndex(v => v.id === vehicleId);
    if (index !== -1) {
        activeVehicleIndex = index;
    }
    
    const v = userVehicles[index];
    const chip = document.getElementById('flow-chip-vehicle');
    if (chip) {
        chip.querySelector('span').textContent = `Vehicle: ${v.make} ${v.model} ✓`;
    }
    
    renderGarageFlowVehicles();
    
    setTimeout(() => {
        window.goToGarageFlowStep(3);
    }, 180);
};

window.selectGarageFlowCondition = function(condition) {
    window.tempSelectedVehicleCondition = condition;
    
    // Toggle active class on card elements
    const cards = document.querySelectorAll('.condition-card');
    cards.forEach(card => card.classList.remove('active'));
    if (condition === 'Working') {
        const card = document.querySelector('.condition-card.working-card');
        if (card) card.classList.add('active');
    } else {
        const card = document.querySelector('.condition-card.towed-card');
        if (card) card.classList.add('active');
    }
    
    window.onConditionSelected = function(chosenCondition) {
        window.selectedVehicleCondition = chosenCondition;
        
        const chip = document.getElementById('flow-chip-condition');
        if (chip) {
            chip.querySelector('span').textContent = `Condition: ${chosenCondition === 'Working' ? 'Starts & Runs' : 'Needs Tow'} ✓`;
        }
        
        window.goToGarageFlowStep(4);
    };
    
    if (condition === 'Not Working') {
        Swal.fire({
            title: 'Towing Required',
            text: 'Since this vehicle is not in working condition, the assigned Driver will arrange towing assistance. Additional charges may apply based on towing distance, and arrival times may vary. Proceed?',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#facc15',
            cancelButtonColor: '#27272a',
            confirmButtonText: 'Yes, proceed',
            background: '#12161D',
            color: '#fff'
        }).then((result) => {
            if (result.isConfirmed) {
                window.onConditionSelected('Not Working');
            }
        });
    } else {
        window.onConditionSelected('Working');
    }
};

window.setupGarageFlowRouting = function(g, flowType, vehicleId, condition) {
    window.selectedGarageId = g.id;
    window.tempFlowType = flowType;
    window.bookingFlow = flowType === 'pickup' || flowType === 'round_trip' ? 'garage_standard' : 'garage_return';
    window.pickupDropType = flowType === 'pickup' ? 'Pickup_Only' : (flowType === 'round_trip' ? 'Pickup' : 'Drop');
    window.selectedVehicleCondition = condition || 'Working';

    const index = userVehicles.findIndex(v => v.id === vehicleId);
    if (index !== -1) {
        activeVehicleIndex = index;
    }

    const pickupInput = document.getElementById('pickup-location-garage');
    const dropInput = document.getElementById('drop-location-garage');
    const globalPickup = document.getElementById('pickup-location-global');
    const globalDrop = document.getElementById('drop-location-global');

    if (customerMap) {
        if (pickupMarker) pickupMarker.setMap(null);
        if (dropMarker) dropMarker.setMap(null);
    }

    let customerAddress = '';
    let customerLat = '';
    let customerLng = '';
    
    // Pre-fill customer address from global Home tab inputs on first load
    if (flowType === 'pickup' || flowType === 'round_trip') {
        if (globalPickup) {
            customerAddress = globalPickup.getAttribute('data-address') || globalPickup.value || '';
            customerLat = globalPickup.getAttribute('data-lat') || '';
            customerLng = globalPickup.getAttribute('data-lng') || '';
        }
    } else {
        if (globalDrop) {
            customerAddress = globalDrop.getAttribute('data-address') || globalDrop.value || '';
            customerLat = globalDrop.getAttribute('data-lat') || '';
            customerLng = globalDrop.getAttribute('data-lng') || '';
        }
    }

    if (!customerAddress || customerAddress.startsWith("Detecting") || customerAddress.startsWith("Approximate")) {
        customerAddress = "Trident Hotel, BKC, Mumbai";
        customerLat = "19.0664";
        customerLng = "72.8680";
    }

    if (flowType === 'pickup' || flowType === 'round_trip') {
        if (pickupInput) {
            pickupInput.value = customerAddress;
            pickupInput.setAttribute('data-address', customerAddress);
            pickupInput.setAttribute('data-lat', customerLat);
            pickupInput.setAttribute('data-lng', customerLng);
            applyLockedStyles(pickupInput, false, 'pickup');
        }
        if (dropInput) {
            dropInput.value = g.name + " (" + g.address + ")";
            dropInput.setAttribute('data-address', g.address);
            dropInput.setAttribute('data-lat', g.lat);
            dropInput.setAttribute('data-lng', g.lng);
            applyLockedStyles(dropInput, true, 'drop');
        }
    } else {
        if (pickupInput) {
            pickupInput.value = g.name + " (" + g.address + ")";
            pickupInput.setAttribute('data-address', g.address);
            pickupInput.setAttribute('data-lat', g.lat);
            pickupInput.setAttribute('data-lng', g.lng);
            applyLockedStyles(pickupInput, true, 'pickup');
        }
        if (dropInput) {
            dropInput.value = customerAddress;
            dropInput.setAttribute('data-address', customerAddress);
            dropInput.setAttribute('data-lat', customerLat);
            dropInput.setAttribute('data-lng', customerLng);
            applyLockedStyles(dropInput, false, 'drop');
        }
    }

    pickupLocationResolved = true;
    dropLocationResolved = true;
};;

function initFlowStep4Map() {
    const mapDiv = document.getElementById('flow-map-container');
    if (!mapDiv) return;
    
    const pickupInput = document.getElementById('pickup-location-garage');
    const dropInput = document.getElementById('drop-location-garage');
    if (!pickupInput || !dropInput) return;
    
    const pLat = parseFloat(pickupInput.getAttribute('data-lat'));
    const pLng = parseFloat(pickupInput.getAttribute('data-lng'));
    const dLat = parseFloat(dropInput.getAttribute('data-lat'));
    const dLng = parseFloat(dropInput.getAttribute('data-lng'));
    
    if (isNaN(pLat) || isNaN(pLng) || isNaN(dLat) || isNaN(dLng)) return;
    
    const center = { lat: (pLat + dLat) / 2, lng: (pLng + dLng) / 2 };
    
    flowMap = new google.maps.Map(mapDiv, {
        center: center,
        zoom: 13,
        disableDefaultUI: true,
        styles: [
            { elementType: "geometry", stylers: [{ color: "#f5f5f5" }] },
            { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
            { elementType: "labels.text.fill", stylers: [{ color: "#616161" }] },
            { elementType: "labels.text.stroke", stylers: [{ color: "#f5f5f5" }] },
            { featureType: "poi", elementType: "geometry", stylers: [{ color: "#eeeeee" }] },
            { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#757575" }] },
            { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
            { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#dadada" }] },
            { featureType: "water", elementType: "geometry", stylers: [{ color: "#c9c9c9" }] },
            { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#9e9e9e" }] }
        ]
    });
    
    const pIcon = createGoogleIcon('#22c55e');
    const dIcon = createGoogleIcon('#ef4444');
    
    flowPickupMarker = new google.maps.Marker({
        position: { lat: pLat, lng: pLng },
        map: flowMap,
        icon: pIcon
    });
    
    flowDropMarker = new google.maps.Marker({
        position: { lat: dLat, lng: dLng },
        map: flowMap,
        icon: dIcon
    });
    
    const flowRoutePolyline = new google.maps.Polyline({
        path: [
            { lat: pLat, lng: pLng },
            { lat: dLat, lng: dLng }
        ],
        geodesic: true,
        strokeColor: "#000000",
        strokeOpacity: 1.0,
        strokeWeight: 4
    });
    flowRoutePolyline.setMap(flowMap);
    
    const bounds = new google.maps.LatLngBounds();
    bounds.extend({ lat: pLat, lng: pLng });
    bounds.extend({ lat: dLat, lng: dLng });
    flowMap.fitBounds(bounds);
}

function initGarageFlowStep4Options(vehicleId) {
    // Setup Transport Mode Gating depending on vehicle condition
    const cond = window.selectedVehicleCondition || 'Working';
    const cardDriver = document.getElementById('flow-transport-card-driver');
    const descDriver = document.getElementById('flow-transport-driver-desc');
    
    if (cond === 'Not Working') {
        if (cardDriver) {
            cardDriver.style.opacity = '0.4';
            cardDriver.style.pointerEvents = 'none';
        }
        if (descDriver) {
            descDriver.textContent = 'Not available (towing required).';
        }
        window.selectGarageFlowTransportMode('marshal');
    } else {
        if (cardDriver) {
            cardDriver.style.opacity = '1';
            cardDriver.style.pointerEvents = 'auto';
        }
        if (descDriver) {
            descDriver.textContent = 'Driver will drive your vehicle to destination.';
        }
        // default to driver if starts & runs
        window.selectGarageFlowTransportMode('driver');
    }

    const dateContainer = document.getElementById('flow-booking-schedule-date-container');
    const hiddenDateInput = document.getElementById('flow-booking-schedule-date');
    if (dateContainer && hiddenDateInput) {
        const dates = [];
        const today = new Date();
        for (let i = 0; i < 7; i++) {
            const d = new Date();
            d.setDate(today.getDate() + i);
            dates.push(d);
        }
        
        dateContainer.innerHTML = dates.map((d, idx) => {
            const dateStr = d.toISOString().split('T')[0];
            let label = '';
            if (idx === 0) label = 'Today';
            else if (idx === 1) label = 'Tomorrow';
            else {
                label = d.toLocaleDateString('en-US', { weekday: 'short' });
            }
            const dayNum = d.getDate();
            const month = d.toLocaleDateString('en-US', { month: 'short' });
            const isActive = idx === 0;
            if (isActive) {
                hiddenDateInput.value = dateStr;
            }
            return `
            <div class="date-card ${isActive ? 'active' : ''}" data-date="${dateStr}" onclick="selectGarageFlowScheduleDate(this)" style="flex: 0 0 64px; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 8px 4px; border-radius: 12px; background: ${isActive ? 'rgba(250, 204, 21, 0.15)' : 'rgba(255, 255, 255, 0.03)'}; border: 1.5px solid ${isActive ? 'var(--primary)' : 'rgba(255, 255, 255, 0.08)'}; cursor: pointer; transition: all 0.2s;">
                <span style="font-size: 0.6rem; color: ${isActive ? 'var(--primary)' : 'var(--text-muted)'}; font-weight: 700; text-transform: uppercase;">${label}</span>
                <span style="font-size: 1rem; color: #fff; font-weight: 800; margin: 2px 0;">${dayNum}</span>
                <span style="font-size: 0.58rem; color: var(--text-muted); font-weight: 500;">${month}</span>
            </div>
            `;
        }).join('');
    }

    const timeContainer = document.getElementById('flow-booking-schedule-time-container');
    const hiddenTimeInput = document.getElementById('flow-booking-schedule-time');
    if (timeContainer && hiddenTimeInput) {
        const slots = [
            "09:00 AM - 10:00 AM", "10:00 AM - 11:00 AM", "11:00 AM - 12:00 PM",
            "12:00 PM - 01:00 PM", "01:00 PM - 02:00 PM", "02:00 PM - 03:00 PM",
            "03:00 PM - 04:00 PM", "04:00 PM - 05:00 PM", "05:00 PM - 06:00 PM",
            "06:00 PM - 07:00 PM", "07:00 PM - 08:00 PM", "08:00 PM - 09:00 PM"
        ];
        timeContainer.innerHTML = slots.map((slot, idx) => {
            const isActive = idx === 0;
            if (isActive) {
                hiddenTimeInput.value = slot;
            }
            return `
            <div class="time-card ${isActive ? 'active' : ''}" data-time="${slot}" onclick="selectGarageFlowScheduleTime(this)" style="display: flex; align-items: center; justify-content: center; padding: 8px; border-radius: 12px; background: ${isActive ? 'rgba(250, 204, 21, 0.1)' : 'rgba(255,255,255,0.03)'}; border: 1.5px solid ${isActive ? 'var(--primary)' : 'rgba(255,255,255,0.08)'}; cursor: pointer; transition: all 0.2s; font-size: 0.7rem; font-weight: 700; color: ${isActive ? 'var(--primary)' : '#eee'};">
                ${slot}
            </div>
            `;
        }).join('');
    }

    if (typeof resetSlideToConfirm === 'function') {
        resetSlideToConfirm('flow-slide-confirm-instant');
        resetSlideToConfirm('flow-slide-confirm-schedule');
    }

    selectGarageFlowOptionTab('instant');
}

window.selectGarageFlowTransportMode = function(mode) {
    const cond = window.selectedVehicleCondition || 'Working';
    if (cond === 'Not Working' && mode === 'driver') {
        if (typeof showToast === 'function') {
            showToast('Towing requires a Towing Driver. Driver cannot tow.', 'warning');
        }
        return;
    }

    window.selectedGarageFlowTransportMode = mode;
    
    // Toggle active card classes/styles
    const cardDriver = document.getElementById('flow-transport-card-driver');
    const cardMarshal = document.getElementById('flow-transport-card-marshal');
    
    if (cardDriver && cardMarshal) {
        if (mode === 'driver') {
            cardDriver.style.borderColor = 'var(--primary)';
            cardDriver.style.background = 'rgba(250, 204, 21, 0.05)';
            
            cardMarshal.style.borderColor = 'rgba(255, 255, 255, 0.08)';
            cardMarshal.style.background = 'rgba(255,255,255,0.02)';
        } else {
            cardMarshal.style.borderColor = 'var(--primary)';
            cardMarshal.style.background = 'rgba(250, 204, 21, 0.05)';
            
            cardDriver.style.borderColor = 'rgba(255, 255, 255, 0.08)';
            cardDriver.style.background = 'rgba(255,255,255,0.02)';
        }
    }
    
    // Update button text content contextually
    const instantBtn = document.getElementById('flow-btn-confirm-instant');
    const slideText = document.querySelector('#flow-slide-confirm-schedule .slide-text');
    if (instantBtn) {
        instantBtn.textContent = mode === 'driver' ? 'Search Driver' : 'Search Towing Driver';
    }
    if (slideText) {
        slideText.textContent = mode === 'driver' ? 'Slide to Confirm Driver' : 'Slide to Confirm Towing Driver';
    }
    
    // Set bookingFlow dynamically
    updateSelectedBookingFlow();
};

function updateSelectedBookingFlow() {
    const mode = window.selectedGarageFlowTransportMode || 'driver';
    const flowType = window.tempFlowType || 'pickup';
    
    if (mode === 'driver') {
        window.bookingFlow = 'garage_driver';
    } else {
        window.bookingFlow = flowType === 'pickup' || flowType === 'round_trip' ? 'garage_standard' : 'garage_return';
    }
}

window.selectGarageFlowScheduleDate = function(elem) {
    const parent = elem.parentElement;
    parent.querySelectorAll('.date-card').forEach(c => {
        c.classList.remove('active');
        c.style.background = 'rgba(255, 255, 255, 0.03)';
        c.style.borderColor = 'rgba(255, 255, 255, 0.08)';
        c.querySelector('span').style.color = 'var(--text-muted)';
    });
    elem.classList.add('active');
    elem.style.background = 'rgba(250, 204, 21, 0.15)';
    elem.style.borderColor = 'var(--primary)';
    elem.querySelector('span').style.color = 'var(--primary)';
    
    document.getElementById('flow-booking-schedule-date').value = elem.getAttribute('data-date');
};

window.selectGarageFlowScheduleTime = function(elem) {
    const parent = elem.parentElement;
    parent.querySelectorAll('.time-card').forEach(c => {
        c.classList.remove('active');
        c.style.background = 'rgba(255, 255, 255, 0.03)';
        c.style.borderColor = 'rgba(255, 255, 255, 0.08)';
        c.style.color = '#eee';
    });
    elem.classList.add('active');
    elem.style.background = 'rgba(250, 204, 21, 0.1)';
    elem.style.borderColor = 'var(--primary)';
    elem.style.color = 'var(--primary)';
    
    document.getElementById('flow-booking-schedule-time').value = elem.getAttribute('data-time');
};

window.selectGarageFlowOptionTab = function(tab) {
    const btnInstant = document.getElementById('btn-flow-opt-instant');
    const btnSchedule = document.getElementById('btn-flow-opt-schedule');
    const secInstant = document.getElementById('flow-booking-opt-instant-section');
    const secSchedule = document.getElementById('flow-booking-opt-schedule-section');
    
    if (tab === 'instant') {
        if (btnInstant) { btnInstant.style.background = 'var(--primary)'; btnInstant.style.color = '#000'; btnInstant.style.fontWeight = '700'; }
        if (btnSchedule) { btnSchedule.style.background = 'transparent'; btnSchedule.style.color = '#fff'; btnSchedule.style.fontWeight = '600'; }
        if (secInstant) secInstant.style.display = 'block';
        if (secSchedule) secSchedule.style.display = 'none';
    } else {
        if (btnInstant) { btnInstant.style.background = 'transparent'; btnInstant.style.color = '#fff'; btnInstant.style.fontWeight = '600'; }
        if (btnSchedule) { btnSchedule.style.background = 'var(--primary)'; btnSchedule.style.color = '#000'; btnSchedule.style.fontWeight = '700'; }
        if (secInstant) secInstant.style.display = 'none';
        if (secSchedule) secSchedule.style.display = 'block';
    }
};

window.confirmGarageFlowInstantBooking = function() {
    // Just-in-time copy to global inputs for backend API payload compatibility
    const gPickup = document.getElementById('pickup-location-garage');
    const gDrop = document.getElementById('drop-location-garage');
    const globalPickup = document.getElementById('pickup-location-global');
    const globalDrop = document.getElementById('drop-location-global');
    
    if (gPickup && globalPickup) {
        globalPickup.value = gPickup.value;
        globalPickup.setAttribute('data-address', gPickup.getAttribute('data-address') || '');
        globalPickup.setAttribute('data-lat', gPickup.getAttribute('data-lat') || '');
        globalPickup.setAttribute('data-lng', gPickup.getAttribute('data-lng') || '');
    }
    if (gDrop && globalDrop) {
        globalDrop.value = gDrop.value;
        globalDrop.setAttribute('data-address', gDrop.getAttribute('data-address') || '');
        globalDrop.setAttribute('data-lat', gDrop.getAttribute('data-lat') || '');
        globalDrop.setAttribute('data-lng', gDrop.getAttribute('data-lng') || '');
    }

    window.exitGarageFlow();
    findMarshal(window.tempSelectedVehicleId);
};

window.confirmGarageFlowScheduleBooking = function() {
    // Just-in-time copy to global inputs for backend API payload compatibility
    const gPickup = document.getElementById('pickup-location-garage');
    const gDrop = document.getElementById('drop-location-garage');
    const globalPickup = document.getElementById('pickup-location-global');
    const globalDrop = document.getElementById('drop-location-global');
    
    if (gPickup && globalPickup) {
        globalPickup.value = gPickup.value;
        globalPickup.setAttribute('data-address', gPickup.getAttribute('data-address') || '');
        globalPickup.setAttribute('data-lat', gPickup.getAttribute('data-lat') || '');
        globalPickup.setAttribute('data-lng', gPickup.getAttribute('data-lng') || '');
    }
    if (gDrop && globalDrop) {
        globalDrop.value = gDrop.value;
        globalDrop.setAttribute('data-address', gDrop.getAttribute('data-address') || '');
        globalDrop.setAttribute('data-lat', gDrop.getAttribute('data-lat') || '');
        globalDrop.setAttribute('data-lng', gDrop.getAttribute('data-lng') || '');
    }

    document.getElementById('booking-opt-vehicle-id').value = window.tempSelectedVehicleId;
    document.getElementById('booking-schedule-date').value = document.getElementById('flow-booking-schedule-date').value;
    document.getElementById('booking-schedule-time').value = document.getElementById('flow-booking-schedule-time').value;
    
    window.exitGarageFlow();
    confirmScheduleBooking();
};

window.exitGarageFlow = function() {
    const container = document.getElementById('garage-flow-container');
    if (container) container.style.display = 'none';
};

window.handleGarageFlowBack = function() {
    const currentStep = window.currentGarageFlowStep || 1;
    if (currentStep === 1) {
        window.exitGarageFlow();
    } else {
        window.goToGarageFlowStep(currentStep - 1);
    }
};

window.onGoogleMapsLoaded = function() {
    if (typeof initCustomerMap === 'function') initCustomerMap();
};

window.confirmPinMap = null;
window.confirmPinMarker = null;

window.triggerManualPinAdjustment = function(type) {
    const inputId = type === 'global' ? 'pickup-location-global' :
                    type === 'global-drop' ? 'drop-location-global' :
                    type === 'garage' ? 'pickup-location-garage' :
                    'drop-location-garage';
    const input = document.getElementById(inputId);
    if (!input) return;
    const address = input.value || input.getAttribute('data-address') || '';
    const lat = parseFloat(input.getAttribute('data-lat'));
    const lng = parseFloat(input.getAttribute('data-lng'));
    
    if (isNaN(lat) || isNaN(lng)) {
        showToast("Select a location first before adjusting.", "warning");
        return;
    }
    
    openConfirmPinModal(inputId, address, lat, lng);
};

window.openConfirmPinModal = function(inputId, address, lat, lng) {
    const modal = document.getElementById('confirm-pin-modal');
    const addrText = document.getElementById('confirm-pin-address-text');
    const confirmBtn = document.getElementById('confirm-pin-btn');
    if (!modal) return;
    
    if (addrText) addrText.textContent = address;
    modal.style.display = 'flex';
    
    setTimeout(() => {
        try {
            const mapCenter = { lat: parseFloat(lat), lng: parseFloat(lng) };
            if (!window.confirmPinMap) {
                window.confirmPinMap = new google.maps.Map(document.getElementById('confirm-pin-map'), {
                    center: mapCenter,
                    zoom: 17,
                    disableDefaultUI: true,
                    styles: lightMapStyle
                });
            } else {
                window.confirmPinMap.setCenter(mapCenter);
                window.confirmPinMap.setZoom(17);
            }
            
            if (window.confirmPinMarker) {
                window.confirmPinMarker.setMap(null);
            }
            
            const markerColor = inputId.includes('drop') ? '#ef4444' : '#facc15';
            window.confirmPinMarker = new google.maps.Marker({
                position: mapCenter,
                map: window.confirmPinMap,
                draggable: true,
                icon: createGoogleIcon(markerColor)
            });
            
            window.confirmPinMarker.addListener('dragend', function() {
                const pos = window.confirmPinMarker.getPosition();
                const curLat = pos.lat();
                const curLng = pos.lng();
                if (addrText) {
                    addrText.textContent = `${address} (Adjusted Pin: ${curLat.toFixed(5)}, ${curLng.toFixed(5)})`;
                }
            });
            
            confirmBtn.onclick = function() {
                const pos = window.confirmPinMarker.getPosition();
                const finalLat = pos.lat();
                const finalLng = pos.lng();
                
                const input = document.getElementById(inputId);
                if (input) {
                    input.setAttribute('data-lat', finalLat);
                    input.setAttribute('data-lng', finalLng);
                    
                    const isDrop = inputId.includes('drop');
                    if (!isDrop) {
                        pickupLocationResolved = true;
                        if (window.customerMap) {
                            window.customerMap.setCenter({ lat: finalLat, lng: finalLng });
                            if (window.customerMarker) {
                                window.customerMarker.setPosition({ lat: finalLat, lng: finalLng });
                            }
                            showNearbyMarshalsOnMap(finalLat, finalLng);
                        }
                        loadNearbyGarages(finalLat, finalLng);
                    } else {
                        dropLocationResolved = true;
                        if (window.customerMap && window.dropMarker) {
                            window.dropMarker.setPosition({ lat: finalLat, lng: finalLng });
                        }
                    }
                    
                    showToast("Coordinates adjusted successfully!", "success");
                }
                
                closeConfirmPinModal();
            };
            
            google.maps.event.trigger(window.confirmPinMap, 'resize');
        } catch (e) {
            console.error("Error loading confirm pin map:", e);
        }
    }, 200);
};

window.closeConfirmPinModal = function() {
    const modal = document.getElementById('confirm-pin-modal');
    if (modal) modal.style.display = 'none';
};

// --- RENTAL PARTNER APPLICATION SYSTEM ---
window.openRentalPartnerModal = function() {
    console.log('[DEBUG-DEVICE] window.openRentalPartnerModal called from tap');
    const modal = document.getElementById('rental-partner-modal');
    const btn = document.getElementById('btn-open-partner-form');
    console.log('[DEBUG-DEVICE] #btn-open-partner-form element exists:', !!btn);
    console.log('[DEBUG-DEVICE] #rental-partner-modal element exists:', !!modal);
    if (modal) {
        modal.style.display = 'flex';
        checkRentalPartnerStatus();
    }
};

window.closeRentalPartnerModal = function() {
    const modal = document.getElementById('rental-partner-modal');
    if (modal) modal.style.display = 'none';
};

window.checkRentalPartnerStatus = async function() {
    try {
        const userStr = localStorage.getItem('redrivo_current_user') || localStorage.getItem('user');

        if (!userStr) return;
        const user = JSON.parse(userStr);
        if (!user || !user.id) return;

        const token = localStorage.getItem('redrivo_token') || localStorage.getItem('token');
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

        const res = await fetch(`${API_URL}/rental-partners/my-status/${user.id}`, { headers });
        const btn = document.getElementById('btn-open-partner-form');

        if (!res.ok) return;
        const data = await res.json();
        
        const badge = document.getElementById('rental-partner-status-badge');
        const desc = document.getElementById('rental-partner-card-desc');

        if (data.partner) {
            const p = data.partner;
            if (p.status === 'pending_approval') {
                if (badge) {
                    badge.innerText = 'UNDER CRM REVIEW';
                    badge.style.background = 'rgba(245, 158, 11, 0.2)';
                    badge.style.color = '#f59e0b';
                }
                if (desc) desc.innerText = `Your application for "${p.businessname || p.businessName}" submitted on ${new Date(p.submittedat || p.submittedAt).toLocaleDateString()} is currently pending admin approval in the CRM.`;
                if (btn) {
                    btn.innerHTML = '<span>Application Pending Review</span>';
                    btn.disabled = true;
                    btn.style.opacity = '0.7';
                }
            } else if (p.status === 'approved') {
                if (badge) {
                    badge.innerText = 'PARTNER APPROVED';
                    badge.style.background = 'rgba(34, 197, 94, 0.2)';
                    badge.style.color = '#22c55e';
                    badge.style.borderColor = 'rgba(34, 197, 94, 0.4)';
                }
                if (desc) desc.innerText = `Your Rental Partner account for "${p.businessname || p.businessName}" is ACTIVE. Manage your fleet, bookings, and revenue.`;
                if (btn) {
                    btn.innerHTML = '<span>Open Partner Fleet Dashboard</span> ➔';
                    btn.disabled = false;
                    btn.onclick = () => {
                        openPartnerDashboardModal();
                    };
                }
            } else if (p.status === 'rejected') {
                if (badge) {
                    badge.innerText = 'REJECTED';
                    badge.style.background = 'rgba(239, 68, 68, 0.2)';
                    badge.style.color = '#ef4444';
                    badge.style.borderColor = 'rgba(239, 68, 68, 0.4)';
                }
                if (desc) desc.innerText = `Application rejected: ${p.rejectionreason || p.rejectionReason || 'Documents did not meet criteria.'}. You may update and resubmit.`;
                if (btn) {
                    btn.innerHTML = '<span>Re-apply / Update Application</span> ➔';
                    btn.disabled = false;
                }
            }
        }
    } catch (e) {
        console.warn('Failed to check rental partner status:', e);
    }
};

const INDIAN_CITIES = [
    'Kolkata', 'Mumbai', 'Delhi', 'Bengaluru', 'Chennai', 
    'Hyderabad', 'Pune', 'Ahmedabad', 'Jaipur', 'Lucknow', 
    'Patna', 'Guwahati', 'Bhubaneswar', 'Ranchi'
];

window.filterCities = function(query) {
    const dropdown = document.getElementById('city-dropdown');
    if (!dropdown) return;

    const filtered = INDIAN_CITIES.filter(c => c.toLowerCase().includes(query.toLowerCase()));
    if (filtered.length === 0) {
        dropdown.style.display = 'none';
        return;
    }

    dropdown.innerHTML = filtered.map(c => `
        <div class="search-dropdown-item" style="padding: 10px 12px; cursor: pointer; color: #fff; font-size: 0.88rem;" onclick="selectCity('${c.replace(/'/g, "\\'")}')">
            <span>${c}</span>
        </div>
    `).join('');
    dropdown.style.display = 'block';
};

window.selectCity = function(city) {
    const input = document.getElementById('rp-service-city');
    if (input) input.value = city;
    const dropdown = document.getElementById('city-dropdown');
    if (dropdown) dropdown.style.display = 'none';
};

// Dismiss dropdown when clicking outside
document.addEventListener('click', (e) => {
    const cityDropdown = document.getElementById('city-dropdown');
    if (cityDropdown && !e.target.closest('#rp-service-city') && !e.target.closest('#city-dropdown')) {
        cityDropdown.style.display = 'none';
    }
});

document.addEventListener('DOMContentLoaded', () => {
    setTimeout(checkRentalPartnerStatus, 1500);
});

window.submitRentalPartnerApplication = async function(event) {
    if (event && event.preventDefault) event.preventDefault();
    const btn = document.getElementById('btn-submit-rp-app');
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Uploading Documents...';
    }

    try {
        const userStr = localStorage.getItem('redrivo_current_user') || localStorage.getItem('user');
        if (!userStr) {
            showToast('Please log in to submit application', 'error');
            if (btn) { btn.disabled = false; btn.innerText = 'Submit Application'; }
            return;
        }
        const user = JSON.parse(userStr);
        const token = localStorage.getItem('redrivo_token') || localStorage.getItem('token');
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

        const businessName = document.getElementById('rp-business-name').value.trim();
        const incorporationDate = document.getElementById('rp-inc-date').value;
        const gstNumber = document.getElementById('rp-gst-number').value.trim().toUpperCase();
        const panNumber = document.getElementById('rp-pan-number').value.trim().toUpperCase();
        const serviceCity = document.getElementById('rp-service-city').value.trim();
        const serviceAddressInput = document.getElementById('pickup-location-rpservice');
        const serviceAddress = serviceAddressInput ? serviceAddressInput.value.trim() : '';
        const serviceLat = serviceAddressInput ? serviceAddressInput.getAttribute('data-lat') : '';
        const serviceLng = serviceAddressInput ? serviceAddressInput.getAttribute('data-lng') : '';
        const registeredAddress = document.getElementById('rp-registered-address').value.trim();

        const incCertFile = document.getElementById('rp-inc-cert-file').files[0];
        const panFile = document.getElementById('rp-pan-file').files[0];
        const aadhaarFile = document.getElementById('rp-aadhaar-file').files[0];
        const gstFile = document.getElementById('rp-gst-file').files[0];
        const companyType = document.getElementById('rp-company-type').value;

        console.log('[DEBUG-FILES]', incCertFile ? incCertFile.name : 'NO_INC_FILE', panFile ? panFile.name : 'NO_PAN_FILE', aadhaarFile ? aadhaarFile.name : 'NO_AADHAAR_FILE', gstFile ? gstFile.name : 'NO_GST_FILE');

        if (!incCertFile || !panFile || !aadhaarFile || !gstFile || !companyType) {
            showToast('Please select all required documents and Company Type.', 'error');
            if (btn) { btn.disabled = false; btn.innerText = 'Submit Application'; }
            return;
        }

        if (!serviceLat || !serviceLng) {
            showToast('Please select a valid Service Address from the map suggestions.', 'error');
            if (btn) { btn.disabled = false; btn.innerText = 'Submit Application'; }
            return;
        }

        // Upload Incorporation Certificate
        const fd1 = new FormData();
        fd1.append('file', incCertFile);
        const res1 = await fetch(`${API_URL}/rental-partners/upload-doc`, { method: 'POST', headers, body: fd1 });
        if (!res1.ok) {
            const rawText = await res1.clone().text();
            console.error('[UPLOAD-DOC-1-RAW-ERROR]', res1.status, rawText);
            throw new Error('Failed to upload Incorporation Certificate: ' + rawText);
        }
        const data1 = await res1.json();

        // Upload Business PAN Card
        const fd2 = new FormData();
        fd2.append('file', panFile);
        const res2 = await fetch(`${API_URL}/rental-partners/upload-doc`, { method: 'POST', headers, body: fd2 });
        if (!res2.ok) {
            const errJson = await res2.json().catch(() => ({}));
            console.error('[UPLOAD-DOC-2-FAIL]', res2.status, errJson);
            throw new Error(errJson.error || 'Failed to upload Business PAN document');
        }
        const data2 = await res2.json();

        // Upload Aadhaar Card
        const fd3 = new FormData();
        fd3.append('file', aadhaarFile);
        const res3 = await fetch(`${API_URL}/rental-partners/upload-doc`, { method: 'POST', headers, body: fd3 });
        if (!res3.ok) {
            const errJson = await res3.json().catch(() => ({}));
            console.error('[UPLOAD-DOC-3-FAIL]', res3.status, errJson);
            throw new Error(errJson.error || 'Failed to upload Owner\'s Aadhaar Card');
        }
        const data3 = await res3.json();

        // Upload GST Certificate
        const fd4 = new FormData();
        fd4.append('file', gstFile);
        const res4 = await fetch(`${API_URL}/rental-partners/upload-doc`, { method: 'POST', headers, body: fd4 });
        if (!res4.ok) {
            const errJson = await res4.json().catch(() => ({}));
            console.error('[UPLOAD-DOC-4-FAIL]', res4.status, errJson);
            throw new Error(errJson.error || 'Failed to upload GST Certificate');
        }
        const data4 = await res4.json();

        if (btn) btn.innerText = 'Submitting Application...';

        // Submit Application
        const resApp = await fetch(`${API_URL}/rental-partners/apply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({
                userId: user.id,
                businessName,
                incorporationDate,
                gstNumber,
                panNumber,
                serviceCity,
                serviceAddress,
                registeredAddress,
                incorporationCertUrl: data1.filePath,
                panCardUrl: data2.filePath,
                aadhaarCardUrl: data3.filePath,
                gstCertUrl: data4.filePath,
                companyType,
                serviceLat,
                serviceLng
            })
        });

        const appData = await resApp.json();
        if (!resApp.ok) throw new Error(appData.error || 'Failed to submit application');

        showToast('Application submitted successfully! Awaiting CRM Admin review.', 'success');
        closeRentalPartnerModal();
        checkRentalPartnerStatus();
    } catch (err) {
        console.error('[RP-SUBMIT-ERROR]', err.message || err);
        showToast(err.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = 'Submit Application';
        }
    }
};

// --- PHASE 2: CUSTOMER RENTAL BROWSING & BOOKING SYSTEM ---
window.currentRentalSubtab = 'partners';
window.currentSelectedRentalVehicle = null;

window.switchRentalSubtab = function(subtab) {
    window.currentRentalSubtab = subtab;
    const btnPartners = document.getElementById('btn-rental-subtab-partners');
    const btnVehicles = document.getElementById('btn-rental-subtab-vehicles');

    if (subtab === 'partners') {
        if (btnPartners) {
            btnPartners.style.background = 'var(--primary)';
            btnPartners.style.color = '#000';
            btnPartners.style.fontWeight = '700';
        }
        if (btnVehicles) {
            btnVehicles.style.background = 'transparent';
            btnVehicles.style.color = '#fff';
            btnVehicles.style.fontWeight = '600';
        }
    } else {
        if (btnPartners) {
            btnPartners.style.background = 'transparent';
            btnPartners.style.color = '#fff';
            btnPartners.style.fontWeight = '600';
        }
        if (btnVehicles) {
            btnVehicles.style.background = 'var(--primary)';
            btnVehicles.style.color = '#000';
            btnVehicles.style.fontWeight = '700';
        }
    }

    fetchRentalData();
};

window.fetchRentalData = async function() {
    const contentArea = document.getElementById('rental-content-area');
    if (!contentArea) return;

    contentArea.innerHTML = `
        <div style="text-align: center; padding: 40px; color: var(--text-muted); font-size: 0.85rem;">
            <div class="loader-spin" style="margin: 0 auto 10px auto;"></div>
            Loading available rentals...
        </div>
    `;

    const pickupInput = document.getElementById('pickup-location-global');
    let lat = 19.0760;
    let lng = 72.8777;
    if (pickupInput) {
        const pLat = parseFloat(pickupInput.getAttribute('data-lat'));
        const pLng = parseFloat(pickupInput.getAttribute('data-lng'));
        if (!isNaN(pLat) && !isNaN(pLng)) {
            lat = pLat;
            lng = pLng;
        }
    }

    const vehicleType = document.getElementById('rental-filter-type')?.value || 'all';
    const sortFilter = document.getElementById('rental-filter-sort')?.value || 'distance_asc';

    try {
        if (window.currentRentalSubtab === 'partners') {
            const sortParam = sortFilter === 'distance_desc' ? 'desc' : 'asc';
            const res = await fetch(`${API_URL}/rental-partners/nearby?lat=${lat}&lng=${lng}&sort=${sortParam}`);
            const data = await res.json();

            if (!res.ok || !data.partners || data.partners.length === 0) {
                contentArea.innerHTML = `
                    <div style="background: rgba(18, 22, 29, 0.8); border: 1px dashed rgba(255,255,255,0.1); border-radius: 16px; padding: 30px; text-align: center;">
                        <span class="material-symbols-outlined" style="font-size: 40px; color: var(--text-muted); margin-bottom: 8px;">storefront</span>
                        <h4 style="color: #fff; margin: 0 0 4px 0;">No Nearby Rental Partners Found</h4>
                        <p style="color: var(--text-muted); font-size: 0.8rem;">Switch to 'All Vehicles' to browse available fleet across the region.</p>
                    </div>
                `;
                return;
            }

            contentArea.innerHTML = data.partners.map(p => {
                const ratingBadge = p.rating ? `⭐ ${p.rating} (Google)` : `⭐ New Partner`;
                return `
                    <div style="background: rgba(18, 22, 29, 0.9); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 16px; margin-bottom: 14px;">
                        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                            <div>
                                <h3 style="font-size: 1.05rem; font-weight: 700; color: #fff; margin: 0 0 2px 0;">${p.businessName}</h3>
                                <div style="font-size: 0.78rem; color: var(--text-muted); display: flex; align-items: center; gap: 4px;">
                                    <span class="material-symbols-outlined" style="font-size: 14px; color: var(--primary);">location_on</span>
                                    ${p.serviceCity} • ${p.distanceKm} km away
                                </div>
                            </div>
                            <span style="background: rgba(250, 204, 21, 0.15); color: #facc15; border: 1px solid rgba(250, 204, 21, 0.3); padding: 3px 8px; border-radius: 8px; font-size: 0.72rem; font-weight: 700;">
                                ${ratingBadge}
                            </span>
                        </div>

                        <div style="font-size: 0.78rem; color: rgba(255,255,255,0.7); margin-bottom: 12px; background: rgba(0,0,0,0.2); padding: 8px 10px; border-radius: 8px;">
                            📍 <strong>Hub Address:</strong> ${p.serviceAddress}
                        </div>

                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span style="font-size: 0.8rem; color: var(--primary); font-weight: 700;">
                                🚗 ${p.vehicleCount || 0} Vehicles Available
                            </span>
                            <button onclick="openPartnerSubView('${p.id}')" style="background: var(--primary); color: #000; border: none; padding: 8px 14px; border-radius: 8px; font-size: 0.8rem; font-weight: 700; cursor: pointer;">
                                View Partner Fleet ➔
                            </button>
                        </div>
                    </div>
                `;
            }).join('');
        } else {
            // 'vehicles' subtab
            const res = await fetch(`${API_URL}/rental-vehicles?vehicleType=${vehicleType}&sort=${sortFilter}&lat=${lat}&lng=${lng}`);
            const data = await res.json();

            if (!res.ok || !data.vehicles || data.vehicles.length === 0) {
                contentArea.innerHTML = `
                    <div style="background: rgba(18, 22, 29, 0.8); border: 1px dashed rgba(255,255,255,0.1); border-radius: 16px; padding: 30px; text-align: center;">
                        <span class="material-symbols-outlined" style="font-size: 40px; color: var(--text-muted); margin-bottom: 8px;">directions_car</span>
                        <h4 style="color: #fff; margin: 0 0 4px 0;">No Rental Vehicles Found</h4>
                        <p style="color: var(--text-muted); font-size: 0.8rem;">Try clearing your vehicle type filter or check back soon.</p>
                    </div>
                `;
                return;
            }

            contentArea.innerHTML = data.vehicles.map(v => {
                const isBike = (v.vehicletype || '').toLowerCase() === 'bike';
                return `
                    <div style="background: rgba(18, 22, 29, 0.9); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; overflow: hidden; margin-bottom: 16px; display: flex; flex-direction: column;">
                        <div style="height: 150px; background: rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; position: relative;">
                            ${v.photos ? `<img src="${v.photos}" style="width:100%; height:100%; object-fit:cover;" />` : `
                                <span class="material-symbols-outlined" style="font-size: 64px; color: var(--primary); opacity: 0.8;">
                                    ${isBike ? 'two_wheeler' : 'directions_car'}
                                </span>
                            `}
                            <div style="position: absolute; top: 10px; left: 10px; background: rgba(0,0,0,0.75); backdrop-filter: blur(4px); padding: 4px 8px; border-radius: 6px; font-size: 0.72rem; color: #fff; font-weight: 700;">
                                ${v.distanceKm} km away
                            </div>
                            <div style="position: absolute; top: 10px; right: 10px; background: rgba(34, 197, 94, 0.2); color: #22c55e; border: 1px solid rgba(34, 197, 94, 0.4); padding: 4px 8px; border-radius: 6px; font-size: 0.7rem; font-weight: 800; text-transform: uppercase;">
                                Driver Included
                            </div>
                        </div>

                        <div style="padding: 16px;">
                            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
                                <div>
                                    <h3 style="font-size: 1.1rem; font-weight: 800; color: #fff; margin: 0 0 2px 0;">${v.make} ${v.model}</h3>
                                    <div style="font-size: 0.78rem; color: var(--primary); font-weight: 600;">${v.platenumber || v.plateNumber} • ${v.fueltype || 'Petrol'}</div>
                                </div>
                                <div style="text-align: right;">
                                    <div style="font-size: 1.25rem; font-weight: 800; color: #22c55e;">₹${v.pricePerDay}</div>
                                    <div style="font-size: 0.7rem; color: var(--text-muted);">per day</div>
                                </div>
                            </div>

                            <div style="font-size: 0.78rem; color: var(--text-muted); margin-bottom: 12px;">
                                🏭 <strong>Hub:</strong> ${v.businessName} (${v.city})
                            </div>

                            <button onclick="openRentalBookingModal('${v.id}')" style="width: 100%; background: var(--primary); color: #000; border: none; padding: 12px; border-radius: 10px; font-size: 0.88rem; font-weight: 800; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;">
                                <span class="material-symbols-outlined" style="font-size: 18px;">event_available</span>
                                Book Vehicle with Driver
                            </button>
                        </div>
                    </div>
                `;
            }).join('');
        }
    } catch (err) {
        console.error('Error fetching rental data:', err);
        contentArea.innerHTML = `
            <div style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 12px; padding: 20px; text-align: center; color: #f87171; font-size: 0.85rem;">
                Failed to load rental listings: ${err.message}
            </div>
        `;
    }
};

window.openPartnerSubView = async function(partnerId) {
    const contentArea = document.getElementById('rental-content-area');
    if (!contentArea) return;

    contentArea.innerHTML = `
        <div style="text-align: center; padding: 30px; color: var(--text-muted);">
            <div class="loader-spin" style="margin: 0 auto 10px auto;"></div>
            Fetching partner fleet...
        </div>
    `;

    try {
        const res = await fetch(`${API_URL}/rental-partners/${partnerId}/vehicles`);
        const data = await res.json();

        if (!res.ok || !data.vehicles) throw new Error(data.error || 'Failed to fetch partner vehicles');

        const backHeader = `
            <button onclick="fetchRentalData()" style="margin-bottom: 16px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 8px 14px; border-radius: 10px; font-size: 0.8rem; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 6px;">
                ➔ Back to Partners List
            </button>
        `;

        if (data.vehicles.length === 0) {
            contentArea.innerHTML = backHeader + `
                <div style="background: rgba(18, 22, 29, 0.8); border: 1px dashed rgba(255,255,255,0.1); border-radius: 16px; padding: 30px; text-align: center; color: var(--text-muted);">
                    This partner has not added any active vehicles to their fleet yet.
                </div>
            `;
            return;
        }

        const partnerName = data.vehicles[0]?.businessName || 'Partner Fleet';
        const partnerCity = data.vehicles[0]?.serviceCity || '';

        contentArea.innerHTML = backHeader + `
            <div style="margin-bottom: 16px; padding: 14px; background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 12px;">
                <h3 style="margin: 0 0 2px 0; font-size: 1.1rem; color: #fff; font-weight: 800;">${partnerName}</h3>
                <p style="margin: 0; font-size: 0.8rem; color: var(--text-muted);">Available Vehicles in ${partnerCity}</p>
            </div>
        ` + data.vehicles.map(v => {
            return `
                <div style="background: rgba(18, 22, 29, 0.9); border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 14px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <h4 style="font-size: 1rem; color: #fff; margin: 0 0 2px 0; font-weight: 700;">${v.make} ${v.model} (${v.year || 2023})</h4>
                        <div style="font-size: 0.78rem; color: var(--primary); font-weight: 600;">${v.platenumber || v.plateNumber} • ${v.fueltype || 'Petrol'} • ${v.transmission || 'Manual'}</div>
                        <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;">Pickup: ${v.pickuplocationaddress || v.pickupLocationAddress}</div>
                    </div>

                    <div style="text-align: right;">
                        <div style="font-size: 1.15rem; font-weight: 800; color: #22c55e;">₹${v.priceperday || v.pricePerDay}</div>
                        <div style="font-size: 0.7rem; color: var(--text-muted); margin-bottom: 8px;">/ day</div>
                        <button onclick="openRentalBookingModal('${v.id}')" style="background: var(--primary); color: #000; border: none; padding: 6px 12px; border-radius: 8px; font-size: 0.78rem; font-weight: 800; cursor: pointer;">
                            Book Now
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        showToast(err.message, 'error');
    }
};

window.openRentalBookingModal = async function(vehicleId) {
    const todayStr = new Date().toISOString().split('T')[0];
    let modal = document.getElementById('rental-booking-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'rental-booking-modal';
        modal.className = 'v-modal open';
        modal.style.cssText = 'display:flex; align-items:center; justify-content:center; z-index:9999;';
        document.body.appendChild(modal);
    }

    modal.innerHTML = `
        <div class="modal-content" style="max-width: 500px; width: 92%; max-height: 90vh; overflow-y: auto; background: #12141a; border: 1px solid var(--border); border-radius: 16px; padding: 20px; font-family: 'Plus Jakarta Sans', sans-serif;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 12px;">
                <div>
                    <h3 style="font-size: 1.15rem; font-weight: 800; color: #fff; margin: 0;">Rental Booking Request</h3>
                    <span style="font-size: 0.72rem; color: #f59e0b; font-weight: 700;">Mandatory ReDrivo Driver Included</span>
                </div>
                <button onclick="document.getElementById('rental-booking-modal').style.display='none'" style="background: none; border: none; color: #fff; font-size: 1.2rem; cursor: pointer;">✕</button>
            </div>

            <div id="rental-booking-modal-body">
                <div style="text-align: center; padding: 20px; color: var(--text-muted);">Loading vehicle details...</div>
            </div>
        </div>
    `;

    modal.style.display = 'flex';

    try {
        const res = await fetch(`${API_URL}/rental-vehicles`);
        const data = await res.json();
        const v = data.vehicles ? data.vehicles.find(item => item.id === vehicleId) : null;

        if (!v) throw new Error('Vehicle details could not be loaded.');
        window.currentSelectedRentalVehicle = v;

        const modalBody = document.getElementById('rental-booking-modal-body');
        modalBody.innerHTML = `
            <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px; margin-bottom: 16px; display: flex; gap: 12px; align-items: center;">
                <div style="width: 50px; height: 50px; background: rgba(0,0,0,0.3); border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                    <span class="material-symbols-outlined" style="color: var(--primary); font-size: 32px;">directions_car</span>
                </div>
                <div>
                    <h4 style="color: #fff; margin: 0 0 2px 0; font-size: 0.95rem; font-weight: 700;">${v.make} ${v.model}</h4>
                    <div style="font-size: 0.75rem; color: var(--text-muted);">${v.platenumber || v.plateNumber} • ₹${v.pricePerDay} / day</div>
                    <div style="font-size: 0.72rem; color: var(--primary); margin-top: 2px;">Partner Hub: ${v.businessName}</div>
                </div>
            </div>

            <form onsubmit="submitRentalBooking(event, '${v.id}')" style="display: flex; flex-direction: column; gap: 12px;">
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    <div>
                        <label style="font-size: 0.75rem; color: var(--text-muted); display: block; margin-bottom: 4px;">Start Date *</label>
                        <input type="date" id="rb-start-date" required min="${todayStr}" value="${todayStr}" onchange="validateRentalDatesAndTimes()" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.3); color: #fff; font-size: 0.85rem;" />
                    </div>
                    <div>
                        <label style="font-size: 0.75rem; color: var(--text-muted); display: block; margin-bottom: 4px;">End Date *</label>
                        <input type="date" id="rb-end-date" required min="${todayStr}" value="${todayStr}" onchange="validateRentalDatesAndTimes()" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.3); color: #fff; font-size: 0.85rem;" />
                    </div>
                </div>

                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    <div>
                        <label style="font-size: 0.75rem; color: var(--text-muted); display: block; margin-bottom: 4px;">Start Time *</label>
                        <input type="time" id="rb-start-time" required value="10:00" onchange="validateRentalDatesAndTimes()" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.3); color: #fff; font-size: 0.85rem;" />
                    </div>
                    <div>
                        <label style="font-size: 0.75rem; color: var(--text-muted); display: block; margin-bottom: 4px;">End Time *</label>
                        <input type="time" id="rb-end-time" required value="20:00" onchange="validateRentalDatesAndTimes()" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.3); color: #fff; font-size: 0.85rem;" />
                    </div>
                </div>

                <div id="rental-time-warning" style="display: none; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 8px; padding: 10px; font-size: 0.75rem; color: #f87171;"></div>

                <div>
                    <label style="font-size: 0.75rem; color: var(--text-muted); display: block; margin-bottom: 4px;">Drop / Destination Address *</label>
                    <input type="text" id="rb-drop-address" required placeholder="Where should the ReDrivo driver drop you?" value="BKC Corporate Hub, Mumbai" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.3); color: #fff; font-size: 0.85rem;" />
                </div>

                <div style="background: rgba(34, 197, 94, 0.08); border: 1px solid rgba(34, 197, 94, 0.2); border-radius: 10px; padding: 12px; margin-top: 4px;">
                    <div style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 6px;">PRICING BREAKDOWN</div>
                    <div style="display: flex; justify-content: space-between; font-size: 0.8rem; color: #fff; margin-bottom: 4px;">
                        <span>Rental Vehicle (<span id="rb-summary-days">1</span> Day)</span>
                        <strong id="rb-summary-vehicle-cost">₹${v.pricePerDay}</strong>
                    </div>
                    <div style="display: flex; justify-content: space-between; font-size: 0.8rem; color: #fff; margin-bottom: 6px;">
                        <span>ReDrivo Driver Service</span>
                        <strong style="color: #22c55e;">INCLUDED (₹500)</strong>
                    </div>
                    <div style="border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 6px; display: flex; justify-content: space-between; font-size: 0.95rem; font-weight: 800; color: var(--primary);">
                        <span>Total Payable</span>
                        <span id="rb-summary-total">₹${v.pricePerDay + 500}</span>
                    </div>
                </div>

                <button type="submit" id="btn-submit-rental-booking" style="width: 100%; background: var(--primary); color: #000; border: none; padding: 12px; border-radius: 10px; font-weight: 800; font-size: 0.9rem; cursor: pointer; margin-top: 8px;">
                    Confirm Rental & Dispatch Driver ➔
                </button>
            </form>
        `;

        validateRentalDatesAndTimes();
    } catch (err) {
        showToast(err.message, 'error');
    }
};

window.validateRentalDatesAndTimes = function() {
    const startDate = document.getElementById('rb-start-date')?.value;
    const endDate = document.getElementById('rb-end-date')?.value;
    const startTime = document.getElementById('rb-start-time')?.value;
    const warnEl = document.getElementById('rental-time-warning');
    const submitBtn = document.getElementById('btn-submit-rental-booking');

    if (!startDate || !endDate || !startTime) return;

    const todayStr = new Date().toISOString().split('T')[0];
    let isValid = true;
    let warnMsg = '';

    if (startDate === todayStr) {
        const now = new Date();
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();

        const [startH, startM] = startTime.split(':').map(Number);

        if (startH > 21 || (startH === 21 && startM > 0)) {
            isValid = false;
            warnMsg = '⚠️ Same-day rental bookings cannot start after 9:00 PM.';
        } else {
            const currentMinutes = currentHour * 60 + currentMinute;
            const bookingMinutes = startH * 60 + (startM || 0);
            if (bookingMinutes - currentMinutes < 6 * 60) {
                isValid = false;
                warnMsg = '⚠️ Same-day bookings require at least 6 hours advance notice from current time.';
            }
        }
    }

    if (!isValid) {
        if (warnEl) {
            warnEl.innerText = warnMsg;
            warnEl.style.display = 'block';
        }
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.style.opacity = '0.5';
        }
    } else {
        if (warnEl) warnEl.style.display = 'none';
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.style.opacity = '1';
        }
    }

    // Update Price Summary Days Calculation
    const startMs = new Date(startDate).getTime();
    const endMs = new Date(endDate).getTime();
    const diffDays = Math.max(1, Math.ceil((endMs - startMs) / (1000 * 3600 * 24)) || 1);

    const daysEl = document.getElementById('rb-summary-days');
    const vehicleCostEl = document.getElementById('rb-summary-vehicle-cost');
    const totalEl = document.getElementById('rb-summary-total');

    if (window.currentSelectedRentalVehicle) {
        const dailyRate = Number(window.currentSelectedRentalVehicle.pricePerDay || window.currentSelectedRentalVehicle.priceperday);
        const vehicleTotal = diffDays * dailyRate;
        const grandTotal = vehicleTotal + 500;

        if (daysEl) daysEl.innerText = diffDays;
        if (vehicleCostEl) vehicleCostEl.innerText = `₹${vehicleTotal}`;
        if (totalEl) totalEl.innerText = `₹${grandTotal}`;
    }
};

window.submitRentalBooking = async function(event, vehicleId) {
    event.preventDefault();
    const userStr = localStorage.getItem('user') || localStorage.getItem('redrivo_current_user');
    if (!userStr) {
        showToast('Please log in to submit a rental booking.', 'error');
        return;
    }

    const user = JSON.parse(userStr);
    const startDate = document.getElementById('rb-start-date').value;
    const endDate = document.getElementById('rb-end-date').value;
    const startTime = document.getElementById('rb-start-time').value;
    const endTime = document.getElementById('rb-end-time').value;
    const dropAddress = document.getElementById('rb-drop-address').value;

    const v = window.currentSelectedRentalVehicle;
    const startMs = new Date(startDate).getTime();
    const endMs = new Date(endDate).getTime();
    const diffDays = Math.max(1, Math.ceil((endMs - startMs) / (1000 * 3600 * 24)) || 1);
    const totalPrice = (diffDays * Number(v.pricePerDay || v.priceperday)) + 500;

    const btn = document.getElementById('btn-submit-rental-booking');
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Dispatching ReDrivo Driver...';
    }

    try {
        const res = await fetch(`${API_URL}/rental-bookings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: user.id,
                rentalVehicleId: vehicleId,
                startDate,
                endDate,
                startTime,
                endTime,
                dropAddress,
                totalPrice
            })
        });

        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to complete rental booking.');

        showToast(`Rental Booking Confirmed! Driver request ID: ${data.requestId}`, 'success');
        document.getElementById('rental-booking-modal').style.display = 'none';

        // Switch to history or show active driver dispatch alert
        switchTab('history');
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = 'Confirm Rental & Dispatch Driver ➔';
        }
    }
};


// --- PHASE 2.5: PARTNER SELF-SERVICE FLEET DASHBOARD CLIENT FUNCTIONS ---

window.openPartnerDashboardModal = async function() {
    console.log('[DEBUG-DEVICE] openPartnerDashboardModal entered');
    const userJson = localStorage.getItem('user') || localStorage.getItem('redrivo_current_user');
    const user = userJson ? JSON.parse(userJson) : null;
    if (!user) {
        console.warn('[DEBUG-DEVICE] openPartnerDashboardModal aborted: No user in localStorage');
        showToast('Please log in to access Partner Dashboard', 'error');
        return;
    }

    try {
        console.log(`[DEBUG-DEVICE] Dashboard fetching my-status for user: ${user.id}`);
        const res = await fetch(`${API_URL}/rental-partners/my-status/${user.id}`);
        const data = await res.json();
        console.log(`[DEBUG-DEVICE] Dashboard my-status HTTP ${res.status}:`, JSON.stringify(data));

        if (!res.ok || !data.partner || data.partner.status !== 'approved') {
            showToast('Only approved rental partners can access the Partner Dashboard', 'error');
            return;
        }

        window.currentPartnerRecord = data.partner;
        const modal = document.getElementById('partner-dashboard-modal');
        console.log('[DEBUG-DEVICE] #partner-dashboard-modal exists:', !!modal);
        if (modal) modal.style.display = 'flex';

        const title = document.getElementById('pd-business-title');
        const subtitle = document.getElementById('pd-business-subtitle');
        if (title) title.innerText = `${data.partner.businessName || data.partner.businessname} Dashboard`;
        if (subtitle) subtitle.innerText = `Service Hub: ${data.partner.serviceCity || data.partner.servicecity} • Approved Partner`;

        switchPartnerDashboardSubtab('fleet');
    } catch (err) {
        showToast('Failed to load partner dashboard: ' + err.message, 'error');
    }
};

window.closePartnerDashboardModal = function() {
    const modal = document.getElementById('partner-dashboard-modal');
    if (modal) modal.style.display = 'none';
};

window.switchPartnerDashboardSubtab = function(subtab) {
    const tabFleet = document.getElementById('pd-tab-fleet');
    const tabBookings = document.getElementById('pd-tab-bookings');

    if (subtab === 'fleet') {
        if (tabFleet) { tabFleet.style.color = 'var(--primary)'; tabFleet.style.borderBottom = '2px solid var(--primary)'; }
        if (tabBookings) { tabBookings.style.color = 'var(--text-muted)'; tabBookings.style.borderBottom = '2px solid transparent'; }
        loadPartnerFleetView();
    } else {
        if (tabFleet) { tabFleet.style.color = 'var(--text-muted)'; tabFleet.style.borderBottom = '2px solid transparent'; }
        if (tabBookings) { tabBookings.style.color = 'var(--primary)'; tabBookings.style.borderBottom = '2px solid var(--primary)'; }
        loadPartnerBookingsView();
    }
};

window.loadPartnerFleetView = async function() {
    const body = document.getElementById('partner-dashboard-body');
    if (!body || !window.currentPartnerRecord) return;

    body.innerHTML = `<div style="text-align: center; padding: 30px; color: var(--text-muted);">Loading partner fleet...</div>`;

    try {
        const res = await fetch(`${API_URL}/rental-vehicles/partner/${window.currentPartnerRecord.id}`);
        const data = await res.json();

        if (!res.ok) throw new Error(data.error || 'Failed to load fleet vehicles');

        const vehicles = data.vehicles || [];

        let html = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                <h4 style="color: #fff; margin: 0; font-size: 1rem;">Fleet Inventory (${vehicles.length})</h4>
                <button onclick="openPartnerAddVehicleModal()" style="background: var(--primary); color: #000; border: none; padding: 8px 14px; border-radius: 8px; font-weight: 700; font-size: 0.8rem; cursor: pointer;">
                    + Add New Vehicle
                </button>
            </div>
        `;

        if (vehicles.length === 0) {
            html += `
                <div style="background: rgba(255,255,255,0.02); border: 1px dashed rgba(255,255,255,0.1); border-radius: 14px; padding: 30px; text-align: center;">
                    <p style="color: var(--text-muted); margin: 0 0 12px 0;">No vehicles added to your fleet yet.</p>
                    <button onclick="openPartnerAddVehicleModal()" style="background: var(--primary); color: #000; border: none; padding: 8px 14px; border-radius: 8px; font-weight: 700; font-size: 0.8rem; cursor: pointer;">
                        + Add Your First Vehicle
                    </button>
                </div>
            `;
        } else {
            html += vehicles.map(v => `
                <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 14px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <h4 style="color: #fff; margin: 0; font-size: 0.95rem; font-weight: 700;">${v.make} ${v.model} (${v.year || 2024})</h4>
                            <span style="background: ${v.status === 'available' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'}; color: ${v.status === 'available' ? '#22c55e' : '#ef4444'}; border: 1px solid ${v.status === 'available' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}; padding: 2px 6px; border-radius: 6px; font-size: 0.7rem; font-weight: 700; text-transform: uppercase;">
                                ${v.status}
                            </span>
                        </div>
                        <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 4px;">
                            ${v.plateNumber} • ${v.fuelType} • ${v.transmission} • ₹${v.pricePerDay}/day
                        </div>
                        <div style="font-size: 0.72rem; color: rgba(255,255,255,0.5); margin-top: 2px;">
                            📍 ${v.pickupLocationAddress || v.serviceCity}
                        </div>
                    </div>
                    <div>
                        <button onclick="togglePartnerVehicleStatus('${v.id}', '${v.status === 'available' ? 'maintenance' : 'available'}')" style="background: rgba(255,255,255,0.1); color: #fff; border: 1px solid rgba(255,255,255,0.2); padding: 6px 12px; border-radius: 8px; font-size: 0.75rem; font-weight: 600; cursor: pointer;">
                            ${v.status === 'available' ? 'Set Maintenance' : 'Set Available'}
                        </button>
                    </div>
                </div>
            `).join('');
        }

        body.innerHTML = html;
    } catch (err) {
        body.innerHTML = `<div style="color: #ef4444; text-align: center; padding: 20px;">${err.message}</div>`;
    }
};

window.togglePartnerVehicleStatus = async function(vehicleId, newStatus) {
    try {
        const res = await fetch(`${API_URL}/rental-vehicles/${vehicleId}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to update vehicle status');
        showToast('Vehicle status updated!', 'success');
        loadPartnerFleetView();
    } catch (err) {
        showToast(err.message, 'error');
    }
};

window.loadPartnerBookingsView = async function() {
    const body = document.getElementById('partner-dashboard-body');
    if (!body || !window.currentPartnerRecord) return;

    body.innerHTML = `<div style="text-align: center; padding: 30px; color: var(--text-muted);">Loading partner bookings & earnings...</div>`;

    try {
        const res = await fetch(`${API_URL}/rental-bookings/partner/${window.currentPartnerRecord.id}`);
        const data = await res.json();

        if (!res.ok) throw new Error(data.error || 'Failed to load bookings');

        const bookings = data.bookings || [];
        const totalEarnings = data.totalEarnings || 0;

        let html = `
            <div style="background: rgba(34,197,94,0.08); border: 1px solid rgba(34,197,94,0.2); border-radius: 14px; padding: 16px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <div style="font-size: 0.75rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">Total Rental Revenue Earned</div>
                    <div style="font-size: 1.4rem; font-weight: 800; color: #22c55e; margin-top: 2px;">₹${totalEarnings.toLocaleString()}</div>
                </div>
                <div style="text-align: right;">
                    <div style="font-size: 0.75rem; color: var(--text-muted); font-weight: 700;">TOTAL BOOKINGS</div>
                    <div style="font-size: 1.2rem; font-weight: 800; color: #fff; margin-top: 2px;">${bookings.length}</div>
                </div>
            </div>

            <h4 style="color: #fff; margin: 0 0 12px 0; font-size: 0.95rem;">Fleet Bookings Log</h4>
        `;

        if (bookings.length === 0) {
            html += `
                <div style="background: rgba(255,255,255,0.02); border: 1px dashed rgba(255,255,255,0.1); border-radius: 14px; padding: 30px; text-align: center; color: var(--text-muted);">
                    No bookings received for your fleet yet.
                </div>
            `;
        } else {
            html += bookings.map(b => `
                <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px; margin-bottom: 10px;">
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
                        <div>
                            <span style="font-size: 0.85rem; font-weight: 700; color: #fff;">${b.bookingnumber || b.id}</span>
                            <div style="font-size: 0.78rem; color: var(--primary); font-weight: 600;">${b.make} ${b.model} (${b.platenumber})</div>
                        </div>
                        <span style="background: rgba(34,197,94,0.15); color: #22c55e; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; font-weight: 700;">
                            ${b.status}
                        </span>
                    </div>
                    <div style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 6px;">
                        👤 Customer: ${b.customerName} (${b.customerPhone}) • 📅 ${b.totaldays} Days
                    </div>
                    <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px dashed rgba(255,255,255,0.08); padding-top: 6px; font-size: 0.8rem;">
                        <span style="color: rgba(255,255,255,0.7);">Partner Share: <strong>₹${b.vehicleRentalAmount}</strong></span>
                        <span style="color: var(--primary); font-weight: 700;">Total: ₹${b.totalAmount}</span>
                    </div>
                </div>
            `).join('');
        }

        body.innerHTML = html;
    } catch (err) {
        body.innerHTML = `<div style="color: #ef4444; text-align: center; padding: 20px;">${err.message}</div>`;
    }
};

window.openPartnerAddVehicleModal = function() {
    const modal = document.getElementById('partner-add-vehicle-modal');
    if (modal) modal.style.display = 'flex';
};

window.closePartnerAddVehicleModal = function() {
    const modal = document.getElementById('partner-add-vehicle-modal');
    if (modal) modal.style.display = 'none';
};

window.submitPartnerAddVehicle = async function(event) {
    event.preventDefault();
    if (!window.currentPartnerRecord) {
        showToast('Approved partner record not found', 'error');
        return;
    }

    const btn = document.getElementById('btn-submit-partner-vehicle');
    if (btn) { btn.disabled = true; btn.innerText = 'Adding Vehicle...'; }

    try {
        const vehicleType = document.getElementById('pav-type').value;
        const plateNumber = document.getElementById('pav-plate').value.trim();
        const make = document.getElementById('pav-make').value.trim();
        const model = document.getElementById('pav-model').value.trim();
        const year = parseInt(document.getElementById('pav-year').value) || 2024;
        const fuelType = document.getElementById('pav-fuel').value;
        const transmission = document.getElementById('pav-transmission').value;
        const seatingCapacity = parseInt(document.getElementById('pav-seating').value) || 5;
        const pricePerDay = parseFloat(document.getElementById('pav-price-day').value);
        const city = document.getElementById('pav-city').value.trim();
        const pickupLocationAddress = document.getElementById('pav-pickup-address').value.trim();

        const res = await fetch(`${API_URL}/rental-vehicles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                partnerId: window.currentPartnerRecord.id,
                vehicleType,
                plateNumber,
                make,
                model,
                year,
                fuelType,
                transmission,
                seatingCapacity,
                pricePerDay,
                city,
                pickupLocationAddress
            })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to add vehicle');

        showToast('Vehicle added to partner fleet successfully!', 'success');
        closePartnerAddVehicleModal();
        loadPartnerFleetView();
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = 'Add Vehicle to Fleet'; }
    }
};


