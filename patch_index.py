import re
import os

with open('index.js', 'r', encoding='utf-8') as f:
    code = f.read()

fcm_code = """
// --- FIREBASE FCM SETUP ---
const admin = require('firebase-admin');
try {
    const serviceAccount = require('./firebaseServiceAccountKey.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin initialized.');
} catch(e) {
    console.warn('Firebase Admin init failed (missing key json). FCM disabled.');
}

async function ensureFcmTokenColumn() {
    try {
        await pool.query('ALTER TABLE users ADD COLUMN fcmToken TEXT');
        console.log('Added fcmToken to users table.');
    } catch(e) {
        // likely already exists
    }
}
ensureFcmTokenColumn();

async function notifyMarshalsFCM(title, body, payloadData = {}) {
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
}

const apiRouter = express.Router();
"""

code = code.replace("const apiRouter = express.Router();", fcm_code)

# Add the PUT endpoint for FCM token
put_fcm_endpoint = """
apiRouter.put('/users/:id/fcm-token', async (req, res) => {
    try {
        const { fcmToken } = req.body;
        if (!fcmToken) return res.status(400).json({ error: 'Token required' });
        await pool.query("UPDATE users SET fcmToken = $1 WHERE id = $2", [fcmToken, req.params.id]);
        res.json({ success: true });
    } catch(err) {
        console.error(err);
        res.status(500).json({ error: 'DB Error' });
    }
});
"""
code = code.replace("apiRouter.put('/users/:id', async (req, res) => {", put_fcm_endpoint + "\napiRouter.put('/users/:id', async (req, res) => {")

# Add the notification trigger to service request creation
# We look for "apiRouter.post('/service-requests'"
booking_trigger = """
        // Ping marshals via FCM
        notifyMarshalsFCM('New Pickup Request!', `A customer has requested a pickup at ${address}. Tap to accept.`);
"""

# Let's just blindly inject it into the success response of POST /service-requests
# We'll use regex to find the exact place
code = re.sub(r'(res\.status\(201\)\.json\(\{.*?serviceRequestId: newId.*?\);)', booking_trigger + r'\1', code, flags=re.DOTALL)

with open('index.js', 'w', encoding='utf-8') as f:
    f.write(code)

print("Backend FCM logic injected successfully.")
