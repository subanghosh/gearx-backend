import os

with open('index.js', 'r', encoding='utf-8') as f:
    code = f.read()

# The old bad code
bad_init = """const admin = require('firebase-admin');
try {
    const serviceAccount = require('./firebaseServiceAccountKey.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin initialized.');
} catch(e) {
    console.warn('Firebase Admin init failed (missing key json). FCM disabled.');
}"""

good_init = """const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

let fcmInitialized = false;
try {
    const serviceAccount = require('./firebaseServiceAccountKey.json');
    initializeApp({
        credential: cert(serviceAccount)
    });
    fcmInitialized = true;
    console.log('Firebase Admin initialized.');
} catch(e) {
    console.warn('Firebase Admin init failed (missing key json or error). FCM disabled.');
}"""

bad_notify = """async function notifyMarshalsFCM(title, body, payloadData = {}) {
    try {
        if (!admin.apps.length) return;
        const res = await pool.query("SELECT fcmToken FROM users WHERE role = 'marshal' AND fcmToken IS NOT NULL");
        const tokens = res.rows.map(r => r.fcmtoken || r.fcmToken).filter(Boolean);
        if (tokens.length === 0) return;
        await admin.messaging().sendMulticast({
            tokens: tokens,
            notification: { title, body },
            data: payloadData,
            android: { priority: 'high', notification: { channelId: 'marshal-alerts', sound: 'default' } }
        });
        console.log('Sent FCM to marshals', tokens.length);
    } catch(e) { console.error('FCM Error:', e); }
}"""

good_notify = """async function notifyMarshalsFCM(title, body, payloadData = {}) {
    try {
        if (!fcmInitialized) return;
        const res = await pool.query("SELECT fcmToken FROM users WHERE role = 'marshal' AND fcmToken IS NOT NULL");
        const tokens = res.rows.map(r => r.fcmtoken || r.fcmToken).filter(Boolean);
        if (tokens.length === 0) return;
        await getMessaging().sendEachForMulticast({
            tokens: tokens,
            notification: { title, body },
            data: payloadData,
            android: { priority: 'high', notification: { channel_id: 'marshal-alerts', default_sound: true } }
        });
        console.log('Sent FCM to marshals', tokens.length);
    } catch(e) { console.error('FCM Error:', e); }
}"""

code = code.replace(bad_init, good_init)
code = code.replace(bad_notify, good_notify)

with open('index.js', 'w', encoding='utf-8') as f:
    f.write(code)

print('Patched successfully!')
