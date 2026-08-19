const fs = require('fs');

const appJsPath = 'c:/Users/Suban/OneDrive/Documents/vroomly-customer-app/www/app.js';
let content = fs.readFileSync(appJsPath, 'utf8');

// Normalize to LF for easy replacing
content = content.replace(/\r\n/g, '\n');

// 1. Fix deleteVehicle
const oldDeleteVehicle = `async function deleteVehicle(id) {
    if (!confirm('Are you sure you want to delete this vehicle?')) return;
    try {
        await apiDelete(\`/vehicles/\${id}\`);
        showToast('Vehicle deleted', 'success');
        loadDashboard();
    } catch (err) {
        console.error(err);
        showToast('Failed to delete vehicle', 'error');
    }
}`;

const newDeleteVehicle = `async function deleteVehicle(id) {
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
        await apiDelete(\`/vehicles/\${id}\`);
        showToast('Vehicle deleted', 'success');
        loadDashboard();
    } catch (err) {
        console.error(err);
        showToast('Failed to delete vehicle', 'error');
    }
}`;

content = content.replace(oldDeleteVehicle, newDeleteVehicle);

// 2. Fix editVehicle photo fallback
const oldEditVehicle = `    if (v.photo) {
        const preview = document.getElementById('v-photo-preview');
        preview.src = v.photo;
        preview.style.display = 'block';
        document.getElementById('photo-label-text').textContent = 'Click to change photo';
    }`;

const newEditVehicle = `    let displayPhoto = v.photo;
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
    }`;

content = content.replace(oldEditVehicle, newEditVehicle);

// 3. Fix switchTab
const oldSwitchTab = `    const btnProfile = document.getElementById('nav-btn-profile');

    if (tabId === 'garage') {`;

const newSwitchTab = `    const btnProfile = document.getElementById('nav-btn-profile');

    const centerPin = document.getElementById('center-pickup-pin');
    if (centerPin && tabId !== 'garage' && tabId !== 'focus-garage') {
        centerPin.style.display = 'none';
    }

    if (tabId === 'garage') {`;

content = content.replace(oldSwitchTab, newSwitchTab);

// Re-apply CRLF just to be safe, though not strictly required
content = content.replace(/\n/g, '\r\n');

fs.writeFileSync(appJsPath, content, 'utf8');
console.log('Done!');
