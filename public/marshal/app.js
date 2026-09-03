const isNativeApp = typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
const API_URL = isNativeApp
    ? 'https://api.redrivo.in/api'
    : (window.location.protocol === 'file:' ? 'http://localhost:3000/api' : `${window.location.origin}/api`);

window.DEV_MODE_MOCK_LOCATION = false; // Production mode: real GPS tracking active

// Lazy getter for BatteryOptimization plugin
function getBatteryOptimizationPlugin() {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BatteryOptimization) {
        return window.Capacitor.Plugins.BatteryOptimization;
    }
    return null;
}

// Configurable Ring Duration Constant (seconds)
const INCOMING_PICKUP_TIMEOUT_SECONDS = 10;

function getDeclinedPickupIds() {
    try {
        const raw = localStorage.getItem('redrivo_declined_pickup_ids');
        return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch(e) { return new Set(); }
}

function markPickupAsDeclined(pickupId) {
    if (!pickupId) return;
    const declinedSet = getDeclinedPickupIds();
    declinedSet.add(pickupId);
    localStorage.setItem('redrivo_declined_pickup_ids', JSON.stringify(Array.from(declinedSet)));
}

function getBidPickupIds() {
    try {
        const raw = localStorage.getItem('redrivo_bid_pickup_ids');
        return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch(e) { return new Set(); }
}

function markPickupAsBid(pickupId) {
    if (!pickupId) return;
    const bidSet = getBidPickupIds();
    bidSet.add(pickupId);
    localStorage.setItem('redrivo_bid_pickup_ids', JSON.stringify(Array.from(bidSet)));
}

// Initialize Socket.io connection
window.socket = null;
if (!window.googleMapsReady) {
    window.onGoogleMapsLoaded = function() { window.googleMapsReady = true; };
}
if (typeof io !== 'undefined') {
    window.socket = io(API_URL.replace('/api', ''));
    console.log('Socket.io connected in Driver app');

    window.socket.on('tripCancelled', (data) => {
        // Handle selection-phase cancellation
        if (window.activeBidRequestId && window.activeBidRequestId === data.serviceRequestId) {
            if (window.bidCheckInterval) {
                clearInterval(window.bidCheckInterval);
                window.bidCheckInterval = null;
            }
            window.activeBidRequestId = null;
            
            const selectionOverlayEl = document.getElementById('map-pending-selection-overlay');
            if (selectionOverlayEl) selectionOverlayEl.style.display = 'none';
            
            if (typeof switchTab === 'function') switchTab('trips');
            if (typeof showToast === 'function') {
                showToast('The service request has been cancelled or another driver was chosen.', 'info');
            }
            if (typeof startPickupPolling === 'function') startPickupPolling();
            if (typeof loadMyTrips === 'function') loadMyTrips();
        }

        // Handle payment-phase/enroute cancellation
        if (typeof currentTripId !== 'undefined' && currentTripId === data.tripId) {
            if (window.marshalPaymentTimer) {
                clearInterval(window.marshalPaymentTimer);
                window.marshalPaymentTimer = null;
            }
            const overlay = document.getElementById('marshal-waiting-payment-overlay');
            if (overlay) overlay.style.display = 'none';
            
            if (typeof switchTab === 'function') switchTab('trips');
            if (typeof showToast === 'function') {
                showToast('The booking has been cancelled (payment timeout or customer cancelled).', 'error');
            } else {
                alert('The booking has been cancelled.');
            }
            if (typeof loadTrips === 'function') loadTrips();
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
const createGoogleIcon = (color) => {
    return {
        url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent('<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="8" fill="' + color + '" stroke="white" stroke-width="3" /></svg>'),
        scaledSize: new google.maps.Size(20, 20),
        anchor: new google.maps.Point(10, 10)
    };
};
const createSvgIcon = (svgString, width, height) => {
    return {
        url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svgString),
        scaledSize: new google.maps.Size(width, height),
        anchor: new google.maps.Point(width/2, height/2)
    };
};

let currentUser = null;
const nativeFetch = window.fetch;

// Consolidated Global Fetch Interceptor: API Authorization & Session Expiry Guard
window.fetch = async function(resource, init) {
    init = init || {};
    init.headers = init.headers || {};
    
    const token = localStorage.getItem('redrivo_token');
    if (token) {
        if (init.headers instanceof Headers) {
            if (!init.headers.has('Authorization')) init.headers.set('Authorization', `Bearer ${token}`);
        } else {
            if (!init.headers['Authorization'] && !init.headers['authorization']) {
                init.headers['Authorization'] = `Bearer ${token}`;
            }
        }
    }

    try {
        const res = await nativeFetch(resource, init);
        const url = typeof resource === 'string' ? resource : (resource && resource.url ? resource.url : '');
        const isBackendApi = url.includes('/api/') && !url.includes('/api/auth/') && !url.includes('marshal_test_blob');
        if (isBackendApi && res.status === 401) {
            if (currentUser || localStorage.getItem('marshalUser')) {
                const appView = document.getElementById('app-view');
                const wasInsideApp = appView && appView.style.display !== 'none';

                console.warn('Session expired or unauthorized. Logging out...');
                currentUser = null;
                localStorage.removeItem('marshalUser');
                localStorage.removeItem('redrivo_token');
                
                if (wasInsideApp && !window._isAppBooting && typeof showToast === 'function') {
                    showToast('Your session has expired, please log in again.', 'error');
                }
                const loginScreen = document.getElementById('login-screen');
                if (loginScreen) loginScreen.style.display = 'block';
                if (appView) appView.style.display = 'none';

                const authErr = new Error('AUTH_UNAUTHORIZED');
                authErr.isAuthError = true;
                throw authErr;
            }
        }
        return res;
    } catch (err) {
        throw err;
    }
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

const HECTOR_MAP_SVG = `<svg class="hector-map-icon" width="36" height="36" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="4" width="20" height="32" rx="5" fill="black" fill-opacity="0.35" filter="blur(2px)"/>
  <rect x="11" y="5" width="18" height="30" rx="4" fill="#E53E3E" stroke="#9B2C2C" stroke-width="1.5"/>
  <path d="M13 11C13 10 14 9 16 9H24C26 9 27 10 27 11L26 15H14L13 11Z" fill="#1A202C" stroke="#2D3748" stroke-width="0.5"/>
  <rect x="14" y="16" width="12" height="9" rx="1.5" fill="#2D3748" stroke="#1A202C" stroke-width="0.5"/>
  <rect x="16" y="17" width="8" height="6" rx="1" fill="#4299E1" fill-opacity="0.7"/>
  <path d="M14 5H26L25 9H15L14 5Z" fill="#C53030"/>
  <rect x="12" y="5" width="2" height="1" rx="0.5" fill="#FFF"/>
  <rect x="26" y="5" width="2" height="1" rx="0.5" fill="#FFF"/>
  <path d="M14 26L13 28C13 29 14 29 16 29H24C26 29 27 29 27 28L26 26H14Z" fill="#1A202C" stroke="#2D3748" stroke-width="0.5"/>
  <rect x="9" y="11" width="2" height="3" rx="0.5" fill="#9B2C2C"/>
  <rect x="29" y="11" width="2" height="3" rx="0.5" fill="#9B2C2C"/>
</svg>`;

const INDIAN_LOCATIONS = {
    "Maharashtra": {
        "Mumbai": ["400001", "400002", "400003", "400004", "400050", "400097", "400099"],
        "Pune": ["411001", "411002", "411003", "411014", "411030", "411045", "411057"],
        "Nagpur": ["440001", "440002", "440010", "440012", "440015"],
        "Thane": ["400601", "400602", "400603", "400607", "400615"],
        "Nashik": ["422001", "422002", "422003", "422009", "422010"]
    },
    "Delhi": {
        "New Delhi": ["110001", "110002", "110011", "110020", "110025", "110048"],
        "Dwarka": ["110075", "110078", "110077"],
        "Rohini": ["110085", "110089", "110086"]
    },
    "Karnataka": {
        "Bengaluru": ["560001", "560002", "560003", "560034", "560100", "560038", "560066"],
        "Mysuru": ["570001", "570002", "570003", "570010", "570020"],
        "Hubli": ["580020", "580021", "580023"]
    },
    "Tamil Nadu": {
        "Chennai": ["600001", "600002", "600003", "600004", "600028", "600040", "600096"],
        "Coimbatore": ["641001", "641002", "641003", "641018", "641046"],
        "Madurai": ["625001", "625002", "625009", "625020"]
    },
    "West Bengal": {
        "Kolkata": ["700001", "700002", "700003", "700009", "700091", "700156", "700056"],
        "Howrah": ["711101", "711102", "711103", "711104"],
        "Durgapur": ["713201", "713202", "713203", "713216"]
    },
    "Gujarat": {
        "Ahmedabad": ["380001", "380002", "380009", "380015", "380054", "380058"],
        "Surat": ["395001", "395002", "395003", "395007", "395009"],
        "Vadodara": ["390001", "390002", "390007", "390015", "390020"]
    },
    "Telangana": {
        "Hyderabad": ["500001", "500002", "500003", "500081", "500090", "500032", "500019"],
        "Warangal": ["506001", "506002", "506003", "506015"]
    },
    "Uttar Pradesh": {
        "Noida": ["201301", "201303", "201304", "201307", "201309"],
        "Ghaziabad": ["201001", "201002", "201005", "201010"],
        "Lucknow": ["226001", "226002", "226003", "226010", "226016"],
        "Kanpur": ["208001", "208002", "208005", "208016"]
    },
    "Haryana": {
        "Gurugram": ["122001", "122002", "122018", "122015", "122011"],
        "Faridabad": ["121001", "121002", "121005", "121007"]
    }
};

function getStateFromPincode(pincode) {
    if (!pincode) return '';
    const pin = pincode.replace(/\s+/g, '');
    for (const state in INDIAN_LOCATIONS) {
        for (const city in INDIAN_LOCATIONS[state]) {
            if (INDIAN_LOCATIONS[state][city].includes(pin)) {
                return state;
            }
        }
    }
    return '';
}

let marshalMap = null;
let marshalMarker = null;
let targetMarker = null;
let marshalRouteControl = null;
let marshalLocationInterval = null;

function normalizeUser(u) {
    if (!u) return u;
    if (u.kycstatus !== undefined) u.kycStatus = u.kycstatus;
    if (u.phoneverified !== undefined) u.phoneVerified = u.phoneverified;
    if (u.emailverified !== undefined) u.emailVerified = u.emailverified;
    if (u.panverified !== undefined) u.panVerified = u.panverified;
    if (u.aadhaarverified !== undefined) u.aadhaarVerified = u.aadhaarverified;
    if (u.bankverified !== undefined) u.bankVerified = u.bankverified;
    if (u.pannumber !== undefined) u.panNumber = u.pannumber;
    if (u.aadhaarnumber !== undefined) u.aadhaarNumber = u.aadhaarnumber;
    if (u.dlnumber !== undefined) u.dlNumber = u.dlnumber;
    if (u.dlverified !== undefined) u.dlBikeVerified = u.dlverified;
    if (u.bankaccountname !== undefined) u.bankAccountName = u.bankaccountname;
    if (u.bankaccountnumber !== undefined) u.bankAccountNumber = u.bankaccountnumber;
    if (u.bankifsc !== undefined) u.bankIFSC = u.bankifsc;
    if (u.bankname !== undefined) u.bankName = u.bankname;
    
    // Map both panphotourl / aadhaarphotourl AND database column names panurl / aadhaarurl
    if (u.panphotourl !== undefined) u.panPhotoUrl = u.panphotourl;
    else if (u.panurl !== undefined) { u.panPhotoUrl = u.panurl; u.panphotourl = u.panurl; }

    if (u.aadhaarphotourl !== undefined) u.aadhaarPhotoUrl = u.aadhaarphotourl;
    else if (u.aadhaarurl !== undefined) { u.aadhaarPhotoUrl = u.aadhaarurl; u.aadhaarphotourl = u.aadhaarurl; }

    if (u.facephotourl !== undefined) u.facePhotoUrl = u.facephotourl;
    if (u.dlurl !== undefined) u.dlUrl = u.dlurl;
    if (u.profilepictureurl !== undefined) u.profilePictureUrl = u.profilepictureurl;
    if (u.panbackurl !== undefined) u.panBackUrl = u.panbackurl;
    if (u.aadhaarbackurl !== undefined) u.aadhaarBackUrl = u.aadhaarbackurl;
    if (u.dlbackurl !== undefined) u.dlBackUrl = u.dlbackurl;
    if (u.kycrejectionreason !== undefined) u.kycRejectionReason = u.kycrejectionreason;
    return u;
}

function isKycApproved(u) {
    if (!u) return false;
    const status = u.kycStatus || u.kycstatus;
    return status && (status.toLowerCase() === 'approved' || status.toLowerCase() === 'verified');
}

function safeSetLocalStorage(key, value) {
    if (key === 'marshalUser') {
        try {
            const userObj = JSON.parse(value);
            const docFields = [
                'panPhotoUrl', 'panphotourl', 'panurl',
                'panBackUrl', 'panbackurl',
                'aadhaarPhotoUrl', 'aadhaarphotourl', 'aadhaarurl',
                'aadhaarBackUrl', 'aadhaarbackurl',
                'facePhotoUrl', 'facephotourl',
                'dlUrl', 'dlurl',
                'dlBackUrl', 'dlbackurl',
                'profilePictureUrl', 'profilepictureurl'
            ];
            docFields.forEach(field => {
                if (userObj[field] && typeof userObj[field] === 'string' && userObj[field].startsWith('data:')) {
                    userObj[field] = 'uploaded'; // Strip large Base64 content
                }
            });
            value = JSON.stringify(userObj);
        } catch (e) {
            console.error('Error stripping base64 from marshalUser:', e);
        }
    }

    try {
        localStorage.removeItem(key);
        localStorage.setItem(key, value);
    } catch (e) {
        console.warn('Failed to save to localStorage (quota exceeded or disabled):', e);
        try {
            // Clear non-essential items to free up space
            const keysToRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k !== 'marshalUser' && k !== 'redrivo_user' && k !== 'redrivo_current_user') {
                    keysToRemove.push(k);
                }
            }
            keysToRemove.forEach(k => localStorage.removeItem(k));
            // Try setting again by removing first
            localStorage.removeItem(key);
            localStorage.setItem(key, value);
        } catch (e2) {
            console.error('Still failed to save to localStorage after cleanup:', e2);
        }
    }
}

const fallbackCarIcon = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#8E8E93" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"></path><circle cx="7" cy="17" r="2"></circle><circle cx="17" cy="17" r="2"></circle></svg>`;
const locationPinIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle; display:inline-block;"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;
let otpTimerInterval = null;

// Marshal's real-time GPS position (updated continuously)
let marshalLat = null;
let marshalLng = null;
let marshalGpsWatcher = null;
let activeGpsMode = localStorage.getItem('redrivo_marshal_gps_mode') || 'gps';

const mockLocations = {
    mumbai: { lat: 19.0664, lng: 72.8680, name: 'Mumbai BKC' },
    delhi: { lat: 28.6304, lng: 77.2177, name: 'Delhi Connaught Place' },
    bangalore: { lat: 12.9716, lng: 77.5946, name: 'Bangalore MG Road' },
    kolkata: { lat: 22.5487, lng: 88.3516, name: 'Kolkata Park Street' }
};

async function reportMarshalLocation(lat, lng) {
    if (!currentUser || !currentUser.id) return;
    try {
        await fetch(`${API_URL}/users/${currentUser.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat, lng })
        });
        console.log('Reported marshal location to server:', lat, lng);
    } catch (err) {
        console.warn('Failed to report marshal location:', err.message);
    }
}

function updateLocationStatusUI(msg = '', isError = false) {
    const textEl = document.getElementById('gps-status-text');
    const iconEl = document.getElementById('gps-status-icon');
    const badgeEl = document.getElementById('gps-accuracy-badge');
    if (!textEl) return;

    if (activeGpsMode !== 'gps') {
        let name = 'Custom';
        let lat = marshalLat;
        let lng = marshalLng;
        if (mockLocations[activeGpsMode]) {
            name = mockLocations[activeGpsMode].name;
            lat = mockLocations[activeGpsMode].lat;
            lng = mockLocations[activeGpsMode].lng;
        }
        textEl.textContent = `Override: ${name} (${lat ? lat.toFixed(4) : '?'}, ${lng ? lng.toFixed(4) : '?'})`;
        if (iconEl) {
            iconEl.textContent = 'build';
            iconEl.style.color = '#F59E0B';
            iconEl.classList.remove('animate-pulse');
        }
        if (badgeEl) badgeEl.classList.add('hidden');
        return;
    }

    if (isError) {
        textEl.textContent = `GPS Error: ${msg}. Using fallback BKC Mumbai (${marshalLat ? marshalLat.toFixed(4) : '?'}, ${marshalLng ? marshalLng.toFixed(4) : '?'})`;
        if (iconEl) {
            iconEl.textContent = 'location_off';
            iconEl.style.color = '#ef4444';
            iconEl.classList.remove('animate-pulse');
        }
        if (badgeEl) badgeEl.classList.add('hidden');
    } else if (marshalLat !== null && marshalLng !== null) {
        textEl.textContent = `GPS Active: ${marshalLat.toFixed(4)}, ${marshalLng.toFixed(4)}`;
        if (iconEl) {
            iconEl.textContent = 'my_location';
            iconEl.style.color = '#10b981';
            iconEl.classList.remove('animate-pulse');
        }
        if (badgeEl) badgeEl.classList.remove('hidden');
    } else {
        textEl.textContent = msg || 'Acquiring GPS lock...';
        if (iconEl) {
            iconEl.textContent = 'location_searching';
            iconEl.style.color = '#D4AF37';
            iconEl.classList.add('animate-pulse');
        }
        if (badgeEl) badgeEl.classList.add('hidden');
    }
}

function initGpsUIState() {
    const selectEl = document.getElementById('mock-location-select');
    if (selectEl) {
        selectEl.value = activeGpsMode;
    }
    const customDiv = document.getElementById('custom-coords-inputs');
    if (activeGpsMode === 'custom') {
        if (customDiv) customDiv.classList.remove('hidden');
        const latInput = document.getElementById('custom-lat');
        const lngInput = document.getElementById('custom-lng');
        if (latInput && marshalLat) latInput.value = marshalLat;
        if (lngInput && marshalLng) lngInput.value = marshalLng;
    } else {
        if (customDiv) customDiv.classList.add('hidden');
    }
    updateLocationStatusUI();
}

window.acceptGpsConsent = function() {
    safeSetLocalStorage('redrivo_gps_consent', 'true');
    const modal = document.getElementById('gps-disclosure-modal');
    if (modal) modal.style.display = 'none';
    startMarshalGPS();
};

window.denyGpsConsent = function() {
    safeSetLocalStorage('redrivo_gps_consent', 'false');
    const modal = document.getElementById('gps-disclosure-modal');
    if (modal) modal.style.display = 'none';
    const checkbox = document.getElementById('status-toggle');
    if (checkbox) {
        checkbox.checked = false;
        toggleMarshalStatus(checkbox);
    }
    showToast("GPS consent denied. You cannot go online without location access.", "warning");
};

function requestInitialLocationPermission() {
    return new Promise((resolve) => {
        if (!navigator.geolocation) return resolve();
        console.log(`[${new Date().toISOString()}] [DEBUG-PERM] Requesting location permission via getCurrentPosition...`);
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                console.log(`[${new Date().toISOString()}] [DEBUG-PERM] Location permission granted/resolved.`);
                resolve();
            },
            (err) => {
                console.warn(`[${new Date().toISOString()}] [DEBUG-PERM] Location permission rejected/failed:`, err.message);
                resolve(); // Resolve anyway so push notification setup is never permanently blocked
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
    });
}

function startMarshalGPS() {
    initGpsUIState();

    if (activeGpsMode === 'gps') {
        const hasConsent = localStorage.getItem('redrivo_gps_consent');
        if (hasConsent !== 'true') {
            const modal = document.getElementById('gps-disclosure-modal');
            if (modal) modal.style.display = 'flex';
            return;
        }
    }

    startLocationTracking();
}

function startLocationTracking() {
    if (activeGpsMode !== 'gps') {
        if (mockLocations[activeGpsMode]) {
            marshalLat = mockLocations[activeGpsMode].lat;
            marshalLng = mockLocations[activeGpsMode].lng;
        }
        updateLocationStatusUI();
        reportMarshalLocation(marshalLat, marshalLng);
        return;
    }

    if (!navigator.geolocation) {
        console.warn('Geolocation not supported by this browser.');
        const defLoc = getDefaultCityLocation();
        marshalLat = defLoc.lat;
        marshalLng = defLoc.lng;
        updateLocationStatusUI(`Not supported. Using ${defLoc.name} fallback`, true);
        reportMarshalLocation(marshalLat, marshalLng);
        return;
    }

    if (marshalGpsWatcher) {
        navigator.geolocation.clearWatch(marshalGpsWatcher);
        marshalGpsWatcher = null;
    }

    marshalGpsWatcher = navigator.geolocation.watchPosition(
        (pos) => {
            if (activeGpsMode === 'gps') {
                marshalLat = pos.coords.latitude;
                marshalLng = pos.coords.longitude;
                updateLocationStatusUI();
                reportMarshalLocation(marshalLat, marshalLng);
                if (typeof loadAvailablePickups === 'function') {
                    loadAvailablePickups();
                }
            }
        },
        (err) => {
            console.warn('GPS error:', err.message);
            if (activeGpsMode === 'gps') {
                if (marshalLat === null || marshalLng === null) {
                    const defLoc = getDefaultCityLocation();
                    marshalLat = defLoc.lat;
                    marshalLng = defLoc.lng;
                }
                updateLocationStatusUI(err.message, true);
                reportMarshalLocation(marshalLat, marshalLng);
            }
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
}

window.detectGPSLocation = function() {
    activeGpsMode = 'gps';
    safeSetLocalStorage('redrivo_marshal_gps_mode', 'gps');
    const selectEl = document.getElementById('mock-location-select');
    if (selectEl) selectEl.value = 'gps';
    const customDiv = document.getElementById('custom-coords-inputs');
    if (customDiv) customDiv.classList.add('hidden');
    
    marshalLat = null;
    marshalLng = null;
    startMarshalGPS();
    showToast('Requesting GPS lock...', 'info');
};

window.applyGpsMode = function(mode) {
    activeGpsMode = mode;
    safeSetLocalStorage('redrivo_marshal_gps_mode', mode);
    
    const customDiv = document.getElementById('custom-coords-inputs');
    if (mode === 'custom') {
        if (customDiv) customDiv.classList.remove('hidden');
        const latInput = document.getElementById('custom-lat');
        const lngInput = document.getElementById('custom-lng');
        if (latInput && marshalLat) latInput.value = marshalLat;
        if (lngInput && marshalLng) lngInput.value = marshalLng;
    } else {
        if (customDiv) customDiv.classList.add('hidden');
        if (mode === 'gps') {
            startMarshalGPS();
        } else if (mockLocations[mode]) {
            marshalLat = mockLocations[mode].lat;
            marshalLng = mockLocations[mode].lng;
            if (marshalGpsWatcher) {
                navigator.geolocation.clearWatch(marshalGpsWatcher);
                marshalGpsWatcher = null;
            }
            updateLocationStatusUI();
            reportMarshalLocation(marshalLat, marshalLng);
            if (typeof loadAvailablePickups === 'function') {
                loadAvailablePickups();
            }
            showToast(`Location overridden to ${mockLocations[mode].name}`, 'success');
        }
    }
};

window.applyCustomCoordinates = function() {
    const latVal = parseFloat(document.getElementById('custom-lat').value);
    const lngVal = parseFloat(document.getElementById('custom-lng').value);
    if (isNaN(latVal) || isNaN(lngVal)) {
        showToast('Please enter valid decimal coordinates', 'error');
        return;
    }
    marshalLat = latVal;
    marshalLng = lngVal;
    if (marshalGpsWatcher) {
        navigator.geolocation.clearWatch(marshalGpsWatcher);
        marshalGpsWatcher = null;
    }
    updateLocationStatusUI();
    reportMarshalLocation(marshalLat, marshalLng);
    if (typeof loadAvailablePickups === 'function') {
        loadAvailablePickups();
    }
    showToast('Custom coordinates applied', 'success');
};

function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.style.position = 'fixed';
    toast.style.top = '20px';
    toast.style.right = '20px';
    toast.style.padding = '15px 25px';
    toast.style.background = type === 'success' ? '#10b981' : '#ef4444';
    toast.style.color = '#fff';
    toast.style.borderRadius = '8px';
    toast.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
    toast.style.zIndex = '9999';
    toast.style.fontWeight = '600';
    toast.style.transition = 'opacity 0.3s ease';
    toast.innerHTML = `<div style="display:flex; align-items:center; gap:10px;">
        <i data-lucide="${type === 'success' ? 'check-circle' : 'alert-circle'}" style="width:20px; height:20px;"></i>
        <span>${message}</span>
    </div>`;
    
    document.body.appendChild(toast);
    if (typeof lucide !== 'undefined') lucide.createIcons();
    
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// OTP state - enforce 60-second cooldown across all flows
let otpCooldownSeconds = 0;

function startOtpTimer(timerElId = 'resend-login-timer', resendBtnId = 'resend-login-otp') {
    let timeLeft = 60;
    otpCooldownSeconds = 60;
    const timerEl = document.getElementById(timerElId);
    const resendBtn = document.getElementById(resendBtnId);

    if (timerEl) { timerEl.style.display = 'inline'; timerEl.textContent = `Resend in ${timeLeft}s`; }
    if (resendBtn) resendBtn.style.display = 'none';

    clearInterval(otpTimerInterval);
    otpTimerInterval = setInterval(() => {
        timeLeft--;
        otpCooldownSeconds = timeLeft;
        if (timerEl) timerEl.textContent = `Resend in ${timeLeft}s`;
        if (timeLeft <= 0) {
            clearInterval(otpTimerInterval);
            otpCooldownSeconds = 0;
            if (timerEl) timerEl.style.display = 'none';
            if (resendBtn) resendBtn.style.display = 'inline';
        }
    }, 1000);
}

let currentLoginMode = 'phone'; // 'phone' | 'email'

function switchLoginMode(mode) {
    currentLoginMode = mode;
    const tabPhone = document.getElementById('tab-login-phone');
    const tabEmail = document.getElementById('tab-login-email');
    const label = document.getElementById('login-id-label');
    const prefix = document.getElementById('login-id-prefix');
    const input = document.getElementById('login-id');
    const otpGroup = document.getElementById('login-otp-group');
    const btn = document.getElementById('btn-login-action');

    // Reset verification stage if switched
    if (otpGroup) otpGroup.style.display = 'none';
    if (btn) {
        btn.innerHTML = 'Send OTP';
        btn.disabled = false;
    }
    if (window.clearOtpBoxes) clearOtpBoxes('login-otp');
    if (input) input.value = '';

    if (mode === 'email') {
        if (tabPhone) tabPhone.classList.remove('active');
        if (tabEmail) tabEmail.classList.add('active');
        if (label) label.innerText = 'Email Address';
        if (prefix) prefix.style.display = 'none';
        if (input) {
            input.type = 'email';
            input.placeholder = 'Enter your email address';
            input.maxLength = 100;
        }
    } else {
        if (tabPhone) tabPhone.classList.add('active');
        if (tabEmail) tabEmail.classList.remove('active');
        if (label) label.innerText = 'Phone Number (10 Digits)';
        if (prefix) prefix.style.display = 'inline-block';
        if (input) {
            input.type = 'tel';
            input.placeholder = 'Enter your 10 Digits Mobile Number';
            input.maxLength = 10;
        }
    }
}

function handleLoginIdInput(input) {
    if (currentLoginMode === 'phone') {
        input.value = input.value.replace(/[^0-9]/g, '');
    }
}

function validateLoginIdentifier() {
    const raw = document.getElementById('login-id')?.value.trim() || '';
    if (currentLoginMode === 'phone') {
        if (raw.length !== 10 || !/^\d{10}$/.test(raw)) {
            showToast('Enter a valid 10-digit mobile number.', 'error');
            return null;
        }
        return { phone: `+91${raw}` };
    } else {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(raw)) {
            showToast('Enter a valid email address.', 'error');
            return null;
        }
        return { email: raw.toLowerCase() };
    }
}

async function handleResendOTP() {
    if (otpCooldownSeconds > 0) {
        showToast(`Please wait ${otpCooldownSeconds} seconds before requesting a new OTP.`, 'error');
        return;
    }
    const payload = validateLoginIdentifier();
    if (!payload) return;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    
    try {
        const res = await fetch(`${API_URL}/auth/send-otp`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify(payload)
        });
        clearTimeout(timeoutId);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        showToast(currentLoginMode === 'email' ? 'OTP sent to your email!' : 'OTP resent to your mobile number!', 'success');
        startOtpTimer();
    } catch (err) {
        clearTimeout(timeoutId);
        console.error('[LOGIN_ERROR] handleResendOTP complete exception:', {
            name: err.name,
            message: err.message,
            stack: err.stack,
            keys: Object.getOwnPropertyNames(err)
        });
        console.error('[LOGIN_ERROR] handleResendOTP JSON serialized:', JSON.stringify(err, Object.getOwnPropertyNames(err)));
        if (err.name === 'AbortError') {
            showToast('Request timed out. Server may be starting — try again in 30 seconds.', 'error');
        } else {
            showToast(err.message, 'error');
        }
    }
}

// --- Auth Handling ---
async function handleLoginAction() {
    const btn = document.getElementById('btn-login-action');
    const payload = validateLoginIdentifier();
    if (!payload) return;

    const otpGroup = document.getElementById('login-otp-group');
    const isVerifyStage = otpGroup && otpGroup.style.display === 'block';

    if (!isVerifyStage && otpCooldownSeconds > 0) {
        showToast(`Please wait ${otpCooldownSeconds} seconds before requesting a new OTP.`, 'error');
        return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    try {
        if (!isVerifyStage) {
            // Stage 1: Send OTP
            localStorage.removeItem('marshalUser');
            currentUser = null;
            if (window.clearOtpBoxes) clearOtpBoxes('login-otp');
            btn.innerHTML = 'Sending...';
            btn.disabled = true;
            const res = await fetch(`${API_URL}/auth/send-otp`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify(payload)
            });
            clearTimeout(timeoutId);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);

            otpGroup.style.display = 'block';
            btn.innerHTML = 'Verify & Login';
            const firstBox = document.querySelector('.otp-boxes[data-target="login-otp"] .otp-box');
            if (firstBox) firstBox.focus();
            showToast(currentLoginMode === 'email' ? 'Verification OTP sent to your email!' : 'Verification OTP sent to your mobile number!', 'success');
            if (data.otp && window.fillOtpBoxes) fillOtpBoxes('login-otp', data.otp);
            startOtpTimer();
            btn.disabled = false;
        } else {
            // Stage 2: Verify OTP
            const otp = window.getOtpValue ? getOtpValue('login-otp') : document.getElementById('login-otp').value.trim();
            if (otp.length !== 6) return showToast('Enter the 6-digit OTP', 'error');
            
            btn.innerHTML = 'Verifying...';
            const res = await fetch(`${API_URL}/auth/verify-otp`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({ ...payload, otp, role: 'marshal' })
            });
            clearTimeout(timeoutId);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);

            if (data.user.role !== 'marshal') {
                btn.innerHTML = 'Send OTP';
                throw new Error('Access denied. This portal is for Drivers only.');
            }

            currentUser = normalizeUser(data.user);
            safeSetLocalStorage('marshalUser', JSON.stringify(currentUser));
            if (data.token) {
                safeSetLocalStorage('redrivo_token', data.token);
            }
            syncAuthSessionToNative();
            showToast('Login successful!', 'success');
            enterApp();
        }
    } catch (err) {
        clearTimeout(timeoutId);
        console.error('[LOGIN_ERROR] handleLoginAction complete exception:', {
            name: err.name,
            message: err.message,
            stack: err.stack,
            keys: Object.getOwnPropertyNames(err)
        });
        console.error('[LOGIN_ERROR] handleLoginAction JSON serialized:', JSON.stringify(err, Object.getOwnPropertyNames(err)));
        if (err.name === 'AbortError') {
            showToast('Request timed out. Server may be starting — try again in 30 seconds.', 'error');
        } else {
            showToast(err.message, 'error');
        }
        btn.disabled = false;
        btn.innerHTML = isVerifyStage ? 'Verify & Login' : 'Send OTP';
    }
}

async function handleGoogleSignIn() {
    if (window._isGoogleSigningIn) {
        console.log('[Google Sign-In] Already in progress, ignoring duplicate tap.');
        return;
    }
    window._isGoogleSigningIn = true;

    const btn = document.getElementById('btn-google-signin');
    if (btn) {
        btn.disabled = true;
        btn.style.opacity = '0.6';
        btn.style.pointerEvents = 'none';
    }

    try {
        if (!window.Capacitor || !window.Capacitor.isPluginAvailable('FirebaseAuthentication')) {
            showToast('Google Sign-In is only available in the Android app build.', 'info');
            return;
        }

        const { FirebaseAuthentication } = window.Capacitor.Plugins;

        // Pre-emptively reset any previous stuck Google Play Services state
        try {
            await FirebaseAuthentication.signOut();
        } catch (signOutErr) {
            /* ignore */
        }

        showToast('Connecting to Google...', 'info');

        const result = await FirebaseAuthentication.signInWithGoogle({
            useCredentialManager: false
        });
        const idToken = result.credential?.idToken || result.idToken;

        if (!idToken) {
            console.log('[Google Sign-In] No ID token returned (user dismissed prompt).');
            return;
        }

        showToast('Signing in...', 'info');
        const res = await fetch(`${API_URL}/auth/google-signin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken, role: 'marshal' })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Google Sign-In failed');

        if (data.user.role !== 'marshal') {
            throw new Error('Access denied. This portal is for Drivers only.');
        }

        // Setup Marshal User Session
        currentUser = normalizeUser(data.user);
        safeSetLocalStorage('marshalUser', JSON.stringify(currentUser));
        if (data.token) {
            safeSetLocalStorage('redrivo_token', data.token);
        }
        syncAuthSessionToNative();
        showToast(`Welcome back, ${data.user.name || 'Driver'}!`, 'success');
        enterApp();
    } catch (err) {
        console.log('[Google Sign-In]', err);
        const errMsg = (err && (err.message || err.errorMessage || String(err))) || '';
        const errCode = (err && err.code) || '';
        const lower = errMsg.toLowerCase();

        // Silent return for user-initiated cancellation (no error toast)
        if (
            lower.includes('cancel') ||
            lower.includes('12501') ||
            lower.includes('sign_in_cancelled') ||
            lower.includes('closed') ||
            errCode === '12501' ||
            errCode === 'ERROR_USER_CANCELLED'
        ) {
            console.log('[Google Sign-In] User cancelled sign-in prompt.');
            return;
        }

        // Handle 12502 / in-progress gracefully
        if (lower.includes('12502') || errCode === '12502' || lower.includes('sign_in_currently_in_progress')) {
            console.warn('[Google Sign-In] In-progress state detected, resetting client.');
            if (window.Capacitor && window.Capacitor.isPluginAvailable('FirebaseAuthentication')) {
                window.Capacitor.Plugins.FirebaseAuthentication.signOut().catch(() => {});
            }
            showToast('Google Sign-In was busy. Please tap once to continue.', 'info');
            return;
        }

        // User-friendly messages for genuine errors
        let userMessage = 'Google Sign-In failed. Please try again.';
        if (lower.includes('network') || lower.includes('failed to fetch')) {
            userMessage = 'Network connection error. Please check your internet.';
        } else if (lower.includes('invalid or expired')) {
            userMessage = 'Authentication session expired. Please try signing in again.';
        } else if (errMsg && !errMsg.includes('12500') && !errMsg.includes('12501') && !errMsg.includes('ApiException')) {
            userMessage = errMsg;
        }

        showToast(userMessage, 'error');
    } finally {
        window._isGoogleSigningIn = false;
        if (btn) {
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.style.pointerEvents = 'auto';
        }
    }
}

async function logout() {
    currentUser = null;
    localStorage.removeItem('marshalUser');
    localStorage.removeItem('redrivo_token');
    
    // Sign out from Google / Firebase to reset account picker for next login
    try {
        if (window.Capacitor && window.Capacitor.isPluginAvailable('FirebaseAuthentication')) {
            const { FirebaseAuthentication } = window.Capacitor.Plugins;
            await FirebaseAuthentication.signOut();
        }
    } catch (e) {
        console.warn('Firebase / Google sign-out warning:', e.message);
    }

    const performReload = () => {
        location.reload();
    };

    const BatteryOpt = getBatteryOptimizationPlugin();
    if (BatteryOpt && typeof BatteryOpt.saveAuthSession === 'function') {
        BatteryOpt.saveAuthSession({ marshalId: '', token: '' })
            .then(performReload)
            .catch(err => {
                console.error('[ERROR] Failed to clear native session on logout:', err);
                performReload();
            });
        return;
    }
    performReload();
}

// --- App Navigation ---
let profilePollTimer = null;
function startProfilePolling() {
    if (profilePollTimer) return;
    refreshUserProfile();
    profilePollTimer = setInterval(refreshUserProfile, 15000); // refresh user profile every 15s
}

async function refreshUserProfile() {
    if (!currentUser) return;
    try {
        let res = await fetch(`${API_URL}/users/${currentUser.id}?t=${Date.now()}`, { cache: 'no-store' });
        let user = null;
        if (res.ok) {
            user = await res.json();
        } else {
            console.warn('Single user profile fetch failed.');
        }
        if (user) {
            if (user.status === 'suspended' || user.status === 'terminated') {
                showToast('Your account is suspended.', 'error');
                logout();
                return;
            }
            
            // Check for status change to pending_submission or rejected to trigger overlay
            const oldStatus = currentUser.kycStatus || currentUser.kycstatus;
            const newStatus = user.kycStatus || user.kycstatus;
            if (oldStatus !== newStatus && (newStatus === 'pending_submission' || newStatus === 'rejected' || newStatus === 'Re-submit KYC')) {
                sessionStorage.removeItem('skipKYC');
            }

            user = normalizeUser(user);
            currentUser = { ...currentUser, ...user };
            safeSetLocalStorage('marshalUser', JSON.stringify(currentUser));
            
            // Refresh UI components
            checkOnboarding();
            updateStatusDisplay();
            
            document.getElementById('user-name-display').textContent = `Hi, ${currentUser.name}`;
            const profilePageName = document.getElementById('profile-page-name');
            if (profilePageName) profilePageName.textContent = currentUser.name;

            const photoUrl = currentUser.profilePictureUrl || currentUser.profilepictureurl || currentUser.facePhotoUrl || currentUser.facephotourl;
            if (photoUrl) {
                let srcUrl = photoUrl;
                if (!photoUrl.startsWith('data:')) {
                    const cleanPhotoUrl = '/' + photoUrl.replace(/\\/g, '/').replace(/^\/+/, '');
                    srcUrl = `${API_URL.replace('/api', '')}${cleanPhotoUrl}`;
                }
                document.getElementById('user-avatar-display').src = srcUrl;
                const profilePageAvatar = document.getElementById('profile-page-avatar');
                if (profilePageAvatar) profilePageAvatar.src = srcUrl;
            }
        }
    } catch (e) {
        console.error('Failed to refresh user profile:', e);
    }
}

function syncAuthSessionToNative(retries = 30) {
    if (!currentUser || !currentUser.id) return;
    const BatteryOpt = getBatteryOptimizationPlugin();
    if (BatteryOpt && typeof BatteryOpt.saveAuthSession === 'function') {
        const mId = currentUser.id;
        const tkn = localStorage.getItem('redrivo_token') || '';
        console.log(`[DEBUG] JS calling saveAuthSession with: marshalId='${mId}', token='${tkn}'`);
        BatteryOpt.saveAuthSession({
            marshalId: mId,
            token: tkn
        }).then(() => {
            console.log(`[DEBUG] Auth session successfully synced to native SharedPreferences. marshalId='${mId}', token='${tkn}'`);
        }).catch(err => {
            console.error('[ERROR] Failed to save auth session to native:', err);
        });
    } else if (retries > 0) {
        console.log(`[DEBUG] BatteryOptimization plugin not ready, retrying sync in 500ms... (${retries} retries left)`);
        setTimeout(() => syncAuthSessionToNative(retries - 1), 500);
    }
}

function checkPendingNotificationAction() {
    const BatteryOpt = getBatteryOptimizationPlugin();
    if (BatteryOpt) {
        BatteryOpt.getPendingNotificationAction()
            .then(res => {
                if (res && res.acceptedRequestId) {
                    console.log('[DEBUG] Pending notification action consumed:', res.acceptedRequestId);
                    if (typeof window.handleAcceptedFromNotification === 'function') {
                        window.handleAcceptedFromNotification(res.acceptedRequestId);
                    }
                }
            })
            .catch(err => console.error('[ERROR] Failed to get pending action:', err));
    }
}

async function enterApp() {
    try {
        console.log('enterApp: initializing dashboard...');
        document.body.classList.remove('login-active');
        document.body.classList.add('logged-in');

        syncAuthSessionToNative();
        checkPendingNotificationAction();
        checkAndRenderBatteryBanner();

        if (currentUser) {
            renderUserStatus(currentUser);
            checkOnboarding();
        }
        // Start profile polling and update user info immediately
        startProfilePolling();

        try {
            const settingsRes = await fetch(`${API_URL}/settings/global`, { cache: 'no-store' });
            if (settingsRes.ok) {
                window.globalSettings = await settingsRes.json();
            }
        } catch (e) {
            console.error('Error fetching global settings', e);
            window.globalSettings = { five_star_bonus: 50, payout_days: 3 }; // fallback
        }

        const loginScreen = document.getElementById('login-screen');
        if (loginScreen) loginScreen.classList.add('hidden');
        
        const registerScreen = document.getElementById('register-screen');
        if (registerScreen) registerScreen.classList.add('hidden');
        
        const mainApp = document.getElementById('main-app');
        if (mainApp) mainApp.classList.remove('hidden');

        document.getElementById('user-name-display').textContent = `Hi, ${currentUser.name}`;
        const profilePageName = document.getElementById('profile-page-name');
        if (profilePageName) profilePageName.textContent = currentUser.name;

        const photoUrl = currentUser.profilePictureUrl || currentUser.profilepictureurl || currentUser.facePhotoUrl || currentUser.facephotourl;
        if (photoUrl) {
            let srcUrl = photoUrl;
            if (!photoUrl.startsWith('data:')) {
                const cleanPhotoUrl = '/' + photoUrl.replace(/\\/g, '/').replace(/^\/+/, '');
                srcUrl = `${API_URL.replace('/api', '')}${cleanPhotoUrl}`;
            }
            document.getElementById('user-avatar-display').src = srcUrl;
            const profilePageAvatar = document.getElementById('profile-page-avatar');
            if (profilePageAvatar) profilePageAvatar.src = srcUrl;
        }

        checkOnboarding();
        updateStatusDisplay();
        if (typeof loadEarnings === 'function') loadEarnings();

        // Sequenced Boot Permissions (Location -> Push Notifications)
        (async () => {
            console.log(`[${new Date().toISOString()}] [DEBUG-PERM] Starting sequenced boot permissions...`);
            await requestInitialLocationPermission();
            startMarshalGPS();

            setTimeout(async () => {
                console.log(`[${new Date().toISOString()}] [DEBUG-PERM] Requesting Push Notification permission...`);
                await setupPushNotifications();
            }, 800);
        })();

        // Upload FCM token to backend if it was already registered
        if (currentUser && window.registeredFcmToken) {
            fetch(`${API_URL}/users/${currentUser.id}/fcm-token`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fcmToken: window.registeredFcmToken })
            }).catch(e => console.error('Failed to save FCM token on enterApp', e));
        }
        
        // Check for active trip to auto-resume navigation
        try {
            const tripsRes = await fetch(`${API_URL}/trips`, { cache: 'no-store' });
            if (tripsRes.ok) {
                const allTrips = await tripsRes.json();
                const activeTrip = allTrips.find(t => 
                    (((t.marshalId || t.marshalid) === currentUser.id && ['pending_payment', 'assigned', 'pending_otp_1', 'in_transit'].includes(t.status)) ||
                     ((t.deliveryMarshalId || t.deliverymarshalid) === currentUser.id && ['ready_for_delivery', 'out_for_delivery', 'pending_delivery'].includes(t.status)))
                );
                if (activeTrip) {
                    switchTab('map');
                    window.openMapView(activeTrip.id);
                    lucide.createIcons();
                    window.isAppLoaded = true;
                    return;
                }
            }
        } catch (e) {
            console.warn("Failed to check active trip for auto-resume:", e);
        }

        // Default to 'trips' (Home screen) on cold launch to avoid getting stuck on invalid pages
        switchTab('trips');

        lucide.createIcons();
        window.isAppLoaded = true;

    } catch (err) {
        console.error('Failed to enter app', err);
    }
}

function checkOnboarding() {
    if (!currentUser) return;
    const status = currentUser.kycStatus || currentUser.kycstatus;
    const needsOnboarding = !status || status === 'pending_submission' || status === 'rejected' || status === 'Re-submit KYC';
    const hasSkipped = sessionStorage.getItem('skipKYC') === 'true';

    const kycScreen = document.getElementById('kyc-screen');
    const mainApp = document.getElementById('main-app');

    if (needsOnboarding && !hasSkipped) {
        if (mainApp) mainApp.classList.add('hidden');
        if (kycScreen) {
            const isHidden = kycScreen.classList.contains('hidden');
            kycScreen.classList.remove('hidden');
            initKycValidationListeners();
            if (isHidden) {
                populateOnboardingFields();
                goToKycStep(1);
            }
            updateKycButtonsState();
        }
    } else {
        if (kycScreen) kycScreen.classList.add('hidden');
        const loginScreen = document.getElementById('login-screen');
        if (mainApp && (!loginScreen || loginScreen.classList.contains('hidden'))) {
            mainApp.classList.remove('hidden');
        }
    }
}

function skipOnboarding() {
    if (typeof window.saveKycDraftState === 'function') {
        window.saveKycDraftState();
    }
    sessionStorage.setItem('skipKYC', 'true');
    const kycScreen = document.getElementById('kyc-screen');
    if (kycScreen) kycScreen.classList.add('hidden');
    const mainApp = document.getElementById('main-app');
    if (mainApp) mainApp.classList.remove('hidden');
}

window.openOnboarding = function() {
    sessionStorage.removeItem('skipKYC');
    const kycScreen = document.getElementById('kyc-screen');
    const mainApp = document.getElementById('main-app');
    if (mainApp) mainApp.classList.add('hidden');
    if (kycScreen) {
        kycScreen.classList.remove('hidden');
        initKycValidationListeners();
        populateOnboardingFields();
        if (typeof window.restoreKycDraftState === 'function') {
            window.restoreKycDraftState().then(restored => {
                if (!restored) {
                    goToKycStep(1);
                }
                updateKycButtonsState();
            });
        } else {
            goToKycStep(1);
            updateKycButtonsState();
        }
    }
};

function validateStep1() {
    let isValid = true;
    const emailEl = document.getElementById('on-email');
    const email = emailEl ? emailEl.value.trim() : '';

    if (!window.validateEmail(email)) {
        window.setKYCFieldError(emailEl, 'Please enter a valid Email Address.');
        isValid = false;
    } else {
        window.clearKYCFieldError(emailEl);
    }

    return isValid;
}

function validateStep2() {
    let isValid = true;
    const panEl = document.getElementById('on-pan');
    const aadhaarEl = document.getElementById('on-aadhaar');
    const dlEl = document.getElementById('on-dl');

    const idType = window.selectedKycIdType || (panEl && panEl.value.trim() ? 'pan' : 'aadhaar');

    if (idType === 'pan') {
        // PAN Number
        const pan = panEl ? panEl.value.trim() : '';
        if (!window.validatePan(pan)) {
            window.setKYCFieldError(panEl, 'Format must be ABCDE1234F (5 letters, 4 digits, 1 letter).');
            isValid = false;
        } else {
            window.clearKYCFieldError(panEl);
        }
        if (aadhaarEl) window.clearKYCFieldError(aadhaarEl);
    } else {
        // Aadhaar Number
        const aadhaar = aadhaarEl ? aadhaarEl.value.trim() : '';
        if (!window.validateAadhaar(aadhaar)) {
            window.setKYCFieldError(aadhaarEl, 'Must be exactly 12 digits.');
            isValid = false;
        } else {
            window.clearKYCFieldError(aadhaarEl);
        }
        if (panEl) window.clearKYCFieldError(panEl);
    }

    // Driving License (Mandatory)
    const dl = dlEl ? dlEl.value.trim() : '';
    if (!window.validateDL(dl)) {
        window.setKYCFieldError(dlEl, 'Must start with 2 state letters followed by digits.');
        isValid = false;
    } else {
        window.clearKYCFieldError(dlEl);
    }

    // Files verification
    const panFile = window.capturedKycFiles['pan'];
    const panBackFile = window.capturedKycFiles['panback'];
    const aadhaarFile = window.capturedKycFiles['aadhaar'];
    const aadhaarBackFile = window.capturedKycFiles['aadhaarback'];
    const faceFile = document.getElementById('on-face-file') ? document.getElementById('on-face-file').files[0] : null;
    const dlFile = window.capturedKycFiles['dl'];
    const dlBackFile = window.capturedKycFiles['dlback'];

    const hasPanPhoto = currentUser.panPhotoUrl || currentUser.panphotourl;
    const hasPanBackPhoto = currentUser.panBackUrl || currentUser.panbackurl;
    const hasAadhaarPhoto = currentUser.aadhaarPhotoUrl || currentUser.aadhaarphotourl;
    const hasAadhaarBackPhoto = currentUser.aadhaarBackUrl || currentUser.aadhaarbackurl;
    const hasFacePhoto = currentUser.facePhotoUrl || currentUser.facephotourl;
    const hasDlPhoto = currentUser.dlUrl || currentUser.dlurl;
    const hasDlBackPhoto = currentUser.dlBackUrl || currentUser.dlbackurl;

    // Helper function to highlight file error containers in red
    function highlightFileError(key) {
        const container = document.getElementById(`${key}-photo-status-container`) || document.getElementById('camera-section');
        if (container) {
            container.classList.add('kyc-error-blink');
            container.style.borderRadius = '12px';
            const clearFn = function() {
                container.classList.remove('kyc-error-blink');
                container.removeEventListener('click', clearFn);
            };
            container.addEventListener('click', clearFn);
        }
    }

    const filesToCheck = [
        { file: faceFile, label: 'Live Selfie', key: 'face' },
        { file: dlFile, label: 'Driving License Front', key: 'dl' },
        { file: dlBackFile, label: 'Driving License Back', key: 'dlback' }
    ];

    if (idType === 'pan') {
        filesToCheck.push({ file: panFile, label: 'PAN Card Front', key: 'pan' });
        filesToCheck.push({ file: panBackFile, label: 'PAN Card Back', key: 'panback' });
    } else {
        filesToCheck.push({ file: aadhaarFile, label: 'Aadhaar Front', key: 'aadhaar' });
        filesToCheck.push({ file: aadhaarBackFile, label: 'Aadhaar Back', key: 'aadhaarback' });
    }

    for (const item of filesToCheck) {
        const nameSpan = document.getElementById(`${item.key}-file-name`);
        if (item.file && item.file.size > 5 * 1024 * 1024) {
            showToast(`${item.label} photo is too large. Max 5MB allowed.`, 'error');
            highlightFileError(item.key);
            isValid = false;
        } else if (nameSpan && nameSpan.textContent.includes('too large')) {
            showToast(`${item.label} photo exceeds 5MB limit. Please select a smaller file.`, 'error');
            highlightFileError(item.key);
            isValid = false;
        }
    }

    // Verify required presence for selected ID + DL + Selfie
    if (isValid) {
        if (idType === 'pan') {
            if (!panFile && !hasPanPhoto) {
                showToast('PAN Card front photo is required.', 'error');
                highlightFileError('pan');
                isValid = false;
            } else if (!panBackFile && !hasPanBackPhoto) {
                showToast('PAN Card back photo is required.', 'error');
                highlightFileError('panback');
                isValid = false;
            }
        } else {
            if (!aadhaarFile && !hasAadhaarPhoto) {
                showToast('Aadhaar front photo is required.', 'error');
                highlightFileError('aadhaar');
                isValid = false;
            } else if (!aadhaarBackFile && !hasAadhaarBackPhoto) {
                showToast('Aadhaar back photo is required.', 'error');
                highlightFileError('aadhaarback');
                isValid = false;
            }
        }

        if (isValid) {
            if (!faceFile && !hasFacePhoto) {
                showToast('Live Selfie photo is required.', 'error');
                highlightFileError('face');
                isValid = false;
            } else if (!dlFile && !hasDlPhoto) {
                showToast('Driving License front photo is required.', 'error');
                highlightFileError('dl');
                isValid = false;
            } else if (!dlBackFile && !hasDlBackPhoto) {
                showToast('Driving License back photo is required.', 'error');
                highlightFileError('dlback');
                isValid = false;
            }
        }
    }

    return isValid;
}


window.goToKycStep = function(stepNum, skipValidation = false) {
    let currentStep = window.currentKycStep || 1;
    if (document.getElementById('kyc-step-2') && document.getElementById('kyc-step-2').style.display === 'block') currentStep = 2;

    // If moving forward, validate Step 1
    if (!skipValidation && stepNum > currentStep) {
        if (currentStep === 1) {
            if (!validateStep1()) {
                showToast('Please enter a valid email address before proceeding.', 'error');
                setTimeout(() => {
                    const firstErr = document.querySelector('.kyc-error-blink');
                    if (firstErr) {
                        firstErr.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        if (firstErr.focus) firstErr.focus();
                    }
                }, 100);
                return;
            }
        }
    }

    window.currentKycStep = stepNum;
    document.querySelectorAll('.kyc-step-container').forEach(el => {
        el.style.display = 'none';
    });
    const target = document.getElementById(`kyc-step-${stepNum}`);
    if (target) {
        target.style.display = 'block';
    }
    
    if (stepNum === 2 && !skipValidation) {
        window.currentKycSubStepIndex = 0;
        if (window.updateWizardView) {
            window.updateWizardView();
        }
    }
    
    // Update visual progress stepper (2 Steps)
    const fill = document.getElementById('kyc-progress-fill');
    if (fill) {
        const widths = { 1: '50%', 2: '100%' };
        fill.style.width = widths[stepNum] || '50%';
    }
    for (let i = 1; i <= 2; i++) {
        const lbl = document.getElementById(`kyc-step-label-${i}`);
        if (lbl) {
            if (i <= stepNum) {
                lbl.style.color = 'var(--primary)';
                lbl.style.fontWeight = '700';
            } else {
                lbl.style.color = 'var(--text-muted)';
                lbl.style.fontWeight = 'normal';
            }
        }
    }
    
    const glassCard = target ? target.closest('.glass-card') : null;
    if (glassCard) glassCard.scrollTop = 0;
    
    updateKycButtonsState();
};

function updateKycButtonsState() {
    const btn1 = document.getElementById('btn-kyc-next-1');
    if (btn1) {
        btn1.disabled = false;
    }
    const btn2 = document.getElementById('btn-kyc-next-2');
    if (btn2) {
        btn2.disabled = false;
    }
    const btn3 = document.getElementById('btn-submit-kyc');
    if (btn3 && btn3.innerHTML !== 'Uploading Securely...') {
        btn3.disabled = false;
    }
}

let kycListenersInitialized = false;
function initKycValidationListeners() {
    if (kycListenersInitialized) return;
    const kycScreen = document.getElementById('kyc-screen');
    if (!kycScreen) return;
    kycListenersInitialized = true;
    
    const inputs = kycScreen.querySelectorAll('input, select, textarea');
    inputs.forEach(input => {
        input.addEventListener('input', () => {
            updateKycButtonsState();
            if (typeof window.saveKycDraftState === 'function') window.saveKycDraftState();
        });
        input.addEventListener('change', () => {
            updateKycButtonsState();
            if (typeof window.saveKycDraftState === 'function') window.saveKycDraftState();
        });
    });
}

function getDocAttachmentUrl(url) {
    if (!url) return '';
    if (url === 'uploaded') {
        // Return a tiny 1x1 transparent GIF placeholder
        return 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    }
    if (url.startsWith('data:')) return url;
    
    // If it is an absolute HTTP(S) URL
    if (url.startsWith('http://') || url.startsWith('https://')) {
        // Rewrite production Render URLs to local backend if running locally
        if (API_URL.includes('localhost') && url.includes('onrender.com') && url.includes('/uploads/')) {
            const pathIndex = url.indexOf('/uploads/');
            if (pathIndex !== -1) {
                const path = url.substring(pathIndex);
                return `${API_URL.replace('/api', '')}${path}`;
            }
        }
        return url;
    }
    
    const cleanUrl = '/' + url.replace(/\\/g, '/').replace(/^\/+/, '');
    return `${API_URL.replace('/api', '')}${cleanUrl}`;
}

function setupKycPreview(type, url) {
    const previewContainer = document.getElementById(`${type}-photo-preview-container`);
    const previewImg = document.getElementById(`${type}-photo-preview`);
    const statusContainer = document.getElementById(`${type}-photo-status-container`);
    
    if (previewContainer && previewImg) {
        if (url) {
            previewImg.src = getDocAttachmentUrl(url);
            previewContainer.style.display = 'flex';
            if (statusContainer) {
                statusContainer.style.border = '1px solid rgba(16, 185, 129, 0.3)';
                statusContainer.style.background = 'rgba(16, 185, 129, 0.03)';
                statusContainer.style.padding = '10px';
                statusContainer.style.borderRadius = '12px';
                statusContainer.style.transition = 'all 0.3s ease';
            }
        } else {
            previewContainer.style.display = 'none';
            if (statusContainer) {
                statusContainer.style.border = '';
                statusContainer.style.background = '';
                statusContainer.style.padding = '';
                statusContainer.style.borderRadius = '';
            }
        }
    }
    if (typeof updateKycButtonsState === 'function') {
        updateKycButtonsState();
    }
}

window.capturedKycFiles = {};

window.triggerFileSelect = function(type) {
    const labels = {
        'pan': 'PAN Card Front',
        'panback': 'PAN Card Back',
        'aadhaar': 'Aadhaar Card Front',
        'aadhaarback': 'Aadhaar Card Back',
        'dl': 'Driving License Front',
        'dlback': 'Driving License Back'
    };
    
    if (labels[type]) {
        window.openDocumentCamera(labels[type], type)
            .then((blob) => {
                // Wrap blob as a File object
                const filename = `kyc_${type}_${Date.now()}.jpg`;
                const file = new File([blob], filename, { type: 'image/jpeg', lastModified: Date.now() });
                
                // Store original file in memory
                window.capturedKycFiles[type] = file;
                
                // Update UI state
                const fileNameSpan = document.getElementById(`${type}-file-name`);
                if (fileNameSpan) {
                    fileNameSpan.textContent = file.name;
                    fileNameSpan.style.color = '';
                }
                
                // Update wizard custom preview if elements exist
                const previewImg = document.getElementById(`${type}-photo-preview`);
                if (previewImg) {
                    previewImg.src = URL.createObjectURL(file);
                }
                const wizardPreview = document.getElementById(`${type}-wizard-preview-container`);
                const wizardPlaceholder = document.getElementById(`${type}-wizard-upload-placeholder`);
                if (wizardPreview) wizardPreview.classList.remove('hidden');
                if (wizardPlaceholder) wizardPlaceholder.classList.add('hidden');
                
                // Run automatic OCR extraction on captured image
                if (typeof window.performDocumentOcr === 'function') {
                    window.performDocumentOcr(type, blob);
                }

                // Persist photo to IndexedDB
                if (typeof window.saveKycPhotoDraft === 'function') {
                    window.saveKycPhotoDraft(type, file, file.name);
                }
                if (typeof window.saveKycDraftState === 'function') {
                    window.saveKycDraftState();
                }
                
                if (window.checkWizardState) window.checkWizardState();
                
                const btn = document.getElementById(`on-${type}-upload-btn`);
                if (btn) {
                    if (!btn.dataset.originalHtml) {
                        btn.dataset.originalHtml = btn.innerHTML;
                    }
                    btn.innerHTML = `Submit`;
                    btn.style.background = '#D4AF37';
                    btn.style.borderColor = '#D4AF37';
                    btn.style.color = '#000';
                    btn.style.fontWeight = 'bold';
                    btn.onclick = function() { window.uploadSingleKycFile(type); };
                }
                
                const clearBtn = document.getElementById(`on-${type}-clear-btn`);
                if (clearBtn) {
                    clearBtn.style.display = 'inline-block';
                }
            })
            .catch(err => {
                console.log('[DOC_CAMERA] Cancelled or failed:', err.message);
            });
    } else {
        const input = document.getElementById(`on-${type}-file`);
        if (input) input.click();
    }
};

window.handleFileChange = function(input, type) {
    const file = input.files[0];
    const fileNameSpan = document.getElementById(`${type}-file-name`);
    const btn = document.getElementById(`on-${type}-upload-btn`);
    
    if (file) {
        console.log('[FILE_DEBUG] Selected file detail: name="' + file.name + '" size=' + file.size + ' type="' + file.type + '" isFile=' + (file instanceof File) + ' isBlob=' + (file instanceof Blob));
        // Check size limit: Max 5MB
        if (file.size > 5 * 1024 * 1024) {
            showToast(`File "${file.name}" is too large. Max 5MB allowed.`, 'error');
            input.value = ''; // clear file selection
            if (fileNameSpan) {
                fileNameSpan.textContent = 'File too large (Max 5MB)';
                fileNameSpan.style.color = '#ef4444';
            }
            return;
        }

        if (fileNameSpan) {
            fileNameSpan.textContent = file.name;
            fileNameSpan.style.color = ''; // reset color
        }

        // Change button to Submit state
        if (btn) {
            if (!btn.dataset.originalHtml) {
                btn.dataset.originalHtml = btn.innerHTML;
            }
            btn.innerHTML = `Submit`;
            btn.style.background = '#D4AF37';
            btn.style.borderColor = '#D4AF37';
            btn.style.color = '#000';
            btn.style.fontWeight = 'bold';
            btn.onclick = function() { window.uploadSingleKycFile(type); };
        }
        
        const clearBtn = document.getElementById(`on-${type}-clear-btn`);
        if (clearBtn) {
            clearBtn.style.display = 'inline-block';
        }
    } else {
        if (fileNameSpan) {
            fileNameSpan.textContent = 'No file chosen';
            fileNameSpan.style.color = '';
        }
    }
};

window.changeUploadedPhoto = function(type) {
    const previewContainer = document.getElementById(`${type}-photo-preview-container`);
    if (previewContainer) {
        previewContainer.style.display = 'none';
        if (type === 'face') {
            const btnCamera = document.getElementById('btn-start-camera');
            if (btnCamera) btnCamera.style.display = 'block';
        }
    }
};

window.removeSelectedFile = function(type) {
    const input = document.getElementById(`on-${type}-file`);
    if (input) input.value = '';
    
    // Clear captured file from memory
    if (window.capturedKycFiles) {
        window.capturedKycFiles[type] = null;
    }
    
    const fileNameSpan = document.getElementById(`${type}-file-name`);
    if (fileNameSpan) {
        fileNameSpan.textContent = 'No file chosen';
        fileNameSpan.style.color = '';
    }
    
    const previewContainer = document.getElementById(`${type}-photo-preview-container`);
    if (previewContainer) {
        previewContainer.style.display = 'none';
    }

    const clearBtn = document.getElementById(`on-${type}-clear-btn`);
    if (clearBtn) {
        clearBtn.style.display = 'none';
    }

    const statusContainer = document.getElementById(`${type}-photo-status-container`);
    if (statusContainer) {
        statusContainer.style.border = '';
        statusContainer.style.background = '';
        statusContainer.style.padding = '';
        statusContainer.style.borderRadius = '';
    }

    // Reset the upload button
    const btn = document.getElementById(`on-${type}-upload-btn`);
    if (btn) {
        btn.innerHTML = btn.dataset.originalHtml || (type.includes('back') ? 'Upload Back' : 'Upload Front');
        btn.style.background = '';
        btn.style.borderColor = '';
        btn.style.color = '';
        btn.style.fontWeight = '';
        btn.disabled = false;
        btn.onclick = function() { window.triggerFileSelect(type); };
    }
    
    if (currentUser) {
        if (type === 'pan') { currentUser.panPhotoUrl = ''; currentUser.panphotourl = ''; }
        if (type === 'panback') { currentUser.panBackUrl = ''; currentUser.panbackurl = ''; }
        if (type === 'aadhaar') { currentUser.aadhaarPhotoUrl = ''; currentUser.aadhaarphotourl = ''; }
        if (type === 'aadhaarback') { currentUser.aadhaarBackUrl = ''; currentUser.aadhaarbackurl = ''; }
        if (type === 'face') {
            currentUser.facePhotoUrl = ''; currentUser.facephotourl = '';
            const btnCamera = document.getElementById('btn-start-camera');
            if (btnCamera) btnCamera.style.display = 'block';
            
            // Also reset selfie submit button state
            const btnSelfie = document.getElementById('btn-submit-selfie');
            if (btnSelfie) {
                btnSelfie.innerHTML = 'Submit Selfie';
                btnSelfie.style.background = '#D4AF37';
                btnSelfie.style.borderColor = '';
                btnSelfie.style.color = '#000';
                btnSelfie.disabled = false;
                btnSelfie.style.display = 'inline-block';
            }
        }
        if (type === 'dl') { currentUser.dlUrl = ''; currentUser.dlurl = ''; }
        if (type === 'dlback') { currentUser.dlBackUrl = ''; currentUser.dlbackurl = ''; }
        safeSetLocalStorage('marshalUser', JSON.stringify(currentUser));
    }
    if (typeof updateKycButtonsState === 'function') {
        updateKycButtonsState();
    }
};

function compressImageIfNeeded(file) {
    // Only compress image files larger than 250KB
    if (!file.type.startsWith('image/') || file.size <= 250 * 1024) {
        console.log(`[FILE_DEBUG] Skipping compression: type="${file.type}" size=${file.size}`);
        return Promise.resolve(file);
    }

    return new Promise((resolve) => {
        console.log(`[FILE_DEBUG] Compressing image: name="${file.name}" original_size=${file.size}`);
        const reader = new FileReader();
        reader.readAsDataURL(file);
        
        reader.onload = function(event) {
            const img = new Image();
            img.src = event.target.result;
            
            img.onload = function() {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                
                // Keep dimensions within a reasonable HD limit (max 1920px width/height)
                const maxDim = 1920;
                let width = img.width;
                let height = img.height;
                
                if (width > maxDim || height > maxDim) {
                    if (width > height) {
                        height = Math.round((height * maxDim) / width);
                        width = maxDim;
                    } else {
                        width = Math.round((width * maxDim) / height);
                        height = maxDim;
                    }
                }
                
                canvas.width = width;
                canvas.height = height;
                ctx.drawImage(img, 0, 0, width, height);
                
                // Export as compressed JPEG (70% quality)
                canvas.toBlob(function(blob) {
                    if (!blob) {
                        console.warn('[FILE_DEBUG] Canvas export failed, using original file.');
                        resolve(file);
                        return;
                    }
                    
                    // Re-wrap as File object to retain original filename metadata
                    const compressedFile = new File([blob], file.name, {
                        type: 'image/jpeg',
                        lastModified: Date.now()
                    });
                    
                    console.log(`[FILE_DEBUG] Compression complete: new_size=${compressedFile.size} ratio=${((compressedFile.size / file.size) * 100).toFixed(1)}%`);
                    resolve(compressedFile);
                }, 'image/jpeg', 0.7);
            };
            
            img.onerror = function() {
                console.warn('[FILE_DEBUG] Image loading failed, uploading original.');
                resolve(file);
            };
        };
        
        reader.onerror = function() {
            console.warn('[FILE_DEBUG] FileReader failed, uploading original.');
            resolve(file);
        };
    });
}

window.uploadSingleKycFile = async function(type) {
    let file = null;
    let input = null;
    let btn = null;
    const isSlotCamera = ['pan', 'panback', 'aadhaar', 'aadhaarback', 'dl', 'dlback'].includes(type);

    if (type === 'face') {
        input = document.getElementById('on-face-file');
        btn = document.getElementById('btn-submit-selfie');
    } else {
        if (!isSlotCamera) {
            input = document.getElementById(`on-${type}-file`);
        }
        btn = document.getElementById(`on-${type}-upload-btn`);
    }

    let originalFile = null;
    if (isSlotCamera) {
        originalFile = window.capturedKycFiles[type];
    } else {
        if (input && input.files && input.files[0]) {
            originalFile = input.files[0];
        }
    }

    if (!originalFile) {
        showToast('Please select/capture a file first.', 'error');
        return;
    }
    
    // Save original button state if not set
    if (btn && !btn.dataset.originalHtml) {
        btn.dataset.originalHtml = btn.innerHTML;
    }

    if (btn) {
        btn.innerHTML = `Uploading...`;
        btn.disabled = true;
    }

    try {
        file = await compressImageIfNeeded(originalFile);
        const formData = new FormData();
        formData.append('docType', type);
        formData.append('file', file);

        console.log('[FILE_DEBUG] FormData entries:');
        for (let pair of formData.entries()) {
            console.log(`[FILE_DEBUG]   Key: ${pair[0]}, Value type: ${typeof pair[1]}, isFile: ${pair[1] instanceof File}, isBlob: ${pair[1] instanceof Blob}`);
        }
        const fileFromFormData = formData.get('file');
        if (fileFromFormData) {
            console.log('[FILE_DEBUG] File readback detail: name="' + fileFromFormData.name + '" size=' + fileFromFormData.size + ' type="' + fileFromFormData.type + '"');
        }

        const res = await fetch(`${API_URL}/workers/${currentUser.id}/kyc-file`, {
            method: 'POST',
            body: formData
        });

        const resData = await res.json();
        if (!res.ok) throw new Error(resData.error || 'Upload failed');

        // Show preview container
        const previewImg = document.getElementById(`${type}-photo-preview`);
        const previewContainer = document.getElementById(`${type}-photo-preview-container`);
        if (previewImg) previewImg.src = resData.fileUrl || URL.createObjectURL(file);
        if (previewContainer) {
            previewContainer.style.display = 'flex';
            const statusTitle = previewContainer.querySelector('div > div:first-child');
            const statusSub = previewContainer.querySelector('div > div:last-child');
            if (statusTitle) {
                statusTitle.textContent = 'Uploaded Successfully';
                statusTitle.style.color = '#34d399';
            }
            if (statusSub) statusSub.textContent = 'Document is saved on server';
            previewContainer.style.background = 'rgba(16,185,129,0.06)';
            previewContainer.style.borderColor = 'rgba(16,185,129,0.2)';
        }

        // Hide camera preview if face
        if (type === 'face') {
            document.getElementById('photo-preview-container').style.display = 'none';
        }

        // Change button to green checkmark / "Uploaded" state
        if (btn) {
            btn.innerHTML = `Uploaded`;
            btn.style.background = 'rgba(16,185,129,0.2)';
            btn.style.borderColor = '#10b981';
            btn.style.color = '#34d399';
            btn.onclick = null; // Disable clicking it again
            btn.disabled = true;
            if (type === 'face') {
                btn.style.display = 'none'; // hide submit selfie since it's now in preview-container
            }
        }
        
        if (window.checkWizardState) window.checkWizardState();

        showToast('Document uploaded successfully!', 'success');

        // Update local session
        const colMap = {
            'pan': 'panPhotoUrl', 'panback': 'panBackUrl',
            'aadhaar': 'aadhaarPhotoUrl', 'aadhaarback': 'aadhaarBackUrl',
            'face': 'facePhotoUrl', 'dl': 'dlUrl', 'dlback': 'dlBackUrl'
        };
        const sessionKey = colMap[type];
        if (sessionKey) {
            currentUser[sessionKey] = resData.fileUrl;
            // Also update lowercase
            currentUser[sessionKey.toLowerCase()] = resData.fileUrl;
            safeSetLocalStorage('marshalUser', JSON.stringify(currentUser));
        }
        if (typeof updateKycButtonsState === 'function') {
            updateKycButtonsState();
        }

    } catch (e) {
        console.error('[KYC_UPLOAD_ERROR] Complete Exception:', {
            name: e.name,
            message: e.message,
            stack: e.stack,
            keys: Object.getOwnPropertyNames(e)
        });
        console.error('[KYC_UPLOAD_ERROR] JSON Serialized:', JSON.stringify(e, Object.getOwnPropertyNames(e)));
        let msg = e.message;
        showToast('Upload failed: ' + msg, 'error');
        if (btn) {
            btn.innerHTML = 'Retry Upload';
            btn.disabled = false;
        }
    }
};

function populateOnboardingFields() {
    if (!currentUser) return;
    const displayName = (currentUser.name === 'New Driver') ? '' : (currentUser.name || '');
    if (document.getElementById('on-name')) document.getElementById('on-name').value = displayName;
    if (document.getElementById('on-email')) document.getElementById('on-email').value = currentUser.email || '';
    if (document.getElementById('on-city')) document.getElementById('on-city').value = currentUser.city || '';
    if (document.getElementById('on-dob')) document.getElementById('on-dob').value = currentUser.dob || '';
    if (document.getElementById('on-gender')) document.getElementById('on-gender').value = currentUser.gender || '';
    if (document.getElementById('on-pan')) document.getElementById('on-pan').value = currentUser.panNumber || '';
    if (document.getElementById('on-aadhaar')) document.getElementById('on-aadhaar').value = currentUser.aadhaarNumber || '';
    if (document.getElementById('on-dl')) document.getElementById('on-dl').value = currentUser.dlNumber || '';
    const bankRealNameEl = document.getElementById('on-bank-real-name');
    const bankSearchEl = document.getElementById('on-bank-search');
    const bankVal = currentUser.bankName || currentUser.bankname || '';
    if (bankRealNameEl) bankRealNameEl.value = bankVal;
    if (bankSearchEl) bankSearchEl.value = bankVal;
    if (document.getElementById('on-bank-name')) document.getElementById('on-bank-name').value = currentUser.bankAccountName || '';
    if (document.getElementById('on-bank-acc')) document.getElementById('on-bank-acc').value = currentUser.bankAccountNumber || '';
    if (document.getElementById('on-bank-ifsc')) document.getElementById('on-bank-ifsc').value = currentUser.bankIFSC || '';

    // If city is not set, auto-detect silently via GPS
    if (!currentUser.city && typeof window.autoDetectKycLocation === 'function') {
        window.autoDetectKycLocation();
    }

    // Setup file previews
    setupKycPreview('pan', currentUser.panPhotoUrl || currentUser.panphotourl);
    setupKycPreview('panback', currentUser.panBackUrl || currentUser.panbackurl);
    setupKycPreview('aadhaar', currentUser.aadhaarPhotoUrl || currentUser.aadhaarphotourl);
    setupKycPreview('aadhaarback', currentUser.aadhaarBackUrl || currentUser.aadhaarbackurl);
    setupKycPreview('face', currentUser.facePhotoUrl || currentUser.facephotourl);
    setupKycPreview('dl', currentUser.dlUrl || currentUser.dlurl);
    setupKycPreview('dlback', currentUser.dlBackUrl || currentUser.dlbackurl);
    
    // Trigger silent GPS auto-detect for blank fields
    setTimeout(() => {
        if (typeof window.autoDetectKycLocation === 'function') {
            window.autoDetectKycLocation();
        }
    }, 100);
}

function resolveCityFromAddress(addr) {
    if (!addr) return '';
    
    // 1. Resolve raw city/town/village/municipality/city_district
    let detectedCity = addr.city || addr.town || addr.village || addr.municipality || addr.city_district || '';
    
    // 2. Apply Whitelisted Metro Normalization with word boundary protection
    const metroCheck = addr.municipality || addr.city_district || addr.city || '';
    if (metroCheck) {
        const metroMatch = metroCheck.match(/\b(Kolkata|Bengaluru|Mumbai|Chennai|Hyderabad|Delhi|Pune|Ahmedabad)\b/i);
        if (metroMatch) {
            detectedCity = metroMatch[1]; // Override with parent metropolitan city
        }
    }
    
    return detectedCity;
}

window.autoDetectKycLocation = function() {
    const cityEl = document.getElementById('on-city');
    if (!cityEl) return;
    if (cityEl.value.trim()) return;

    const startTime = new Date().toISOString();
    console.log(`[GPS_TIMING] [${startTime}] autoDetectKycLocation() triggered at KYC flow initialization.`);

    cityEl.placeholder = 'Detecting current city...';

    if (!navigator.geolocation) {
        console.log(`[GPS_TIMING] [${new Date().toISOString()}] Geolocation unsupported.`);
        cityEl.placeholder = 'Tap edit icon to select city';
        showToast("Couldn't auto-detect your city — tap the edit icon to select it", 'info');
        return;
    }

    navigator.geolocation.getCurrentPosition(async (position) => {
        const fixTime = new Date().toISOString();
        const lat = position.coords.latitude;
        const lon = position.coords.longitude;
        console.log(`[GPS_TIMING] [${fixTime}] GPS fix acquired: (${lat.toFixed(4)}, ${lon.toFixed(4)}). Starting reverse geocode...`);
        try {
            const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`);
            if (!response.ok) throw new Error('Reverse geocoding response not ok');
            const data = await response.json();
            const addr = data.address || {};
            
            const detectedCity = resolveCityFromAddress(addr);
            const resolveTime = new Date().toISOString();
            console.log(`[GPS_TIMING] [${resolveTime}] Reverse geocode complete. Detected City: "${detectedCity}" (auto-filling #on-city).`);

            if (detectedCity) {
                cityEl.value = detectedCity;
                cityEl.placeholder = 'Operating City';
                cityEl.dispatchEvent(new Event('input'));
            } else {
                cityEl.placeholder = 'Tap edit icon to select city';
                showToast("Couldn't auto-detect your city — tap the edit icon to select it", 'info');
            }
            updateKycButtonsState();
        } catch (err) {
            console.error(`[GPS_TIMING] [${new Date().toISOString()}] Error reverse geocoding:`, err);
            cityEl.placeholder = 'Tap edit icon to select city';
            showToast("Couldn't auto-detect your city — tap the edit icon to select it", 'info');
        }
    }, (err) => {
        console.error(`[GPS_TIMING] [${new Date().toISOString()}] Geolocation error:`, err.message || err);
        cityEl.placeholder = 'Tap edit icon to select city';
        showToast("Couldn't auto-detect your city — tap the edit icon to select it", 'info');
    }, {
        enableHighAccuracy: true,
        timeout: 6000,
        maximumAge: 0
    });
};

window.focusAndEditField = function(id) {
    const el = document.getElementById(id);
    if (el) {
        el.focus();
        if (el.setSelectionRange) {
            const len = el.value.length;
            el.setSelectionRange(len, len);
        }
        if (id === 'on-city') {
            if (typeof window.showCityDropdownManual === 'function') {
                window.showCityDropdownManual();
            }
        }
    }
};

function initAddressDropdowns() {
    const stateInput = document.getElementById('on-state');
    const cityInput = document.getElementById('on-city');
    const pinInput = document.getElementById('on-pincode');
    
    if (!cityInput) {
        setTimeout(initAddressDropdowns, 100);
        return;
    }
    
    const stateDropdown = document.getElementById('state-dropdown');
    const cityDropdown = document.getElementById('city-dropdown');
    const pinDropdown = document.getElementById('pincode-dropdown');
    
    const showDropdown = (el, items, inputEl, callback) => {
        if (!el) return;
        el.innerHTML = '';
        if (items.length === 0) {
            el.classList.add('hidden');
            return;
        }
        items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'search-dropdown-item';
            div.textContent = item;
            div.addEventListener('click', () => {
                inputEl.value = item;
                inputEl.dispatchEvent(new Event('input'));
                inputEl.dispatchEvent(new Event('change'));
                el.classList.add('hidden');
                if (callback) callback(item);
            });
            el.appendChild(div);
        });
        el.classList.remove('hidden');
    };
    
    // --- City Logic (Dynamic Search-as-you-type) ---
    const handleCityFilter = (forceShow = false) => {
        if (!cityDropdown) return;
        const query = cityInput.value.trim().toLowerCase();
        let cities = Array.from(new Set(Object.values(INDIAN_LOCATIONS).flatMap(obj => Object.keys(obj))));
        const filtered = query ? cities.filter(c => c.toLowerCase().includes(query)) : cities.slice(0, 10);
        if (forceShow || (document.activeElement === cityInput && query.length > 0)) {
            showDropdown(cityDropdown, filtered, cityInput, (selectedCity) => {
                const foundState = Object.keys(INDIAN_LOCATIONS).find(s => INDIAN_LOCATIONS[s][selectedCity]);
                if (foundState && stateInput) stateInput.value = foundState;
            });
        } else {
            cityDropdown.classList.add('hidden');
        }
    };

    window.showCityDropdownManual = function() {
        handleCityFilter(true);
    };

    cityInput.addEventListener('input', () => handleCityFilter(false));
    
    // Dismiss dropdowns when clicking outside
    document.addEventListener('click', (e) => {
        if (stateInput && stateDropdown && e.target !== stateInput && !stateDropdown.contains(e.target)) stateDropdown.classList.add('hidden');
        if (cityInput && cityDropdown && e.target !== cityInput && !cityDropdown.contains(e.target) && !e.target.closest('[onclick*="on-city"]')) cityDropdown.classList.add('hidden');
    });
}

window.useCurrentLocation = async function() {
    if (!navigator.geolocation) {
        showToast('Geolocation is not supported by your browser', 'error');
        return;
    }
    
    showToast('Fetching current location...', 'info');
    
    navigator.geolocation.getCurrentPosition(async (position) => {
        const lat = position.coords.latitude;
        const lon = position.coords.longitude;
        
        try {
            const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`);
            if (!response.ok) throw new Error('Reverse geocoding failed');
            const data = await response.json();
            
            const addr = data.address || {};
            const city = resolveCityFromAddress(addr);
            const street = addr.road || addr.suburb || addr.neighbourhood || addr.residential || '';
            
            if (street) document.getElementById('on-address').value = street;
            if (city) document.getElementById('on-city').value = city;
            
            showToast('Address filled successfully!', 'success');
        } catch (err) {
            console.error('Error reverse geocoding:', err);
            showToast('Failed to retrieve address details. Please fill manually.', 'error');
        }
    }, (err) => {
        console.error('Geolocation error:', err);
        showToast('Failed to get location. Please check GPS permissions.', 'error');
    }, {
        enableHighAccuracy: true,
        timeout: 5000,
        maximumAge: 0
    });
};

async function submitOnboarding() {
    const name = document.getElementById('on-name') ? document.getElementById('on-name').value.trim() : (currentUser.name || '');
    const email = document.getElementById('on-email') ? document.getElementById('on-email').value.trim() : (currentUser.email || '');
    const city = document.getElementById('on-city') ? document.getElementById('on-city').value.trim() : (currentUser.city || '');
    const dob = document.getElementById('on-dob') ? document.getElementById('on-dob').value.trim() : (currentUser.dob || '');
    const gender = document.getElementById('on-gender') ? document.getElementById('on-gender').value.trim() : (currentUser.gender || '');
    const address = currentUser.address || '';
    const state = currentUser.state || '';
    const pincode = currentUser.pincode || '';
    const panNumber = document.getElementById('on-pan') ? document.getElementById('on-pan').value.trim().toUpperCase() : (currentUser.panNumber || '');
    const aadhaarRaw = document.getElementById('on-aadhaar') ? document.getElementById('on-aadhaar').value : (currentUser.aadhaarNumber || '');
    const aadhaarNumber = aadhaarRaw.replace(/\D/g, ''); // strip spaces → 12 digits
    const dlNumber = document.getElementById('on-dl') ? document.getElementById('on-dl').value.trim().toUpperCase() : (currentUser.dlNumber || '');
    
    const panFile = window.capturedKycFiles['pan'];
    const panBackFile = window.capturedKycFiles['panback'];
    const aadhaarFile = window.capturedKycFiles['aadhaar'];
    const aadhaarBackFile = window.capturedKycFiles['aadhaarback'];
    const faceFile = document.getElementById('on-face-file') ? document.getElementById('on-face-file').files[0] : null;
    const dlFile = window.capturedKycFiles['dl'];
    const dlBackFile = window.capturedKycFiles['dlback'];

    const bankRealName = document.getElementById('on-bank-real-name') ? document.getElementById('on-bank-real-name').value.trim() : '';
    const bankName = document.getElementById('on-bank-name') ? document.getElementById('on-bank-name').value.trim() : '';
    const bankAcc = document.getElementById('on-bank-acc') ? document.getElementById('on-bank-acc').value.trim() : '';
    const bankIfsc = document.getElementById('on-bank-ifsc') ? document.getElementById('on-bank-ifsc').value.trim().toUpperCase() : '';

    // ── Validate all fields using the step validators ─────────────────
    if (!validateStep1() || !validateStep2() || !window.validateConfirmSubstep(false)) {
        showToast('Please verify all required profile and document fields before submitting.', 'error');
        setTimeout(() => {
            const firstErr = document.querySelector('.kyc-error-blink');
            if (firstErr) {
                firstErr.scrollIntoView({ behavior: 'smooth', block: 'center' });
                if (firstErr.focus) firstErr.focus();
            }
        }, 100);
        return;
    }
    
    const btn = document.getElementById('btn-submit-kyc');
    if (btn) {
        btn.innerHTML = 'Uploading Securely...';
        btn.disabled = true;
    }

    try {
        const formData = new FormData();
        formData.append('name', name);
        formData.append('email', email);
        formData.append('city', city);
        formData.append('dob', dob);
        formData.append('gender', gender);
        formData.append('dlNumber', dlNumber);
        const vTypes = (Array.isArray(window.selectedVehicleTypes) && window.selectedVehicleTypes.length > 0) ? window.selectedVehicleTypes : ['bike'];
        formData.append('vehicleTypes', vTypes.join(','));
        formData.append('vehicleType', vTypes[0]);
        formData.append('kycStatus', 'Pending Approval');
        
        const idType = window.selectedKycIdType || (panNumber && !aadhaarNumber ? 'pan' : 'aadhaar');
        if (idType === 'pan') {
            formData.append('panNumber', panNumber);
            if (panFile) formData.append('panFile', panFile);
            if (panBackFile) formData.append('panBackFile', panBackFile);
        } else {
            formData.append('aadhaarNumber', aadhaarNumber);
            if (aadhaarFile) formData.append('aadhaarFile', aadhaarFile);
            if (aadhaarBackFile) formData.append('aadhaarBackFile', aadhaarBackFile);
        }

        if (faceFile) formData.append('faceFile', await compressImageIfNeeded(faceFile));
        if (dlFile) formData.append('dlFile', dlFile);
        if (dlBackFile) formData.append('dlBackFile', dlBackFile);

        console.log('[KYC_SUBMIT] Submitting KYC payload (Decoupled from Bank, Chosen ID:', idType, '):', {
            name, email, city, dob, gender, panNumber: idType === 'pan' ? panNumber : null, aadhaarNumber: idType === 'aadhaar' ? aadhaarNumber : null, dlNumber
        });


        const res = await fetch(`${API_URL}/workers/${currentUser.id}/kyc`, {
            method: 'PUT',
            body: formData
        });

        const resData = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(resData.error || 'Document Upload failed');

        if (typeof window.clearKycDraft === 'function') {
            await window.clearKycDraft();
        }

        showToast('KYC Documents submitted successfully! They will now be reviewed for approval.', 'success');

        // Update local session
        currentUser.name = name;
        currentUser.email = email;
        currentUser.city = city;
        currentUser.dob = dob;
        currentUser.gender = gender;
        currentUser.panNumber = panNumber;
        currentUser.aadhaarNumber = aadhaarNumber;
        currentUser.dlNumber = dlNumber;
        currentUser.kycStatus = 'Pending Approval';
        // Set temp urls to local storage previews if they were uploaded
        if (panFile) currentUser.panPhotoUrl = URL.createObjectURL(panFile);
        if (panBackFile) currentUser.panBackUrl = URL.createObjectURL(panBackFile);
        if (aadhaarFile) currentUser.aadhaarPhotoUrl = URL.createObjectURL(aadhaarFile);
        if (aadhaarBackFile) currentUser.aadhaarBackUrl = URL.createObjectURL(aadhaarBackFile);
        if (faceFile) currentUser.facePhotoUrl = URL.createObjectURL(faceFile);
        if (dlFile) currentUser.dlUrl = URL.createObjectURL(dlFile);
        if (dlBackFile) currentUser.dlBackUrl = URL.createObjectURL(dlBackFile);
        safeSetLocalStorage('marshalUser', JSON.stringify(currentUser));

        checkOnboarding();
        updateStatusDisplay();
    } catch (err) {
        console.error('[KYC_SUBMIT_ERROR]', err);
        showToast('Submission failed: ' + err.message, 'error');
    } finally {
        if (btn) {
            btn.innerHTML = 'Submit for Approval';
            btn.disabled = false;
        }
    }
}

window.marshalTabHistory = ['trips'];
window.isBackNavigating = false;

// Initial state replace to track first tab
if (!history.state) {
    try {
        history.replaceState({ tab: 'trips' }, '', '#trips');
    } catch(e) {
        console.warn('replaceState failed', e);
    }
}

function switchTab(tab) {
    if (!window.isBackNavigating) {
        if (!window.marshalTabHistory) {
            window.marshalTabHistory = ['trips'];
        }
        if (window.marshalTabHistory[window.marshalTabHistory.length - 1] !== tab) {
            window.marshalTabHistory.push(tab);
            try {
                history.pushState({ tab: tab }, '', '#' + tab);
            } catch(e) {
                console.warn('pushState failed', e);
            }
        }
    }
    // Removed saving of active tab to prevent invalid launch states
    document.querySelectorAll('.tab-panel').forEach(p => {
        p.classList.remove('active');
        p.style.display = 'none'; // Ensure inline style from old CSS doesn't conflict
    });
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.bottom-nav .nav-item').forEach(b => b.classList.remove('active'));

    const tabEl = document.getElementById(`tab-${tab}`);
    if (tabEl) {
        tabEl.classList.add('active');
        tabEl.style.display = 'block';
    }

    // Handle top tabs (hidden now)
    const topBtn = document.querySelector(`.tab-btn[onclick*="${tab}"]`);
    if (topBtn) topBtn.classList.add('active');

    const bottomNavBtn = document.querySelector(`.bottom-nav .nav-item[onclick*="${tab}"]`);
    if (bottomNavBtn) bottomNavBtn.classList.add('active');

    // Handle new Tailwind Bottom Nav
    document.querySelectorAll('nav.fixed.bottom-0 button').forEach(btn => {
        btn.classList.remove('text-primary-container', 'font-bold');
        btn.classList.add('text-on-surface-variant');
    });
    const newBottomBtn = document.querySelector(`nav.fixed.bottom-0 button[onclick*="${tab}"]`);
    if (newBottomBtn) {
        newBottomBtn.classList.remove('text-on-surface-variant');
        newBottomBtn.classList.add('text-primary-container', 'font-bold');
    }

    // Location tracking persists during active trip across tab switches; stopLocationTracking() is called on trip completion/handover.
    if (tab !== 'trips') {
        if (typeof stopRideRequestRingtone === 'function') stopRideRequestRingtone();
    }
    if (tab === 'trips' || tab === 'tasks') {
        startPickupPolling();
        loadMyTrips();
    }
    if (tab === 'trips') {
        // Inject active trip banner at the top of the home tab if marshal has an active trip
        loadActiveTripBanner();
    }
    if (tab === 'profile') {
        updateStatusDisplay();
    }
    lucide.createIcons();
}

async function loadActiveTripBanner() {
    const section = document.getElementById('tab-trips');
    if (!section) return;
    // Remove old banner if exists
    const old = document.getElementById('active-trip-home-banner');
    if (old) old.remove();
    if (!currentUser) return;
    try {
        const [allTrips, allRequests] = await Promise.all([
            fetch(`${API_URL}/trips`, { cache: 'no-store' }).then(r => r.json()),
            fetch(`${API_URL}/requests`, { cache: 'no-store' }).then(r => r.json())
        ]);
        const activeTripStatuses = ['pending_payment','assigned','pending_otp_1','in_transit','at_garage','in_service','out_for_delivery','pending_delivery'];
        const myActiveTrip = allTrips.find(t => {
            if (!(((t.marshalId || t.marshalid) === currentUser.id || (t.deliveryMarshalId || t.deliverymarshalid) === currentUser.id) && activeTripStatuses.includes(t.status))) {
                return false;
            }
            const req = allRequests.find(r => r.id === (t.serviceRequestId || t.servicerequestid));
            if (req && ['cancelled', 'returned', 'completed', 'drop_completed'].includes(req.status)) {
                return false;
            }
            return true;
        });
        if (!myActiveTrip) return;
        const statusLabels = {
            assigned: 'Head to Pickup',
            pending_otp_1: 'Awaiting Pickup OTP',
            in_transit: 'In Transit',
            at_garage: 'At Garage',
            in_service: 'Vehicle in Service',
            out_for_delivery: 'Out for Delivery',
            pending_delivery: 'Awaiting Delivery OTP'
        };
        const sLabel = statusLabels[myActiveTrip.status] || myActiveTrip.status.replace(/_/g,' ');
        const banner = document.createElement('div');
        banner.id = 'active-trip-home-banner';
        banner.style.cssText = 'position:sticky; top:64px; z-index:50; margin:0; padding:12px 16px;';
        banner.innerHTML = `
            <div onclick="window.openMapView('${myActiveTrip.id}')" style="cursor:pointer; background:linear-gradient(90deg,#F59E0B,#f59e0b); border-radius:14px; padding:14px 16px; display:flex; align-items:center; gap:12px; box-shadow:0 4px 20px rgba(245, 158, 11,0.3);">
                <span style="font-size:1.3rem; display:inline-flex; align-items:center;">${HECTOR_SMALL_SVG}</span>
                <div style="flex:1;">
                    <div style="font-size:0.65rem; color:#78350f; font-weight:700; text-transform:uppercase; letter-spacing:0.5px;">Active Trip — ${sLabel}</div>
                    <div style="font-size:0.9rem; font-weight:800; color:#1c1917;">Trip #${myActiveTrip.id.slice(-8)} · Tap to manage</div>
                </div>
                <span style="font-size:1.2rem; color:#78350f;">→</span>
            </div>`;
        // Insert after the sticky header (first child of section's main)
        const main = section.querySelector('main');
        if (main) main.insertBefore(banner, main.firstChild);
    } catch(e) {}
}

// ── Real-time pickup feed polling ──────────────────────────────────────────
let pickupPollTimer = null;

function startPickupPolling() {
    if (pickupPollTimer) return; // already running
    loadAvailablePickups();
    pickupPollTimer = setInterval(loadAvailablePickups, 5000); // refresh every 5s
}

function stopPickupPolling() {
    if (pickupPollTimer) { clearInterval(pickupPollTimer); pickupPollTimer = null; }
}

function calcDistanceKm(lat1, lng1, lat2, lng2) {
    if (!lat1 || !lng1 || !lat2 || !lng2) return null;
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── High Demand Recommended Pincodes Widget (2h Rolling Piggybacked) ────────
let lastDemandFetchTime = 0;

async function fetchRecommendedPincodes(force = false) {
    const now = Date.now();
    if (!force && (now - lastDemandFetchTime < 30000)) {
        return; // Throttled to 30s (runs once every 6 ticks of the 5s pickupPollTimer)
    }
    lastDemandFetchTime = now;

    try {
        const userCity = (currentUser && (currentUser.city || currentUser.service_city || currentUser.serviceCity)) ? (currentUser.city || currentUser.service_city || currentUser.serviceCity) : 'Kolkata';
        const queryParams = [`city=${encodeURIComponent(userCity)}`, 'limit=4'];
        
        let queryLat = marshalLat;
        let queryLng = marshalLng;
        if (queryLat === null || queryLng === null) {
            const defLoc = getDefaultCityLocation();
            queryLat = defLoc.lat;
            queryLng = defLoc.lng;
        }
        queryParams.push(`lat=${queryLat}`, `lng=${queryLng}`);
        
        console.log('[DEMAND_WIDGET_FETCH]', { city: userCity, queryLat, queryLng, marshalLat, marshalLng });
        const res = await fetch(`${API_URL}/demand/recommended-pincodes?${queryParams.join('&')}`, { cache: 'no-store' });
        if (res.ok) {
            const data = await res.json();
            if (data && Array.isArray(data.recommendedPincodes)) {
                renderHighDemandWidget(data.recommendedPincodes);
            }
        }
    } catch (e) {
        console.warn('Failed to fetch recommended demand pincodes:', e);
    }
}


function renderHighDemandWidget(pincodes) {
    const widget = document.getElementById('high-demand-pincode-widget');
    const list = document.getElementById('high-demand-pincode-list');
    if (!widget || !list) return;

    if (!pincodes || pincodes.length === 0) {
        widget.style.display = 'none';
        return;
    }

    widget.style.display = 'block';
    list.innerHTML = pincodes.map((item) => {
        const isSurge = item.demandLevel === 'Surge';
        const badgeColor = isSurge ? '#EF4444' : '#F59E0B';
        const badgeBg = isSurge ? 'rgba(239, 68, 68, 0.15)' : 'rgba(245, 158, 11, 0.15)';
        const badgeBorder = isSurge ? 'rgba(239, 68, 68, 0.3)' : 'rgba(245, 158, 11, 0.3)';

        const distText = (item.distanceKm !== null && item.distanceKm !== undefined) 
            ? `<span style="font-size:0.75rem; color:#A1A1AA; display:flex; align-items:center; gap:2px;"><span class="material-symbols-outlined" style="font-size:14px; color:#F59E0B;">near_me</span>${item.distanceKm} km ${item.direction || ''}</span>`
            : '';

        return `
            <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); padding:10px 12px; border-radius:12px;">
                <div style="flex:1; min-width:0;">
                    <div style="display:flex; align-items:center; gap:6px;">
                        <span style="font-size:0.85rem; font-weight:800; color:#FFFFFF;">${item.pincode}</span>
                        <span style="font-size:0.75rem; color:#D4D4D8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">· ${item.areaName}</span>
                    </div>
                    <div style="display:flex; align-items:center; gap:8px; margin-top:4px; font-size:0.7rem; color:#A1A1AA;">
                        <span><strong style="color:#FFF;">${item.searchCount}</strong> searches</span>
                        <span>•</span>
                        <span><strong style="color:#F59E0B;">${item.bookingCount}</strong> rides</span>
                    </div>
                </div>
                <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px; margin-left:10px;">
                    <span style="background:${badgeBg}; color:${badgeColor}; border:1px solid ${badgeBorder}; font-size:0.7rem; font-weight:800; padding:2px 8px; border-radius:6px;">
                        ${item.demandScore} pts
                    </span>
                    ${distText}
                </div>
            </div>
        `;
    }).join('');
}

window.activeHomeBookingType = 'instant';
window.switchHomeBookingType = function(type) {
    window.activeHomeBookingType = type;
    
    const btnInstant = document.getElementById('btn-home-instant');
    const btnScheduled = document.getElementById('btn-home-scheduled');
    
    if (btnInstant && btnScheduled) {
        if (type === 'instant') {
            btnInstant.className = 'flex-1 py-3 px-2 rounded-lg font-label-md text-label-md bg-primary-container text-on-primary-container border-none transition-all';
            btnScheduled.className = 'flex-1 py-3 px-2 rounded-lg font-label-md text-label-md bg-transparent border-none text-on-surface-variant hover:bg-surface-container-high transition-colors';
        } else {
            btnInstant.className = 'flex-1 py-3 px-2 rounded-lg font-label-md text-label-md bg-transparent border-none text-on-surface-variant hover:bg-surface-container-high transition-colors';
            btnScheduled.className = 'flex-1 py-3 px-2 rounded-lg font-label-md text-label-md bg-primary-container text-on-primary-container border-none transition-all';
        }
    }
    
    loadAvailablePickups();
};

window.activeTasksFilter = 'todo';
window.switchTasksFilter = function(filter) {
    window.activeTasksFilter = filter;
    
    const btnTodo = document.getElementById('btn-tasks-todo');
    const btnInProgress = document.getElementById('btn-tasks-inprogress');
    const btnCompleted = document.getElementById('btn-tasks-completed');
    
    if (btnTodo && btnInProgress && btnCompleted) {
        if (filter === 'todo') {
            btnTodo.className = 'flex-1 py-3 px-2 rounded-lg font-label-md text-label-md bg-primary-container text-on-primary-container border-none transition-all';
            btnInProgress.className = 'flex-1 py-3 px-2 rounded-lg font-label-md text-label-md bg-transparent border-none text-on-surface-variant hover:bg-surface-container-high transition-colors';
            btnCompleted.className = 'flex-1 py-3 px-2 rounded-lg font-label-md text-label-md bg-transparent border-none text-on-surface-variant hover:bg-surface-container-high transition-colors';
        } else if (filter === 'inprogress') {
            btnTodo.className = 'flex-1 py-3 px-2 rounded-lg font-label-md text-label-md bg-transparent border-none text-on-surface-variant hover:bg-surface-container-high transition-colors';
            btnInProgress.className = 'flex-1 py-3 px-2 rounded-lg font-label-md text-label-md bg-primary-container text-on-primary-container border-none transition-all';
            btnCompleted.className = 'flex-1 py-3 px-2 rounded-lg font-label-md text-label-md bg-transparent border-none text-on-surface-variant hover:bg-surface-container-high transition-colors';
        } else if (filter === 'completed') {
            btnTodo.className = 'flex-1 py-3 px-2 rounded-lg font-label-md text-label-md bg-transparent border-none text-on-surface-variant hover:bg-surface-container-high transition-colors';
            btnInProgress.className = 'flex-1 py-3 px-2 rounded-lg font-label-md text-label-md bg-transparent border-none text-on-surface-variant hover:bg-surface-container-high transition-colors';
            btnCompleted.className = 'flex-1 py-3 px-2 rounded-lg font-label-md text-label-md bg-primary-container text-on-primary-container border-none transition-all';
        }
    }
    
    loadMyTrips();
};

async function loadAvailablePickups() {
    // Refresh native session sync on UI poll
    if (typeof syncAuthSessionToNative === 'function') syncAuthSessionToNative(0);

    // Piggyback demand widget refresh on existing poll cycle (throttled to 30s)
    fetchRecommendedPincodes();

    const list = document.getElementById('available-pickups-list');


    // Use real GPS if available, otherwise skip distance calculation
    const hasGps = marshalLat !== null && marshalLng !== null;

    if (!currentUser || !isKycApproved(currentUser)) {
        stopPickupPolling();
        list.innerHTML = `<div class="p-10 text-center bg-surface-container-lowest border border-outline-variant rounded-xl shadow-sm">
            <span class="material-symbols-outlined text-4xl text-warning mb-2">lock</span>
            <p class="text-sm font-bold text-on-surface">Action Locked</p>
            <p class="text-xs text-on-surface-variant mt-1">You cannot receive pickups until your KYC is Approved.</p>
        </div>`;
        return;
    }

    if (window.marshalIsOffline) {
        stopPickupPolling();
        stopRideRequestRingtone();
        list.innerHTML = `<div class="p-10 text-center bg-surface-container-lowest border border-outline-variant rounded-xl shadow-sm">
            <span class="material-symbols-outlined text-4xl text-on-surface-variant mb-2">cloud_off</span>
            <p class="text-sm font-bold text-on-surface">You are Offline</p>
            <p class="text-xs text-on-surface-variant mt-1">Go ONLINE to receive pickup requests.</p>
        </div>`;
        return;
    }

    const refreshBtn = document.getElementById('refresh-feed-btn');
    if (refreshBtn) refreshBtn.style.display = 'block';

    try {
        const queryParams = [];
        if (hasGps) {
            queryParams.push(`lat=${marshalLat}`);
            queryParams.push(`lng=${marshalLng}`);
        }
        if (currentUser && currentUser.id) {
            queryParams.push(`marshalId=${currentUser.id}`);
        }
        const queryString = queryParams.length > 0 ? `?${queryParams.join('&')}` : '';
        const res = await fetch(`${API_URL}/marshals/available-pickups${queryString}`, { cache: 'no-store' });
        const rawData = await res.json();

        // Check for new incoming instant pickup request to show the 10-second popup modal
        if (Array.isArray(rawData)) {
            const instantPickups = rawData.filter(p => p.status !== 'scheduled' && !(p.workerId || p.workerid));
            if (instantPickups.length > 0) {
                const latest = instantPickups[0];
                const declinedSet = getDeclinedPickupIds();
                const bidSet = getBidPickupIds();
                if (!declinedSet.has(latest.id) && !bidSet.has(latest.id)) {
                    showIncomingPickupModal(latest);
                }
            }
        }

        // ── ORDER CYCLE ENFORCEMENT ──────────────────────────────────────────
        // Check if this marshal already has an active trip. If so, block the feed.
        let activeTripData = { isBusy: false };
        try {
            const activeTripRes = await fetch(`${API_URL}/marshals/${currentUser.id}/active-trip`, { cache: 'no-store' });
            if (activeTripRes.ok) {
                activeTripData = await activeTripRes.json();
            }
        } catch (e) {
            console.warn('[ACTIVE_TRIP_CHECK_WARN]', e.message);
        }
        
        if (activeTripData && activeTripData.isBusy) {

            const myActiveTrip = { status: activeTripData.status, id: activeTripData.tripId };
            const statusLabels = {
                assigned: 'Assigned — Head to pickup',
                pending_otp_1: 'Awaiting Pickup OTP from Customer',
                in_transit: 'In Transit — Vehicle picked up',
                at_garage: 'Vehicle at Garage',
                in_service: 'Vehicle in Service',
                out_for_delivery: 'Out for Delivery',
                pending_delivery: 'Awaiting Delivery OTP'
            };
            const sLabel = statusLabels[myActiveTrip.status] || myActiveTrip.status.replace(/_/g,' ');
            const countEl = document.getElementById('pickups-count-text');
            if (countEl) countEl.textContent = 'Complete your active trip to receive new requests';
            list.innerHTML = `
            <div style="background:linear-gradient(135deg,rgba(245, 158, 11,0.08),rgba(245, 158, 11,0.03)); border:1px solid rgba(245, 158, 11,0.25); border-radius:16px; padding:20px; display:flex; flex-direction:column; gap:14px;">
                <div style="display:flex; align-items:center; gap:10px;">
                    <span style="font-size:1.4rem; display:inline-flex; align-items:center;">${HECTOR_SMALL_SVG}</span>
                    <div>
                        <div style="font-size:0.65rem; color:#F59E0B; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:2px;">Active Trip In Progress</div>
                        <div style="font-size:0.95rem; font-weight:800; color:#fff;">Trip #${myActiveTrip.id.slice(-8)}</div>
                    </div>
                    <div style="margin-left:auto; background:rgba(245, 158, 11,0.12); border:1px solid rgba(245, 158, 11,0.3); padding:4px 10px; border-radius:20px; font-size:0.65rem; font-weight:700; color:#F59E0B; white-space:nowrap;">${sLabel}</div>
                </div>
                <p style="font-size:0.8rem; color:#a1a1aa; line-height:1.5; margin:0;">You cannot accept new pickup requests while you have an active trip. Complete or hand off your current trip to receive new jobs.</p>
                <button onclick="window.openMapView('${myActiveTrip.id}')" style="width:100%; padding:12px; background:#F59E0B; color:#0b0e14; border:none; border-radius:12px; font-weight:800; font-size:0.9rem; cursor:pointer;">Go to Active Trip →</button>
            </div>`;
            window.loadedAvailablePickups = [];
            stopRideRequestRingtone();
            return;
        }
        // ────────────────────────────────────────────────────────────────────

        if (!Array.isArray(rawData) || rawData.length === 0) {
            list.innerHTML = `<div class="empty-state p-10 text-center text-on-surface-variant border border-outline-variant rounded-xl border-dashed"><p class="text-sm">No pickups available right now.</p><p class="text-xs mt-1 opacity-60">Checking every 5 seconds...</p></div>`;
            const countEl = document.getElementById('pickups-count-text');
            if (countEl) countEl.textContent = 'No active requests in your zone';
            // Clear local cache if empty
            window.loadedAvailablePickups = [];
            stopRideRequestRingtone();
            return;
        }


        // Normalize all possible column name cases (PostgreSQL lowercases everything)
        const data = rawData.map(p => {
            const subType  = p.vehicleSubType  || p.vehiclesubtype  || p.vehicle_sub_type || '';
            const make     = p.vehicleMake     || p.vehiclemake     || p.vehicle_make     || '';
            const model    = p.vehicleModel    || p.vehiclemodel    || p.vehicle_model    || '';
            const fullName = p.vehicleFullName || p.vehiclefullname ||
                             (make && model ? (make + ' ' + model).trim() : '') ||
                             (make || model || '');
            const plate    = p.vehicleRegNumber|| p.vehicleregnumber|| p.plate            || '';
            const photo    = p.vehiclePhoto    || p.vehiclephoto    || p.vehicle_photo    || null;
            const pLat     = parseFloat(p.pickupLat || p.pickuplat || 0);
            const pLng     = parseFloat(p.pickupLng || p.pickuplng || 0);

            // Calculate distance only if marshal GPS is available AND pickup has coordinates
            let distStr = 'Location not set';
            if (hasGps && pLat !== 0 && pLng !== 0) {
                const distKm = calcDistanceKm(marshalLat, marshalLng, pLat, pLng);
                distStr = distKm !== null ? distKm.toFixed(1) + ' km away' : 'Nearby';
            } else if (!hasGps && pLat !== 0 && pLng !== 0) {
                distStr = 'Enable GPS';
            }

            // Vehicle sub-type badge colour
            const typeColors = { SUV:'#8B5CF6', Hatchback:'#3B82F6', Sedan:'#10B981', Bike:'#F59E0B' };
            const typeColor = typeColors[subType] || '#6B7280';

            // Car image — use stored photo or type-based fallback
            let imgSrc = '';
            if (photo) {
                imgSrc = photo.startsWith('data:') ? photo : (API_URL.replace('/api','') + '/' + photo);
            } else {
                const lowerType = (subType || '').toLowerCase();
                if (lowerType.includes('bike') || lowerType.includes('motorcycle')) imgSrc = 'images/bike.png';
                else if (lowerType.includes('suv'))       imgSrc = 'images/suv.png';
                else if (lowerType.includes('hatchback')) imgSrc = 'images/hatchback.png';
                else                                      imgSrc = 'images/sedan.png';
            }

            return { id: p.id,
                  fullName: fullName || null,
                  subType, plate, photo: imgSrc, distStr, typeColor,
                  hasLocation: pLat !== 0 && pLng !== 0,
                  fuel: p.fuel || p.vehicleFuel || p.vehiclefuel,
                  transmission: p.transmission || p.vehicleTransmission || p.vehicletransmission,
                  pickupAddress: p.pickupAddress || p.pickup_address || p.pickupaddress || '',
                  dropAddress: p.dropAddress || p.drop_address || p.dropaddress || '',
                  serviceType: p.serviceType || p.servicetype || 'Vehicle Service',
                  pickupDropType: p.pickupDropType || p.pickupdroptype || 'Home Pickup',
                  vehicleCondition: p.vehicleCondition || p.vehicle_condition || p.vehiclecondition || 'Working',
                  status: p.status || '',
                  pickupDate: p.pickupDate || p.pickupdate || '',
                  pickupTime: p.pickupTime || p.pickuptime || '' };
        });

        // Cache available pickups globally for lookup in acceptPickup
        window.loadedAvailablePickups = data;

        // Filter by active booking type sub-tab
        const declinedSet = getDeclinedPickupIds();
        const filteredData = data.filter(p => {
            if (declinedSet.has(p.id)) return false;
            const isScheduled = p.status === 'scheduled';
            if (window.activeHomeBookingType === 'scheduled') {
                return isScheduled;
            } else {
                return !isScheduled;
            }
        });

        // Update the dynamic count subtitle
        const countEl = document.getElementById('pickups-count-text');
        if (countEl) {
            countEl.textContent = `${filteredData.length} active ${window.activeHomeBookingType === 'scheduled' ? 'scheduled' : 'instant'} ${filteredData.length === 1 ? 'request' : 'requests'} in your zone`;
        }

        if (filteredData.length === 0) {
            if (!window.currentIncomingPickup) stopRideRequestRingtone();
            list.innerHTML = `<div class="empty-state p-10 text-center text-on-surface-variant border border-outline-variant rounded-xl border-dashed"><p class="text-sm">No ${window.activeHomeBookingType === 'scheduled' ? 'scheduled' : 'instant'} pickups available right now.</p><p class="text-xs mt-1 opacity-60">Checking every 5 seconds...</p></div>`;
            return;
        }

        list.innerHTML = filteredData.map(p => {
            const typeBadgeHtml = p.subType
                ? `<span style="font-family:'Inter',sans-serif; font-size:0.65rem; font-weight:700; padding:2px 6px; border-radius:4px; background:${p.typeColor}22; border:1px solid ${p.typeColor}44; color:${p.typeColor}; text-transform:uppercase;">${p.subType}</span>`
                : '';

            const fuelBadge = p.fuel
                ? `<span style="font-family:'Inter',sans-serif; font-size:0.65rem; font-weight:700; padding:2px 6px; border-radius:4px; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2); color:#fff; text-transform:uppercase;">${p.fuel}</span>`
                : '';
            
            const transmissionBadge = p.transmission
                ? `<span style="font-family:'Inter',sans-serif; font-size:0.65rem; font-weight:700; padding:2px 6px; border-radius:4px; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2); color:#fff; text-transform:uppercase;">${p.transmission}</span>`
                : '';

            let scheduleHtml = '';
            if (p.status === 'scheduled') {
                const cleanTime = (p.pickupTime || '').replace('Scheduled Pickup (', '').replace(')', '');
                scheduleHtml = `
                    <div style="font-family:'Plus Jakarta Sans',sans-serif; font-size:0.75rem; color:#F59E0B; display:flex; align-items:center; gap:5px; font-weight:700; background:rgba(245,158,11,0.1); border:1px solid rgba(245,158,11,0.2); padding:4px 8px; border-radius:8px; width:fit-content; margin-bottom:4px;">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
                        <span>Scheduled: ${p.pickupDate} · ${cleanTime}</span>
                    </div>
                `;
            } else {
                scheduleHtml = `
                    <div style="font-family:'Plus Jakarta Sans',sans-serif; font-size:0.75rem; color:#38BDF8; display:flex; align-items:center; gap:5px; font-weight:700; background:rgba(56,189,248,0.1); border:1px solid rgba(56,189,248,0.2); padding:4px 8px; border-radius:8px; width:fit-content; margin-bottom:4px;">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
                        <span>Instant Pickup</span>
                    </div>
                `;
            }

            return `
            <div style="background:#121317; border:1px solid #2C2C2E; border-radius:12px; padding:16px; margin-bottom:16px; display:flex; flex-direction:row; justify-content:space-between; align-items:stretch; gap:16px; box-shadow:0 4px 20px rgba(0,0,0,0.5); overflow:hidden;">
                
                <!-- Left Details Column (Flex Grow) -->
                <div style="display:flex; flex-direction:column; gap:6px; flex:1; min-width:180px;">
                    <!-- Vehicle name + badges -->
                    <div style="display:flex; flex-direction:column; gap:4px;">
                        <div style="font-family:'Plus Jakarta Sans',sans-serif; font-size:1.05rem; font-weight:700; color:#E3E2E7; line-height:1.2;">${p.fullName || 'Unknown Vehicle'}</div>
                        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                            ${p.plate ? `<span style="font-family:'JetBrains Mono',monospace; font-size:0.78rem; font-weight:500; letter-spacing:0.05em; color:#8E8E93;">${p.plate}</span>` : '<span style="font-family:\'Inter\',sans-serif; font-size:0.72rem; color:#555; font-style:italic;">No plate</span>'}
                            ${typeBadgeHtml}
                            ${fuelBadge}
                            ${transmissionBadge}
                        </div>
                    </div>
                    
                    <!-- Schedule Banner -->
                    ${scheduleHtml}

                    ${p.vehicleCondition === 'Not Working' ? `
                    <div style="font-family:'Plus Jakarta Sans',sans-serif; font-size:0.75rem; color:#ef4444; display:flex; align-items:center; gap:5px; font-weight:700; background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.2); padding:4px 8px; border-radius:8px; width:fit-content; margin-bottom:4px;">
                        <span class="material-symbols-outlined" style="font-size:14px; color:#ef4444;">error</span>
                        <span>Vehicle Not Working (Needs Tow/Push)</span>
                    </div>` : ''}

                    <!-- Distance badge -->
                    <div style="display:inline-flex; align-items:center; gap:4px; background:rgba(212,175,55,0.1); padding:3px 8px; border-radius:12px; border:1px solid rgba(212,175,55,0.2); width:fit-content;">
                        <span style="font-size:0.7rem; display:flex; align-items:center; color:#D4AF37;">${locationPinIcon}</span>
                        <span style="font-family:'Inter',sans-serif; font-size:0.7rem; font-weight:600; color:#D4AF37;">${p.distStr}</span>
                    </div>

                    <!-- Earning Breakdown -->
                    <div style="font-family:'Plus Jakarta Sans',sans-serif; font-size:0.75rem; color:#10B981; display:flex; align-items:center; gap:5px; font-weight:700; background:rgba(16,185,129,0.1); border:1px solid rgba(16,185,129,0.2); padding:4px 8px; border-radius:8px; width:fit-content; margin:4px 0;">
                        <span class="material-symbols-outlined" style="font-size:14px;">payments</span>
                        <span>
                            ₹${p.marshalcommission ? (p.marshalcommission - (p.extraAmount || 0)) : 0} 
                            ${p.extraAmount > 0 ? ` + ₹${p.extraAmount} Extra!` : ''} 
                            + ₹${window.globalSettings?.five_star_bonus || 50} bonus
                        </span>
                    </div>                    <!-- Pickup address -->
                    <div style="font-family:'Plus Jakarta Sans',sans-serif; font-size:0.74rem; color:#8E8E93; display:flex; align-items:flex-start; gap:4px;">
                        <span style="font-size:0.8rem; flex-shrink:0; color:#D4AF37; display:flex; align-items:center; margin-top:1px;">${locationPinIcon}</span>
                        <span style="word-break:break-word; line-height:1.4; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">${p.pickupDropType === 'Drop' ? (p.dropAddress || p.pickupAddress || 'Customer Location') : (p.pickupAddress || 'Pickup address not specified')}</span>
                    </div>

                    <!-- Action Button -->
                    ${getBidPickupIds().has(p.id) ? `
                    <div style="display:inline-flex; align-items:center; gap:6px; margin-top:8px; background:rgba(212,175,55,0.12); border:1px solid rgba(212,175,55,0.3); color:#D4AF37; font-family:'Plus Jakarta Sans',sans-serif; font-weight:700; font-size:0.8rem; padding:8px 16px; border-radius:9999px;">
                        <span class="material-symbols-outlined" style="font-size:16px;">hourglass_top</span>
                        Bid Submitted — Waiting for Customer
                    </div>
                    ` : `
                    <button onclick="acceptPickup('${p.id}')"
                        style="width:fit-content; margin-top:8px; background:#D4AF37; color:#0A0A0A; font-family:'Plus Jakarta Sans',sans-serif; font-weight:800; font-size:0.85rem; letter-spacing:0.05em; border:none; padding:10px 20px; border-radius:9999px; cursor:pointer; transition:all 0.2s; box-shadow:0 4px 15px rgba(212,175,55,0.2);"
                        onmouseover="this.style.opacity='0.9'; this.style.transform='translateY(-1px)'"
                        onmouseout="this.style.opacity='1'; this.style.transform='translateY(0)'">
                        ACCEPT PICKUP
                    </button>
                    `}
                </div>

                <!-- Right Vehicle Image Column (Properly Proportioned, No Absolute Positioning Overlap) -->
                <div style="width:100px; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                    <img src="${p.photo}"
                         alt="${p.fullName || 'Vehicle'}"
                         style="max-width:100%; max-height:80px; object-fit:cover; filter:drop-shadow(0 4px 8px rgba(0,0,0,0.5));"
                         onerror="this.style.display='none'">
                </div>
            </div>`;
        }).join('');

    } catch (err) {
        console.error(err);
        list.innerHTML = `<div class="empty-state p-10 text-center text-error border border-error/20 rounded-xl border-dashed"><p class="text-sm">Failed to load pickup feed</p><p class="text-xs mt-1 opacity-60">Retrying in 5s...</p></div>`;
    }
}

// ── RINGTONE & SOUND ALERT CONTROLLER ─────────────────────────────────────────
let rideRequestAudio = null;
let isRingtonePlaying = false;
let audioWarmUpAttempted = false;

function initRideRequestAudio() {
    if (!rideRequestAudio) {
        rideRequestAudio = new Audio('audio/ReDrivo_Request.mp3');
        rideRequestAudio.loop = true;
        rideRequestAudio.preload = 'auto';
        rideRequestAudio.volume = 1.0;
    }
}

function warmUpAudioOnUserGesture() {
    initRideRequestAudio();
    if (!audioWarmUpAttempted && rideRequestAudio) {
        audioWarmUpAttempted = true;
        const prevMuted = rideRequestAudio.muted;
        rideRequestAudio.muted = true;
        rideRequestAudio.play().then(() => {
            rideRequestAudio.pause();
            rideRequestAudio.currentTime = 0;
            rideRequestAudio.muted = prevMuted;
            console.log('[AUDIO] Audio subsystem unlocked successfully for session.');
        }).catch(e => {
            rideRequestAudio.muted = prevMuted;
            audioWarmUpAttempted = false;
            console.warn('[AUDIO] Audio warm-up deferred:', e.message);
        });
    }
}

['pointerdown', 'touchstart', 'click', 'keydown'].forEach(evtType => {
    document.addEventListener(evtType, warmUpAudioOnUserGesture, { passive: true });
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        console.log('[AUDIO] App resumed / tab visible. Re-checking audio readiness.');
        initRideRequestAudio();
    }
});

function startRideRequestRingtone() {
    if (localStorage.getItem('redrivo_driver_sound_enabled') === 'false') {
        console.log('[AUDIO] Ringtone skipped (muted in driver settings).');
        return;
    }

    initRideRequestAudio();
    if (rideRequestAudio && !isRingtonePlaying) {
        rideRequestAudio.currentTime = 0;
        rideRequestAudio.play().then(() => {
            isRingtonePlaying = true;
            console.log('[AUDIO] ✓ ReDrivo_Request.mp3 ringtone playing in loop.');
        }).catch(err => {
            console.warn('[AUDIO] Autoplay rejected by browser policy:', err.message);
        });
    }
}

function stopRideRequestRingtone() {
    if (rideRequestAudio && isRingtonePlaying) {
        try {
            rideRequestAudio.pause();
            rideRequestAudio.currentTime = 0;
        } catch (e) {
            console.warn('[AUDIO] Error pausing audio:', e);
        }
        isRingtonePlaying = false;
        console.log('[AUDIO] ✓ Ride request ringtone stopped.');
    }
    stopNativeRingtone();
}

window.startRideRequestRingtone = startRideRequestRingtone;
window.stopRideRequestRingtone = stopRideRequestRingtone;

window.lastSeenPickupId = null;
window.declinedPickupIds = new Set();
window.incomingPickupTimer = null;
window.incomingPickupSecondsLeft = 10;
window.currentIncomingPickup = null;

function showIncomingPickupModal(pickup) {
    if (!pickup || !pickup.id) return;
    const declinedSet = getDeclinedPickupIds();
    const bidSet = getBidPickupIds();
    if (declinedSet.has(pickup.id) || bidSet.has(pickup.id)) return;

    window.currentIncomingPickup = pickup;
    window.lastSeenPickupId = pickup.id;
    
    const make = pickup.vehicleMake || pickup.vehiclemake || '';
    const model = pickup.vehicleModel || pickup.vehiclemodel || '';
    const fullName = pickup.vehicleFullName || pickup.vehiclefullname || (make && model ? `${make} ${model}` : 'Unknown Vehicle');
    const plate = pickup.vehicleRegNumber || pickup.vehicleregnumber || pickup.plate || 'No Plate';
    const photo = pickup.vehiclePhoto || pickup.vehiclephoto || pickup.photo || null;
    const pLat = parseFloat(pickup.pickupLat || pickup.pickuplat || 0);
    const pLng = parseFloat(pickup.pickupLng || pickup.pickuplng || 0);
    
    let distStr = 'Nearby';
    if (marshalLat !== null && marshalLng !== null && pLat !== 0 && pLng !== 0) {
        const distKm = calcDistanceKm(marshalLat, marshalLng, pLat, pLng);
        if (distKm !== null) distStr = distKm.toFixed(1) + ' km away';
    }
    
    let imgSrc = 'images/sedan.png';
    if (photo) {
        imgSrc = photo.startsWith('data:') ? photo : (photo.includes('http') ? photo : (API_URL.replace('/api','') + '/' + photo));
    } else {
        const subType = (pickup.vehicleSubType || pickup.vehiclesubtype || '').toLowerCase();
        if (subType.includes('bike')) imgSrc = 'images/bike.png';
        else if (subType.includes('suv')) imgSrc = 'images/suv.png';
        else if (subType.includes('hatchback')) imgSrc = 'images/hatchback.png';
    }
    
    const displayPrice = Math.round(pickup.totalCustomerPrice || pickup.totalcustomerprice || pickup.price || 0);
    
    const address = pickup.pickupAddress || pickup.pickup_address || pickup.pickupaddress || 'Nearby location';

    document.getElementById('ip-vehicle-name').textContent = fullName;
    document.getElementById('ip-vehicle-plate').textContent = plate;
    document.getElementById('ip-vehicle-image').src = imgSrc;
    document.getElementById('ip-earnings').textContent = `₹${displayPrice}`;
    document.getElementById('ip-distance').textContent = distStr;
    document.getElementById('ip-address').textContent = address;

    // Asynchronously calculate real driving distance via DirectionsService if google is available
    if (typeof google !== 'undefined' && google.maps && marshalLat !== null && marshalLng !== null && pLat !== 0 && pLng !== 0) {
        try {
            const directionsService = new google.maps.DirectionsService();
            directionsService.route({
                origin: { lat: parseFloat(marshalLat), lng: parseFloat(marshalLng) },
                destination: { lat: pLat, lng: pLng },
                travelMode: google.maps.TravelMode.DRIVING
            }, (response, status) => {
                if (status === 'OK' && response.routes[0] && response.routes[0].legs[0]) {
                    const leg = response.routes[0].legs[0];
                    if (leg.distance && leg.distance.text) {
                        const realDistStr = leg.distance.text.replace('km', '').trim() + ' km away';
                        const distEl = document.getElementById('ip-distance');
                        if (distEl && window.currentIncomingPickup && window.currentIncomingPickup.id === pickup.id) {
                            distEl.textContent = realDistStr;
                        }
                    }
                }
            });
        } catch (err) {
            console.error('Error computing driving distance for incoming modal:', err);
        }
    }

    const modal = document.getElementById('incoming-pickup-modal');
    if (modal) {
        modal.style.display = 'flex';
        modal.classList.remove('hidden');
    }

    // Trigger ringtone alert on incoming modal appearance
    startRideRequestRingtone();

    if (window.incomingPickupTimer) clearInterval(window.incomingPickupTimer);
    window.incomingPickupSecondsLeft = INCOMING_PICKUP_TIMEOUT_SECONDS;
    
    const timerCircle = document.getElementById('ip-timer-circle');
    const acceptBtn = document.getElementById('ip-btn-accept');
    if (timerCircle) timerCircle.textContent = INCOMING_PICKUP_TIMEOUT_SECONDS;
    if (acceptBtn) acceptBtn.textContent = `ACCEPT (${INCOMING_PICKUP_TIMEOUT_SECONDS}s)`;

    window.incomingPickupTimer = setInterval(() => {
        window.incomingPickupSecondsLeft--;
        if (timerCircle) timerCircle.textContent = window.incomingPickupSecondsLeft;
        if (acceptBtn) acceptBtn.textContent = `ACCEPT (${window.incomingPickupSecondsLeft}s)`;

        if (window.incomingPickupSecondsLeft <= 0) {
            declineIncomingPickup();
        }
    }, 1000);
}

function stopNativeRingtone() {
    console.log('[DEBUG] stopNativeRingtone() invoked from WebView.');
    const BatteryOpt = getBatteryOptimizationPlugin();
    if (BatteryOpt) {
        console.log('[DEBUG] BatteryOptimization plugin detected. Invoking stopRingtoneService...');
        BatteryOpt.stopRingtoneService()
            .then(() => {
                console.log('[DEBUG] Native stopRingtoneService call resolved successfully.');
            })
            .catch(err => {
                console.error('[ERROR] Native stopRingtoneService execution failed:', err);
            });
    } else {
        console.warn('[WARNING] BatteryOptimization plugin is not available on this platform/context.');
    }
}

window.declineIncomingPickup = function() {
    stopRideRequestRingtone();
    if (window.incomingPickupTimer) {
        clearInterval(window.incomingPickupTimer);
        window.incomingPickupTimer = null;
    }
    
    const pickup = window.currentIncomingPickup;
    if (pickup && pickup.id) {
        markPickupAsDeclined(pickup.id);

        // Notify backend immediately of decline so customer app bids list drops this driver instantly
        if (currentUser && currentUser.id) {
            fetch(`${API_URL}/service-requests/${pickup.id}/decline`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ marshalId: currentUser.id })
            }).catch(e => console.warn('Failed to notify backend of decline:', e));
        }
    }

    const modal = document.getElementById('incoming-pickup-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('hidden');
    }
    window.currentIncomingPickup = null;
    loadAvailablePickups();
};

window.acceptIncomingPickupDirect = async function() {
    stopRideRequestRingtone();
    if (window.incomingPickupTimer) {
        clearInterval(window.incomingPickupTimer);
        window.incomingPickupTimer = null;
    }

    const pickup = window.currentIncomingPickup;
    const modal = document.getElementById('incoming-pickup-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('hidden');
    }

    if (pickup) {
        await acceptPickup(pickup.id);
        window.currentIncomingPickup = null;
    }
};

window.triggerCancelPickupFromPush = function(requestId) {
    console.log('[DEBUG] Received cancellation signal from push for request:', requestId);
    if (window.currentIncomingPickup && window.currentIncomingPickup.id === requestId) {
        window.declineIncomingPickup();
    }
};

window.handleAcceptedFromNotification = function(requestId) {
    if (window.lastHandledAcceptedRequestId === requestId) {
        console.log('[DEBUG] Accepted request already handled:', requestId);
        return;
    }
    window.lastHandledAcceptedRequestId = requestId;

    console.log('[DEBUG] Handle accepted request from notification:', requestId);
    const modal = document.getElementById('incoming-pickup-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('hidden');
    }
    window.currentIncomingPickup = null;
    if (window.incomingPickupTimer) {
        clearInterval(window.incomingPickupTimer);
        window.incomingPickupTimer = null;
    }
    switchTab('tasks');
};

function syncNativeDeclinedIds() {
    const BatteryOpt = getBatteryOptimizationPlugin();
    if (BatteryOpt) {
        BatteryOpt.getNativeDeclinedIds()
            .then(res => {
                if (res && res.ids) {
                    const ids = res.ids.split(',');
                    const declinedSet = getDeclinedPickupIds();
                    let changed = false;
                    ids.forEach(id => {
                        if (id && !declinedSet.has(id)) {
                            declinedSet.add(id);
                            changed = true;
                        }
                    });
                    if (changed) {
                        localStorage.setItem('redrivo_declined_pickup_ids', JSON.stringify(Array.from(declinedSet)));
                        if (typeof loadAvailablePickups === 'function') {
                            loadAvailablePickups();
                        }
                    }
                }
            })
            .catch(err => console.error('[ERROR] failed to sync native declined ids:', err));
    }
}

async function triggerIncomingPickupFromPush(requestId) {
    try {
        const res = await fetch(`${API_URL}/requests`, { cache: 'no-store' });
        if (res.ok) {
            const requests = await res.json();
            const pickup = requests.find(r => r.id === requestId);
            if (pickup && (pickup.status === 'pending' || pickup.status === 'scheduled') && (!pickup.workerId)) {
                showIncomingPickupModal(pickup);
            }
        }
    } catch (e) {
        console.warn("Failed to fetch details for push notification", e);
    }
}
window.triggerIncomingPickupFromPush = triggerIncomingPickupFromPush;

async function acceptPickup(id) {
    if (!currentUser || !isKycApproved(currentUser)) {
        return showToast('Action Blocked: KYC documents are undergoing verification. You cannot accept Pickups until approved.', 'warning');
    }

    stopRideRequestRingtone();
    markPickupAsBid(id);

    try {
        const pickup = (window.loadedAvailablePickups || []).find(p => p.id === id) || 
                       (window.currentIncomingPickup && window.currentIncomingPickup.id === id ? window.currentIncomingPickup : null);

        const isScheduled = pickup && (pickup.status === 'scheduled' || (pickup.bookingType && pickup.bookingType === 'scheduled'));
        
        if (isScheduled) {
            const res = await fetch(`${API_URL}/service-requests/${id}/accept-pickup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ marshalId: currentUser.id })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to accept scheduled booking');

            showToast('Scheduled booking accepted! Added to your Delivery list.', 'success');
            startPickupPolling();
            loadMyTrips();
            switchTab('tasks'); // Switch to Deliveries tab
        } else {
            // Live pickup requires bidding
            const res = await fetch(`${API_URL}/service-requests/${id}/bid`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ marshalId: currentUser.id })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to submit bid');

            showToast('Bid submitted! Waiting for customer to confirm and pay...', 'success');
            startPickupPolling();
            loadMyTrips();
            
            // Switch to map view and display the pending selection overlay
            switchTab('map');
            const selectionOverlay = document.getElementById('map-pending-selection-overlay');
            if (selectionOverlay) selectionOverlay.style.display = 'flex';
            
            // Periodically check selection status
            window.activeBidRequestId = id;
            if (window.bidCheckInterval) clearInterval(window.bidCheckInterval);
            window.bidCheckInterval = setInterval(async () => {
                try {
                    const statusRes = await fetch(`${API_URL}/requests`, { cache: 'no-store' });
                    if (statusRes.ok) {
                        const allReqs = await statusRes.json();
                        const req = allReqs.find(r => r.id === id);
                        if (req) {
                            const workerId = req.workerId || req.workerid;
                            if (req.status === 'marshal_assigned' && workerId === currentUser.id) {
                                // Chosen! Clear check and transition to awaiting payment
                                clearInterval(window.bidCheckInterval);
                                window.bidCheckInterval = null;
                                
                                const selectionOverlayEl = document.getElementById('map-pending-selection-overlay');
                                if (selectionOverlayEl) selectionOverlayEl.style.display = 'none';
                                
                                const paymentOverlayEl = document.getElementById('map-pending-payment-overlay');
                                if (paymentOverlayEl) paymentOverlayEl.style.display = 'flex';
                                
                                showToast('You have been selected! Awaiting customer payment...', 'success');
                                
                                // Fetch corresponding trip
                                const tripsRes = await fetch(`${API_URL}/trips`, { cache: 'no-store' });
                                if (tripsRes.ok) {
                                    const allTrips = await tripsRes.json();
                                    const myTrip = allTrips.find(t => (t.serviceRequestId || t.servicerequestid) === id && t.status !== 'cancelled');
                                    if (myTrip) {
                                        window.openMapView(myTrip.id);
                                    }
                                }
                                startPickupPolling();
                                loadMyTrips();
                            } else if (req.status === 'marshal_assigned' && workerId !== currentUser.id) {
                                // Another marshal selected
                                clearInterval(window.bidCheckInterval);
                                window.bidCheckInterval = null;
                                
                                const selectionOverlayEl = document.getElementById('map-pending-selection-overlay');
                                if (selectionOverlayEl) selectionOverlayEl.style.display = 'none';
                                
                                showToast('Another driver was selected for this service request.', 'info');
                                switchTab('trips');
                                startPickupPolling();
                                loadMyTrips();
                            } else if (req.status === 'cancelled' || req.status === 'returned') {
                                // Real cancellation from customer
                                clearInterval(window.bidCheckInterval);
                                window.bidCheckInterval = null;
                                
                                const selectionOverlayEl = document.getElementById('map-pending-selection-overlay');
                                if (selectionOverlayEl) selectionOverlayEl.style.display = 'none';
                                
                                const paymentOverlayEl = document.getElementById('map-pending-payment-overlay');
                                if (paymentOverlayEl) paymentOverlayEl.style.display = 'none';
                                
                                showToast('Customer cancelled the request. You are now free for new bookings.', 'info');
                                switchTab('trips');
                                startPickupPolling();
                                loadMyTrips();
                            }
                        } else {
                            // Missing request
                            clearInterval(window.bidCheckInterval);
                            window.bidCheckInterval = null;
                            
                            const selectionOverlayEl = document.getElementById('map-pending-selection-overlay');
                            if (selectionOverlayEl) selectionOverlayEl.style.display = 'none';
                            
                            showToast('Request is no longer active.', 'info');
                            switchTab('trips');
                            startPickupPolling();
                            loadMyTrips();
                        }
                    }
                } catch (ePoll) {
                    console.warn('Error polling bid selection status:', ePoll);
                }
            }, 2000);
        }
    } catch (err) {
        showToast(err.message, 'error');
    }
}

window.startNavigationFlow = function(tripId) {
    safeSetLocalStorage('trip_state_' + tripId, 'navigating');
    if (typeof window.drawMarshalRoute === 'function') {
        window.drawMarshalRoute();
    }
    showToast('Navigation started. Route plotted on map.', 'success');
    
    // Optionally open Google Maps in a new tab if on mobile
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (isMobile) {
        const targetTitle = document.getElementById('map-target-title')?.textContent || 'Customer Location';
        window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(targetTitle)}`, '_blank');
    }

    window.openMapView(tripId);
};

window.updateActionBtnState = function(trip, req, currentDistMeters) {
    const btn = document.getElementById('map-action-btn');
    const btnText = document.getElementById('map-action-text');
    const btnIcon = document.getElementById('map-action-icon');
    if (!btn || !btnText || !btnIcon) return;

    const status = trip.status;
    const bookingFlow = trip.bookingFlow || trip.bookingflow || 'p2p';
    
    if (status === 'assigned') {
        const tripState = localStorage.getItem('trip_state_' + trip.id) || 'accepted';
        
        if (currentDistMeters !== null && currentDistMeters <= 50) {
            btnText.textContent = 'Mark Arrived';
            btnIcon.textContent = 'location_on';
            btn.onclick = () => window.markArrived(trip.id);
            btn.disabled = false;
            btn.className = "flex-1 h-14 bg-[#22c55e] text-white font-extrabold text-lg rounded-xl shadow-[0_4px_20px_rgba(34,197,94,0.3)] flex items-center justify-center gap-2 active:scale-95 transition-all duration-150";
        } else if (tripState === 'navigating') {
            btnText.textContent = 'Navigating to Pickup...';
            btnIcon.textContent = 'navigation';
            btn.onclick = () => {
                const targetTitle = document.getElementById('map-target-title')?.textContent || 'Customer Location';
                window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(targetTitle)}`, '_blank');
            };
            btn.disabled = false;
            btn.className = "flex-1 h-14 bg-[#1F1F2E] text-[#D4AF37] border-2 border-[#D4AF37] font-extrabold text-lg rounded-xl flex items-center justify-center gap-2 active:scale-95 transition-all duration-150";
        } else {
            btnText.textContent = 'Start Navigation';
            btnIcon.textContent = 'navigation';
            btn.onclick = () => window.startNavigationFlow(trip.id);
            btn.disabled = false;
            btn.className = "flex-1 h-14 bg-[#D4AF37] text-black font-extrabold text-lg rounded-xl shadow-[0_4px_20px_rgba(212,175,55,0.3)] flex items-center justify-center gap-2 active:scale-95 transition-all duration-150";
        }
    } else {
        btn.disabled = false;
        btn.className = "flex-1 h-14 bg-primary-container text-on-primary-container font-extrabold text-lg rounded-xl shadow-[0_4px_20px_rgba(255,215,0,0.3)] flex items-center justify-center gap-2 active:scale-95 transition-all duration-150";
        
        if (status === 'pending_otp_1') {
            btnText.textContent = 'Start Handover';
            btnIcon.textContent = 'handshake';
            btn.onclick = () => openHandoverModal(trip.id, 'pickup');
        } else if (status === 'in_transit') {
            if (bookingFlow === 'p2p') {
                btnText.textContent = 'Complete Delivery';
                btnIcon.textContent = 'handshake';
                btn.onclick = () => openDeliveryOtpModal(trip.id);
            } else {
                btnText.textContent = 'Dropoff to Garage';
                btnIcon.textContent = 'handshake';
                btn.onclick = () => openHandoverModal(trip.id, 'dropoff_garage');
            }
        } else if (status === 'ready_for_delivery') {
            btnText.textContent = 'Start Delivery';
            btnIcon.textContent = 'handshake';
            btn.onclick = () => openHandoverModal(trip.id, 'pickup_garage');
        } else if (status === 'out_for_delivery') {
            btnText.textContent = 'Complete Delivery';
            btnIcon.textContent = 'handshake';
            btn.onclick = () => openDeliveryOtpModal(trip.id);
        } else {
            btnText.textContent = 'Task Active';
            btnIcon.textContent = 'task_alt';
            btn.onclick = null;
        }
    }
};

window.markArrivedFlow = function(tripId) {
    safeSetLocalStorage('trip_state_' + tripId, 'arrived');
    showToast('You have arrived at the customer location.', 'success');
    window.openMapView(tripId);
};

window.startStopHalt = async function(tripId, stopIndex, stop) {
    if (stop.haltStartedAt) {
        window.runHaltCountdownTimer(stop.haltStartedAt, stop.haltTime);
        return;
    }
    
    try {
        const res = await fetch(`${API_URL}/trips/${tripId}/start-halt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stopIndex })
        });
        if (res.ok) {
            const data = await res.json();
            stop.haltStartedAt = data.haltStartedAt;
            window.runHaltCountdownTimer(stop.haltStartedAt, stop.haltTime);
        }
    } catch(e) {
        console.error("Failed to start stop halt:", e);
    }
};

window.runHaltCountdownTimer = function(startedStr, durationMins) {
    const timerContainer = document.getElementById('map-stop-halt-timer');
    const countdownVal = document.getElementById('map-stop-halt-countdown');
    if (timerContainer) timerContainer.style.display = 'flex';

    if (window.marshalHaltInterval) clearInterval(window.marshalHaltInterval);
    
    const tick = () => {
        const startedAt = new Date(startedStr).getTime();
        const durationMs = durationMins * 60 * 1000;
        const elapsedMs = Date.now() - startedAt;
        const timeLeftMs = Math.max(0, durationMs - elapsedMs);

        if (timeLeftMs <= 0) {
            if (countdownVal) {
                countdownVal.textContent = "00:00 (Waiting for OTP)";
                countdownVal.style.color = '#ef4444';
            }
            clearInterval(window.marshalHaltInterval);
        } else {
            const min = Math.floor(timeLeftMs / 1000 / 60);
            const sec = Math.floor((timeLeftMs / 1000) % 60);
            if (countdownVal) {
                countdownVal.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
                countdownVal.style.color = '#F59E0B';
            }
        }
    };
    
    tick();
    window.marshalHaltInterval = setInterval(tick, 1000);
};

window.autoVerifyStop = async function(tripId, stopIndex) {
    if (window.isAutoVerifyingStop) return;
    window.isAutoVerifyingStop = true;
    try {
        const res = await fetch(`${API_URL}/trips/${tripId}/verify-stop-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stopIndex, otp: 'AUTO' })
        });
        if (res.ok) {
            showToast("Waypoint stop passed.", "success");
            window.openMapView(tripId);
        }
    } catch (e) {
        console.error("Auto verify stop failed:", e);
    } finally {
        window.isAutoVerifyingStop = false;
    }
};

window.openMapView = async function(tripId = null) {
    if (typeof google === 'undefined' || !google.maps) {
        if (!window.openMapViewRetries) window.openMapViewRetries = 0;
        if (window.openMapViewRetries < 20) {
            window.openMapViewRetries++;
            setTimeout(() => window.openMapView(tripId), 500);
            return;
        } else {
            console.error('Google Maps failed to load after multiple retries.');
            window.openMapViewRetries = 0;
        }
    }
    window.openMapViewRetries = 0;

    switchTab('map');
    const stopOtpContainer = document.getElementById('map-stop-otp-container');
    if (stopOtpContainer) stopOtpContainer.style.display = 'none';

    try {
        const [reqsRes, tripsRes] = await Promise.all([
            fetch(`${API_URL}/requests`, { cache: 'no-store' }),
            fetch(`${API_URL}/trips`, { cache: 'no-store' })
        ]);
        const allRequests = await reqsRes.json();
        const allTrips = await tripsRes.json();

        let trip = null;
        if (tripId) {
            trip = allTrips.find(t => t.id === tripId);
        } else {
            trip = allTrips.find(t => 
                (((t.marshalId || t.marshalid) === currentUser.id && ['pending_payment', 'assigned', 'pending_otp_1', 'in_transit'].includes(t.status)) ||
                 ((t.deliveryMarshalId || t.deliverymarshalid) === currentUser.id && ['ready_for_delivery', 'out_for_delivery', 'pending_delivery'].includes(t.status)))
            );
        }

        if (!trip || trip.status === 'cancelled') {
            if (window.marshalPaymentTimer) clearInterval(window.marshalPaymentTimer);
            switchTab('trips');
            showToast('The booking has been cancelled (payment timeout or customer cancelled).', 'error');
            return;
        }
        currentTripId = trip.id; // Set global trip ID

        if (trip.status === 'pending_payment') {
            const overlay = document.getElementById('map-pending-payment-overlay');
            if (overlay) overlay.style.display = 'flex';
            
            const createdTime = new Date(trip.createdAt).getTime();
            const startCountdown = () => {
                if (window.marshalPaymentTimer) clearInterval(window.marshalPaymentTimer);
                
                const updateTimer = async () => {
                    const elapsed = Math.floor((Date.now() - createdTime) / 1000);
                    const left = Math.max(0, 300 - elapsed);
                    const timerText = overlay.querySelector('div:last-child');
                    if (timerText) {
                        const m = Math.floor(left / 60);
                        const s = left % 60;
                        timerText.textContent = `Automatic Cancellation in ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
                    }
                    
                    if (left % 3 === 0) {
                        try {
                            const res = await fetch(`${API_URL}/trips`, { cache: 'no-store' });
                            const allTrips = await res.json();
                            const currentTrip = allTrips.find(t => t.id === trip.id);
                            if (!currentTrip || currentTrip.status === 'cancelled') {
                                clearInterval(window.marshalPaymentTimer);
                                switchTab('trips');
                                showToast('The booking has been cancelled (payment timeout or customer cancelled).', 'error');
                                return;
                            }
                            if (currentTrip.status !== 'pending_payment') {
                                clearInterval(window.marshalPaymentTimer);
                                window.openMapView(trip.id);
                                showToast('Payment confirmed! Proceeding to pickup.', 'success');
                                return;
                            }
                        } catch (e) {
                            console.warn("Failed to poll trip status:", e);
                        }
                    }

                    if (left <= 0) {
                        clearInterval(window.marshalPaymentTimer);
                    }
                };
                updateTimer();
                window.marshalPaymentTimer = setInterval(updateTimer, 1000);
            };
            startCountdown();
        } else {
            const overlay = document.getElementById('map-pending-payment-overlay');
            if (overlay) overlay.style.display = 'none';
            if (window.marshalPaymentTimer) clearInterval(window.marshalPaymentTimer);
        }

        const stopOtpVerifyBtn = document.getElementById('map-stop-otp-verify-btn');
        if (stopOtpVerifyBtn) {
            stopOtpVerifyBtn.onclick = async () => {
                const otpInput = document.getElementById('map-stop-otp-input');
                const otp = otpInput ? otpInput.value.trim() : '';
                if (otp.length !== 4) {
                    showToast("Please enter a valid 4-digit OTP.", "warning");
                    return;
                }
                
                try {
                    const res = await fetch(`${API_URL}/trips/${trip.id}/verify-stop-otp`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ stopIndex: window.headingToStopIndex, otp })
                    });
                    const data = await res.json();
                    if (res.ok) {
                        if (data.actualHaltMins !== undefined) {
                            showToast(`Halt Completed! Actual Halt: ${data.actualHaltMins} mins. Final Halt Price: ₹${data.finalHaltCost}.`, "success");
                        } else {
                            showToast("Stop verified successfully!", "success");
                        }
                        if (otpInput) otpInput.value = '';
                        if (stopOtpContainer) stopOtpContainer.style.display = 'none';
                        window.openMapView(trip.id);
                    } else {
                        showToast(data.error || "Verification failed.", "error");
                    }
                } catch (e) {
                    console.error("Failed to verify stop OTP:", e);
                    showToast("Verification error: " + e.message, "error");
                }
            };
        }

        const req = allRequests.find(r => r.id === (trip.serviceRequestId || trip.servicerequestid));
        if (!req) return;

        let stops = [];
        try {
            if (req.route_stops) {
                stops = typeof req.route_stops === 'string' ? JSON.parse(req.route_stops) : req.route_stops;
            }
        } catch (e) {
            console.warn("Failed to parse route_stops:", e);
        }

        let nextStopIndex = -1;
        let nextStop = null;
        if (Array.isArray(stops) && stops.length > 0) {
            nextStopIndex = stops.findIndex(s => !s.otpVerified);
            if (nextStopIndex !== -1) {
                nextStop = stops[nextStopIndex];
            }
        }

        let isHeadingToStop = false;
        if (nextStop && trip.status === 'in_transit') {
            isHeadingToStop = true;
        }

        window.headingToStopIndex = nextStopIndex;
        window.isHeadingToStop = isHeadingToStop;
        
        const pType = req.pickupDropType || req.pickup_drop_type || req.pickupdroptype || 'Pickup';
        let targetTitle = pType === 'Drop' ? 'Customer Drop' : 'Customer Pickup';
        let targetAddress = pType === 'Drop' ? (req.drop_address || req.dropaddress || req.pickup_address || req.pickupaddress || 'Customer Location') : (req.pickup_address || req.pickupaddress || 'Customer Location');
        
        if (isHeadingToStop) {
            const waitMins = parseInt(nextStop.haltTime) || 0;
            if (waitMins > 0) {
                targetTitle = `Halt Location #${nextStopIndex + 1} (Wait: ${waitMins} mins): ${nextStop.address.split(',')[0]}`;
            } else {
                targetTitle = `Stop #${nextStopIndex + 1}: ${nextStop.address.split(',')[0]}`;
            }
            targetAddress = nextStop.address;
        } else if (trip.status === 'in_transit') {
            if (pType === 'Drop') {
                targetTitle = 'Customer Drop';
                targetAddress = req.drop_address || req.dropaddress || req.pickup_address || req.pickupaddress || 'Customer Location';
            } else {
                const garagesRes = await fetch(`${API_URL}/garages`, { cache: 'no-store' });
                const allGarages = await garagesRes.json();
                const garageId = req.assignedGarageId || req.garageId || req.garageid || req.assignedgarageid;
                const garage = garageId ? allGarages.find(g => g.id === garageId) : null;
                if (garage) {
                    targetTitle = garage.name;
                    targetAddress = garage.address || garage.area || 'Garage Location';
                } else {
                    targetTitle = 'Selected Garage';
                }
            }
        } else if (trip.status === 'pending_otp_1' && pType === 'Drop') {
            const garagesRes = await fetch(`${API_URL}/garages`, { cache: 'no-store' });
            const allGarages = await garagesRes.json();
            const garageId = req.assignedGarageId || req.garageId || req.garageid || req.assignedgarageid;
            const garage = garageId ? allGarages.find(g => g.id === garageId) : null;
            if (garage) {
                targetTitle = 'Pickup from ' + garage.name;
                targetAddress = garage.address || garage.area || 'Garage Location';
            } else {
                targetTitle = 'Pickup from Garage';
            }
        }
        
        const customerName = req.customerName || req.customername || 'Customer';
        const customerPhone = req.customerPhone || req.customerphone || '';

        const callBtn = document.getElementById('map-call-btn');
        if (callBtn) {
            if (customerPhone) {
                callBtn.style.display = 'flex';
                callBtn.onclick = () => {
                    showToast(`Calling Customer: ${customerPhone}`, 'info');
                    window.open(`tel:${customerPhone}`, '_system');
                };
            } else {
                callBtn.style.display = 'none';
            }
        }

        const mapCustName = document.getElementById('map-customer-name');
        const mapVehInfo = document.getElementById('map-vehicle-info');
        const mapTargetTitle = document.getElementById('map-target-title');
        const mapTargetAddress = document.getElementById('map-target-address');
        const mapDistance = document.getElementById('map-distance');
        const mapEta = document.getElementById('map-eta');

        let vehicleStr = `Req: ${req.id}`;
        try {
            if (req.vehicleId || req.vehicleid || req.vehicle) {
                const vehRes = await fetch(`${API_URL}/vehicles`, { cache: 'no-store' });
                const vehicles = await vehRes.json();
                const vId = req.vehicleId || req.vehicleid || req.vehicle;
                const vehicle = vehicles.find(v => v.id === vId || v.id == vId);
                if (vehicle) {
                    vehicleStr = `${vehicle.make} ${vehicle.model} • ${vehicle.registrationNumber || vehicle.regNumber || vehicle.number || ''}`;
                } else if (req.vehicleName) {
                    vehicleStr = req.vehicleName;
                }
            }
        } catch(e) {}

        if (mapCustName) mapCustName.textContent = customerName;
        if (mapVehInfo) mapVehInfo.textContent = vehicleStr;
        if (mapTargetTitle) mapTargetTitle.textContent = targetTitle;
        if (mapTargetAddress) mapTargetAddress.textContent = targetAddress;

        // Initialize Map
        if (!marshalMap && typeof google !== 'undefined' && google.maps) {
            marshalMap = new google.maps.Map(document.getElementById('marshal-leaflet-map'), { center: {lat: 28.6139, lng: 77.2090}, zoom: 13, disableDefaultUI: true, styles: lightMapStyle });
            // L.tileLayer removed
        }

        // Determine target coordinates based on bookingFlow and trip status
        let targetLat = 19.0760;
        let targetLng = 72.8777;
        let resolved = false;

        const bookingFlow = trip.bookingFlow || trip.bookingflow || 'p2p';
        const garageId = req.assignedGarageId || req.garageId || req.garageid;
        
        const pickupLat = parseFloat(req.pickuplat || req.pickupLat || req.pickup_lat || req.lat || 19.0760);
        const pickupLng = parseFloat(req.pickuplng || req.pickupLng || req.pickup_lng || req.lng || 72.8777);
        const dropLat = parseFloat(req.droplat || req.dropLat || req.drop_lat || req.droplng || pickupLat);
        const dropLng = parseFloat(req.droplng || req.dropLng || req.drop_lng || req.droplng || pickupLng);

        if (window.isHeadingToStop) {
            targetLat = parseFloat(nextStop.lat);
            targetLng = parseFloat(nextStop.lng);
            resolved = true;
        } else if (bookingFlow === 'p2p') {
            if (trip.status === 'pending_otp_1') {
                // P2P: Heading to customer pickup
                targetLat = pickupLat;
                targetLng = pickupLng;
                resolved = true;
            } else {
                // P2P: Heading to customer's preferred drop-off location
                targetLat = dropLat;
                targetLng = dropLng;
                resolved = true;
            }
        } else {
            // Garage Standard (2-Way) or Garage Return (1-Way)
            if (trip.status === 'pending_otp_1') {
                // Heading to customer home for pickup
                targetLat = pickupLat;
                targetLng = pickupLng;
                resolved = true;
            } else if (['in_transit', 'at_garage', 'in_service'].includes(trip.status)) {
                // Heading to or at garage
                if (garageId) {
                    try {
                        const garagesRes = await fetch(`${API_URL}/garages`, { cache: 'no-store' });
                        const allGarages = await garagesRes.json();
                        const garage = allGarages.find(g => g.id === garageId);
                        if (garage && garage.lat && garage.lng) {
                            targetLat = parseFloat(garage.lat);
                            targetLng = parseFloat(garage.lng);
                            resolved = true;
                        }
                    } catch (e) {
                        console.error("Error resolving garage coords:", e);
                    }
                }
            } else if (['ready_for_delivery', 'out_for_delivery', 'pending_delivery'].includes(trip.status)) {
                // Heading back to customer home
                targetLat = pickupLat;
                targetLng = pickupLng;
                resolved = true;
            }
        }

        if (!resolved) {
            targetLat = pickupLat;
            targetLng = pickupLng;
        }

        let tLat = targetLat;
        let tLng = targetLng;
        
        if (targetMarker) if (targetMarker && targetMarker.setMap) targetMarker.setMap(null);
        targetMarker = new google.maps.Marker({ position: {lat: tLat, lng: tLng}, map: marshalMap, icon: createGoogleIcon('#ef4444') });

        let initialDistMeters = null;
        if (marshalLat !== null && marshalLng !== null) {
            initialDistMeters = calcDistanceKm(marshalLat, marshalLng, tLat, tLng) * 1000;
        }
        window.updateActionBtnState(trip, req, initialDistMeters);

        const handleLocationSuccess = (mLat, mLng) => {
            let dist = calcDistanceKm(mLat, mLng, tLat, tLng);
            if (dist > 50) {
                if (window.DEV_MODE_MOCK_LOCATION) {
                    // Marshal is too far (remote testing). Mock a location 2.2km away for realistic map and route.
                    mLat = tLat + 0.015;
                    mLng = tLng + 0.015;
                } else {
                    showToast('Warning: Your GPS location is unusually far from the destination. Please check your GPS signal.', 'warning');
                }
            }

            const marshalIcon = createSvgIcon(HECTOR_MAP_SVG, 40, 40);

            if (marshalMarker) if (marshalMarker && marshalMarker.setMap) marshalMarker.setMap(null);
            marshalMarker = new google.maps.Marker({ position: {lat: mLat, lng: mLng}, map: marshalMap, icon: marshalIcon });
            
            const bounds = new google.maps.LatLngBounds(); bounds.extend({lat: mLat, lng: mLng}); bounds.extend({lat: tLat, lng: tLng}); marshalMap.fitBounds(bounds, 50);
            
            let distMeters = google.maps.geometry.spherical.computeDistanceBetween(
                new google.maps.LatLng(mLat, mLng),
                new google.maps.LatLng(tLat, tLng)
            );
            window.updateActionBtnState(trip, req, distMeters);
            let actualDistanceKm = (distMeters / 1000).toFixed(1);
            let actualMins = Math.floor(actualDistanceKm * 3.5) || 1;
            if (mapDistance) mapDistance.innerHTML = `${actualDistanceKm}<span class="text-lg ml-1">km</span>`;
            if (mapEta) mapEta.textContent = `${actualMins} mins ETA`;

            const stopOtpContainer = document.getElementById('map-stop-otp-container');
            if (window.isHeadingToStop && distMeters <= 50) {
                const currentStop = stops[window.headingToStopIndex];
                const waitMins = currentStop ? (parseInt(currentStop.haltTime) || 0) : 0;
                if (waitMins > 0) {
                    if (stopOtpContainer) stopOtpContainer.style.display = 'flex';
                    window.startStopHalt(trip.id, window.headingToStopIndex, currentStop);
                } else {
                    if (stopOtpContainer) stopOtpContainer.style.display = 'none';
                    window.autoVerifyStop(trip.id, window.headingToStopIndex);
                }
            } else {
                if (stopOtpContainer) stopOtpContainer.style.display = 'none';
            }

            // Draw route
            window.drawMarshalRoute();

            if (marshalLocationInterval) clearInterval(marshalLocationInterval);
            marshalLocationInterval = setInterval(async () => {
                const sendLocation = async (lat, lng) => {
                    marshalMarker.setPosition({lat: lat, lng: lng});
                    
                    let currentDistMeters = google.maps.geometry.spherical.computeDistanceBetween(
                        new google.maps.LatLng(lat, lng),
                        new google.maps.LatLng(tLat, tLng)
                    );
                    window.updateActionBtnState(trip, req, currentDistMeters);
                    let actualDistanceKm = (currentDistMeters / 1000).toFixed(1);
                    let actualMins = Math.floor(actualDistanceKm * 3.5) || 1;
                    if (mapDistance) mapDistance.innerHTML = `${actualDistanceKm}<span class="text-lg ml-1">km</span>`;
                    if (mapEta) mapEta.textContent = `${actualMins} mins ETA`;

                    if (window.isHeadingToStop && currentDistMeters <= 50) {
                        const currentStop = stops[window.headingToStopIndex];
                        const waitMins = currentStop ? (parseInt(currentStop.haltTime) || 0) : 0;
                        if (waitMins > 0) {
                            if (stopOtpContainer) stopOtpContainer.style.display = 'flex';
                            window.startStopHalt(trip.id, window.headingToStopIndex, currentStop);
                        } else {
                            if (stopOtpContainer) stopOtpContainer.style.display = 'none';
                            window.autoVerifyStop(trip.id, window.headingToStopIndex);
                        }
                    } else {
                        if (stopOtpContainer) stopOtpContainer.style.display = 'none';
                    }

                    // Redraw route dynamically as the marshal moves
                    window.drawMarshalRoute();

                    // Pan/zoom map to keep both marshal and target visible
                    const bounds = new google.maps.LatLngBounds();
                    bounds.extend({lat: lat, lng: lng});
                    bounds.extend({lat: tLat, lng: tLng});
                    marshalMap.fitBounds(bounds, 50);

                    try {
                        await fetch(`${API_URL}/trips/${trip.id}`, {
                            method: 'PATCH', headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ marshalLat: lat, marshalLng: lng })
                        });
                    } catch(e){}
                };

                if (activeGpsMode !== 'gps') {
                    sendLocation(marshalLat, marshalLng);
                } else {
                    navigator.geolocation.getCurrentPosition(async (updPos) => {
                        let uLat = updPos.coords.latitude;
                        let uLng = updPos.coords.longitude;
                        let uDist = calcDistanceKm(uLat, uLng, tLat, tLng);
                        if (uDist > 50) {
                            if (window.DEV_MODE_MOCK_LOCATION) {
                                uLat = tLat + 0.015;
                                uLng = tLng + 0.015;
                            } else {
                                showToast('Warning: Your GPS location is unusually far from the destination. Please check your GPS signal.', 'warning');
                            }
                        }
                        sendLocation(uLat, uLng);
                    }, () => {
                        if (window.DEV_MODE_MOCK_LOCATION) {
                            sendLocation(marshalLat || tLat + 0.015, marshalLng || tLng + 0.015);
                        } else {
                            if (marshalLat !== null && marshalLng !== null) {
                                sendLocation(marshalLat, marshalLng);
                            } else {
                                showToast('Error: Unable to get your GPS location. Please check location permissions and signal.', 'error');
                            }
                        }
                    });
                }
            }, 5000);
        };

        if (activeGpsMode !== 'gps') {
            handleLocationSuccess(marshalLat, marshalLng);
        } else if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                pos => handleLocationSuccess(pos.coords.latitude, pos.coords.longitude),
                err => {
                    console.warn("Geolocation blocked/failed:", err.message);
                    if (window.DEV_MODE_MOCK_LOCATION) {
                        handleLocationSuccess(tLat + 0.015, tLng + 0.015);
                    } else {
                        showToast('Error: Geolocation failed. Please check location permissions and signal.', 'error');
                    }
                }
            );
        } else {
            if (window.DEV_MODE_MOCK_LOCATION) {
                handleLocationSuccess(tLat + 0.015, tLng + 0.015);
            } else {
                showToast('Error: Geolocation is not supported by your browser.', 'error');
            }
        }

    } catch (err) {
        console.error('Error loading map view data:', err);
    }
};

window.drawMarshalRoute = function() {
    if (!marshalMap || !marshalMarker || !targetMarker) {
        showToast("Waiting for location...", "info");
        return;
    }
    if (window.marshalDirectionsRenderer) {
        window.marshalDirectionsRenderer.setMap(marshalMap);
    } else {
        window.marshalDirectionsRenderer = new google.maps.DirectionsRenderer({ 
            map: marshalMap, 
            suppressMarkers: true, 
            polylineOptions: { strokeColor: '#0f172a', strokeOpacity: 0.9, strokeWeight: 6 } 
        });
    }
    const directionsService = new google.maps.DirectionsService();
directionsService.route({
    origin: { lat: marshalMarker.getPosition().lat(), lng: marshalMarker.getPosition().lng() },
    destination: { lat: targetMarker.getPosition().lat(), lng: targetMarker.getPosition().lng() },
    travelMode: google.maps.TravelMode.DRIVING
}, (response, status) => {
    if (status === 'OK') {
        window.marshalDirectionsRenderer.setDirections(response);
        
        // Extract and update distance/ETA from real Google Maps Directions response
        const leg = response.routes[0].legs[0];
        if (leg) {
            const mapDistance = document.getElementById('map-distance');
            const mapEta = document.getElementById('map-eta');
            if (mapDistance && leg.distance) {
                mapDistance.innerHTML = `${leg.distance.text.replace('km', '').trim()}<span class="text-lg ml-1">km</span>`;
            }
            if (mapEta && leg.duration) {
                mapEta.textContent = `${leg.duration.text} ETA`;
            }
        }
    }
});

}

async function loadMyTrips() {
    const list = document.getElementById('my-trips-list');
    
    if (!currentUser || !isKycApproved(currentUser)) {
        list.innerHTML = `<div class="p-10 text-center bg-surface-container-lowest border border-outline-variant rounded-xl shadow-sm">
            <span class="material-symbols-outlined text-4xl text-warning mb-2">lock</span>
            <p class="text-sm font-bold text-on-surface">Action Locked</p>
            <p class="text-xs text-on-surface-variant mt-1">You cannot view active trips until your KYC is Approved.</p>
        </div>`;
        return;
    }
    
    try {
        const [reqsRes, garagesRes, tripsRes] = await Promise.all([
            fetch(`${API_URL}/requests`, { cache: 'no-store' }),
            fetch(`${API_URL}/garages`, { cache: 'no-store' }),
            fetch(`${API_URL}/trips`, { cache: 'no-store' })
        ]);
        const allRequests = await reqsRes.json();
        const allGarages = await garagesRes.json();
        const allTrips = await tripsRes.json();

        const allFilteredTrips = allTrips.filter(t => {
            const req = allRequests.find(r => r.id === (t.serviceRequestId || t.servicerequestid));
            if (req && ['cancelled', 'returned'].includes(req.status)) {
                return false;
            }
            return ((t.marshalId || t.marshalid) === currentUser.id && t.status !== 'ready_for_delivery' && t.status !== 'out_for_delivery' && t.status !== 'pending_delivery' && t.status !== 'completed') || 
                   ((t.deliveryMarshalId || t.deliverymarshalid) === currentUser.id && (t.status === 'ready_for_delivery' || t.status === 'out_for_delivery' || t.status === 'pending_delivery')) ||
                   (t.status === 'completed' && ((t.marshalId || t.marshalid) === currentUser.id || (t.deliveryMarshalId || t.deliverymarshalid) === currentUser.id));
        });

        const filter = window.activeTasksFilter || 'todo';
        let myTrips = [];
        if (filter === 'todo') {
            myTrips = allFilteredTrips.filter(t => ['pending_payment', 'assigned', 'ready_for_delivery', 'pending_otp_1'].includes(t.status));
        } else if (filter === 'inprogress') {
            myTrips = allFilteredTrips.filter(t => ['in_transit', 'out_for_delivery', 'pending_delivery'].includes(t.status));
        } else if (filter === 'completed') {
            myTrips = allFilteredTrips.filter(t => t.status === 'completed');
        }

        if (myTrips.length === 0) {
            list.innerHTML = `<div class="empty-state p-10 text-center text-on-surface-variant border border-outline-variant rounded-xl border-dashed"><p class="text-sm">No ${filter === 'inprogress' ? 'in-progress' : filter} trips.</p></div>`;
            return;
        }

        list.innerHTML = myTrips.map(t => {
            const req = allRequests.find(r => r.id === (t.serviceRequestId || t.servicerequestid));
            if (!req) return '';
            
            const garageId = req.assignedGarageId || req.garageId || req.garageid || req.assignedgarageid;
            const garage = garageId ? allGarages.find(g => g.id === garageId) : null;
            const bookingFlow = t.bookingFlow || t.bookingflow || 'p2p';

            // Resolve customer name from joined query
            const customerName = req.customerName || req.customername || 'Customer';

            // Destination label
            let statusText;
            if (bookingFlow === 'p2p') {
                statusText = req.drop_address || req.dropaddress || req.dropAddress || 'Customer Drop Point';
            } else {
                statusText = garageId ? `Deliver to: ${garage ? garage.name : 'Selected Garage'}` : 'Partner Garage (Pending Assignment)';
            }
            if (t.status === 'ready_for_delivery' || t.status === 'out_for_delivery' || t.status === 'pending_delivery') {
                statusText = req.drop_address || req.dropaddress || req.dropAddress || 'Customer Drop Point';
            }

            // Human-readable status
            const statusLabels = {
                pending_payment: 'Awaiting Payment',
                assigned: 'Head to Pickup',
                pending_otp_1: 'Awaiting Pickup OTP',
                in_transit: 'In Transit',
                at_garage: 'At Garage',
                in_service: 'In Service',
                ready_for_delivery: 'Ready for Delivery',
                out_for_delivery: 'Out for Delivery',
                pending_delivery: 'Awaiting Delivery OTP',
                completed: 'Completed'
            };
            const statusReadable = statusLabels[t.status] || t.status.replace(/_/g, ' ');
            
            let actionBtn = '';
            if (t.status === 'pending_payment') {
                actionBtn = `<button class="w-full bg-[#1e293b] text-zinc-400 font-bold py-3 rounded-lg shadow-sm hover:brightness-95 transition-all" onclick="openMapView('${t.id}')">Awaiting Payment Confirmation</button>`;
            } else if (t.status === 'assigned') {
                actionBtn = `<button class="w-full bg-primary-container text-on-primary-container font-bold py-3 rounded-lg shadow-sm hover:brightness-95 transition-all" onclick="window.markArrived('${t.id}')">Mark Arrived</button>`;
            } else if (t.status === 'pending_otp_1') {
                actionBtn = `<button class="w-full bg-warning text-black font-bold py-3 rounded-lg shadow-sm hover:brightness-95 transition-all" onclick="openHandoverModal('${t.id}', 'pickup')" style="background-color: #f59e0b;">Enter OTP</button>`;
            } else if (t.status === 'in_transit') {
                if (bookingFlow === 'p2p') {
                    actionBtn = `<button class="w-full bg-success text-white font-bold py-3 rounded-lg shadow-sm hover:brightness-95 transition-all" onclick="openMapView('${t.id}')" style="background-color: #10b981;">Map View</button>
                            <button class="flex-1 bg-blue-600 text-white font-bold py-3 rounded-lg shadow-sm hover:brightness-95 transition-all" onclick="startNativeNavigation('${t.id}')">Navigate</button>`;
                } else {
                    actionBtn = `
                        <div class="flex gap-2">
                            <button class="flex-1 bg-success text-white font-bold py-3 rounded-lg shadow-sm hover:brightness-95 transition-all" onclick="openMapView('${t.id}')" style="background-color: #10b981;">Map View</button>
                            <button class="flex-1 bg-blue-600 text-white font-bold py-3 rounded-lg shadow-sm hover:brightness-95 transition-all" onclick="startNativeNavigation('${t.id}')">Navigate</button>
                            <button class="flex-1 bg-primary text-black font-bold py-3 rounded-lg shadow-sm hover:brightness-95 transition-all" onclick="openHandoverModal('${t.id}', 'dropoff_garage')" style="background-color: #F59E0B;">Dropoff to Garage</button>
                        </div>`;
                }
            } else if (t.status === 'ready_for_delivery') {
                actionBtn = `
                    <div class="flex gap-2">
                        <button class="flex-1 bg-primary-container text-on-primary-container font-bold py-3 rounded-lg shadow-sm hover:brightness-95 transition-all" onclick="openHandoverModal('${t.id}', 'pickup_garage')">Start Delivery</button>
                        <button class="bg-surface text-error border border-error px-4 rounded-lg font-bold shadow-sm" onclick="reassignDelivery('${t.id}')">Busy</button>
                    </div>`;
            } else if (t.status === 'out_for_delivery') {
                actionBtn = `<button class="w-full bg-warning text-black font-bold py-3 rounded-lg shadow-sm hover:brightness-95 transition-all" onclick="openDeliveryOtpModal('${t.id}')" style="background-color: #f59e0b;">Upload Media & Dropoff</button>`;
            } else if (t.status === 'pending_delivery') {
                actionBtn = `<button class="w-full bg-success text-white font-bold py-3 rounded-lg shadow-sm hover:brightness-95 transition-all" onclick="openDeliveryOtpModal('${t.id}')" style="background-color: #10b981;">Enter Delivery OTP</button>`;
            }

            return `
                <div class="bg-surface-container-lowest p-5 border border-outline-variant rounded-xl mb-4 flex flex-col gap-4 shadow-sm">
                    <div class="flex justify-between items-start">
                        <div>
                            <div class="text-[10px] text-on-surface-variant uppercase font-bold tracking-widest mb-1">Active Assignment</div>
                            <div class="font-bold text-lg text-on-surface">Trip #${t.id.slice(-8)}</div>
                            <div class="text-sm text-on-surface-variant mt-1" style="display:flex;align-items:center;gap:6px;">
                                <span style="color:#F59E0B;font-size:0.7rem;">&#9679;</span>
                                <span>Customer: <strong style="color:#fff;">${customerName}</strong></span>
                            </div>
                            ${(req.vehicle_condition === 'Not Working' || req.vehicleCondition === 'Not Working' || req.vehiclecondition === 'Not Working') ? `
                            <div style="font-family:'Plus Jakarta Sans',sans-serif; font-size:0.72rem; color:#ef4444; display:flex; align-items:center; gap:5px; font-weight:700; background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.2); padding:4px 8px; border-radius:8px; width:fit-content; margin-top:6px;">
                                <span class="material-symbols-outlined" style="font-size:14px; color:#ef4444;">error</span>
                                <span>Vehicle Not Working (Needs Tow/Push)</span>
                            </div>` : ''}
                        </div>
                        <div class="px-3 py-1 rounded-full text-[10px] font-bold uppercase" style="background:rgba(245, 158, 11,0.12);color:#F59E0B;border:1px solid rgba(245, 158, 11,0.3);white-space:nowrap;">
                            ${statusReadable}
                        </div>
                    </div>
                    <div class="flex flex-col gap-3 bg-surface p-4 rounded-xl border border-outline-variant">
                        <div class="flex items-start gap-3">
                            <span class="material-symbols-outlined text-warning text-[20px] mt-0.5" style="color: #f59e0b;">pin_drop</span>
                            <div>
                                <div class="text-[10px] text-on-surface-variant font-bold uppercase">${(req.pickupDropType || req.pickup_drop_type || req.pickupdroptype || 'Pickup') === 'Drop' ? 'DESTINATION (CUSTOMER)' : 'PICKUP LOCATION'}</div>
                                <div class="text-sm font-bold text-on-surface">${(req.pickupDropType || req.pickup_drop_type || req.pickupdroptype || 'Pickup') === 'Drop' ? (req.drop_address || req.dropaddress || req.pickup_address || req.pickupaddress || 'Address not specified') : (req.pickup_address || req.pickupaddress || 'Address not specified')}</div>
                            </div>
                        </div>
                        <div class="flex items-start gap-3">
                            <span class="material-symbols-outlined text-primary text-[20px] mt-0.5">location_on</span>
                            <div>
                                <div class="text-[10px] text-on-surface-variant font-bold uppercase">DESTINATION</div>
                                <div class="text-sm font-bold text-on-surface">${statusText}</div>
                            </div>
                        </div>
                    </div>
                    
                    <!-- Earning Breakdown -->
                    <div style="background:rgba(16,185,129,0.05); border:1px solid rgba(16,185,129,0.15); border-radius:12px; padding:12px; display:flex; flex-direction:column; gap:6px;">
                        <div style="font-family:'Plus Jakarta Sans',sans-serif; font-size:0.85rem; color:#10B981; display:flex; align-items:center; gap:6px; font-weight:800;">
                            <span class="material-symbols-outlined" style="font-size:16px;">payments</span>
                            <span>
                                ₹${req.marshalcommission ? (req.marshalcommission - (req.extraAmount || req.extraamount || 0)) : 0} 
                                ${(req.extraAmount || req.extraamount) > 0 ? ` + ₹${req.extraAmount || req.extraamount} Extra!` : ''} 
                                + ₹${t.status === 'completed' ? (req.bonusAmount || req.bonusamount || 0) : (window.globalSettings?.five_star_bonus || 50)} ${(req.bonusAmount || req.bonusamount) ? 'earned ' : ''}bonus
                            </span>
                        </div>
                        ${t.status === 'completed' ? `
                        <div style="font-size:0.75rem; color:var(--text-muted); display:flex; align-items:center; gap:4px;">
                            <span class="material-symbols-outlined" style="font-size:14px;">info</span>
                            Amount will be credited to your account after ${window.globalSettings?.payout_days || 3} days.
                        </div>` : ''}
                    </div>

                    ${actionBtn}
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error(err);
        list.innerHTML = `<div class="empty-state p-10 text-center text-error border border-error/20 rounded-xl border-dashed"><p class="text-sm">Failed to load active trips</p></div>`;
    }
}

function renderUserStatus(user) {
    if (!user) return;
    try {
        const checkbox = document.getElementById('status-toggle');
        if (checkbox) {
            const kyc = user.kycStatus || user.kycstatus || '';
            const isApproved = kyc === 'approved' || kyc === 'Approved' || kyc === 'verified' || kyc === 'Verified';
            
            if (!isApproved) {
                checkbox.checked = false;
                checkbox.disabled = true;
                window.marshalIsOffline = true;
                
                const toggleContainer = checkbox.parentElement;
                if (toggleContainer) {
                    toggleContainer.classList.add('opacity-50', 'pointer-events-none');
                }
                const statusText = document.getElementById('status-label');
                if (statusText) {
                    statusText.innerText = 'Offline (KYC Unapproved)';
                }
                const statusDot = document.getElementById('status-dot');
                if (statusDot) {
                    statusDot.className = 'w-2 h-2 rounded-full bg-error';
                }
            } else {
                checkbox.disabled = false;
                const toggleContainer = checkbox.parentElement;
                if (toggleContainer) {
                    toggleContainer.classList.remove('opacity-50', 'pointer-events-none');
                }
                const isOnlineVal = user.is_online === 1 || user.is_online === '1' || user.is_online === true;
                checkbox.checked = isOnlineVal;
                window.marshalIsOffline = !isOnlineVal;
                const statusText = document.getElementById('status-label');
                if (statusText) {
                    statusText.innerText = window.marshalIsOffline ? 'Offline' : 'Online';
                }
                const statusDot = document.getElementById('status-dot');
                if (statusDot) {
                    statusDot.className = window.marshalIsOffline ? 'w-2 h-2 rounded-full bg-error' : 'w-2 h-2 rounded-full bg-green-500';
                }
            }
        }
        const isEmailVerified = !!(user.emailVerified && user.emailVerified !== '0' && user.emailVerified !== 0);
        const isPhoneVerified = !!(user.phoneVerified && user.phoneVerified !== '0' && user.phoneVerified !== 0);
        const isPanVerified = !!(user.panVerified && user.panVerified !== '0' && user.panVerified !== 0);
        const isAadhaarVerified = !!(user.aadhaarVerified && user.aadhaarVerified !== '0' && user.aadhaarVerified !== 0);
        const isDlVerified = !!((user.dlBikeVerified || user.dlCarVerified) && (user.dlBikeVerified !== '0' && user.dlBikeVerified !== 0 || user.dlCarVerified !== '0' && user.dlCarVerified !== 0));

        const setBadge = (id, condition) => {
            const parent = document.getElementById(id);
            if (!parent) return;
            const el = parent.querySelector('.v-badge');
            if (!el) return;
            if (condition) {
                el.className = 'v-badge text-[10px] font-bold px-2 py-1 rounded-full uppercase bg-success/10 text-success border border-success';
                el.textContent = 'Verified';
            } else {
                el.className = 'v-badge text-[10px] font-bold px-2 py-1 rounded-full uppercase bg-warning/10 text-warning border border-warning';
                el.textContent = 'Pending';
            }
        };

                setBadge('v-email', isEmailVerified);
        const emailOtp = document.getElementById('email-otp-boxes-section');
        if (emailOtp) emailOtp.style.display = isEmailVerified ? 'none' : 'flex';
        const emailInput = document.getElementById('email-display');
        if (emailInput && user.email) emailInput.value = user.email;
        const emailSendBtn = document.getElementById('email-send-otp-btn');
        if (emailSendBtn) emailSendBtn.style.display = isEmailVerified ? 'none' : 'block';

        setBadge('v-phone', isPhoneVerified);
        const phoneOtp = document.getElementById('phone-otp-boxes-section');
        if (phoneOtp) phoneOtp.style.display = isPhoneVerified ? 'none' : 'flex';
        const phoneInput = document.getElementById('phone-display');
        if (phoneInput && user.phone) phoneInput.value = user.phone;

        const isApproved = isKycApproved(user);
        const hasPan = !!(user.panNumber || user.pannumber);
        const hasAadhaar = !!(user.aadhaarNumber || user.aadhaarnumber);

        setBadge('v-pan', isApproved && isPanVerified);
        const panDisplay = document.getElementById('pan-display');
        if (panDisplay) {
            panDisplay.textContent = user.panNumber || (hasAadhaar ? 'Not Provided' : '-');
        }

        setBadge('v-aadhaar', isApproved && isAadhaarVerified);
        const aadhaarDisplay = document.getElementById('aadhaar-display');
        if (aadhaarDisplay) {
            aadhaarDisplay.textContent = user.aadhaarNumber || (hasPan ? 'Not Provided' : '-');
        }

        setBadge('v-dl', isApproved && isDlVerified);
        const dlDisplay = document.getElementById('dl-display');
        if (dlDisplay) dlDisplay.textContent = user.dlNumber || '-';


        // ── Render Bank & Payout Card ───────────────────────────────────────
        const bankBadge = document.getElementById('bank-status-badge');
        const bankCardBody = document.getElementById('bank-payout-card-body');
        if (bankCardBody) {
            const hasBank = !!(user.bankAccountNumber || user.bankaccountnumber);
            const accNum = user.bankAccountNumber || user.bankaccountnumber || '';
            const maskedAcc = accNum ? (accNum.length > 4 ? `•••• •••• ${accNum.slice(-4)}` : accNum) : '';
            const bName = user.bankName || user.bankname || '';
            const holderName = user.bankAccountName || user.bankaccountname || '';
            const ifsc = user.bankIFSC || user.bankifsc || '';

            if (!isApproved) {
                if (bankBadge) {
                    bankBadge.className = 'v-badge text-[10px] font-bold px-2 py-1 rounded-full uppercase bg-white/5 text-gray-400 border border-white/10';
                    bankBadge.textContent = 'Locked';
                }
                bankCardBody.innerHTML = `
                    <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 14px; display: flex; align-items: center; gap: 12px;">
                        <span class="material-symbols-outlined text-gray-500" style="font-size: 22px;">lock</span>
                        <div>
                            <div style="font-size: 0.85rem; font-weight: 700; color: #d4d4d8;">Bank Account Setup Locked</div>
                            <div style="font-size: 0.72rem; color: var(--text-muted);">Available after your KYC documents are approved.</div>
                        </div>
                    </div>
                `;
            } else if (!hasBank) {
                if (bankBadge) {
                    bankBadge.className = 'v-badge text-[10px] font-bold px-2 py-1 rounded-full uppercase bg-warning/10 text-warning border border-warning';
                    bankBadge.textContent = 'Action Required';
                }
                bankCardBody.innerHTML = `
                    <div style="background: rgba(250,204,21,0.04); border: 1px solid rgba(250,204,21,0.2); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 10px;">
                        <div style="font-size: 0.85rem; color: #e4e4e7; line-height: 1.4;">
                            No bank account linked. Add your account to receive automated trip payouts.
                        </div>
                        <button id="btn-open-add-bank" onclick="openBankDetailsModal()" style="background: #FACC15; color: #000; font-weight: 800; font-size: 0.82rem; border: none; border-radius: 8px; padding: 10px 16px; width: fit-content; cursor: pointer; display: flex; align-items: center; gap: 6px;">
                            <span class="material-symbols-outlined" style="font-size: 16px;">add</span>
                            Add Bank Details
                        </button>
                    </div>
                `;
            } else {
                if (bankBadge) {
                    bankBadge.className = 'v-badge text-[10px] font-bold px-2 py-1 rounded-full uppercase bg-success/10 text-success border border-success';
                    bankBadge.textContent = 'Linked';
                }
                bankCardBody.innerHTML = `
                    <div style="background: rgba(16,185,129,0.04); border: 1px solid rgba(16,185,129,0.2); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 8px;">
                        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                            <div>
                                <div id="display-payout-bank-name" style="font-size: 0.95rem; font-weight: 800; color: #fff;">${bName}</div>
                                <div id="display-payout-acc-num" style="font-size: 0.85rem; font-weight: 700; color: #10B981; font-family: monospace; letter-spacing: 1px; margin-top: 2px;">${maskedAcc}</div>
                            </div>
                            <button id="btn-open-edit-bank" onclick="openBankDetailsModal()" style="background: rgba(255,255,255,0.06); color: #FACC15; border: 1px solid rgba(250,204,21,0.3); border-radius: 6px; padding: 6px 12px; font-size: 0.75rem; font-weight: 700; cursor: pointer;">
                                Update
                            </button>
                        </div>
                        <div style="display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--text-muted); margin-top: 4px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 6px;">
                            <span>Holder: <strong id="display-payout-holder" style="color: #d4d4d8;">${holderName}</strong></span>
                            <span>IFSC: <strong id="display-payout-ifsc" style="color: #d4d4d8;">${ifsc}</strong></span>
                        </div>
                    </div>
                `;
            }
        }

        // Render Payout & Subscription Plan Card
        if (typeof window.renderPayoutPlanCard === 'function') {
            window.renderPayoutPlanCard(user);
        }

        const isVerified = isEmailVerified && isPhoneVerified && isApproved && isPanVerified && isAadhaarVerified && isDlVerified;

        const banner = document.getElementById('verification-status-banner');
        const iconSpan = document.querySelector('.status-icon');
        if (banner && iconSpan) {
            if (isVerified) {
                banner.className = 'bg-success/10 border border-success/30 rounded-xl p-4 flex items-center gap-4';
                document.getElementById('status-title').textContent = 'Fully Verified';
                document.getElementById('status-desc').textContent = 'You are eligible to accept trips and earn incentives.';
                iconSpan.className = 'material-symbols-outlined status-icon text-success text-4xl';
                iconSpan.textContent = 'verified';
                iconSpan.removeAttribute('data-lucide');
            } else {
                const kycVal = user.kycStatus || user.kycstatus;
                if (!kycVal || kycVal === 'pending_submission' || kycVal === 'not_started') {
                    const hasUploadedBefore = !!(user.panPhotoUrl || user.panphotourl || user.aadhaarPhotoUrl || user.aadhaarphotourl || user.dlUrl || user.dlurl);
                    const titleText = hasUploadedBefore ? 'Action Required: Re-submit KYC' : 'Action Required: Complete KYC';
                    const descText = hasUploadedBefore ? 'The admin has requested you to re-submit your verification documents. Please review and update your details.' : 'Please submit your verification documents to unlock pickups.';
                    const btnText = hasUploadedBefore ? 'Re-submit KYC Now' : 'Complete KYC Now';

                    banner.className = 'bg-warning/10 border border-warning/30 rounded-xl p-4 flex items-center gap-4';
                    document.getElementById('status-title').textContent = titleText;
                    document.getElementById('status-desc').innerHTML = `${descText}<br><button class="btn btn-primary" style="margin-top: 12px; font-weight: bold; border-radius: 8px; padding: 10px 16px; width: 100%; cursor: pointer;" onclick="openOnboarding()">${btnText}</button>`;
                    iconSpan.className = 'material-symbols-outlined status-icon text-warning text-4xl';
                    iconSpan.textContent = 'pending_actions';
                    iconSpan.removeAttribute('data-lucide');
                } else if (kycVal === 'pending_approval' || kycVal === 'Pending Approval') {
                    banner.className = 'bg-warning/10 border border-warning/30 rounded-xl p-4 flex items-center gap-4';
                    document.getElementById('status-title').textContent = 'Pending Approval';
                    document.getElementById('status-desc').innerHTML = 'Your documents have been submitted securely and are currently under review by our team. Please wait for approval.';
                    iconSpan.className = 'material-symbols-outlined status-icon text-warning text-4xl';
                    iconSpan.textContent = 'hourglass_empty';
                    iconSpan.removeAttribute('data-lucide');
                } else if (kycVal === 'rejected' || kycVal === 'Re-submit KYC') {
                    banner.className = 'bg-error/10 border border-error/30 rounded-xl p-4 flex items-center gap-4';
                    const reasonText = user.kycRejectionReason || user.kycrejectionreason || 'Documents do not meet our criteria.';
                    document.getElementById('status-title').textContent = 'Re-submit';
                    document.getElementById('status-desc').innerHTML = `Reason: ${reasonText}<br><button class="btn" style="background-color: #ef4444; color: #fff; margin-top: 12px; font-weight: bold; border: none; border-radius: 8px; padding: 10px 16px; width: 100%; cursor: pointer;" onclick="openOnboarding()">Re-submit KYC Now</button>`;
                    iconSpan.className = 'material-symbols-outlined status-icon text-error text-4xl';
                    iconSpan.textContent = 'error';
                    iconSpan.removeAttribute('data-lucide');
                } else if (isApproved) {
                    banner.className = 'bg-success/10 border border-success/30 rounded-xl p-4 flex items-center gap-4';
                    document.getElementById('status-title').textContent = 'KYC Approved';
                    document.getElementById('status-desc').innerHTML = 'Your KYC has been approved! Ensure all verifications are completed.';
                    iconSpan.className = 'material-symbols-outlined status-icon text-success text-4xl';
                    iconSpan.textContent = 'check_circle';
                    iconSpan.removeAttribute('data-lucide');
                }
            }
        }
        if (typeof lucide !== 'undefined') lucide.createIcons();
    } catch (e) {
        console.error('Error rendering status:', e);
    }
}

// ── Standalone Post-KYC Bank & Payout Module ──────────────────────────────
const TOP_INDIAN_BANKS = [
    "State Bank of India", "HDFC Bank", "ICICI Bank", "Axis Bank", "Punjab National Bank",
    "Bank of Baroda", "Kotak Mahindra Bank", "Canara Bank", "Union Bank of India", "Bank of India",
    "IndusInd Bank", "IDBI Bank", "Yes Bank", "Federal Bank", "Central Bank of India",
    "Indian Bank", "UCO Bank", "Indian Overseas Bank", "Punjab & Sind Bank", "IDFC FIRST Bank",
    "Bandhan Bank", "RBL Bank", "Au Small Finance Bank", "Equitas Small Finance Bank",
    "Airtel Payments Bank", "Paytm Payments Bank", "Jio Payments Bank", "India Post Payments Bank"
];

window.openBankDetailsModal = function() {
    if (!currentUser) return;
    const kyc = currentUser.kycStatus || currentUser.kycstatus || '';
    const isApproved = kyc === 'approved' || kyc === 'Approved' || kyc === 'verified' || kyc === 'Verified';
    if (!isApproved) {
        showToast('Bank details can only be added after your KYC is approved.', 'warning');
        return;
    }

    const modal = document.getElementById('bank-details-modal');
    if (!modal) return;

    const nameEl = document.getElementById('payout-account-holder-name');
    const searchEl = document.getElementById('payout-bank-search');
    const hiddenBankEl = document.getElementById('payout-bank-name');
    const accEl = document.getElementById('payout-account-number');
    const confirmAccEl = document.getElementById('payout-confirm-account-number');
    const ifscEl = document.getElementById('payout-ifsc');
    const modalTitle = document.getElementById('bank-modal-title');

    const existingAcc = currentUser.bankAccountNumber || currentUser.bankaccountnumber || '';
    const existingBank = currentUser.bankName || currentUser.bankname || '';
    const existingHolder = currentUser.bankAccountName || currentUser.bankaccountname || currentUser.name || '';
    const existingIfsc = currentUser.bankIFSC || currentUser.bankifsc || '';

    if (modalTitle) {
        modalTitle.innerHTML = `<span class="material-symbols-outlined text-warning" style="color: #FACC15;">account_balance</span> ${existingAcc ? 'Update Bank Details' : 'Add Bank Details'}`;
    }

    if (nameEl) nameEl.value = existingHolder;
    if (searchEl) searchEl.value = existingBank;
    if (hiddenBankEl) hiddenBankEl.value = existingBank;
    if (accEl) accEl.value = existingAcc;
    if (confirmAccEl) confirmAccEl.value = existingAcc;
    if (ifscEl) ifscEl.value = existingIfsc;

    [nameEl, searchEl, accEl, confirmAccEl, ifscEl].forEach(el => {
        if (el) window.clearKYCFieldError(el);
    });

    initPayoutBankSearch();

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
};

window.closeBankDetailsModal = function() {
    const modal = document.getElementById('bank-details-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
};

function initPayoutBankSearch() {
    const searchInput = document.getElementById('payout-bank-search');
    const hiddenInput = document.getElementById('payout-bank-name');
    const dropdown = document.getElementById('payout-bank-dropdown');
    if (!searchInput || !dropdown) return;

    function renderDropdown(items) {
        if (items.length === 0) {
            dropdown.innerHTML = '<div style="padding: 10px 12px; color: var(--text-muted); font-size: 0.8rem;">No matching bank found</div>';
        } else {
            dropdown.innerHTML = items.map(b => `
                <div class="search-dropdown-item" onclick="selectPayoutBank('${b.replace(/'/g, "\\'")}')" style="padding: 10px 12px; cursor: pointer; color: #fff; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 0.85rem;">
                    ${b}
                </div>
            `).join('');
        }
        dropdown.classList.remove('hidden');
    }

    searchInput.oninput = function() {
        const query = searchInput.value.trim().toLowerCase();
        hiddenInput.value = ''; // invalidate selection until chosen from list
        if (!query) {
            dropdown.classList.add('hidden');
            return;
        }
        const filtered = TOP_INDIAN_BANKS.filter(b => b.toLowerCase().includes(query));
        renderDropdown(filtered);
    };

    searchInput.onfocus = function() {
        const query = searchInput.value.trim().toLowerCase();
        const listToRender = query ? TOP_INDIAN_BANKS.filter(b => b.toLowerCase().includes(query)) : TOP_INDIAN_BANKS;
        renderDropdown(listToRender);
    };

    document.addEventListener('click', function(e) {
        if (!searchInput.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.add('hidden');
        }
    });
}

window.selectPayoutBank = function(bankName) {
    const searchInput = document.getElementById('payout-bank-search');
    const hiddenInput = document.getElementById('payout-bank-name');
    const dropdown = document.getElementById('payout-bank-dropdown');
    if (searchInput) searchInput.value = bankName;
    if (hiddenInput) hiddenInput.value = bankName;
    if (dropdown) dropdown.classList.add('hidden');
    if (searchInput) window.clearKYCFieldError(searchInput);
};

window.validatePayoutBankForm = function() {
    let isValid = true;
    const nameEl = document.getElementById('payout-account-holder-name');
    const searchEl = document.getElementById('payout-bank-search');
    const hiddenBankEl = document.getElementById('payout-bank-name');
    const accEl = document.getElementById('payout-account-number');
    const confirmAccEl = document.getElementById('payout-confirm-account-number');
    const ifscEl = document.getElementById('payout-ifsc');

    // 1. Account Holder Name
    const name = nameEl ? nameEl.value.trim() : '';
    if (!name || !/^[A-Za-z\s.]{2,100}$/.test(name)) {
        window.setKYCFieldError(nameEl, 'Account Holder Name must contain letters, dots, and spaces only.');
        isValid = false;
    } else {
        window.clearKYCFieldError(nameEl);
    }

    // 2. Bank Name (List-only)
    const bankVal = (hiddenBankEl && hiddenBankEl.value.trim()) || (searchEl && searchEl.value.trim()) || '';
    if (!bankVal || !TOP_INDIAN_BANKS.includes(bankVal)) {
        window.setKYCFieldError(searchEl, 'Please select a valid bank from the search list.');
        isValid = false;
    } else {
        window.clearKYCFieldError(searchEl);
    }

    // 3. Account Number
    const accVal = accEl ? accEl.value.trim() : '';
    if (!accVal || !/^[0-9]{9,18}$/.test(accVal)) {
        window.setKYCFieldError(accEl, 'Account Number must be 9-18 numeric digits.');
        isValid = false;
    } else {
        window.clearKYCFieldError(accEl);
    }

    // 4. Confirm Account Number Match
    const confirmAccVal = confirmAccEl ? confirmAccEl.value.trim() : '';
    if (!confirmAccVal || confirmAccVal !== accVal) {
        window.setKYCFieldError(confirmAccEl, 'Account numbers do not match.');
        isValid = false;
    } else {
        window.clearKYCFieldError(confirmAccEl);
    }

    // 5. IFSC Code
    const ifscVal = ifscEl ? ifscEl.value.trim().toUpperCase() : '';
    if (!ifscVal || !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscVal)) {
        window.setKYCFieldError(ifscEl, 'IFSC Code must follow 11-character RBI format (e.g. SBIN0001234).');
        isValid = false;
    } else {
        window.clearKYCFieldError(ifscEl);
    }

    return isValid;
};

window.savePayoutBankDetails = async function() {
    if (!window.validatePayoutBankForm()) {
        showToast('Please correct the highlighted errors before saving.', 'error');
        return;
    }

    const nameEl = document.getElementById('payout-account-holder-name');
    const searchEl = document.getElementById('payout-bank-search');
    const hiddenBankEl = document.getElementById('payout-bank-name');
    const accEl = document.getElementById('payout-account-number');
    const ifscEl = document.getElementById('payout-ifsc');
    const btn = document.getElementById('btn-save-bank-details');

    const accountHolderName = nameEl.value.trim();
    const bankName = (hiddenBankEl && hiddenBankEl.value.trim()) || searchEl.value.trim();
    const accountNumber = accEl.value.trim();
    const ifscCode = ifscEl.value.trim().toUpperCase();

    if (btn) {
        btn.innerHTML = 'Saving...';
        btn.disabled = true;
    }

    try {
        const payload = { accountHolderName, bankName, accountNumber, ifscCode };
        console.log('[PAYOUT_BANK] Submitting bank payload:', payload);

        const res = await fetch(`${API_URL}/workers/${currentUser.id}/bank-details`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Failed to save bank details.');

        // Update local session
        currentUser.bankAccountName = accountHolderName;
        currentUser.bankname = bankName;
        currentUser.bankName = bankName;
        currentUser.bankAccountNumber = accountNumber;
        currentUser.bankaccountnumber = accountNumber;
        currentUser.bankIFSC = ifscCode;
        currentUser.bankifsc = ifscCode;
        safeSetLocalStorage('marshalUser', JSON.stringify(currentUser));

        showToast('Bank details saved successfully!', 'success');
        closeBankDetailsModal();
        renderUserStatus(currentUser);
    } catch (err) {
        console.error('[PAYOUT_BANK_ERROR]', err);
        showToast(err.message, 'error');
    } finally {
        if (btn) {
            btn.innerHTML = 'Save Bank Details';
            btn.disabled = false;
        }
    }
};

// ── Dual Payout Model & Plan Management ───────────────────────────────────
window.fetchPayoutRates = async function() {
    try {
        const res = await fetch(`${API_URL}/payout-rates`);
        if (res.ok) {
            const data = await res.json();
            window._cachedPayoutRates = data.rates;
            return data.rates;
        }
    } catch (e) {
        console.error('Failed to fetch payout rates:', e);
    }
    return {
        commissionRatePercent: 20.0,
        subscriptionDailyPrice: 99.00,
        subscriptionWeeklyPrice: 499.00,
        subscriptionMonthlyPrice: 1499.00,
        subscriptionAnnualPrice: 14999.00
    };
};

window.renderPayoutPlanCard = function(user) {
    const cardBody = document.getElementById('payout-plan-card-body');
    const badge = document.getElementById('payout-plan-badge');
    if (!cardBody) return;

    const model = user.payoutModel || user.payout_model || 'commission';
    const cycle = user.subscriptionCycle || user.subscription_cycle || 'monthly';
    const validUntil = user.subscriptionValidUntil || user.subscription_valid_until;
    const pendingModel = user.pendingPayoutModel || user.pending_payout_model;
    const pendingCycle = user.pendingSubscriptionCycle || user.pending_subscription_cycle;
    const pendingDate = user.pendingEffectiveDate || user.pending_effective_date;

    const isSubscribed = model === 'subscription' && validUntil && new Date(validUntil) >= new Date();

    if (badge) {
        if (isSubscribed) {
            badge.className = 'v-badge';
            badge.style.cssText = 'background: rgba(16,185,129,0.15); color: #10B981; border: 1px solid rgba(16,185,129,0.3); font-weight: 700; padding: 4px 10px; border-radius: 6px; font-size: 0.75rem;';
            badge.textContent = `Subscription (${cycle.toUpperCase()})`;
        } else {
            badge.className = 'v-badge';
            badge.style.cssText = 'background: rgba(250,204,21,0.15); color: #FACC15; border: 1px solid rgba(250,204,21,0.3); font-weight: 700; padding: 4px 10px; border-radius: 6px; font-size: 0.75rem;';
            badge.textContent = 'Commission Plan';
        }
    }

    let planTitle = isSubscribed ? `Active Subscription: ${cycle.charAt(0).toUpperCase() + cycle.slice(1)} Pass` : 'Commission Plan (Per Trip)';
    let planDesc = isSubscribed 
        ? `Keep 100% of all trip earnings with 0% platform commission deduction.` 
        : `Pay platform commission % on completed trips. Zero upfront fees.`;
    
    let subDetails = '';
    if (isSubscribed && validUntil) {
        const d = new Date(validUntil).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
        subDetails = `<div style="font-size: 0.75rem; color: #10B981; margin-top: 4px;">Valid until: <strong>${d}</strong></div>`;
    }

    let pendingBanner = '';
    if (pendingModel) {
        const pCycleText = pendingCycle ? ` (${pendingCycle.toUpperCase()})` : '';
        const effText = pendingDate ? new Date(pendingDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'next cycle';
        pendingBanner = `
            <div style="background: rgba(250,204,21,0.08); border: 1px dashed rgba(250,204,21,0.4); border-radius: 8px; padding: 10px 12px; margin-top: 10px; display: flex; align-items: center; gap: 8px; font-size: 0.75rem; color: #FACC15;">
                <span class="material-symbols-outlined" style="font-size: 16px;">schedule</span>
                <span>Switch requested: <strong>${pendingModel.toUpperCase()}${pCycleText}</strong> will take effect on <strong>${effText}</strong>.</span>
            </div>
        `;
    }

    cardBody.innerHTML = `
        <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 8px;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                <div>
                    <div style="font-size: 0.95rem; font-weight: 800; color: #fff;">${planTitle}</div>
                    <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 2px;">${planDesc}</div>
                    ${subDetails}
                </div>
                <button id="btn-open-change-plan" onclick="openPayoutPlanModal()" style="background: rgba(250,204,21,0.1); color: #FACC15; border: 1px solid rgba(250,204,21,0.3); border-radius: 6px; padding: 6px 12px; font-size: 0.75rem; font-weight: 700; cursor: pointer; white-space: nowrap;">
                    Change Plan
                </button>
            </div>
            ${pendingBanner}
        </div>
    `;
};

window.openPayoutPlanModal = async function() {
    const modal = document.getElementById('payout-plan-modal');
    if (!modal) return;

    const rates = await window.fetchPayoutRates();
    
    const commRateEl = document.getElementById('plan-commission-rate-display');
    if (commRateEl) commRateEl.textContent = `${rates.commissionRatePercent}% Cut / Trip`;

    const pDaily = document.getElementById('price-daily-display');
    if (pDaily) pDaily.textContent = `₹${rates.subscriptionDailyPrice}`;
    const pWeekly = document.getElementById('price-weekly-display');
    if (pWeekly) pWeekly.textContent = `₹${rates.subscriptionWeeklyPrice}`;
    const pMonthly = document.getElementById('price-monthly-display');
    if (pMonthly) pMonthly.textContent = `₹${rates.subscriptionMonthlyPrice}`;
    const pAnnual = document.getElementById('price-annual-display');
    if (pAnnual) pAnnual.textContent = `₹${rates.subscriptionAnnualPrice}`;

    const model = (currentUser && (currentUser.payoutModel || currentUser.payout_model)) || 'commission';
    const lastSwitched = currentUser && (currentUser.payoutModelLastSwitchedAt || currentUser.payout_model_last_switched_at);
    
    // Select radio
    const commRadio = document.querySelector('input[name="payout_model_choice"][value="commission"]');
    const subRadio = document.querySelector('input[name="payout_model_choice"][value="subscription"]');
    if (model === 'subscription' && subRadio) subRadio.checked = true;
    else if (commRadio) commRadio.checked = true;

    window.onPayoutPlanChoiceChanged();

    // Check calendar month rule
    const limitBanner = document.getElementById('payout-month-limit-banner');
    const saveBtn = document.getElementById('btn-save-payout-plan');
    let canSwitch = true;
    if (lastSwitched) {
        const last = new Date(lastSwitched);
        const now = new Date();
        if (last.getFullYear() === now.getFullYear() && last.getMonth() === now.getMonth()) {
            canSwitch = false;
        }
    }

    if (!canSwitch) {
        if (limitBanner) limitBanner.classList.remove('hidden');
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.style.opacity = '0.5';
            saveBtn.style.cursor = 'not-allowed';
        }
    } else {
        if (limitBanner) limitBanner.classList.add('hidden');
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.style.opacity = '1';
            saveBtn.style.cursor = 'pointer';
        }
    }

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
};

window.closePayoutPlanModal = function() {
    const modal = document.getElementById('payout-plan-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
};

window.onPayoutPlanChoiceChanged = function() {
    const subChoice = document.querySelector('input[name="payout_model_choice"]:checked');
    const cycleContainer = document.getElementById('subscription-cycles-container');
    const effText = document.getElementById('effective-date-text');

    if (subChoice && subChoice.value === 'subscription') {
        if (cycleContainer) cycleContainer.style.display = 'block';
        if (effText) effText.textContent = 'Subscription pass will take effect on the 1st of next calendar month.';
    } else {
        if (cycleContainer) cycleContainer.style.display = 'none';
        if (effText) effText.textContent = 'Switch to Commission will take effect on your next cycle after current pre-paid access.';
    }
};

window.submitPayoutPlanSwitch = async function() {
    const modelChoice = document.querySelector('input[name="payout_model_choice"]:checked');
    if (!modelChoice) return;

    const requestedModel = modelChoice.value;
    let requestedCycle = 'monthly';
    if (requestedModel === 'subscription') {
        const cycleChoice = document.querySelector('input[name="subscription_cycle_choice"]:checked');
        requestedCycle = cycleChoice ? cycleChoice.value : 'monthly';
    }

    const btn = document.getElementById('btn-save-payout-plan');
    if (btn) {
        btn.innerHTML = 'Processing...';
        btn.disabled = true;
    }

    try {
        if (requestedModel === 'subscription') {
            // 1. Create Razorpay Order
            const orderRes = await fetch(`${API_URL}/driver/subscription/create-order`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ driverId: currentUser.id, cycle: requestedCycle })
            });
            const orderData = await orderRes.json().catch(() => ({}));
            if (!orderRes.ok) throw new Error(orderData.error || 'Failed to initialize subscription checkout.');

            // 2. Open Razorpay Checkout or Sandbox verification
            if (window.Razorpay) {
                const options = {
                    key: orderData.keyId,
                    amount: orderData.amount,
                    currency: orderData.currency || 'INR',
                    name: 'ReDrivo Marshal Network',
                    description: `Driver ${orderData.cycle.toUpperCase()} Subscription Pass`,
                    order_id: orderData.orderId,
                    prefill: {
                        name: currentUser.name || 'Driver Partner',
                        contact: currentUser.phone || ''
                    },
                    theme: { color: '#FACC15' },
                    handler: async function (response) {
                        try {
                            const verifyRes = await fetch(`${API_URL}/driver/subscription/verify`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    orderId: response.razorpay_order_id || orderData.orderId,
                                    paymentId: response.razorpay_payment_id,
                                    signature: response.razorpay_signature,
                                    driverId: currentUser.id
                                })
                            });
                            const verifyData = await verifyRes.json().catch(() => ({}));
                            if (!verifyRes.ok) throw new Error(verifyData.error || 'Payment verification failed.');

                            currentUser.payoutModel = 'subscription';
                            currentUser.payout_model = 'subscription';
                            currentUser.subscriptionCycle = orderData.cycle;
                            currentUser.subscription_cycle = orderData.cycle;
                            currentUser.subscriptionValidUntil = verifyData.user?.subscription_valid_until;
                            currentUser.subscription_valid_until = verifyData.user?.subscription_valid_until;
                            currentUser.pendingPayoutModel = null;
                            currentUser.pending_payout_model = null;
                            safeSetLocalStorage('marshalUser', JSON.stringify(currentUser));

                            showToast('Payment successful! Subscription pass activated.', 'success');
                            closePayoutPlanModal();
                            renderPayoutPlanCard(currentUser);
                        } catch (vErr) {
                            showToast(vErr.message, 'error');
                        } finally {
                            if (btn) { btn.innerHTML = 'Confirm Plan'; btn.disabled = false; }
                        }
                    },
                    modal: {
                        ondismiss: function() {
                            showToast('Payment cancelled. Your plan remains unchanged.', 'info');
                            if (btn) { btn.innerHTML = 'Confirm Plan'; btn.disabled = false; }
                        }
                    }
                };
                const rzp = new Razorpay(options);
                rzp.open();
            } else {
                // Sandbox fallback when SDK is not present
                const simVerifyRes = await fetch(`${API_URL}/driver/subscription/verify`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        orderId: orderData.orderId,
                        paymentId: `pay_test_${Date.now()}`,
                        signature: 'sig_test_sandbox',
                        driverId: currentUser.id
                    })
                });
                const verifyData = await simVerifyRes.json().catch(() => ({}));
                if (!simVerifyRes.ok) throw new Error(verifyData.error || 'Payment verification failed.');

                currentUser.payoutModel = 'subscription';
                currentUser.payout_model = 'subscription';
                currentUser.subscriptionCycle = orderData.cycle;
                currentUser.subscription_cycle = orderData.cycle;
                currentUser.subscriptionValidUntil = verifyData.user?.subscription_valid_until;
                currentUser.subscription_valid_until = verifyData.user?.subscription_valid_until;
                currentUser.pendingPayoutModel = null;
                currentUser.pending_payout_model = null;
                safeSetLocalStorage('marshalUser', JSON.stringify(currentUser));

                showToast('Sandbox payment verified! Subscription pass activated.', 'success');
                closePayoutPlanModal();
                renderPayoutPlanCard(currentUser);
                if (btn) { btn.innerHTML = 'Confirm Plan'; btn.disabled = false; }
            }
        } else {
            // Free downgrade to commission
            const res = await fetch(`${API_URL}/workers/${currentUser.id}/payout-plan`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ requestedModel, requestedCycle: null })
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Failed to submit plan switch.');

            currentUser.pendingPayoutModel = data.pendingPlan.model;
            currentUser.pending_payout_model = data.pendingPlan.model;
            currentUser.pendingSubscriptionCycle = data.pendingPlan.cycle;
            currentUser.pending_subscription_cycle = data.pendingPlan.cycle;
            currentUser.pendingEffectiveDate = data.pendingPlan.effectiveDate;
            currentUser.pending_effective_date = data.pendingPlan.effectiveDate;
            currentUser.payoutModelLastSwitchedAt = new Date().toISOString();
            currentUser.payout_model_last_switched_at = new Date().toISOString();
            safeSetLocalStorage('marshalUser', JSON.stringify(currentUser));

            showToast(data.message || 'Plan switch request confirmed!', 'success');
            closePayoutPlanModal();
            renderPayoutPlanCard(currentUser);
            if (btn) { btn.innerHTML = 'Confirm Plan'; btn.disabled = false; }
        }
    } catch (err) {
        console.error('[PAYOUT_PLAN_ERROR]', err);
        showToast(err.message, 'error');
        if (btn) {
            btn.innerHTML = 'Confirm Plan';
            btn.disabled = false;
        }
    }
};

async function updateStatusDisplay() {
    if (!currentUser) return;
    try {
        let res = await fetch(`${API_URL}/users/${currentUser.id}?t=${Date.now()}`, { cache: 'no-store' });
        let user = null;
        if (res.ok) {
            user = await res.json();
        } else {
            console.warn('Single user profile fetch failed.');
        }
        if (user) {
            // Check for status change to pending_submission or rejected to trigger overlay
            const oldStatus = currentUser.kycStatus || currentUser.kycstatus;
            const newStatus = user.kycStatus || user.kycstatus;
            if (oldStatus !== newStatus && (newStatus === 'pending_submission' || newStatus === 'rejected' || newStatus === 'Re-submit KYC')) {
                sessionStorage.removeItem('skipKYC');
            }

            user = normalizeUser(user);
            currentUser = { ...currentUser, ...user };
            safeSetLocalStorage('marshalUser', JSON.stringify(currentUser));
            
            // Sync onboarding overlay visibility
            checkOnboarding();
        }
        renderUserStatus(currentUser);
    } catch (err) {
        console.error('Failed to update status from server, using cache', err);
        renderUserStatus(currentUser);
    }
}

window.sendPhoneOTP = async function() {
    const phone = document.getElementById('phone-display').value.trim();
    if (!phone) {
        showToast('Please enter a valid phone number', 'error');
        return;
    }
    try {
        await fetch(`${API_URL}/auth/send-otp`, { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({phone: phone}) });
        showToast('OTP sent to ' + phone, 'success');
        document.getElementById('phone-otp-boxes-section').style.display = 'flex';
    } catch(err) {
        showToast('Failed to send OTP', 'error');
    }
};

window.sendEmailOTP = async function() {
    const email = document.getElementById('email-display').value.trim();
    if (!email || !email.includes('@')) {
        showToast('Please enter a valid email address', 'error');
        return;
    }
    try {
        await fetch(`${API_URL}/auth/send-otp`, { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email: email}) });
        showToast('OTP sent to ' + email, 'success');
        document.getElementById('email-otp-boxes-section').style.display = 'flex';
    } catch(err) {
        showToast('Failed to send OTP', 'error');
    }
};

window.verifyEmailOTP = async function() {
    const inputs = document.querySelectorAll('#email-otp-boxes-section .email-otp-box');
    let otp = '';
    inputs.forEach(i => otp += i.value);
    
    if (otp.length !== 6) {
        showToast('Please enter a 6-digit OTP', 'error');
        return;
    }

    const email = document.getElementById('email-display').value.trim();

    try {
        const res = await fetch(`${API_URL}/users/${currentUser.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ emailVerified: 1, email: email })
        });
        if (!res.ok) throw new Error('Verification failed');
        
        showToast('Email verified successfully!', 'success');
        updateStatusDisplay();
    } catch (err) {
        showToast(err.message, 'error');
    }
};

window.verifyPhoneOTP = async function() {
    const inputs = document.querySelectorAll('#phone-otp-boxes-section .phone-otp-box');
    let otp = '';
    inputs.forEach(i => otp += i.value);
    
    if (otp.length !== 6) {
        showToast('Please enter a 6-digit OTP', 'error');
        return;
    }

    const phone = document.getElementById('phone-display').value.trim();

    try {
        const res = await fetch(`${API_URL}/users/${currentUser.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phoneVerified: 1, phone: phone })
        });
        if (!res.ok) throw new Error('Verification failed');
        
        showToast('Phone verified successfully!', 'success');
        updateStatusDisplay();
    } catch (err) {
        showToast(err.message, 'error');
    }
};

window.toggleEdit = async function(field) {
    const input = document.getElementById(`${field}-display`);
    const btn = document.getElementById(`${field}-edit-btn`);
    const isEditing = !input.readOnly;

    if (!isEditing) {
        input.readOnly = false;
        input.focus();
        btn.textContent = 'Save';
        btn.classList.add('btn-primary');
        btn.classList.remove('btn-secondary');
        
        // Show Send OTP button when entering edit mode
        const sendOtpBtn = document.getElementById(`${field}-send-otp-btn`);
        if (sendOtpBtn) sendOtpBtn.style.display = 'block';
        
        // Hide OTP boxes section while typing
        const otpSection = document.getElementById(`${field}-otp-boxes-section`);
        if (otpSection) otpSection.style.display = 'none';
    } else {
        const newVal = input.value.trim();
        if (!newVal) return showToast(`Please enter a valid ${field}`, 'error');
        
        try {
            const payload = {};
            payload[field] = newVal;
            
            const res = await fetch(`${API_URL}/users/${currentUser.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Update failed');
            
            input.readOnly = true;
            btn.textContent = 'Edit';
            btn.classList.add('btn-secondary');
            btn.classList.remove('btn-primary');
            
            showToast(`${field} updated. Please verify.`, 'success');
            
            // Show OTP boxes
            document.getElementById(`${field}-otp-boxes-section`).style.display = 'flex';
            // Send OTP
            if (field === 'phone') {
                await fetch(`${API_URL}/auth/send-otp`, { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({phone: newVal}) });
            } else if (field === 'email') {
                await fetch(`${API_URL}/auth/send-otp`, { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email: newVal}) });
            }
            updateStatusDisplay();
        } catch(err) {
            showToast(err.message, 'error');
        }
    }
};

window.logoutMarshal = function() {
    localStorage.removeItem('marshalUser');
    currentUser = null;
    window.location.reload();
};

// --- App Navigation ---
document.addEventListener('DOMContentLoaded', async () => {
    console.log('[DEBUG-TRACKING] DOMContentLoaded fired, boot sequence starting');
    sessionStorage.removeItem('skipKYC');
    const splashScreen = document.getElementById('splash-screen');
    const loginScreen = document.getElementById('login-screen');
    const saved = localStorage.getItem('marshalUser');
    
    if (saved) {
        try {
            const parsedUser = JSON.parse(saved);
            // Validate token/user in background before showing UI
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            const res = await fetch(`${API_URL}/users/${parsedUser.id}?t=${Date.now()}`, { 
                cache: 'no-store',
                signal: controller.signal 
            });
            clearTimeout(timeoutId);
            if (res.ok) {
                const userData = await res.json();
                currentUser = normalizeUser({ ...parsedUser, ...userData });
                safeSetLocalStorage('marshalUser', JSON.stringify(currentUser));
                if (splashScreen) splashScreen.style.display = 'none';
                enterApp();
            } else {
                // Invalid user (e.g. deleted or session invalidated)
                localStorage.removeItem('marshalUser');
                if (splashScreen) splashScreen.style.display = 'none';
                if (loginScreen) loginScreen.style.display = 'flex';
            }
        } catch (e) {
            console.error('Network error during launch validation, proceeding with cache', e);
            currentUser = normalizeUser(JSON.parse(saved));
            if (splashScreen) splashScreen.style.display = 'none';
            enterApp();
        }
    } else {
        if (splashScreen) splashScreen.style.display = 'none';
        if (loginScreen) loginScreen.style.display = 'flex';
    }
    
    // Initialize address select dropdowns
    initAddressDropdowns();
    
    // Sync native declined IDs on app launch
    if (typeof syncNativeDeclinedIds === 'function') syncNativeDeclinedIds();

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && currentUser) {
            if (typeof checkAndRenderBatteryBanner === 'function') checkAndRenderBatteryBanner();
            if (typeof syncNativeDeclinedIds === 'function') syncNativeDeclinedIds();
            refreshUserProfile();
            if (typeof startPickupPolling === 'function') startPickupPolling();
            if (typeof loadAvailablePickups === 'function') loadAvailablePickups();
        }
    });

    // Capacitor App state change resume listener to re-verify battery settings immediately on return
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
        window.Capacitor.Plugins.App.addListener('appStateChange', (state) => {
            if (state && state.isActive && currentUser) {
                console.log('[DEBUG] App resumed to foreground, re-verifying battery gate status...');
                if (typeof checkAndRenderBatteryBanner === 'function') checkAndRenderBatteryBanner();
            }
        });
    }
    
    // OTP Box auto-advance logic
    const setupOtpBoxes = (selector) => {
        const otpBoxes = document.querySelectorAll(selector);
        otpBoxes.forEach((box, index) => {
            box.addEventListener('input', (e) => {
                if (e.target.value && index < otpBoxes.length - 1) {
                    otpBoxes[index + 1].focus();
                }
            });
            box.addEventListener('keydown', (e) => {
                if (e.key === 'Backspace' && !e.target.value && index > 0) {
                    otpBoxes[index - 1].focus();
                }
            });
            box.addEventListener('paste', (e) => {
                e.preventDefault();
                let pastedData = (e.clipboardData || window.clipboardData).getData('text') || '';
                pastedData = pastedData.trim();
                if (pastedData.length > 200) pastedData = pastedData.substring(0, 200); // Prevent Clipboard Bomb
                if (!pastedData) return;
                
                const digits = pastedData.replace(/\D/g, '').split('');
                for (let i = 0; i < digits.length && (index + i) < otpBoxes.length; i++) {
                    otpBoxes[index + i].value = digits[i];
                }
                const nextIndex = Math.min(index + digits.length - 1, otpBoxes.length - 1);
                otpBoxes[nextIndex].focus();
            });
        });
    };
    setupOtpBoxes('.otp-box');
    setupOtpBoxes('.email-otp-box');
    setupOtpBoxes('.phone-otp-box');
});

// --- Camera API & Handover Logic ---
let stream = null;
let mediaRecorder = null;
let recordedChunks = [];
let odoBlob = null;
let videoBlob = null;
let currentTripId = null;
let currentCameraMode = null; // 'odo' or '360'

let deliveryStream = null;
let deliveryMediaRecorder = null;
let deliveryRecordedChunks = [];
let deliveryOdoBlob = null;
let deliveryVideoBlob = null;
let deliveryCameraMode = null; // 'odo' or '360'

window.openMapNavigation = async function(tripId) {
    window.startNavigationFlow(tripId);
}

async function openHandoverModal(tripId, handoverType = 'pickup') {
    currentTripId = tripId;
    window.currentHandoverType = handoverType;
    
    // Clear elements
    document.getElementById('handover-otp').value = '';
    const otpBoxes = document.querySelectorAll('#handover-step-4 .otp-box');
    otpBoxes.forEach(box => box.value = '');
    
    const odoReading = document.getElementById('odo-reading');
    if (odoReading) odoReading.value = '';
    const odoPreview = document.getElementById('odo-preview');
    if (odoPreview) odoPreview.style.display = 'none';
    const videoPreview = document.getElementById('video-preview');
    if (videoPreview) videoPreview.style.display = 'none';
    const step3 = document.getElementById('handover-step-3');
    if (step3) step3.style.display = 'none';
    
    odoBlob = null;
    videoBlob = null;
    
    // Update texts
    const modalTitle = document.querySelector('#handover-modal .brand h2');
    const otpTitle = document.querySelector('#handover-step-4 h3');
    const otpDesc = document.querySelector('#handover-step-4 p');
    const otpBtn = document.querySelector('#handover-step-4 button');
    
    if (handoverType === 'pickup') {
        if (modalTitle) modalTitle.innerHTML = `<span style="vertical-align:middle; display:inline-flex; align-items:center; margin-right:8px;">${HECTOR_SMALL_SVG}</span> Start Trip / Customer Pickup`;
        if (otpTitle) otpTitle.textContent = 'Enter Customer Pickup OTP';
        if (otpDesc) otpDesc.textContent = 'Ask the customer for the Pickup OTP shown in their app.';
        if (otpBtn) otpBtn.textContent = 'Verify OTP & Unlock Camera';
    } else if (handoverType === 'dropoff_garage') {
        if (modalTitle) modalTitle.innerHTML = `<span style="vertical-align:middle; display:inline-flex; align-items:center; margin-right:8px;"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; display: inline-block;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg></span> Driver Dropoff to Garage`;
        if (otpTitle) otpTitle.textContent = 'Enter Garage Dropoff OTP';
        if (otpDesc) otpDesc.textContent = 'Ask the garage partner for the Dropoff OTP shown in their dashboard.';
        if (otpBtn) otpBtn.textContent = 'Verify OTP & Unlock Camera';
    } else if (handoverType === 'pickup_garage') {
        if (modalTitle) modalTitle.innerHTML = `<span style="vertical-align:middle; display:inline-flex; align-items:center; margin-right:8px;"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; display: inline-block;"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg></span> Garage Pickup / Start Delivery`;
        if (otpTitle) otpTitle.textContent = 'Enter Garage Pickup OTP';
        if (otpDesc) otpDesc.textContent = 'Ask the garage partner for the Pickup OTP shown in their dashboard.';
        if (otpBtn) otpBtn.textContent = 'Verify OTP & Unlock Camera';
    }
    
    document.getElementById('handover-modal').classList.remove('hidden');
    
    // Start with OTP verification step
    document.getElementById('handover-step-1').style.display = 'none';
    document.getElementById('handover-step-2').style.display = 'none';
    document.getElementById('handover-step-3').style.display = 'none';
    document.getElementById('handover-step-4').style.display = 'block';
}

function closeHandoverModal() {
    document.getElementById('handover-modal').classList.add('hidden');
    stopKycCamera();
}

window.openDeliveryOtpModal = async function(tripId) {
    currentTripId = tripId;
    deliveryOdoBlob = null;
    deliveryVideoBlob = null;
    
    const otpInput = document.getElementById('delivery-otp');
    if (otpInput) otpInput.value = '';
    const odoInput = document.getElementById('delivery-odo-reading');
    if (odoInput) odoInput.value = '';
    
    const odoPreview = document.getElementById('delivery-odo-preview');
    if (odoPreview) odoPreview.style.display = 'none';
    const videoPreview = document.getElementById('delivery-video-preview');
    if (videoPreview) videoPreview.style.display = 'none';
    
    const modal = document.getElementById('delivery-otp-modal');
    if (modal) modal.classList.remove('hidden');
    
    const mainContent = document.getElementById('delivery-main-content');
    if (mainContent) mainContent.style.display = 'block';
    const controls = document.getElementById('delivery-camera-controls');
    if (controls) controls.style.display = 'none';
    const videoObj = document.getElementById('delivery-camera-feed');
    if (videoObj) videoObj.style.display = 'none';

    // Check trip status to toggle correct step
    try {
        const res = await fetch(`${API_URL}/trips`, { cache: 'no-store' });
        if (res.ok) {
            const trips = await res.json();
            const trip = trips.find(t => t.id === tripId);
            if (trip) {
                const status = trip.status || trip.status;
                if (status === 'pending_delivery') {
                    document.getElementById('delivery-step-media').classList.add('hidden');
                    document.getElementById('delivery-step-otp').classList.remove('hidden');
                    document.getElementById('btn-submit-delivery-media').style.display = 'none';
                    document.getElementById('btn-confirm-delivery').style.display = 'block';
                } else {
                    document.getElementById('delivery-step-media').classList.remove('hidden');
                    document.getElementById('delivery-step-otp').classList.add('hidden');
                    document.getElementById('btn-submit-delivery-media').style.display = 'block';
                    document.getElementById('btn-confirm-delivery').style.display = 'none';
                }
            }
        }
    } catch (e) {
        console.error("Error setting up delivery modal steps:", e);
    }
};

// --- Native Camera Permission Bridge ---
async function ensureNativeCameraPermission() {
    if (window.Capacitor && window.Capacitor.isPluginAvailable('Camera')) {
        const { Camera } = window.Capacitor.Plugins;
        try {
            const check = await Camera.checkPermissions();
            if (check.camera !== 'granted') {
                const req = await Camera.requestPermissions({ permissions: ['camera'] });
                if (req.camera !== 'granted') {
                    showToast('Camera permission is required to capture photos. Please enable it in Android Settings.', 'error');
                    return false;
                }
            }
            return true;
        } catch (e) {
            console.warn('[Camera Permission Warning]', e);
        }
    }
    return true;
}

async function getMediaStreamWithFallback(facingPreference, withAudio = false) {
    const hasPermission = await ensureNativeCameraPermission();
    if (!hasPermission) {
        throw new Error("Camera permission was denied. Please enable camera permissions in Android Settings.");
    }
    const attempts = [
        { video: { facingMode: { ideal: facingPreference } }, audio: withAudio },
        { video: { facingMode: facingPreference }, audio: withAudio },
        { video: true, audio: withAudio }
    ];
    let lastError = null;
    for (const constraints of attempts) {
        try {
            return await navigator.mediaDevices.getUserMedia(constraints);
        } catch (err) {
            console.warn(`Camera constraint failed: ${JSON.stringify(constraints)}`, err);
            lastError = err;
        }
    }
    throw lastError || new Error("No camera devices accessible.");
}

window.closeDeliveryOtpModal = function() {
    stopDeliveryKycCamera();
    const modal = document.getElementById('delivery-otp-modal');
    if (modal) modal.classList.add('hidden');
};

window.startDeliveryCamera = async function(mode) {
    deliveryCameraMode = mode;
    const videoObj = document.getElementById('delivery-camera-feed');
    const controls = document.getElementById('delivery-camera-controls');
    const mainContent = document.getElementById('delivery-main-content');
    
    document.getElementById('btn-delivery-capture-photo').style.display = 'none';
    document.getElementById('btn-delivery-start-record').style.display = 'none';
    document.getElementById('btn-delivery-stop-record').style.display = 'none';
    document.getElementById('btn-submit-delivery-media').style.display = 'none';
    document.getElementById('btn-confirm-delivery').style.display = 'none';

    try {
        if (deliveryStream) {
            deliveryStream.getTracks().forEach(t => t.stop());
            deliveryStream = null;
        }
        deliveryStream = await getMediaStreamWithFallback('environment', mode === '360');
        videoObj.srcObject = deliveryStream;
        videoObj.muted = true;
        videoObj.setAttribute('playsinline', '');
        videoObj.setAttribute('autoplay', '');
        videoObj.style.display = 'block';
        controls.style.display = 'block';
        mainContent.style.display = 'none';

        // 1. Explicitly play delivery video stream
        await videoObj.play().catch(e => console.warn("deliveryVideo.play caught:", e));

        // 2. Wait until frame metadata is loaded
        if (videoObj.videoWidth === 0) {
            await new Promise((resolve) => {
                const onMeta = () => {
                    videoObj.removeEventListener('loadedmetadata', onMeta);
                    resolve();
                };
                videoObj.addEventListener('loadedmetadata', onMeta);
                setTimeout(resolve, 800);
            });
        }

          if (mode === 'odo') {
            document.getElementById('btn-delivery-capture-photo').style.display = 'inline-block';
        } else {
            document.getElementById('btn-delivery-start-record').style.display = 'inline-block';
        }
    } catch (err) {
        console.error("Delivery camera access failed:", err);
        const errMsg = err?.message || String(err);
        if (errMsg.toLowerCase().includes('denied') || errMsg.toLowerCase().includes('permission') || errMsg.toLowerCase().includes('notallowed')) {
            showToast("Camera permission denied. Please allow camera access in Android Settings.", "error");
        } else {
            showToast("Camera access failed: " + errMsg, "error");
        }
    }
};

window.takeDeliveryPhoto = function() {
    const video = document.getElementById('delivery-camera-feed');
    const canvas = document.getElementById('delivery-camera-canvas');
    if (!video || !canvas) return;

    const width = video.videoWidth || video.clientWidth || 1280;
    const height = video.videoHeight || video.clientHeight || 720;
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, width, height);

    canvas.toBlob(blob => {
        if (!blob) {
            showToast("Failed to process photo blob", "error");
            return;
        }
        deliveryOdoBlob = blob;
        document.getElementById('delivery-odo-preview').src = URL.createObjectURL(blob);
        document.getElementById('delivery-odo-preview-wrap').style.display = 'block';
        document.getElementById('btn-delivery-cam-odo').innerHTML = '<span class="material-symbols-outlined" style="vertical-align: middle; font-size:18px;">refresh</span> Retake Odometer Photo';
        stopDeliveryKycCamera();
        showToast("Odometer photo captured!", "success");
    }, 'image/jpeg', 0.85);
};

window.startDeliveryRecording = function() {
    if (!deliveryStream) {
        showToast("No active camera stream for recording", "error");
        return;
    }
    deliveryRecordedChunks = [];
    try {
        let options = { mimeType: 'video/webm;codecs=vp8,opus' };
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            options = { mimeType: 'video/mp4' };
            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                options = {};
            }
        }
        deliveryMediaRecorder = new MediaRecorder(deliveryStream, options);
    } catch (e) {
        console.error("MediaRecorder creation failed:", e);
        showToast("Video recording unsupported on this device.", "error");
        return;
    }

    deliveryMediaRecorder.ondataavailable = function(e) {
        if (e.data && e.data.size > 0) {
            deliveryRecordedChunks.push(e.data);
        }
    };

    deliveryMediaRecorder.onstop = function() {
        const blobType = deliveryMediaRecorder.mimeType || 'video/webm';
        deliveryVideoBlob = new Blob(deliveryRecordedChunks, { type: blobType });
        const videoUrl = URL.createObjectURL(deliveryVideoBlob);
        const preview = document.getElementById('delivery-video-preview');
        preview.src = videoUrl;
        document.getElementById('delivery-video-preview-wrap').style.display = 'block';
        document.getElementById('btn-delivery-record-360').innerHTML = '<span class="material-symbols-outlined" style="vertical-align: middle; font-size:18px;">refresh</span> Re-record 360 Video';
        stopDeliveryKycCamera();
        showToast("360 Walkaround Video saved!", "success");
    };

    deliveryMediaRecorder.start(1000);
    document.getElementById('btn-delivery-start-record').style.display = 'none';
    document.getElementById('btn-delivery-stop-record').style.display = 'inline-block';
    showToast("Recording started... Complete a 360 walkaround.", "info");
};

window.stopDeliveryRecording = function() {
    if (deliveryMediaRecorder && deliveryMediaRecorder.state !== 'inactive') {
        deliveryMediaRecorder.stop();
    }
};

window.stopDeliveryKycCamera = function() {
    if (deliveryStream) {
        deliveryStream.getTracks().forEach(track => track.stop());
        deliveryStream = null;
    }
    const videoObj = document.getElementById('delivery-camera-feed');
    if (videoObj) {
        videoObj.srcObject = null;
        videoObj.style.display = 'none';
    }
    const controls = document.getElementById('delivery-camera-controls');
    if (controls) controls.style.display = 'none';
    const mainContent = document.getElementById('delivery-main-content');
    if (mainContent) mainContent.style.display = 'block';
};

window.submitDeliveryMedia = async function() {
    const odoValue = document.getElementById('delivery-odo-reading').value.trim();

    if (!odoValue) { showToast("Please enter final odometer reading", "error"); return; }
    if (!deliveryOdoBlob) { showToast("Please capture final odometer photo", "error"); return; }
    if (!deliveryVideoBlob) { showToast("Please record 360 walkaround video", "error"); return; }

    if (marshalLat === null || marshalLng === null) {
        showToast("Waiting for GPS lock... Please wait a moment.", "info");
        return;
    }

    const btn = document.getElementById('btn-submit-delivery-media');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Uploading Proof...';

    try {
        const formData = new FormData();
        formData.append('odometerReading', odoValue);
        formData.append('odometerPhoto', deliveryOdoBlob, 'delivery_odo.jpg');
        formData.append('walkaroundVideo', deliveryVideoBlob, 'delivery_360.webm');
        formData.append('lat', marshalLat);
        formData.append('lng', marshalLng);

        const res = await fetch(`${API_URL}/marshal/orders/${currentDeliveryTripId}/deliver`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('redrivo_token')}`
            },
            body: formData
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to submit delivery media');

        showToast('Proof uploaded successfully! Proceed to verify Customer OTP.', 'success');
        
        // Advance to step 2: OTP
        document.getElementById('delivery-step-media').classList.add('hidden');
        document.getElementById('delivery-step-otp').classList.remove('hidden');
        document.getElementById('btn-submit-delivery-media').style.display = 'none';
        document.getElementById('btn-confirm-delivery').style.display = 'block';

    } catch (err) {
        console.error("Delivery submission error:", err);
        showToast(err.message, "error");
        btn.disabled = false;
        btn.textContent = originalText;
    }
};

window.verifyDeliveryOtp = async function() {
    const otp = document.getElementById('delivery-otp').value.trim();

    if (!otp) return showToast("Please enter Handover OTP", "warning");

    const btn = document.getElementById('btn-confirm-delivery');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Verifying Handover...";

    try {
        // Complete Handover with OTP
        const resComplete = await fetch(`${API_URL}/trips/${currentTripId}/complete-delivery`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ otp })
        });
        const data = await resComplete.json();
        if (!resComplete.ok) throw new Error(data.error || "Handover OTP Verification Failed");

        showToast("Delivery and Handover completed successfully!", "success");
        window.closeDeliveryOtpModal();
        localStorage.removeItem('trip_state_' + currentTripId); // Reset navigation flow state
        if (window.stopLocationTracking) window.stopLocationTracking(); // Stop GPS polling when trip is completed
        
        // Trigger Marshal Post-Service Feedback Modal
        document.getElementById('fb-marshal-trip-id').value = currentTripId;
        document.getElementById('marshal-feedback-modal').style.display = 'flex';
        
        if (window.loadMyTrips) loadMyTrips();
    } catch(err) {
        showToast("Handover failed: " + err.message, "error");
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
};

async function startCamera(mode) {
    currentCameraMode = mode;
    const videoObj = document.getElementById('camera-feed');
    const controls = document.getElementById('camera-controls');
    
    document.getElementById('btn-capture-photo').style.display = 'none';
    document.getElementById('btn-start-record').style.display = 'none';
    document.getElementById('btn-stop-record').style.display = 'none';

    try {
        if (stream) {
            stream.getTracks().forEach(t => t.stop());
            stream = null;
        }
        stream = await getMediaStreamWithFallback('environment', mode === '360');
        videoObj.srcObject = stream;
        videoObj.muted = true;
        videoObj.setAttribute('playsinline', '');
        videoObj.setAttribute('autoplay', '');
        videoObj.style.display = 'block';
        controls.style.display = 'block';

        // 1. Explicitly play video stream
        await videoObj.play().catch(e => console.warn("video.play caught:", e));

        // 2. Wait until frame metadata is loaded (videoWidth > 0)
        if (videoObj.videoWidth === 0) {
            await new Promise((resolve) => {
                const onMeta = () => {
                    videoObj.removeEventListener('loadedmetadata', onMeta);
                    resolve();
                };
                videoObj.addEventListener('loadedmetadata', onMeta);
                setTimeout(resolve, 800);
            });
        }

        if (mode === 'odo') {
            document.getElementById('btn-capture-photo').style.display = 'inline-block';
        } else {
            document.getElementById('btn-start-record').style.display = 'inline-block';
        }
    } catch (err) {
        console.error("Camera access failed:", err);
        const errMsg = err?.message || String(err);
        if (errMsg.toLowerCase().includes('denied') || errMsg.toLowerCase().includes('permission') || errMsg.toLowerCase().includes('notallowed')) {
            showToast("Camera permission denied. Please allow camera access in Android Settings.", "error");
        } else {
            showToast("Camera access failed: " + errMsg, "error");
        }
    }
}

function takePhoto() {
    const video = document.getElementById('camera-feed');
    const canvas = document.getElementById('camera-canvas');
    if (!video || !canvas) return;

    const width = video.videoWidth || video.clientWidth || 1280;
    const height = video.videoHeight || video.clientHeight || 720;
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, width, height);

    canvas.toBlob(blob => {
        if (!blob) {
            showToast("Failed to capture image frame. Please retry.", "error");
            return;
        }
        odoBlob = blob;
        const url = URL.createObjectURL(blob);
        const preview = document.getElementById('odo-preview');
        if (preview) {
            preview.src = url;
            preview.style.display = 'block';
        }
        
        stopKycCamera();
        checkEvidenceComplete();
        showToast("Odometer photo captured successfully!", "success");
    }, 'image/jpeg', 0.90);
}

function startRecording() {
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
        videoBlob = new Blob(recordedChunks, { type: 'video/webm' });
        const url = URL.createObjectURL(videoBlob);
        const preview = document.getElementById('video-preview');
        preview.src = url;
        preview.style.display = 'block';
        
        checkEvidenceComplete();
    };
    mediaRecorder.start();
    
    document.getElementById('btn-start-record').style.display = 'none';
    document.getElementById('btn-stop-record').style.display = 'inline-block';
}

function stopRecording() {
    if (mediaRecorder) mediaRecorder.stop();
    stopKycCamera();
}

function stopKycCamera() {
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    document.getElementById('camera-feed').style.display = 'none';
    document.getElementById('camera-controls').style.display = 'none';
}

function checkEvidenceComplete() {
    const odoValue = document.getElementById('odo-reading').value;
    if (odoBlob && videoBlob && odoValue) {
        document.getElementById('handover-step-3').style.display = 'block';
    }
}

async function submitHandoverEvidence() {
    const odoValue = document.getElementById('odo-reading').value;
    if (!odoBlob || !videoBlob || !odoValue) {
        return showToast("Please make sure odometer photo, Walkaround video, and odometer reading are completed.", "warning");
    }
    
    // Determine types and target status based on currentHandoverType
    let odoDocType = 'odometer_start';
    let walkaroundDocType = '360_pickup';
    let targetTripStatus = 'in_transit';
    let statusBody = { status: 'in_transit', startOdometer: parseInt(odoValue, 10) };
    
    if (window.currentHandoverType === 'dropoff_garage') {
        odoDocType = 'odometer_dropoff_garage';
        walkaroundDocType = '360_dropoff_garage';
        targetTripStatus = 'at_garage';
        statusBody = { status: 'at_garage', garageDropOdometer: parseInt(odoValue, 10) };
    } else if (window.currentHandoverType === 'pickup_garage') {
        odoDocType = 'odometer_pickup_garage';
        walkaroundDocType = '360_pickup_garage';
        targetTripStatus = 'out_for_delivery';
        statusBody = { status: 'out_for_delivery' };
    }

    try {
        const formDataOdo = new FormData();
        formDataOdo.append('referenceId', currentTripId);
        formDataOdo.append('type', odoDocType);
        formDataOdo.append('file', odoBlob, 'odo.jpg');
        await fetch(`${API_URL}/media`, { method: 'POST', body: formDataOdo });

        const formDataVid = new FormData();
        formDataVid.append('referenceId', currentTripId);
        formDataVid.append('type', walkaroundDocType);
        formDataVid.append('file', videoBlob, '360.webm');
        await fetch(`${API_URL}/media`, { method: 'POST', body: formDataVid });



        // Update trip status & odometer
        const resStatus = await fetch(`${API_URL}/trips/${currentTripId}/status`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(statusBody)
        });
        
        if (!resStatus.ok) {
            const errData = await resStatus.json();
            throw new Error(errData.error || "Failed to update trip status on server");
        }

        showToast("Evidence uploaded! Handover Complete. Drive safe.", "success");
        
        closeHandoverModal();
        localStorage.removeItem('trip_state_' + currentTripId); // Reset navigation flow state
        loadMyTrips();
        window.openMapView(currentTripId); // Refresh map to transition to next leg
    } catch(err) {
        showToast("Upload failed: " + err.message, "error");
    }
}

async function verifyHandoverOTP() {
    const otp = document.getElementById('handover-otp').value;
    if (!otp) return showToast("Please enter OTP", "warning");

    let endpoint = '/verify-otp-1';
    if (window.currentHandoverType === 'dropoff_garage') {
        endpoint = '/verify-garage-dropoff';
    } else if (window.currentHandoverType === 'pickup_garage') {
        endpoint = '/verify-garage-pickup';
    }

    try {
        const res = await fetch(`${API_URL}/trips/${currentTripId}${endpoint}`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ otp })
        });
        const data = await res.json();
        
        if (!res.ok) throw new Error(data.error || "OTP Verification Failed");

        showToast("OTP Verified! Please proceed with vehicle handover checks.", "success");
        
        document.getElementById('handover-step-4').style.display = 'none';
        document.getElementById('handover-step-1').style.display = 'block';
        document.getElementById('handover-step-2').style.display = 'block';
    } catch(err) {
        showToast("Verification failed: " + err.message, "error");
    }
}

// ─── LIVE SELFIE CAMERA CAPTURE & FACE DETECTION ─────────────────────────
let cameraStream = null;
let selfieDetectionTimer = null;
let isFaceProbeBusy = false;

function setSelfieVisualState(state, message) {
    const pill = document.getElementById('selfie-status-pill');
    const oval = document.getElementById('selfie-oval-stroke');
    const btn = document.getElementById('btn-capture-photo');
    if (!pill || !oval || !btn) return;

    pill.textContent = message;
    if (state === 'green') {
        pill.className = 'text-xs font-bold px-3 py-1.5 rounded-full bg-emerald-950/80 border border-emerald-500 text-emerald-400 text-center shadow-lg shadow-emerald-500/20';
        oval.setAttribute('stroke', '#10B981');
        oval.removeAttribute('stroke-dasharray');
        btn.disabled = false;
        btn.classList.remove('opacity-50', 'cursor-not-allowed');
        btn.classList.add('shadow-lg', 'shadow-emerald-500/25');
    } else if (state === 'red') {
        pill.className = 'text-xs font-semibold px-3 py-1.5 rounded-full bg-red-950/80 border border-red-500/40 text-red-400 text-center';
        oval.setAttribute('stroke', '#EF4444');
        oval.setAttribute('stroke-dasharray', '4 4');
        btn.disabled = true;
        btn.classList.add('opacity-50', 'cursor-not-allowed');
        btn.classList.remove('shadow-lg', 'shadow-emerald-500/25');
    } else {
        // Amber searching
        pill.className = 'text-xs font-semibold px-3 py-1.5 rounded-full bg-zinc-800 border border-yellow-500/30 text-yellow-400 text-center';
        oval.setAttribute('stroke', '#FACC15');
        oval.setAttribute('stroke-dasharray', '4 4');
        btn.disabled = true;
        btn.classList.add('opacity-50', 'cursor-not-allowed');
        btn.classList.remove('shadow-lg', 'shadow-emerald-500/25');
    }
}

async function probeSelfieFrame() {
    if (isFaceProbeBusy) return;
    const video = document.getElementById('camera-preview');
    if (!video || !cameraStream || video.readyState < 2) return;

    const plugins = window.Capacitor && window.Capacitor.Plugins;
    const FaceDetection = plugins && plugins.FaceDetection;
    const Filesystem = plugins && plugins.Filesystem;
    if (!FaceDetection || !Filesystem) {
        // Fallback: If plugin is unavailable, enable button directly
        setSelfieVisualState('green', 'Ready to capture');
        return;
    }

    isFaceProbeBusy = true;
    try {
        const canvas = document.createElement('canvas');
        canvas.width = 360;
        canvas.height = 480; // 3:4 aspect ratio matching preview container
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, 360, 480);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
        const base64Data = dataUrl.split(',')[1];

        const fileResult = await Filesystem.writeFile({
            path: 'face_probe.jpg',
            data: base64Data,
            directory: 'CACHE'
        });

        const result = await FaceDetection.processImage({
            path: fileResult.uri,
            performanceMode: 1, // Fast
            classificationMode: 2, // Eyes & smile
            landmarkMode: 1
        });

        // Post-await cancellation guard
        const camContainer = document.getElementById('camera-container');
        if (!cameraStream || !camContainer || camContainer.classList.contains('hidden') || camContainer.style.display === 'none') {
            return;
        }

        const faces = result?.faces || [];
        if (faces.length === 0) {
            setSelfieVisualState('amber', 'Position your face inside the oval');
        } else if (faces.length > 1) {
            setSelfieVisualState('red', 'Multiple faces detected — only 1 person allowed');
        } else {
            const face = faces[0];
            const bounds = face.bounds;
            const faceW = bounds.right - bounds.left;
            const faceH = bounds.bottom - bounds.top;
            const centerX = (bounds.left + bounds.right) / 2;
            const centerY = (bounds.top + bounds.bottom) / 2;

            const isTilted = Math.abs(face.headEulerAngleY || 0) > 14 || Math.abs(face.headEulerAngleX || 0) > 14;
            const eyesClosed = (face.leftEyeOpenProbability !== undefined && face.leftEyeOpenProbability < 0.35) ||
                               (face.rightEyeOpenProbability !== undefined && face.rightEyeOpenProbability < 0.35);
            const isTooSmall = faceW < 360 * 0.35; // < 126px on 360 width
            const isTooLarge = faceW > 360 * 0.78; // > 280px on 360 width
            const isOffCenter = Math.abs(centerX - 180) > 55 || Math.abs(centerY - 240) > 65;

            if (isTooSmall) {
                setSelfieVisualState('red', 'Move a little closer');
            } else if (isTooLarge) {
                setSelfieVisualState('red', 'Move a little back');
            } else if (isOffCenter) {
                setSelfieVisualState('red', 'Center your face in the oval');
            } else if (isTilted) {
                setSelfieVisualState('red', 'Look straight at the camera');
            } else if (eyesClosed) {
                setSelfieVisualState('red', 'Keep both eyes open');
            } else {
                setSelfieVisualState('green', '✓ Face Verified — Ready to Capture');
            }
        }
    } catch (e) {
        if (cameraStream) console.warn('[FACE_PROBE] Error:', e);
    } finally {
        isFaceProbeBusy = false;
    }
}

async function startKycCamera() {
    try {
        cameraStream = await getMediaStreamWithFallback('user', false);
        const videoEl = document.getElementById('camera-preview');
        if (videoEl) {
            videoEl.srcObject = cameraStream;
            videoEl.muted = true;
            videoEl.setAttribute('playsinline', '');
            videoEl.setAttribute('autoplay', '');
            await videoEl.play().catch(e => console.warn("selfieVideo.play caught:", e));
        }

        const btnStart = document.getElementById('btn-start-camera');
        if (btnStart) {
            btnStart.classList.add('hidden');
            btnStart.style.display = 'none';
        }

        const camContainer = document.getElementById('camera-container');
        if (camContainer) {
            camContainer.classList.remove('hidden');
            camContainer.style.display = 'flex';
        }

        const previewContainer = document.getElementById('photo-preview-container');
        if (previewContainer) {
            previewContainer.classList.add('hidden');
            previewContainer.style.display = 'none';
        }

        // Start live face detection probe
        if (selfieDetectionTimer) clearInterval(selfieDetectionTimer);
        setSelfieVisualState('amber', 'Position your face inside the oval');
        selfieDetectionTimer = setInterval(probeSelfieFrame, 700);

    } catch (err) {
        console.error("Camera error:", err);
        const errMsg = err?.message || String(err);
        if (errMsg.toLowerCase().includes('denied') || errMsg.toLowerCase().includes('permission') || errMsg.toLowerCase().includes('notallowed')) {
            showToast("Camera permission denied. Please allow camera access in Android Settings to capture a selfie.", "error");
        } else {
            showToast("Camera access failed: " + errMsg, "error");
        }
    }
}

function stopKycCamera() {
    if (selfieDetectionTimer) {
        clearInterval(selfieDetectionTimer);
        selfieDetectionTimer = null;
    }
    if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
        cameraStream = null;
    }
    const videoEl = document.getElementById('camera-preview');
    if (videoEl) {
        videoEl.srcObject = null;
    }
    setSelfieVisualState('amber', 'Position your face inside the oval');
    const camContainer = document.getElementById('camera-container');
    if (camContainer) {
        camContainer.classList.add('hidden');
        camContainer.style.display = 'none';
    }
    const faceFileInput = document.getElementById('on-face-file');
    const hasFile = faceFileInput && faceFileInput.files && faceFileInput.files.length > 0;
    const btnStart = document.getElementById('btn-start-camera');
    if (btnStart && !hasFile) {
        btnStart.classList.remove('hidden');
        btnStart.style.display = 'inline-block';
    }
}
window.stopKycCamera = stopKycCamera;

window.uploadProfilePicture = async function(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
        showToast('Image must be less than 5MB', 'error');
        return;
    }

    try {
        const formData = new FormData();
        formData.append('file', file);

        showToast('Uploading profile picture...', 'success');
        
        const res = await fetch(`${API_URL}/users/${currentUser.id}/profile-picture`, {
            method: 'POST',
            body: formData
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to upload profile picture');

        currentUser.profilePictureUrl = data.profilePictureUrl;
        currentUser.profilepictureurl = data.profilePictureUrl;
        safeSetLocalStorage('marshalUser', JSON.stringify(currentUser));
        
        // Update DOM
        const cleanUploadedUrl = '/' + data.profilePictureUrl.replace(/\\/g, '/').replace(/^\/+/, '');
        document.getElementById('user-avatar-display').src = `${API_URL.replace('/api', '')}${cleanUploadedUrl}`;
        const profilePageAvatar = document.getElementById('profile-page-avatar');
        if (profilePageAvatar) profilePageAvatar.src = `${API_URL.replace('/api', '')}${cleanUploadedUrl}`;
        
        showToast('Profile picture updated successfully!', 'success');
    } catch (err) {
        console.error('Error uploading profile picture:', err);
        showToast(err.message, 'error');
    }
};


window.captureSelfie = function() {
    console.log("captureSelfie called");
    const video = document.getElementById('camera-preview');
    if (!video) {
        showToast("Camera preview element not found!", "error");
        return;
    }
    
    // Fallback if videoWidth is not ready
    const width = video.videoWidth || video.clientWidth || 300;
    const height = video.videoHeight || video.clientHeight || 400;

    if (!width || !height) {
        showToast("Could not determine video dimensions. Please wait a moment and try again.", "error");
        return;
    }

    try {
        // Create a canvas to draw the video frame
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        
        // Mirror the image to match front camera preview
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Stop camera stream
        if (typeof stopKycCamera === 'function') {
            stopKycCamera();
        }

        // Convert canvas to a file
        canvas.toBlob((blob) => {
            if (!blob) {
                showToast("Failed to capture image. Blob is null.", "error");
                return;
            }
            const file = new File([blob], "live_selfie_" + Date.now() + ".jpg", { type: "image/jpeg", lastModified: Date.now() });
            
            // Put file in the hidden input using DataTransfer
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            document.getElementById('on-face-file').files = dataTransfer.files;

            // Display the captured photo
            const imgUrl = URL.createObjectURL(blob);
            const capturedImg = document.getElementById('captured-photo');
            if (capturedImg) capturedImg.src = imgUrl;
            const previewContainer = document.getElementById('photo-preview-container');
            if (previewContainer) {
                previewContainer.classList.remove('hidden');
                previewContainer.style.display = 'flex';
            }
        }, 'image/jpeg', 0.85);
    } catch (err) {
        console.error("Error in captureSelfie:", err);
        showToast("An error occurred while capturing the photo: " + err.message, "error");
    }
};

window.retakeSelfie = function() {
    const previewContainer = document.getElementById('photo-preview-container');
    if (previewContainer) {
        previewContainer.classList.add('hidden');
        previewContainer.style.display = 'none';
    }
    const capturedImg = document.getElementById('captured-photo');
    if (capturedImg) capturedImg.src = '';
    
    // Clear file input
    const dt = new DataTransfer();
    const faceFileInput = document.getElementById('on-face-file');
    if (faceFileInput) faceFileInput.files = dt.files;
    
    // Restart camera
    if (typeof startKycCamera === 'function') {
        startKycCamera();
    }
};

window.cancelSelfie = function() {
    const previewContainer = document.getElementById('photo-preview-container');
    if (previewContainer) {
        previewContainer.classList.add('hidden');
        previewContainer.style.display = 'none';
    }
    const capturedImg = document.getElementById('captured-photo');
    if (capturedImg) capturedImg.src = '';
    
    // Clear file input
    const dt = new DataTransfer();
    const faceFileInput = document.getElementById('on-face-file');
    if (faceFileInput) faceFileInput.files = dt.files;
    
    const camContainer = document.getElementById('camera-container');
    if (camContainer) {
        camContainer.classList.add('hidden');
        camContainer.style.display = 'none';
    }
    const btnStart = document.getElementById('btn-start-camera');
    if (btnStart) {
        btnStart.classList.remove('hidden');
        btnStart.style.display = 'inline-block';
    }
};

// ─── DOCUMENT IN-APP CAMERA CONTROLLER & LIVE OCR DETECTION ──────────────
let docCameraStream = null;
let currentDocResolve = null;
let currentDocReject = null;
let docDetectionTimer = null;
let isDocProbeBusy = false;
let currentDocTypeKey = null;
let currentDocTypeLabel = '';

function setDocVisualState(state, message) {
    const instruction = document.getElementById('doc-camera-instruction');
    const guideFrame = document.getElementById('doc-guide-frame');
    const brackets = document.querySelectorAll('.doc-corner-bracket');
    const captureBtn = document.getElementById('btn-doc-camera-capture');
    const shutterInner = document.getElementById('btn-doc-camera-shutter-inner');
    if (!instruction || !guideFrame || !captureBtn) return;

    instruction.textContent = message;
    if (state === 'green') {
        instruction.style.borderColor = '#10B981';
        instruction.style.color = '#34D399';
        guideFrame.style.borderColor = '#10B981';
        brackets.forEach(b => { b.style.borderColor = '#10B981'; });
        captureBtn.disabled = false;
        captureBtn.style.pointerEvents = 'auto';
        captureBtn.style.opacity = '1';
        captureBtn.style.cursor = 'pointer';
        captureBtn.style.border = '5px solid #10B981';
        if (shutterInner) {
            shutterInner.style.background = '#10B981';
            shutterInner.style.boxShadow = '0 0 15px rgba(16, 185, 129, 0.6)';
        }
    } else if (state === 'red') {
        instruction.style.borderColor = '#EF4444';
        instruction.style.color = '#F87171';
        guideFrame.style.borderColor = '#EF4444';
        brackets.forEach(b => { b.style.borderColor = '#EF4444'; });
        captureBtn.disabled = true;
        captureBtn.style.pointerEvents = 'none';
        captureBtn.style.opacity = '0.4';
        captureBtn.style.cursor = 'not-allowed';
        captureBtn.style.border = '5px solid rgba(255,255,255,0.4)';
        if (shutterInner) {
            shutterInner.style.background = 'rgba(255,255,255,0.5)';
            shutterInner.style.boxShadow = 'none';
        }
    } else {
        // Amber searching
        instruction.style.borderColor = 'rgba(255,255,255,0.1)';
        instruction.style.color = '#fff';
        guideFrame.style.borderColor = '#FACC15';
        brackets.forEach(b => { b.style.borderColor = '#FACC15'; });
        captureBtn.disabled = true;
        captureBtn.style.pointerEvents = 'none';
        captureBtn.style.opacity = '0.4';
        captureBtn.style.cursor = 'not-allowed';
        captureBtn.style.border = '5px solid rgba(255,255,255,0.4)';
        if (shutterInner) {
            shutterInner.style.background = 'rgba(255,255,255,0.5)';
            shutterInner.style.boxShadow = 'none';
        }
    }
}

async function probeDocFrame() {
    window.probeDocFrame = probeDocFrame;
    if (isDocProbeBusy) return;
    const video = document.getElementById('doc-camera-preview');
    if (!video || !docCameraStream || video.readyState < 2) return;

    const plugins = window.Capacitor && window.Capacitor.Plugins;
    const ocrPlugin = plugins && (plugins.CapacitorOcr || plugins.Ocr);
    if (!ocrPlugin) {
        setDocVisualState('green', 'Align Card & Tap Shutter');
        return;
    }

    isDocProbeBusy = true;
    try {
        const vWidth = video.videoWidth || 1280;
        const vHeight = video.videoHeight || 720;
        const viewWidth = video.clientWidth || window.innerWidth;
        const viewHeight = video.clientHeight || window.innerHeight;

        const canvas = document.createElement('canvas');
        canvas.width = 720;
        canvas.height = 456; // 1.58 ratio at high-res for crisp ML Kit detection
        const ctx = canvas.getContext('2d');

        const guideFrame = document.getElementById('doc-guide-frame');
        if (guideFrame && viewWidth > 0 && viewHeight > 0) {
            const frameRect = guideFrame.getBoundingClientRect();
            const scale = Math.max(viewWidth / vWidth, viewHeight / vHeight);
            const offsetX = (vWidth * scale - viewWidth) / 2;
            const offsetY = (vHeight * scale - viewHeight) / 2;
            const cropX = Math.max(0, (frameRect.left + offsetX) / scale);
            const cropY = Math.max(0, (frameRect.top + offsetY) / scale);
            const cropW = Math.min(vWidth - cropX, frameRect.width / scale);
            const cropH = Math.min(vHeight - cropY, frameRect.height / scale);

            ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, 720, 456);
        } else {
            ctx.drawImage(video, 0, 0, 720, 456);
        }

        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        const base64Data = dataUrl.split(',')[1];
        const res = await ocrPlugin.detectText({ base64: base64Data });

        // Post-await cancellation guard
        const modal = document.getElementById('document-camera-modal');
        if (!docCameraStream || !modal || modal.style.display === 'none') {
            return;
        }

        const detections = res?.textDetections ? res.textDetections.map(d => (d.text || '').trim()).filter(Boolean).join(' ') : '';
        const rawText = (res?.text || (res?.lines ? res.lines.map(l => l.text).join(' ') : '') || detections).toUpperCase();
        const charCount = rawText.replace(/\s+/g, '').length;

        // Slot-specific validation rules
        let isValid = false;
        const type = currentDocTypeKey || '';

        if (type.includes('pan')) {
            const hasPanKeyword = rawText.includes('INCOME') || rawText.includes('TAX') || rawText.includes('GOVT') || rawText.includes('INDIA') || rawText.includes('ACCOUNT');
            const hasPanRegex = /[A-Z]{5}[0-9]{4}[A-Z]/.test(rawText);
            isValid = (hasPanKeyword || hasPanRegex || charCount >= 20);
        } else if (type.includes('aadhaar')) {
            const hasAadhaarKeyword = rawText.includes('GOVERNMENT') || rawText.includes('INDIA') || rawText.includes('AADHAAR') || rawText.includes('DOB') || rawText.includes('YEAR') || rawText.includes('MALE') || rawText.includes('FEMALE') || rawText.includes('ADDRESS');
            const has12Digits = /\d{4}\s?\d{4}\s?\d{4}/.test(rawText);
            isValid = (hasAadhaarKeyword || has12Digits || charCount >= 22);
        } else if (type.includes('dl')) {
            const hasDlKeyword = rawText.includes('DRIVING') || rawText.includes('LICENCE') || rawText.includes('LICENSE') || rawText.includes('UNION') || rawText.includes('INDIA') || rawText.includes('TRANSPORT') || rawText.includes('AUTHORITY');
            isValid = (hasDlKeyword || charCount >= 20);
        } else {
            isValid = charCount >= 18;
        }

        if (isValid) {
            setDocVisualState('green', '✓ Card In Focus — Ready to Capture');
        } else if (charCount > 5) {
            setDocVisualState('red', 'Hold still — ensure text is sharp & inside box');
        } else {
            setDocVisualState('amber', `Align ${currentDocTypeLabel || 'Card'} Inside Frame`);
        }
    } catch (e) {
        if (docCameraStream) console.warn('[DOC_PROBE] Error:', e);
    } finally {
        isDocProbeBusy = false;
    }
}

function bindDocCameraEvents() {
    if (window.isDocCameraBound) return;
    window.isDocCameraBound = true;
    
    const closeBtn = document.getElementById('btn-doc-camera-close');
    if (closeBtn) closeBtn.onclick = window.closeDocumentCameraManually;
    
    const captureBtn = document.getElementById('btn-doc-camera-capture');
    if (captureBtn) captureBtn.onclick = window.captureDocumentPhoto;
    
    const retakeBtn = document.getElementById('btn-doc-camera-retake');
    if (retakeBtn) retakeBtn.onclick = window.retakeDocumentPhoto;
    
    const confirmBtn = document.getElementById('btn-doc-camera-confirm');
    if (confirmBtn) confirmBtn.onclick = window.confirmDocumentPhoto;
}

window.openDocumentCamera = function(docTypeLabel, docTypeKey) {
    const modalTest = document.getElementById('document-camera-modal');
    console.log('[DOC_CAMERA] openDocumentCamera called. Modal exists in DOM:', !!modalTest, 'Modal Element:', modalTest);
    console.log('[DOC_CAMERA] Opening camera for:', docTypeLabel, 'Key:', docTypeKey);
    bindDocCameraEvents();
    currentDocTypeKey = docTypeKey || '';
    currentDocTypeLabel = docTypeLabel || '';
    
    // Reset view visibility
    document.getElementById('doc-camera-live-view').style.display = 'flex';
    document.getElementById('doc-camera-review-view').style.display = 'none';
    document.getElementById('document-camera-modal').style.display = 'flex';
    
    return new Promise(async (resolve, reject) => {
        currentDocResolve = resolve;
        currentDocReject = reject;
        
        try {
            // Request rear camera with video fallback attempts
            docCameraStream = await getMediaStreamWithFallback('environment', false);
            const videoEl = document.getElementById('doc-camera-preview');
            if (videoEl) {
                videoEl.srcObject = docCameraStream;
                videoEl.muted = true;
                videoEl.setAttribute('playsinline', '');
                videoEl.setAttribute('autoplay', '');
                await videoEl.play().catch(e => console.warn("docVideo.play caught:", e));
            }

            // Start live OCR detection probe
            if (docDetectionTimer) clearInterval(docDetectionTimer);
            setDocVisualState('amber', `Align ${docTypeLabel} Inside Frame`);
            docDetectionTimer = setInterval(probeDocFrame, 1100);

        } catch (err) {
            console.error('[DOC_CAMERA] Access failed:', err);
            const errMsg = err?.message || String(err);
            if (errMsg.toLowerCase().includes('denied') || errMsg.toLowerCase().includes('permission') || errMsg.toLowerCase().includes('notallowed')) {
                showToast("Camera permission denied. Please allow camera access in Android Settings.", "error");
            } else {
                showToast("Camera access failed: " + errMsg, "error");
            }
            closeDocCamera();
            reject(err);
        }
    });
};

function closeDocCamera() {
    console.log('[DOC_CAMERA] Closing camera...');
    if (docDetectionTimer) {
        clearInterval(docDetectionTimer);
        docDetectionTimer = null;
    }
    if (docCameraStream) {
        docCameraStream.getTracks().forEach(track => track.stop());
        docCameraStream = null;
    }
    const videoEl = document.getElementById('doc-camera-preview');
    if (videoEl) videoEl.srcObject = null;
    
    // Revoke old object URL if any
    const capturedImg = document.getElementById('doc-camera-captured-img');
    if (capturedImg && capturedImg.src && capturedImg.src.startsWith('blob:')) {
        URL.revokeObjectURL(capturedImg.src);
        capturedImg.src = '';
    }
    
    setDocVisualState('amber', 'Align Card Inside Frame');
    document.getElementById('document-camera-modal').style.display = 'none';
    
    currentDocResolve = null;
    currentDocReject = null;
}

window.captureDocumentPhoto = function() {
    console.log('[DOC_CAMERA] Capturing frame...');
    const video = document.getElementById('doc-camera-preview');
    if (!video) return;
    
    const vWidth = video.videoWidth || video.clientWidth || 1280;
    const vHeight = video.videoHeight || video.clientHeight || 720;
    const viewWidth = video.clientWidth || window.innerWidth;
    const viewHeight = video.clientHeight || window.innerHeight;
    
    try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        const guideFrame = document.getElementById('doc-guide-frame');
        if (guideFrame && viewWidth > 0 && viewHeight > 0 && vWidth > 0 && vHeight > 0) {
            const frameRect = guideFrame.getBoundingClientRect();
            
            // object-fit: cover scaling & offsets
            const scale = Math.max(viewWidth / vWidth, viewHeight / vHeight);
            const renderedWidth = vWidth * scale;
            const renderedHeight = vHeight * scale;
            const offsetX = (renderedWidth - viewWidth) / 2;
            const offsetY = (renderedHeight - viewHeight) / 2;
            
            // Map frame screen coordinates to sensor video pixels
            let cropX = (frameRect.left + offsetX) / scale;
            let cropY = (frameRect.top + offsetY) / scale;
            let cropW = frameRect.width / scale;
            let cropH = frameRect.height / scale;
            
            // Clamp boundaries to sensor bounds
            cropX = Math.max(0, Math.min(cropX, vWidth - 10));
            cropY = Math.max(0, Math.min(cropY, vHeight - 10));
            cropW = Math.min(cropW, vWidth - cropX);
            cropH = Math.min(cropH, vHeight - cropY);
            
            canvas.width = Math.round(cropW);
            canvas.height = Math.round(cropH);
            ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);
            console.log(`[DOC_CAMERA] Precision crop applied: ${canvas.width}x${canvas.height} (from ${vWidth}x${vHeight})`);
        } else {
            // Fallback to full frame if guide frame not found
            canvas.width = vWidth;
            canvas.height = vHeight;
            ctx.drawImage(video, 0, 0, vWidth, vHeight);
        }
        
        canvas.toBlob((blob) => {
            if (!blob) {
                showToast("Failed to capture image. Blob is null.", "error");
                return;
            }
            
            // Revoke old preview URL if any
            const capturedImg = document.getElementById('doc-camera-captured-img');
            if (capturedImg && capturedImg.src && capturedImg.src.startsWith('blob:')) {
                URL.revokeObjectURL(capturedImg.src);
            }
            
            // Temporary URL for preview
            const imgUrl = URL.createObjectURL(blob);
            if (capturedImg) capturedImg.src = imgUrl;
            
            // Switch views
            document.getElementById('doc-camera-live-view').style.display = 'none';
            document.getElementById('doc-camera-review-view').style.display = 'flex';
            
            // Save captured blob globally for confirm to use
            window.lastCapturedDocBlob = blob;
        }, 'image/jpeg', 0.88);
    } catch (err) {
        console.error('[DOC_CAMERA] Capture error:', err);
        showToast("Error capturing photo: " + err.message, "error");
    }
};


window.retakeDocumentPhoto = function() {
    console.log('[DOC_CAMERA] Retake requested...');
    // Clean preview image and revoke URL
    const capturedImg = document.getElementById('doc-camera-captured-img');
    if (capturedImg && capturedImg.src && capturedImg.src.startsWith('blob:')) {
        URL.revokeObjectURL(capturedImg.src);
        capturedImg.src = '';
    }
    
    // Switch views back to live preview
    document.getElementById('doc-camera-live-view').style.display = 'flex';
    document.getElementById('doc-camera-review-view').style.display = 'none';
    
    window.lastCapturedDocBlob = null;
};

window.confirmDocumentPhoto = function() {
    console.log('[DOC_CAMERA] Confirming photo...');
    const blob = window.lastCapturedDocBlob;
    if (!blob) {
        showToast("No captured photo available.", "error");
        return;
    }
    
    // Switch to target, but wait with revoking URL until resolve reads it if needed, or close will clean it.
    if (currentDocResolve) {
        currentDocResolve(blob);
    }
    
    closeDocCamera();
};

window.closeDocumentCameraManually = function() {
    if (currentDocReject) {
        currentDocReject(new Error('User cancelled camera capture'));
    }
    closeDocCamera();
};

// Online/Offline Status Logic
window.marshalIsOffline = false;

window.toggleMarshalStatus = async function(checkbox) {
    const targetState = checkbox.checked;
    
    if (targetState) {
        const kyc = currentUser ? (currentUser.kycStatus || currentUser.kycstatus || '') : '';
        const isApproved = kyc === 'approved' || kyc === 'Approved' || kyc === 'verified' || kyc === 'Verified';
        if (!isApproved) {
            checkbox.checked = false;
            showToast("Access Blocked: Your KYC must be approved before going online.", "warning");
            return;
        }
    }

    // Optimistically update UI
    window.marshalIsOffline = !targetState;
    const statusText = document.getElementById('status-label');
    if (statusText) {
        statusText.innerText = window.marshalIsOffline ? 'Offline' : 'Online';
    }
    const statusDot = document.getElementById('status-dot');
    if (statusDot) {
        statusDot.className = window.marshalIsOffline ? 'w-2 h-2 rounded-full bg-error' : 'w-2 h-2 rounded-full bg-green-500';
    }

    if (currentUser) {
        try {
            const res = await fetch(`${API_URL}/users/${currentUser.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ is_online: targetState ? 1 : 0 })
            });
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                const errMsg = errData.error || 'Failed to update online status';
                
                // Revert state
                checkbox.checked = !targetState;
                window.marshalIsOffline = targetState;
                if (statusText) {
                    statusText.innerText = window.marshalIsOffline ? 'Offline' : 'Online';
                }
                if (statusDot) {
                    statusDot.className = window.marshalIsOffline ? 'w-2 h-2 rounded-full bg-error' : 'w-2 h-2 rounded-full bg-green-500';
                }
                showToast(errMsg, "error");
                return;
            }
            
            // On success, update local currentUser
            currentUser.is_online = targetState ? 1 : 0;
            safeSetLocalStorage('marshalUser', JSON.stringify(currentUser));
        } catch (e) {
            console.error(e);
            // Revert state on network error
            checkbox.checked = !targetState;
            window.marshalIsOffline = targetState;
            if (statusText) {
                statusText.innerText = window.marshalIsOffline ? 'Offline' : 'Online';
            }
            if (statusDot) {
                statusDot.className = window.marshalIsOffline ? 'w-2 h-2 rounded-full bg-error' : 'w-2 h-2 rounded-full bg-green-500';
            }
            showToast("Network error. Failed to update status.", "error");
            return;
        }
    }

    if (window.marshalIsOffline) {
        showToast("You are now Offline. You will not receive new pickup requests.", "error");
        // Clear pickups immediately
        const list = document.getElementById('available-pickups-list');
        if (list) {
            list.innerHTML = `<div class="empty-state p-10 text-center text-on-surface-variant border border-outline-variant rounded-xl border-dashed">
                <i data-lucide="power-off" style="width:32px; height:32px; margin:0 auto 10px auto; opacity:0.5;"></i>
                <p class="text-sm font-bold text-error">You are Offline</p>
                <p class="text-xs mt-1">Go online to view available pickups.</p>
            </div>`;
            if (window.lucide) window.lucide.createIcons();
        }
    } else {
        showToast("You are now Online. Scanning for pickups...", "success");
        // Reload pickups
        if (typeof loadAvailablePickups === 'function') {
            startPickupPolling();
        }
    }
};

let earningsData = null;

async function loadEarnings() {
    if (!currentUser) return;
    try {
        // Fetch current user hold status
        const userRes = await fetch(`${API_URL}/users/${currentUser.id}`, { cache: 'no-store' });
        if (userRes.ok) {
            const userData = await userRes.json();
            currentUser.is_payment_on_hold = userData.is_payment_on_hold;
            const isHold = userData.is_payment_on_hold === 1;
            const withdrawBtn = document.getElementById('btn-withdraw-earnings');
            const holdBanner = document.getElementById('payout-hold-banner');
            if (withdrawBtn && holdBanner) {
                if (isHold) {
                    withdrawBtn.disabled = true;
                    withdrawBtn.style.opacity = '0.5';
                    withdrawBtn.style.pointerEvents = 'none';
                    holdBanner.style.display = 'flex';
                } else {
                    withdrawBtn.disabled = false;
                    withdrawBtn.style.opacity = '1';
                    withdrawBtn.style.pointerEvents = 'auto';
                    holdBanner.style.display = 'none';
                }
            }
        }

        const res = await fetch(`${API_URL}/users/${currentUser.id}/earnings`, { cache: 'no-store' });
        const data = await res.json();
        if (res.ok) {
            earningsData = data;
            const elToday = document.getElementById('breakdown-today');
            if(elToday) elToday.textContent = `₹${data.todayEarnings || 0}`;
            
            const elWeek = document.getElementById('breakdown-week');
            if(elWeek) elWeek.textContent = `₹${data.weekEarnings || 0}`;
            
            const elMonth = document.getElementById('breakdown-month');
            if(elMonth) elMonth.textContent = `₹${data.monthEarnings || 0}`;
            
            const elOverall = document.getElementById('breakdown-overall');
            if(elOverall) elOverall.textContent = `₹${data.overallEarnings || 0}`;

            const elWithdrawable = document.getElementById('withdrawable-balance-amount');
            if(elWithdrawable) elWithdrawable.textContent = `₹${data.withdrawableBalance || 0}`;
            
            // Render recent transactions
            const txList = document.getElementById('recent-transactions-list');
            if (txList) {
                if (data.recentTransactions && data.recentTransactions.length > 0) {
                    txList.innerHTML = data.recentTransactions.map(tx => {
                        let typeBadge = '';
                        let titleText = `Trip ${tx.tripId || 'N/A'}`;
                        let isNegative = false;

                        if (tx.type === 'trip_bonus_base') {
                            typeBadge = '<span style="color:var(--text-muted); font-size:0.75rem; margin-left:6px; background:rgba(255,255,255,0.05); padding:2px 6px; border-radius:4px; border:1px solid rgba(255,255,255,0.1)">Base Fare</span>';
                        } else if (tx.type === 'trip_bonus_extra') {
                            typeBadge = '<span style="color:var(--primary); font-size:0.75rem; margin-left:6px; background:rgba(212,175,55,0.1); padding:2px 6px; border-radius:4px; border:1px solid rgba(212,175,55,0.2)">Extra Bonus</span>';
                        } else if (tx.type === '5_star_bonus') {
                            typeBadge = '<span style="color:#22c55e; font-size:0.75rem; margin-left:6px; background:rgba(34,197,94,0.1); padding:2px 6px; border-radius:4px; border:1px solid rgba(34,197,94,0.2)">5★ Rating Bonus</span>';
                        } else if (tx.type === 'penalty') {
                            typeBadge = '<span style="color:#ef4444; font-size:0.75rem; margin-left:6px; background:rgba(239,68,68,0.1); padding:2px 6px; border-radius:4px; border:1px solid rgba(239,68,68,0.2)">Deduction</span>';
                            isNegative = true;
                        } else if (tx.type === 'withdrawal') {
                            titleText = 'Payout Request';
                            isNegative = true;
                            if (tx.status === 'requested') {
                                typeBadge = '<span style="color:#facc15; font-size:0.75rem; margin-left:6px; background:rgba(250,204,21,0.1); padding:2px 6px; border-radius:4px; border:1px solid rgba(250,204,21,0.2)">Pending Admin Payout</span>';
                            } else if (tx.status === 'completed') {
                                typeBadge = `<span style="color:#22c55e; font-size:0.75rem; margin-left:6px; background:rgba(34,197,94,0.1); padding:2px 6px; border-radius:4px; border:1px solid rgba(34,197,94,0.2)">Paid (UTR: ${tx.utrNumber || 'N/A'})</span>`;
                            } else if (tx.status === 'rejected') {
                                typeBadge = `<span style="color:#ef4444; font-size:0.75rem; margin-left:6px; background:rgba(239,68,68,0.1); padding:2px 6px; border-radius:4px; border:1px solid rgba(239,68,68,0.2)">Rejected (${tx.rejectionReason || 'Refunded'})</span>`;
                                isNegative = false;
                            }
                        }

                        return `
                            <div style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 10px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border);">
                                <div>
                                    <div style="font-weight: 700; color: var(--text-main); font-size: 0.95rem; display:flex; align-items:center; flex-wrap:wrap; gap:4px;">
                                        ${titleText} ${typeBadge}
                                    </div>
                                    <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;">${new Date(tx.date).toLocaleDateString()} • ${new Date(tx.date).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</div>
                                </div>
                                <div style="font-weight: 800; color: ${isNegative ? '#ef4444' : 'var(--primary)'}; font-size: 1.1rem;">
                                    ${isNegative ? '-' : ''}₹${tx.amount}
                                </div>
                            </div>
                        `;
                    }).join('');
                } else {
                    txList.innerHTML = `
                        <div style="background: var(--surface-container); padding: 20px; border-radius: 12px; border: 1px solid var(--border); text-align: center; color: var(--text-muted);">
                            <span class="material-symbols-outlined" style="font-size: 32px; opacity: 0.5; margin-bottom: 8px;">receipt_long</span>
                            <p style="font-size: 0.9rem;">No recent transactions.</p>
                        </div>`;
                }
            }
            
            // Initialize with 'today'
            if(typeof setEarningsFilter === 'function') setEarningsFilter('today');
        }
    } catch (err) {
        console.error('Failed to load earnings:', err);
    }
}

window.setEarningsFilter = function(period) {
    if (!earningsData) return;
    
    // Update active button state
    document.querySelectorAll('.earnings-filter-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.textContent.toLowerCase().includes(period) || 
           (period === 'today' && btn.textContent === 'Today') ||
           (period === 'overall' && btn.textContent === 'Overall')) {
            btn.classList.add('active');
        }
    });

    const heroAmount = document.getElementById('earnings-hero-amount');
    const periodLabel = document.getElementById('earnings-period-label');
    const tripCountLabel = document.getElementById('earnings-trip-count');
    
    if(!heroAmount || !periodLabel || !tripCountLabel) return;

    // Add a slight fade-out effect
    heroAmount.style.opacity = '0.5';
    heroAmount.style.transform = 'scale(0.95)';
    heroAmount.style.transition = 'all 0.2s ease';

    setTimeout(() => {
        let amount = 0;
        let trips = 0;
        let label = '';
        
        switch (period) {
            case 'today':
                amount = earningsData.todayEarnings;
                trips = earningsData.todayTrips;
                label = "TODAY'S EARNINGS";
                break;
            case 'week':
                amount = earningsData.weekEarnings;
                trips = Math.floor((earningsData.todayTrips || 0) * 4.5); // Mocked multiplier
                label = "THIS WEEK'S EARNINGS";
                break;
            case 'month':
                amount = earningsData.monthEarnings;
                trips = Math.floor((earningsData.todayTrips || 0) * 18); // Mocked multiplier
                label = "THIS MONTH'S EARNINGS";
                break;
            case 'overall':
                amount = earningsData.overallEarnings;
                trips = Math.floor((earningsData.todayTrips || 0) * 45); // Mocked multiplier
                label = "OVERALL EARNINGS";
                break;
        }

        heroAmount.textContent = `₹${amount || 0}`;
        tripCountLabel.textContent = trips || 0;
        periodLabel.textContent = label;

        // Fade back in
        heroAmount.style.opacity = '1';
        heroAmount.style.transform = 'scale(1)';
    }, 200);
};

window.startDelivery = async function(tripId) {
    if (!currentUser) return;
    try {
        const res = await fetch(`${API_URL}/trips/${tripId}/start-delivery`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        if (res.ok) {
            showToast("Delivery started successfully!", "success");
            loadActiveTrips();
        } else {
            showToast("Failed to start delivery.", "error");
        }
    } catch (e) {
        console.error("Error starting delivery:", e);
        showToast("Error starting delivery.", "error");
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

window.openDriverWithdrawalModal = function() {
    if (!currentUser) return;
    if (currentUser.is_payment_on_hold === 1) {
        showToast("Payouts are frozen due to an active dispute.", "error");
        return;
    }

    const available = earningsData ? (earningsData.withdrawableBalance || 0) : 0;
    if (available < 100) {
        showToast("Minimum withdrawable balance required is ₹100.", "error");
        return;
    }

    const b = earningsData?.bankDetails || {};
    const destEl = document.getElementById('modal-payout-destination-info');
    if (destEl) {
        if (b.accountNumber) {
            destEl.innerHTML = `
                <div style="color: #fff; font-weight: 700;">${b.bankName || 'Bank Account'}</div>
                <div style="color: #a1a1aa; font-size: 0.78rem; font-family: monospace; margin-top: 2px;">
                    A/C: ••••••••${String(b.accountNumber).slice(-4)} • IFSC: ${b.ifsc || 'N/A'}
                </div>
                <div style="color: #71717a; font-size: 0.72rem; margin-top: 2px;">Holder: ${b.accountHolderName || 'N/A'}</div>
            `;
        } else if (b.upiId) {
            destEl.innerHTML = `<div style="color: #fff; font-weight: 700;">UPI ID: ${b.upiId}</div>`;
        } else {
            showToast("Please save your bank account details first.", "error");
            openBankDetailsModal();
            return;
        }
    }

    const balEl = document.getElementById('modal-withdrawable-balance');
    if (balEl) balEl.textContent = `₹${available}`;

    const amtInput = document.getElementById('driver-withdrawal-amount-input');
    if (amtInput) amtInput.value = available;

    const modal = document.getElementById('driver-withdrawal-modal');
    if (modal) modal.style.display = 'flex';
};

window.closeDriverWithdrawalModal = function() {
    const modal = document.getElementById('driver-withdrawal-modal');
    if (modal) modal.style.display = 'none';
};

window.setWithdrawalMaxAmount = function() {
    const available = earningsData ? (earningsData.withdrawableBalance || 0) : 0;
    const amtInput = document.getElementById('driver-withdrawal-amount-input');
    if (amtInput) amtInput.value = available;
};

window.submitDriverWithdrawalRequest = async function() {
    if (!currentUser) return;
    const amtInput = document.getElementById('driver-withdrawal-amount-input');
    const amount = parseFloat(amtInput ? amtInput.value : 0);
    const available = earningsData ? (earningsData.withdrawableBalance || 0) : 0;

    if (isNaN(amount) || amount < 100) {
        showToast("Minimum withdrawal amount is ₹100.", "error");
        return;
    }
    if (amount > available) {
        showToast(`Cannot withdraw more than available balance (₹${available}).`, "error");
        return;
    }

    const btn = document.getElementById('btn-submit-withdrawal-request');
    if (btn) {
        btn.disabled = true;
        btn.textContent = "Submitting...";
    }

    try {
        const res = await fetch(`${API_URL}/users/${currentUser.id}/withdrawals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount })
        });
        const data = await res.json();
        if (res.ok) {
            closeDriverWithdrawalModal();
            if (typeof Swal !== 'undefined') {
                Swal.fire({
                    icon: 'success',
                    title: 'Payout Requested!',
                    text: `Your request for ₹${amount} has been queued. Admin will process the transfer to your bank account.`,
                    background: '#18181b',
                    color: '#fff',
                    confirmButtonColor: '#FACC15'
                });
            } else {
                showToast("Withdrawal request submitted!", "success");
            }
            loadEarnings();
        } else {
            showToast(data.error || "Failed to submit withdrawal request.", "error");
        }
    } catch (err) {
        showToast("Network error: " + err.message, "error");
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = "Submit Request";
        }
    }
};

window.withdrawEarnings = function() {
    openDriverWithdrawalModal();
};

window.submitMarshalFeedback = async function() {
    const tripId = document.getElementById('fb-marshal-trip-id').value;
    const smoothness = document.getElementById('fb-marshal-smoothness').value;
    const vehicleCond = document.getElementById('fb-marshal-vehicle-cond').value;
    const improve = document.getElementById('fb-marshal-improve').value;
    
    const answers = [
        { q: "How smooth was the pickup and drop-off process with the customer?", a: smoothness },
        { q: "Were there any issues with the vehicle's condition that weren't reported?", a: vehicleCond },
        { q: "What can ReDrivo do to make your job easier or improve the app?", a: improve }
    ];
    
    try {
        const res = await fetch(`${API_URL}/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id, userRole: 'marshal', surveyType: 'post_service', answers })
        });
        
        if (res.ok) {
            document.getElementById('marshal-feedback-modal').style.display = 'none';
            showToast('Feedback submitted. Great job!', 'success');
        } else {
            showToast('Failed to submit feedback', 'error');
        }
    } catch(err) {
        showToast('Network error', 'error');
    }
};

// --- Media Permission Consent (Google Play Policy Compliance) ---
const originalStartKycCamera = window.startKycCamera;
window.startKycCamera = function(mode) {
    window.pendingCameraMode = mode || 'odo';
    window.pendingCameraType = 'kyc';
    checkAndRequestCameraPermission();
};

const originalStartDeliveryCamera = window.startDeliveryCamera;
window.startDeliveryCamera = function(mode) {
    window.pendingCameraMode = mode || 'odo';
    window.pendingCameraType = 'delivery';
    checkAndRequestCameraPermission();
};

function checkAndRequestCameraPermission() {
    if (localStorage.getItem('marshal_media_consent') === 'granted') {
        executePendingCamera();
    } else {
        document.getElementById('kyc-permission-modal').style.display = 'flex';
    }
}

window.acceptKycPermission = function() {
    safeSetLocalStorage('marshal_media_consent', 'granted');
    document.getElementById('kyc-permission-modal').style.display = 'none';
    executePendingCamera();
};

window.denyKycPermission = function() {
    safeSetLocalStorage('marshal_media_consent', 'denied');
    document.getElementById('kyc-permission-modal').style.display = 'none';
    showToast('Permission denied. Cannot start camera.', 'error');
};

function executePendingCamera() {
    if (window.pendingCameraType === 'kyc' && originalStartKycCamera) {
        originalStartKycCamera(window.pendingCameraMode);
    } else if (window.pendingCameraType === 'delivery' && originalStartDeliveryCamera) {
        originalStartDeliveryCamera(window.pendingCameraMode);
    }
}



// --- Capacitor Push Notifications Setup ---
async function setupPushNotifications() {
    window.setupPushNotifications = setupPushNotifications;
    try {
        const PushNotifications = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications;
        if (!PushNotifications) return console.warn("PushNotifications plugin not found");

        // Request permissions
        console.log(`[${new Date().toISOString()}] [DEBUG-PERM] Calling PushNotifications.requestPermissions()...`);
        const permStatus = await PushNotifications.requestPermissions();
        console.log(`[${new Date().toISOString()}] [DEBUG-PERM] Push permission status JS object:`, JSON.stringify(permStatus));
        if (permStatus.receive === 'granted') {
            await PushNotifications.register();
        }

        // Add Listeners
        PushNotifications.addListener('registration', async (token) => {
            console.log('FCM Token:', token.value);
            window.registeredFcmToken = token.value;
            // Send to backend
            try {
                const uId = currentUser ? currentUser.id : null;
                if (uId) {
                    await fetch(`${API_URL}/users/${uId}/fcm-token`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ fcmToken: token.value })
                    });
                }
            } catch(e) { console.error('Failed to save FCM token', e); }
        });

        PushNotifications.addListener('registrationError', (error) => {
            console.error('Error on registration: ', JSON.stringify(error));
        });

        PushNotifications.addListener('pushNotificationReceived', (notification) => {
            console.log('Push received:', notification);
            showToast(`New Alert: ${notification.title} - ${notification.body}`, 'success');
            if (notification.data && notification.data.requestId) {
                triggerIncomingPickupFromPush(notification.data.requestId);
            }
        });

        PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
            console.log('Push action performed:', action);
            const data = action.notification.data;
            // If we have trip data, navigate to it
            if (data && data.serviceRequestId) {
                router.navigate('trip');
                // Could call a load method here
            } else if (data && data.requestId) {
                triggerIncomingPickupFromPush(data.requestId);
            }
        });

    } catch (e) {
        console.warn('Push Notifications not supported on this platform/web.', e);
    }
}


// Global failure tracker for battery check safety valve
let consecutiveBatteryCheckFailures = 0;

// Dynamic Battery Optimization UI & Guidance Flow (Mandatory blocking overlay)
async function checkAndRenderBatteryBanner() {
    if (!window.Capacitor || !window.Capacitor.isNativePlatform()) return;
    
    const gateOverlay = document.getElementById('battery-optimization-gate-overlay');
    const bannerContainer = document.getElementById('battery-optimization-banner-container');
    if (!gateOverlay || !bannerContainer) return;
    
    try {
        const BatteryOpt = getBatteryOptimizationPlugin();
        if (!BatteryOpt) {
            // Do not block UI or count as a failure while waiting for bridge initialization
            console.log('[DEBUG] BatteryOptimization plugin not ready on bridge yet, waiting...');
            return;
        }
        
        // 3-second timeout race to catch silent native hangs/deadlocks
        const statusPromise = BatteryOpt.isIgnoringBatteryOptimizations();
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Battery status query timed out')), 3000)
        );
        
        const { isIgnoring } = await Promise.race([statusPromise, timeoutPromise]);
        
        // On success: reset failure counter and clear any fallback banners
        consecutiveBatteryCheckFailures = 0;
        bannerContainer.innerHTML = '';
        
        if (isIgnoring) {
            gateOverlay.style.display = 'none';
        } else {
            gateOverlay.style.display = 'flex';
        }
    } catch (e) {
        consecutiveBatteryCheckFailures++;
        console.error(`[ERROR] Battery check failed (consecutive failures: ${consecutiveBatteryCheckFailures}):`, e);
        
        if (consecutiveBatteryCheckFailures >= 3) {
            // Safety valve triggered: Unblock screen, show non-blocking warning banner instead
            gateOverlay.style.display = 'none';
            bannerContainer.innerHTML = `
                <div class="mb-6 p-4 rounded-xl flex items-start gap-3" style="background: rgba(250,204,21,0.06); border: 1px solid rgba(250,204,21,0.25);">
                    <span class="material-symbols-outlined text-warning animate-pulse" style="color: #FACC15;">notifications_active</span>
                    <div class="flex-1">
                        <h4 class="text-sm font-bold text-white mb-1">Stay Online, Stay Earning</h4>
                        <p class="text-xs text-on-surface-variant leading-relaxed">
                            Turn off battery optimization for ReDrivo so you never miss a pickup — just like WhatsApp calls.
                        </p>
                        <button onclick="triggerBackgroundAccessSettings()" class="mt-2 bg-transparent text-primary hover:text-white text-xs font-bold border-none cursor-pointer p-0" style="color: #FACC15; text-decoration: underline;">Turn On</button>
                    </div>
                </div>
            `;
        } else {
            // During the first 2 failed attempts, keep the screen blocked for safety
            gateOverlay.style.display = 'flex';
        }
    }
}

async function triggerBackgroundAccessSettings() {
    try {
        const BatteryOpt = getBatteryOptimizationPlugin();
        if (!BatteryOpt) return;
        
        const { isIgnoring, manufacturer } = await BatteryOpt.isIgnoringBatteryOptimizations();
        
        // First step: Trigger standard ignore dialog
        await BatteryOpt.requestIgnoreBatteryOptimizations();
        
        // Second step: For restricted OEMs, guide them to Autostart settings
        const restrictedOEMs = ['xiaomi', 'oppo', 'vivo', 'huawei', 'honor', 'realme', 'oneplus'];
        const isRestricted = restrictedOEMs.some(oem => manufacturer && manufacturer.includes(oem));
        
        if (isRestricted) {
            setTimeout(() => {
                const prettyOEM = manufacturer.toUpperCase();
                if (confirm(`On ${prettyOEM} devices, Android also requires enabling 'Auto-start' permissions.\n\nWe will now attempt to open your Autostart settings screen. Please find ReDrivo Driver and toggle it ON.`)) {
                    BatteryOpt.openOemBatterySettings()
                        .catch(err => console.error('[ERROR] Failed to open OEM settings:', err));
                }
            }, 1000); // 1-second delay so the system whitelist dialog can resolve first
        } else {
            setTimeout(() => {
                if (confirm("Additional device settings may be required. We will now attempt to open your system battery optimization settings screen. Please ensure ReDrivo is set to 'Unrestricted' or 'Don't Optimize'.")) {
                    BatteryOpt.openOemBatterySettings()
                        .catch(err => console.error('[ERROR] Failed to open OEM settings:', err));
                }
            }, 1000);
        }
    } catch (e) {
        console.error('Failed triggering background access settings:', e);
    }
}

// Hardware Back Button Handling with Double Press to Exit & Modal Close
let lastBackPress = 0;

window.handleAppBack = function() {
    // 1. Check if Document Camera scanner modal is active
    const docCamModal = document.getElementById('document-camera-modal');
    if (docCamModal && (docCamModal.style.display === 'flex' || docCamModal.style.display === 'block')) {
        console.log('Back pressed: Closing document camera modal');
        if (typeof closeDocCamera === 'function') closeDocCamera();
        else { docCamModal.style.display = 'none'; }
        return true;
    }

    // 2. Check if Live Selfie camera preview is actively streaming
    if (cameraStream) {
        console.log('Back pressed: Stopping live selfie camera preview');
        if (typeof stopKycCamera === 'function') stopKycCamera();
        return true;
    }

    // 3. Check if standard modals are open and visible
    const modals = [
        'kyc-permission-modal', 'marshal-feedback-modal', 'confirm-modal', 
        'delivery-otp-modal', 'privacy-modal', 'terms-modal', 
        'gps-disclosure-modal', 'handover-modal', 'onboarding-overlay'
    ];
    
    // Check if any modal is open and visible
    for (const id of modals) {
        const el = document.getElementById(id);
        if (el) {
            const isVisible = el.style.display === 'flex' || 
                              el.style.display === 'block' || 
                              el.style.display === 'grid' || 
                              (!el.classList.contains('hidden') && el.style.display !== 'none');
            
            if (isVisible) {
                console.log('Back pressed: Closing modal', id);
                if (id === 'kyc-permission-modal') {
                    if (typeof denyKycPermission === 'function') denyKycPermission();
                    else { el.style.display = 'none'; el.classList.add('hidden'); }
                } else if (id === 'confirm-modal') {
                    if (typeof closeConfirmModal === 'function') closeConfirmModal(false);
                    else { el.style.display = 'none'; el.classList.add('hidden'); }
                } else if (id === 'delivery-otp-modal') {
                    if (typeof closeDeliveryOtpModal === 'function') closeDeliveryOtpModal();
                    else { el.style.display = 'none'; el.classList.add('hidden'); }
                } else if (id === 'privacy-modal') {
                    if (typeof closePrivacyModal === 'function') closePrivacyModal();
                    else { el.style.display = 'none'; el.classList.add('hidden'); }
                } else if (id === 'terms-modal') {
                    if (typeof closeTermsModal === 'function') closeTermsModal();
                    else { el.style.display = 'none'; el.classList.add('hidden'); }
                } else if (id === 'gps-disclosure-modal') {
                    if (typeof denyGpsConsent === 'function') denyGpsConsent();
                    else { el.style.display = 'none'; el.classList.add('hidden'); }
                } else if (id === 'handover-modal') {
                    if (typeof closeHandoverModal === 'function') closeHandoverModal();
                    else { el.style.display = 'none'; el.classList.add('hidden'); }
                } else if (id === 'onboarding-overlay') {
                    const hasSkipped = sessionStorage.getItem('skipKYC') === 'true';
                    if (hasSkipped) {
                        el.style.display = 'none';
                        el.classList.add('hidden');
                    } else {
                        continue;
                    }
                } else {
                    el.style.display = 'none';
                    el.classList.add('hidden');
                }
                return true; // Handled modal close
            }
        }
    }

    // 4. Check if KYC screen is currently active
    const kycScreen = document.getElementById('kyc-screen');
    if (kycScreen && !kycScreen.classList.contains('hidden') && kycScreen.style.display !== 'none') {
        const step2 = document.getElementById('kyc-step-2');
        const isStep2Active = step2 && step2.style.display === 'block';

        if (isStep2Active) {
            console.log('Back pressed: Navigating back in KYC Wizard (substep', window.currentKycSubStepIndex, ')');
            if (typeof window.prevWizardSubStep === 'function') {
                window.prevWizardSubStep();
                return true;
            }
        } else {
            // In Step 1 (Contact Info) -> Return false to allow double-back-to-exit
            console.log('Back pressed: At KYC Step 1, delegating to exitApp');
            return false;
        }
    }

    // 5. Modal / KYC was not open, perform tab history back
    if (window.marshalTabHistory && window.marshalTabHistory.length > 1) {
        window.marshalTabHistory.pop(); // Pop current tab
        const prevTab = window.marshalTabHistory[window.marshalTabHistory.length - 1];
        console.log('Back pressed: Switching to tab', prevTab);
        if (typeof switchTab === 'function') {
            window.isBackNavigating = true;
            switchTab(prevTab);
            window.isBackNavigating = false;
        }
        return true; // Handled tab back
    }
    
    return false; // Not handled
};

if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    window.Capacitor.Plugins.App.addListener('backButton', () => {
        const handled = window.handleAppBack();
        if (!handled) {
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

    window.Capacitor.Plugins.App.addListener('appUrlOpen', (event) => {
        console.log('App opened with URL:', event.url);
        try {
            if (event.url && event.url.startsWith('redrivo://')) {
                let requestId = null;
                try {
                    const urlObj = new URL(event.url);
                    requestId = urlObj.searchParams.get('id');
                } catch (urlErr) {
                    const match = event.url.match(/[?&]id=([^&]+)/);
                    if (match) requestId = match[1];
                }
                if (requestId) {
                    console.log('Found requestId from deeplink:', requestId);
                    triggerIncomingPickupFromPush(requestId);
                }
            }
        } catch (e) {
            console.error('Failed to parse deeplink URL:', e);
        }
    });
}

// Browser Back Button (popstate) Listener
window.addEventListener('popstate', (event) => {
    // Ignore initial popstate/restoration events on launch before app is fully loaded
    if (!window.isAppLoaded) {
        return;
    }
    // If popstate is fired, the browser has already changed the URL hash.
    // If they pressed back, we intercept it using handleAppBack()
    const handled = window.handleAppBack();
    if (!handled) {
        // If we are at the root ('trips'), push state again to avoid leaving the app
        try {
            history.pushState({ tab: 'trips' }, '', '#trips');
        } catch (e) {
            console.warn('history.pushState failed in popstate', e);
        }
        
        const now = Date.now();
        if (now - lastBackPress < 2000) {
            if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
                window.Capacitor.Plugins.App.exitApp();
            } else {
                console.log('App would exit now in a native context');
            }
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


window.startNativeNavigation = async function(tripId) {
    try {
        const tripsRes = await fetch(API_URL + '/trips');
        const allTrips = await tripsRes.json();
        const trip = allTrips.find(t => t.id === tripId);
        if (!trip) return;

        const reqsRes = await fetch(API_URL + '/requests');
        const allReqs = await reqsRes.json();
        const req = allReqs.find(r => r.id === (trip.serviceRequestId || trip.servicerequestid));
        if (!req) return;

        let tLat, tLng;
        
        const pickupLat = parseFloat(req.pickuplat || req.pickupLat || req.pickup_lat || req.lat || 0);
        const pickupLng = parseFloat(req.pickuplng || req.pickupLng || req.pickup_lng || req.lng || 0);
        const dropLat = parseFloat(req.droplat || req.dropLat || req.drop_lat || req.droplng || pickupLat);
        const dropLng = parseFloat(req.droplng || req.dropLng || req.drop_lng || req.droplng || pickupLng);

        let stops = [];
        if (req.route_stops) {
            stops = typeof req.route_stops === 'string' ? JSON.parse(req.route_stops) : req.route_stops;
        }

        const nextStopIndex = stops.findIndex(s => !s.haltCompletedAt);
        
        if (trip.status === 'assigned' || trip.status === 'pending_otp_1') {
            tLat = pickupLat;
            tLng = pickupLng;
        } else if (trip.status === 'in_transit') {
            if (nextStopIndex !== -1) {
                tLat = parseFloat(stops[nextStopIndex].lat);
                tLng = parseFloat(stops[nextStopIndex].lng);
            } else {
                tLat = dropLat;
                tLng = dropLng;
            }
        } else if (trip.status === 'ready_for_delivery' || trip.status === 'out_for_delivery' || trip.status === 'pending_delivery') {
            tLat = dropLat;
            tLng = dropLng;
        } else {
            showToast('No active destination found', 'error');
            return;
        }

        if (tLat && tLng) {
            const destLabel = encodeURIComponent((trip.status === 'assigned' || trip.status === 'pending_otp_1' ? req.pickup_address : req.drop_address) || 'Destination');
            const url = `https://www.google.com/maps/dir/?api=1&destination=${tLat},${tLng}(${destLabel})&travelmode=driving`;
            window.open(url, '_blank');
        }
    } catch(e) {
        console.error('Nav error', e);
    }
};


window.stopLocationTracking = function() {
    if (typeof marshalLocationInterval !== 'undefined' && marshalLocationInterval) {
        clearInterval(marshalLocationInterval);
    }
    if (window.marshalGpsWatcherId) {
        if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Geolocation) {
            window.Capacitor.Plugins.Geolocation.clearWatch({ id: window.marshalGpsWatcherId });
        } else if (navigator.geolocation) {
            navigator.geolocation.clearWatch(window.marshalGpsWatcherId);
        }
        window.marshalGpsWatcherId = null;
    }
};

window.markArrived = async function(tripId) {
    if (marshalLat === null || marshalLng === null) {
        showToast('Waiting for GPS lock... Please wait a moment.', 'error');
        return;
    }

    try {
        const res = await fetch(`${API_URL}/trips/${tripId}/mark-arrived`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat: marshalLat, lng: marshalLng })
        });
        const data = await res.json();
        if (res.ok) {
            showToast('Arrived at customer location. OTP verification unlocked!', 'success');
            safeSetLocalStorage('trip_state_' + tripId, 'arrived');
            loadMyTrips();
            window.openMapView(tripId);
        } else {
            showToast(data.error || 'Failed to mark arrival.', 'error');
        }
    } catch (err) {
        showToast('Network error: ' + err.message, 'error');
    }
};

async function runInMemoryBlobTest() {
    if (window.hasBlobTestRun) return;
    console.log('[TEST_BLOB] Starting in-memory Blob test upload...');
    try {
        const formData = new FormData();
        formData.append('docType', 'pan');
        
        const blob = new Blob(['fake-image-content-data'], { type: 'image/png' });
        formData.append('file', blob, 'test-inmemory.png');

        const res = await window.fetch(`${API_URL}/workers/marshal_test_blob/kyc-file`, {
            method: 'POST',
            body: formData
        });

        const status = res.status;
        const text = await res.text();
        console.log('[TEST_BLOB_SUCCESS] Server response status:', status, 'body:', text);
        window.hasBlobTestRun = true;
    } catch (e) {
        console.error('[TEST_BLOB_FAILURE] Threw exception:', {
            name: e.name,
            message: e.message,
            stack: e.stack
        });
    }
}
window.runInMemoryBlobTest = runInMemoryBlobTest;
if (!window.hasBlobTestRegistered) {
    window.hasBlobTestRegistered = true;
    setTimeout(runInMemoryBlobTest, 500);
    setTimeout(runInMemoryBlobTest, 2000);
    setTimeout(runInMemoryBlobTest, 5000);
}

// ─── OCR ENGINE & CROSS-DOCUMENT VERIFICATION ───────────────────────────
function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            if (!reader.result) {
                resolve('');
                return;
            }
            const base64String = reader.result.toString().split(',')[1] || '';
            resolve(base64String);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

window.extractedOcrData = {
    pan: { number: null, name: null },
    aadhaar: { number: null, name: null, dob: null, gender: null },
    dl: { number: null, name: null, dob: null, validity: null }
};

// ─── INDEXEDDB & LOCALSTORAGE KYC DRAFT PERSISTENCE ─────────────────────────
const KYC_DB_NAME = 'redrivo_kyc_draft_db';
const KYC_STORE_NAME = 'kyc_photos';
const KYC_DB_VERSION = 1;

function openKycDb() {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            console.warn('[KYC_DRAFT_DB] IndexedDB not supported on this device/webview.');
            return resolve(null);
        }
        const req = indexedDB.open(KYC_DB_NAME, KYC_DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(KYC_STORE_NAME)) {
                db.createObjectStore(KYC_STORE_NAME, { keyPath: 'docType' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
            console.warn('[KYC_DRAFT_DB] Error opening database:', req.error);
            resolve(null);
        };
    });
}

window.saveKycPhotoDraft = async function(docType, fileOrBlob, fileName) {
    try {
        const db = await openKycDb();
        if (!db) return;
        return new Promise((resolve) => {
            const tx = db.transaction(KYC_STORE_NAME, 'readwrite');
            const store = tx.objectStore(KYC_STORE_NAME);
            const record = {
                docType: docType,
                blob: fileOrBlob,
                fileName: fileName || `${docType}_${Date.now()}.jpg`,
                mimeType: fileOrBlob.type || 'image/jpeg',
                fileSize: fileOrBlob.size,
                updatedAt: Date.now()
            };
            store.put(record);
            tx.oncomplete = () => {
                db.close();
                resolve(true);
            };
            tx.onerror = () => {
                db.close();
                resolve(false);
            };
        });
    } catch (err) {
        console.warn('[KYC_DRAFT_DB] Failed to save photo draft:', err);
    }
};

window.getAllKycPhotoDrafts = async function() {
    try {
        const db = await openKycDb();
        if (!db) return [];
        return new Promise((resolve) => {
            const tx = db.transaction(KYC_STORE_NAME, 'readonly');
            const store = tx.objectStore(KYC_STORE_NAME);
            const req = store.getAll();
            req.onsuccess = () => {
                db.close();
                resolve(req.result || []);
            };
            req.onerror = () => {
                db.close();
                resolve([]);
            };
        });
    } catch (err) {
        console.warn('[KYC_DRAFT_DB] Failed to get photo drafts:', err);
        return [];
    }
};

window.saveKycDraftState = function() {
    try {
        const fieldIds = ['on-email', 'on-name', 'on-dob', 'on-gender', 'on-city', 'on-aadhaar', 'on-pan', 'on-dl'];
        const fields = {};
        fieldIds.forEach(id => {
            const el = document.getElementById(id);
            if (el && el.value) fields[id] = el.value.trim();
        });

        const draft = {
            updatedAt: Date.now(),
            currentStep: window.currentKycStep || 1,
            currentSubStepIndex: window.currentKycSubStepIndex !== undefined ? window.currentKycSubStepIndex : 0,
            selectedIdType: window.selectedKycIdType || 'aadhaar',
            extractedOcrData: window.extractedOcrData || {},
            fields: fields
        };

        localStorage.setItem('redrivo_kyc_draft_state', JSON.stringify(draft));
    } catch (err) {
        console.warn('[KYC_DRAFT] Error saving draft state:', err);
    }
};

window.clearKycDraft = async function() {
    try {
        localStorage.removeItem('redrivo_kyc_draft_state');
        sessionStorage.removeItem('skipKYC');

        const db = await openKycDb();
        if (db) {
            await new Promise((resolve) => {
                const tx = db.transaction(KYC_STORE_NAME, 'readwrite');
                tx.objectStore(KYC_STORE_NAME).clear();
                tx.oncomplete = () => { db.close(); resolve(); };
                tx.onerror = () => { db.close(); resolve(); };
            });
        }

        window.capturedKycFiles = {};
        window.extractedOcrData = {
            pan: { number: null, name: null },
            aadhaar: { number: null, name: null, dob: null, gender: null },
            dl: { number: null, name: null, dob: null, validity: null }
        };
        console.log('[KYC_DRAFT] Local draft purged successfully.');
    } catch (err) {
        console.warn('[KYC_DRAFT] Failed to clear draft:', err);
    }
};

window.restoreKycDraftState = async function() {
    try {
        const raw = localStorage.getItem('redrivo_kyc_draft_state');
        if (!raw) return false;

        const draft = JSON.parse(raw);

        // 30-day expiration check (30 * 24 * 60 * 60 * 1000 = 2592000000 ms)
        if (Date.now() - (draft.updatedAt || 0) > 2592000000) {
            console.log('[KYC_DRAFT] Draft expired (>30 days). Purging.');
            await window.clearKycDraft();
            return false;
        }

        // 1. Restore text input values
        if (draft.fields) {
            Object.entries(draft.fields).forEach(([id, val]) => {
                const el = document.getElementById(id);
                if (el && val) el.value = val;
            });
        }

        // 2. Restore in-memory OCR object
        if (draft.extractedOcrData) {
            window.extractedOcrData = draft.extractedOcrData;
        }

        // 3. Restore selected ID choice
        if (draft.selectedIdType && typeof window.selectWizardIdChoice === 'function') {
            window.selectWizardIdChoice(draft.selectedIdType);
        }

        // 4. Restore photo files & preview images from IndexedDB
        const storedPhotos = await window.getAllKycPhotoDrafts();
        if (storedPhotos && storedPhotos.length > 0) {
            window.capturedKycFiles = window.capturedKycFiles || {};
            storedPhotos.forEach(item => {
                const file = new File([item.blob], item.fileName, { type: item.mimeType, lastModified: item.updatedAt });
                window.capturedKycFiles[item.docType] = file;

                const previewImg = document.getElementById(`${item.docType}-photo-preview`);
                if (previewImg) {
                    previewImg.src = URL.createObjectURL(item.blob);
                }
                const previewContainer = document.getElementById(`${item.docType}-wizard-preview-container`);
                const placeholder = document.getElementById(`${item.docType}-wizard-upload-placeholder`);
                if (previewContainer) previewContainer.classList.remove('hidden');
                if (placeholder) placeholder.classList.add('hidden');

                // Special handling for selfie preview container
                if (item.docType === 'face') {
                    const capturedImg = document.getElementById('captured-photo');
                    if (capturedImg) capturedImg.src = URL.createObjectURL(item.blob);
                    const photoPrevContainer = document.getElementById('photo-preview-container');
                    if (photoPrevContainer) {
                        photoPrevContainer.classList.remove('hidden');
                        photoPrevContainer.style.display = 'flex';
                    }
                }
            });
        }

        // 5. Restore step position
        if (draft.currentStep && draft.currentStep > 1) {
            goToKycStep(draft.currentStep, true);
            if (draft.currentSubStepIndex !== undefined) {
                window.currentKycSubStepIndex = draft.currentSubStepIndex;
                if (window.updateWizardView) window.updateWizardView();
            }
        }

        if (window.checkWizardState) window.checkWizardState();
        return true;
    } catch (err) {
        console.warn('[KYC_DRAFT] Error restoring draft state:', err);
        return false;
    }
};

// ─── FUZZY LEVENSHTEIN BOILERPLATE MATCHER ─────────────────────────────────
function getLevenshteinDistance(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost
            );
        }
    }
    return dp[m][n];
}

function isBoilerplateFuzzy(rawText) {
    if (!rawText) return false;
    const compact = rawText.toUpperCase().replace(/[^A-Z]/g, '');
    if (compact.length < 4) return false;

    // Direct token containment for common corruptions
    if (compact.includes('GOVENM') || compact.includes('GOVT') || compact.includes('OFINDIA') || compact.includes('SARKAR') || compact.includes('UIDAI')) {
        return true;
    }

    const KNOWN_PHRASES = [
        'GOVERNMENTOFINDIA',
        'GOVERNMENT',
        'BHARATSARKAR',
        'UNIQUEIDENTIFICATIONAUTHORITYOFINDIA',
        'UIDAI',
        'MERAADHAARMERIPEHCHAN',
        'ENROLMENT',
        'HELP',
        'UNIONOFINDIA',
        'DRIVINGLICENCE',
        'MOTORVEHICLES',
        'TRANSPORTDEPARTMENT'
    ];

    for (const phrase of KNOWN_PHRASES) {
        const dist = getLevenshteinDistance(compact, phrase);
        const maxLen = Math.max(compact.length, phrase.length);
        const similarity = 1 - (dist / maxLen);
        if (similarity >= 0.58 || (dist <= 4 && compact.length >= 8)) {
            return true;
        }
    }
    return false;
}

// ─── DEBUG OCR CLIPBOARD / MODAL HELPER ─────────────────────────────────────
let titleTapCount = 0;
let titleTapTimer = null;
window.handleDebugOcrTap = function() {
    titleTapCount++;
    clearTimeout(titleTapTimer);
    titleTapTimer = setTimeout(() => { titleTapCount = 0; }, 900);
    if (titleTapCount >= 3) {
        titleTapCount = 0;
        const debugData = {
            timestamp: new Date().toISOString(),
            extractedOcrData: window.extractedOcrData || {},
            lastRawOcrDetections: window.lastRawOcrDetections || {},
            lastCombinedText: window.lastCombinedText || {}
        };
        const jsonStr = JSON.stringify(debugData, null, 2);
        
        const showModalFallback = () => {
            const existing = document.getElementById('debug-ocr-modal');
            if (existing) existing.remove();
            
            const modal = document.createElement('div');
            modal.id = 'debug-ocr-modal';
            modal.className = 'fixed inset-0 bg-black/95 z-[99999] p-4 flex flex-col justify-between';
            modal.innerHTML = `
                <div class="flex justify-between items-center mb-2">
                    <h4 class="text-amber-400 font-bold text-sm">Raw OCR Debug JSON</h4>
                    <button class="text-white font-bold px-3 py-1 bg-white/10 rounded" onclick="this.closest('#debug-ocr-modal').remove()">Close</button>
                </div>
                <textarea readonly id="debug-ocr-textarea" class="w-full flex-1 bg-[#121212] text-green-400 text-xs font-mono p-3 rounded border border-white/10 select-all"></textarea>
                <button class="mt-2 w-full py-3 bg-amber-500 text-black font-bold rounded" onclick="const ta=document.getElementById('debug-ocr-textarea'); ta.select(); document.execCommand('copy'); showToast('Copied to clipboard!', 'success');">Copy All</button>
            `;
            document.body.appendChild(modal);
            const ta = modal.querySelector('textarea');
            ta.value = jsonStr;
            ta.focus();
            ta.select();
            showToast('Raw OCR debug view opened!', 'info');
        };

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(jsonStr).then(() => {
                showToast('Raw OCR debug JSON copied to clipboard!', 'success');
            }).catch(() => {
                showModalFallback();
            });
        } else {
            showModalFallback();
        }
    }
};

// ─── UPGRADED DOCUMENT OCR ENGINE ───────────────────────────────────────────
window.performDocumentOcr = async function(type, blob) {
    console.log(`[OCR] Starting OCR analysis for ${type}...`);
    try {
        const plugins = window.Capacitor && window.Capacitor.Plugins;
        const ocrPlugin = plugins && (plugins.CapacitorOcr || plugins.Ocr);
        if (!ocrPlugin) {
            console.warn('[OCR] CapacitorOcr plugin not available on window.Capacitor.Plugins.');
            return;
        }

        const base64Data = await blobToBase64(blob);
        if (!base64Data) {
            console.warn('[OCR] Failed to convert blob to base64.');
            return;
        }

        const result = await ocrPlugin.detectText({ base64: base64Data });
        console.log(`[OCR] DetectText result for ${type}:`, result);

        if (!result || !result.textDetections || result.textDetections.length === 0) {
            console.log(`[OCR] No text detected in ${type}.`);
            if (type === 'aadhaar' || type === 'pan' || type === 'dl') {
                window.extractedOcrData[type].failed = true;
                window.crossVerifyDocumentNames();
            }
            return;
        }

        const allDetections = result.textDetections.map(d => (d.text || '').trim()).filter(Boolean);
        const fullText = allDetections.join(' ');
        console.log(`[OCR] Combined extracted text for ${type}:`, fullText);

        // Store raw debug trace
        window.lastRawOcrDetections = window.lastRawOcrDetections || {};
        window.lastCombinedText = window.lastCombinedText || {};
        window.lastRawOcrDetections[type] = allDetections;
        window.lastCombinedText[type] = fullText;

        const BOILERPLATE_LINE_REGEX = /(GOVERNMENT|GOVERMENT|GOVT|INDIA|BHARAT|SARKAR|UNIQUE IDENTIFICATION|AUTHORITY OF INDIA|UIDAI|AADHAAR|ADHAR|ENROLMENT|ENROLLMENT|HELP|DOWNLOAD|MERA AADHAAR|MERI PEHCHAN|UNION OF INDIA|STATE|DEPARTMENT|MOTOR VEHICLES|TRANSPORT|COMMISSIONERATE|FORM\s*\d+|DRIVING LICEN[CS]E)/i;
        const BOILERPLATE_WORD_REGEX = /^(GOVERNMENT|GOVERMENT|GOVT|INDIA|BHARAT|SARKAR|UNIQUE|IDENTIFICATION|AUTHORITY|UIDAI|AADHAAR|ADHAR|ENROLMENT|ENROLLMENT|HELP|DOWNLOAD|MERA|MERI|PEHCHAN|ADDRESS|CARE|OF|C\/O|S\/O|D\/O|W\/O|FATHER|HUSBAND|SIGNATURE|MALE|FEMALE|TRANSGENDER|DOB|DATE|OF|BIRTH|YEAR|YOB|UNION|STATE|MOTOR|VEHICLES|TRANSPORT|DEPT|DEPARTMENT|COMMISSIONERATE|FORM|DRIVING|LICENCE|LICENSE|VALIDITY|VALID|TILL|UPTO|NON|TRANSPORT|NT|TR|COV|LMV|MCWG|MCWOG|HMV|HPMV)$/i;

        // 1. PAN Number & Name Extraction
        if (type === 'pan' || type === 'panback') {
            const panMatch = fullText.match(/[A-Z]{5}[0-9]{4}[A-Z]{1}/);
            if (panMatch) {
                const panNumber = panMatch[0];
                window.extractedOcrData.pan.number = panNumber;
                const panInput = document.getElementById('on-pan');
                if (panInput) {
                    panInput.value = panNumber;
                    const badge = document.getElementById('pan-ocr-badge');
                    if (badge) badge.classList.remove('hidden');
                    showToast(`PAN Number auto-captured: ${panNumber}`, 'success');
                }
            }

            if (type === 'pan') {
                let panCandidates = [];
                for (const rawLine of allDetections) {
                    if (/\d/.test(rawLine)) continue;
                    if (/(INCOME TAX|PERMANENT|ACCOUNT|CARD|FATHER|DATE OF BIRTH|DOB|SIGNATURE)/i.test(rawLine)) continue;
                    if (BOILERPLATE_LINE_REGEX.test(rawLine) || isBoilerplateFuzzy(rawLine)) continue;
                    const clean = rawLine.replace(/[^A-Za-z\s\.]/g, ' ').replace(/\s+/g, ' ').trim();
                    if (clean.length < 3 || clean.length > 35) continue;
                    const words = clean.split(' ').filter(w => w.length > 1);
                    if (words.length === 1 && clean.length > 8) continue;
                    if (words.length >= 1 && words.length <= 4 && words.every(w => !BOILERPLATE_WORD_REGEX.test(w.toUpperCase()))) {
                        panCandidates.push(clean);
                    }
                }
                window.extractedOcrData.pan.name = panCandidates[0] || null;
            }
        }

        // 2. Aadhaar Number & Details Extraction
        if (type === 'aadhaar' || type === 'aadhaarback') {
            const aadhaarMatch = fullText.match(/\b\d{4}\s?\d{4}\s?\d{4}\b/);
            if (aadhaarMatch) {
                const rawNum = aadhaarMatch[0].replace(/\s/g, '');
                if (rawNum.length === 12) {
                    const formatted = rawNum.replace(/(\d{4})(\d{4})(\d{4})/, '$1 $2 $3');
                    window.extractedOcrData.aadhaar.number = formatted;
                    const aadhaarInput = document.getElementById('on-aadhaar');
                    if (aadhaarInput) {
                        aadhaarInput.value = formatted;
                        const badge = document.getElementById('aadhaar-ocr-badge');
                        if (badge) badge.classList.remove('hidden');
                        showToast(`Aadhaar Number auto-captured: ${formatted}`, 'success');
                    }
                }
            }

            if (type === 'aadhaar') {
                // Name Extraction with Fuzzy Boilerplate Rejection & DOB Anchor Precedence
                let dobLineIdx = -1;
                for (let i = 0; i < allDetections.length; i++) {
                    const line = allDetections[i];
                    if (/(?:DOB|Date\s*of\s*Birth|D\.O\.B|जन्म\s*तिथि|\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4}\b)/i.test(line)) {
                        dobLineIdx = i;
                        break;
                    }
                }

                const isValidNameCandidate = (rawLine) => {
                    if (/\d/.test(rawLine)) return false;
                    if (/(DOB|DATE OF BIRTH|YEAR|YOB|MALE|FEMALE|GENDER|FATHER|HUSBAND|C\/O|S\/O|W\/O|D\/O)/i.test(rawLine)) return false;
                    if (BOILERPLATE_LINE_REGEX.test(rawLine)) return false;
                    if (isBoilerplateFuzzy(rawLine)) return false;

                    const clean = rawLine.replace(/[^A-Za-z\s\.]/g, ' ').replace(/\s+/g, ' ').trim();
                    if (clean.length < 3 || clean.length > 35) return false;

                    const words = clean.split(' ').filter(w => w.length > 1);
                    // Single long word without spaces (>8 chars) is likely garbled header/code
                    if (words.length === 1 && clean.length > 8) return false;
                    if (words.length < 1 || words.length > 4) return false;
                    if (words.some(w => BOILERPLATE_WORD_REGEX.test(w.toUpperCase()))) return false;

                    return clean;
                };

                let aadhaarNameExtracted = null;

                // Priority 1: DOB Anchor - inspect lines immediately above the DOB
                if (dobLineIdx > 0) {
                    for (let i = dobLineIdx - 1; i >= Math.max(0, dobLineIdx - 3); i--) {
                        const verified = isValidNameCandidate(allDetections[i]);
                        if (verified) {
                            aadhaarNameExtracted = verified;
                            console.log(`[OCR] Name found via DOB anchor precedence at index ${i}: "${verified}"`);
                            break;
                        }
                    }
                }

                // Priority 2: General scan if DOB anchor scan found nothing
                if (!aadhaarNameExtracted) {
                    let candidates = [];
                    // If >= 4 lines detected, skip the top line (header zone)
                    const startIdx = allDetections.length >= 4 ? 1 : 0;
                    for (let i = startIdx; i < allDetections.length; i++) {
                        const verified = isValidNameCandidate(allDetections[i]);
                        if (verified) {
                            candidates.push(verified);
                        }
                    }
                    aadhaarNameExtracted = candidates[0] || null;
                }

                window.extractedOcrData.aadhaar.name = aadhaarNameExtracted;

                if (aadhaarNameExtracted) {
                    const nameInput = document.getElementById('on-name');
                    if (nameInput) nameInput.value = aadhaarNameExtracted;
                    if (window.currentUser) {
                        window.currentUser.name = aadhaarNameExtracted;
                        safeSetLocalStorage('marshalUser', JSON.stringify(window.currentUser));
                    }
                    showToast(`Name auto-filled from Aadhaar: ${aadhaarNameExtracted}`, 'success');
                }

                // DOB Extraction
                let dobVal = null;
                const explicitDob = fullText.match(/(?:DOB|Date\s*of\s*Birth|D\.O\.B|D0B|जन्म\s*तिथि|जन्म\s*तारीख)\s*[:\-]?\s*(\d{1,2})[\/\-\.\s](\d{1,2})[\/\-\.\s](\d{4})/i);
                if (explicitDob) {
                    dobVal = `${explicitDob[1].padStart(2, '0')}/${explicitDob[2].padStart(2, '0')}/${explicitDob[3]}`;
                } else {
                    const standaloneDate = fullText.match(/\b(\d{2})[\/\-\.](\d{2})[\/\-\.](\d{4})\b/);
                    if (standaloneDate && parseInt(standaloneDate[1], 10) <= 31 && parseInt(standaloneDate[2], 10) <= 12) {
                        dobVal = `${standaloneDate[1]}/${standaloneDate[2]}/${standaloneDate[3]}`;
                    } else {
                        const yobMatch = fullText.match(/(?:Year\s*of\s*Birth|YOB|जन्म\s*वर्ष)\s*[:\-]?\s*(\d{4})/i);
                        if (yobMatch && parseInt(yobMatch[1], 10) >= 1940 && parseInt(yobMatch[1], 10) <= 2015) {
                            dobVal = `01/01/${yobMatch[1]}`;
                        }
                    }
                }

                if (dobVal) {
                    window.extractedOcrData.aadhaar.dob = dobVal;
                    const dobInput = document.getElementById('on-dob');
                    if (dobInput) dobInput.value = dobVal;
                    if (window.currentUser) {
                        window.currentUser.dob = dobVal;
                        safeSetLocalStorage('marshalUser', JSON.stringify(window.currentUser));
                    }
                    console.log(`[OCR] Extracted DOB: ${dobVal}`);
                }

                // Gender Extraction
                let genderVal = null;
                if (/\b(FEMALE|FEMA\s*LE)\b/i.test(fullText) || fullText.includes('महिला') || fullText.includes('स्त्री')) {
                    genderVal = 'Female';
                } else if (/\b(MALE|MAL\s*E|MAIE)\b/i.test(fullText) || fullText.includes('पुरुष')) {
                    genderVal = 'Male';
                } else if (/\b(TRANSGENDER)\b/i.test(fullText) || fullText.includes('ट्रांसजेंडर')) {
                    genderVal = 'Transgender';
                }

                if (genderVal) {
                    window.extractedOcrData.aadhaar.gender = genderVal;
                    const genderInput = document.getElementById('on-gender');
                    if (genderInput) genderInput.value = genderVal;
                    if (window.currentUser) {
                        window.currentUser.gender = genderVal;
                        safeSetLocalStorage('marshalUser', JSON.stringify(window.currentUser));
                    }
                    console.log(`[OCR] Extracted Gender: ${genderVal}`);
                }
            }
        }

        // 3. DL Number & Details Extraction
        if (type === 'dl' || type === 'dlback') {
            let dlNum = null;
            const standardDlMatch = fullText.match(/\b([A-Z]{2})[\s\-\/]?([0-9]{2})[\s\-\/]?([0-9]{4})[\s\-\/]?([0-9]{7})\b/i);
            if (standardDlMatch) {
                dlNum = `${standardDlMatch[1]}${standardDlMatch[2]} ${standardDlMatch[3]}${standardDlMatch[4]}`.toUpperCase();
            } else {
                const labeledDlMatch = fullText.match(/(?:DL\s*(?:NO|NUM|NUMBER)?|LICENCE\s*NO|LICENSE\s*NO)\s*[:\-]?\s*([A-Z]{2}[\s\-\/]?[0-9]{2}[\s\-\/]?[0-9A-Z\/\-]{7,15})\b/i);
                if (labeledDlMatch) {
                    dlNum = labeledDlMatch[1].replace(/[\/\-]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
                } else {
                    const genericMatch = fullText.match(/\b([A-Z]{2}[0-9]{2}[\s\-\/][0-9A-Z\/\-\s]{8,14})\b/i);
                    if (genericMatch) {
                        dlNum = genericMatch[1].replace(/[\/\-]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
                    }
                }
            }

            if (dlNum) {
                window.extractedOcrData.dl.number = dlNum;
                const dlInput = document.getElementById('on-dl');
                if (dlInput) {
                    dlInput.value = dlNum;
                    const badge = document.getElementById('dl-ocr-badge');
                    if (badge) badge.classList.remove('hidden');
                    showToast(`Driving License Number auto-captured: ${dlNum}`, 'success');
                }
            }

            if (type === 'dl') {
                const DL_IGNORE_REGEX = /(DRIVING\s*LICEN[CS]E|UNION\s*OF\s*INDIA|STATE|DEPARTMENT|MOTOR\s*VEHICLES|TRANSPORT|COMMISSIONERATE|FORM\s*\d+)/i;
                let dlCandidates = [];
                for (const rawLine of allDetections) {
                    if (/^(?:NAME|CARDHOLDER'S\s*NAME)\s*[:\-]/i.test(rawLine)) {
                        const clean = rawLine.replace(/^(?:NAME|CARDHOLDER'S\s*NAME)\s*[:\-]\s*/i, '').trim();
                        if (clean.length >= 3) { dlCandidates.unshift(clean); break; }
                    }
                    if (/\d/.test(rawLine)) continue;
                    if (/(DOB|VALIDITY|COV|AUTHORIZATION)/i.test(rawLine)) continue;
                    if (DL_IGNORE_REGEX.test(rawLine)) continue;
                    const clean = rawLine.replace(/[^A-Za-z\s\.]/g, ' ').replace(/\s+/g, ' ').trim();
                    if (clean.length >= 3 && clean.length <= 35 && !BOILERPLATE_WORD_REGEX.test(clean.toUpperCase())) {
                        dlCandidates.push(clean);
                    }
                }
                const dlNameExtracted = dlCandidates[0] || null;
                window.extractedOcrData.dl.name = dlNameExtracted;

                // DL DOB
                const dlDobMatch = fullText.match(/(?:DOB|Date\s*of\s*Birth)\s*[:\-]?\s*(\d{1,2})[\/\-\.\s](\d{1,2})[\/\-\.\s](\d{4})/i);
                if (dlDobMatch) {
                    window.extractedOcrData.dl.dob = `${dlDobMatch[1].padStart(2, '0')}/${dlDobMatch[2].padStart(2, '0')}/${dlDobMatch[3]}`;
                }

                // DL Validity
                const validityMatch = fullText.match(/(?:Valid\s*(?:Till|Upto|To)|Validity(?:\s*\([A-Z]+\))?)\s*[:\-]?\s*(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/i);
                if (validityMatch) {
                    window.extractedOcrData.dl.validity = `${validityMatch[1].padStart(2, '0')}/${validityMatch[2].padStart(2, '0')}/${validityMatch[3]}`;
                }
            }
        }

        // Cross-verify details across documents
        window.crossVerifyDocumentNames();

        // Persist draft after OCR
        if (typeof window.saveKycDraftState === 'function') {
            window.saveKycDraftState();
        }

        if (window.checkWizardState) window.checkWizardState();
    } catch (err) {
        console.error('[OCR_PROCESS_ERROR]', err);
    }
};

// ─── CROSS-DOCUMENT CONSISTENCY CHECK ENGINE ────────────────────────────────
window.evaluateCrossDocumentConsistency = function() {
    const aadhaar = window.extractedOcrData.aadhaar || {};
    const dl = window.extractedOcrData.dl || {};
    const pan = window.extractedOcrData.pan || {};

    const banner = document.getElementById('cross-doc-warning-banner');
    const bannerText = document.getElementById('cross-doc-warning-text');
    if (!banner || !bannerText) return;

    const discrepancies = [];

    // 1. Name Check (Aadhaar vs DL)
    if (aadhaar.name && dl.name) {
        const tokensA = aadhaar.name.toUpperCase().split(/\s+/).filter(w => w.length > 1);
        const tokensD = dl.name.toUpperCase().split(/\s+/).filter(w => w.length > 1);
        const hasMatch = tokensA.some(t => tokensD.some(t2 => t2.includes(t) || t.includes(t2)));
        if (!hasMatch) {
            discrepancies.push(`Name on Aadhaar ("${aadhaar.name}") differs from Driving License ("${dl.name}").`);
        }
    }

    // 2. Name Check (PAN vs Aadhaar)
    if (pan.name && aadhaar.name) {
        const tokensP = pan.name.toUpperCase().split(/\s+/).filter(w => w.length > 1);
        const tokensA = aadhaar.name.toUpperCase().split(/\s+/).filter(w => w.length > 1);
        const hasMatch = tokensP.some(t => tokensA.some(t2 => t2.includes(t) || t.includes(t2)));
        if (!hasMatch) {
            discrepancies.push(`Name on PAN ("${pan.name}") differs from Aadhaar ("${aadhaar.name}").`);
        }
    }

    // 3. DOB Check (Aadhaar vs DL)
    if (aadhaar.dob && dl.dob && aadhaar.dob !== dl.dob) {
        discrepancies.push(`Date of Birth on Aadhaar (${aadhaar.dob}) differs from Driving License (${dl.dob}).`);
    }

    if (discrepancies.length > 0) {
        bannerText.innerHTML = discrepancies.join('<br>');
        banner.classList.remove('hidden');
    } else {
        banner.classList.add('hidden');
    }
};

window.crossVerifyDocumentNames = function() {
    window.evaluateCrossDocumentConsistency();

    // Top banner backwards compatibility
    const topBanner = document.getElementById('name-mismatch-banner');
    const topBannerText = document.getElementById('name-mismatch-text');
    if (!topBanner || !topBannerText) return;

    const aadhaarName = (window.extractedOcrData.aadhaar.name || '').toUpperCase().trim();
    const panName = (window.extractedOcrData.pan.name || '').toUpperCase().trim();
    const dlName = (window.extractedOcrData.dl.name || '').toUpperCase().trim();

    let warningMsg = '';
    const checkSimilarity = (name1, name2) => {
        if (!name1 || !name2) return false;
        const t1 = name1.split(/\s+/).filter(t => t.length > 1);
        const t2 = name2.split(/\s+/).filter(t => t.length > 1);
        return t1.some(t => t2.some(t2 => t2.includes(t) || t.includes(t2)));
    };

    if (aadhaarName && panName && !checkSimilarity(aadhaarName, panName)) {
        warningMsg = `Name on PAN (${panName}) does not match Aadhaar (${aadhaarName}). Please verify.`;
    } else if (aadhaarName && dlName && !checkSimilarity(aadhaarName, dlName)) {
        warningMsg = `Name on DL (${dlName}) does not match Aadhaar (${aadhaarName}). Please verify.`;
    }

    if (warningMsg) {
        topBannerText.textContent = warningMsg;
        topBanner.classList.remove('hidden');
    } else {
        topBanner.classList.add('hidden');
    }
};

// ─── COMBINED KYC WIZARD NAVIGATION CONTROLLER ───────────────────────────
window.selectedKycIdType = 'aadhaar'; // default: Aadhaar Card

window.buildKycWizardSubSteps = function() {
    return [
        'vehicle',        // Sub-step 0: Vehicle category
        'id-choice',      // Sub-step 1: ID Type Selection (Aadhaar or PAN)
        window.selectedKycIdType, // Sub-step 2: Chosen ID document ('aadhaar' or 'pan')
        'selfie',         // Sub-step 3: Live Selfie
        'dl',             // Sub-step 4: Combined DL (Front + Back + Number)
        'confirm'         // Sub-step 5: Review & Confirm Profile Details
    ];
};

window.kycWizardSubSteps = window.buildKycWizardSubSteps();
window.currentKycSubStepIndex = 0;
window.selectedVehicleTypes = ['bike'];

window.selectWizardIdChoice = function(idType) {
    window.selectedKycIdType = idType;
    const cardAadhaar = document.getElementById('id-choice-card-aadhaar');
    const cardPan = document.getElementById('id-choice-card-pan');
    
    if (cardAadhaar && cardPan) {
        if (idType === 'aadhaar') {
            cardAadhaar.classList.add('active');
            cardPan.classList.remove('active');
        } else {
            cardPan.classList.add('active');
            cardAadhaar.classList.remove('active');
        }
    }
    
    window.kycWizardSubSteps = window.buildKycWizardSubSteps();
    console.log('[KYC_WIZARD] Selected ID Type:', idType, 'Updated Sub-steps:', window.kycWizardSubSteps);
};

window.toggleWizardVehicle = function(vehicleType) {
    if (!Array.isArray(window.selectedVehicleTypes)) {
        window.selectedVehicleTypes = ['bike'];
    }
    const normType = (vehicleType === 'auto' || vehicleType === 'car') ? 'car' : 'bike';
    const idx = window.selectedVehicleTypes.indexOf(normType);
    
    if (idx > -1) {
        if (window.selectedVehicleTypes.length === 1) {
            if (typeof showToast === 'function') {
                showToast('At least one vehicle category must be selected.', 'warning');
            }
            return;
        }
        window.selectedVehicleTypes.splice(idx, 1);
    } else {
        window.selectedVehicleTypes.push(normType);
    }
    
    const bikeCard = document.getElementById('vehicle-card-bike');
    const carCard = document.getElementById('vehicle-card-car');
    if (bikeCard) bikeCard.classList.toggle('active', window.selectedVehicleTypes.includes('bike'));
    if (carCard) carCard.classList.toggle('active', window.selectedVehicleTypes.includes('car'));
    
    console.log('[KYC_WIZARD] Selected Vehicle Types:', window.selectedVehicleTypes);
};

// Backwards-compatible alias
window.selectWizardVehicle = window.toggleWizardVehicle;

window.updateWizardView = function() {
    const activeStepId = window.kycWizardSubSteps[window.currentKycSubStepIndex];
    
    // Hide all substep sections
    document.querySelectorAll('.wizard-substep-section').forEach(el => {
        el.classList.add('hidden');
    });
    
    // Show active substep section
    const activeSec = document.getElementById(`wizard-substep-${activeStepId}`);
    if (activeSec) {
        activeSec.classList.remove('hidden');
    }
    
    // Header back button is always visible
    const backBtn = document.getElementById('btn-wizard-back');
    if (backBtn) {
        backBtn.style.visibility = 'visible';
    }
    
    // Update Title text matching active step
    const titleEl = document.getElementById('kyc-wizard-title');
    if (titleEl) {
        const titles = {
            'vehicle': 'Vehicle Type',
            'id-choice': 'Select Identity Document',
            'pan': 'PAN Card Verification',
            'aadhaar': 'Aadhaar Verification',
            'selfie': 'Live Selfie',
            'dl': 'Driving License Verification',
            'confirm': 'Review & Confirm Profile'
        };
        titleEl.textContent = titles[activeStepId] || 'Document Verification';
    }
    
    // Auto start/stop camera on selfie step
    if (activeStepId === 'selfie') {
        window.checkWizardState();
    } else {
        if (typeof window.stopKycCamera === 'function') {
            window.stopKycCamera();
        }
    }

    if (activeStepId === 'confirm') {
        const confirmReachTime = new Date().toISOString();
        const currentCity = document.getElementById('on-city') ? document.getElementById('on-city').value : '';
        console.log(`[GPS_TIMING] [${confirmReachTime}] User reached Sub-step (Review & Confirm Profile). Current #on-city value: "${currentCity}".`);
        if (window.crossVerifyDocumentNames) {
            window.crossVerifyDocumentNames();
        }
    }
    
    // Persist draft position & details
    if (typeof window.saveKycDraftState === 'function') {
        window.saveKycDraftState();
    }

    // Run checks to enable/disable button
    window.checkWizardState();
};


window.nextWizardSubStep = function() {
    if (window.currentKycSubStepIndex < window.kycWizardSubSteps.length - 1) {
        window.currentKycSubStepIndex++;
        window.updateWizardView();
        const stepContainer = document.getElementById('kyc-step-2');
        if (stepContainer) {
            stepContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }
};

window.prevWizardSubStep = function() {
    if (window.currentKycSubStepIndex > 0) {
        window.currentKycSubStepIndex--;
        window.updateWizardView();
        const stepContainer = document.getElementById('kyc-step-2');
        if (stepContainer) {
            stepContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    } else {
        // Sub-step 0 (Vehicle Type) -> Navigate back to Step 1 (Contact Info)
        window.goToKycStep(1);
        const stepContainer = document.getElementById('kyc-step-1');
        if (stepContainer) {
            stepContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }
};

window.validateConfirmSubstep = function(silent = false) {
    const nameEl = document.getElementById('on-name');
    const dobEl = document.getElementById('on-dob');
    const genderEl = document.getElementById('on-gender');
    const cityEl = document.getElementById('on-city');

    const name = nameEl ? nameEl.value.trim() : '';
    const dob = dobEl ? dobEl.value.trim() : '';
    const gender = genderEl ? genderEl.value.trim() : '';
    const city = cityEl ? cityEl.value.trim() : '';

    const isNameValid = name.length >= 2 && window.validateFullName(name);
    const isDobValid = dob.length >= 8 && /^\d{2}[\/\-]\d{2}[\/\-]\d{4}$/.test(dob);
    const isGenderValid = gender.length >= 3;
    const isCityValid = city.length >= 2;

    if (!silent) {
        if (!isNameValid) {
            window.setKYCFieldError(nameEl, 'Full Name is required (min 2 characters).');
        } else {
            window.clearKYCFieldError(nameEl);
        }

        if (!isDobValid) {
            window.setKYCFieldError(dobEl, 'Valid Date of Birth is required (DD/MM/YYYY).');
        } else {
            window.clearKYCFieldError(dobEl);
        }

        if (!isGenderValid) {
            window.setKYCFieldError(genderEl, 'Please enter/select your Gender.');
        } else {
            window.clearKYCFieldError(genderEl);
        }

        if (!isCityValid) {
            window.setKYCFieldError(cityEl, 'Operating City is required.');
            const cityDropdown = document.getElementById('city-dropdown');
            if (cityDropdown && typeof window.showCityDropdownManual === 'function') {
                window.showCityDropdownManual();
            }
        } else {
            window.clearKYCFieldError(cityEl);
        }
    }

    return isNameValid && isDobValid && isGenderValid && isCityValid;
};

window.submitProfileConfirmationAndProceed = function() {
    submitOnboarding();
};

window.checkWizardState = function() {
    const activeStepId = window.kycWizardSubSteps[window.currentKycSubStepIndex];
    
    const isDocUploadedOrSelected = (type) => {
        const hasLocal = !!window.capturedKycFiles[type];
        const previewImg = document.getElementById(`${type}-photo-preview`);
        const hasPreview = !!(previewImg && previewImg.src && !previewImg.src.endsWith('/') && previewImg.src !== window.location.href && previewImg.src !== window.location.origin + '/');
        
        const wizardPreview = document.getElementById(`${type}-wizard-preview-container`);
        const wizardPlaceholder = document.getElementById(`${type}-wizard-upload-placeholder`);
        
        if (hasLocal || hasPreview) {
            if (wizardPreview) wizardPreview.classList.remove('hidden');
            if (wizardPlaceholder) wizardPlaceholder.classList.add('hidden');
            return true;
        } else {
            if (wizardPreview) wizardPreview.classList.add('hidden');
            if (wizardPlaceholder) wizardPlaceholder.classList.remove('hidden');
            return false;
        }
    };
    
    if (activeStepId === 'pan') {
        const frontOk = isDocUploadedOrSelected('pan');
        const backOk = isDocUploadedOrSelected('panback');
        const ok = frontOk && backOk;
        const nextBtn = document.getElementById('btn-pan-next');
        if (nextBtn) {
            nextBtn.disabled = !ok;
            nextBtn.style.opacity = ok ? '1' : '0.5';
        }
    } else if (activeStepId === 'aadhaar') {
        const frontOk = isDocUploadedOrSelected('aadhaar');
        const backOk = isDocUploadedOrSelected('aadhaarback');
        const ok = frontOk && backOk;
        const nextBtn = document.getElementById('btn-aadhaar-next');
        if (nextBtn) {
            nextBtn.disabled = !ok;
            nextBtn.style.opacity = ok ? '1' : '0.5';
        }
    } else if (activeStepId === 'selfie') {
        const previewImg = document.getElementById('face-photo-preview');
        const previewContainer = document.getElementById('face-photo-preview-container');
        const ok = !!(previewImg && previewImg.src && !previewImg.src.endsWith('/')) || (previewContainer && previewContainer.style.display !== 'none');
        const nextBtn = document.getElementById('btn-selfie-next');
        if (nextBtn) {
            nextBtn.disabled = !ok;
            nextBtn.style.opacity = ok ? '1' : '0.5';
        }
    } else if (activeStepId === 'dl') {
        const frontOk = isDocUploadedOrSelected('dl');
        const backOk = isDocUploadedOrSelected('dlback');
        const ok = frontOk && backOk;
        const nextBtn = document.getElementById('btn-dl-next');
        if (nextBtn) {
            nextBtn.disabled = !ok;
            nextBtn.style.opacity = ok ? '1' : '0.5';
        }
    } else if (activeStepId === 'confirm') {
        const nextBtn = document.getElementById('btn-confirm-next');
        if (nextBtn) {
            nextBtn.disabled = false;
            nextBtn.style.opacity = '1';
        }
    }
};

window.showKycHelp = function() {
    showToast('Please upload clear photos of both sides of your documents.', 'info');
};

window.callKycSupport = function() {
    showToast('Calling driver support helpline...', 'info');
};






