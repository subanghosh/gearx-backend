const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

async function publish() {
    const target = (process.argv[2] || 'driver').toLowerCase();
    const isDriver = target.includes('driver') || target.includes('marshal');
    const localApkPath = isDriver 
        ? path.resolve(__dirname, '../../vroomly-marshal-app/android/app/build/outputs/apk/release/app-release.apk')
        : path.resolve(__dirname, '../../vroomly-customer-app/android/app/build/outputs/apk/release/app-release.apk');
    const targetFilename = isDriver ? 'redrivo-driver.apk' : 'redrivo-customer.apk';

    if (!fs.existsSync(localApkPath)) {
        console.error(`[ERROR] APK file not found at: ${localApkPath}`);
        console.error(`Run '.\\gradlew.bat assembleRelease' first.`);
        process.exit(1);
    }

    const stats = fs.statSync(localApkPath);
    console.log(`\n======================================================`);
    console.log(`PUBLISHING APK TO RAILWAY PERSISTENT VOLUME`);
    console.log(`======================================================`);
    console.log(`Target:           ${targetFilename}`);
    console.log(`Local File Path:  ${localApkPath}`);
    console.log(`Local File Size:  ${stats.size} bytes (${(stats.size / (1024 * 1024)).toFixed(2)} MB)`);
    console.log(`Modified:         ${stats.mtime.toLocaleString()}`);
    console.log(`======================================================\n`);

    let token = process.argv[3];
    if (!token) {
        token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InVzcl9hZG1fMTc4ODA2OTAyMzE1OCIsInJvbGUiOiJhZG1pbiIsImdhcmFnZUlkIjpudWxsLCJ0b2tlblZlcnNpb24iOjEsImlhdCI6MTc4ODY1NjE1OSwiZXhwIjoxNzkxMjQ4MTU5fQ._qz5EcrrkS-MfRvQ45pz2xwxkbWS964W0KQuF4w5fHY';
    }

    console.log('Uploading APK via POST /api/admin/system/upload-apk...');
    const startTime = Date.now();

    const formData = new FormData();
    const fileBuffer = fs.readFileSync(localApkPath);
    const blob = new Blob([fileBuffer], { type: 'application/vnd.android.package-archive' });
    formData.append('apk', blob, targetFilename);

    try {
        const uploadUrl = `https://api.redrivo.in/api/admin/system/upload-apk?target=${targetFilename}`;
        const res = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
            },
            body: formData
        });

        const text = await res.text();
        let json = null;
        try {
            json = JSON.parse(text);
        } catch {
            console.error('Non-JSON response from server:', text);
            process.exit(1);
        }

        console.log(`Upload Status: ${res.status} ${res.statusText} (${Date.now() - startTime}ms)`);
        console.log('Server Response JSON:');
        console.log(JSON.stringify(json, null, 2));

        if (!res.ok || !json.success) {
            console.error('\n[FAILED] Upload did not succeed.');
            process.exit(1);
        }

        console.log('\n--- Running Live Header Verification ---');
        const headRes = await fetch(`https://api.redrivo.in/downloads/${targetFilename}`, { method: 'HEAD' });
        const liveLength = headRes.headers.get('content-length');
        console.log(`HTTP Status:    ${headRes.status} ${headRes.statusText}`);
        console.log(`Content-Length: ${liveLength} bytes`);
        console.log(`Local Size:     ${stats.size} bytes`);
        const match = (liveLength === String(stats.size));
        console.log(`Exact Match:    ${match ? '✓ YES (100% MATCH)' : '✗ NO'}`);

    } catch (err) {
        console.error('Publish error:', err);
        process.exit(1);
    }
}

publish();
