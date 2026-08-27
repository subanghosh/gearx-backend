'use strict';
const API_URL = '/api';
const nativeFetch = window.fetch;
window.fetch = async function(resource, init) {
    init = init || {};
    init.headers = init.headers || {};
    const token = localStorage.getItem('redrivo_token');
    if (token) {
        init.headers['Authorization'] = `Bearer ${token}`;
    }
    return nativeFetch(resource, init);
};
let user = null; 
let activeOrder = null;
let currentAuditItems = [];
let authMethod = 'mobile';
const PROTOTYPE_STATE = {
    currentOwners: []
};

// --- KYC HELPERS ---
function formatPAN(el) {
    let val = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    let clean = '';
    for(let i=0; i<val.length; i++) {
        if (i < 5) { // First 5: Letters
            if (/[A-Z]/.test(val[i])) clean += val[i];
        } else if (i < 9) { // Next 4: Numbers
            if (/[0-9]/.test(val[i])) clean += val[i];
        } else if (i < 10) { // Last 1: Letter
            if (/[A-Z]/.test(val[i])) clean += val[i];
        }
    }
    el.value = clean.substring(0, 10);
}

function formatID(el) {
    const type = document.getElementById('k-id-type').value;
    if (type === 'Aadhaar Card') {
        let val = el.value.replace(/[^0-9]/g, '').substring(0, 12);
        let formatted = '';
        for(let i=0; i<val.length; i++) {
            if (i > 0 && i % 4 === 0) formatted += '-';
            formatted += val[i];
        }
        el.value = formatted;
    }
}


// --- NOTIFICATIONS ---
function showNotify(msg, type = 'error') {
    // Try local card notification first, then global
    const box = document.getElementById('auth-notification-card') || document.getElementById('auth-notification');
    if (!box) {
        alert(`${type.toUpperCase()}: ${msg}`);
        return;
    }
    box.style.pointerEvents = 'all';
    box.style.display = 'block'; // Ensure visible
    box.innerHTML = `
        <div class="glass fade-in" style="padding:16px 24px; border:1px solid ${type === 'success' ? '#10b981' : '#ef4444'}; border-radius:12px; background:rgba(0,0,0,0.8); box-shadow:0 10px 30px rgba(0,0,0,0.5); display:flex; align-items:center; gap:16px; margin-bottom: 15px;">
            <i data-lucide="${type === 'success' ? 'check-circle' : 'alert-circle'}" style="color:${type === 'success' ? '#10b981' : '#ef4444'}"></i> 
            <span style="font-weight:700; color:#fff; font-size: 0.9rem;">${msg}</span>
        </div>`;
    if (window.lucide) lucide.createIcons();
    setTimeout(() => {
        box.innerHTML = '';
        if (box.id === 'auth-notification') box.style.pointerEvents = 'none';
    }, 4000);
}

// --- AUTH (OTP ONLY FLOW) ---
let resendInterval;
let otpCooldownSeconds = 0;

function startResendTimer() {
    let timeLeft = 60;
    otpCooldownSeconds = 60;
    const timerSpan = document.getElementById('resend-timer');
    const resendBtn = document.getElementById('btn-resend');
    const timerText = document.getElementById('resend-timer-text');

    if (!timerSpan || !timerText) return;

    clearInterval(resendInterval);
    if (resendBtn) resendBtn.style.display = 'none';
    timerText.textContent = 'Resend available in ';
    timerSpan.style.display = 'inline';
    timerSpan.textContent = timeLeft;

    resendInterval = setInterval(() => {
        timeLeft--;
        otpCooldownSeconds = timeLeft;
        timerSpan.textContent = timeLeft;
        if (timeLeft <= 0) {
            clearInterval(resendInterval);
            otpCooldownSeconds = 0;
            timerSpan.style.display = 'none';
            timerText.textContent = '';
            if (resendBtn) resendBtn.style.display = 'inline';
        }
    }, 1000);
}

async function handleSendOTP() {
    if (otpCooldownSeconds > 0) {
        showNotify(`Please wait ${otpCooldownSeconds} seconds before requesting a new OTP.`, 'error');
        return;
    }
    const val = document.getElementById('auth-phone').value.trim();
    if (val.length !== 10) return showNotify('Please enter exactly 10 digits.');
    const id = `+91${val}`;

    const btn = document.getElementById('btn-send-otp');
    const originalText = btn.innerHTML;

    try {
        btn.disabled = true;
        btn.innerHTML = '<div class="loader-spin" style="width:20px; height:20px;"></div> Sending...';

        const body = { phone: id };
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000); // 20s timeout for Render cold start

        const res = await fetch(`${API_URL}/auth/send-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Server Error');

        showNotify(`OTP sent! For testing, your code is: ${data.otp}`, 'success'); // Simulated for testing
        if (data.otp && window.fillOtpBoxes) fillOtpBoxes('auth-otp', data.otp);

        document.getElementById('otp-section').style.display = 'block';
        // Focus first otp box
        const firstBox = document.querySelector('.otp-boxes[data-target="auth-otp"] .otp-box');
        if (firstBox) firstBox.focus();
        document.getElementById('btn-send-otp').style.display = 'none';
        document.getElementById('btn-verify-otp').style.display = 'block';
        startResendTimer();
    } catch (e) {
        showNotify(e.name === 'AbortError' ? 'Server took too long to respond. Please try again in 30 seconds.' : (e.message === 'Failed to fetch' ? 'Server Connection Failed. Is the backend running?' : e.message));
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

async function handleVerifyOTP() {
    const val = document.getElementById('auth-phone').value.trim();
    if (val.length !== 10) return showNotify('Please enter exactly 10 digits.');
    const id = `+91${val}`;
    const otp = document.getElementById('auth-otp').value.trim();
    if (otp.length !== 6) return showNotify('Enter 6-digit OTP');

    const btn = document.getElementById('btn-verify-otp');
    const originalText = btn.innerHTML;

    try {
        btn.disabled = true;
        btn.innerHTML = '<div class="loader-spin" style="width:20px; height:20px;"></div> Verifying...';

        const body = { phone: id, otp, role: 'garage' };
        const res = await fetch(`${API_URL}/auth/verify-otp`, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(body) 
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        user = data.user;
        localStorage.setItem('redrivo_user', JSON.stringify(user));
        if (data.token) {
            localStorage.setItem('redrivo_token', data.token);
        }
        enterDashboard();
        
        // CRM Onboarding Hook
        if (data.isNewUser) {
            setTimeout(() => {
                showNotify('Welcome to ReDrivo! Please complete your Business Profile & KYC.', 'success');
                switchTab('profile'); // Force them to onboarding
            }, 500);
        }
    } catch (e) { 
        showNotify(e.message); 
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

function handleLogout() { 
    user = null; 
    localStorage.removeItem('redrivo_user');
    localStorage.removeItem('redrivo_token');
    document.getElementById('app-screen').style.display = 'none'; 
    document.getElementById('auth-screen').style.display = 'flex'; 
    initGoogleOneTap();
}

// --- GOOGLE ONE TAP & SIGN-IN ---
async function initGoogleOneTap() {
    if (!window.google || !window.google.accounts || !window.google.accounts.id) {
        setTimeout(initGoogleOneTap, 250);
        return;
    }

    let clientId = window.GOOGLE_CLIENT_ID;
    if (!clientId) {
        try {
            const res = await fetch(`${API_URL}/auth/google-client-id`);
            const data = await res.json();
            clientId = data.clientId;
        } catch (e) {
            console.warn('Failed to fetch Google Client ID from server:', e);
        }
    }

    if (!clientId) {
        console.warn('[Google One Tap] Client ID is not configured.');
        return;
    }

    try {
        google.accounts.id.initialize({
            client_id: clientId,
            callback: handleGoogleCredentialResponse,
            auto_select: false,
            cancel_on_tap_outside: true
        });

        const btnContainer = document.getElementById('g_id_signin_container');
        if (btnContainer) {
            btnContainer.innerHTML = '';
            google.accounts.id.renderButton(btnContainer, {
                theme: 'filled_black',
                size: 'large',
                shape: 'rectangular',
                width: 320,
                text: 'continue_with'
            });
        }

        // Trigger One Tap floating prompt
        google.accounts.id.prompt();
    } catch (err) {
        console.warn('Google One Tap init error:', err);
    }
}

async function handleGoogleCredentialResponse(response) {
    if (!response || !response.credential) {
        showNotify('Google authentication was cancelled.', 'error');
        return;
    }

    try {
        showNotify('Signing in with Google...', 'info');
        const res = await fetch(`${API_URL}/auth/google-signin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken: response.credential, role: 'garage' })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Authentication failed');

        user = data.user;
        localStorage.setItem('redrivo_user', JSON.stringify(user));
        if (data.token) {
            localStorage.setItem('redrivo_token', data.token);
        }
        enterDashboard();

        if (data.isNewUser) {
            setTimeout(() => {
                showNotify('Welcome to ReDrivo! Please complete your Business Profile & KYC.', 'success');
                switchTab('profile');
            }, 500);
        }
    } catch (err) {
        showNotify(err.message, 'error');
    }
}

// --- DASHBOARD ---
function enterDashboard() {
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app-screen').style.display = 'block';
    document.querySelector('.tabs').style.display = 'flex';
    document.getElementById('nav-user-name').textContent = user.name;
    document.getElementById('nav-user-avatar').src = `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name)}&background=facc15&color=000`;
    document.getElementById('nav-user-role').textContent = user.role.toUpperCase();
    
    // Visibility based on role
    const isOwner = user.role === 'garage' || user.role === 'admin';
    const isMechanic = user.role === 'mechanic';
    
    document.querySelectorAll('.t-owner').forEach(el => el.style.display = isOwner ? '' : 'none');
    document.querySelectorAll('.t-mechanic').forEach(el => el.style.display = (isOwner || isMechanic) ? '' : 'none');
    
    // Default tab persistence
    const savedTab = localStorage.getItem('redrivo_active_tab');
    const defaultTab = isMechanic ? 'orders' : 'overview';
    
    if (savedTab) {
        const tabBtn = document.getElementById(`tab-${savedTab}`);
        // Only restore if tab exists and is not hidden by role logic
        if (tabBtn && tabBtn.style.display !== 'none') {
            switchTab(savedTab);
        } else {
            switchTab(defaultTab);
        }
    } else {
        switchTab(defaultTab);
    }
}

function switchTab(name) {
    localStorage.setItem('redrivo_active_tab', name);
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`tab-${name}`).classList.add('active');
    document.getElementById(`panel-${name}`).classList.add('active');
    
    // Sync bottom navigation active states
    document.querySelectorAll('.bottom-nav-item').forEach(b => b.classList.remove('active'));
    const bottomTab = document.getElementById(`bottom-tab-${name}`);
    if (bottomTab) bottomTab.classList.add('active');
    
    if (name === 'overview') renderDashboard();
    if (name === 'orders') loadOrders();
    if (name === 'team') loadWorkers();
    if (name === 'inventory') loadSkus();
    if (name === 'inventory') loadSkus();
    if (name === 'health-check') {
        if (healthCheckEditMode) toggleHealthCheckEdit();
        loadMasterRates(); // Ensures cachedRMap is populated from backend
    }
    if (name === 'profile') {
        if (profileEditMode) toggleProfileEdit();
        else loadProfile();
    }
    if (name === 'kyc') {
        if (kycEditMode) toggleKycEdit();
        else loadKYC();
    }
    if (window.lucide) {
        lucide.createIcons();
    }
}

// --- RATES GRID (FULL CATALOG FROM MASTER DATA) ---
const MASTER_CATALOG = [
    // ===================== CAR =====================
    // --- Car General Servicing ---
    { cat: 'General Servicing', item: 'Basic Service (Oil + Filter)', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'General Servicing', item: 'Standard Service Package', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'General Servicing', item: 'Comprehensive Service Package', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'General Servicing', item: 'Periodic Maintenance Service', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'General Servicing', item: 'Pre-Purchase Inspection', vType: 'Car', canRepair: false, canReplace: false },
    { cat: 'General Servicing', item: 'Post-Accident Inspection', vType: 'Car', canRepair: false, canReplace: false },
    { cat: 'General Servicing', item: 'AC Gas Refill', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'General Servicing', item: 'AC Service (Full)', vType: 'Car', canRepair: true, canReplace: true },
    { cat: 'General Servicing', item: 'Wheel Alignment', vType: 'Car', canRepair: true, canReplace: false },
    { cat: 'General Servicing', item: 'Wheel Balancing (per wheel)', vType: 'Car', canRepair: true, canReplace: false },
    { cat: 'General Servicing', item: 'Tyre Rotation', vType: 'Car', canRepair: true, canReplace: false },
    { cat: 'General Servicing', item: 'Battery Load Test', vType: 'Car', canRepair: false, canReplace: false },
    { cat: 'General Servicing', item: 'Engine Diagnostics (OBD)', vType: 'Car', canRepair: true, canReplace: false },
    { cat: 'General Servicing', item: 'Brake Fluid Flush', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'General Servicing', item: 'Coolant Flush', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'General Servicing', item: 'Fuel Injector Cleaning', vType: 'Car', canRepair: true, canReplace: true },
    { cat: 'General Servicing', item: 'Throttle Body Cleaning', vType: 'Car', canRepair: true, canReplace: false },

    // --- Engine and Fluids ---
    { cat: 'Engine and Fluids', item: 'Engine Oil Level', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Engine and Fluids', item: 'Engine Oil Color', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Engine and Fluids', item: 'Oil Filter', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Engine and Fluids', item: 'Coolant Level', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Engine and Fluids', item: 'Coolant Quality', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Engine and Fluids', item: 'Brake Fluid Level', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Engine and Fluids', item: 'Air Filter', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Engine and Fluids', item: 'Cabin Filter', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Engine and Fluids', item: 'Battery Voltage', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Engine and Fluids', item: 'Battery Terminals', vType: 'Car', canRepair: true, canReplace: false },
    { cat: 'Engine and Fluids', item: 'Drive Belts', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Engine and Fluids', item: 'Radiator Hoses', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Engine and Fluids', item: 'Fuel Lines', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Engine and Fluids', item: 'Spark Plugs', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Engine and Fluids', item: 'Washer Fluid', vType: 'Car', canRepair: false, canReplace: true },

    // --- Safety and Brakes ---
    { cat: 'Safety and Brakes', item: 'Front Brake Pads', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Safety and Brakes', item: 'Rear Brake Pads', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Safety and Brakes', item: 'Brake Discs', vType: 'Car', canRepair: true, canReplace: true },
    { cat: 'Safety and Brakes', item: 'Handbrake', vType: 'Car', canRepair: true, canReplace: false },
    { cat: 'Safety and Brakes', item: 'ABS Light', vType: 'Car', canRepair: true, canReplace: true },
    { cat: 'Safety and Brakes', item: 'Front Tyre Tread', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Safety and Brakes', item: 'Rear Tyre Tread', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Safety and Brakes', item: 'Tyre Sidewall', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Safety and Brakes', item: 'Spare Tyre', vType: 'Car', canRepair: true, canReplace: false },
    { cat: 'Safety and Brakes', item: 'Wheel Alignment', vType: 'Car', canRepair: true, canReplace: false },
    { cat: 'Safety and Brakes', item: 'Wheel Balancing', vType: 'Car', canRepair: true, canReplace: false },
    { cat: 'Safety and Brakes', item: 'Brake Pedal Feel', vType: 'Car', canRepair: true, canReplace: true },
    { cat: 'Safety and Brakes', item: 'Brake Lines', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Safety and Brakes', item: 'Wheel Bearings', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Safety and Brakes', item: 'Lug Nuts', vType: 'Car', canRepair: false, canReplace: true },

    // --- Suspension and Body ---
    { cat: 'Suspension and Body', item: 'Front Strut', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Suspension and Body', item: 'Rear Shockers', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Suspension and Body', item: 'Suspension Bushings', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Suspension and Body', item: 'Lower Arms', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Suspension and Body', item: 'Steering Play', vType: 'Car', canRepair: true, canReplace: true },
    { cat: 'Suspension and Body', item: 'Exhaust System', vType: 'Car', canRepair: true, canReplace: true },
    { cat: 'Suspension and Body', item: 'Chassis Health', vType: 'Car', canRepair: true, canReplace: false },
    { cat: 'Suspension and Body', item: 'Door Hinges', vType: 'Car', canRepair: true, canReplace: false },
    { cat: 'Suspension and Body', item: 'Boot Latch', vType: 'Car', canRepair: true, canReplace: true },
    { cat: 'Suspension and Body', item: 'Fuel Lid', vType: 'Car', canRepair: true, canReplace: true },
    { cat: 'Suspension and Body', item: 'Underbody', vType: 'Car', canRepair: true, canReplace: false },
    { cat: 'Suspension and Body', item: 'Side Mirrors', vType: 'Car', canRepair: true, canReplace: true },
    { cat: 'Suspension and Body', item: 'Windshield', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Suspension and Body', item: 'Wiper Blades', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Suspension and Body', item: 'Paint Condition', vType: 'Car', canRepair: true, canReplace: false },

    // --- Electricals and Interior ---
    { cat: 'Electricals and Interior', item: 'Headlights', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Electricals and Interior', item: 'Indicators', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Electricals and Interior', item: 'Tail Lights', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Electricals and Interior', item: 'Reverse Lights', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Electricals and Interior', item: 'Fog Lights', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Electricals and Interior', item: 'Horn', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Electricals and Interior', item: 'Power Windows', vType: 'Car', canRepair: true, canReplace: true },
    { cat: 'Electricals and Interior', item: 'Central Locking', vType: 'Car', canRepair: true, canReplace: true },
    { cat: 'Electricals and Interior', item: 'Music System', vType: 'Car', canRepair: true, canReplace: true },
    { cat: 'Electricals and Interior', item: 'Instrument Cluster', vType: 'Car', canRepair: true, canReplace: true },
    { cat: 'Electricals and Interior', item: 'Dashboard Condition', vType: 'Car', canRepair: true, canReplace: false },
    { cat: 'Electricals and Interior', item: 'Seat Belts', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Electricals and Interior', item: 'Sunroof Operation', vType: 'Car', canRepair: true, canReplace: true },
    { cat: 'Electricals and Interior', item: 'Interior Lights', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Electricals and Interior', item: '12V Socket/USB', vType: 'Car', canRepair: true, canReplace: true },

    // ===================== BIKE =====================
    // --- Bike General Servicing ---
    { cat: 'General Servicing', item: 'Basic Service (Oil + Filter)', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'General Servicing', item: 'Standard Service Package', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'General Servicing', item: 'Comprehensive Service Package', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'General Servicing', item: 'Pre-Purchase Inspection', vType: 'Bike', canRepair: false, canReplace: false },
    { cat: 'General Servicing', item: 'Engine Diagnostics', vType: 'Bike', canRepair: true, canReplace: false },
    { cat: 'General Servicing', item: 'Wheel Alignment', vType: 'Bike', canRepair: true, canReplace: false },
    { cat: 'General Servicing', item: 'Wheel Balancing (per wheel)', vType: 'Bike', canRepair: true, canReplace: false },
    { cat: 'General Servicing', item: 'Chain Lubrication and Tightening', vType: 'Bike', canRepair: true, canReplace: false },
    { cat: 'General Servicing', item: 'Battery Load Test', vType: 'Bike', canRepair: false, canReplace: false },
    { cat: 'General Servicing', item: 'Carburettor Cleaning', vType: 'Bike', canRepair: true, canReplace: true },
    { cat: 'General Servicing', item: 'Throttle and Cable Adjustment', vType: 'Bike', canRepair: true, canReplace: false },

    // --- Engine and Transmission ---
    { cat: 'Engine and Transmission', item: 'Engine Oil Level', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Engine and Transmission', item: 'Engine Oil Color', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Engine and Transmission', item: 'Clutch Lever Play', vType: 'Bike', canRepair: true, canReplace: false },
    { cat: 'Engine and Transmission', item: 'Clutch Cable', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Engine and Transmission', item: 'Gear Shift', vType: 'Bike', canRepair: true, canReplace: false },
    { cat: 'Engine and Transmission', item: 'Spark Plug', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Engine and Transmission', item: 'Idle Stability', vType: 'Bike', canRepair: true, canReplace: false },
    { cat: 'Engine and Transmission', item: 'Tappet Noise', vType: 'Bike', canRepair: true, canReplace: true },
    { cat: 'Engine and Transmission', item: 'Air Filter', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Engine and Transmission', item: 'Fuel Injector', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Engine and Transmission', item: 'Fuel Filter', vType: 'Bike', canRepair: false, canReplace: true },

    // --- Bike Safety and Brakes ---
    { cat: 'Safety and Brakes', item: 'Front Brake Pad/Shoe', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Safety and Brakes', item: 'Rear Brake Pad/Shoe', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Safety and Brakes', item: 'Brake Fluid Level', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Safety and Brakes', item: 'Brake Cable/Hose', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Safety and Brakes', item: 'Tyre Condition (Front)', vType: 'Bike', canRepair: true, canReplace: true },
    { cat: 'Safety and Brakes', item: 'Tyre Condition (Rear)', vType: 'Bike', canRepair: true, canReplace: true },
    { cat: 'Safety and Brakes', item: 'Wheel Bearings', vType: 'Bike', canRepair: false, canReplace: true },

    // --- Bike Suspension and Chassis ---
    { cat: 'Suspension and Chassis', item: 'Front Fork Oil Leak', vType: 'Bike', canRepair: true, canReplace: true },
    { cat: 'Suspension and Chassis', item: 'Rear Shock Absorber', vType: 'Bike', canRepair: true, canReplace: true },
    { cat: 'Suspension and Chassis', item: 'Chain Tension', vType: 'Bike', canRepair: true, canReplace: false },
    { cat: 'Suspension and Chassis', item: 'Sprocket Condition', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Suspension and Chassis', item: 'Swing Arm Bush', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Suspension and Chassis', item: 'Chassis/Frame Check', vType: 'Bike', canRepair: true, canReplace: false },

    // --- Bike Electricals ---
    { cat: 'Electricals', item: 'Battery Voltage', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Electricals', item: 'Self Start/Kick', vType: 'Bike', canRepair: true, canReplace: true },
    { cat: 'Electricals', item: 'Headlight', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Electricals', item: 'Pass Switch', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Electricals', item: 'Indicators', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Electricals', item: 'Brake Light', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Electricals', item: 'Neutral Light', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Electricals', item: 'Speedometer', vType: 'Bike', canRepair: true, canReplace: true },
    { cat: 'Electricals', item: 'Fuel Gauge', vType: 'Bike', canRepair: true, canReplace: false },
    { cat: 'Electricals', item: 'Horn', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Electricals', item: 'Stand Sensor', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Electricals', item: 'Wiring Harness', vType: 'Bike', canRepair: true, canReplace: false },
    { cat: 'Electricals', item: 'Spark Plug Cap', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Electricals', item: 'Key Lock', vType: 'Bike', canRepair: true, canReplace: false },

    // --- Bike Wash and Detailing ---
    { cat: 'Bike Wash and Detailing', item: 'Bike Foam Wash', vType: 'Bike', canRepair: false, canReplace: false },
    { cat: 'Bike Wash and Detailing', item: 'Chain and Sprocket Wash', vType: 'Bike', canRepair: false, canReplace: false },
    { cat: 'Bike Wash and Detailing', item: 'Full Body Polish', vType: 'Bike', canRepair: false, canReplace: false },
    { cat: 'Bike Wash and Detailing', item: 'Engine Degreasing', vType: 'Bike', canRepair: false, canReplace: false },
    { cat: 'Bike Wash and Detailing', item: 'Ceramic Coating', vType: 'Bike', canRepair: false, canReplace: false },

    // --- Bike Denting and Painting ---
    { cat: 'Bike Denting and Painting', item: 'Tank Denting', vType: 'Bike', canRepair: true, canReplace: false },
    { cat: 'Bike Denting and Painting', item: 'Tank Painting', vType: 'Bike', canRepair: true, canReplace: false },
    { cat: 'Bike Denting and Painting', item: 'Side Panel Painting', vType: 'Bike', canRepair: true, canReplace: false },
    { cat: 'Bike Denting and Painting', item: 'Mudguard Painting', vType: 'Bike', canRepair: true, canReplace: false },
    { cat: 'Bike Denting and Painting', item: 'Full Body Painting', vType: 'Bike', canRepair: true, canReplace: false },
    { cat: 'Bike Denting and Painting', item: 'Sticker and Graphics', vType: 'Bike', canRepair: false, canReplace: true },

    // --- Bike EV Specifics ---
    { cat: 'EV Specifics', item: 'Charging Port', vType: 'Bike', canRepair: true, canReplace: true },
    { cat: 'EV Specifics', item: 'High Voltage Cables', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'EV Specifics', item: 'Battery SOH', vType: 'Bike', canRepair: true, canReplace: false },
    { cat: 'EV Specifics', item: 'Regenerative Braking', vType: 'Bike', canRepair: true, canReplace: false },

    // --- Bike Compliance ---
    { cat: 'Compliance and Legal', item: 'Insurance Policy', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Compliance and Legal', item: 'PUC Certificate', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Compliance and Legal', item: 'Registration Plate', vType: 'Bike', canRepair: false, canReplace: true },
];

let activeVType = 'Car';
let currentSearch = '';
let cachedRMap = {};
const SEGMENTS = ['Hatchback', 'Sedan', 'SUV', 'Luxury'];

// --- 500-Point Health Check Helpers ---
function getAbbr(str) {
    if (!str) return 'XX';
    const clean = str.replace(/[&]/g, '').trim();
    const words = clean.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 1) return words[0].substring(0, 3).toUpperCase();
    return words.map(w => w[0].toUpperCase()).join('').replace(/[^A-Z]/g, '').substring(0, 4);
}

function getPackage(idx) {
    if (idx < 4) return 'Basic';
    if (idx < 12) return 'Standard';
    return 'Premium';
}

// --- 500-Point Health Check ---
const HEALTH_CHECK_POINTS = {
    'Engine System': [
        'Engine oil level', 'Engine oil leakage', 'Oil filter condition', 'Air filter condition', 'Fuel filter clogging', 'Spark plug wear', 'Ignition coil function', 'Timing belt wear', 'Serpentine belt cracks', 'Engine mount vibration', 'Throttle body cleanliness', 'PCV valve blockage', 'MAF sensor condition', 'MAP sensor reading', 'Oxygen sensor health', 'Knock sensor check', 'Camshaft sensor signal', 'Crankshaft sensor signal', 'Valve cover gasket leak', 'Head gasket leak', 'Piston noise', 'Engine idle stability', 'Exhaust smoke color', 'Engine temperature stability', 'Engine vibration level'
    ],
    'Cooling System': [
        'Radiator leakage', 'Radiator fin damage', 'Coolant level', 'Coolant contamination', 'Radiator cap pressure', 'Upper radiator hose cracks', 'Lower radiator hose cracks', 'Heater core blockage', 'Thermostat operation', 'Water pump leakage', 'Cooling fan operation', 'Fan motor noise', 'Fan relay function', 'Temperature sensor reading', 'Coolant pipe corrosion', 'Intercooler blockage', 'Cooling fan shroud condition', 'Coolant reservoir crack', 'Coolant overflow hose', 'Radiator mounting', 'Coolant circulation', 'Fan blade damage', 'Coolant smell', 'Coolant pressure stability', 'Cooling system airlock'
    ],
    'Brake System': [
        'Brake pad thickness', 'Brake disc wear', 'Brake shoe wear', 'Brake drum scoring', 'Brake caliper movement', 'Brake master cylinder leak', 'Brake booster performance', 'Brake fluid level', 'Brake fluid contamination', 'Brake hose cracks', 'ABS sensor signal', 'ABS module error', 'Handbrake cable tension', 'Wheel cylinder leak', 'Brake proportioning valve', 'Parking brake lever travel', 'Brake pedal hardness', 'Brake vibration', 'Brake noise', 'Brake line corrosion', 'Brake response time', 'Brake fluid moisture', 'ABS warning light', 'Emergency brake function', 'Brake disc overheating'
    ],
    'Suspension & Steering': [
        'Shock absorber leakage', 'Strut performance', 'Coil spring damage', 'Control arm bush wear', 'Ball joint play', 'Stabilizer bar condition', 'Stabilizer link noise', 'Suspension bush cracks', 'Steering knuckle wear', 'Wheel hub damage', 'Wheel bearing noise', 'Trailing arm bend', 'Cross member damage', 'Subframe rust', 'Suspension mount looseness', 'Steering rack leak', 'Steering column play', 'Power steering pump noise', 'Power steering fluid level', 'Tie rod inner wear', 'Tie rod outer wear', 'Steering gearbox play', 'Steering coupler wear', 'Steering angle sensor error', 'Steering vibration'
    ],
    'Transmission System': [
        'Clutch plate wear', 'Pressure plate damage', 'Release bearing noise', 'Flywheel scoring', 'Clutch master cylinder leak', 'Clutch slave cylinder leak', 'Gearbox oil level', 'Gearbox mount wear', 'Transmission oil pan leak', 'Transmission filter clog', 'Gear shift lever play', 'Drive shaft vibration', 'CV joint boot crack', 'Differential oil leak', 'Axle shaft bend', 'Gear shifting smoothness', 'Clutch pedal free play', 'Transmission noise', 'Gear slipping', 'Clutch smell', 'Transmission overheating', 'Automatic transmission fluid level', 'Gear linkage wear', 'Transmission seal leak', 'Transmission vibration'
    ],
    'Electrical System': [
        'Battery voltage', 'Battery terminal corrosion', 'Alternator charging output', 'Starter motor noise', 'Ignition switch response', 'Fuse box condition', 'Relay functionality', 'Wiring harness damage', 'ECU error codes', 'BCM communication', 'Headlight brightness', 'Tail light operation', 'Indicator flashing', 'Fog light operation', 'Interior light operation', 'Horn sound level', 'Parking sensor function', 'Reverse camera clarity', 'Speed sensor signal', 'Fuel gauge accuracy', 'Immobilizer function', 'Central locking', 'Power window operation', 'Dashboard warning lights', 'Instrument cluster'
    ],
    'AC & HVAC System': [
        'AC compressor noise', 'AC condenser blockage', 'AC evaporator cooling', 'Cabin air filter clog', 'Blower motor noise', 'AC expansion valve', 'AC dryer condition', 'AC pressure sensor', 'Climate control module', 'AC gas pipe leakage', 'Heater blower function', 'HVAC control panel', 'AC relay function', 'AC fan speed levels', 'Temperature blend door', 'AC cooling efficiency', 'AC smell', 'AC vent airflow', 'AC compressor clutch', 'AC condenser fan', 'Cabin cooling time', 'Rear AC vents', 'Defogger function', 'Heater core heating', 'AC gas pressure'
    ],
    'Exhaust System': [
        'Exhaust manifold crack', 'Catalytic converter blockage', 'Exhaust pipe rust', 'Muffler noise', 'Resonator damage', 'Exhaust hanger rubber', 'Exhaust heat shield looseness', 'Exhaust gasket leak', 'Exhaust clamp rust', 'DPF blockage', 'Exhaust smoke density', 'Exhaust vibration', 'Exhaust smell', 'Tailpipe corrosion', 'Exhaust mount looseness', 'Oxygen sensor exhaust reading', 'Exhaust back pressure', 'Catalytic converter temperature', 'Exhaust pipe dent', 'Exhaust bracket damage', 'Diesel soot buildup', 'Silencer crack', 'Exhaust leak sound', 'Exhaust alignment', 'Emission level'
    ],
    'Wheels & Tyres': [
        'Tyre tread depth', 'Tyre sidewall crack', 'Tyre pressure', 'Wheel alignment', 'Wheel balancing weight', 'Alloy wheel crack', 'Wheel nuts tightness', 'Valve stem leak', 'Wheel bearing noise', 'Tyre uneven wear', 'Spare tyre condition', 'Tyre age', 'Wheel rim bend', 'Wheel vibration', 'Tyre rotation need', 'Tyre puncture repair', 'Wheel hub bolts', 'Tyre pressure sensor', 'Tyre heat marks', 'Tyre shoulder wear', 'Tyre center wear', 'Tyre side bulge', 'Wheel stud damage', 'Tyre valve cap', 'Tyre brand mismatch'
    ],
    'Body & Interior': [
        'Windshield crack', 'Wiper blade wear', 'Side mirror damage', 'Door handle operation', 'Fuel pump noise', 'Fuel tank leak', 'Door lock function', 'Seat belt function', 'Seat rail movement', 'Dashboard cracks', 'Interior trim damage', 'Boot lock operation', 'Bonnet latch', 'Hood struts', 'Paint scratches', 'Rust spots', 'Underbody rust', 'Floor mat condition', 'Carpet moisture', 'Interior odor', 'Sunroof operation', 'Power window motor', 'Central locking actuator', 'Door hinge noise', 'Interior panel fitment'
    ]
};

let healthCheckEditMode = false;

function toggleHealthCheckEdit() {
    healthCheckEditMode = !healthCheckEditMode;
    const editBtn = document.getElementById('btn-h-rate-edit');
    const saveBtn = document.getElementById('btn-h-rate-save');
    
    if (healthCheckEditMode) {
        editBtn.innerHTML = '<i data-lucide="x" style="width:14px; margin-right:6px;"></i> Cancel';
        editBtn.style.color = 'var(--danger)';
        editBtn.style.background = 'rgba(255, 62, 5, 0.1)';
        saveBtn.style.display = 'inline-flex';
    } else {
        editBtn.innerHTML = '<i data-lucide="edit-3" style="width:14px; margin-right:6px;"></i> Edit';
        editBtn.style.color = '#fff';
        editBtn.style.background = 'rgba(255,255,255,0.03)';
        saveBtn.style.display = 'none';
    }
    renderHealthCheckRates();
    if (window.lucide) lucide.createIcons();
}

function renderHealthCheckRates() {
    const tbody = document.getElementById('health-rates-tbody');
    const filterCat = document.getElementById('h-rate-filter-cat')?.value.toLowerCase() || '';
    const filterItem = document.getElementById('h-rate-filter-item')?.value.toLowerCase() || '';
    const filterPkg = document.getElementById('h-rate-filter-pkg')?.value.toLowerCase() || '';
    if (!tbody) return;
    
    let html = '';
    const segments = ['Hatchback', 'Sedan', 'SUV', 'Luxury'];
    const locked = !healthCheckEditMode;
    let catIdx = 1;

    Object.entries(HEALTH_CHECK_POINTS).forEach(([cat, items]) => {
        let itemIdx = 1;
        // Excel-like filter logic: check category then check items
        if (cat.toLowerCase().includes(filterCat)) {
            items.forEach((it, arrayIdx) => {
                const pkg = getPackage(arrayIdx);
                const pkgColor = pkg === 'Basic' ? 'rgba(59, 130, 246, 0.15)' : (pkg === 'Standard' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(250, 204, 21, 0.15)');
                const pkgText = pkg === 'Basic' ? '#60a5fa' : (pkg === 'Standard' ? '#34d399' : '#facc15');
                
                if (it.toLowerCase().includes(filterItem) && (filterPkg === '' || pkg.toLowerCase() === filterPkg)) {
                    const cAb = getAbbr(cat);
                    const iAb = getAbbr(it);
                    const jobId = `${cAb}-${iAb}-${itemIdx.toString().padStart(2, '0')}`;
                    html += `
                        <tr class="h-rate-row" data-item="${it}" data-category="${cat}">
                            <td style="vertical-align: middle; padding:12px 15px; font-family:monospace; font-weight:700; color:var(--text-dim); font-size:0.75rem;">
                                ${jobId}
                            </td>
                            <td style="vertical-align: middle; padding:12px 15px;">
                                <span class="badge badge-secondary" style="font-size:0.6rem; opacity:0.7;">${cat.toUpperCase()}</span>
                            </td>
                            <td style="vertical-align: middle; padding:12px 15px;">
                                <span style="background:${pkgColor}; color:${pkgText}; font-size:0.65rem; font-weight:800; padding:4px 8px; border-radius:6px; border:1px solid ${pkgColor.replace('0.15','0.3')}; text-transform:uppercase;">${pkg}</span>
                            </td>
                            <td style="vertical-align: middle; padding:12px 15px;">
                                <div style="font-weight:600; font-size:0.85rem; color:var(--text-main);">${it}</div>
                            </td>
                            ${segments.map(seg => {
                                const rateKey = `500-Point Health Report|${seg}|Labor|${it}`;
                                const timeKey = `500-Point Health Report|${seg}|Time|${it}`;
                                const rateVal = cachedRMap[rateKey]?.price || '';
                                const timeVal = cachedRMap[timeKey]?.price || '';
                                return `
                                    <td style="vertical-align: middle; padding:8px; text-align: center;">
                                        <div style="display:flex; gap:4px;">
                                            <div style="display:flex; align-items:center; background:rgba(255,255,255,${locked ? '0.01' : '0.04'}); border:1px solid rgba(255,255,255,${locked ? '0.05' : '0.15'}); border-radius:4px; padding:0 4px; flex:1;">
                                                <i data-lucide="clock" style="width:10px; color:var(--text-dim); margin-right:2px;"></i>
                                                <input type="number" class="input h-time-in" data-segment="${seg}" data-item="${it}" value="${timeVal}" 
                                                    ${locked ? 'disabled' : ''}
                                                    min="0"
                                                    onkeypress="return event.charCode >= 48 && event.charCode <= 57"
                                                    oninput="this.value = this.value.replace(/[^0-9]/g, '')"
                                                    style="border:none; background:transparent; text-align: center; padding: 6px 0; height: 32px; font-weight: 600; font-size:0.7rem; width:100%; color:var(--text-dim); cursor:${locked ? 'not-allowed' : 'text'};" 
                                                    placeholder="Min">
                                            </div>
                                            <div style="display:flex; align-items:center; background:rgba(255,255,255,${locked ? '0.01' : '0.04'}); border:1px solid rgba(255,255,255,${locked ? '0.05' : '0.15'}); border-radius:4px; padding:0 4px; flex:1;">
                                                <span style="font-size:0.6rem; color:var(--text-dim);">₹</span>
                                                <input type="number" class="input h-rate-in" data-segment="${seg}" data-item="${it}" value="${rateVal}" 
                                                    ${locked ? 'disabled' : ''}
                                                    min="0"
                                                    onkeypress="return event.charCode >= 48 && event.charCode <= 57"
                                                    oninput="this.value = this.value.replace(/[^0-9]/g, '')"
                                                    style="border:none; background:transparent; text-align: center; padding: 6px 0; height: 32px; font-weight: 700; font-size:0.8rem; width:100%; color:${locked ? 'var(--text-dim)' : 'var(--text-main)'}; cursor:${locked ? 'not-allowed' : 'text'};" 
                                                    placeholder="0">
                                            </div>
                                        </div>
                                    </td>
                                `;
                            }).join('')}
                            <td style="vertical-align: middle; padding:8px; text-align: center;">
                                <div style="display:flex; align-items:center; background:rgba(255,255,255,${locked ? '0.01' : '0.04'}); border:1px solid rgba(255,255,255,${locked ? '0.05' : '0.15'}); border-radius:4px; padding:0 6px;">
                                    <input type="number" class="input h-warranty-days" data-item="${it}" 
                                        value="${cachedRMap[`500-Point Health Report|WarrantyDays|${it}`]?.price || ''}" 
                                        ${locked ? 'disabled' : ''}
                                        min="0"
                                        onkeypress="return event.charCode >= 48 && event.charCode <= 57"
                                        oninput="this.value = this.value.replace(/[^0-9]/g, '')"
                                        style="border:none; background:transparent; text-align: center; padding: 6px 2px; height: 32px; font-weight: 700; font-size:0.75rem; width:100%; color:${locked ? 'var(--text-dim)' : 'var(--accent)'}; cursor:${locked ? 'not-allowed' : 'text'};" 
                                        placeholder="Days">
                                </div>
                            </td>
                            <td style="vertical-align: middle; padding:8px; text-align: center;">
                                <div style="display:flex; align-items:center; background:rgba(255,255,255,${locked ? '0.01' : '0.04'}); border:1px solid rgba(255,255,255,${locked ? '0.05' : '0.15'}); border-radius:4px; padding:0 6px;">
                                    <input type="number" class="input h-warranty-km" data-item="${it}" 
                                        value="${cachedRMap[`500-Point Health Report|WarrantyKM|${it}`]?.price || ''}" 
                                        ${locked ? 'disabled' : ''}
                                        min="0"
                                        onkeypress="return event.charCode >= 48 && event.charCode <= 57"
                                        oninput="this.value = this.value.replace(/[^0-9]/g, '')"
                                        style="border:none; background:transparent; text-align: center; padding: 6px 2px; height: 32px; font-weight: 700; font-size:0.75rem; width:100%; color:${locked ? 'var(--text-dim)' : 'var(--accent)'}; cursor:${locked ? 'not-allowed' : 'text'};" 
                                        placeholder="KM">
                                </div>
                            </td>
                        </tr>
                    `;
                }
                itemIdx++;
            });
        }
        catIdx++;
    });

    if (html === '') {
        html = `<tr><td colspan="10" style="text-align:center; padding:40px; color:var(--text-muted);">No items match your filters</td></tr>`;
    }
    tbody.innerHTML = html;
}

async function saveHealthCheckRates() {
    if (!user || !user.garageId) {
        showNotify('Session Error: Please logout and login again.', 'error');
        return;
    }
    const rates = [];
    const btn = document.getElementById('btn-h-rate-save');
    if (!btn) return;
    const oldText = btn.innerHTML;
    btn.innerHTML = '<div class="loader-spin" style="width:14px; height:14px; margin-right:8px;"></div> Saving...';
    btn.disabled = true;

    // Save Prices
    document.querySelectorAll('.h-rate-in').forEach(inp => {
        const seg = inp.dataset.segment;
        const item = inp.dataset.item;
        const price = parseInt(inp.value, 10) || 0;
        if (price > 0) {
            rates.push({
                vehicleType: 'Car', itemCategory: 'General Servicing',
                item: `500-Point Health Report|${item}`, segment: seg,
                logicType: 'Labor', price: price
            });
        }
    });

    // Save Time
    document.querySelectorAll('.h-time-in').forEach(inp => {
        const seg = inp.dataset.segment;
        const item = inp.dataset.item;
        const timeVal = parseInt(inp.value, 10) || 0;
        if (timeVal > 0) {
            rates.push({
                vehicleType: 'Car', itemCategory: 'General Servicing',
                item: `500-Point Health Report|${item}`, segment: seg,
                logicType: 'Time', price: timeVal
            });
        }
    });

    // Save Warranties (Days)
    document.querySelectorAll('.h-warranty-days').forEach(inp => {
        const item = inp.dataset.item;
        const val = parseInt(inp.value, 10) || 0;
        if (val > 0) {
            rates.push({
                vehicleType: 'Car', itemCategory: 'General Servicing',
                item: `500-Point Health Report|WarrantyDays|${item}`,
                segment: 'All', logicType: 'Labor', price: val
            });
        }
    });

    // Save Warranties (KM)
    document.querySelectorAll('.h-warranty-km').forEach(inp => {
        const item = inp.dataset.item;
        const val = parseInt(inp.value, 10) || 0;
        if (val > 0) {
            rates.push({
                vehicleType: 'Car', itemCategory: 'General Servicing',
                item: `500-Point Health Report|WarrantyKM|${item}`,
                segment: 'All', logicType: 'Labor', price: val
            });
        }
    });

    if (rates.length === 0) {
        showNotify('Please enter at least one rate.');
        btn.innerHTML = oldText;
        btn.disabled = false;
        return;
    }

    try {
        const res = await fetch(`${API_URL}/garages/${user.garageId}/rates`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rates })
        });
        if (res.ok) {
            showNotify('500-Point Health Check rates updated successfully!', 'success');
            await loadMasterRates(); // Refresh local cache correctly
            toggleHealthCheckEdit(); // Return to view mode
        } else {
            throw new Error('Failed to save rates');
        }
    } catch (e) {
        showNotify('Failed to save rates. Please try again.', 'error');
    } finally {
        btn.innerHTML = oldText;
        btn.disabled = false;
    }
}

function filterRates(val) { currentSearch = val; renderCatalogRows(cachedRMap); }
function setVType(type) { 
    activeVType = type; 
    document.querySelectorAll('.v-btn').forEach(b => { b.classList.remove('btn-primary'); b.classList.add('btn-outline'); });
    const btn = document.getElementById(`v-btn-${type.toLowerCase()}`);
    if (btn) { btn.classList.remove('btn-outline'); btn.classList.add('btn-primary'); }
    loadMasterRates(); 
}

function applyColumnFilters() { renderCatalogRows(cachedRMap); }
function applyRatesFilters() { renderCatalogRows(cachedRMap); } // alias used by HTML

function renderCatalogRows(rMap) {
    const tbody = document.getElementById('master-rates-tbody');
    
    // Collect all column filters
    const fCat = (document.getElementById('filter-cat')?.value || '').toLowerCase();
    const fItem = (document.getElementById('filter-item')?.value || '').toLowerCase();
    const fSegment = (document.getElementById('filter-segment')?.value || '').toLowerCase();
    const fRepair = parseFloat(document.getElementById('filter-repair')?.value) || 0;
    const fReplace = parseFloat(document.getElementById('filter-replace')?.value) || 0;
    const fLabor = parseFloat(document.getElementById('filter-labor')?.value) || 0;
    const fWarranty = parseFloat(document.getElementById('filter-warranty')?.value) || 0;
    const globalSearch = currentSearch.toLowerCase();
    
    // Expand catalog by segments for Car
    let displayList = [];
    MASTER_CATALOG.forEach(it => {
        if (it.vType !== activeVType) return;
        if (it.vType === 'Car') {
            SEGMENTS.forEach(seg => {
                displayList.push({ ...it, segment: seg });
            });
        } else {
            displayList.push({ ...it, segment: 'Universal' });
        }
    });

    const filtered = displayList.filter(it => {
        // Global search bar
        if (globalSearch && !it.item.toLowerCase().includes(globalSearch) && !it.cat.toLowerCase().includes(globalSearch)) return false;
        
        // Per-column text filters
        if (fCat && !it.cat.toLowerCase().includes(fCat)) return false;
        if (fItem && !it.item.toLowerCase().includes(fItem)) return false;
        if (fSegment && it.segment.toLowerCase() !== fSegment) return false;
        
        // Per-column numeric filters (check saved rates)
        const key = `${it.item}|${it.segment}`;
        if (fRepair && (parseFloat(rMap[key+'|Repair']?.price) || 0) < fRepair) return false;
        if (fReplace && (parseFloat(rMap[key+'|Replacement']?.price) || 0) < fReplace) return false;
        if (fLabor && (parseFloat(rMap[key+'|Labor']?.price) || 0) < fLabor) return false;
        if (fWarranty && (parseFloat(rMap[key+'|Labor']?.wDays) || 0) < fWarranty) return false;

        return true;
    });
    
    tbody.innerHTML = filtered.map(it => {
        const key = `${it.item}|${it.segment}`;
        const locked = !ratesEditMode;
        // Reduced padding and font-size for compact UI
        const inpStyle = `background:rgba(255,255,255,${locked ? '0.04' : '0.08'}); border:1px solid rgba(255,255,255,${locked ? '0.05' : '0.2'}); color:${locked ? '#aaa' : '#fff'}; cursor:${locked ? 'not-allowed' : 'text'}; height: 32px; width: 70px; text-align: center; font-size: 0.85rem; padding: 4px;`;
        
        return `
            <tr class="catalog-row" data-item="${it.item}" data-cat="${it.cat}" data-segment="${it.segment}">
                <td style="color:var(--primary); font-size:0.65rem; font-weight:700; white-space:nowrap; vertical-align:middle;">${it.cat.toUpperCase()}</td>
                <td style="font-weight:700; font-size:0.9rem; vertical-align:middle;">${it.item}</td>
                <td style="vertical-align:middle;"><span class="badge ${it.segment === 'Universal' ? 'badge-secondary' : 'badge-primary'}" style="font-size:0.7rem;">${it.segment}</span></td>
                <td style="text-align:center;"><input type="number" class="input r-in" data-logic="Repair" value="${rMap[key+'|Repair']?.price || ''}" ${!it.canRepair || locked ? 'disabled placeholder="-"' : ''} style="${inpStyle}"></td>
                <td style="text-align:center;"><input type="number" class="input r-in" data-logic="Replacement" value="${rMap[key+'|Replacement']?.price || ''}" ${!it.canReplace || locked ? 'disabled placeholder="-"' : ''} style="${inpStyle}"></td>
                <td style="text-align:center;"><input type="number" class="input r-in" data-logic="Labor" value="${rMap[key+'|Labor']?.price || ''}" ${locked ? 'disabled' : ''} style="${inpStyle}"></td>
                <td style="text-align:center;">
                    <div style="display:flex; gap:2px; align-items:center; justify-content:center;">
                        <input type="number" class="input w-in-days" value="${rMap[key+'|Labor']?.wDays || ''}" placeholder="D" style="${inpStyle} width:50px;" ${locked ? 'disabled' : ''}>
                        <span style="color:var(--text-muted); font-size:0.7rem;">/</span>
                        <input type="number" class="input w-in-km" value="${rMap[key+'|Labor']?.wKM || ''}" placeholder="K" style="${inpStyle} width:50px;" ${locked ? 'disabled' : ''}>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

let ratesEditMode = false;
function toggleRatesEdit() {
    ratesEditMode = !ratesEditMode;
    const btnEdit = document.getElementById('btn-rates-edit');
    const btnSave = document.getElementById('btn-rates-save');
    if (ratesEditMode) {
        btnEdit.textContent = 'Cancel Editing';
        btnSave.style.display = 'block';
    } else {
        btnEdit.textContent = 'Edit Rates';
        btnSave.style.display = 'none';
    }
    renderCatalogRows(cachedRMap);
}

async function loadMasterRates() {
    const status = document.getElementById('sync-status');
    cachedRMap = {}; 
    if (status) { status.textContent = 'Synchronizing...'; status.style.color = 'var(--primary)'; }
    try {
        const res = await fetch(`${API_URL}/garages/${user.garageId}/rates`);
        const rates = await res.json();
        rates.forEach(r => cachedRMap[`${r.item}|${r.segment}|${r.logicType}`] = { price: r.price, wDays: r.warrantyDays, wKM: r.warrantyKM });
        
        // Update the 500-Point Health Check table instead of the old rates catalog
        renderHealthCheckRates();
        
        if (status) { status.textContent = 'Synced with ReDrivo Cloud'; status.style.color = 'var(--success)'; }
    } catch (e) { 
        if (status) { status.textContent = 'Offline Mode'; status.style.color = 'var(--text-muted)'; } 
        renderHealthCheckRates();
    }
}

async function saveMasterRates() {
    const rates = [];
    document.querySelectorAll('.catalog-row').forEach(row => {
        const item = row.dataset.item;
        const cat = row.dataset.cat;
        const segment = row.dataset.segment;
        const wDays = row.querySelector('.w-in-days').value;
        const wKM = row.querySelector('.w-in-km').value;
        
        row.querySelectorAll('.r-in').forEach(input => {
            if (input.value && !input.disabled) {
                rates.push({ vType: activeVType, cat, item, segment, logic: input.dataset.logic, price: input.value, wDays, wKM });
            }
        });
    });
    const res = await fetch(`${API_URL}/garages/${user.garageId}/rates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rates }) });
    if (res.ok) showNotify('Master Rates Published!', 'success');
}

// --- SKU & INVENTORY MANAGEMENT ---
let MASTER_SKUS = [];
let GARAGE_SKUS = [];
// Staging buffer: skuId -> { myPrice, stock }
let skuDraft = {};

async function loadSkus() {
    const gid = user.garageId;
    if (!gid) return;

    const statusEl = document.getElementById('sync-status-sku');
    statusEl.innerHTML = '<span style="color:var(--accent);">⟳ Syncing with ReDrivo Parts Cloud...</span>';

    try {
        const [masterRes, garageRes] = await Promise.all([
            fetch(`${API_URL}/skus`),
            fetch(`${API_URL}/garages/${gid}/skus`)
        ]);
        MASTER_SKUS = await masterRes.json();
        GARAGE_SKUS = await garageRes.json();
        statusEl.innerHTML = `<span style="color:var(--success);">Fully Synced (${MASTER_SKUS.length} Parts Available)</span>`;
        renderSkus();
    } catch (err) {
        console.error('SKU Load Error:', err);
        statusEl.innerHTML = '<span style="color:var(--danger);">✗ Cloud Unreachable — check server</span>';
    }
}

async function validatePartSerial(input, itemName) {
    const serial = input.value.trim();
    const statusEl = input.nextElementSibling;
    if (!serial) { statusEl.innerHTML = ''; return; }

    // Find SKU ID for this item
    const sku = MASTER_SKUS.find(s => s.itemName === itemName);
    if (!sku) {
        statusEl.innerHTML = '<span style="color:var(--danger);">SKU not found for item</span>';
        return;
    }

    try {
        const res = await fetch(`${API_URL}/validate-part`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ serialNumber: serial, garageId: user.garageId, skuId: sku.id })
        });
        const data = await res.json();
        if (data.valid) {
            statusEl.innerHTML = '<span style="color:var(--success);">✓ Valid ReDrivo Part</span>';
            // Update memory
            const auditItem = currentAuditItems.find(i => i.item === itemName);
            if (auditItem) {
                auditItem.serial = serial;
                auditItem.partId = data.part.id;
            }
        } else {
            statusEl.innerHTML = `<span style="color:var(--danger);">✗ ${data.reason}</span>`;
            input.value = '';
        }
    } catch (e) {
        statusEl.innerHTML = '<span style="color:var(--danger);">Validation Error</span>';
    }
}

let skuEditMode = false;
let kycEditMode = false;

function toggleSkuEdit() {
    skuEditMode = !skuEditMode;
    const btnEdit = document.getElementById('btn-sku-edit');
    const btnSave = document.getElementById('btn-sku-save');

    if (skuEditMode) {
        if (btnEdit) btnEdit.textContent = 'Cancel Editing';
        if (btnSave) btnSave.style.display = 'block';
    } else {
        if (btnEdit) btnEdit.textContent = 'Edit Inventory';
        if (btnSave) btnSave.style.display = 'none';
        skuDraft = {}; 
    }
    renderSkus();
}

async function saveAllSkus() {
    const gid = user.garageId;
    const btn = document.getElementById('btn-sku-save');
    const activeSkus = GARAGE_SKUS; // Only save activated parts

    if (activeSkus.length === 0) {
        showNotify('No activated parts to save. Activate parts first.', 'error');
        return;
    }

    btn.textContent = `Saving 0/${activeSkus.length}...`;
    btn.disabled = true;

    let saved = 0;
    for (const gs of activeSkus) {
        const skuId = gs.id || gs.skuId;
        const priceEl = document.getElementById(`price-${skuId}`);
        const stockEl = document.getElementById(`stock-${skuId}`);
        const myPrice = priceEl ? parseFloat(priceEl.value) || 0 : gs.myPrice;
        const stock   = stockEl ? parseInt(stockEl.value)   || 0 : gs.stock;

        try {
            // Enforce manual increment only: check against current local state
            const currentGs = GARAGE_SKUS.find(g => (g.id || g.skuId) === skuId);
            if (currentGs && stock < currentGs.stock) {
                console.warn(`Stock reduction rejected for ${skuId}. manual reduction not allowed.`);
                // We skip saving this specific stock but save other fields or skip entirely
                // For now, we enforce it by setting it back to current
                await fetch(`${API_URL}/garages/${gid}/skus`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ skuId, myPrice, stock: currentGs.stock, status: 'active' })
                });
            } else {
                await fetch(`${API_URL}/garages/${gid}/skus`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ skuId, myPrice, stock, status: 'active' })
                });
            }
            saved++;
            btn.textContent = `Saving ${saved}/${activeSkus.length}...`;
        } catch (e) {
            console.error('Save failed for', skuId, e);
        }
    }

    btn.textContent = `Saved ${saved} Parts!`;
    btn.style.background = 'var(--accent)';
    btn.style.color = '#000';
    showNotify(`${saved} parts saved successfully!`, 'success');

    // Reset button after 2s
    setTimeout(() => {
        btn.textContent = 'Save All';
        btn.style.background = 'var(--success)';
        btn.style.color = '#fff';
        btn.disabled = false;
    }, 2000);

    // Refresh GARAGE_SKUS silently
    const r = await fetch(`${API_URL}/garages/${gid}/skus`);
    GARAGE_SKUS = await r.json();
    const sActive = document.getElementById('s-active-sku');
    if (sActive) sActive.textContent = GARAGE_SKUS.length;
    const sLow = document.getElementById('s-low-stock');
    if (sLow) sLow.textContent  = GARAGE_SKUS.filter(s => s.stock < 5).length;

    // If edit mode was on, turn it off after save
    if (skuEditMode) toggleSkuEdit();
}

function capMyPrice(skuId, mrp) {
    const el = document.getElementById(`price-${skuId}`);
    if (!el) return;
    const val = parseFloat(el.value) || 0;
    if (val > mrp) {
        el.value = mrp;
        el.style.borderColor = 'var(--danger)';
        setTimeout(() => el.style.borderColor = '', 1200);
    }
}

function renderSkus() {
    const skuContainer = document.getElementById('sku-tbody');

    // Merge master with garage overrides
    const displayData = MASTER_SKUS.map(ms => {
        const ov = GARAGE_SKUS.find(gs => gs.id === ms.id);
        return { ...ms, myPrice: ov ? ov.myPrice : ms.basePrice, stock: ov ? ov.stock : 0, status: ov ? ov.status : 'inactive' };
    });

    const locked = !skuEditMode;

    const fCat  = document.getElementById('f-sku-cat').value.toLowerCase();
    const fName = document.getElementById('f-sku-name').value.toLowerCase();
    const fBrand= document.getElementById('f-sku-brand').value.toLowerCase();
    const fComp = document.getElementById('f-sku-comp').value.toLowerCase();

    const filtered = displayData.filter(d =>
        d.category.toLowerCase().includes(fCat) &&
        (d.itemName || '').toLowerCase().includes(fName) &&
        (d.sparePartBrand || '').toLowerCase().includes(fBrand) &&
        (d.compatibleBrands || '').toLowerCase().includes(fComp)
    );

    const sTotal = document.getElementById('s-total-sku');
    if (sTotal) sTotal.textContent = MASTER_SKUS.length;
    const sActive2 = document.getElementById('s-active-sku');
    if (sActive2) sActive2.textContent = GARAGE_SKUS.length;
    const sLow2 = document.getElementById('s-low-stock');
    if (sLow2) sLow2.textContent = GARAGE_SKUS.filter(s => s.stock < 5).length;

    const stockColor = (n) => n === 0 ? 'var(--danger)' : n < 5 ? '#f59e0b' : 'var(--success)';
    const inp = (locked) => `background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,${locked ? '0.08' : '0.2'}); padding:6px 10px; border-radius:6px; font-size:0.85rem; font-weight:700; width:100%; box-sizing:border-box; opacity:${locked ? '0.45' : '1'}; cursor:${locked ? 'not-allowed' : 'text'};`;
    // Garage portal uses 8 columns: category | name | brand | compatible | MRP | My Price | Stock | Status
    const GRID = '1fr 1.8fr 1fr 1.2fr 0.8fr 1fr 1fr 0.8fr 1.2fr';

    skuContainer.innerHTML = filtered.slice(0, 100).map(d => {
        const isActive = d.status === 'active';
        const mrp = d.basePrice || 0;
        return `
        <div id="sku-row-${d.id}" style="display:grid; grid-template-columns:${GRID}; align-items:center; padding:10px 16px; border-bottom:1px solid rgba(255,255,255,0.04); transition:background 0.15s; gap:8px;"
            onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background='none'">
            <div style="padding:0;">
                <span style="background:rgba(250,180,0,0.12); color:var(--accent); font-size:0.65rem; font-weight:700; padding:3px 8px; border-radius:4px; letter-spacing:0.5px;">${d.category}</span>
            </div>
            <div style="padding:0; font-weight:600; font-size:0.88rem; color:#fff;">${d.itemName}</div>
            <div style="padding:0; color:var(--text-muted); font-size:0.82rem;">${d.sparePartBrand || '—'}</div>
            <div style="padding:0; color:rgba(255,255,255,0.4); font-size:0.75rem;">${d.compatibleBrands || '—'}</div>
            <div style="padding:0; text-align:center; font-size:0.85rem; color:var(--text-muted); font-weight:700;">₹${mrp}</div>
            <div style="padding:0; text-align:center; font-size:0.85rem; color:var(--accent); font-weight:900;">₹${d.vroomerPrice || (mrp * 0.8).toFixed(0)}</div>
            <div style="padding:0; text-align:center;">
                <input id="price-${d.id}" type="number" value="${d.myPrice}" min="0" max="${mrp}"
                    oninput="capMyPrice('${d.id}', ${mrp})"
                    placeholder="Price"
                    ${locked || !isActive ? 'disabled' : ''}
                    style="${inp(locked || !isActive)} color:#fff; text-align:center;"
                    title="Your selling price (max MRP ₹${mrp})">
            </div>
            <div style="padding:0; text-align:center;">
                <input id="stock-${d.id}" type="number" value="${d.stock}" min="${d.stock}"
                    placeholder="Qty"
                    ${locked || !isActive ? 'disabled' : ''}
                    style="${inp(locked || !isActive)} color:${stockColor(d.stock)}; text-align:center;"
                    oninput="if(this.value < ${d.stock}) { this.value = ${d.stock}; showNotify('Manual reduction not allowed. Only Job Cards can reduce stock.', 'warning'); } this.style.color = stockColor(parseInt(this.value)||0)">
            </div>
            <div style="padding:0; text-align:center;">
                ${isActive
                    ? `<span style="background:rgba(16,185,129,0.15); color:var(--success); font-size:0.75rem; font-weight:800; padding:6px 14px; border-radius:8px; letter-spacing:0.5px; border:1px solid rgba(16,185,129,0.2);">ACTIVE</span>`
                    : `<button onclick="activateSku('${d.id}')" class="btn btn-outline"
                           style="padding:4px 10px; font-size:0.7rem; border-color:var(--primary); color:var(--primary); border-radius:6px; cursor:pointer; font-weight:800; transition:transform 0.2s;"
                           onmouseover="this.style.background='var(--primary)'; this.style.color='#000';" onmouseout="this.style.background='transparent'; this.style.color='var(--primary)';">
                           ACTIVATE
                       </button>`
                }
            </div>
        </div>`;
    }).join('');

    if (filtered.length > 100)
        skuContainer.innerHTML += `<div style="text-align:center; color:var(--text-muted); font-size:0.75rem; padding:12px;">Showing 100 of ${filtered.length} results. Use filters to narrow down.</div>`;
}

// Auto-save My Price on blur (no edit mode needed)
async function saveMyPrice(skuId) {
    const gid = user.garageId;
    const master = MASTER_SKUS.find(s => s.id === skuId);
    const myPriceEl = document.getElementById(`price-${skuId}`);
    const stockEl = document.getElementById(`stock-${skuId}`);
    if (!myPriceEl || !master) return;

    const myPrice = parseFloat(myPriceEl.value) || 0;
    const stock = stockEl ? (parseInt(stockEl.value) || 0) : 0;
    const mrp = master.basePrice || 0;
    
    if (myPrice > mrp) { myPriceEl.value = mrp; }

    await fetch(`${API_URL}/garages/${gid}/skus`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skuId, myPrice, stock, status: 'active' })
    });
    // Refresh local
    const r = await fetch(`${API_URL}/garages/${gid}/skus`);
    GARAGE_SKUS = await r.json();
    
    // Update local dashboard stats
    document.getElementById('s-low-stock').textContent = GARAGE_SKUS.filter(s => s.stock < 5).length;
}

async function saveSku(skuId) { await saveMyPrice(skuId); }

async function activateSku(skuId) {
    const master = MASTER_SKUS.find(s => s.id === skuId);
    if (!master) return;
    await fetch(`${API_URL}/garages/${user.garageId}/skus`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skuId, myPrice: master.basePrice, stock: 1, status: 'active' })
    });
    loadSkus();
}

function applySkuFilters() { renderSkus(); }
let kycDocUrls = {};

async function loadKYC() {
    setKycLocked(!kycEditMode);
    const res = await fetch(`${API_URL}/garages/${user.garageId}`);
    if (!res.ok) {
        console.error('Failed to load KYC:', res.status);
        return;
    }
    const g = await res.json();
    
    // Populate Fields (Postgres might return lowercase keys)
    if(document.getElementById('k-bank-name')) document.getElementById('k-bank-name').value = g.bankName || g.bankname || '';
    if(document.getElementById('k-acc-type')) document.getElementById('k-acc-type').value = g.accountType || g.accounttype || 'Savings';
    if(document.getElementById('k-acc')) document.getElementById('k-acc').value = g.bankAccountNumber || g.bankaccountnumber || '';
    if(document.getElementById('k-ifsc')) document.getElementById('k-ifsc').value = g.bankIFSC || g.bankifsc || '';
    if(document.getElementById('k-gst')) document.getElementById('k-gst').value = g.gstNumber || g.gstnumber || '';
    if(document.getElementById('k-pan-number')) document.getElementById('k-pan-number').value = g.panNumber || g.pannumber || '';
    if(document.getElementById('k-id-type')) document.getElementById('k-id-type').value = g.govIdType || g.govidtype || 'Aadhaar Card';
    if(document.getElementById('k-id-number')) {
        const el = document.getElementById('k-id-number');
        el.value = g.govIdNumber || g.govidnumber || '';
        formatID(el); // Re-format on load
    }
    
    updateIdPlaceholder(g.govIdType || g.govidtype || 'Aadhaar Card');
    toggleBizType(g.businessType || g.businesstype || 'Individual');

    const isLockedBySystem = (g.status === 'approved');
    const userLocked = !kycEditMode;
    const isLocked = isLockedBySystem || userLocked;
    
    // Lock Fields
    ['k-bank-name', 'k-acc-type', 'k-acc', 'k-ifsc', 'k-gst', 'k-pan-number', 'k-id-type', 'k-id-number'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.disabled = isLocked;
            el.style.opacity = isLocked ? '0.6' : '1';
            el.style.cursor = isLocked ? 'not-allowed' : 'auto';
        }
    });

    if (isLockedBySystem) {
        const editB = document.getElementById('btn-kyc-edit');
        if(editB) editB.style.display = 'none';
    }

    const docMap = { 
        'shop_act': { status: 'b-lic-status', name: 'b-lic-name' }, 
        'pan':      { status: 'b-pan-status', name: 'b-pan-name' }, 
        'gov_id':   { status: 'b-id-status',  name: 'b-id-name' }, 
        'gst_cert': { status: 'b-gst-cert-status', name: 'b-gst-cert-name' } 
    };
    
    // Reset document UI state
    Object.keys(docMap).forEach(docType => {
        const sEl = document.getElementById(docMap[docType].status);
        const nEl = document.getElementById(docMap[docType].name);
        const card = document.getElementById(`slot-card-${docType}`);
        const attachBar = document.getElementById(`attach-${docType}`);
        const upBtn = document.getElementById(`up-btn-${docType}`);
        
        if(!sEl || !nEl) return;
        
        sEl.textContent = 'Missing';
        sEl.className = 'status-badge-kyc status-kyc-missing';
        nEl.textContent = 'No document';
        
        if(card) card.classList.remove('active');
        if(attachBar) attachBar.style.display = 'none';
        
        if (upBtn) {
            // Upload zones should ONLY be visible in Edit Mode and NOT locked by system
            upBtn.style.display = (!isLockedBySystem && kycEditMode) ? 'flex' : 'none';
        }
    });

    if (g.documents) {
        g.documents.forEach(doc => {
            kycDocUrls[doc.docType] = `${API_URL.replace('/api', '')}/${doc.filePath}`;
            const meta = docMap[doc.docType];
            if (meta) {
                const sEl = document.getElementById(meta.status);
                const nEl = document.getElementById(meta.name);
                const card = document.getElementById(`slot-card-${doc.docType}`);
                const attachBar = document.getElementById(`attach-${doc.docType}`);
                const upBtn = document.getElementById(`up-btn-${doc.docType}`);
                
                if(!sEl || !nEl) return;
                
                sEl.textContent = 'Uploaded';
                sEl.className = 'status-badge-kyc status-kyc-uploaded';
                nEl.textContent = doc.fileName;
                nEl.title = doc.fileName;
                
                if(card) card.classList.add('active');
                if(attachBar) attachBar.style.display = 'flex';
                if(upBtn) upBtn.style.display = 'none';

                // Delete button logic: disappear if approved by CRM, or if not in edit mode
                const rmBtn = attachBar.querySelector('.btn-remove');
                if (rmBtn) {
                    rmBtn.style.display = (isLockedBySystem || !kycEditMode) ? 'none' : 'block';
                }
            }
        });
    }
    syncOwnerCount();
}

function toggleBizType(val) {
    const label = document.getElementById('gst-label');
    const isMandatory = (val === 'Pvt Ltd' || val === 'LLC');
    label.innerHTML = `GST Number ${isMandatory ? '<span style="color:var(--danger)">*</span>' : '(Optional)'}`;
}

function updateGovIdSlot(val) { document.getElementById('g-id-label').textContent = val; }

let activeKYCSlot = null;
function upSlot(slot) { activeKYCSlot = slot; document.getElementById('kyc-input').click(); }

async function handleKYCSelect(input) {
    if (!input.files.length) return;
    const fd = new FormData();
    fd.append('file', input.files[0]);
    fd.append('docType', activeKYCSlot);
    try {
        const res = await fetch(`${API_URL}/garages/${user.garageId}/documents`, { method: 'POST', body: fd });
        if (res.ok) {
            showNotify('Document Uploaded Successfully!', 'success');
            loadKYC(); // Refresh everything neatly
        }
    } catch(e) { showNotify('Upload failed.'); }
}

async function removeKYC(docType) {
    if(!confirm("Are you sure you want to remove this document?")) return;
    try {
        const res = await fetch(`${API_URL}/garages/${user.garageId}/documents/${docType}`, { method: 'DELETE' });
        if (res.ok) {
            showNotify('Document Removed', 'success');
            loadKYC();
        } else {
            showNotify('Failed to remove document', 'error');
        }
    } catch(e) {
        showNotify('Failed to remove document', 'error');
    }
}

function viewKYC(docType) {
    if (kycDocUrls[docType]) window.open(kycDocUrls[docType], '_blank');
}

function updateIdPlaceholder(val) {
    const input = document.getElementById('k-id-number');
    const label = document.getElementById('id-num-label');
    const hint  = document.getElementById('id-num-hint');
    const docLabel = document.getElementById('photo-id-doc-label');
    if (!input || !label || !hint) return;

    if (val === 'Aadhaar Card') {
        label.textContent = 'Aadhaar Number';
        input.placeholder = 'e.g. 0000-0000-0000';
        hint.textContent = 'Format: 12-digit Aadhaar number';
        docLabel.textContent = 'Aadhaar Card Document';
    } else if (val === 'Driving License') {
        label.textContent = 'DL Number';
        input.placeholder = 'e.g. MH12 20110001234';
        hint.textContent = 'Format: Standard RTO DL number';
        docLabel.textContent = 'Driving License Document';
    } else if (val === 'Passport') {
        label.textContent = 'Passport Number';
        input.placeholder = 'e.g. L1234567';
        hint.textContent = 'Format: 1 Letter then 7 Digits';
        docLabel.textContent = 'Passport Document';
    }
}

async function removeKYC(docType) {
    if (!confirm('Are you sure you want to remove this document?')) return;
    try {
        const res = await fetch(`${API_URL}/garages/${user.garageId}/documents/${docType}`, { method: 'DELETE' });
        if (res.ok) {
            showNotify('Document Removed', 'success');
            loadKYC();
        } else {
            showNotify('Failed to remove document', 'error');
        }
    } catch(e) {
        showNotify('Failed to remove document', 'error');
    }
}

async function saveKYC() {
    const type = document.getElementById('k-type').value;
    const gst = document.getElementById('k-gst').value.trim();
    const isMandatory = (type === 'Pvt Ltd' || type === 'LLC');
    if (isMandatory && !gst) return showNotify('GST Number is mandatory for Pvt Ltd/LLC entities.');
    
    const kyc = {
        businessType: type, gstNumber: gst,
        bankName: document.getElementById('k-bank').value,
        bankAccountNumber: document.getElementById('k-acc').value,
        bankIFSC: document.getElementById('k-ifsc').value,
        govIdType: document.getElementById('k-id-type').value
    };
    try {
        const res = await fetch(`${API_URL}/garages/${user.garageId}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(kyc)
        });
        if (res.ok) showNotify('KYC Profile Updated!', 'success');
    } catch(e) { showNotify('Error saving KYC.'); }
}

// --- ACTIVE ORDERS & AUDIT (USP) ---
async function loadOrders() {
    const gid = user.role === 'garage' ? user.garageId : user.id;
    const url = user.role === 'garage' ? `/garages/${user.garageId}/orders` : `/workers/${user.id}/tasks`;
    const res = await fetch(`${API_URL}${url}`);
    const orders = await res.json();
    document.getElementById('orders-tbody').innerHTML = orders.map(o => `
        <tr>
            <td><strong>#${o.id.slice(-6)}</strong></td>
            <td>
                <div>${o.customerName}</div>
                <div style="font-size:0.75rem; color:var(--primary); font-weight:700;">${o.plate} • ${o.makeModel}</div>
                ${o.garageDropoffOtp ? `<div style="font-size:0.72rem; color:#facc15; margin-top:4px; font-weight:600;">Dropoff OTP: <span style="font-family:monospace; font-size:0.8rem; background:rgba(250,204,21,0.1); padding:2px 6px; border-radius:4px;">${o.garageDropoffOtp}</span></div>` : ''}
                ${o.garagePickupOtp ? `<div style="font-size:0.72rem; color:#22c55e; margin-top:4px; font-weight:600;">Pickup OTP: <span style="font-family:monospace; font-size:0.8rem; background:rgba(34,197,94,0.1); padding:2px 6px; border-radius:4px;">${o.garagePickupOtp}</span></div>` : ''}
            </td>
            <td><span class="status-badge" style="background:rgba(255,255,255,0.05); color:var(--text-muted);">${o.status.toUpperCase()}</span></td>
            <td><div style="font-size:0.75rem;">${o.auditStatus === 'submitted' ? 'Audited' : 'Pending'}</div></td>
            <td><button class="btn btn-primary btn-xs" onclick="openAudit('${o.id}')">${o.auditStatus === 'submitted' ? 'Review' : 'Audit'}</button></td>
        </tr>
    `).join('');
}

async function openAudit(id) {
    activeOrder = id;
    currentAuditItems = [];
    const [rateRes, skuRes] = await Promise.all([
        fetch(`${API_URL}/garages/${user.garageId}/rates`),
        loadSkus() // Ensure MASTER_SKUS is populated
    ]);
    const rates = await rateRes.json();
    
    const tbody = document.getElementById('audit-items-tbody');
    tbody.innerHTML = MASTER_CATALOG.slice(0, 15).map(it => {
        const rep = rates.find(r => r.item === it.item && r.logicType === 'Repair')?.price || 0;
        const repl = rates.find(r => r.item === it.item && r.logicType === 'Replacement')?.price || 0;
        const lab = rates.find(r => r.item === it.item && r.logicType === 'Labor')?.price || 0;
        return `
            <tr>
                <td><strong>${it.item}</strong></td>
                <td><select class="input input-xs a-logic" onchange="calcAuditLine(this)" data-item="${it.item}" data-cat="${it.cat}" data-rep="${rep}" data-repl="${repl}" data-lab="${lab}">
                    <option value="">No Service</option><option value="Repair">Repair</option><option value="Replacement">Replace</option></select></td>
                <td><div class="line-rate">₹0</div><div style="font-size:0.6rem; color:var(--text-muted);">+ ₹0 Labor</div></td>
                <td>
                    <input type="text" class="input input-xs a-serial" placeholder="Scan ReDrivo Serial" 
                           style="width:120px; display:none; font-family:monospace;" 
                           onchange="validatePartSerial(this, '${it.item}')">
                    <div class="serial-status" style="font-size:0.6rem; margin-top:2px;"></div>
                </td>
                <td><div id="ev-${it.item.replace(/\s/g,'')}" class="evidence-btn" onclick="triggerEvidence('${it.item.replace(/\s/g,'')}')"><i data-lucide="camera"></i></div></td>
            </tr>
        `;
    }).join('');
    lucide.createIcons();
    document.getElementById('audit-modal').style.display = 'flex';
}

function calcAuditLine(sel) {
    const logic = sel.value;
    const row = sel.closest('tr');
    const rate = logic === 'Repair' ? sel.dataset.rep : (logic === 'Replacement' ? sel.dataset.repl : 0);
    const lab = logic ? sel.dataset.lab : 0;
    row.querySelector('.line-rate').textContent = `₹${rate}`;
    row.querySelector('.line-rate').nextElementSibling.textContent = `+ ₹${lab} Labor`;
    
    // Toggle serial input for Replacements
    const serialInput = row.querySelector('.a-serial');
    if (serialInput) {
        serialInput.style.display = logic === 'Replacement' ? 'block' : 'none';
        if (logic !== 'Replacement') {
            serialInput.value = '';
            row.querySelector('.serial-status').innerHTML = '';
        }
    }
    
    // Update memory
    const existing = currentAuditItems.find(i => i.item === sel.dataset.item);
    if (existing) { 
        existing.logic = logic; 
        existing.rate = parseFloat(rate); 
        existing.labor = parseFloat(lab); 
    } else if (logic) {
        currentAuditItems.push({ item: sel.dataset.item, category: sel.dataset.cat, logic, rate: parseFloat(rate), labor: parseFloat(lab), serial: '' });
    }
    updateAuditTotal();
}

function updateAuditTotal() {
    const total = currentAuditItems.reduce((acc, i) => acc + (i.rate || 0) + (i.labor || 0), 0);
    document.getElementById('audit-total').textContent = `₹${total}`;
}

let activeEvItem = null;
function triggerEvidence(itemId) { activeEvItem = itemId; document.getElementById('evidence-input').click(); }
async function handleEvidenceSelect(input) {
    if (!input.files.length) return;
    const fd = new FormData(); 
    fd.append('file', input.files[0]); 
    fd.append('docType', 'audit_evidence');
    const res = await fetch(`${API_URL}/garages/${user.garageId}/documents`, { method: 'POST', body: fd });
    const data = await res.json();
    const btn = document.getElementById(`ev-${activeEvItem}`);
    btn.classList.add('uploaded'); btn.innerHTML = '<i data-lucide="check"></i>';
    lucide.createIcons();
    // Link media to item in currentAuditItems if needed
}

async function submitAudit() {
    const total = parseFloat(document.getElementById('audit-total').textContent.replace('₹',''));
    if (total === 0) return showNotify('No services selected.');

    // 1. Process Stock Deductions for "Replacement" items
    const replacementItems = currentAuditItems.filter(i => i.logic === 'Replacement');
    for (const item of replacementItems) {
        try {
            // 1a. Deduct Stock
            const deductRes = await fetch(`${API_URL}/garages/${user.garageId}/skus/deduct`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ itemName: item.item, category: item.category })
            });
            const deductData = await deductRes.json();
            
            // 1b. Mark Serial as Used
            if (item.partId) {
                await fetch(`${API_URL}/serialized-parts/${item.partId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'used', orderId: activeOrder })
                });
            }
            
            if (deductData.success) {
                console.log(`Stock auto-deducted for ${item.item}. New stock: ${deductData.newStock}`);
            } else {
                console.warn(`Stock deduction skipped: ${deductData.reason}`);
            }
        } catch (e) { console.error('Processing failed', e); }
    }

    // 2. Submit Audit
    await fetch(`${API_URL}/service-requests/${activeOrder}/audit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: currentAuditItems, total })
    });

    showNotify('Digital Job Card Published & Stock Updated!', 'success');
    closeAudit(); 
    loadOrders();
    loadSkus(); // Refresh stock in inventory tab
}

function closeAudit() { document.getElementById('audit-modal').style.display = 'none'; }

// --- WORKERS & STATS ---
let GARAGE_WORKERS = [];

async function loadWorkers() {
    if (!user || !user.garageId) return console.error('No valid session for loading workers');
    try {
        const res = await fetch(`${API_URL}/garages/${user.garageId}/workers`);
        if (!res.ok) throw new Error('API Error: ' + res.status);
        const wkrs = await res.json();
        GARAGE_WORKERS = wkrs;
        
        const sTeam = document.getElementById('s-team');
        if (sTeam) sTeam.textContent = wkrs.length;
        
        // Update team count badge in the panel
        const badge = document.getElementById('team-count-badge');
        if (badge) badge.textContent = `${wkrs.length} Member${wkrs.length !== 1 ? 's' : ''}`;
        
        // Compute and render mechanic category stats
        const mechanicStats = {};
        let totalMechanics = 0;
        wkrs.forEach(w => {
            if (w.role && w.role.startsWith('mechanic')) {
                totalMechanics++;
                const cat = w.role.includes('|') ? w.role.split('|')[1] : 'All Categories';
                mechanicStats[cat] = (mechanicStats[cat] || 0) + 1;
            }
        });
        
        const statsDiv = document.getElementById('mechanic-category-stats');
        if (statsDiv) {
            if (totalMechanics > 0) {
                statsDiv.style.display = 'flex';
                let html = `<div style="font-size:0.75rem; color:var(--text-muted); font-weight:800; text-transform:uppercase; letter-spacing:0.8px; display:flex; align-items:center; margin-right:10px;">Mechanics by Category:</div>`;
                html += Object.entries(mechanicStats).map(([cat, count]) => {
                    return `<span style="background:rgba(250,204,21,0.1); color:var(--primary); border:1px solid rgba(250,204,21,0.25); padding:4px 10px; border-radius:6px; font-size:0.7rem; font-weight:800; text-transform:uppercase; letter-spacing:0.5px;">${cat}: <strong style="color:#fff;">${count}</strong></span>`;
                }).join('');
                statsDiv.innerHTML = html;
            } else {
                statsDiv.style.display = 'none';
            }
        }

        const tbody = document.getElementById('workers-tbody');
        if (tbody) {
            tbody.innerHTML = wkrs.length === 0
                ? `<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:32px; font-size:0.85rem;">No team members yet. Add your first member →</td></tr>`
                : wkrs.map(w => renderWorkerRow(w)).join('');
        }
    } catch (e) {
        console.error('loadWorkers failed:', e);
    }
}

// -- Worker table rendering with portal access column --
function renderWorkerRow(w) {
    let displayRole = w.role;
    let displayCategory = '';
    
    // Parse custom role syntax if category is attached (e.g. mechanic|Engine System)
    if (w.role && w.role.startsWith('mechanic|')) {
        const parts = w.role.split('|');
        displayRole = parts[0];
        displayCategory = parts[1];
    } else if (w.role === 'mechanic') {
        displayRole = 'mechanic';
        displayCategory = 'All Categories';
    }

    const rolePortalMap = {
        mechanic:   { label: 'Mechanic Portal', color: 'rgba(250,204,21,0.08)', textColor: '#eab308' },
        marshal:    { label: 'Marshal App',      color: 'rgba(139,92,246,0.08)',  textColor: '#a78bfa' },
        supervisor: { label: 'Supervisor View',  color: 'rgba(16,185,129,0.08)', textColor: '#10b981' },
    };
    const portal = rolePortalMap[displayRole] || { label: 'Garage Portal', color: 'rgba(255,255,255,0.04)', textColor: 'var(--text-muted)' };
    return `
        <tr>
            <td><div style="font-weight:700; font-size:0.95rem;">${w.name}</div></td>
            <td style="color:var(--text-muted); font-size:0.85rem; font-family:monospace; letter-spacing:0.5px;">${w.phone}</td>
            <td>
                <span style="font-size:0.7rem; font-weight:800; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.8px;">
                    ${displayRole}
                    ${displayRole === 'mechanic' && displayCategory ? `<br><span style="color:var(--primary); font-size:0.6rem; margin-top:2px; display:inline-block;">${displayCategory}</span>` : ''}
                </span>
            </td>
            <td><span style="background:${portal.color}; color:${portal.textColor}; font-size:0.7rem; font-weight:800; padding:4px 10px; border-radius:6px; text-transform:uppercase; letter-spacing:0.5px;">${portal.label}</span></td>
            <td><span style="color:var(--success); font-size:0.7rem; font-weight:900; letter-spacing:1px; text-transform:uppercase;">Active</span></td>
            <td>
                <div style="display:flex; gap:12px;">
                    <button class="btn" style="background:none; border:none; padding:0; color:var(--primary); font-size:0.8rem; font-weight:700; cursor:pointer; opacity:0.7; transition:opacity 0.2s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'" onclick="editWorker('${w.id}')">Edit</button>
                    <button class="btn" style="background:none; border:none; padding:0; color:var(--danger); font-size:0.8rem; font-weight:700; cursor:pointer; opacity:0.7; transition:opacity 0.2s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'" onclick="deleteWorker('${w.id}')">Remove</button>
                </div>
            </td>
        </tr>`;
}

// --- WORKER OTP FLOW ---
let workerPhoneVerified = false;

function onWorkerPhoneInput() {
    // If user changes the phone after verify, reset verification
    if (workerPhoneVerified) {
        workerPhoneVerified = false;
        document.getElementById('w-phone-verified-badge').style.display = 'none';
        document.getElementById('worker-otp-row').style.display = 'none';
        if (window.clearOtpBoxes) clearOtpBoxes('w-otp'); else document.getElementById('w-otp').value = '';
        lockWorkerInvite();
    }
}

async function sendWorkerOTP() {
    const rawPhone = document.getElementById('w-phone').value.trim();
    if (rawPhone.length !== 10) return showNotify('Enter a valid 10-digit mobile number.');

    // Identify duplicate with mobile number and prevent creation
    const fullPhone = '+91' + rawPhone;
    if (typeof GARAGE_WORKERS !== 'undefined' && GARAGE_WORKERS.some(w => w.phone === fullPhone)) {
        // Allow sending OTP only if we are currently editing this specific worker
        const currentEditId = document.getElementById('w-id').value;
        const matchingWorker = GARAGE_WORKERS.find(w => w.phone === fullPhone);
        if (!currentEditId || matchingWorker.id !== currentEditId) {
            return showNotify('Warning: A team member with this mobile number already exists in your team.', 'error');
        }
    }

    const btn = document.getElementById('btn-send-worker-otp');
    btn.textContent = 'Sending...';
    btn.disabled = true;

    try {
        const res = await fetch(`${API_URL}/auth/send-otp`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: '+91' + rawPhone })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to send OTP');

        document.getElementById('w-otp-phone-hint').textContent = rawPhone;
        document.getElementById('worker-otp-row').style.display = 'block';
        
        // Auto-fill test OTP to prevent user from missing the notification
        if (data.otp) {
            if (window.fillOtpBoxes) fillOtpBoxes('w-otp', data.otp); else document.getElementById('w-otp').value = data.otp;
        }
        
        showNotify(`OTP sent (test: ${data.otp})`, 'success');
    } catch(e) {
        showNotify(e.message);
    } finally {
        btn.textContent = 'Send OTP';
        btn.disabled = false;
    }
}

async function verifyWorkerOTP() {
    const rawPhone = document.getElementById('w-phone').value.trim();
    const otp = document.getElementById('w-otp').value.trim();
    if (otp.length !== 6) return showNotify('Enter the 6-digit OTP.');

    try {
        const res = await fetch(`${API_URL}/auth/verify-otp`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: '+91' + rawPhone, otp })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Invalid OTP');

        workerPhoneVerified = true;
        document.getElementById('worker-otp-row').style.display = 'none';
        document.getElementById('w-phone-verified-badge').style.display = 'inline-block';
        unlockWorkerInvite();
        showNotify('Phone verified! Select a role and invite.', 'success');
    } catch(e) {
        showNotify(e.message);
    }
}

function handleWorkerRoleChange() {
    const role = document.getElementById('w-role').value;
    const catWrapper = document.getElementById('w-category-wrapper');
    const catSelect = document.getElementById('w-category');
    if (role === 'mechanic') {
        catWrapper.style.display = 'block';
    } else {
        catWrapper.style.display = 'none';
        catSelect.value = 'All Categories';
    }
}

function unlockWorkerInvite() {
    const btn = document.getElementById('btn-invite-worker');
    const role = document.getElementById('w-role');
    const cat = document.getElementById('w-category');
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
    role.disabled = false;
    cat.disabled = false;
    handleWorkerRoleChange();
    // Show verified badge, highlight step 3
    const badge = document.getElementById('w-phone-verified-badge');
    if (badge) { badge.style.display = 'flex'; }
    const s3 = document.getElementById('step3-num');
    if (s3) { s3.style.background = 'var(--primary)'; s3.style.color = '#000'; s3.style.border = 'none'; }
    try { lucide.createIcons(); } catch(e) {}
}

function lockWorkerInvite() {
    const btn = document.getElementById('btn-invite-worker');
    const role = document.getElementById('w-role');
    const cat = document.getElementById('w-category');
    btn.disabled = true;
    btn.style.opacity = '0.4';
    btn.style.cursor = 'not-allowed';
    role.disabled = true;
    cat.disabled = true;
    // Hide verified badge, reset step 3
    const badge = document.getElementById('w-phone-verified-badge');
    if (badge) { badge.style.display = 'none'; }
    const s3 = document.getElementById('step3-num');
    if (s3) { s3.style.background = 'rgba(255,255,255,0.06)'; s3.style.color = 'var(--text-muted)'; s3.style.border = '1px solid var(--border)'; }
}

async function addWorker() {
    if (!workerPhoneVerified) return showNotify('Please verify the worker phone number first.');
    if (!user || !user.garageId) return showNotify('Session error. Please logout and login again.');
    
    const rawPhone = document.getElementById('w-phone').value.trim();
    const roleVal = document.getElementById('w-role').value;
    const catVal = document.getElementById('w-category').value;
    const finalRole = roleVal === 'mechanic' && catVal && catVal !== 'All Categories' ? `mechanic|${catVal}` : roleVal;
    
    const body = { 
        name: document.getElementById('w-name').value.trim(), 
        phone: `+91${rawPhone}`, 
        password: '',
        role: finalRole
    };
    if (!body.name) return showNotify('Name is required.');
    
    const wId = document.getElementById('w-id').value;
    
    const btn = document.getElementById('btn-save-worker') || document.querySelector('.modal-invite-worker button.btn-primary');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Saving...';
    }

    try {
        // If editing, delete the old worker first (workaround for lack of PUT endpoint)
        if (wId) {
            try {
                await fetch(`${API_URL}/garages/${user.garageId}/workers/${wId}`, { method: 'DELETE' });
            } catch(e) { console.error('Failed to remove old worker during edit', e); }
        }

        const res = await fetch(`${API_URL}/garages/${user.garageId}/workers`, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(body) 
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Server error');
        
        showNotify(`${body.name} ${wId ? 'updated' : 'added'} successfully.`, 'success');
        loadWorkers();

        // Reset form
        ['w-name', 'w-phone', 'w-otp'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
        workerPhoneVerified = false;
        document.getElementById('w-phone-verified-badge').style.display = 'none';
        document.getElementById('worker-otp-row').style.display = 'none';
        lockWorkerInvite();
        closeWorkerModal();
    } catch(e) {
        showNotify('Failed: ' + e.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Save Member';
        }
    }
}

async function deleteWorker(id) {
    if (!confirm('Remove this team member?')) return;
    await fetch(`${API_URL}/garages/${user.garageId}/workers/${id}`, { method: 'DELETE' });
    showNotify('Member removed.');
    loadWorkers();
}

function openWorkerModal() {
    document.getElementById('w-id').value = '';
    document.getElementById('w-name').value = '';
    document.getElementById('w-phone').value = '';
    document.getElementById('w-phone').disabled = false;
    document.getElementById('btn-send-worker-otp').style.display = 'block';
    
    const title = document.getElementById('w-modal-title');
    if (title) title.innerHTML = '<i data-lucide="user-plus"></i> Add Team Member';
    
    document.getElementById('btn-invite-worker').innerHTML = '<i data-lucide="user-check"></i> Add to Team';
    workerPhoneVerified = false;
    document.getElementById('w-phone-verified-badge').style.display = 'none';
    document.getElementById('worker-otp-row').style.display = 'none';
    
    lockWorkerInvite();
    document.getElementById('worker-modal').style.display = 'flex';
    try { lucide.createIcons(); } catch(e) {}
}

function editWorker(id) {
    const w = GARAGE_WORKERS.find(x => x.id === id);
    if (!w) return;
    
    document.getElementById('w-id').value = w.id;
    document.getElementById('w-name').value = w.name;
    document.getElementById('w-phone').value = (w.phone || '').replace('+91', '');
    document.getElementById('w-phone').disabled = true; // Prevent changing verified phone
    
    const roleVal = w.role.includes('|') ? w.role.split('|')[0] : w.role;
    const catVal = w.role.includes('|') ? w.role.split('|')[1] : 'All Categories';
    
    document.getElementById('w-role').value = roleVal;
    if (roleVal === 'mechanic') {
        document.getElementById('w-category-wrapper').style.display = 'block';
        document.getElementById('w-category').value = catVal;
    } else {
        document.getElementById('w-category-wrapper').style.display = 'none';
    }
    
    document.getElementById('btn-send-worker-otp').style.display = 'none';
    document.getElementById('worker-otp-row').style.display = 'none';
    
    const title = document.getElementById('w-modal-title');
    if (title) title.innerHTML = '<i data-lucide="edit"></i> Edit Team Member';
    
    document.getElementById('btn-invite-worker').innerHTML = '<i data-lucide="save"></i> Save Changes';
    
    // Bypass OTP lock since they are already verified
    workerPhoneVerified = true; 
    unlockWorkerInvite(); 
    
    document.getElementById('worker-modal').style.display = 'flex';
    try { lucide.createIcons(); } catch(e) {}
}

function closeWorkerModal() {
    document.getElementById('worker-modal').style.display = 'none';
}


// Global chart instances
let chartRevenue = null;
let chartMechanics = null;
let chartInventory = null;

async function renderDashboard() {
    const filter = document.getElementById('dashboard-filter').value;
    
    // Fetch live data where possible
    const [statsRes, workersRes, skusRes] = await Promise.all([
        fetch(`${API_URL}/garages/${user.garageId}/stats`).catch(() => ({ json: () => ({}) })),
        fetch(`${API_URL}/garages/${user.garageId}/workers`).catch(() => ({ json: () => [] })),
        fetch(`${API_URL}/garages/${user.garageId}/skus`).catch(() => ({ json: () => [] }))
    ]);
    
    const s = await statsRes.json();
    const wkrs = await workersRes.json();
    const skus = await skusRes.json();
    
    // KPI Data
    let baseRevenue = s.revenue || 0;
    let baseOrders = s.totalOrders || 0;
    let criticalStockCount = skus.filter(s => s.quantity <= (s.threshold || 5)).length;
    
    // Mechanics Data
    let mechanicsTotal = 0;
    let mechanicsEngaged = 0;
    wkrs.forEach(w => {
        if (w.role && w.role.startsWith('mechanic')) {
            mechanicsTotal++;
            // Assuming status 'available' vs 'engaged/busy'
            if (w.status !== 'available') mechanicsEngaged++; 
        }
    });

    // Mock trend multipliers based on filter
    const multipliers = {
        daily: { m: 1, label: 'Today', days: 1 },
        weekly: { m: 5.5, label: 'This Week', days: 7 },
        monthly: { m: 22, label: 'This Month', days: 30 },
        quarterly: { m: 65, label: 'This Quarter', days: 90 },
        annually: { m: 250, label: 'This Year', days: 365 }
    };
    
    const mult = multipliers[filter] || multipliers.daily;
    const mockRevenue = Math.round(baseRevenue * mult.m);
    const mockOrders = Math.round(baseOrders * mult.m);
    
    // Update KPI UI
    document.getElementById('s-orders').textContent = mockOrders;
    document.getElementById('s-orders-trend').textContent = `+${Math.floor(Math.random() * 15) + 2}% vs last period`;
    document.getElementById('s-rev').textContent = `₹${mockRevenue.toLocaleString()}`;
    document.getElementById('s-rev-trend').textContent = `+${Math.floor(Math.random() * 20) + 5}% vs last period`;
    document.getElementById('s-mechanics-total').textContent = mechanicsTotal;
    document.getElementById('s-mechanics-engaged').textContent = mechanicsEngaged;
    document.getElementById('s-low-stock').textContent = criticalStockCount;

    // --- REVENUE & ORDERS TREND CHART (Area) ---
    const trendDates = [];
    const trendRev = [];
    const trendOrd = [];
    
    // Generate realistic mock curve
    let currentRev = (mockRevenue / mult.days) || 5000; // fallback if 0
    let currentOrd = (mockOrders / mult.days) || 5;     // fallback if 0
    
    // Build from past to today
    for (let i = mult.days - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        trendDates.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
        
        // Random fluctuation to make chart look alive
        let variance = 0.7 + (Math.random() * 0.6); 
        trendRev.push(Math.round(currentRev * variance));
        trendOrd.push(Math.round(currentOrd * variance));
    }

    const revChartOptions = {
        series: [{ name: 'Revenue (₹)', data: trendRev }, { name: 'Orders', data: trendOrd }],
        chart: { type: 'area', height: 300, background: 'transparent', toolbar: { show: false }, fontFamily: 'Outfit, sans-serif' },
        colors: ['#facc15', '#10b981'],
        fill: { type: 'gradient', gradient: { shadeIntensity: 1, opacityFrom: 0.4, opacityTo: 0.05, stops: [0, 90, 100] } },
        dataLabels: { enabled: false },
        stroke: { curve: 'smooth', width: 2 },
        xaxis: { categories: trendDates, labels: { style: { colors: '#71717a' } }, axisBorder: { show: false }, axisTicks: { show: false }, tickAmount: Math.min(mult.days, 10) },
        yaxis: [{ labels: { style: { colors: '#71717a' }, formatter: (v) => '₹'+v.toLocaleString() } }, { opposite: true, labels: { style: { colors: '#71717a' }, formatter: (v) => Math.round(v) } }],
        grid: { borderColor: 'rgba(255,255,255,0.05)', strokeDashArray: 4 },
        theme: { mode: 'dark' },
        legend: { position: 'top', horizontalAlign: 'right' }
    };

    if (chartRevenue) chartRevenue.destroy();
    chartRevenue = new ApexCharts(document.querySelector("#chart-revenue"), revChartOptions);
    chartRevenue.render();

    // --- MECHANICS CHART (Donut) ---
    const mechChartOptions = {
        series: [mechanicsEngaged, mechanicsTotal - mechanicsEngaged],
        labels: ['Engaged', 'Available'],
        chart: { type: 'donut', height: 300, background: 'transparent', fontFamily: 'Outfit, sans-serif' },
        colors: ['#ef4444', '#10b981'],
        stroke: { show: true, colors: ['#161618'], width: 2 },
        dataLabels: { enabled: false },
        plotOptions: { pie: { donut: { size: '75%', labels: { show: true, name: { color: '#71717a' }, value: { color: '#fff', fontSize: '2rem', fontWeight: 800 } } } } },
        theme: { mode: 'dark' },
        legend: { position: 'bottom' }
    };

    if (chartMechanics) chartMechanics.destroy();
    // Prevent rendering empty donut if no mechanics exist
    if (mechanicsTotal > 0) {
        chartMechanics = new ApexCharts(document.querySelector("#chart-mechanics"), mechChartOptions);
        chartMechanics.render();
    } else {
        document.querySelector("#chart-mechanics").innerHTML = '<div style="height:100%; display:flex; align-items:center; justify-content:center; color:var(--text-muted); font-size:0.85rem;">No mechanics found in your team.</div>';
    }

    // --- INVENTORY CHART (Bar) ---
    const invCategories = {};
    skus.forEach(sku => {
        const cat = sku.category || 'Uncategorized';
        invCategories[cat] = (invCategories[cat] || 0) + (sku.quantity || 0);
    });
    
    const catLabels = Object.keys(invCategories).length > 0 ? Object.keys(invCategories) : ['Oil', 'Brakes', 'Filters', 'Tyres', 'Electrical'];
    const catData = Object.keys(invCategories).length > 0 ? Object.values(invCategories) : [0, 0, 0, 0, 0];

    const invChartOptions = {
        series: [{ name: 'Available Parts', data: catData }],
        chart: { type: 'bar', height: 350, background: 'transparent', toolbar: { show: false }, fontFamily: 'Outfit, sans-serif' },
        colors: ['#facc15'],
        plotOptions: { bar: { borderRadius: 4, horizontal: false, columnWidth: '40%' } },
        dataLabels: { enabled: false },
        xaxis: { categories: catLabels, labels: { style: { colors: '#71717a', fontSize: '0.75rem' } }, axisBorder: { show: false }, axisTicks: { show: false } },
        yaxis: { labels: { style: { colors: '#71717a' } } },
        grid: { borderColor: 'rgba(255,255,255,0.05)', strokeDashArray: 4 },
        theme: { mode: 'dark' },
        tooltip: { theme: 'dark' }
    };

    if (chartInventory) chartInventory.destroy();
    if (Object.keys(invCategories).length > 0) {
        chartInventory = new ApexCharts(document.querySelector("#chart-inventory"), invChartOptions);
        chartInventory.render();
    } else {
        document.querySelector("#chart-inventory").innerHTML = '<div style="height:100%; display:flex; align-items:center; justify-content:center; color:var(--text-muted); font-size:0.85rem;">No inventory data available.</div>';
    }
}

// ============================================================
// PROFILE MANAGEMENT
// ============================================================
let profileEditMode = false;

/**
 * Brand Logo Assets & Attribution:
 * - Simple Icons (https://simpleicons.org/): Licensed under CC0 1.0 Universal (Public Domain).
 * - OEM Corporate Marks: Displayed strictly under nominative fair use for B2B workshop
 *   capability & authorized service center identification.
 */
const CAR_OEM_BRANDS = [
    { id: 'maruti_suzuki', name: 'Maruti Suzuki', logo: 'assets/brands/cars/maruti_suzuki.svg' },
    { id: 'tata_motors',   name: 'Tata Motors',   logo: 'assets/brands/cars/tata_motors.svg' },
    { id: 'mahindra',      name: 'Mahindra',      logo: 'assets/brands/cars/mahindra.svg' },
    { id: 'hyundai',       name: 'Hyundai',       logo: 'assets/brands/cars/hyundai.svg' },
    { id: 'kia',           name: 'Kia',           logo: 'assets/brands/cars/kia.svg' },
    { id: 'toyota',        name: 'Toyota',        logo: 'assets/brands/cars/toyota.svg' },
    { id: 'honda',         name: 'Honda',         logo: 'assets/brands/cars/honda.svg' },
    { id: 'volkswagen',    name: 'Volkswagen',    logo: 'assets/brands/cars/volkswagen.svg' },
    { id: 'skoda',         name: 'Skoda',         logo: 'assets/brands/cars/skoda.svg' },
    { id: 'renault',       name: 'Renault',       logo: 'assets/brands/cars/renault.svg' },
    { id: 'nissan',        name: 'Nissan',        logo: 'assets/brands/cars/nissan.svg' },
    { id: 'mg_motor',      name: 'MG Motor',      logo: 'assets/brands/cars/mg_motor.svg' },
    { id: 'force_motors',  name: 'Force Motors',  logo: 'assets/brands/cars/force_motors.svg' },
    { id: 'citroen',       name: 'Citroen',       logo: 'assets/brands/cars/citroen.svg' },
    { id: 'jeep',          name: 'Jeep',          logo: 'assets/brands/cars/jeep.svg' },
    { id: 'byd',           name: 'BYD',           logo: 'assets/brands/cars/byd.svg' },
    { id: 'bmw',           name: 'BMW',           logo: 'assets/brands/cars/bmw.svg' },
    { id: 'mercedes_benz', name: 'Mercedes-Benz', logo: 'assets/brands/cars/mercedes_benz.svg' },
    { id: 'audi',          name: 'Audi',          logo: 'assets/brands/cars/audi.svg' },
    { id: 'volvo',         name: 'Volvo',         logo: 'assets/brands/cars/volvo.svg' },
    { id: 'land_rover',    name: 'Land Rover',    logo: 'assets/brands/cars/land_rover.svg' },
    { id: 'jaguar',        name: 'Jaguar',        logo: 'assets/brands/cars/jaguar.svg' },
    { id: 'lexus',         name: 'Lexus',         logo: 'assets/brands/cars/lexus.svg' },
    { id: 'porsche',       name: 'Porsche',       logo: 'assets/brands/cars/porsche.svg' },
    { id: 'isuzu',         name: 'Isuzu',         logo: 'assets/brands/cars/isuzu.svg' }
];

const BIKE_OEM_BRANDS = [
    { id: 'hero_motocorp',  name: 'Hero MotoCorp',            logo: 'assets/brands/bikes/hero_motocorp.svg' },
    { id: 'honda',          name: 'Honda',                    logo: 'assets/brands/bikes/honda.svg' },
    { id: 'tvs_motor',      name: 'TVS Motor',                logo: 'assets/brands/bikes/tvs_motor.svg' },
    { id: 'bajaj_auto',     name: 'Bajaj Auto',               logo: 'assets/brands/bikes/bajaj_auto.svg' },
    { id: 'royal_enfield',  name: 'Royal Enfield',            logo: 'assets/brands/bikes/royal_enfield.svg' },
    { id: 'yamaha',         name: 'Yamaha',                   logo: 'assets/brands/bikes/yamaha.svg' },
    { id: 'suzuki',         name: 'Suzuki',                   logo: 'assets/brands/bikes/suzuki.svg' },
    { id: 'ktm',            name: 'KTM',                      logo: 'assets/brands/bikes/ktm.svg' },
    { id: 'jawa_yezdi',     name: 'Jawa/Yezdi',               logo: 'assets/brands/bikes/jawa_yezdi.svg' },
    { id: 'triumph',        name: 'Triumph',                  logo: 'assets/brands/bikes/triumph.svg' },
    { id: 'kawasaki',       name: 'Kawasaki',                 logo: 'assets/brands/bikes/kawasaki.svg' },
    { id: 'harley_davidson',name: 'Harley-Davidson',          logo: 'assets/brands/bikes/harley_davidson.svg' },
    { id: 'bmw_motorrad',   name: 'BMW Motorrad',             logo: 'assets/brands/bikes/bmw_motorrad.svg' },
    { id: 'aprilia',        name: 'Aprilia',                  logo: 'assets/brands/bikes/aprilia.svg' },
    { id: 'ducati',         name: 'Ducati',                   logo: 'assets/brands/bikes/ducati.svg' },
    { id: 'vespa_piaggio',  name: 'Vespa (Piaggio)',          logo: 'assets/brands/bikes/vespa_piaggio.svg' },
    { id: 'benelli',        name: 'Benelli',                  logo: 'assets/brands/bikes/benelli.svg' },
    { id: 'husqvarna',      name: 'Husqvarna',                logo: 'assets/brands/bikes/husqvarna.svg' },
    { id: 'indian_moto',    name: 'Indian Motorcycle',        logo: 'assets/brands/bikes/indian_moto.svg' },
    { id: 'ultraviolette',  name: 'Ultraviolette Automotive', logo: 'assets/brands/bikes/ultraviolette.svg' },
    { id: 'revolt_motors',  name: 'Revolt Motors',            logo: 'assets/brands/bikes/revolt_motors.svg' },
    { id: 'ather_energy',   name: 'Ather Energy',             logo: 'assets/brands/bikes/ather_energy.svg' },
    { id: 'ola_electric',   name: 'Ola Electric',             logo: 'assets/brands/bikes/ola_electric.svg' },
    { id: 'hero_vida',      name: 'Hero Vida',                logo: 'assets/brands/bikes/hero_vida.svg' },
    { id: 'ampere',         name: 'Ampere',                   logo: 'assets/brands/bikes/ampere.svg' },
    { id: 'okinawa',        name: 'Okinawa',                  logo: 'assets/brands/bikes/okinawa.svg' },
    { id: 'bgauss',         name: 'BGauss',                   logo: 'assets/brands/bikes/bgauss.svg' },
    { id: 'simple_energy',  name: 'Simple Energy',            logo: 'assets/brands/bikes/simple_energy.svg' },
    { id: 'river_mobility', name: 'River Mobility',           logo: 'assets/brands/bikes/river_mobility.svg' },
    { id: 'bounce_infinity',name: 'Bounce Infinity',          logo: 'assets/brands/bikes/bounce_infinity.svg' },
    { id: 'kinetic_green',  name: 'Kinetic Green',            logo: 'assets/brands/bikes/kinetic_green.svg' }
];

let selectedCarBrands = new Set();
let selectedBikeBrands = new Set();
let carSearchQuery = '';
let bikeSearchQuery = '';

function renderBrandCheckboxes(type) {
    const list = type === 'car' ? CAR_OEM_BRANDS : BIKE_OEM_BRANDS;
    const selected = type === 'car' ? selectedCarBrands : selectedBikeBrands;
    const query = ((type === 'car' ? carSearchQuery : bikeSearchQuery) || '').toLowerCase().trim();
    const container = document.getElementById(type === 'car' ? 'auth-car-brands-grid' : 'auth-bike-brands-grid');
    const countBadge = document.getElementById(type === 'car' ? 'car-brands-count' : 'bike-brands-count');
    if (!container) return;

    if (countBadge) countBadge.textContent = `${selected.size} selected`;

    const filtered = list.filter(b => b.name.toLowerCase().includes(query));
    if (filtered.length === 0) {
        container.innerHTML = `<div style="grid-column:1/-1; color:var(--text-muted); font-size:0.8rem; padding:12px 0;">No matching brands found.</div>`;
        return;
    }

    container.innerHTML = filtered.map(b => {
        const isChecked = selected.has(b.name);
        const initials = b.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
        return `
            <div class="brand-checkbox-card ${isChecked ? 'checked' : ''} ${!profileEditMode ? 'disabled' : ''}" 
                 onclick="toggleBrandCheckbox('${type}', '${b.name.replace(/'/g, "\\'")}')">
                <span class="custom-checkbox">
                    <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
                </span>
                <div class="brand-logo-frame">
                    <img src="${b.logo}" alt="${b.name}" class="brand-logo-img" 
                         onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                    <div class="brand-logo-fallback" style="display:none;">${initials}</div>
                </div>
                <span class="brand-name-text" title="${b.name}">${b.name}</span>
            </div>
        `;
    }).join('');
}

function filterBrandList(type, query) {
    if (type === 'car') carSearchQuery = query;
    else bikeSearchQuery = query;
    renderBrandCheckboxes(type);
}

function toggleBrandCheckbox(type, brandName) {
    if (!profileEditMode) return;
    const selected = type === 'car' ? selectedCarBrands : selectedBikeBrands;
    if (selected.has(brandName)) selected.delete(brandName);
    else selected.add(brandName);
    renderBrandCheckboxes(type);
}

function selectAllBrands(type) {
    if (!profileEditMode) return;
    const list = type === 'car' ? CAR_OEM_BRANDS : BIKE_OEM_BRANDS;
    const selected = type === 'car' ? selectedCarBrands : selectedBikeBrands;
    list.forEach(b => selected.add(b.name));
    renderBrandCheckboxes(type);
}

function clearAllBrands(type) {
    if (!profileEditMode) return;
    const selected = type === 'car' ? selectedCarBrands : selectedBikeBrands;
    selected.clear();
    renderBrandCheckboxes(type);
}

function toggleCenterType(type) {
    updateAuthorizedBrandsVisibility();
}

function updateAuthorizedBrandsVisibility() {
    const centerTypeEl = document.getElementById('p-center-type');
    const svctypeEl = document.getElementById('p-svctype');
    const wrapper = document.getElementById('authorized-brands-wrapper');
    const carGroup = document.getElementById('auth-car-brands-group');
    const bikeGroup = document.getElementById('auth-bike-brands-group');
    if (!centerTypeEl || !wrapper) return;

    const centerType = centerTypeEl.value;
    const svcType = svctypeEl ? svctypeEl.value : 'Both';

    if (centerType === 'authorized') {
        wrapper.style.display = 'block';
        if (carGroup) carGroup.style.display = (svcType === 'Car' || svcType === 'Both') ? 'block' : 'none';
        if (bikeGroup) bikeGroup.style.display = (svcType === 'Bike' || svcType === 'Both') ? 'block' : 'none';
    } else {
        wrapper.style.display = 'none';
    }
    renderBrandCheckboxes('car');
    renderBrandCheckboxes('bike');
}

// All profile field IDs for lock/unlock. Notice p-phone is explicitly excluded because it requires OTP to unlock.
const PROFILE_FIELDS = ['p-name', 'p-owner', 'p-owner-count', 'p-biztype', 'p-svctype', 'p-center-type',
    'p-altphone', 'p-email',
    'p-address', 'p-pincode', 'p-city', 'p-state', 'p-country'];

function setProfileLocked(locked) {
    PROFILE_FIELDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.disabled = locked;
        el.style.opacity = locked ? '0.55' : '1';
        el.style.cursor  = locked ? 'not-allowed' : '';
        el.style.border  = locked ? '1px solid rgba(255,255,255,0.06)' : '1px solid rgba(255,255,255,0.18)';
    });
    
    // Toggle brand action buttons and search inputs
    const carSearch = document.getElementById('search-car-brands');
    const bikeSearch = document.getElementById('search-bike-brands');
    if (carSearch) carSearch.disabled = locked;
    if (bikeSearch) bikeSearch.disabled = locked;
    document.querySelectorAll('.btn-brand-action').forEach(btn => {
        btn.disabled = locked;
    });

    renderBrandCheckboxes('car');
    renderBrandCheckboxes('bike');
    // Ensure primary phone is ALWAYS locked unless explicitly requested
    document.getElementById('p-phone').disabled = true;
    document.getElementById('p-phone').style.opacity = '0.55';
    document.getElementById('p-phone').style.cursor = 'not-allowed';
    
    const changeBtn = document.getElementById('btn-change-primary-phone');
    if(changeBtn) {
        changeBtn.style.display = locked ? 'none' : 'inline-block';
        if(locked) {
            changeBtn.textContent = 'Request Change';
            changeBtn.onclick = requestPhoneChange;
            const otpRow = document.getElementById('p-phone-otp-row');
            if(otpRow) otpRow.style.display = 'none';
        }
    }
    
    // Also lock/unlock Verify OTP buttons
    document.querySelectorAll('[onclick^="sendContactOtp"]').forEach(btn => {
        btn.disabled = locked;
        btn.style.opacity = locked ? '0.4' : '1';
        btn.style.cursor  = locked ? 'not-allowed' : 'pointer';
    });
    document.getElementById('btn-detect-loc').disabled = locked;
    document.getElementById('btn-detect-loc').style.opacity = locked ? '0.4' : '1';

    // Garage Photos Interactivity
    document.querySelectorAll('.upload-area').forEach(el => {
        el.style.opacity = locked ? '0.4' : '1';
        el.style.cursor = locked ? 'not-allowed' : 'pointer';
        el.style.pointerEvents = locked ? 'none' : 'auto';
    });
    document.querySelectorAll('.btn-remove').forEach(el => {
        el.style.display = locked ? 'none' : 'flex';
    });
}

function toggleProfileEdit() {
    profileEditMode = !profileEditMode;
    const editBtn = document.getElementById('btn-profile-edit');
    const saveBtn = document.getElementById('btn-save-profile');
    const badge   = document.getElementById('profile-mode-badge');

    setProfileLocked(!profileEditMode);

    if (profileEditMode) {
        editBtn.style.display = 'none';
        editBtn.style.color = '#ef4444';
        editBtn.style.borderColor = 'rgba(239,68,68,0.3)';
        saveBtn.style.display = 'flex';
        saveBtn.textContent = 'Save';
        saveBtn.disabled = false;
        saveBtn.style.background = 'var(--primary)';
        saveBtn.style.color = '#000';
        saveBtn.style.borderColor = 'transparent';
        badge.textContent = 'Edit Mode';
        badge.style.background = 'rgba(250,180,0,0.12)';
        badge.style.color = 'var(--accent)';
    } else {
        editBtn.style.display = 'flex';
        editBtn.textContent = 'Edit';
        editBtn.style.background = 'rgba(255,255,255,0.07)';
        editBtn.style.color = '#ddd';
        editBtn.style.borderColor = 'rgba(255,255,255,0.15)';
        saveBtn.style.display = 'none';
        badge.textContent = 'View Mode';
        badge.style.background = 'rgba(255,255,255,0.06)';
        badge.style.color = 'var(--text-muted)';
    }
}

// --- MULTI-OWNER DYNAMIC UI ---
let currentOwnersData = [];

async function syncOwnerCount() {
    const count = parseInt(document.getElementById('p-owner-count').value);
    const container = document.getElementById('owners-container');
    if (!container) return;
    container.innerHTML = '';
    
    for (let i = 0; i < count; i++) {
        const data = currentOwnersData[i] || { name: '', phone: '', altPhone: '', email: '', aadhaar: '', pan: '' };
        container.appendChild(renderOwnerCard(i, data));
    }
    // Re-lock or Unlock based on current state
    setKycLocked(!kycEditMode);
    if (window.lucide) lucide.createIcons();
    setProfileLocked(!profileEditMode);
}

function renderOwnerCard(index, data) {
    const card = document.createElement('div');
    card.className = 'owner-card';
    card.innerHTML = `
        <div class="owner-card-header">
            <div class="owner-title">${index === 0 ? 'Primary Owner / Lead Partner' : `Partner ${index + 1}`}</div>
            ${data.id ? `<span style="font-size:0.6rem; color:var(--text-muted); font-family:monospace;">ID: ${data.id}</span>` : ''}
        </div>
        <div class="owner-grid">
            <div class="owner-field-group">
                <label class="stat-label">Full Name</label>
                <input type="text" class="input owner-input" data-index="${index}" data-field="name" value="${data.name || ''}" placeholder="Full Name" ${kycEditMode ? '' : 'disabled'}>
            </div>
            <div class="owner-field-group">
                <label class="stat-label">Mobile Number</label>
                <div class="owner-input-wrapper">
                    <input type="tel" class="input owner-input" data-index="${index}" data-field="phone" value="${data.phone || ''}" placeholder="Phone" ${kycEditMode ? '' : 'disabled'}>
                    ${renderVerifyUI(data, 'phone', index)}
                </div>
            </div>
            <div class="owner-field-group">
                <label class="stat-label">Alt Mobile (Optional)</label>
                <div class="owner-input-wrapper">
                    <input type="tel" class="input owner-input" data-index="${index}" data-field="altPhone" value="${data.altPhone || ''}" placeholder="Alt Phone" ${kycEditMode ? '' : 'disabled'}>
                    ${renderVerifyUI(data, 'altPhone', index)}
                </div>
            </div>
            <div class="owner-field-group">
                <label class="stat-label">Aadhaar Number</label>
                <div class="owner-input-wrapper">
                    <input type="text" class="input owner-input" data-index="${index}" data-field="aadhaar" value="${data.aadhaar || ''}" placeholder="0000-0000-0000" maxlength="14" oninput="formatAadhaar(this)" ${kycEditMode ? '' : 'disabled'}>
                    ${renderVerifyUI(data, 'aadhaar', index)}
                </div>
            </div>
            <div class="owner-field-group">
                <label class="stat-label">PAN Number</label>
                <div class="owner-input-wrapper">
                    <input type="text" class="input owner-input" data-index="${index}" data-field="pan" value="${data.pan || ''}" placeholder="ABCDE1234F" maxlength="10" oninput="this.value=this.value.toUpperCase()" ${kycEditMode ? '' : 'disabled'}>
                    ${renderVerifyUI(data, 'pan', index)}
                </div>
            </div>
            <div class="owner-field-group">
                <label class="stat-label">Email (Optional)</label>
                <div class="owner-input-wrapper">
                    <input type="email" class="input owner-input" data-index="${index}" data-field="email" value="${data.email || ''}" placeholder="Email Address" ${kycEditMode ? '' : 'disabled'}>
                    ${renderVerifyUI(data, 'email', index)}
                </div>
            </div>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-top:20px; padding-top:20px; border-top:1px solid rgba(255,255,255,0.05);">
            <div class="evidence-card" style="padding:16px; margin:0;">
                <div class="evidence-header" style="margin-bottom:12px;">
                    <div class="evidence-title" style="font-size:0.8rem;">Aadhaar Document</div>
                    <div id="owner-${index}-aadhaar-status" class="status-badge-kyc ${data.aadhaarPath ? 'status-kyc-uploaded' : 'status-kyc-missing'}">
                        ${data.aadhaarPath ? 'Uploaded' : 'Missing'}
                    </div>
                </div>
                ${data.aadhaarPath ? `
                    <div class="file-attachment-slot">
                        <div class="file-info"><span class="file-name">aadhaar_proof.pdf</span></div>
                        <button class="btn btn-view btn-xs" onclick="viewOwnerDoc('${data.aadhaarPath}')">View</button>
                    </div>
                ` : `
                    <div class="upload-zone" onclick="triggerOwnerUpload(${index}, 'aadhaar')">
                        <i data-lucide="upload-cloud" style="width:20px;"></i>
                        <span style="font-size:0.7rem;">Upload Aadhaar (PDF)</span>
                    </div>
                `}
            </div>
            <div class="evidence-card" style="padding:16px; margin:0;">
                <div class="evidence-header" style="margin-bottom:12px;">
                    <div class="evidence-title" style="font-size:0.8rem;">PAN Document</div>
                    <div id="owner-${index}-pan-status" class="status-badge-kyc ${data.panPath ? 'status-kyc-uploaded' : 'status-kyc-missing'}">
                        ${data.panPath ? 'Uploaded' : 'Missing'}
                    </div>
                </div>
                ${data.panPath ? `
                    <div class="file-attachment-slot">
                        <div class="file-info"><span class="file-name">pan_proof.pdf</span></div>
                        <button class="btn btn-view btn-xs" onclick="viewOwnerDoc('${data.panPath}')">View</button>
                    </div>
                ` : `
                    <div class="upload-zone" onclick="triggerOwnerUpload(${index}, 'pan')">
                        <i data-lucide="upload-cloud" style="width:20px;"></i>
                        <span style="font-size:0.7rem;">Upload PAN (PDF)</span>
                    </div>
                `}
            </div>
        </div>
    `;
    return card;
}

let activeOwnerUpload = null;

function triggerOwnerUpload(index, docType) {
    if (!kycEditMode) return showNotify('Enable "Edit KYC" mode to upload documents.', 'warning');
    const owners = PROTOTYPE_STATE.currentOwners || [];
    const owner = owners[index];
    if (!owner || !owner.id) return showNotify('Please save the partner details first.', 'warning');
    
    activeOwnerUpload = { index, docType, ownerId: owner.id };
    document.getElementById('owner-doc-input').click();
}

async function handleOwnerDocSelect(input) {
    const file = input.files[0];
    if (!file || !activeOwnerUpload) return;
    
    const formData = new FormData();
    formData.append('file', file);
    formData.append('entityId', activeOwnerUpload.ownerId);
    formData.append('docType', `owner_${activeOwnerUpload.docType}`);

    try {
        const res = await fetch(`${API_URL}/upload-kyc`, {
            method: 'POST',
            body: formData
        });
        if (res.ok) {
            const data = await res.json();
            showNotify('Document uploaded successfully!', 'success');
            loadProfile(); // Refresh to show uploaded state
        } else {
            showNotify('Upload failed');
        }
    } catch (e) { showNotify('Upload error'); }
    activeOwnerUpload = null;
    input.value = '';
}

function viewOwnerDoc(path) {
    window.open(`${API_URL.replace('/api','')}/${path}`, '_blank');
}
function renderVerifyUI(data, field, index) {
    const isVerified = data[field + 'Verified'] == 1;
    // Special case: If this is owner 0 and the phone matches the signup number, it's auto-verified
    const signupPhone = (user.phone || '').replace('+91','');
    const currentVal = (data[field] || '').replace('+91','');
    
    if (index === 0 && field === 'phone' && currentVal === signupPhone && signupPhone) {
        return `<div class="verified-badge"><i data-lucide="shield-check" style="width:12px"></i> VERIFIED</div>`;
    }

    if (isVerified) {
        return `<div class="verified-badge"><i data-lucide="check-circle" style="width:12px"></i> VERIFIED</div>`;
    }
    return `<button class="btn btn-outline verify-btn" style="display:${kycEditMode ? 'inline-block' : 'none'}" onclick="verifyOwnerField('${data.id}', '${field}', ${index})">Verify</button>`;
}

async function verifyOwnerField(ownerId, field, index) {
    if (!ownerId || ownerId === 'undefined') return showNotify('Please save the profile first before verifying partners.', 'warning');
    
    const otp = prompt(`Enter OTP sent to ${field}: (Simulated: 1234)`);
    if (otp !== '1234') return showNotify('Invalid OTP');

    try {
        const res = await fetch(`${API_URL}/verify-field`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entityId: ownerId, entityType: 'owner', field, status: 1 })
        });
        if (res.ok) {
            showNotify(`${field} verified successfully!`, 'success');
            loadProfile(); // Refresh
        }
    } catch(e) { showNotify('Verification failed'); }
}

function formatAadhaar(el) {
    let val = el.value.replace(/[^0-9]/g, '').substring(0, 12);
    let formatted = '';
    for(let i=0; i<val.length; i++) {
        if (i > 0 && i % 4 === 0) formatted += '-';
        formatted += val[i];
    }
    el.value = formatted;
}

async function loadProfile() {
    setProfileLocked(!profileEditMode);
    const gid = user.garageId;
    if (!gid) return;
    const res = await fetch(`${API_URL}/garages/${gid}`);
    const g = await res.json();
    if (!g) return;
    PROTOTYPE_STATE.currentOwners = g.owners || [];

    // Identity
    const garageName = g.name || g.Name;
    if (garageName && garageName !== user.name && garageName !== 'New Partner') {
        user.name = garageName;
        localStorage.setItem('redrivo_user', JSON.stringify(user));
        document.getElementById('nav-user-name').textContent = garageName;
        document.getElementById('nav-user-avatar').src = `https://ui-avatars.com/api/?name=${encodeURIComponent(garageName)}&background=facc15&color=000`;
    }
    
    document.getElementById('p-name').value    = garageName || user.name || '';
    document.getElementById('p-owner').value   = g.owner   || g.Owner   || '';
    document.getElementById('p-owner-count').value = g.ownerCount || g.ownercount || 1;
    document.getElementById('p-biztype').value = g.businessType || g.businesstype || 'Individual';
    document.getElementById('p-svctype').value = g.serviceType  || g.servicetype  || 'Both';

    const cType = g.serviceCenterType || g.servicecentertype || 'local';
    const cTypeEl = document.getElementById('p-center-type');
    if (cTypeEl) cTypeEl.value = cType;

    const rawCarBrands = g.authorizedCarBrands || g.authorizedcarbrands || '';
    const rawBikeBrands = g.authorizedBikeBrands || g.authorizedbikebrands || '';
    selectedCarBrands = new Set(rawCarBrands.split(',').map(s => s.trim()).filter(Boolean));
    selectedBikeBrands = new Set(rawBikeBrands.split(',').map(s => s.trim()).filter(Boolean));
    updateAuthorizedBrandsVisibility();

    // Fetch and sync owners
    const ownersRes = await fetch(`${API_URL}/garages/${gid}/owners`);
    currentOwnersData = await ownersRes.json();
    syncOwnerCount();

    // Contact
    const phone = (g.contact || g.Contact || '').replace('+91','');
    document.getElementById('p-phone').value    = phone;
    document.getElementById('p-altphone').value = (g.altPhone || g.altphone || '').replace('+91','');
    document.getElementById('p-email').value    = g.email || g.Email || '';

    // Verification badges
    document.getElementById('p-phone-badge').textContent = (g.phoneVerified || g.phoneverified) == 1 ? 'Verified' : '';
    document.getElementById('p-alt-badge').textContent   = (g.altPhoneVerified || g.altphoneverified) == 1 ? 'Verified' : '';
    document.getElementById('p-email-badge').textContent = (g.emailVerified || g.emailverified) == 1 ? 'Verified' : '';

    // Location — split stored address into parts if available
    const rawAddr = g.address || g.Address || g.location || '';
    const parts = rawAddr.split('|');
    document.getElementById('p-address').value = parts[0] || (parts.length === 1 ? rawAddr : '');
    document.getElementById('p-pincode').value = parts[1] || '';
    document.getElementById('p-city').value    = parts[2] || '';
    document.getElementById('p-state').value   = parts[3] || '';
    document.getElementById('p-country').value = parts[4] || 'India';

    if (g.lat && g.lng) {
        document.getElementById('p-coords').textContent = `${parseFloat(g.lat).toFixed(5)}, ${parseFloat(g.lng).toFixed(5)}`;
    } else {
        document.getElementById('p-coords').textContent = 'Coords: Not Detected';
    }

    // Load KYC Data specifically since it's separated now
    document.getElementById('k-gst').value = g.gstNumber || g.gstnumber || '';
    document.getElementById('k-acc').value = g.bankAccountNumber || g.bankaccountnumber || '';
    document.getElementById('k-ifsc').value = g.bankIFSC || g.bankifsc || '';
    document.getElementById('k-id-type').value = g.govIdType || g.govidtype || 'PAN Card';
    document.getElementById('k-id-number').value = g.govIdNumber || g.govidnumber || '';

    // Always start in locked (view) mode — reset any active edit state
    profileEditMode = false;
    kycEditMode = false; // Added for separate KYC tab
    setProfileLocked(true);
    setKycLocked(true);

    const editBtn = document.getElementById('btn-profile-edit');
    const saveBtn = document.getElementById('btn-save-profile');
    const badge   = document.getElementById('profile-mode-badge');
    if (editBtn) { editBtn.textContent = 'Edit'; editBtn.style.background='rgba(255,255,255,0.07)'; editBtn.style.color='#ddd'; editBtn.style.borderColor='rgba(255,255,255,0.15)'; }
    if (saveBtn) saveBtn.style.display = 'none';
    if (badge)   { badge.textContent = 'View Mode'; badge.style.background='rgba(255,255,255,0.06)'; badge.style.color='var(--text-muted)'; }

    if (kEditBtn) { kEditBtn.textContent = 'Edit'; kEditBtn.style.background='rgba(255,255,255,0.07)'; kEditBtn.style.color='#ddd'; kEditBtn.style.borderColor='rgba(255,255,255,0.15)'; }
    if (kSaveBtn) kSaveBtn.style.display = 'none';
    if (kBadge)   { kBadge.textContent = 'View Mode'; kBadge.style.background='rgba(255,255,255,0.06)'; kBadge.style.color='var(--text-muted)'; }

    // Load Photos
    const photoMap = g.garagePhotos || {};
    ['inside', 'outside', 'waiting'].forEach(type => {
        const path = photoMap[type];
        const preview = document.getElementById(`preview-photo-${type}`);
        const uploadArea = document.getElementById(`upload-${type}`);
        if (path) {
            const fullUrl = path.startsWith('data:') ? path : `${API_URL.replace('/api','')}/${path}`;
            preview.style.backgroundImage = `url(${fullUrl})`;
            preview.style.display = 'flex';
            uploadArea.style.display = 'none';
            preview.innerHTML = `<button class="btn-remove" onclick="removeGaragePhoto('${type}')">&times;</button>`;
        } else {
            preview.style.display = 'none';
            uploadArea.style.display = 'flex';
        }
    });
}

async function saveProfile() {
    const gid = user.garageId;
    const btn = document.getElementById('btn-save-profile');
    btn.textContent = 'Saving...'; btn.disabled = true;

    // Build composite address string
    const addr = [
        document.getElementById('p-address').value.trim(),
        document.getElementById('p-pincode').value.trim(),
        document.getElementById('p-city').value.trim(),
        document.getElementById('p-state').value.trim(),
        document.getElementById('p-country').value.trim() || 'India'
    ].join('|');

    const centerType = document.getElementById('p-center-type') ? document.getElementById('p-center-type').value : 'local';
    const svcType = document.getElementById('p-svctype').value;

    let finalCarBrands = '';
    let finalBikeBrands = '';

    if (centerType === 'authorized') {
        const carArr = Array.from(selectedCarBrands);
        const bikeArr = Array.from(selectedBikeBrands);

        if (svcType === 'Car' && carArr.length === 0) {
            btn.textContent = 'Save Changes'; btn.disabled = false;
            return showNotify('Please select at least one authorized Car brand.', 'error');
        }
        if (svcType === 'Bike' && bikeArr.length === 0) {
            btn.textContent = 'Save Changes'; btn.disabled = false;
            return showNotify('Please select at least one authorized Bike brand.', 'error');
        }
        if (svcType === 'Both' && (carArr.length === 0 || bikeArr.length === 0)) {
            btn.textContent = 'Save Changes'; btn.disabled = false;
            return showNotify('Please select at least one authorized brand for both Car and Bike categories.', 'error');
        }

        if (svcType === 'Car' || svcType === 'Both') {
            finalCarBrands = carArr.join(',');
        }
        if (svcType === 'Bike' || svcType === 'Both') {
            finalBikeBrands = bikeArr.join(',');
        }
    }

    const body = {
        name:                 document.getElementById('p-name').value.trim(),
        owner:                document.getElementById('p-owner').value.trim(),
        ownerCount:           parseInt(document.getElementById('p-owner-count').value),
        businessType:         document.getElementById('p-biztype').value,
        serviceType:          svcType,
        serviceCenterType:    centerType,
        authorizedCarBrands:  finalCarBrands,
        authorizedBikeBrands: finalBikeBrands,
        address:              addr,
        garagePhotos: {
            inside: document.getElementById('preview-photo-inside').style.backgroundImage.slice(5, -2),
            outside: document.getElementById('preview-photo-outside').style.backgroundImage.slice(5, -2),
            waiting: document.getElementById('preview-photo-waiting').style.backgroundImage.slice(5, -2)
        }
    };

    try {
        await fetch(`${API_URL}/garages/${gid}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });

        // Save Multi-Owners
        const ownerInputs = document.querySelectorAll('.owner-input');
        const ownersToSave = [];
        const count = body.ownerCount;
        
        for (let i = 0; i < count; i++) {
            const ownerObj = { ...currentOwnersData[i] };
            ownerInputs.forEach(input => {
                if (parseInt(input.dataset.index) === i) {
                    ownerObj[input.dataset.field] = input.value.trim();
                }
            });
            ownersToSave.push(ownerObj);
        }

        // Sequential save for owners
        for (let owner of ownersToSave) {
            if (owner.id) {
                await fetch(`${API_URL}/owners/${owner.id}`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(owner)
                });
            } else {
                await fetch(`${API_URL}/garages/${gid}/owners`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(owner)
                });
            }
        }

        // Update globally: navbar name + user object
        if (body.name) {
            document.getElementById('nav-user-name').textContent = body.name;
            document.getElementById('nav-user-avatar').src = `https://ui-avatars.com/api/?name=${encodeURIComponent(body.name)}&background=facc15&color=000`;
            if (user) {
                user.name = body.name;
                localStorage.setItem('redrivo_user', JSON.stringify(user));
            }
        }

        btn.textContent = 'Saved!';
        btn.style.background = 'rgba(16,185,129,0.2)';
        btn.style.color = 'var(--success)';
        btn.style.borderColor = 'rgba(16,185,129,0.4)';
        showNotify('Profile saved successfully!', 'success');

        // Re-lock after 1.2s
        setTimeout(() => {
            profileEditMode = true;     // trick toggleProfileEdit into flipping back
            toggleProfileEdit();        // this resets to locked view mode
        }, 1200);

    } catch (e) {
        showNotify('Failed to save profile.', 'error');
        btn.textContent = 'Save Changes';
        btn.disabled = false;
    }
}

// --- GARAGE PHOTO HELPERS ---
function triggerPhotoUpload(type) {
    if (profileEditMode) {
        document.getElementById(`file-photo-${type}`).click();
    } else {
        showNotify('Please enter Edit mode to upload photos.', 'info');
    }
}

function previewGaragePhoto(type, input) {
    const file = input.files[0];
    if (file) {
        if (file.size > 2 * 1024 * 1024) return showNotify('Image size too large. Max 2MB allowed.');
        
        const reader = new FileReader();
        reader.onload = function(e) {
            const preview = document.getElementById(`preview-photo-${type}`);
            const uploadArea = document.getElementById(`upload-${type}`);
            preview.style.backgroundImage = `url(${e.target.result})`;
            preview.style.display = 'flex';
            uploadArea.style.display = 'none';
            preview.innerHTML = `<button class="btn-remove" onclick="removeGaragePhoto('${type}')">&times;</button>`;
        }
        reader.readAsDataURL(file);
    }
}

function removeGaragePhoto(type) {
    if (!profileEditMode) return;
    const preview = document.getElementById(`preview-photo-${type}`);
    const uploadArea = document.getElementById(`upload-${type}`);
    const input = document.getElementById(`file-photo-${type}`);
    
    preview.style.display = 'none';
    preview.style.backgroundImage = 'none';
    preview.innerHTML = '';
    uploadArea.style.display = 'flex';
    input.value = '';
}

// ============================================================
// KYC MANAGEMENT
// ============================================================
// kycEditMode previously declared
const KYC_FIELDS = ['k-bank-name', 'k-acc-type', 'k-gst', 'k-pan-number', 'k-id-type', 'k-id-number', 'k-acc', 'k-ifsc'];

function setKycLocked(locked) {
    KYC_FIELDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.disabled = locked;
        el.style.opacity = locked ? '0.55' : '1';
        el.style.cursor  = locked ? 'not-allowed' : '';
        el.style.border  = locked ? '1px solid rgba(255,255,255,0.06)' : '1px solid rgba(255,255,255,0.18)';
    });
    
    // Unlock Partner Inputs
    document.querySelectorAll('.owner-input').forEach(el => {
        el.disabled = locked;
        el.style.opacity = locked ? '0.55' : '1';
        el.style.cursor  = locked ? 'not-allowed' : '';
    });

    // Handle Upload Zones visibility
    document.querySelectorAll('.upload-zone').forEach(el => {
        el.style.display = locked ? 'none' : 'flex';
    });

    // Handle Verify Buttons
    document.querySelectorAll('.verify-btn').forEach(el => {
        el.style.display = locked ? 'none' : 'inline-block';
    });
}

function toggleKycEdit() {
    kycEditMode = !kycEditMode;
    const editBtn = document.getElementById('btn-kyc-edit');
    const saveBtn = document.getElementById('btn-save-kyc');
    const badge   = document.getElementById('kyc-mode-badge');

    setKycLocked(!kycEditMode);

    if (kycEditMode) {
        editBtn.textContent = 'Cancel';
        editBtn.classList.remove('btn-outline');
        editBtn.classList.add('btn-danger');
        saveBtn.style.display = 'flex';
        saveBtn.textContent = 'Save';
        
        badge.textContent = 'Edit Mode';
        badge.style.background = 'rgba(250,180,0,0.12)';
        badge.style.color = 'var(--accent)';
    } else {
        editBtn.textContent = 'Edit';
        editBtn.classList.add('btn-outline');
        editBtn.classList.remove('btn-danger');
        saveBtn.style.display = 'none';
        
        badge.textContent = 'View Mode';
        badge.style.background = 'rgba(255,255,255,0.06)';
        badge.style.color = 'var(--text-muted)';
    }
    loadKYC();
}

function validateKycData() {
    const pan = document.getElementById('k-pan-number').value.trim();
    const idType = document.getElementById('k-id-type').value;
    const idNum = document.getElementById('k-id-number').value.trim();
    const bizType = document.getElementById('k-biz-type')?.value || 'Individual';
    const gst = document.getElementById('k-gst').value.trim();

    // PAN Validation: 5L, 4N, 1L
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
    if (!panRegex.test(pan)) {
        showNotify('Invalid PAN Format. Must be: 5 Letters, 4 Digits, 1 Letter (e.g. ABCDE1234F)');
        return false;
    }

    // ID Validation (specifically Aadhaar)
    if (idType === 'Aadhaar Card') {
        const cleanID = idNum.replace(/-/g, '');
        if (!/^[0-9]{12}$/.test(cleanID)) {
            showNotify('Invalid Aadhaar Number. Must be exactly 12 digits (0000-0000-0000).');
            return false;
        }
    } else if (!idNum) {
        showNotify(`Please enter your ${idType} number.`);
        return false;
    }

    // GST Validation (if Pvt Ltd or number provided)
    if (bizType === 'PVT LTD' || bizType === 'LLC' || gst.length > 0) {
        if (gst.length < 15) {
            showNotify('GST Number must be 15 characters long.');
            return false;
        }
    }

    return true;
}

async function saveKyc() {
    if (!validateKycData()) return;
    
    const gid = user.garageId;
    const btn = document.getElementById('btn-save-kyc');
    btn.textContent = 'Saving...'; btn.disabled = true;

    const body = {
        bankName:     document.getElementById('k-bank-name').value,
        accountType:  document.getElementById('k-acc-type').value,
        bankAccountNumber: document.getElementById('k-acc').value.trim(),
        bankIFSC:     document.getElementById('k-ifsc').value.trim(),
        gstNumber:    document.getElementById('k-gst').value.trim(),
        panNumber:    document.getElementById('k-pan-number').value.trim(),
        govIdType:    document.getElementById('k-id-type').value,
        govIdNumber:  document.getElementById('k-id-number').value.replace(/-/g, ''), // Strip hyphens for storage
    };

    try {
        const res = await fetch(`${API_URL}/garages/${gid}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });

        if (!res.ok) {
            const errData = await res.json();
            throw new Error(errData.error || 'Server rejected the update');
        }

        btn.textContent = 'Verifying...';
        // Wait 500ms for DB commit and fetch again to verify
        setTimeout(async () => {
            try {
                const checkRes = await fetch(`${API_URL}/garages/${gid}`);
                const g = await checkRes.json();
                
                // Verify critical fields (use lowercase as fallback)
                const savedAcc = g.accountType || g.accounttype;
                const savedID = g.govIdNumber || g.govidnumber;
                
                if (savedAcc && savedID) {
                    btn.textContent = 'Saved!';
                    btn.style.background = 'rgba(16,185,129,0.2)';
                    btn.style.color = 'var(--success)';
                    btn.style.borderColor = 'rgba(16,185,129,0.4)';
                    showNotify('KYC details saved and verified!', 'success');
                    
                    // Mode is currently true (Edit), calling toggle will make it false (View)
                    setTimeout(() => {
                        toggleKycEdit();
                    }, 1200);
                } else {
                    throw new Error('Verification failed - records not found after save');
                }
            } catch(ve) {
                console.error('Verification Error:', ve);
                showNotify(`Save Warning: ${ve.message}`, 'warning');
                btn.textContent = 'Save';
                btn.disabled = false;
            }
        }, 800);

    } catch (e) {
        console.error('KYC Save Error Details:', {
            error: e.message,
            garageId: gid,
            payload: body
        });
        showNotify(`Failed to save KYC records: ${e.message}`, 'error');
        btn.textContent = 'Save';
        btn.disabled = false;
    }
}

// ---- OTP Contact Verification ----
function requestPhoneChange() {
    const btn = document.getElementById('btn-change-primary-phone');
    if (!profileEditMode) return showNotify('Please click "Edit Profile" first before requesting a phone change.', 'error');
    
    // Unlock the field
    const phoneInput = document.getElementById('p-phone');
    phoneInput.disabled = false;
    phoneInput.style.opacity = '1';
    phoneInput.style.cursor = 'text';
    phoneInput.style.border = '1px solid var(--primary)';
    phoneInput.focus();
    
    // Morph button into Verify OTP trigger
    btn.textContent = 'Send Verify OTP';
    btn.onclick = () => sendContactOtp('phone', 'primary');
}

function verifyPhoneChangeOtp() {
    verifyContactOtp('phone', 'primary');
}

async function sendContactOtp(type, field) {
    const gid = user.garageId;
    let value;
    if (field === 'primary') value = '+91' + document.getElementById('p-phone').value.trim();
    else if (field === 'alt')  value = '+91' + document.getElementById('p-altphone').value.trim();
    else                       value = document.getElementById('p-email').value.trim();

    if (!value || value.length < 5) return showNotify('Please enter a valid ' + type, 'error');

    const body = type === 'email' ? { email: value } : { phone: value };
    try {
        const r = await fetch(`${API_URL}/auth/send-otp`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const d = await r.json();
        showNotify(`OTP sent! (Test: ${d.otp})`, 'success');

        // Show OTP input row
        const rowId = field === 'primary' ? 'p-phone-otp-row' : field === 'alt' ? 'p-alt-otp-row' : 'p-email-otp-row';
        document.getElementById(rowId).style.display = 'block';
    } catch (e) {
        showNotify('Failed to send OTP.', 'error');
    }
}

async function verifyContactOtp(type, field) {
    const gid = user.garageId;
    let value, otp;

    if (field === 'primary') {
        value = '+91' + document.getElementById('p-phone').value.trim();
        otp   = document.getElementById('p-phone-otp').value.trim();
    } else if (field === 'alt') {
        value = '+91' + document.getElementById('p-altphone').value.trim();
        otp   = document.getElementById('p-alt-otp').value.trim();
    } else {
        value = document.getElementById('p-email').value.trim();
        otp   = document.getElementById('p-email-otp').value.trim();
    }

    const body = type === 'email' ? { email: value, otp } : { phone: value, otp };
    try {
        const r = await fetch(`${API_URL}/auth/verify-otp`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        if (!r.ok) { showNotify('Invalid or expired OTP.', 'error'); return; }

        // Now save verified field to garage profile
        let updateBody = {};
        if (field === 'primary') { updateBody = { contact: value, phoneVerified: 1 }; }
        else if (field === 'alt')  { updateBody = { altPhone: value, altPhoneVerified: 1 }; }
        else                       { updateBody = { email: value, emailVerified: 1 }; }

        await fetch(`${API_URL}/garages/${gid}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updateBody)
        });

        const badgeId = field === 'primary' ? 'p-phone-badge' : field === 'alt' ? 'p-alt-badge' : 'p-email-badge';
        const rowId   = field === 'primary' ? 'p-phone-otp-row' : field === 'alt' ? 'p-alt-otp-row' : 'p-email-otp-row';
        document.getElementById(badgeId).textContent = 'Verified';
        document.getElementById(rowId).style.display = 'none';
        showNotify(`${type === 'email' ? 'Email' : 'Phone'} verified successfully!`, 'success');
    } catch (e) {
        showNotify('Verification failed.', 'error');
    }
}

// ---- GPS Auto-Detect ----
function autoDetectLocation() {
    const statusEl = document.getElementById('loc-status');
    const btn = document.getElementById('btn-detect-loc');
    statusEl.style.display = 'block';
    statusEl.textContent = 'Detecting your location...';
    btn.disabled = true;

    if (!navigator.geolocation) {
        statusEl.textContent = 'Geolocation is not supported by your browser.';
        btn.disabled = false; return;
    }

    
    if (!confirm("ReDrivo Garage needs your location to accurately list your garage for nearby customers. Proceed?")) return;
    navigator.geolocation.getCurrentPosition(async (pos) => {
        const { latitude, longitude } = pos.coords;
        document.getElementById('p-coords').textContent = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
        statusEl.textContent = `Got GPS: ${latitude.toFixed(4)}, ${longitude.toFixed(4)} — Reverse geocoding...`;

        try {
            const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`, {
                headers: { 'Accept-Language': 'en-IN' }
            });
            const data = await r.json();
            const addr = data.address || {};

            const street  = (addr.road || addr.neighbourhood || '') + (addr.suburb ? ', ' + addr.suburb : '');
            const pincode = addr.postcode || '';
            
            // Refined City Logic: Prioritize state_district for major cities like Kolkata
            let city = addr.city || addr.town || addr.village || '';
            if (addr.state_district && addr.state_district.toLowerCase() === 'kolkata') {
                city = 'Kolkata';
            } else if (!city && addr.state_district) {
                city = addr.state_district;
            }
            
            const state   = addr.state || '';
            const country = addr.country || 'India';

            // Fetch business name if available in the data
            const businessName = data.name || addr.amenity || addr.shop || addr.office || '';
            if (businessName && !document.getElementById('p-name').value) {
                document.getElementById('p-name').value = businessName;
            }

            document.getElementById('p-address').value = street;
            document.getElementById('p-pincode').value = pincode;
            document.getElementById('p-city').value    = city;
            document.getElementById('p-state').value   = state;
            document.getElementById('p-country').value = country;

            statusEl.textContent = `Location filled automatically from GPS coordinates. Saving...`;
            statusEl.style.color = 'var(--success)';

            // Auto-Save the detected address so it persists on refresh
            const compositeAddr = [street, pincode, city, state, country].join('|');
            await fetch(`${API_URL}/garages/${user.garageId}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    lat: latitude, 
                    lng: longitude,
                    address: compositeAddr
                })
            });
            statusEl.textContent = `Location detected and saved automatically.`;
        } catch (e) {
            console.error('Reverse Geocode Error:', e);
            statusEl.textContent = 'Could not reverse geocode. Fill address manually.';
        }
        btn.disabled = false;
    }, (err) => {
        statusEl.textContent = 'Location access denied. Please allow it in browser settings.';
        btn.disabled = false;
    }, { timeout: 10000 });
}

// ---- Pincode Auto-fill ----
async function fetchPincodeData(pin) {
    try {
        const r = await fetch(`https://api.postalpincode.in/pincode/${pin}`);
        const data = await r.json();
        if (data[0]?.Status === 'Success') {
            const post = data[0].PostOffice[0];
            document.getElementById('p-city').value  = post.District || post.Name || '';
            document.getElementById('p-state').value = post.State  || '';
            document.getElementById('p-country').value = 'India';
            showNotify(`City/State auto-filled for PIN ${pin}`, 'success');
        }
    } catch (e) { /* Silently fail */ }
}

const showSync = (show) => {
    const el = document.querySelector('.sync-indicator');
    if (el) el.style.opacity = show ? '1' : '0';
};

window.addEventListener('DOMContentLoaded', () => {
    const saved = localStorage.getItem('redrivo_user');
    if(saved) {
        try { 
            const parsed = JSON.parse(saved);
            if (parsed && parsed.id) {
                user = parsed;
                enterDashboard();
            } else {
                initGoogleOneTap();
            }
        } catch(e){
            console.error('Boot session error:', e);
            localStorage.removeItem('redrivo_user');
            initGoogleOneTap();
        }
    } else {
        initGoogleOneTap();
    }
});
