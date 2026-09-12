const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (fs.existsSync(path.join(__dirname, '.env.local'))) {
    require('dotenv').config({ path: path.join(__dirname, '.env.local'), override: true });
}
const { Pool } = require('pg');
const multer = require('multer');
const { isR2Configured, uploadBufferToR2, getPresignedDocUrl, getR2ObjectStream, headR2Object, normalizeKey } = require('./r2Storage');
const nodemailer = require('nodemailer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const googleOAuthClient = new OAuth2Client();

const app = express();
app.set('trust proxy', 1); // Crucial for Render/reverse proxies to accurately identify client IPs for rate limiting

console.log('[STARTUP-1] Starting GearX backend initialization...');
const PORT = parseInt(process.env.PORT, 10) || 3000;
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
    throw new Error('FATAL: JWT_SECRET environment variable is missing.');
}
const JWT_SECRET = process.env.JWT_SECRET || 'gearx-dev-jwt-secret';
const FILE_SIGNING_SECRET = process.env.FILE_SIGNING_SECRET || crypto.createHmac('sha256', JWT_SECRET).update('redrivo:file-signing-key:v1').digest('hex');

function generateSignedUploadUrl(filePath, expirySeconds = 86400) {
    if (!filePath || typeof filePath !== 'string') return filePath;
    // Base64 inline data URLs and external URLs remain untouched
    if (filePath.startsWith('data:') || (filePath.startsWith('http') && !filePath.includes('/uploads/'))) {
        return filePath;
    }
    // Extract pure filename: handles "/uploads/xyz.png", "uploads/xyz.png", or "https://api.redrivo.in/uploads/xyz.png"
    let filename = filePath;
    if (filename.includes('/uploads/')) {
        filename = filename.split('/uploads/')[1].split('?')[0];
    } else {
        filename = filename.replace(/^(\/)?uploads\//, '').split('?')[0];
    }
    filename = path.basename(filename);
    if (!filename) return filePath;

    const exp = Math.floor(Date.now() / 1000) + expirySeconds;
    const stringToSign = `${filename}:${exp}`;
    const sig = crypto.createHmac('sha256', FILE_SIGNING_SECRET).update(stringToSign).digest('hex');

    const baseUrl = process.env.PUBLIC_API_URL || process.env.BASE_URL || 'https://api.redrivo.in';
    return `${baseUrl}/uploads/${encodeURIComponent(filename)}?exp=${exp}&sig=${sig}`;
}

function signUserKycUrls(user) {
    if (!user || typeof user !== 'object') return user;
    const signed = { ...user };
    const kycFields = [
        'panurl', 'panUrl', 'panbackurl', 'panBackUrl',
        'aadhaarurl', 'aadhaarUrl', 'aadhaarbackurl', 'aadhaarBackUrl',
        'dlurl', 'dlUrl', 'dlbackurl', 'dlBackUrl',
        'facephotourl', 'facePhotoUrl',
        'profilepictureurl', 'profilePictureUrl',
        'photo'
    ];
    for (const field of kycFields) {
        if (signed[field]) {
            signed[field] = generateSignedUploadUrl(signed[field]);
        }
    }
    return signed;
}
const BCRYPT_ROUNDS = 12;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
if (!GOOGLE_MAPS_API_KEY && process.env.NODE_ENV === 'production') {
    throw new Error('FATAL: GOOGLE_MAPS_API_KEY environment variable is missing.');
}


// --- GLOBAL UNIQUE ENTITY VALIDATION ---
async function checkUniqueEntity(phone, options = {}) {
    if (!phone) return false;
    const cleanPhone = phone.replace('+91', '').trim();
    const prefixedPhone = phone.startsWith('+91') ? phone : '+91' + phone.trim();
    
    let checks = [
        pool.query("SELECT id, role FROM users WHERE phone IN ($1, $2)", [cleanPhone, prefixedPhone]),
        pool.query("SELECT id, role FROM garage_workers WHERE phone IN ($1, $2)", [cleanPhone, prefixedPhone]),
        pool.query("SELECT id, 'customer' as role FROM customers WHERE phone IN ($1, $2)", [cleanPhone, prefixedPhone]),
        pool.query("SELECT id, 'garage' as role FROM garages WHERE contact IN ($1, $2)", [cleanPhone, prefixedPhone])
    ];

    if (options.aadhaar) {
        const cleanAadhaar = options.aadhaar.replace(/\D/g, '');
        checks.push(pool.query("SELECT id, role FROM users WHERE aadhaarnumber = $1", [cleanAadhaar]));
        checks.push(pool.query("SELECT id, role FROM garage_workers WHERE aadhaarnumber = $1", [cleanAadhaar]));
    }
    if (options.pan) {
        const cleanPan = options.pan.trim().toUpperCase();
        checks.push(pool.query("SELECT id, role FROM users WHERE pannumber = $1", [cleanPan]));
        checks.push(pool.query("SELECT id, role FROM garage_workers WHERE pannumber = $1", [cleanPan]));
    }
    if (options.dl) {
        const cleanDl = options.dl.replace(/[^A-Z0-9]/g, '').toUpperCase();
        checks.push(pool.query("SELECT id, role FROM users WHERE dlnumber = $1", [cleanDl]));
        checks.push(pool.query("SELECT id, role FROM garage_workers WHERE dlnumber = $1", [cleanDl]));
    }

    const results = await Promise.all(checks);
    for (let r of results) {
        if (r.rows && r.rows.length > 0) {
            return r.rows[0]; // returns {id, role}
        }
    }
    return null;
}

// --- DOMAIN-BASED ROUTING HELPERS ---
function getNormalizedHost(req) {
    let rawHost = '';
    if (req.headers['x-forwarded-host']) {
        rawHost = req.headers['x-forwarded-host'].split(',')[0].trim();
    } else if (req.headers.host) {
        rawHost = req.headers.host;
    } else if (req.hostname) {
        rawHost = req.hostname;
    }
    return rawHost.split(':')[0].toLowerCase().trim();
}

function isCustomerDomain(req) {
    const host = getNormalizedHost(req);
    return host === 'redrivo.com' || host === 'www.redrivo.com' ||
           host === 'redrivo.in' || host === 'www.redrivo.in';
}

function isGarageDomain(req) {
    const host = getNormalizedHost(req);
    return host === 'garages.redrivo.com' || host === 'www.garages.redrivo.com' ||
           host === 'garage.redrivo.com' || host === 'www.garage.redrivo.com' ||
           host === 'garages.redrivo.in' || host === 'www.garages.redrivo.in' ||
           host === 'garage.redrivo.in' || host === 'www.garage.redrivo.in';
}

function isDriverDomain(req) {
    const host = getNormalizedHost(req);
    return host === 'drivers.redrivo.com' || host === 'www.drivers.redrivo.com' ||
           host === 'driver.redrivo.com' || host === 'www.driver.redrivo.com' ||
           host === 'drivers.redrivo.in' || host === 'www.drivers.redrivo.in' ||
           host === 'driver.redrivo.in' || host === 'www.driver.redrivo.in';
}

// --- ANTI-CRAWLING & SEARCH ENGINE EXCLUSION ---
// Apply noindex headers on non-customer domains (drivers, garages, and api); leave customer domains (redrivo.com / redrivo.in) indexable
app.use((req, res, next) => {
    if (!isCustomerDomain(req)) {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    }
    next();
});

app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    if (isCustomerDomain(req)) {
        res.send('User-agent: *\nAllow: /\n');
    } else if (isGarageDomain(req) || isDriverDomain(req)) {
        res.send('User-agent: *\nDisallow: /\n');
    } else {
        // Temporarily allow crawling so search engines can read the 'X-Robots-Tag: noindex' header and purge api.redrivo.in from the search index
        res.send('User-agent: *\nAllow: /\n');
    }
});

// Google Search Console verification for api.redrivo.in
app.get('/googleb3142194a3b63def.html', (req, res) => {
    res.type('text/html');
    res.send('google-site-verification: googleb3142194a3b63def.html');
});

// --- SECURITY MIDDLEWARE ---
app.use(helmet({
    contentSecurityPolicy: false // disabled to allow inline scripts in existing HTML
}));

const allowedOrigins = [
    'https://redrivo.com',
    'https://www.redrivo.com',
    'https://drivers.redrivo.com',
    'https://www.drivers.redrivo.com',
    'https://garages.redrivo.com',
    'https://www.garages.redrivo.com',
    'https://garage.redrivo.com',
    'https://redrivo.in',
    'https://www.redrivo.in',
    'https://drivers.redrivo.in',
    'https://www.drivers.redrivo.in',
    'https://garages.redrivo.in',
    'https://www.garages.redrivo.in',
    'https://garage.redrivo.in',
    'https://www.garage.redrivo.in',
    'https://api.redrivo.in',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
    origin: (origin, cb) => {
        // Allow requests with no origin (mobile apps, curl, Postman) or string 'null' (file:// URL)
        if (!origin || origin === 'null') return cb(null, true);
        
        // Allow any localhost / 127.0.0.1 / capacitor origins (supporting http/https protocols)
        if (origin.includes('localhost') || origin.includes('127.0.0.1') || origin.startsWith('capacitor://')) {
            return cb(null, true);
        }

        // Strict domain boundary validation for redrivo.com and redrivo.in
        if (
            origin === 'https://redrivo.com' ||
            origin.endsWith('.redrivo.com') ||
            origin === 'https://redrivo.in' ||
            origin.endsWith('.redrivo.in') ||
            allowedOrigins.includes(origin)
        ) {
            return cb(null, true);
        }

        // If FRONTEND_URL is not set, allow in development; otherwise enforce whitelist
        if (!process.env.FRONTEND_URL) return cb(null, true);
        
        cb(new Error('CORS: Origin not allowed'));
    },
    credentials: true
}));

app.use(express.json({
    limit: '10mb',
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' }
});

const otpLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 100,
    message: { error: 'Too many OTP requests. Please wait 10 minutes.' }
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many login attempts. Please try again later.' }
});

const verifyOtpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // Max 10 attempts
    message: { error: 'Too many OTP validation attempts. Please try again after 15 minutes.' }
});

const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 30,
    message: { error: 'Upload limit reached. Try again in 1 hour.' }
});

app.use('/api', globalLimiter);

// --- JWT HELPERS ---
function signToken(payload, tokenVersion = 1) {
    return jwt.sign({ ...payload, tokenVersion: tokenVersion || 1 }, JWT_SECRET, { expiresIn: '24h' });
}

async function revokeUserSessions(userId) {
    if (!userId) return;
    await pool.query('UPDATE users SET token_version = COALESCE(token_version, 1) + 1 WHERE id = $1', [userId]).catch(() => {});
    await pool.query('UPDATE garage_workers SET token_version = COALESCE(token_version, 1) + 1 WHERE id = $1', [userId]).catch(() => {});
}

async function authMiddleware(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authorization token required' });
    }
    try {
        const token = header.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Investor Token Live Status Check
        if (decoded.role === 'investor') {
            const invResult = await pool.query("SELECT id, email, status FROM investor_access_requests WHERE id = $1 AND status = 'approved'", [decoded.id]);
            const liveInv = invResult.rows[0];
            if (!liveInv) {
                return res.status(401).json({ error: 'Investor access expired or revoked' });
            }
            req.user = {
                ...decoded,
                role: 'investor'
            };
            return next();
        }

        // Live revocation and status verification
        const result = await pool.query('SELECT token_version, status, role, garageid FROM users WHERE id = $1', [decoded.id]);
        const liveUser = result.rows[0];

        if (!liveUser) {
            return res.status(401).json({ error: 'User account no longer exists' });
        }
        if (liveUser.status === 'suspended' || liveUser.status === 'banned' || liveUser.status === 'inactive') {
            return res.status(403).json({ error: 'Account is suspended or inactive' });
        }
        if (decoded.tokenVersion !== undefined && liveUser.token_version !== undefined) {
            if (decoded.tokenVersion !== liveUser.token_version) {
                return res.status(401).json({ error: 'Session expired or revoked. Please log in again.' });
            }
        }

        req.user = {
            ...decoded,
            role: liveUser.role || decoded.role,
            garageId: liveUser.garageid || decoded.garageId
        };
        next();
    } catch {
        res.status(401).json({ error: 'Token expired or invalid' });
    }
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Access forbidden for your role' });
        }
        next();
    };
}

const transporter = {
    sendMail: async ({ from, to, subject, text, html }) => {
        const apiKey = process.env.RESEND_API_KEY ? process.env.RESEND_API_KEY.trim() : '';
        const recipients = Array.isArray(to) ? to : [to];
        const sender = from || process.env.RESEND_FROM_EMAIL || '"ReDrivo" <support@redrivo.in>';

        if (!apiKey) {
            console.warn('[EMAIL] RESEND_API_KEY is not configured in environment. Email dispatch skipped.');
            return { messageId: 'mock-no-key', response: 'Skipped - no RESEND_API_KEY configured' };
        }

        console.log(`[EMAIL] Dispatching email via Resend HTTPS API to: ${recipients.join(', ')}`);
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: sender,
                to: recipients,
                subject: subject,
                text: text,
                html: html
            })
        });

        const data = await res.json().catch(() => null);
        if (!res.ok) {
            const errMsg = data?.message || (data?.name ? `${data.name}: ${data.message}` : `Resend HTTP error ${res.status}`);
            console.error('[EMAIL] Resend API error:', errMsg, 'Data:', JSON.stringify(data));
            throw new Error(errMsg);
        }

        console.log(`[EMAIL] ✓ Successfully sent email via Resend to: ${recipients.join(', ')} | ID: ${data?.id}`);
        return { messageId: data?.id, response: JSON.stringify(data) };
    }
};

function generateOtpEmailHtml(otp, title = 'Your ReDrivo Verification Code', subtitle = 'Use the one-time verification code below to authenticate your ReDrivo account.') {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0B0F19; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #F8FAFC;">
  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="table-layout: fixed;">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 480px; background-color: #151D2E; border: 1px solid #1E293B; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4);">
          <tr>
            <td align="center" style="padding: 32px 24px 20px 24px; border-bottom: 1px solid #1E293B;">
              <img src="https://api.redrivo.in/customer/assets/redrivo_logo_transparent_dark_bg.png" alt="ReDrivo" width="72" style="display: block; width: 72px; max-width: 72px; height: auto; border: 0; outline: none; margin: 0 auto 8px auto;" />
              <div style="font-size: 11px; font-weight: 600; color: #94A3B8; letter-spacing: 1.5px; text-transform: uppercase;">
                Security Verification
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding: 32px 28px 24px 28px; text-align: center;">
              <h1 style="margin: 0 0 12px 0; font-size: 20px; font-weight: 700; color: #FFFFFF;">
                ${title}
              </h1>
              <p style="margin: 0 0 28px 0; font-size: 14px; line-height: 22px; color: #94A3B8;">
                ${subtitle}
              </p>
              <div style="background-color: #0B0F19; border: 2px dashed #FACC15; border-radius: 12px; padding: 18px 24px; margin: 0 auto 24px auto; display: inline-block;">
                <span style="font-family: 'Courier New', Courier, monospace; font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #FACC15; padding-left: 8px; display: block;">
                  ${otp}
                </span>
              </div>
              <div style="background-color: rgba(250, 204, 21, 0.08); border-radius: 8px; padding: 12px 16px; margin-bottom: 24px;">
                <p style="margin: 0; font-size: 13px; font-weight: 500; color: #FDE047;">
                  ⏳ Valid for <strong>10 minutes</strong>. Do not share this code with anyone.
                </p>
              </div>
              <p style="margin: 0; font-size: 12px; line-height: 18px; color: #64748B;">
                If you did not request this verification code, please disregard this email or contact support.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 24px; background-color: #0E1422; border-top: 1px solid #1E293B; text-align: center;">
              <p style="margin: 0; font-size: 11px; color: #64748B;">
                &copy; ${new Date().getFullYear()} ReDrivo Logistics &amp; Mobility. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

const isSsl = process.env.DATABASE_URL && (process.env.DATABASE_URL.includes('sslmode=require') || process.env.DATABASE_URL.includes('neon.tech'));
const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: isSsl ? { rejectUnauthorized: false } : false,
    keepAlive: true
});

pool.on('error', (err, client) => {
    console.error('Unexpected error on idle client', err);
});

// Ensure is_test and is_test_account columns exist in PostgreSQL
pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_test_account BOOLEAN DEFAULT FALSE;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_test_account BOOLEAN DEFAULT FALSE;
    ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS is_test BOOLEAN DEFAULT FALSE;
`).catch(e => console.warn('Schema check warning:', e.message));

const db = {
    convertQuery: (sql) => {
        let i = 1;
        // Matches single-quoted strings (handling '' and \' escapes) OR question marks
        return sql.replace(/'(?:''|\\'|[^'])*'|\?/g, (match) => {
            if (match === '?') {
                return '$' + (i++);
            }
            return match; // Return string literal unchanged
        });
    },
    run: (sql, params, cb) => {
        if (typeof params === 'function') { cb = params; params = []; }
        pool.query(db.convertQuery(sql), params || [])
            .then(res => cb && cb(null))
            .catch(err => {
                if (err.code === '42701' || err.code === '42P07') return cb && cb(null);
                console.error('DB Run Error:', err.message, '\nSQL:', sql, '\nParams:', params);
                cb && cb(err);
            });
    },
    get: (sql, params, cb) => {
        if (typeof params === 'function') { cb = params; params = []; }
        pool.query(db.convertQuery(sql), params || [])
            .then(res => cb && cb(null, res.rows[0]))
            .catch(err => {
                console.error('DB Get Error:', err.message, '\nSQL:', sql, '\nParams:', params);
                cb && cb(err);
            });
    },
    all: (sql, params, cb) => {
        if (typeof params === 'function') { cb = params; params = []; }
        pool.query(db.convertQuery(sql), params || [])
            .then(res => cb && cb(null, res.rows))
            .catch(err => {
                console.error('DB All Error:', err.message, '\nSQL:', sql, '\nParams:', params);
                cb && cb(err);
            });
    },
    serialize: (cb) => { cb(); },
    prepare: (sql) => {
        return {
            run: (params) => {
                pool.query(db.convertQuery(sql), params || []).catch(console.error);
            },
            finalize: () => {}
        };
    }
};

pool.connect((err, client, release) => {
    if (err) return console.error('Error acquiring client', err.stack);
    const dbTarget = process.env.DATABASE_URL ? (process.env.DATABASE_URL.split('@')[1] || 'local') : 'local';
    console.log(`Connected to PostgreSQL database (${dbTarget}).`);
    release();
    initializeDatabase();
});


function initializeDatabase() {
    db.serialize(() => {
        // Customers Table
        db.run(`CREATE TABLE IF NOT EXISTS customers (
            id TEXT PRIMARY KEY, name TEXT, phone TEXT, email TEXT, status TEXT DEFAULT 'active'
        )`);

        // Vehicles Table
        db.run(`CREATE TABLE IF NOT EXISTS vehicles (
            id TEXT PRIMARY KEY, customerId TEXT, plate TEXT, makeModel TEXT, color TEXT, vin TEXT,
            FOREIGN KEY(customerId) REFERENCES customers(id)
        )`);

        // Users Table (Central Auth)
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY, name TEXT, role TEXT, email TEXT, phone TEXT, password TEXT, garageId TEXT,
            status TEXT DEFAULT 'active', emailVerified INTEGER DEFAULT 0, phoneVerified INTEGER DEFAULT 0,
            panNumber TEXT, aadhaarNumber TEXT, panVerified INTEGER DEFAULT 0, aadhaarVerified INTEGER DEFAULT 0,
            dlNumber TEXT, dlVerified INTEGER DEFAULT 0,
            bankAccountName TEXT, bankAccountNumber TEXT, bankIFSC TEXT, bankVerified INTEGER DEFAULT 0,
            countryCode TEXT DEFAULT '+91', altPhone TEXT, altPhoneVerified INTEGER DEFAULT 0, lat REAL, lng REAL,
            panUrl TEXT, aadhaarUrl TEXT, facePhotoUrl TEXT, kycStatus TEXT DEFAULT 'pending_submission',
            is_online INTEGER DEFAULT 0, pincode TEXT, is_payment_on_hold INTEGER DEFAULT 0, dlUrl TEXT, profilePictureUrl TEXT, panBackUrl TEXT, aadhaarBackUrl TEXT, dlBackUrl TEXT,
            bankName TEXT, kycRejectionReason TEXT
        )`);

        // Migration: Ensure new columns exist for existing databases
        [
            "ALTER TABLE users ADD COLUMN dlNumber TEXT",
            "ALTER TABLE users ADD COLUMN dlVerified INTEGER DEFAULT 0",
            "ALTER TABLE users ADD COLUMN bankAccountName TEXT",
            "ALTER TABLE users ADD COLUMN bankAccountNumber TEXT",
            "ALTER TABLE users ADD COLUMN bankIFSC TEXT",
            "ALTER TABLE users ADD COLUMN bankVerified INTEGER DEFAULT 0",
            "ALTER TABLE users ADD COLUMN panUrl TEXT",
            "ALTER TABLE users ADD COLUMN aadhaarUrl TEXT",
            "ALTER TABLE users ADD COLUMN facePhotoUrl TEXT",
            "ALTER TABLE users ADD COLUMN kycStatus TEXT DEFAULT 'pending_submission'",
            "ALTER TABLE users ADD COLUMN is_online INTEGER DEFAULT 0",
            "ALTER TABLE users ADD COLUMN address TEXT",
            "ALTER TABLE users ADD COLUMN city TEXT",
            "ALTER TABLE users ADD COLUMN state TEXT",
            "ALTER TABLE users ADD COLUMN pincode TEXT",
            "ALTER TABLE users ADD COLUMN is_payment_on_hold INTEGER DEFAULT 0",
            "ALTER TABLE users ADD COLUMN rating REAL DEFAULT 5.0",
            "ALTER TABLE trips ADD COLUMN rating REAL",
            "ALTER TABLE garage_workers ADD COLUMN rating REAL DEFAULT 5.0",
            "ALTER TABLE garage_workers ADD COLUMN address TEXT",
            "ALTER TABLE garage_workers ADD COLUMN city TEXT",
            "ALTER TABLE garage_workers ADD COLUMN state TEXT",
            "ALTER TABLE users ADD COLUMN dlUrl TEXT",
            "ALTER TABLE garage_workers ADD COLUMN dlUrl TEXT",
            "ALTER TABLE users ADD COLUMN profilePictureUrl TEXT",
            "ALTER TABLE garage_workers ADD COLUMN profilePictureUrl TEXT",
            "ALTER TABLE users ADD COLUMN panBackUrl TEXT",
            "ALTER TABLE users ADD COLUMN aadhaarBackUrl TEXT",
            "ALTER TABLE users ADD COLUMN dlBackUrl TEXT",
            "ALTER TABLE garage_workers ADD COLUMN panBackUrl TEXT",
            "ALTER TABLE garage_workers ADD COLUMN aadhaarBackUrl TEXT",
            "ALTER TABLE garage_workers ADD COLUMN dlBackUrl TEXT",
            "ALTER TABLE users ADD COLUMN bankName TEXT",
            "ALTER TABLE garage_workers ADD COLUMN bankName TEXT",
            "ALTER TABLE garage_workers ADD COLUMN dlNumber TEXT",
            "ALTER TABLE garage_workers ADD COLUMN dlVerified INTEGER DEFAULT 0",
            "ALTER TABLE garage_workers ADD COLUMN bankAccountName TEXT",
            "ALTER TABLE garage_workers ADD COLUMN bankAccountNumber TEXT",
            "ALTER TABLE garage_workers ADD COLUMN bankIFSC TEXT",
            "ALTER TABLE garage_workers ADD COLUMN bankVerified INTEGER DEFAULT 0",
            "ALTER TABLE users ADD COLUMN kycRejectionReason TEXT",
            "ALTER TABLE garage_workers ADD COLUMN kycRejectionReason TEXT",
            "ALTER TABLE users ADD COLUMN dob TEXT",
            "ALTER TABLE users ADD COLUMN gender TEXT",
            "ALTER TABLE garage_workers ADD COLUMN dob TEXT",
            "ALTER TABLE garage_workers ADD COLUMN gender TEXT",
            "ALTER TABLE users ADD COLUMN payout_model TEXT DEFAULT 'commission'",
            "ALTER TABLE users ADD COLUMN subscription_cycle TEXT",
            "ALTER TABLE users ADD COLUMN subscription_valid_until TEXT",
            "ALTER TABLE users ADD COLUMN pending_payout_model TEXT",
            "ALTER TABLE users ADD COLUMN pending_subscription_cycle TEXT",
            "ALTER TABLE users ADD COLUMN pending_effective_date TEXT",
            "ALTER TABLE users ADD COLUMN payout_model_last_switched_at TEXT"
        ].forEach(sql => db.run(sql, (err) => {}));

        // Garages Table
        db.run(`CREATE TABLE IF NOT EXISTS garages (
            id TEXT PRIMARY KEY, name TEXT, address TEXT, contact TEXT, email TEXT, password TEXT,
            status TEXT DEFAULT 'active', photo TEXT, owner TEXT, joinedDate TEXT, lat REAL, lng REAL,
            businessType TEXT, gstNumber TEXT, bankAccountName TEXT, bankAccountNumber TEXT, bankIFSC TEXT, bankName TEXT,
            accountType TEXT, govIdNumber TEXT, bankVerified INTEGER DEFAULT 0, serviceType TEXT DEFAULT 'Both', rating REAL DEFAULT 0.0, emailVerified INTEGER DEFAULT 0,
            panNumber TEXT, panVerified INTEGER DEFAULT 0, aadhaarNumber TEXT, aadhaarVerified INTEGER DEFAULT 0,
            altPhone TEXT, altPhoneVerified INTEGER DEFAULT 0, workerCount INTEGER DEFAULT 0, govIdType TEXT DEFAULT 'PAN Card',
            ownerCount INTEGER DEFAULT 1
        )`);
        db.run("ALTER TABLE garages ADD COLUMN govIdType TEXT DEFAULT 'PAN Card'", () => {});
        db.run("ALTER TABLE garages ADD COLUMN ownerCount INTEGER DEFAULT 1", () => {});

        // Workers Table (Mirror of users for garage context)
        db.run(`CREATE TABLE IF NOT EXISTS garage_workers (
            id TEXT PRIMARY KEY, garageId TEXT, name TEXT, phone TEXT, role TEXT, status TEXT DEFAULT 'available',
            panNumber TEXT, aadhaarNumber TEXT, panUrl TEXT, aadhaarUrl TEXT, facePhotoUrl TEXT,
            kycStatus TEXT DEFAULT 'pending_submission', is_online INTEGER DEFAULT 0, pincode TEXT, is_payment_on_hold INTEGER DEFAULT 0,
            address TEXT, city TEXT, state TEXT, rating REAL DEFAULT 5.0, dlUrl TEXT, profilePictureUrl TEXT,
            panBackUrl TEXT, aadhaarBackUrl TEXT, dlBackUrl TEXT, bankName TEXT,
            dlNumber TEXT, dlVerified INTEGER DEFAULT 0,
            bankAccountName TEXT, bankAccountNumber TEXT, bankIFSC TEXT, bankVerified INTEGER DEFAULT 0,
            kycRejectionReason TEXT,
            FOREIGN KEY(garageId) REFERENCES garages(id)
        )`);
        [
            "ALTER TABLE garage_workers ADD COLUMN is_online INTEGER DEFAULT 0",
            "ALTER TABLE garage_workers ADD COLUMN pincode TEXT",
            "ALTER TABLE garage_workers ADD COLUMN is_payment_on_hold INTEGER DEFAULT 0"
        ].forEach(sql => db.run(sql, (err) => {}));

        // Garage Rates (High Detail)
        db.run(`CREATE TABLE IF NOT EXISTS garage_rates (
            id SERIAL PRIMARY KEY, garageId TEXT, vehicleType TEXT, itemCategory TEXT, item TEXT,
            logicType TEXT, price REAL, warrantyDays INTEGER DEFAULT 0, warrantyKM INTEGER DEFAULT 0,
            UNIQUE(garageId, vehicleType, itemCategory, item, logicType),
            FOREIGN KEY(garageId) REFERENCES garages(id)
        )`);
        db.run("ALTER TABLE garage_rates ADD COLUMN warrantyDays INTEGER DEFAULT 0", () => {});
        db.run("ALTER TABLE garage_rates ADD COLUMN warrantyKM INTEGER DEFAULT 0", () => {});

        // Service Requests (Expanded for Worker Flow)
        db.run(`CREATE TABLE IF NOT EXISTS service_requests (
            id TEXT PRIMARY KEY, customerId TEXT, vehicleId TEXT, garageId TEXT, date TEXT, status TEXT,
            totalCustomerPrice REAL DEFAULT 0, workerId TEXT, auditStatus TEXT DEFAULT 'pending',
            service_category TEXT DEFAULT 'Standard Service', inspection_fee REAL DEFAULT 299,
            parts_cost REAL DEFAULT 0, labor_cost REAL DEFAULT 0, marshal_commission REAL DEFAULT 0,
            lat REAL, lng REAL, pickup_address TEXT, drop_address TEXT, issue TEXT, created_at BIGINT,
            booking_flow TEXT, pickup_drop_type TEXT, route_stops TEXT,
            FOREIGN KEY(workerId) REFERENCES users(id)
        )`);
        db.run("ALTER TABLE service_requests ADD COLUMN workerId TEXT", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN auditStatus TEXT DEFAULT 'pending'", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN service_category TEXT DEFAULT 'Standard Service'", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN inspection_fee REAL DEFAULT 299", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN parts_cost REAL DEFAULT 0", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN labor_cost REAL DEFAULT 0", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN marshal_commission REAL DEFAULT 0", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN lat REAL", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN lng REAL", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN pickup_address TEXT", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN drop_address TEXT", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN issue TEXT", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN service_type TEXT", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN created_at BIGINT", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN booking_flow TEXT", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN pickup_drop_type TEXT", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN route_stops TEXT", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN vehicle_type TEXT DEFAULT 'car'", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN estimated_hours REAL DEFAULT 1.0", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN unextended_overtime_cost REAL DEFAULT 0", () => {});

        // Trips Table (Marshal Operations)
        db.run(`CREATE TABLE IF NOT EXISTS trips (
            id TEXT PRIMARY KEY,
            serviceRequestId TEXT NOT NULL,
            marshalId TEXT,
            status TEXT,
            startOdometer INTEGER,
            otp1 TEXT,
            garageOtp TEXT,
            deliveryOtp TEXT,
            deliveryMarshalId TEXT,
            garageDropOdometer INTEGER,
            endOdometer INTEGER,
            pickupLat REAL,
            pickupLng REAL,
            marshalLat REAL,
            marshalLng REAL,
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(serviceRequestId) REFERENCES service_requests(id),
            FOREIGN KEY(marshalId) REFERENCES users(id)
        )`);
        db.run("ALTER TABLE trips ADD COLUMN endOdometer INTEGER", () => {});
        db.run("ALTER TABLE trips ADD COLUMN marshalLat REAL", () => {});
        db.run("ALTER TABLE trips ADD COLUMN marshalLng REAL", () => {});
        db.run("ALTER TABLE trips ADD COLUMN garageDropoffOtp TEXT", () => {});
        db.run("ALTER TABLE trips ADD COLUMN garagePickupOtp TEXT", () => {});

        // Vehicles table migrations
        db.run("ALTER TABLE vehicles ADD COLUMN make TEXT", () => {});
        db.run("ALTER TABLE vehicles ADD COLUMN model TEXT", () => {});
        db.run("ALTER TABLE vehicles ADD COLUMN type TEXT", () => {});
        db.run("ALTER TABLE vehicles ADD COLUMN photo TEXT", () => {});
        db.run("ALTER TABLE vehicles ADD COLUMN fuel TEXT", () => {});
        db.run("ALTER TABLE vehicles ADD COLUMN transmission TEXT", () => {});

        // Global Settings
        db.run(`CREATE TABLE IF NOT EXISTS system_settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )`, () => {
            db.run(`INSERT INTO system_settings (key, value) VALUES ('marshal_commission_percentage', '2.0') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('customer_rate_per_km', '15.0') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('marshal_rating_threshold', '4.5') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('commission_high_tier', '80.0') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('commission_low_tier', '65.0') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('bonus_5_star_percentage', '5.0') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('max_pickup_distance_km', '10.0') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('car_platform_base_charge', '99.0') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('bike_platform_base_charge', '49.0') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('car_base_fare', '150.0') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('bike_base_fare', '50.0') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('car_customer_rate_per_km', '30.0') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('bike_customer_rate_per_km', '8.0') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('car_halt_rate_per_min', '5.0') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('bike_halt_rate_per_min', '3.0') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('car_hourly_rate', '150.0') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('bike_hourly_rate', '80.0') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('car_max_pickup_distance_km', '10.0') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('bike_max_pickup_distance_km', '5.0') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('car_five_star_bonus', '50.0') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('bike_five_star_bonus', '30.0') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('car_payout_days', '3') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('bike_payout_days', '3') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('customer_free_cancel_window_seconds', '180') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('customer_cancellation_fee', '50.0') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('driver_noshow_timeout_minutes', '60') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('driver_noshow_penalty', '49.0') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('customer_noshow_wait_minutes', '10') ON CONFLICT(key) DO NOTHING`);
            db.run(`INSERT INTO system_settings (key, value) VALUES ('customer_noshow_penalty', '99.0') ON CONFLICT(key) DO NOTHING`);
        });

        // Async PostgreSQL migrations for cancellation & arrival tracking
        pool.query(`
            ALTER TABLE trips ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMP;
            ALTER TABLE trips ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMP;
            ALTER TABLE trips ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
            ALTER TABLE trips ADD COLUMN IF NOT EXISTS cancellation_tier TEXT;
            ALTER TABLE trips ADD COLUMN IF NOT EXISTS cancellation_fee REAL DEFAULT 0;
            ALTER TABLE trips ADD COLUMN IF NOT EXISTS refund_amount REAL DEFAULT 0;
            ALTER TABLE trips ADD COLUMN IF NOT EXISTS penalty_amount REAL DEFAULT 0;
            ALTER TABLE trips ADD COLUMN IF NOT EXISTS pickup_eta_minutes REAL DEFAULT 15;
            ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMP;
            ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMP;
            ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS cancellation_tier TEXT;
        `).catch(e => console.warn("Postgres cancellation migration notice:", e.message));

        // Disputes Table
        db.run(`CREATE TABLE IF NOT EXISTS disputes (
            id TEXT PRIMARY KEY,
            tripId TEXT,
            customerId TEXT,
            marshalId TEXT,
            reason TEXT,
            status TEXT DEFAULT 'pending', -- pending, dismissed, penalized
            deductionAmount REAL DEFAULT 0,
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // Incentives Table
        db.run(`CREATE TABLE IF NOT EXISTS incentives (
            id TEXT PRIMARY KEY,
            userId TEXT,
            tripId TEXT,
            amount REAL,
            type TEXT,
            status TEXT DEFAULT 'pending',
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // Dual-Core Progress & Evidence
        db.run(`CREATE TABLE IF NOT EXISTS service_progress (
            id SERIAL PRIMARY KEY,
            order_id TEXT REFERENCES service_requests(id),
            category TEXT,
            has_before_video BOOLEAN DEFAULT false,
            has_after_video BOOLEAN DEFAULT false,
            part_brand_verified BOOLEAN DEFAULT false,
            last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS repair_evidence (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            service_id INTEGER REFERENCES service_progress(id),
            evidence_type TEXT,
            media_url TEXT NOT NULL,
            part_name TEXT,
            brand_detected TEXT,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )`);

        // Audit Items (The USP Job Card)
        db.run(`CREATE TABLE IF NOT EXISTS audit_items (
            id SERIAL PRIMARY KEY, serviceRequestId TEXT, item TEXT, category TEXT,
            logic TEXT, rate REAL, labor REAL, mediaId TEXT,
            FOREIGN KEY(serviceRequestId) REFERENCES service_requests(id)
        )`);

        // Media / Documents
        db.run(`CREATE TABLE IF NOT EXISTS media (
            id TEXT PRIMARY KEY, type TEXT, referenceId TEXT, filePath TEXT, fileName TEXT, docType TEXT,
            status TEXT DEFAULT 'pending', uploadedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_media_ref_doctype ON media(referenceId, docType)", () => {});

        // OTP Verification
        db.run(`CREATE TABLE IF NOT EXISTS otp_verifications (
            id SERIAL PRIMARY KEY, entityid TEXT, entitytype TEXT, phone TEXT, email TEXT,
            otp TEXT NOT NULL, createdat TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expiresat TIMESTAMP, verifiedat TIMESTAMP
        )`);

        // Garage Owners (Support for up to 10)
        db.run(`CREATE TABLE IF NOT EXISTS garage_owners (
            id TEXT PRIMARY KEY,
            garageId TEXT REFERENCES garages(id),
            name TEXT,
            phone TEXT,
            altPhone TEXT,
            email TEXT,
            aadhaar TEXT,
            pan TEXT,
            phoneVerified INTEGER DEFAULT 0,
            altPhoneVerified INTEGER DEFAULT 0,
            emailVerified INTEGER DEFAULT 0,
            aadhaarVerified INTEGER DEFAULT 0,
            aadhaarPath TEXT,
            panVerified INTEGER DEFAULT 0,
            panPath TEXT,
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run("ALTER TABLE otp_verifications ADD COLUMN email TEXT", () => {});

        // New garage profile columns (will fail silently if already exist)
        ['serviceType TEXT', 'altPhone TEXT', 'altPhoneVerified INTEGER DEFAULT 0',
         'phoneVerified INTEGER DEFAULT 0', 'emailVerified INTEGER DEFAULT 0',
         'lat REAL', 'lng REAL', 'accountType TEXT', 'govIdNumber TEXT', 'ownerCount INTEGER DEFAULT 1',
         'serviceCenterType TEXT DEFAULT \'local\'', 'authorizedCarBrands TEXT DEFAULT \'\'', 'authorizedBikeBrands TEXT DEFAULT \'\'']
        .forEach(col => db.run(`ALTER TABLE garages ADD COLUMN ${col}`, () => {}));

        ['aadhaarPath TEXT', 'panPath TEXT'].forEach(col => db.run(`ALTER TABLE garage_owners ADD COLUMN ${col}`, () => {}));

        // Master SKUs (Platform-Wide)
        db.run(`CREATE TABLE IF NOT EXISTS master_skus (
            id TEXT PRIMARY KEY, vehicleType TEXT, category TEXT, subcategory TEXT,
            itemName TEXT, partType TEXT, compatibleBrands TEXT, sparePartBrand TEXT,
            oemType TEXT, unit TEXT, basePrice REAL, vroomerPrice REAL DEFAULT 0,
            warrantyMonths INTEGER DEFAULT 0, serviceTimeMin INTEGER DEFAULT 0,
            supplierType TEXT, remarks TEXT
        )`);
        db.run("ALTER TABLE master_skus ADD COLUMN vroomerPrice REAL DEFAULT 0", () => {});

        // Garage SKUs (Shop-Specific Overrides)
        db.run(`CREATE TABLE IF NOT EXISTS garage_skus (
            garageId TEXT, skuId TEXT, gearxPrice REAL, garagePrice REAL, stock INTEGER DEFAULT 0,
            status TEXT DEFAULT 'active', lastUpdated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(garageId, skuId),
            FOREIGN KEY(garageId) REFERENCES garages(id),
            FOREIGN KEY(skuId) REFERENCES master_skus(id)
        )`);

        // Migration for garage_skus
        [
            "ALTER TABLE garage_skus ADD COLUMN gearxPrice REAL",
            "ALTER TABLE garage_skus ADD COLUMN garagePrice REAL"
        ].forEach(sql => db.run(sql, (err) => {}));

        db.run(`CREATE TABLE IF NOT EXISTS serialized_parts (
            id TEXT PRIMARY KEY,
            skuId TEXT,
            serialNumber TEXT UNIQUE,
            garageId TEXT,
            status TEXT DEFAULT 'assigned',
            assignedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(skuId) REFERENCES master_skus(id),
            FOREIGN KEY(garageId) REFERENCES garages(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS garage_applications (
            id TEXT PRIMARY KEY,
            garage_name TEXT NOT NULL,
            owner_name TEXT NOT NULL,
            phone TEXT NOT NULL,
            city TEXT,
            pincode TEXT,
            service_bays TEXT,
            services_offered TEXT,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // Sessions table (JWT refresh tokens)
        db.run(`CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            userId TEXT NOT NULL,
            refreshToken TEXT UNIQUE NOT NULL,
            expiresAt TIMESTAMP NOT NULL,
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // Audit log (who did what, when)
        db.run(`CREATE TABLE IF NOT EXISTS audit_log (
            id SERIAL PRIMARY KEY,
            userId TEXT,
            action TEXT NOT NULL,
            entity TEXT,
            entityId TEXT,
            details JSONB,
            ipAddress TEXT,
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // Feature analytics events
        db.run(`CREATE TABLE IF NOT EXISTS analytics_events (
            id SERIAL PRIMARY KEY,
            app TEXT NOT NULL,
            event TEXT NOT NULL,
            userId TEXT,
            sessionId TEXT,
            properties JSONB,
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_analytics_app_event ON analytics_events(app, event)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events(createdAt)`);

        // Google Maps Daily API Usage
        db.run(`CREATE TABLE IF NOT EXISTS daily_api_usage (
            usage_date DATE PRIMARY KEY,
            request_count INTEGER DEFAULT 0
        )`);

        // Google Maps Cached Places
        db.run(`CREATE TABLE IF NOT EXISTS cached_places (
            place_id TEXT PRIMARY KEY,
            description TEXT,
            lat DOUBLE PRECISION,
            lng DOUBLE PRECISION,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // Feedback Table
        db.run(`CREATE TABLE IF NOT EXISTS feedback (
            id TEXT PRIMARY KEY,
            userId TEXT,
            userRole TEXT,
            surveyType TEXT,
            question1 TEXT,
            answer1 TEXT,
            question2 TEXT,
            answer2 TEXT,
            question3 TEXT,
            answer3 TEXT,
            question4 TEXT,
            answer4 TEXT,
            question5 TEXT,
            answer5 TEXT,
            question6 TEXT,
            answer6 TEXT,
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // Incentive Slabs Table
        db.run(`CREATE TABLE IF NOT EXISTS incentive_slabs (
            id TEXT PRIMARY KEY,
            maxDistance REAL,
            ratePerKm REAL,
            vehicle_type TEXT DEFAULT 'car'
        )`, () => {
            db.get("SELECT COUNT(*) as count FROM incentive_slabs", (err, row) => {
                if (row && Number(row.count) === 0) {
                    db.run("INSERT INTO incentive_slabs (id, maxDistance, ratePerKm, vehicle_type) VALUES ('slab_1', 5.0, 15.0, 'car')");
                    db.run("INSERT INTO incentive_slabs (id, maxDistance, ratePerKm, vehicle_type) VALUES ('slab_2', 10.0, 20.0, 'car')");
                    db.run("INSERT INTO incentive_slabs (id, maxDistance, ratePerKm, vehicle_type) VALUES ('slab_3', 999.0, 25.0, 'car')");
                }
            });
        });

        // Hourly Incentive Slabs Table (Dedicated for Hourly Rentals)
        db.run(`CREATE TABLE IF NOT EXISTS hourly_incentive_slabs (
            id TEXT PRIMARY KEY,
            maxHours REAL NOT NULL,
            ratePerHour REAL NOT NULL,
            vehicle_type TEXT DEFAULT 'car'
        )`, () => {
            db.get("SELECT COUNT(*) as count FROM hourly_incentive_slabs", (err, row) => {
                if (row && Number(row.count) === 0) {
                    db.run("INSERT INTO hourly_incentive_slabs (id, maxHours, ratePerHour, vehicle_type) VALUES ('hslab_car_1', 2.0, 90.0, 'car')");
                    db.run("INSERT INTO hourly_incentive_slabs (id, maxHours, ratePerHour, vehicle_type) VALUES ('hslab_car_2', 6.0, 80.0, 'car')");
                    db.run("INSERT INTO hourly_incentive_slabs (id, maxHours, ratePerHour, vehicle_type) VALUES ('hslab_car_3', 999.0, 70.0, 'car')");
                    db.run("INSERT INTO hourly_incentive_slabs (id, maxHours, ratePerHour, vehicle_type) VALUES ('hslab_bike_1', 2.0, 45.0, 'bike')");
                    db.run("INSERT INTO hourly_incentive_slabs (id, maxHours, ratePerHour, vehicle_type) VALUES ('hslab_bike_2', 6.0, 40.0, 'bike')");
                    db.run("INSERT INTO hourly_incentive_slabs (id, maxHours, ratePerHour, vehicle_type) VALUES ('hslab_bike_3', 999.0, 35.0, 'bike')");
                }
            });
        });

        // Seed Admin (hash password in production)
        db.get("SELECT * FROM users WHERE id = 'u_admin'", (err, row) => {
            if (!row) {
                bcrypt.hash('admin', BCRYPT_ROUNDS).then(hash => {
                    db.run("INSERT INTO users (id, name, email, phone, role, password, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        ['u_admin', 'Admin', 'admin@gearx.com', '+910000000000', 'admin', hash, 'active']);
                });
            }
        });

        // Migration: Ensure garage_workers has all required columns in PostgreSQL
        ['email TEXT', 'panNumber TEXT', 'aadhaarNumber TEXT', 'panUrl TEXT', 'aadhaarUrl TEXT', 'facePhotoUrl TEXT', 'kycStatus TEXT DEFAULT \'pending_submission\''].forEach(col => {
            db.run(`ALTER TABLE garage_workers ADD COLUMN ${col}`, () => {});
        });

        // Migration: Ensure structural unique indexes for legal & transport identity fields
        const uniqueIndexes = [
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_unique_aadhaarnumber ON users (aadhaarnumber) WHERE aadhaarnumber IS NOT NULL AND aadhaarnumber != ''`,
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_unique_pannumber ON users (pannumber) WHERE pannumber IS NOT NULL AND pannumber != ''`,
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_unique_dlnumber ON users (dlnumber) WHERE dlnumber IS NOT NULL AND dlnumber != ''`,
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_garage_workers_unique_aadhaarnumber ON garage_workers (aadhaarnumber) WHERE aadhaarnumber IS NOT NULL AND aadhaarnumber != ''`,
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_garage_workers_unique_pannumber ON garage_workers (pannumber) WHERE pannumber IS NOT NULL AND pannumber != ''`,
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_garage_workers_unique_dlnumber ON garage_workers (dlnumber) WHERE dlnumber IS NOT NULL AND dlnumber != ''`
        ];
        uniqueIndexes.forEach(sql => {
            pool.query(sql).catch(err => console.warn('[INIT_DB] Unique index migration non-fatal warning:', err.message));
        });

        // Self-healing database migration: Ensure all referenced garage IDs in users exist in the garages table
        pool.query("SELECT DISTINCT garageid FROM users WHERE garageid IS NOT NULL")
            .then(res => {
                res.rows.forEach(row => {
                    const gid = row.garageid;
                    pool.query("SELECT id FROM garages WHERE id = $1", [gid])
                        .then(gRes => {
                            if (gRes.rows.length === 0) {
                                console.log(`[Self-Healing] Inserting missing garage record for ID: ${gid}`);
                                pool.query(`INSERT INTO garages (id, name, status) VALUES ($1, 'Self-Healed Partner Garage', 'active')`, [gid])
                                    .catch(e => console.error(`[Self-Healing] Insert error for garage ${gid}:`, e.message));
                            }
                        })
                        .catch(e => console.error(`[Self-Healing] Check error for garage ${gid}:`, e.message));
                });
            })
            .catch(e => console.error("[Self-Healing] Query error:", e.message));
    });
}

// Global error handlers to keep the server alive
process.on('uncaughtException', (err) => {
    console.error('CRITICAL UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL UNHANDLED REJECTION:', reason);
});


// --- FIREBASE FCM SETUP ---
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

let fcmInitialized = false;
try {
    let serviceAccount;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        } catch (parseErr) {
            serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8'));
        }
    } else if (fs.existsSync(path.join(__dirname, 'firebaseServiceAccountKey.json'))) {
        serviceAccount = require('./firebaseServiceAccountKey.json');
    }

    if (serviceAccount) {
        initializeApp({
            credential: cert(serviceAccount)
        });
        fcmInitialized = true;
        console.log('Firebase Admin initialized.');
    } else {
        console.warn('Firebase Admin: No credentials found. FCM disabled.');
    }
} catch(e) {
    console.warn('Firebase Admin init failed (missing key json or error). FCM disabled:', e.message);
}

async function ensureKycColumns() {
    try {
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS fcmToken TEXT').catch(() => {});
        await pool.query('ALTER TABLE customers ADD COLUMN IF NOT EXISTS fcmToken TEXT').catch(() => {});
        await pool.query('ALTER TABLE customers ADD COLUMN IF NOT EXISTS fcmtoken TEXT').catch(() => {});
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS kycRejectionReason TEXT').catch(() => {});
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS kycrejectionreason TEXT').catch(() => {});
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS vehicle_types TEXT DEFAULT \'bike\'').catch(() => {});
        await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_model VARCHAR(32) DEFAULT 'commission'").catch(() => {});
        await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_cycle VARCHAR(32)").catch(() => {});
        await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_valid_until TIMESTAMPTZ").catch(() => {});
        await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_payout_model VARCHAR(32)").catch(() => {});
        await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_subscription_cycle VARCHAR(32)").catch(() => {});
        await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_effective_date DATE").catch(() => {});
        await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_model_last_switched_at TIMESTAMPTZ").catch(() => {});

        await pool.query('ALTER TABLE garage_workers ADD COLUMN IF NOT EXISTS kycRejectionReason TEXT').catch(() => {});
        await pool.query('ALTER TABLE garage_workers ADD COLUMN IF NOT EXISTS kycrejectionreason TEXT').catch(() => {});
        await pool.query('ALTER TABLE garage_workers ADD COLUMN IF NOT EXISTS vehicle_types TEXT DEFAULT \'bike\'').catch(() => {});

        await pool.query('ALTER TABLE garages ADD COLUMN IF NOT EXISTS serviceCenterType TEXT DEFAULT \'local\'').catch(() => {});
        await pool.query('ALTER TABLE garages ADD COLUMN IF NOT EXISTS authorizedCarBrands TEXT DEFAULT \'\'').catch(() => {});
        await pool.query('ALTER TABLE garages ADD COLUMN IF NOT EXISTS authorizedBikeBrands TEXT DEFAULT \'\'').catch(() => {});

        // Promo tracking columns (First 5 Rides Free Promotion)
        await pool.query(`
            ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS is_promotional_ride BOOLEAN DEFAULT FALSE;
            ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS promo_type VARCHAR(64) DEFAULT NULL;
            ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS original_customer_fare NUMERIC(10,2) DEFAULT 0;
            ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS promo_discount_amount NUMERIC(10,2) DEFAULT 0;
            ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS promo_absorbed_by VARCHAR(64) DEFAULT 'redrivo';

            ALTER TABLE trips ADD COLUMN IF NOT EXISTS is_promotional_ride BOOLEAN DEFAULT FALSE;
            ALTER TABLE trips ADD COLUMN IF NOT EXISTS promo_type VARCHAR(64) DEFAULT NULL;
            ALTER TABLE trips ADD COLUMN IF NOT EXISTS original_customer_fare NUMERIC(10,2) DEFAULT 0;
            ALTER TABLE trips ADD COLUMN IF NOT EXISTS promo_discount_amount NUMERIC(10,2) DEFAULT 0;
            ALTER TABLE trips ADD COLUMN IF NOT EXISTS promo_absorbed_by VARCHAR(64) DEFAULT 'redrivo';
        `).catch(e => console.warn('promo columns ensure failed:', e.message));

        await pool.query(`
            CREATE TABLE IF NOT EXISTS vehicle_plate_change_requests (
                id VARCHAR(64) PRIMARY KEY,
                customer_id VARCHAR(64) NOT NULL,
                vehicle_id VARCHAR(64) NOT NULL,
                current_plate VARCHAR(32) NOT NULL,
                requested_plate VARCHAR(32) NOT NULL,
                normalized_requested_plate VARCHAR(32) NOT NULL,
                rc_doc_url TEXT NOT NULL,
                insurance_doc_url TEXT NOT NULL,
                is_ownership_changed BOOLEAN DEFAULT FALSE,
                form29_30_doc_url TEXT,
                status VARCHAR(32) NOT NULL DEFAULT 'pending',
                rejection_reason TEXT,
                reviewed_by VARCHAR(64),
                reviewed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_vpcr_status ON vehicle_plate_change_requests(status);
            CREATE INDEX IF NOT EXISTS idx_vpcr_customer ON vehicle_plate_change_requests(customer_id);
            CREATE INDEX IF NOT EXISTS idx_vpcr_vehicle ON vehicle_plate_change_requests(vehicle_id);
        `).catch(e => console.warn('vehicle_plate_change_requests ensure failed:', e.message));

        // Offers Management System Tables & Migration
        await pool.query(`
            CREATE TABLE IF NOT EXISTS offers (
                id VARCHAR(64) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                ride_count INTEGER NOT NULL DEFAULT 5,
                max_free_distance_km NUMERIC(6,2) DEFAULT 30.0,
                start_date TIMESTAMPTZ DEFAULT NOW(),
                end_date TIMESTAMPTZ NOT NULL,
                vehicle_scope VARCHAR(16) NOT NULL DEFAULT 'both',
                target_type VARCHAR(16) NOT NULL DEFAULT 'all',
                status VARCHAR(16) NOT NULL DEFAULT 'active',
                created_by VARCHAR(64),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_offers_status ON offers(status);
            CREATE INDEX IF NOT EXISTS idx_offers_end_date ON offers(end_date);

            CREATE TABLE IF NOT EXISTS offer_target_customers (
                id SERIAL PRIMARY KEY,
                offer_id VARCHAR(64) NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
                customer_id VARCHAR(64) NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(offer_id, customer_id)
            );
            CREATE INDEX IF NOT EXISTS idx_otc_offer_id ON offer_target_customers(offer_id);
            CREATE INDEX IF NOT EXISTS idx_otc_customer_id ON offer_target_customers(customer_id);

            ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS offer_id VARCHAR(64);
            ALTER TABLE trips ADD COLUMN IF NOT EXISTS offer_id VARCHAR(64);

            -- Migrate default Launch Promotion Offer
            INSERT INTO offers (
                id, name, description, ride_count, max_free_distance_km, start_date, end_date, vehicle_scope, target_type, status, created_at, updated_at
            ) VALUES (
                'off_launch_sep2026',
                'Launch Promotion: First 5 Rides Free',
                'Initial platform launch promotion — first 30km free per ride for all customers',
                5,
                30.0,
                '2026-09-11 00:00:00+05:30',
                '2026-11-10 23:59:59+05:30',
                'both',
                'all',
                'active',
                NOW(),
                NOW()
            ) ON CONFLICT (id) DO NOTHING;

            -- Backfill existing promo service requests to off_launch_sep2026
            UPDATE service_requests SET offer_id = 'off_launch_sep2026' WHERE is_promotional_ride = true AND (offer_id IS NULL OR offer_id = '');
            UPDATE trips SET offer_id = 'off_launch_sep2026' WHERE is_promotional_ride = true AND (offer_id IS NULL OR offer_id = '');
        `).catch(e => console.warn('offers system tables ensure failed:', e.message));
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS investor_access_requests (
                id VARCHAR(64) PRIMARY KEY,
                name VARCHAR(255),
                email VARCHAR(255) NOT NULL,
                organization VARCHAR(255),
                scheduling_link_or_note TEXT,
                status VARCHAR(32) NOT NULL DEFAULT 'pending',
                requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                decided_at TIMESTAMPTZ,
                decided_by VARCHAR(64),
                rejection_reason TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_investor_req_email ON investor_access_requests (LOWER(email));
            CREATE INDEX IF NOT EXISTS idx_investor_req_status ON investor_access_requests (status);

            CREATE TABLE IF NOT EXISTS garage_applications (
                id VARCHAR(64) PRIMARY KEY,
                garage_name VARCHAR(255) NOT NULL,
                owner_name VARCHAR(255) NOT NULL,
                phone VARCHAR(32) NOT NULL,
                city VARCHAR(128),
                pincode VARCHAR(32),
                service_bays VARCHAR(32),
                services_offered TEXT,
                status VARCHAR(32) NOT NULL DEFAULT 'pending',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_garage_app_phone ON garage_applications (phone);
            CREATE INDEX IF NOT EXISTS idx_garage_app_status ON garage_applications (status);
        `).catch(e => console.warn('investor/garage tables ensure failed:', e.message));

        console.log('Postgres columns, investor, and garage application tables ensured.');
        await syncExpiredSubscriptions();
    } catch(e) {
        console.warn('Postgres columns ensure failed:', e.message);
    }
}

// ============================================================
// SUBSCRIPTION EXPIRATION & PAYOUT MODEL SYNC WORKER
// ============================================================
async function syncExpiredSubscriptions() {
    try {
        const updateUsersRes = await pool.query(`
            UPDATE users 
            SET payout_model = 'commission',
                pending_payout_model = NULL,
                pending_subscription_cycle = NULL,
                pending_effective_date = NULL
            WHERE payout_model = 'subscription' 
              AND (subscription_valid_until IS NULL OR subscription_valid_until < NOW())
            RETURNING id, name, phone, subscription_valid_until;
        `);

        if (updateUsersRes.rows && updateUsersRes.rows.length > 0) {
            const driverIds = updateUsersRes.rows.map(r => r.id);
            console.log(`[SUBSCRIPTION_SYNC] Reset ${driverIds.length} expired driver subscription(s) to commission: ${driverIds.join(', ')}`);

            driverIds.forEach(driverId => {
                db.run(`
                    UPDATE users 
                    SET payout_model = 'commission',
                        pending_payout_model = NULL,
                        pending_subscription_cycle = NULL,
                        pending_effective_date = NULL
                    WHERE id = ?
                `, [driverId], () => {});
            });
        }
    } catch (err) {
        console.error('[SUBSCRIPTION_SYNC_ERROR]', err.message);
    }
}

// Background sync interval (every 5 minutes)
setInterval(syncExpiredSubscriptions, 5 * 60 * 1000);

ensureKycColumns();

async function notifyMarshalsFCM(title, body, payloadData = {}) {
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
}

async function notifyUserFCM(userId, title, body, payloadData = {}) {
    if (!userId || !title) return;
    try {
        if (!fcmInitialized) return;
        const res = await pool.query(`
            SELECT fcmtoken as "fcmToken" FROM users WHERE id = $1 AND fcmtoken IS NOT NULL
            UNION
            SELECT fcmtoken as "fcmToken" FROM customers WHERE id = $1 AND fcmtoken IS NOT NULL
        `, [userId]);
        if (res.rows.length === 0) return;
        const token = res.rows[0].fcmToken || res.rows[0].fcmtoken;
        if (!token) return;

        const stringifiedData = {};
        for (const [k, v] of Object.entries(payloadData || {})) {
            stringifiedData[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
        }

        await getMessaging().send({
            token: token,
            notification: { title, body },
            data: stringifiedData,
            android: { priority: 'high', notification: { channel_id: 'marshal-alerts', default_sound: true } }
        });
        console.log(`[FCM_NOTIFY] Sent FCM to user ${userId} | Title: "${title}"`);
    } catch(e) { console.error(`[FCM_ERROR] Failed for user ${userId}:`, e.message); }
}

const apiRouter = express.Router();


apiRouter.get('/admin/system/health', authMiddleware, requireRole('admin'), (req, res) => {
    res.json({ status: 'active', message: 'Backend is running correctly', timestamp: new Date() });
});

apiRouter.get('/admin/system/env-keys', authMiddleware, requireRole('admin'), (req, res) => {
    res.json({
        railway: {
            commitSha: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || null,
            branch: process.env.RAILWAY_GIT_BRANCH || null,
            commitMessage: process.env.RAILWAY_GIT_COMMIT_MESSAGE || null,
            serviceName: process.env.RAILWAY_SERVICE_NAME || null,
            environment: process.env.RAILWAY_ENVIRONMENT_NAME || null
        },
        envKeys: Object.keys(process.env).sort()
    });
});

apiRouter.post('/admin/system/upload-apk', authMiddleware, requireRole('admin'), (req, res, next) => {
    apkUpload.single('apk')(req, res, (err) => {
        if (err) {
            console.error('[APK_UPLOAD] Multer error:', err.message);
            return res.status(400).json({ error: err.message });
        }
        next();
    });
}, async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No APK file provided in multipart "apk" field.' });
    }

    try {
        const savedPath = req.file.path;
        const stats = fs.statSync(savedPath);

        console.log(`[APK_UPLOAD] Admin (${req.user?.email || req.user?.id}) published APK: ${req.file.filename} (${stats.size} bytes) -> ${savedPath}`);

        res.json({
            success: true,
            filename: req.file.filename,
            sizeBytes: stats.size,
            sizeMB: (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
            downloadUrl: `https://api.redrivo.in/downloads/${req.file.filename}`,
            uploadedAt: new Date().toISOString()
        });
    } catch (err) {
        console.error('[APK_UPLOAD] Error saving APK:', err);
        res.status(500).json({ error: 'Failed to process APK upload: ' + err.message });
    }
});

apiRouter.get('/health', (req, res) => {
    res.json({ status: 'active', message: 'Backend is running correctly' });
});

// --- GOOGLE MAPS PROXY & QUOTA CONTROL ---
let inMemoryQuotaCount = 0;
let inMemoryQuotaDay = '';

async function checkAndIncrementQuota() {
    const apiKey = GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
        console.warn('[Google Maps Proxy] GOOGLE_MAPS_API_KEY constant is missing. Falling back to OpenStreetMap.');
        return false;
    }
    
    const today = new Date().toISOString().split('T')[0];
    if (inMemoryQuotaDay !== today) {
        inMemoryQuotaDay = today;
        inMemoryQuotaCount = 0;
    }
    
    if (inMemoryQuotaCount >= 500) {
        console.warn(`[Google Maps Proxy] Daily quota limit of 500 requests exceeded (${inMemoryQuotaCount} requests today). Falling back to OpenStreetMap.`);
        return false;
    }
    
    inMemoryQuotaCount++;
    
    // Asynchronously update/save usage count in database so it NEVER blocks the main thread
    pool.query(
        "INSERT INTO daily_api_usage (usage_date, request_count) VALUES ($1, 1) ON CONFLICT (usage_date) DO UPDATE SET request_count = daily_api_usage.request_count + 1",
        [today]
    ).catch(err => {
        // Quietly ignore DB logging errors to keep it fast and non-blocking
    });
    
    return true;
}

function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const deltaPhi = (lat2 - lat1) * Math.PI / 180;
    const deltaLambda = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return Math.round(R * c); // Distance in meters
}

apiRouter.get('/maps/config', (req, res) => {
    const hasKey = !!GOOGLE_MAPS_API_KEY;
    res.json({ 
        googleMapsActive: hasKey,
        googleMapsKey: GOOGLE_MAPS_API_KEY || ''
    });
});

apiRouter.get('/maps/autocomplete', async (req, res) => {
    const query = req.query.q;
    const biasLat = req.query.lat ? parseFloat(req.query.lat) : 22.5726;
    const biasLng = req.query.lng ? parseFloat(req.query.lng) : 88.3639;

    if (!query || query.trim().length < 3) {
        return res.json([]);
    }
    
    const useGoogle = await checkAndIncrementQuota();
    if (useGoogle) {
        try {
            const apiKey = GOOGLE_MAPS_API_KEY;
            let url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(query)}&components=country:in&key=${apiKey}`;
            if (biasLat !== null && biasLng !== null && !isNaN(biasLat) && !isNaN(biasLng)) {
                url += `&location=${biasLat},${biasLng}&radius=50000&origin=${biasLat},${biasLng}`;
            }
            const response = await fetch(url);
            const data = await response.json();
            
            if (data && data.status === 'OK' && Array.isArray(data.predictions)) {
                const mapped = data.predictions.map(pred => ({
                    name: pred.structured_formatting ? pred.structured_formatting.main_text : pred.description.split(',')[0],
                    address: pred.description,
                    place_id: pred.place_id,
                    distance_meters: pred.distance_meters || null,
                    source: 'google'
                }));
                return res.json(mapped);
            } else {
                console.warn('[Google Maps Autocomplete] API returned non-OK status:', data.status);
            }
        } catch (err) {
            console.error('[Google Maps Autocomplete] Fetch error:', err.message);
        }
        console.log('[Google Maps Autocomplete] Falling back to OpenStreetMap search.');
    }
    
    // Fallback to OSM Nominatim
    try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=in&limit=5`;
        const response = await fetch(url, { headers: { 'User-Agent': 'GearX-App/1.0' } });
        if (response.ok) {
            const data = await response.json();
            const mapped = data.map(item => {
                const parts = item.display_name.split(',');
                const name = parts[0] || 'Pinpoint Location';
                const address = parts.slice(1).join(',').trim();
                const itemLat = parseFloat(item.lat);
                const itemLng = parseFloat(item.lon);
                
                let distMeters = null;
                if (biasLat !== null && biasLng !== null && !isNaN(biasLat) && !isNaN(biasLng) && !isNaN(itemLat) && !isNaN(itemLng)) {
                    distMeters = haversineDistance(biasLat, biasLng, itemLat, itemLng);
                }

                return {
                    name: name,
                    address: address || item.display_name,
                    lat: itemLat,
                    lng: itemLng,
                    distance_meters: distMeters,
                    source: 'osm'
                };
            });
            return res.json(mapped);
        }
    } catch (err) {
        console.error('[OSM Autocomplete Fallback] Fetch error:', err.message);
    }
    res.json([]);
});

apiRouter.get('/maps/details', async (req, res) => {
    const placeId = req.query.place_id;
    if (!placeId) {
        return res.status(400).json({ error: 'place_id is required' });
    }
    
    // 1. Check cache first (ignore if it contains a Plus Code '+')
    try {
        const cacheResult = await pool.query("SELECT * FROM cached_places WHERE place_id = $1", [placeId]);
        if (cacheResult.rows.length > 0) {
            const row = cacheResult.rows[0];
            if (row.description && !row.description.includes('+')) {
                return res.json({ lat: row.lat, lng: row.lng, address: row.description, source: 'cache' });
            }
        }
    } catch (err) {
        console.error('[Google Maps Details Cache] Query error:', err.message);
    }
    
    const useGoogle = await checkAndIncrementQuota();
    if (useGoogle) {
        try {
            const apiKey = GOOGLE_MAPS_API_KEY;
            const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=geometry,formatted_address&key=${apiKey}`;
            const response = await fetch(url);
            const data = await response.json();
            
            if (data && data.status === 'OK' && data.result && data.result.geometry && data.result.geometry.location) {
                const lat = data.result.geometry.location.lat;
                const lng = data.result.geometry.location.lng;
                let address = data.result.formatted_address;
                
                // If Google details returns a Plus Code, fall back to OpenStreetMap Nominatim reverse geocode for a human-readable address
                if (address && address.includes('+')) {
                    try {
                        const osmUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`;
                        const osmResponse = await fetch(osmUrl, { headers: { 'User-Agent': 'GearX-App/1.0' } });
                        if (osmResponse.ok) {
                            const osmData = await osmResponse.json();
                            if (osmData && osmData.display_name) {
                                address = osmData.display_name;
                            }
                        }
                    } catch (osmErr) {
                        console.error('[Details OSM Fallback] Reverse geocode failed:', osmErr.message);
                    }
                }
                
                // Save/overwrite in cache
                pool.query(
                    "INSERT INTO cached_places (place_id, description, lat, lng) VALUES ($1, $2, $3, $4) ON CONFLICT (place_id) DO UPDATE SET description = EXCLUDED.description, lat = EXCLUDED.lat, lng = EXCLUDED.lng",
                    [placeId, address, lat, lng]
                ).catch(e => console.error('[Google Maps Details Cache] Save error:', e.message));

                // Log customer search intent into pickup_searches
                logPickupSearch({
                    address,
                    lat,
                    lng,
                    customerId: req.query.customerId || req.query.customer_id,
                    searchType: 'autocomplete_select'
                });
                
                return res.json({ lat, lng, address, source: 'google' });
            } else {
                console.warn('[Google Maps Details] API returned non-OK status:', data ? data.status : 'No response');
            }
        } catch (err) {
            console.error('[Google Maps Details] Fetch error:', err.message);
        }
    }
    
    // Fallback: Return default Kolkata location if Details resolution fails
    res.json({ lat: 22.5726, lng: 88.3639, address: 'Fallback: Park Street, Kolkata', source: 'fallback' });
});

apiRouter.get('/maps/reverse-geocode', async (req, res) => {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    if (isNaN(lat) || isNaN(lng)) {
        return res.status(400).json({ error: 'Valid lat and lng are required' });
    }
    
    const useGoogle = await checkAndIncrementQuota();
    if (useGoogle) {
        try {
            const apiKey = GOOGLE_MAPS_API_KEY;
            const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`;
            const response = await fetch(url);
            const data = await response.json();
            
            if (data && data.status === 'OK' && Array.isArray(data.results) && data.results.length > 0) {
                // Find first geocoded result that is not a Plus Code (has no '+' symbol and no 'plus_code' type)
                let bestResult = data.results.find(r => r.types && !r.types.includes('plus_code') && !(r.formatted_address && r.formatted_address.includes('+')));
                if (bestResult) {
                    logPickupSearch({
                        address: bestResult.formatted_address,
                        lat,
                        lng,
                        customerId: req.query.customerId || req.query.customer_id,
                        searchType: 'map_pin'
                    });
                    return res.json({ address: bestResult.formatted_address, source: 'google' });
                }
                console.log('[Google Maps Reverse Geocode] Only Plus Codes found. Falling back to OpenStreetMap.');
            } else {
                console.warn('[Google Maps Reverse Geocode] API returned non-OK status:', data ? data.status : 'No response data');
            }
        } catch (err) {
            console.error('[Google Maps Reverse Geocode] Fetch error:', err.message);
        }
        console.log('[Google Maps Reverse Geocode] Falling back to OpenStreetMap.');
    }

    
    // Fallback to OSM Nominatim
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`;
        const response = await fetch(url, { headers: { 'User-Agent': 'GearX-App/1.0' } });
        if (response.ok) {
            const data = await response.json();
            return res.json({ address: data.display_name, source: 'osm' });
        }
    } catch (err) {
        console.error('[OSM Reverse Geocode Fallback] Fetch error:', err.message);
    }
    res.json({ address: `GPS Coordinates: ${lat.toFixed(6)}, ${lng.toFixed(6)}`, source: 'fallback' });
});

// --- BASIC ENTITY ROUTES ---
apiRouter.get('/customers', authMiddleware, requireRole('admin'), (req, res) => {
    db.all("SELECT * FROM customers", (err, rows) => {
        if (err) {
            console.error("GET /customers DB error:", err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json(rows || []);
    });
});

apiRouter.get('/vehicles', authMiddleware, (req, res) => {
    db.all("SELECT * FROM vehicles WHERE (is_test = FALSE OR is_test IS NULL)", (err, rows) => {
        if (err) {
            console.error("GET /vehicles DB error:", err.message);
            return res.status(500).json({ error: err.message });
        }
        const mapped = (rows || []).map(r => ({
            ...r,
            photo: generateSignedUploadUrl(r.photo)
        }));
        res.json(mapped);
    });
});

apiRouter.get('/requests', authMiddleware, (req, res) => {
    let query = "SELECT * FROM service_requests WHERE (is_test = FALSE OR is_test IS NULL)";
    let params = [];

    if (req.user && req.user.role === 'customer') {
        const custId = req.user.id.replace('_user', '');
        query += " AND (customerId = ? OR customerId = ?)";
        params = [custId, `${custId}_user`];
    } else if (req.user && req.user.role === 'marshal') {
        const marshalId = req.user.id;
        query += " AND (workerId = ? OR status IN ('pending', 'scheduled', 'marshal_assigned', 'searching'))";
        params = [marshalId];
    } else if (req.user && req.user.role === 'garage') {
        const garageId = req.user.garageId || req.user.id;
        query += " AND garageId = ?";
        params = [garageId];
    }

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error("GET /requests DB error:", err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json(rows || []);
    });
});

apiRouter.get('/garages', authMiddleware, requireRole('admin'), (req, res) => {
    db.all(`
        SELECT id, name, address, contact, email, status, photo, owner,
               joinedDate as "joinedDate", joineddate,
               lat, lng, businessType as "businessType", businesstype,
               rating, serviceType as "serviceType", servicetype,
               workerCount as "workerCount", workercount,
               ownerCount as "ownerCount", ownercount,
               serviceCenterType as "serviceCenterType", servicecentertype,
               authorizedCarBrands as "authorizedCarBrands", authorizedcarbrands,
               authorizedBikeBrands as "authorizedBikeBrands", authorizedbikebrands,
               emailVerified as "emailVerified", emailverified,
               phoneVerified as "phoneVerified", phoneverified,
               panVerified as "panVerified", panverified,
               aadhaarVerified as "aadhaarVerified", aadhaarverified,
               bankVerified as "bankVerified", bankverified
        FROM garages
    `, (err, rows) => {
        if (err) {
            console.error("GET /garages DB error:", err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json(rows || []);
    });
});

apiRouter.get('/garages/nearby', (req, res) => {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    
    db.all("SELECT * FROM garages WHERE status = 'active' AND (is_test = FALSE OR is_test IS NULL)", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        let result = rows || [];
        if (!isNaN(lat) && !isNaN(lng)) {
            result = result.map(g => {
                const gLat = parseFloat(g.lat);
                const gLng = parseFloat(g.lng);
                const dist = calcDistanceKm(lat, lng, gLat, gLng);
                return { ...g, distance: dist };
            });
            result = result.filter(g => g.distance !== null && g.distance <= 15.0);
            result.sort((a, b) => a.distance - b.distance);
        }
        res.json(result);
    });
});

apiRouter.post('/garages', authMiddleware, requireRole('admin'), (req, res) => {
    const { id, name, owner, phone, location, gmapLink, type, commissionRate, joinedDate } = req.body;
    db.run(`INSERT INTO garages (id, name, owner, contact, address, status, serviceType, joinedDate) 
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        [id, name, owner, phone, location, type === 'Both' ? 'Both' : (type === 'Bike' ? 'Bike' : 'Car'), joinedDate || new Date().toISOString()],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id });
        });
});


apiRouter.post('/users', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
        const { id, name, phone, email, role, password, status, pincode } = req.body;
        if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required' });
        
        const existing = await checkUniqueEntity(phone);
        if (existing) {
            return res.status(400).json({ error: 'A ' + (existing.role || 'user') + ' with this phone number already exists in the system.' });
        }
        
        await pool.query(
            "INSERT INTO users (id, name, phone, email, role, password, status, pincode) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            [id || 'u_' + Date.now(), name, phone, email, role || 'customer', password, status || 'active', pincode || null]
        );
        res.json({ success: true, id });
    } catch (err) {
        console.error('POST /users error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

apiRouter.get('/users', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
        await syncExpiredSubscriptions();
        const result = await pool.query(`
            SELECT id, name, role, email, phone, garageId as "garageId", garageid,
                   status, emailVerified as "emailVerified", emailverified,
                   phoneVerified as "phoneVerified", phoneverified,
                   panVerified as "panVerified", panverified,
                   aadhaarVerified as "aadhaarVerified", aadhaarverified,
                   dlVerified as "dlVerified", dlverified,
                   bankVerified as "bankVerified", bankverified,
                   kycStatus as "kycStatus", kycstatus,
                   panurl, panbackurl, aadhaarurl, aadhaarbackurl, dlurl, dlbackurl, facephotourl,
                   panurl as "panUrl", panbackurl as "panBackUrl", aadhaarurl as "aadhaarUrl", aadhaarbackurl as "aadhaarBackUrl", dlurl as "dlUrl", dlbackurl as "dlBackUrl", facephotourl as "facePhotoUrl",
                   is_online, pincode, address, city, state, rating,
                   profilePictureUrl as "profilePictureUrl", profilepictureurl,
                   dob, gender, kycRejectionReason as "kycRejectionReason", kycrejectionreason,
                   pannumber, aadhaarnumber, dlnumber, vehicle_types,
                   bankname, bankaccountname, bankaccountnumber, bankifsc,
                   payout_model as "payoutModel", payout_model,
                   subscription_cycle as "subscriptionCycle", subscription_cycle,
                   subscription_valid_until as "subscriptionValidUntil", subscription_valid_until,
                   pending_payout_model as "pendingPayoutModel", pending_payout_model,
                   pending_subscription_cycle as "pendingSubscriptionCycle", pending_subscription_cycle,
                   pending_effective_date as "pendingEffectiveDate", pending_effective_date,
                   payout_model_last_switched_at as "payoutModelLastSwitchedAt", payout_model_last_switched_at
            FROM users
        `);
        res.json((result.rows || []).map(signUserKycUrls));
    } catch (err) {
        console.error('GET /users error:', err.message);
        res.json([]);
    }
});

apiRouter.get('/system-settings', (req, res) => {
    db.all("SELECT * FROM system_settings", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const settings = {};
        rows.forEach(r => { settings[r.key] = r.value; });
        res.json(settings);
    });
});

apiRouter.post('/system-settings', authMiddleware, requireRole('admin'), (req, res) => {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'Key is required' });
    db.run(
        "INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value",
        [key, String(value)],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

apiRouter.get('/debug-server-paths', (req, res) => {
    try {
        const fs = require('fs');
        const path = require('path');
        const parentDir = path.join(__dirname, '..');
        const parentFiles = fs.readdirSync(parentDir);
        res.json({
            __dirname,
            parentDir,
            parentFiles,
            currentFiles: fs.readdirSync(__dirname)
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Feedback / Survey Routes
apiRouter.get('/feedback', authMiddleware, requireRole('admin'), (req, res) => {
    db.all("SELECT * FROM feedback ORDER BY createdAt DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

apiRouter.post('/feedback', (req, res) => {
    const { userId, userRole, surveyType, answers } = req.body;
    const id = `fb_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const params = [id, userId, userRole, surveyType];
    const qFields = [];
    const placeholders = ['?', '?', '?', '?'];
    
    for (let i = 1; i <= 6; i++) {
        const ans = answers && answers[i - 1];
        params.push(ans ? ans.q : null);
        params.push(ans ? ans.a : null);
        qFields.push(`question${i}`, `answer${i}`);
        placeholders.push('?', '?');
    }
    
    const sql = `INSERT INTO feedback (id, userId, userRole, surveyType, ${qFields.join(', ')}) VALUES (${placeholders.join(', ')})`;
    db.run(sql, params, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id });
    });
});

// Incentive Slabs & Global Settings Routes
apiRouter.get('/settings/incentives', (req, res) => {
    const type = (req.query.type || 'car').toLowerCase();
    db.all("SELECT maxDistance, ratePerKm, vehicle_type as \"vehicleType\" FROM incentive_slabs WHERE LOWER(COALESCE(vehicle_type, 'car')) = ? ORDER BY maxDistance ASC", [type], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (rows && rows.length > 0) {
            return res.json(rows);
        }
        if (type === 'bike') {
            return res.json([
                { maxDistance: 5, ratePerKm: 15, vehicleType: 'bike' },
                { maxDistance: 15, ratePerKm: 10, vehicleType: 'bike' },
                { maxDistance: 999, ratePerKm: 7, vehicleType: 'bike' }
            ]);
        }
        return res.json([
            { maxDistance: 10, ratePerKm: 35, vehicleType: 'car' },
            { maxDistance: 25, ratePerKm: 28, vehicleType: 'car' },
            { maxDistance: 999, ratePerKm: 18, vehicleType: 'car' }
        ]);
    });
});

apiRouter.post('/settings/incentives', authMiddleware, requireRole('admin'), (req, res) => {
    const { slabs } = req.body;
    const type = (req.body.type || 'car').toLowerCase();
    if (!Array.isArray(slabs)) return res.status(400).json({ error: 'Slabs array is required' });
    
    db.run("DELETE FROM incentive_slabs WHERE LOWER(COALESCE(vehicle_type, 'car')) = ?", [type], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        
        let completed = 0;
        if (slabs.length === 0) return res.json({ success: true });
        
        slabs.forEach((slab, idx) => {
            const id = `slab_${type}_${idx}_${Date.now()}`;
            db.run(
                "INSERT INTO incentive_slabs (id, maxDistance, ratePerKm, vehicle_type) VALUES (?, ?, ?, ?)",
                [id, Number(slab.maxDistance), Number(slab.ratePerKm), type],
                (err2) => {
                    completed++;
                    if (completed === slabs.length) {
                        res.json({ success: true });
                    }
                }
            );
        });
    });
});

// Hourly Rate Slabs Routes (Dedicated for Hourly Rentals with Atomic Transaction)
apiRouter.get('/settings/hourly-slabs', (req, res) => {
    const type = (req.query.type || 'car').toLowerCase();
    pool.query(
        "SELECT maxhours as \"maxHours\", rateperhour as \"ratePerHour\", vehicle_type as \"vehicleType\" FROM hourly_incentive_slabs WHERE LOWER(COALESCE(vehicle_type, 'car')) = $1 ORDER BY maxhours ASC",
        [type]
    ).then(result => {
        if (result.rows && result.rows.length > 0) {
            return res.json(result.rows);
        }
        if (type === 'bike') {
            return res.json([
                { maxHours: 2, ratePerHour: 45, vehicleType: 'bike' },
                { maxHours: 6, ratePerHour: 40, vehicleType: 'bike' },
                { maxHours: 999, ratePerHour: 35, vehicleType: 'bike' }
            ]);
        }
        return res.json([
            { maxHours: 2, ratePerHour: 90, vehicleType: 'car' },
            { maxHours: 6, ratePerHour: 80, vehicleType: 'car' },
            { maxHours: 999, ratePerHour: 70, vehicleType: 'car' }
        ]);
    }).catch(err => {
        console.error('Error fetching hourly slabs:', err.message);
        res.status(500).json({ error: err.message });
    });
});

apiRouter.post('/settings/hourly-slabs', authMiddleware, requireRole('admin'), async (req, res) => {
    const { slabs } = req.body;
    const type = (req.body.type || 'car').toLowerCase();
    if (!Array.isArray(slabs)) return res.status(400).json({ error: 'Slabs array is required' });

    // Strict pre-validation: validate all entries before touching database
    for (let i = 0; i < slabs.length; i++) {
        const s = slabs[i];
        const maxH = Number(s.maxHours !== undefined ? s.maxHours : s.maxhours);
        const rate = Number(s.ratePerHour !== undefined ? s.ratePerHour : s.rateperhour);
        if (isNaN(maxH) || maxH <= 0 || isNaN(rate) || rate < 0 || !isFinite(maxH) || !isFinite(rate)) {
            return res.status(400).json({ 
                error: `Invalid slab at index ${i}: maxHours must be > 0 and ratePerHour must be >= 0` 
            });
        }
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("DELETE FROM hourly_incentive_slabs WHERE LOWER(COALESCE(vehicle_type, 'car')) = $1", [type]);

        for (let idx = 0; idx < slabs.length; idx++) {
            const slab = slabs[idx];
            const id = `hslab_${type}_${idx}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
            const maxH = Number(slab.maxHours !== undefined ? slab.maxHours : slab.maxhours);
            const rate = Number(slab.ratePerHour !== undefined ? slab.ratePerHour : slab.rateperhour);
            await client.query(
                "INSERT INTO hourly_incentive_slabs (id, maxhours, rateperhour, vehicle_type) VALUES ($1, $2, $3, $4)",
                [id, maxH, rate, type]
            );
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Atomic transaction failed for hourly slabs, rolled back:', err.message);
        res.status(500).json({ error: 'Failed to update hourly rate slabs: ' + err.message });
    } finally {
        client.release();
    }
});

apiRouter.get('/settings/global', (req, res) => {
    db.all("SELECT key, value FROM system_settings", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const settings = {
            five_star_bonus: 50,
            payout_days: 3,
            car_platform_base_charge: 99,
            bike_platform_base_charge: 49,
            car_base_fare: 150,
            bike_base_fare: 50,
            car_customer_rate_per_km: 30,
            bike_customer_rate_per_km: 8,
            car_halt_rate_per_min: 5,
            bike_halt_rate_per_min: 3,
            car_hourly_rate: 150,
            bike_hourly_rate: 80
        };
        rows.forEach(r => {
            const num = Number(r.value);
            settings[r.key] = isNaN(num) ? r.value : num;
        });
        res.json(settings);
    });
});

apiRouter.post('/settings/global', authMiddleware, requireRole('admin'), (req, res) => {
    const { settings } = req.body;
    if (!Array.isArray(settings)) return res.status(400).json({ error: 'Settings array is required' });
    
    let completed = 0;
    settings.forEach(s => {
        db.run(
            "INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value",
            [s.key, String(s.value)],
            (err) => {
                completed++;
                if (completed === settings.length) {
                    res.json({ success: true });
                }
            }
        );
    });
});

apiRouter.get('/users/:id', authMiddleware, async (req, res) => {
    let id = req.params.id;
    if (id.endsWith('_owner')) {
        const garageId = id.replace('_owner', '');
        const userLookup = await pool.query(`SELECT id FROM users WHERE garageid = $1 AND role = 'garage' LIMIT 1`, [garageId]);
        if (userLookup.rows[0]) {
            id = userLookup.rows[0].id;
        }
    }
    if (req.user.role !== 'admin' && req.user.id !== id) {
        return res.status(403).json({ error: 'Forbidden: You can only access your own profile.' });
    }
    try {
        await syncExpiredSubscriptions();
        const userRes = await pool.query(`
            SELECT id, name, role, email, phone, garageId as "garageId", garageid,
                   status, emailVerified as "emailVerified", emailverified,
                   phoneVerified as "phoneVerified", phoneverified,
                   panVerified as "panVerified", panverified,
                   aadhaarVerified as "aadhaarVerified", aadhaarverified,
                   dlVerified as "dlVerified", dlverified,
                   bankVerified as "bankVerified", bankverified,
                   kycStatus as "kycStatus", kycstatus,
                   is_online, is_payment_on_hold as "is_payment_on_hold", is_payment_on_hold,
                   lat, lng, pincode, address, city, state, rating,
                   profilePictureUrl as "profilePictureUrl", profilepictureurl,
                   dob, gender, kycRejectionReason as "kycRejectionReason", kycrejectionreason,
                   pannumber, aadhaarnumber, dlnumber, vehicle_types,
                   bankname, bankaccountname, bankaccountnumber, bankifsc,
                   panurl, panbackurl, aadhaarurl, aadhaarbackurl, dlurl, dlbackurl, facephotourl,
                   payout_model as "payoutModel", payout_model,
                   subscription_cycle as "subscriptionCycle", subscription_cycle,
                   subscription_valid_until as "subscriptionValidUntil", subscription_valid_until,
                   pending_payout_model as "pendingPayoutModel", pending_payout_model,
                   pending_subscription_cycle as "pendingSubscriptionCycle", pending_subscription_cycle,
                   pending_effective_date as "pendingEffectiveDate", pending_effective_date,
                   payout_model_last_switched_at as "payoutModelLastSwitchedAt", payout_model_last_switched_at
            FROM users WHERE id = $1
        `, [id]);
        if (userRes.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json(signUserKycUrls(userRes.rows[0]));
    } catch (err) {
        console.error('GET /users/:id error:', err.message);
        res.status(500).json({ error: 'Failed to fetch user profile' });
    }
});

// --- STRICT KYC APPROVAL VALIDATION ---
function validateKycApprovalRequirements(user, updates = {}) {
    const role = (user.role || '').toLowerCase();
    // Only drivers/marshals and garage workers need mandatory DL, Face, ID, and Bank validation
    if (role !== 'marshal' && role !== 'driver' && role !== 'worker' && role !== 'garage_worker') {
        return { valid: true };
    }

    const missing = [];

    // 1. Identity Document: Either Aadhaar (12 digits + front + back) OR PAN (10 chars + front + back)
    const effectivePan = (updates.panNumber || updates.pannumber || user.pannumber || '').trim().toUpperCase();
    const isPanFormatValid = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(effectivePan);
    const hasPanFront = !!(updates.panUrl || updates.panurl || user.panurl);
    const hasPanBack = !!(updates.panBackUrl || updates.panbackurl || user.panbackurl);
    const isPanComplete = isPanFormatValid && hasPanFront && hasPanBack;

    const effectiveAadhaar = (updates.aadhaarNumber || updates.aadhaarnumber || user.aadhaarnumber || '').replace(/\D/g, '');
    const isAadhaarFormatValid = /^[2-9][0-9]{11}$/.test(effectiveAadhaar);
    const hasAadhaarFront = !!(updates.aadhaarUrl || updates.aadhaarurl || user.aadhaarurl);
    const hasAadhaarBack = !!(updates.aadhaarBackUrl || updates.aadhaarbackurl || user.aadhaarbackurl);
    const isAadhaarComplete = isAadhaarFormatValid && hasAadhaarFront && hasAadhaarBack;

    if (!isPanComplete && !isAadhaarComplete) {
        if (!effectivePan && !effectiveAadhaar) {
            missing.push('Government ID (Aadhaar or PAN Number + Front/Back photos)');
        } else if (effectiveAadhaar) {
            if (!isAadhaarFormatValid) missing.push('Valid 12-digit Aadhaar Number (starting with 2-9)');
            if (!hasAadhaarFront) missing.push('Aadhaar Front Photo');
            if (!hasAadhaarBack) missing.push('Aadhaar Back Photo');
        } else if (effectivePan) {
            if (!isPanFormatValid) missing.push('Valid PAN Number (e.g. ABCDE1234F)');
            if (!hasPanFront) missing.push('PAN Front Photo');
            if (!hasPanBack) missing.push('PAN Back Photo');
        }
    }

    // 2. Driving License: DL Number + Front Photo + Back Photo
    const effectiveDl = (updates.dlNumber || updates.dlnumber || user.dlnumber || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const isDlFormatValid = /^[A-Z]{2}[0-9]{11,13}$/.test(effectiveDl);
    const hasDlFront = !!(updates.dlUrl || updates.dlurl || user.dlurl);
    const hasDlBack = !!(updates.dlBackUrl || updates.dlbackurl || user.dlbackurl);

    if (!isDlFormatValid) missing.push('Valid Driving License Number (e.g. WB4120220002368)');
    if (!hasDlFront) missing.push('Driving License Front Photo');
    if (!hasDlBack) missing.push('Driving License Back Photo');

    // 3. Live Selfie Photo
    const hasFacePhoto = !!(updates.facePhotoUrl || updates.facephotourl || user.facephotourl);
    if (!hasFacePhoto) missing.push('Live Selfie Photo');

    // 4. Bank Payout Details: Account Number + IFSC OR UPI ID
    const effectiveBankAcc = (updates.bankAccountNumber || updates.bankaccountnumber || user.bankaccountnumber || '').trim();
    const effectiveBankIfsc = (updates.bankIFSC || updates.bankifsc || user.bankifsc || '').trim().toUpperCase();
    const effectiveUpi = (updates.upi_id || updates.upiId || user.upi_id || '').trim();
    const hasValidBank = (effectiveBankAcc.length >= 8 && /^[A-Z]{4}0[A-Z0-9]{6}$/.test(effectiveBankIfsc)) || effectiveUpi.length >= 3;
    if (!hasValidBank) {
        missing.push('Bank Payout Details (Account Number + valid IFSC or UPI ID)');
    }

    if (missing.length > 0) {
        return {
            valid: false,
            error: `Cannot approve driver KYC. Missing or invalid required items: ${missing.join(', ')}.`,
            missingFields: missing
        };
    }
    return { valid: true };
}

apiRouter.patch('/users/:id', authMiddleware, async (req, res) => {
    let id = req.params.id;
    if (id.endsWith('_owner')) {
        const garageId = id.replace('_owner', '');
        const userLookup = await pool.query(`SELECT id FROM users WHERE garageid = $1 AND role = 'garage' LIMIT 1`, [garageId]);
        if (userLookup.rows[0]) {
            id = userLookup.rows[0].id;
        }
    }
    if (req.user.role !== 'admin' && req.user.id !== id) {
        return res.status(403).json({ error: 'Forbidden: You can only modify your own profile.' });
    }

    // Pre-validate KYC approval if requesting approved/verified status
    const kycStatusVal = req.body.kycStatus || req.body.kycstatus;
    if (kycStatusVal && (kycStatusVal === 'verified' || kycStatusVal === 'approved' || kycStatusVal === 'Approved')) {
        try {
            const currentUserRes = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
            const currentUser = currentUserRes.rows[0];
            if (!currentUser) {
                return res.status(404).json({ error: 'User not found' });
            }
            const validation = validateKycApprovalRequirements(currentUser, req.body);
            if (!validation.valid) {
                return res.status(400).json({ error: validation.error, missingFields: validation.missingFields });
            }
        } catch (vErr) {
            console.error('KYC approval validation error:', vErr);
            return res.status(500).json({ error: 'Failed to validate KYC approval requirements.' });
        }
    }

    const USER_ALLOWED_FIELDS = ['name', 'email', 'phone', 'lat', 'lng', 'is_online', 'pincode', 'address', 'city', 'state'];
    const ADMIN_ONLY_FIELDS = ['kycStatus', 'panVerified', 'aadhaarVerified', 'bankVerified', 'dlVerified', 'status', 'is_payment_on_hold', 'kycRejectionReason'];
    const allowed = req.user.role === 'admin' 
        ? [...USER_ALLOWED_FIELDS, ...ADMIN_ONLY_FIELDS]
        : USER_ALLOWED_FIELDS;
    const fields = [];
    const vals = [];
    let idx = 1;

    allowed.forEach(col => {
        if (req.body[col] !== undefined) {
            fields.push(`${col.toLowerCase()} = $${idx++}`);
            vals.push(req.body[col]);
        }
    });

    if (fields.length === 0 && !req.body.phone && !req.body.email) return res.json({ success: true });

    try {
        if (req.body.phone) {
            const exists = await pool.query(`SELECT id FROM users WHERE phone = $1 AND id != $2`, [req.body.phone, id]);
            if (exists.rows.length > 0) return res.status(400).json({ error: 'Phone number is already associated with another account.' });
            fields.push(`phoneverified = $${idx++}`);
            vals.push(0);
        }
        if (req.body.email) {
            const exists = await pool.query(`SELECT id FROM users WHERE email = $1 AND id != $2 AND role = $3`, [req.body.email, id, req.user.role]);
            if (exists.rows.length > 0) return res.status(400).json({ error: 'Email is already associated with another account.' });
            // Only reset if we are not actively verifying it in the same request
            if (req.body.emailVerified === undefined) {
                fields.push(`emailverified = $${idx++}`);
                vals.push(0);
            }
        }

        vals.push(id);
        await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`, vals);

        if (req.body.password !== undefined || req.body.role !== undefined || req.body.status !== undefined) {
            await revokeUserSessions(id);
        }

        const kycStatusVal = req.body.kycStatus || req.body.kycstatus;
        if (kycStatusVal !== undefined) {
            if (kycStatusVal === 'verified' || kycStatusVal === 'approved' || kycStatusVal === 'Approved') {
                notifyUserFCM(id, 'KYC Approved', 'Your KYC documents have been successfully approved. You can now accept pickups.');
            } else if (kycStatusVal === 'rejected' || kycStatusVal === 'Re-submit KYC') {
                notifyUserFCM(id, 'KYC Action Required', 'Some of your KYC documents were rejected. Please submit them again in the app.');
            } else if (kycStatusVal === 'pending_submission') {
                notifyUserFCM(id, 'KYC Re-verification Requested', 'We need you to re-submit your KYC documents. Tap to open and re-submit.');
            }
        }

        // Also update garages/customers if applicable
        const userRes = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
        const user = userRes.rows[0];
        if (user) {
            // Update customer table in Postgres
            const custCheck = await pool.query(`SELECT id FROM customers WHERE id = $1`, [id]);
            if (custCheck.rows[0]) {
                const custFields = [];
                const custVals = [];
                let cIdx = 1;
                if (req.body.name) { custFields.push(`name = $${cIdx++}`); custVals.push(req.body.name); }
                if (req.body.email) { custFields.push(`email = $${cIdx++}`); custVals.push(req.body.email); }
                if (req.body.phone) { custFields.push(`phone = $${cIdx++}`); custVals.push(req.body.phone); }
                if (custFields.length > 0) {
                    custVals.push(id);
                    await pool.query(`UPDATE customers SET ${custFields.join(', ')} WHERE id = $${cIdx}`, custVals).catch(() => {});
                }
            }

            if (user.role === 'garage') {
                const garageId = user.garageId || user.garageid;
                if (garageId) {
                    const garFields = [];
                    const garVals = [];
                    let gIdx = 1;
                    if (req.body.name) { garFields.push(`name = $${gIdx++}`); garVals.push(req.body.name); }
                    if (req.body.email) { garFields.push(`email = $${gIdx++}`); garVals.push(req.body.email); }
                    if (req.body.phone) { garFields.push(`contact = $${gIdx++}`); garVals.push(req.body.phone); }
                    if (garFields.length > 0) {
                        garVals.push(garageId);
                        await pool.query(`UPDATE garages SET ${garFields.join(', ')} WHERE id = $${gIdx}`, garVals).catch(() => {});
                    }
                }
            }

            // Sync to garage_workers table in Postgres if user is a worker/marshal
            const workerCheck = await pool.query(`SELECT id FROM garage_workers WHERE id = $1`, [id]);
            if (workerCheck.rows[0]) {
                const wFields = [];
                const wVals = [];
                let wIdx = 1;
                allowed.forEach(col => {
                    if (req.body[col] !== undefined) {
                        wFields.push(`${col.toLowerCase()} = $${wIdx++}`);
                        wVals.push(req.body[col]);
                    }
                });
                if (req.body.phone) {
                    wFields.push(`phoneverified = $${wIdx++}`);
                    wVals.push(0);
                }
                if (req.body.email) {
                    if (req.body.emailVerified === undefined) {
                        wFields.push(`emailverified = $${wIdx++}`);
                        wVals.push(0);
                    }
                }
                if (wFields.length > 0) {
                    wVals.push(id);
                    await pool.query(`UPDATE garage_workers SET ${wFields.join(', ')} WHERE id = $${wIdx}`, wVals).catch(e => {
                        console.error('Failed to sync to garage_workers table:', e.message);
                    });
                }
            }

            // Sync to SQLite tables
            const sqFields = [];
            const sqVals = [];
            allowed.forEach(col => {
                if (req.body[col] !== undefined) {
                    sqFields.push(`${col} = ?`);
                    sqVals.push(req.body[col]);
                }
            });
            if (sqFields.length > 0) {
                sqVals.push(id);
                const sqCustFields = [];
                const sqCustVals = [];
                if (req.body.name) { sqCustFields.push("name = ?"); sqCustVals.push(req.body.name); }
                if (req.body.email) { sqCustFields.push("email = ?"); sqCustVals.push(req.body.email); }
                if (req.body.phone) { sqCustFields.push("phone = ?"); sqCustVals.push(req.body.phone); }
                if (sqCustFields.length > 0) {
                    sqCustVals.push(id);
                    db.run(`UPDATE customers SET ${sqCustFields.join(', ')} WHERE id = ?`, sqCustVals, (err) => {
                        if (err) console.warn('SQLite customers sync failed:', err.message);
                    });
                }
                db.run(`UPDATE users SET ${sqFields.join(', ')} WHERE id = ?`, sqVals, (err) => {
                    if (err) console.warn('SQLite users sync failed:', err.message);
                });
            }
            if (user.role === 'garage') {
                const garageId = user.garageId || user.garageid;
                if (garageId) {
                    const sqGarFields = [];
                    const sqGarVals = [];
                    if (req.body.name) { sqGarFields.push("name = ?"); sqGarVals.push(req.body.name); }
                    if (req.body.email) { sqGarFields.push("email = ?"); sqGarVals.push(req.body.email); }
                    if (req.body.phone) { sqGarFields.push("contact = ?"); sqGarVals.push(req.body.phone); }
                    if (sqGarFields.length > 0) {
                        sqGarVals.push(garageId);
                        db.run(`UPDATE garages SET ${sqGarFields.join(', ')} WHERE id = ?`, sqGarVals, (err) => {
                            if (err) console.warn('SQLite garages sync failed:', err.message);
                        });
                    }
                }
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('PATCH /users/:id error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Alias PUT to PATCH for /users/:id to support PUT requests from frontend

apiRouter.put('/users/:id/fcm-token', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin' && req.user.id !== req.params.id) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    try {
        const { fcmToken } = req.body;
        if (!fcmToken) return res.status(400).json({ error: 'Token required' });
        await pool.query("UPDATE users SET fcmToken = $1 WHERE id = $2", [fcmToken, req.params.id]);
        await pool.query("UPDATE customers SET fcmToken = $1 WHERE id = $2", [fcmToken, req.params.id]).catch(() => {});
        res.json({ success: true });
    } catch(err) {
        console.error(err);
        res.status(500).json({ error: 'DB Error' });
    }
});

apiRouter.put('/customers/:id/fcm-token', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin' && req.user.id !== req.params.id) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    try {
        const { fcmToken } = req.body;
        if (!fcmToken) return res.status(400).json({ error: 'Token required' });
        await pool.query("UPDATE customers SET fcmToken = $1 WHERE id = $2", [fcmToken, req.params.id]);
        await pool.query("UPDATE users SET fcmToken = $1 WHERE id = $2", [fcmToken, req.params.id]).catch(() => {});
        res.json({ success: true });
    } catch(err) {
        console.error(err);
        res.status(500).json({ error: 'DB Error' });
    }
});

apiRouter.put('/users/:id', authMiddleware, async (req, res) => {
    let id = req.params.id;
    if (id.endsWith('_owner')) {
        const garageId = id.replace('_owner', '');
        const userLookup = await pool.query(`SELECT id FROM users WHERE garageid = $1 AND role = 'garage' LIMIT 1`, [garageId]);
        if (userLookup.rows[0]) {
            id = userLookup.rows[0].id;
        }
    }
    if (req.user.role !== 'admin' && req.user.id !== id) {
        return res.status(403).json({ error: 'Forbidden: You can only modify your own profile.' });
    }

    // Pre-validate KYC approval if requesting approved/verified status
    const kycStatusVal = req.body.kycStatus || req.body.kycstatus;
    if (kycStatusVal && (kycStatusVal === 'verified' || kycStatusVal === 'approved' || kycStatusVal === 'Approved')) {
        try {
            const currentUserRes = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
            const currentUser = currentUserRes.rows[0];
            if (!currentUser) {
                return res.status(404).json({ error: 'User not found' });
            }
            const validation = validateKycApprovalRequirements(currentUser, req.body);
            if (!validation.valid) {
                return res.status(400).json({ error: validation.error, missingFields: validation.missingFields });
            }
        } catch (vErr) {
            console.error('KYC approval validation error:', vErr);
            return res.status(500).json({ error: 'Failed to validate KYC approval requirements.' });
        }
    }

    const USER_ALLOWED_FIELDS = ['name', 'email', 'phone', 'lat', 'lng', 'is_online', 'pincode', 'address', 'city', 'state'];
    const ADMIN_ONLY_FIELDS = ['kycStatus', 'panVerified', 'aadhaarVerified', 'bankVerified', 'dlVerified', 'status', 'is_payment_on_hold', 'kycRejectionReason'];
    const allowed = req.user.role === 'admin' 
        ? [...USER_ALLOWED_FIELDS, ...ADMIN_ONLY_FIELDS]
        : USER_ALLOWED_FIELDS;
    const fields = [];
    const vals = [];
    let idx = 1;

    allowed.forEach(col => {
        if (req.body[col] !== undefined) {
            fields.push(`${col.toLowerCase()} = $${idx++}`);
            vals.push(req.body[col]);
        }
    });

    if (fields.length === 0 && !req.body.phone && !req.body.email) return res.json({ success: true });

    try {
        if (req.body.phone) {
            const exists = await pool.query(`SELECT id FROM users WHERE phone = $1 AND id != $2`, [req.body.phone, id]);
            if (exists.rows.length > 0) return res.status(400).json({ error: 'Phone number is already associated with another account.' });
            fields.push(`phoneverified = $${idx++}`);
            vals.push(0);
        }
        if (req.body.email) {
            const exists = await pool.query(`SELECT id FROM users WHERE email = $1 AND id != $2 AND role = $3`, [req.body.email, id, req.user.role]);
            if (exists.rows.length > 0) return res.status(400).json({ error: 'Email is already associated with another account.' });
            if (req.body.emailVerified === undefined) {
                fields.push(`emailverified = $${idx++}`);
                vals.push(0);
            }
        }

        vals.push(id);
        await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`, vals);

        if (req.body.password !== undefined || req.body.role !== undefined || req.body.status !== undefined) {
            await revokeUserSessions(id);
        }

        const kycStatusVal = req.body.kycStatus || req.body.kycstatus;
        if (kycStatusVal !== undefined) {
            if (kycStatusVal === 'verified' || kycStatusVal === 'approved' || kycStatusVal === 'Approved') {
                notifyUserFCM(id, 'KYC Approved', 'Your KYC documents have been successfully approved. You can now accept pickups.');
            } else if (kycStatusVal === 'rejected' || kycStatusVal === 'Re-submit KYC') {
                notifyUserFCM(id, 'KYC Action Required', 'Some of your KYC documents were rejected. Please submit them again in the app.');
            } else if (kycStatusVal === 'pending_submission') {
                notifyUserFCM(id, 'KYC Re-verification Requested', 'We need you to re-submit your KYC documents. Tap to open and re-submit.');
            }
        }
        
        // Also update garages/customers if applicable
        const userRes = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
        const user = userRes.rows[0];
        if (user) {
            // Update customer table in Postgres
            const custCheck = await pool.query(`SELECT id FROM customers WHERE id = $1`, [id]);
            if (custCheck.rows[0]) {
                const custFields = [];
                const custVals = [];
                let cIdx = 1;
                if (req.body.name) { custFields.push(`name = $${cIdx++}`); custVals.push(req.body.name); }
                if (req.body.email) { custFields.push(`email = $${cIdx++}`); custVals.push(req.body.email); }
                if (req.body.phone) { custFields.push(`phone = $${cIdx++}`); custVals.push(req.body.phone); }
                if (custFields.length > 0) {
                    custVals.push(id);
                    await pool.query(`UPDATE customers SET ${custFields.join(', ')} WHERE id = $${cIdx}`, custVals).catch(() => {});
                }
            }

            if (user.role === 'garage') {
                const garageId = user.garageId || user.garageid;
                if (garageId) {
                    const garFields = [];
                    const garVals = [];
                    let gIdx = 1;
                    if (req.body.name) { garFields.push(`name = $${gIdx++}`); garVals.push(req.body.name); }
                    if (req.body.email) { garFields.push(`email = $${gIdx++}`); garVals.push(req.body.email); }
                    if (req.body.phone) { garFields.push(`contact = $${gIdx++}`); garVals.push(req.body.phone); }
                    if (garFields.length > 0) {
                        garVals.push(garageId);
                        await pool.query(`UPDATE garages SET ${garFields.join(', ')} WHERE id = $${gIdx}`, garVals).catch(() => {});
                    }
                }
            }

            // Sync to SQLite tables
            const sqFields = [];
            const sqVals = [];
            allowed.forEach(col => {
                if (req.body[col] !== undefined) {
                    sqFields.push(`${col} = ?`);
                    sqVals.push(req.body[col]);
                }
            });
            if (sqFields.length > 0) {
                sqVals.push(id);
                const sqCustFields = [];
                const sqCustVals = [];
                if (req.body.name) { sqCustFields.push("name = ?"); sqCustVals.push(req.body.name); }
                if (req.body.email) { sqCustFields.push("email = ?"); sqCustVals.push(req.body.email); }
                if (req.body.phone) { sqCustFields.push("phone = ?"); sqCustVals.push(req.body.phone); }
                if (sqCustFields.length > 0) {
                    sqCustVals.push(id);
                    db.run(`UPDATE customers SET ${sqCustFields.join(', ')} WHERE id = ?`, sqCustVals, (err) => {
                        if (err) console.warn('SQLite customers sync failed:', err.message);
                    });
                }
                db.run(`UPDATE users SET ${sqFields.join(', ')} WHERE id = ?`, sqVals, (err) => {
                    if (err) console.warn('SQLite users sync failed:', err.message);
                });
            }
            if (user.role === 'garage') {
                const garageId = user.garageId || user.garageid;
                if (garageId) {
                    const sqGarFields = [];
                    const sqGarVals = [];
                    if (req.body.name) { sqGarFields.push("name = ?"); sqGarVals.push(req.body.name); }
                    if (req.body.email) { sqGarFields.push("email = ?"); sqGarVals.push(req.body.email); }
                    if (req.body.phone) { sqGarFields.push("contact = ?"); sqGarVals.push(req.body.phone); }
                    if (sqGarFields.length > 0) {
                        sqGarVals.push(garageId);
                        db.run(`UPDATE garages SET ${sqGarFields.join(', ')} WHERE id = ?`, sqGarVals, (err) => {
                            if (err) console.warn('SQLite garages sync failed:', err.message);
                        });
                    }
                }
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('PUT /users/:id error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Secure OTP-verified Profile Edits
apiRouter.post('/users/:id/send-update-otp', async (req, res) => {
    let userId = req.params.id;
    if (userId.endsWith('_owner')) {
        const garageId = userId.replace('_owner', '');
        const userLookup = await pool.query(`SELECT id FROM users WHERE garageid = $1 AND role = 'garage' LIMIT 1`, [garageId]);
        if (userLookup.rows[0]) {
            userId = userLookup.rows[0].id;
        }
    }
    const { field, value, preferredChannel = 'sms' } = req.body;
    if (!field || !value) return res.status(400).json({ error: 'Field and value required' });
    if (field !== 'phone' && field !== 'email') return res.status(400).json({ error: 'Invalid field' });

    try {
        // Check if value is already taken by another user
        const checkSql = field === 'phone' 
            ? `SELECT id FROM users WHERE (phone = $1 OR phone = $2) AND id != $3`
            : `SELECT id FROM users WHERE email = $1 AND id != $2`;
        const checkParams = field === 'phone'
            ? [value.replace('+91', ''), value.startsWith('+91') ? value : '+91' + value, userId]
            : [value, userId];

        const checkRes = await pool.query(checkSql, checkParams);
        if (checkRes.rows.length > 0) {
            return res.status(400).json({ error: `${field === 'phone' ? 'Phone number' : 'Email'} is already in use by another account.` });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 mins

        const targetPhone = field === 'phone' ? value : null;
        const targetEmail = field === 'email' ? value : null;
        await pool.query(
            `INSERT INTO otp_verifications (entityid, entitytype, phone, email, otp, expiresat) VALUES ($1, 'update', $2, $3, $4, $5)`,
            [userId, targetPhone, targetEmail, otp, expiresAt]
        );

        if (field === 'phone' && value) {
            pool.query('SELECT role FROM users WHERE id = $1', [userId])
                .then(userRes => {
                    const userRole = userRes.rows[0]?.role || 'customer';
                    return sendUnifiedOtp(value, otp, userRole, preferredChannel);
                })
                .catch(otpErr => {
                    console.warn('[UNIFIED_OTP] Update OTP send error:', otpErr.message);
                });
        }

        if (field === 'email') {
            const fromEmail = process.env.RESEND_FROM_EMAIL || '"ReDrivo" <support@redrivo.in>';
            transporter.sendMail({
                from: fromEmail,
                to: value,
                subject: 'Verify your new email',
                text: `Your verification OTP is: ${otp}. Valid for 10 minutes. Do not share with anyone.`,
                html: generateOtpEmailHtml(otp, 'Verify Your New Email Address', 'Use the one-time verification code below to verify and update your ReDrivo account email.')
            }).then(info => {
                console.log(`[EMAIL] Verification OTP sent successfully to: ${value} | MessageId: ${info.messageId}`);
            }).catch(mailErr => {
                console.warn('[EMAIL] Email send failed (non-fatal):', mailErr.message);
            });
        }

        const resp = { message: 'OTP sent' };
        if (process.env.NODE_ENV !== 'production') resp.otp = otp;
        res.json(resp);
    } catch (err) {
        console.error('send-update-otp error:', err.message);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

apiRouter.post('/users/:id/verify-update-otp', async (req, res) => {
    let userId = req.params.id;
    if (userId.endsWith('_owner')) {
        const garageId = userId.replace('_owner', '');
        const userLookup = await pool.query(`SELECT id FROM users WHERE (garageid = $1 OR garageId = $1) AND role = 'garage' LIMIT 1`, [garageId]);
        if (userLookup.rows[0]) {
            userId = userLookup.rows[0].id;
        }
    }
    const { field, value, otp } = req.body;
    if (!field || !value || !otp) return res.status(400).json({ error: 'Field, value, and OTP required' });

    try {
        const otpResult = await pool.query(
            `SELECT * FROM otp_verifications WHERE entityid = $1 AND entitytype = 'update' AND (phone = $2 OR email = $2) AND otp = $3 AND verifiedat IS NULL AND expiresat > NOW() ORDER BY id DESC LIMIT 1`,
            [userId, value, otp]
        );
        const otpRow = otpResult.rows[0];
        if (!otpRow) return res.status(400).json({ error: 'Invalid or expired OTP' });

        await pool.query(`UPDATE otp_verifications SET verifiedat = NOW() WHERE id = $1`, [otpRow.id]);

        const userRes = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
        const user = userRes.rows[0];
        if (!user) return res.status(404).json({ error: 'User not found' });

        const prefixedVal = field === 'phone' && !value.startsWith('+91') ? '+91' + value : value;

        if (field === 'phone') {
            await pool.query(`UPDATE users SET phone = $1, phoneverified = 1 WHERE id = $2`, [prefixedVal, userId]);
            // Update customer table in Postgres if exists
            const custCheck = await pool.query(`SELECT id FROM customers WHERE id = $1`, [userId]);
            if (custCheck.rows[0]) {
                await pool.query(`UPDATE customers SET phone = $1 WHERE id = $2`, [prefixedVal, userId]);
            }
            if (user.role === 'garage') {
                const garageId = user.garageId || user.garageid;
                if (garageId) {
                    await pool.query(`UPDATE garages SET contact = $1, phoneverified = 1 WHERE id = $2`, [prefixedVal, garageId]);
                }
            }
        } else if (field === 'email') {
            await pool.query(`UPDATE users SET email = $1, emailverified = 1 WHERE id = $2`, [prefixedVal, userId]);
            // Update customer table in Postgres if exists
            const custCheck = await pool.query(`SELECT id FROM customers WHERE id = $1`, [userId]);
            if (custCheck.rows[0]) {
                await pool.query(`UPDATE customers SET email = $1 WHERE id = $2`, [prefixedVal, userId]);
            }
            if (user.role === 'garage') {
                const garageId = user.garageId || user.garageid;
                if (garageId) {
                    await pool.query(`UPDATE garages SET email = $1, emailverified = 1 WHERE id = $2`, [prefixedVal, garageId]);
                }
            }
        }

        // SQLite Sync for OTP update
        const sqliteCol = field === 'phone' ? 'phone' : 'email';
        db.run(`UPDATE users SET ${sqliteCol} = ? WHERE id = ?`, [prefixedVal, userId], (err) => {
            if (err) console.warn('SQLite users sync failed:', err.message);
        });
        db.run(`UPDATE customers SET ${sqliteCol} = ? WHERE id = ?`, [prefixedVal, userId], (err) => {
            if (err) console.warn('SQLite customers sync failed:', err.message);
        });
        if (user.role === 'garage') {
            const garageId = user.garageId || user.garageid;
            if (garageId) {
                const sqliteGarCol = field === 'phone' ? 'contact' : 'email';
                db.run(`UPDATE garages SET ${sqliteGarCol} = ? WHERE id = ?`, [prefixedVal, garageId], (err) => {
                    if (err) console.warn('SQLite garages sync failed:', err.message);
                });
            }
        }

        const updatedUserRes = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
        const updatedUser = updatedUserRes.rows[0];

        res.json({
            success: true,
            user: {
                id: updatedUser.id,
                name: updatedUser.name,
                role: updatedUser.role,
                phone: updatedUser.phone,
                email: updatedUser.email,
                phoneVerified: updatedUser.phoneverified || updatedUser.phoneVerified || 0,
                emailVerified: updatedUser.emailverified || updatedUser.emailVerified || 0
            }
        });
    } catch (err) {
        console.error('verify-update-otp error:', err.message);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

apiRouter.get('/trips', authMiddleware, (req, res) => {
    let query = `
        SELECT trips.*, 
               sr.customerId AS "customerId",
               sr.booking_flow AS "bookingFlow",
               sr.pickup_drop_type AS "pickupDropType",
               sr.pricing_mode AS "pricingMode",
               sr.estimated_hours AS "estimatedHours",
               sr.totalcustomerprice AS "totalCustomerPrice",
               sr.baseamount AS "baseAmount",
               sr.pickup_address AS "pickup_address",
               sr.drop_address AS "drop_address",
               sr.garageId AS "assignedGarageId",
               u.name AS "marshalName", 
               u.phone AS "marshalPhone",
               COALESCE(u.profilepictureurl, u.facePhotoUrl) AS "marshalPhoto",
               u.emailVerified AS "emailVerified",
               u.phoneVerified AS "phoneVerified",
               u.dlVerified AS "dlVerified"
        FROM trips
        LEFT JOIN service_requests sr ON trips.serviceRequestId = sr.id
        LEFT JOIN users u ON trips.marshalId = u.id
    `;
    let params = [];

    if (req.user && req.user.role === 'customer') {
        const custId = req.user.id.replace('_user', '');
        query += " WHERE sr.customerId = ? OR sr.customerId = ?";
        params = [custId, `${custId}_user`];
    } else if (req.user && req.user.role === 'marshal') {
        const marshalId = req.user.id;
        query += " WHERE trips.marshalId = ? OR trips.deliveryMarshalId = ? OR trips.status IN ('pending_pickup', 'assigned', 'pending_otp_1')";
        params = [marshalId, marshalId];
    } else if (req.user && req.user.role === 'garage') {
        const garageId = req.user.garageId || req.user.id;
        query += " WHERE sr.garageId = ?";
        params = [garageId];
    }

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error("GET /trips DB error:", err.message);
            return res.status(500).json({ error: err.message });
        }
        const mapped = (rows || []).map(r => ({
            ...r,
            rentalStartedAt: r.rentalStartedAt || r.rentalstartedat,
            rentalExpiresAt: r.rentalExpiresAt || r.rentalexpiresat,
            rentalExtensions: r.rentalExtensions || r.rental_extensions || [],
            pricingMode: r.pricingMode || r.pricing_mode,
            estimatedHours: r.estimatedHours !== undefined ? r.estimatedHours : r.estimated_hours,
            totalCustomerPrice: r.totalCustomerPrice !== undefined ? r.totalCustomerPrice : r.totalcustomerprice,
            marshalPhoto: generateSignedUploadUrl(r.marshalPhoto)
        }));
        res.json(mapped);
    });
});

async function isGarageMediaAuthorized(garageId, referenceId) {
    if (!garageId || !referenceId) return false;
    if (referenceId === garageId) return true;
    
    try {
        // 1. Check if referenceId is a garage worker for this garage
        const workerRes = await pool.query("SELECT id FROM garage_workers WHERE id = $1 AND garageid = $2", [referenceId, garageId]);
        if (workerRes && workerRes.rows && workerRes.rows.length > 0) return true;

        // 2. Check if referenceId is a service request assigned to this garage
        const srRes = await pool.query("SELECT id FROM service_requests WHERE id = $1 AND garageid = $2", [referenceId, garageId]);
        if (srRes && srRes.rows && srRes.rows.length > 0) return true;

        // 3. Check if referenceId is a trip for this garage
        const tripRes = await pool.query("SELECT t.id FROM trips t JOIN service_requests sr ON t.servicerequestid = sr.id WHERE t.id = $1 AND sr.garageid = $2", [referenceId, garageId]);
        if (tripRes && tripRes.rows && tripRes.rows.length > 0) return true;

        // Fallback check for SQLite
        return new Promise((resolve) => {
            db.get("SELECT id FROM garage_workers WHERE id = ? AND garageId = ?", [referenceId, garageId], (e1, w) => {
                if (w) return resolve(true);
                db.get("SELECT id FROM service_requests WHERE id = ? AND garageId = ?", [referenceId, garageId], (e2, sr) => {
                    if (sr) return resolve(true);
                    db.get("SELECT t.id FROM trips t JOIN service_requests sr ON t.serviceRequestId = sr.id WHERE t.id = ? AND sr.garageId = ?", [referenceId, garageId], (e3, tr) => {
                        resolve(!!tr);
                    });
                });
            });
        });
    } catch {
        return false;
    }
}

apiRouter.get('/media', authMiddleware, requireRole('admin', 'garage'), async (req, res) => {
    const { referenceId } = req.query;

    if (req.user.role === 'garage') {
        const garageId = req.user.garageId || req.user.id;
        if (!garageId) {
            return res.status(403).json({ error: 'Forbidden: No garage association found for this user.' });
        }

        if (!referenceId) {
            return res.status(400).json({ error: 'referenceId is required for garage role media queries.' });
        }

        const isAuthorized = await isGarageMediaAuthorized(garageId, referenceId);
        if (!isAuthorized) {
            return res.status(403).json({ error: 'Forbidden: You do not have permission to view media for this entity.' });
        }

        db.all("SELECT * FROM media WHERE referenceId = ?", [referenceId], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const mapped = (rows || []).map(r => ({
                ...r,
                filePath: generateSignedUploadUrl(r.filePath || r.filepath),
                filepath: generateSignedUploadUrl(r.filepath || r.filePath)
            }));
            res.json(mapped);
        });
    } else {
        // Admin: can fetch all media or filter by referenceId
        let query = "SELECT * FROM media";
        let params = [];
        if (referenceId) {
            query += " WHERE referenceId = ?";
            params.push(referenceId);
        }
        db.all(query, params, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const mapped = (rows || []).map(r => ({
                ...r,
                filePath: generateSignedUploadUrl(r.filePath || r.filepath),
                filepath: generateSignedUploadUrl(r.filepath || r.filePath)
            }));
            res.json(mapped);
        });
    }
});

// --- AUTH ---
apiRouter.post('/auth/login', loginLimiter, async (req, res) => {
    const { identifier, password } = req.body;
    if (!identifier || !password)
        return res.status(400).json({ error: 'Identifier and password are required' });
    db.get("SELECT * FROM users WHERE (email = ? OR phone = ?)", [identifier, identifier], async (err, user) => {
        if (err) {
            console.error("Login database error:", err.message);
            return res.status(500).json({ error: 'Database execution failure' });
        }
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });
        // Support both bcrypt hashes and legacy plaintext (migration path)
        let valid = false;
        if (user.password && user.password.startsWith('$2')) {
            valid = await bcrypt.compare(password, user.password);
        } else {
            valid = (password === user.password); // legacy plaintext
        }
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
        const token = signToken({ id: user.id, role: user.role, garageId: user.garageId }, user.token_version || user.tokenversion || 1);
        res.json({ ...signUserKycUrls(user), password: undefined, token });
    });
});

apiRouter.post('/auth/logout', authMiddleware, async (req, res) => {
    try {
        await revokeUserSessions(req.user.id);
        res.json({ success: true, message: 'Logged out successfully. All sessions revoked.' });
    } catch (err) {
        res.status(500).json({ error: 'Logout failed: ' + err.message });
    }
});

// --- FAST2SMS OTP DISPATCH HELPER (SMS) ---
async function sendFast2SmsOtp(phone, otp) {
    if (!phone || !otp) return;
    if (process.env.FAST2SMS_DISABLE_PLAIN_SMS === 'true') {
        console.log('[FAST2SMS] Plain SMS disabled via config (FAST2SMS_DISABLE_PLAIN_SMS=true). Skipping SMS OTP send.');
        return { return: false, message: 'Plain SMS disabled via configuration' };
    }
    const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
    if (cleanPhone.length !== 10) {
        console.warn('[FAST2SMS] Invalid 10-digit phone number:', phone);
        return;
    }
    const apiKey = process.env.FAST2SMS_API_KEY;
    if (!apiKey) {
        console.warn('[FAST2SMS] FAST2SMS_API_KEY is not configured in environment.');
        return;
    }
    try {
        const message = `Your ReDrivo verification code is: ${otp}. Valid for 10 minutes. Do not share with anyone.`;
        const url = `https://www.fast2sms.com/dev/bulkV2?authorization=${encodeURIComponent(apiKey)}&route=q&message=${encodeURIComponent(message)}&flash=0&numbers=${encodeURIComponent(cleanPhone)}`;
        const res = await fetch(url);
        const data = await res.json().catch(() => null);
        if (data && data.return === false) {
            console.warn('[FAST2SMS] Fast2SMS dispatch response:', JSON.stringify(data));
        } else {
            console.log(`[FAST2SMS] OTP dispatched successfully to ${cleanPhone.slice(0, 2)}******${cleanPhone.slice(-2)} | Response:`, JSON.stringify(data));
        }
        return data;
    } catch (err) {
        console.warn('[FAST2SMS] SMS dispatch failed (non-fatal):', err.message);
    }
}

// --- TRANSACTIONAL SMS NOTIFICATION DISPATCH HELPER ---
async function sendTransactionalSms(phone, message) {
    if (!phone || !message) return;
    if (process.env.FAST2SMS_DISABLE_PLAIN_SMS === 'true') {
        console.log('[SMS_ALERT] Plain SMS disabled via config (FAST2SMS_DISABLE_PLAIN_SMS=true). Skipping SMS alert.');
        return { return: false, message: 'Plain SMS disabled via configuration' };
    }
    const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
    if (cleanPhone.length !== 10) {
        console.warn('[SMS_ALERT] Invalid 10-digit phone number:', phone);
        return;
    }
    const apiKey = process.env.FAST2SMS_API_KEY;
    if (!apiKey) {
        console.warn('[SMS_ALERT] FAST2SMS_API_KEY is not configured in environment. SMS dispatch skipped.');
        return;
    }
    try {
        const url = `https://www.fast2sms.com/dev/bulkV2?authorization=${encodeURIComponent(apiKey)}&route=q&message=${encodeURIComponent(message)}&flash=0&numbers=${encodeURIComponent(cleanPhone)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const data = await res.json().catch(() => null);
        if (data && data.return === false) {
            console.warn('[SMS_ALERT] Fast2SMS dispatch response:', JSON.stringify(data));
        } else {
            console.log(`[SMS_ALERT] SMS dispatched successfully to ${cleanPhone.slice(0, 2)}******${cleanPhone.slice(-2)} | Message: "${message.slice(0, 50)}..."`);
        }
        return data;
    } catch (err) {
        console.warn('[SMS_ALERT] SMS dispatch failed (non-fatal):', err.message);
    }
}

// Helper to look up customer id, phone, name & email for a trip
async function getTripCustomerInfo(trip, clientOrPool = pool) {
    if (!trip) return null;
    try {
        let custId = trip.customerid || trip.customerId || null;
        let custPhone = null;
        let custName = null;
        let custEmail = null;
        const srId = trip.servicerequestid || trip.serviceRequestId || trip.sr_id;

        if (custId) {
            const cRes = await clientOrPool.query(
                "SELECT id, phone, name, email FROM customers WHERE id = $1 UNION SELECT id, phone, name, email FROM users WHERE id = $1",
                [custId]
            );
            if (cRes.rows[0]) {
                custId = cRes.rows[0].id || custId;
                custPhone = cRes.rows[0].phone;
                custName = cRes.rows[0].name;
                custEmail = cRes.rows[0].email;
            }
        }
        if ((!custPhone || !custId) && srId) {
            const srRes = await clientOrPool.query(`
                SELECT COALESCE(c.id, u.id) as id, COALESCE(c.phone, u.phone) as phone, COALESCE(c.name, u.name) as name, COALESCE(c.email, u.email) as email
                FROM service_requests sr
                LEFT JOIN customers c ON sr.customerId = c.id
                LEFT JOIN users u ON sr.customerId = u.id
                WHERE sr.id = $1
            `, [srId]);
            if (srRes.rows[0]) {
                custId = custId || srRes.rows[0].id;
                custPhone = custPhone || srRes.rows[0].phone;
                custName = custName || srRes.rows[0].name;
                custEmail = custEmail || srRes.rows[0].email;
            }
        }
        return { id: custId, phone: custPhone, name: custName, email: custEmail };
    } catch (err) {
        console.warn('[TRIP_CUSTOMER_LOOKUP_ERROR]', err.message);
        return { id: trip.customerid || trip.customerId || null, phone: null, name: null, email: null };
    }
}

// Branded HTML Generator for Cancellation & Refund Receipts
function generateCancellationEmailHtml({ trip, cust, tier, refundAmount, customerFee, originalFare, reason }) {
    const customerName = cust?.name || 'Valued Customer';
    const tripId = trip?.id || 'N/A';
    const tripShortId = tripId.length > 8 ? tripId.slice(0, 8).toUpperCase() : tripId;
    const formattedDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
    const totalPrepaid = parseFloat(originalFare || (refundAmount + customerFee)).toFixed(2);
    const formattedFee = parseFloat(customerFee || 0).toFixed(2);
    const formattedRefund = parseFloat(refundAmount || 0).toFixed(2);

    let tierHeading = 'Trip Cancellation & Settlement';
    let tierBadge = 'CANCELLED';
    let tierBadgeColor = '#ef4444';
    let tierBadgeBg = '#fee2e2';
    let tierDescription = 'Your booking has been cancelled. Below is your detailed settlement breakdown and refund status.';

    if (tier === 'tier1_free_cancel') {
        tierHeading = 'Trip Cancelled (Free Window)';
        tierBadge = '100% REFUNDED';
        tierBadgeColor = '#059669';
        tierBadgeBg = '#d1fae5';
        tierDescription = 'Your booking was cancelled within the free 3-minute cancellation window. No cancellation fee was charged, and a full 100% refund has been initiated.';
    } else if (tier === 'tier2_standard_cancel') {
        tierHeading = 'Trip Cancelled En Route';
        tierBadge = 'FEE APPLIED';
        tierBadgeColor = '#d97706';
        tierBadgeBg = '#fef3c7';
        tierDescription = 'Your booking was cancelled while your assigned driver was en route. A standard cancellation fee was deducted to compensate the driver for transit time.';
    } else if (tier === 'tier3_driver_noshow') {
        tierHeading = 'Driver Arrival Timeout — Full Refund';
        tierBadge = '100% REFUNDED';
        tierBadgeColor = '#059669';
        tierBadgeBg = '#d1fae5';
        tierDescription = 'We sincerely apologize — your driver was unable to reach your pickup location within the designated arrival window. A full 100% refund has been processed.';
    } else if (tier === 'tier4_customer_noshow') {
        tierHeading = 'Customer No-Show Settlement';
        tierBadge = 'NO-SHOW FEE';
        tierBadgeColor = '#dc2626';
        tierBadgeBg = '#fee2e2';
        tierDescription = 'The driver arrived at your pickup location and waited for the required arrival grace period. A no-show fee was applied to compensate the driver.';
    }

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${tierHeading}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1f2937;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f3f4f6; padding: 30px 15px;">
        <tr>
            <td align="center">
                <table role="presentation" width="100%" style="max-width: 560px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);">
                    <!-- Header -->
                    <tr>
                        <td style="background-color: #0f172a; padding: 24px 30px; text-align: left;">
                            <table width="100%" cellspacing="0" cellpadding="0">
                                <tr>
                                    <td>
                                        <h1 style="margin: 0; color: #ffffff; font-size: 22px; font-weight: 800; letter-spacing: -0.5px;">ReDrivo</h1>
                                        <p style="margin: 2px 0 0 0; color: #94a3b8; font-size: 12px; letter-spacing: 0.5px; text-transform: uppercase;">Professional On-Demand Drivers</p>
                                    </td>
                                    <td align="right">
                                        <span style="display: inline-block; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; background-color: ${tierBadgeBg}; color: ${tierBadgeColor};">
                                            ${tierBadge}
                                        </span>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- Body Content -->
                    <tr>
                        <td style="padding: 30px;">
                            <h2 style="margin: 0 0 10px 0; color: #0f172a; font-size: 18px; font-weight: 700;">${tierHeading}</h2>
                            <p style="margin: 0 0 20px 0; color: #4b5563; font-size: 14px; line-height: 1.5;">
                                Hi <strong>${customerName}</strong>,
                            </p>
                            <p style="margin: 0 0 24px 0; color: #4b5563; font-size: 14px; line-height: 1.5;">
                                ${tierDescription}
                            </p>

                            <!-- Breakdown Card -->
                            <table width="100%" cellspacing="0" cellpadding="0" style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 24px;">
                                <tr>
                                    <td style="padding: 16px 20px; border-bottom: 1px solid #e2e8f0;">
                                        <table width="100%" cellspacing="0" cellpadding="0">
                                            <tr>
                                                <td style="color: #64748b; font-size: 13px;">Booking Reference</td>
                                                <td align="right" style="color: #0f172a; font-size: 13px; font-family: monospace; font-weight: 600;">#${tripShortId}</td>
                                            </tr>
                                            <tr>
                                                <td style="color: #64748b; font-size: 13px; padding-top: 6px;">Date & Time</td>
                                                <td align="right" style="color: #0f172a; font-size: 13px; font-weight: 500; padding-top: 6px;">${formattedDate}</td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding: 16px 20px;">
                                        <table width="100%" cellspacing="0" cellpadding="0">
                                            <tr>
                                                <td style="color: #64748b; font-size: 14px;">Prepaid Booking Amount</td>
                                                <td align="right" style="color: #0f172a; font-size: 14px; font-weight: 600;">₹${totalPrepaid}</td>
                                            </tr>
                                            <tr>
                                                <td style="color: #64748b; font-size: 14px; padding-top: 8px;">Cancellation / No-Show Fee</td>
                                                <td align="right" style="color: #dc2626; font-size: 14px; font-weight: 600; padding-top: 8px;">- ₹${formattedFee}</td>
                                            </tr>
                                            <tr>
                                                <td colspan="2" style="padding-top: 12px; padding-bottom: 12px;">
                                                    <div style="height: 1px; background-color: #cbd5e1;"></div>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td style="color: #0f172a; font-size: 15px; font-weight: 700;">Net Refund Amount</td>
                                                <td align="right" style="color: #059669; font-size: 16px; font-weight: 800;">₹${formattedRefund}</td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>

                            <!-- Refund Details -->
                            <div style="background-color: #ecfdf5; border-left: 4px solid #10b981; padding: 12px 16px; border-radius: 4px; margin-bottom: 24px;">
                                <p style="margin: 0; color: #065f46; font-size: 13px; line-height: 1.4;">
                                    <strong>Refund Status:</strong> Initiated to your original payment method. Depending on your bank/UPI provider, funds typically reflect in <strong>3-5 business days</strong>.
                                </p>
                            </div>

                            <!-- Dispute Notice -->
                            <p style="margin: 0; color: #64748b; font-size: 12px; line-height: 1.5;">
                                Have questions or believe this was recorded incorrectly? You can file a dispute directly in the <strong>ReDrivo App</strong> or reply to this email at <a href="mailto:support@redrivo.in" style="color: #2563eb; text-decoration: none;">support@redrivo.in</a>.
                            </p>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="background-color: #f8fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
                            <p style="margin: 0 0 4px 0; color: #94a3b8; font-size: 12px;">
                                © ${new Date().getFullYear()} ReDrivo Inc. All rights reserved.
                            </p>
                            <p style="margin: 0; color: #94a3b8; font-size: 11px;">
                                Bangalore, Karnataka, India • <a href="https://redrivo.in" style="color: #94a3b8; text-decoration: underline;">redrivo.in</a>
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
    `.trim();
}

// Transactional Email Receipt Dispatcher
async function sendCancellationEmailReceipt({ trip, cust, tier, refundAmount, customerFee, originalFare, reason }) {
    if (!cust || !cust.email) {
        console.log(`[EMAIL_RECEIPT] Skipped - no email on file for customer (${cust?.id || cust?.phone || trip?.customerid || 'unknown'})`);
        return { skipped: true, reason: 'no_email' };
    }
    try {
        const fromEmail = process.env.RESEND_FROM_EMAIL || '"ReDrivo Support" <support@redrivo.in>';
        const tripId = trip?.id || 'N/A';
        const tripShortId = tripId.length > 8 ? tripId.slice(0, 8).toUpperCase() : tripId;
        const subject = tier === 'tier3_driver_noshow'
            ? `ReDrivo Trip Update: Driver No-Show & Full Refund (#${tripShortId})`
            : `ReDrivo Cancellation & Refund Receipt (#${tripShortId})`;
        
        const html = generateCancellationEmailHtml({ trip, cust, tier, refundAmount, customerFee, originalFare, reason });
        const text = `ReDrivo Cancellation Receipt for Trip #${tripId}.\nTier: ${tier}\nOriginal Amount: ₹${(originalFare || (refundAmount + customerFee)).toFixed(2)}\nCancellation Fee: ₹${customerFee.toFixed(2)}\nNet Refund Amount: ₹${refundAmount.toFixed(2)}\nRefund has been processed to your original payment method. Contact support@redrivo.in for questions.`;

        console.log(`[EMAIL_RECEIPT] Dispatching cancellation receipt to ${cust.email} for Trip #${tripShortId} (${tier})...`);
        const result = await transporter.sendMail({
            from: fromEmail,
            to: cust.email,
            subject: subject,
            text: text,
            html: html
        });
        return result;
    } catch (err) {
        console.warn('[EMAIL_RECEIPT_ERROR]', err.message);
        return { error: err.message };
    }
}

// --- DIRECT META CLOUD API WHATSAPP OTP DISPATCH HELPER ---
async function sendDirectMetaWhatsAppOtp(phone, otp, templateName = 'otp_customer') {
    if (!phone || !otp) return { success: false, error: 'Phone and OTP are required' };
    const cleanPhone = '91' + String(phone).replace(/\D/g, '').slice(-10);
    if (cleanPhone.length !== 12) {
        console.warn('[META_WA] Invalid phone number:', phone);
        return { success: false, error: 'Invalid phone number' };
    }

    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '1329557343567092';
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!token) {
        console.warn('[META_WA] WHATSAPP_ACCESS_TOKEN is not configured in environment.');
        return { success: false, error: 'WHATSAPP_ACCESS_TOKEN not configured' };
    }

    const templateLang = process.env.WHATSAPP_TEMPLATE_LANG || 'en_US';
    const targetTemplate = templateName || 'otp_customer';
    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
    
    const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: 'template',
        template: {
            name: targetTemplate,
            language: { code: templateLang },
            components: [
                {
                    type: 'body',
                    parameters: [{ type: 'text', text: String(otp) }]
                },
                {
                    type: 'button',
                    sub_type: 'url',
                    index: '0',
                    parameters: [{ type: 'text', text: String(otp) }]
                }
            ]
        }
    };

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5000)
        });

        const data = await res.json().catch(() => null);

        if (res.ok && data && data.messages?.[0]?.id) {
            console.log(`[META_WA] Direct WhatsApp OTP sent successfully to ${cleanPhone.slice(0, 4)}******${cleanPhone.slice(-2)} | Template: ${targetTemplate} | MessageId:`, data.messages[0].id);
            return { success: true, data };
        } else {
            const errMsg = data?.error?.message || res.statusText || 'Meta WhatsApp dispatch failed';
            console.warn(`[META_WA] Dispatch failed HTTP ${res.status} for template ${targetTemplate}:`, JSON.stringify(data));
            return { success: false, status: res.status, error: errMsg, details: data };
        }
    } catch (err) {
        console.warn(`[META_WA] Dispatch exception (${err.name}) for template ${targetTemplate}:`, err.message);
        return { success: false, error: err.message };
    }
}

// --- FAST2SMS WHATSAPP BUSINESS OTP DISPATCH HELPER ---
async function sendFast2SmsWhatsAppOtp(phone, otp, otpId) {
    if (!phone || !otp) return { success: false, error: 'Phone and OTP are required' };
    const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
    if (cleanPhone.length !== 10) {
        console.warn('[FAST2SMS_WA] Invalid 10-digit phone number:', phone);
        return { success: false, error: 'Invalid 10-digit phone number' };
    }

    const apiKey = process.env.FAST2SMS_API_KEY;
    if (!apiKey) {
        console.warn('[FAST2SMS_WA] FAST2SMS_API_KEY is not configured in environment.');
        return { success: false, error: 'FAST2SMS_API_KEY not configured' };
    }

    const targetOtpId = otpId || process.env.FAST2SMS_WHATSAPP_CUSTOMER_OTP_ID || '4b2f8dce17';
    const url = 'https://www.fast2sms.com/dev/otp/send';
    const payload = {
        otp_id: targetOtpId,
        mobile: cleanPhone,
        otp: String(otp),
        variables_values: String(otp)
    };

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'authorization': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5000)
        });

        const data = await res.json().catch(() => null);

        if (res.ok && data && (data.return === true || data.status_code === 200)) {
            console.log(`[FAST2SMS_WA] WhatsApp OTP sent successfully to ${cleanPhone.slice(0, 2)}******${cleanPhone.slice(-2)} | OTP ID: ${targetOtpId} | RequestId:`, data?.request_id || data?.message || 'OK');
            return { success: true, data };
        } else {
            const errMsg = Array.isArray(data?.message) ? data.message.join(', ') : (data?.message || res.statusText || 'Fast2SMS dispatch failed');
            console.warn(`[FAST2SMS_WA] Dispatch failed HTTP ${res.status}:`, JSON.stringify(data));
            return { success: false, status: res.status, error: errMsg, details: data };
        }
    } catch (err) {
        console.warn(`[FAST2SMS_WA] Dispatch exception (${err.name}):`, err.message);
        return { success: false, error: err.message };
    }
}

// --- UNIFIED OTP DISPATCH (3-LAYER: DIRECT META -> FAST2SMS DUAL DISPATCH FALLBACK) ---
async function sendUnifiedOtp(phone, otp, role = 'customer', preferredChannel = 'sms') {
    if (!phone || !otp) return;
    const cleanChannel = String(preferredChannel || 'sms').toLowerCase().trim();
    
    // Role-based template selection for Direct Meta Cloud API WhatsApp
    const metaTemplateName = (role === 'marshal' || role === 'driver') ? 'otp_driver_v2' : 'otp_customer';
    
    // Role-based template selection for Fast2SMS WhatsApp
    const customerOtpId = process.env.FAST2SMS_WHATSAPP_CUSTOMER_OTP_ID || '4b2f8dce17';
    const driverOtpId = process.env.FAST2SMS_WHATSAPP_DRIVER_OTP_ID || customerOtpId;
    const fast2SmsOtpId = (role === 'marshal' || role === 'driver') ? driverOtpId : customerOtpId;

    // --- LAYER 1: Attempt Direct Meta Cloud API WhatsApp (5s Timeout) ---
    if (process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) {
        console.log(`[UNIFIED_OTP] Layer 1: Attempting Direct Meta WhatsApp for role=${role}, template=${metaTemplateName} to ${phone}...`);
        const metaRes = await sendDirectMetaWhatsAppOtp(phone, otp, metaTemplateName);
        if (metaRes && metaRes.success) {
            console.log(`[UNIFIED_OTP] Layer 1 Success: Direct Meta WhatsApp OTP (${metaTemplateName}) delivered to ${phone}`);
            return { channel: 'meta_whatsapp', success: true, meta: metaRes };
        }
        console.warn(`[UNIFIED_OTP] Layer 1 Failed (${metaRes?.error || 'Unknown'}). Falling back to Layer 2/3 (Fast2SMS Dual Dispatch)...`);
    }

    // --- LAYER 2 & 3: Fallback Fast2SMS Dual-Dispatch (SMS + Fast2SMS WhatsApp) ---
    console.log(`[UNIFIED_OTP] Layer 2/3: Executing Fast2SMS Dual Dispatch (SMS + WhatsApp) for role=${role}, channel=${cleanChannel} to ${phone} (Fast2SMS OTP ID: ${fast2SmsOtpId})...`);
    const results = await Promise.allSettled([
        sendFast2SmsOtp(phone, otp),
        sendFast2SmsWhatsAppOtp(phone, otp, fast2SmsOtpId)
    ]);

    const smsRes = results[0].status === 'fulfilled' ? results[0].value : { return: false, error: results[0].reason?.message };
    const waRes = results[1].status === 'fulfilled' ? results[1].value : { success: false, error: results[1].reason?.message };

    console.log(`[UNIFIED_OTP] Dual dispatch results -> SMS:`, JSON.stringify(smsRes), `| WhatsApp:`, JSON.stringify(waRes));

    if ((smsRes && smsRes.return !== false) || (waRes && waRes.success)) {
        return {
            channel: 'fast2sms_dual_sms_whatsapp',
            success: true,
            sms: smsRes,
            whatsapp: waRes
        };
    }
    return { channel: 'failed', success: false, sms: smsRes, whatsapp: waRes };
}

apiRouter.get('/system/meta-token-inspection', async (req, res) => {
    const token = process.env.WHATSAPP_ACCESS_TOKEN || '';
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID || '1329557343567092';
    const wabaId = req.query.waba_id || '1935784290711470';
    const appId = '4633212553569336';
    
    if (!token) {
        return res.json({ configured: false, error: 'WHATSAPP_ACCESS_TOKEN is not configured on server.' });
    }

    const tokenMeta = {
        configured: true,
        length: token.length,
        first6: token.substring(0, 6),
        last6: token.substring(token.length - 6),
        phoneId: phoneId,
        wabaId: wabaId
    };

    const fetchMeta = async (url) => {
        try {
            const r = await fetch(url, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await r.json().catch(e => ({ error: e.message }));
            return { httpStatus: r.status, data };
        } catch (err) {
            return { httpStatus: 500, error: err.message };
        }
    };

    // 1. Debug token
    const debugToken = await fetchMeta(`https://graph.facebook.com/v21.0/debug_token?input_token=${token}&access_token=${token}`);
    
    // 2. Me
    const meData = await fetchMeta(`https://graph.facebook.com/v21.0/me?access_token=${token}`);
    
    // 3. App
    const appData = await fetchMeta(`https://graph.facebook.com/v21.0/app?access_token=${token}`);

    // 4. Subscribed Apps & WABA Namespace Queries
    const appSubscribedApps = await fetchMeta(`https://graph.facebook.com/v21.0/${appId}/subscribed_apps`);
    const wabaNamespaceAndDetails = await fetchMeta(`https://graph.facebook.com/v21.0/${wabaId}?fields=id,name,message_template_namespace`);
    const wabaSubscribedAppsBefore = await fetchMeta(`https://graph.facebook.com/v21.0/${wabaId}/subscribed_apps`);

    // 5. Attempt explicit POST to link App to WABA: POST /1935784290711470/subscribed_apps
    let postSubscribedAppsResult = null;
    try {
        const subPostRes = await fetch(`https://graph.facebook.com/v21.0/${wabaId}/subscribed_apps`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });
        postSubscribedAppsResult = {
            httpStatus: subPostRes.status,
            data: await subPostRes.json().catch(e => ({ error: e.message }))
        };
    } catch (subPostErr) {
        postSubscribedAppsResult = { error: subPostErr.message };
    }

    const wabaSubscribedAppsAfter = await fetchMeta(`https://graph.facebook.com/v21.0/${wabaId}/subscribed_apps`);


    // Phone Registration Call: POST /1329557343567092/register
    const registrationPin = req.query.pin || '628924';
    let registrationResult = null;
    try {
        const regRes = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/register`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                pin: registrationPin
            })
        });
        registrationResult = {
            pinUsed: registrationPin,
            httpStatus: regRes.status,
            data: await regRes.json().catch(e => ({ error: e.message }))
        };
    } catch (regErr) {
        registrationResult = { pinUsed: registrationPin, error: regErr.message };
    }

    // Phone Status Check: GET /1329557343567092
    const phoneStatusAfter = await fetchMeta(`https://graph.facebook.com/v21.0/${phoneId}?fields=id,display_phone_number,verified_name,quality_rating,name_status,messaging_limit_tier,code_verification_status,status`);

    let testSendResult = null;
    if (req.query.phone) {
        const testPhone = String(req.query.phone).replace(/\D/g, '').slice(-10);
        const testOtp = req.query.otp || '123456';
        const role = req.query.role || 'customer';
        const targetTemplate = (role === 'marshal' || role === 'driver') ? 'otp_driver_v2' : 'otp_customer';
        
        try {
            const sendRes = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    messaging_product: 'whatsapp',
                    to: '91' + testPhone,
                    type: 'template',
                    template: {
                        name: targetTemplate,
                        language: { code: 'en_US' },
                        components: [
                            {
                                type: 'body',
                                parameters: [{ type: 'text', text: String(testOtp) }]
                            },
                            {
                                type: 'button',
                                sub_type: 'url',
                                index: '0',
                                parameters: [{ type: 'text', text: String(testOtp) }]
                            }
                        ]
                    }
                })
            });
            testSendResult = {
                status: sendRes.status,
                data: await sendRes.json()
            };
        } catch (sendErr) {
            testSendResult = { error: sendErr.message };
        }
    }

    res.json({
        tokenMeta,
        appSubscribedApps,
        wabaNamespaceAndDetails,
        wabaSubscribedAppsBefore,
        postSubscribedAppsResult,
        wabaSubscribedAppsAfter,
        phoneStatusAfter,
        testSendResult
    });
});

apiRouter.get('/admin/test-whatsapp', authMiddleware, requireRole('admin'), async (req, res) => {
    const phone = req.query.phone || '9093184965';
    const otp = req.query.otp || '123456';
    const role = req.query.role || 'customer';
    const preferredChannel = req.query.channel || 'whatsapp';
    const customOtpId = req.query.otp_id || null;

    if (!process.env.FAST2SMS_API_KEY) {
        return res.json({
            configured: false,
            error: 'FAST2SMS_API_KEY is not configured in environment.'
        });
    }

    try {
        const start = Date.now();
        const result = customOtpId 
            ? await sendFast2SmsWhatsAppOtp(phone, otp, customOtpId)
            : await sendUnifiedOtp(phone, otp, role, preferredChannel);
        res.json({
            configured: true,
            targetPhone: phone,
            role,
            preferredChannel,
            customOtpId: customOtpId || process.env.FAST2SMS_WHATSAPP_CUSTOMER_OTP_ID || '4b2f8dce17',
            latencyMs: Date.now() - start,
            result
        });
    } catch (err) {
        res.status(500).json({
            configured: true,
            error: err.message
        });
    }
});

apiRouter.get('/admin/test-fast2sms', authMiddleware, requireRole('admin'), async (req, res) => {
    const phone = req.query.phone || '9093184965';
    const otp = req.query.otp || '123456';
    const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
    const apiKey = process.env.FAST2SMS_API_KEY;

    if (!apiKey) {
        return res.json({
            configured: false,
            error: 'FAST2SMS_API_KEY is not configured in environment.'
        });
    }

    try {
        const message = `Your ReDrivo verification code is: ${otp}. Valid for 10 minutes. Do not share with anyone.`;
        const url = `https://www.fast2sms.com/dev/bulkV2?authorization=${encodeURIComponent(apiKey)}&route=q&message=${encodeURIComponent(message)}&flash=0&numbers=${encodeURIComponent(cleanPhone)}`;
        const start = Date.now();
        const apiRes = await fetch(url);
        const rawText = await apiRes.text();
        let jsonData = null;
        try { jsonData = JSON.parse(rawText); } catch (e) {}

        res.json({
            configured: true,
            apiKeyPrefix: apiKey.slice(0, 4) + '****',
            targetPhone: cleanPhone,
            httpStatus: apiRes.status,
            latencyMs: Date.now() - start,
            fast2smsResponse: jsonData || rawText
        });

    } catch (err) {
        res.status(500).json({
            configured: true,
            error: err.message
        });
    }
});

apiRouter.get('/admin/test-fcm', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
        if (!fcmInitialized) {
            return res.json({
                fcmInitialized: false,
                message: 'Firebase Admin is not initialized. Check FIREBASE_SERVICE_ACCOUNT environment variable.'
            });
        }

        const testToken = req.query.token || 'fake_test_token_for_fcm_verification';
        let fcmResult;
        try {
            fcmResult = await getMessaging().send({
                token: testToken,
                notification: { title: 'Test Ping', body: 'FCM verification' }
            });
        } catch (apiErr) {
            fcmResult = {
                code: apiErr.code || 'unknown',
                message: apiErr.message,
                status: 'Google FCM API successfully reached and authenticated'
            };
        }

        res.json({
            fcmInitialized: true,
            projectId: 'gearx-marshal',
            fcmResult
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

apiRouter.get('/admin/test-email', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
        const targetEmail = req.query.email || 'subanghosh7@gmail.com';
        const fromEmail = process.env.RESEND_FROM_EMAIL || '"ReDrivo" <support@redrivo.in>';
        const isResend = !!process.env.RESEND_API_KEY;

        const info = await transporter.sendMail({
            from: fromEmail,
            to: targetEmail,
            subject: 'ReDrivo Email Gateway Test',
            text: 'This is a live test email from ReDrivo via Resend. If you received this, real production email delivery is operating correctly.',
            html: generateOtpEmailHtml('748209', 'ReDrivo Email Gateway Test', 'This is a live test email from ReDrivo via Resend. If you received this, real production email delivery is operating correctly.')
        });

        res.json({
            success: true,
            provider: isResend ? 'Resend HTTPS API' : 'Ethereal Mock',
            from: fromEmail,
            to: targetEmail,
            messageId: info.messageId,
            response: info.response
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

/**
 * Strict Database-Backed Test Account Check
 * ONLY allows test-mode bypass (static OTP 123456) if an existing account record
 * in the database (users or customers table) is explicitly flagged with is_test = true OR is_test_account = true.
 * NO regex heuristics, NO repeated-digit checks, NO string shape pattern-matching.
 */
async function isExplicitlyFlaggedTestAccount({ email, phone } = {}) {
    const val = phone || email;
    if (!val) return false;

    try {
        const rawPhone = phone ? String(phone).replace(/[\s\-]/g, '') : (String(val).includes('@') ? null : String(val).replace(/[\s\-]/g, ''));
        const cleanVal = rawPhone ? rawPhone.replace('+91', '') : null;
        const prefixedVal = rawPhone ? (rawPhone.startsWith('+91') ? rawPhone : '+91' + rawPhone) : null;
        const finalEmail = email ? String(email).trim().toLowerCase() : (String(val).includes('@') ? String(val).trim().toLowerCase() : null);

        // 1. Check users table for explicit test flag
        const userRes = await pool.query(
            `SELECT id FROM users 
             WHERE (($1::text IS NOT NULL AND phone IN ($1, $2)) OR ($3::text IS NOT NULL AND LOWER(email) = $3)) 
               AND (is_test = true OR is_test_account = true) 
             LIMIT 1`,
            [cleanVal, prefixedVal, finalEmail]
        );
        if (userRes.rows.length > 0) return true;

        // 2. Check customers table for explicit test flag
        const custRes = await pool.query(
            `SELECT id FROM customers 
             WHERE (($1::text IS NOT NULL AND phone IN ($1, $2)) OR ($3::text IS NOT NULL AND LOWER(email) = $3)) 
               AND (is_test = true OR is_test_account = true) 
             LIMIT 1`,
            [cleanVal, prefixedVal, finalEmail]
        );
        if (custRes.rows.length > 0) return true;
    } catch (err) {
        console.error('[AUTH] isExplicitlyFlaggedTestAccount DB error:', err.message);
    }
    return false;
}

apiRouter.post('/auth/send-otp', otpLimiter, async (req, res) => {
    const { email, phone, role, preferredChannel = 'sms' } = req.body;
    if (!phone && !email)
        return res.status(400).json({ error: 'Phone or email is required' });

    if (role === 'admin') {
        const allowedAdminEmails = (process.env.ADMIN_EMAILS || 'subanghosh7@gmail.com').split(',').map(e => e.trim().toLowerCase());
        const reqEmail = (email || '').trim().toLowerCase();
        if (!reqEmail || !allowedAdminEmails.includes(reqEmail)) {
            return res.status(403).json({ error: 'Access restricted: Unauthorized administrator email address.' });
        }
    }

    if (role === 'investor') {
        const reqEmail = (email || '').trim().toLowerCase();
        if (!reqEmail || !reqEmail.includes('@')) {
            return res.status(400).json({ error: 'Valid investor email address is required.' });
        }
        const accessRes = await pool.query(
            "SELECT status FROM investor_access_requests WHERE LOWER(email) = $1 ORDER BY requested_at DESC LIMIT 1",
            [reqEmail]
        );
        if (accessRes.rows.length === 0) {
            return res.status(403).json({ error: 'No access request found for this email. Please submit a request on our investors page first.', accessStatus: 'not_found' });
        }
        const reqStatus = accessRes.rows[0].status;
        if (reqStatus === 'pending') {
            return res.status(403).json({ error: 'Your access request is currently pending administrative review.', accessStatus: 'pending' });
        }
        if (reqStatus === 'rejected') {
            return res.status(403).json({ error: 'Your access request was declined.', accessStatus: 'rejected' });
        }
    }

    // Clean expired OTPs (housekeeping)
    pool.query("DELETE FROM otp_verifications WHERE expiresat < NOW()").catch(() => {});

    // Persistent per-account rate limit: Max 5 OTP requests per 10 minutes
    try {
        const rateCheck = await pool.query(
            `SELECT COUNT(*) FROM otp_verifications 
             WHERE (phone = $1 OR email = $2) 
               AND createdat > NOW() - INTERVAL '10 minutes'`,
            [phone || null, email || null]
        );
        const recentAttempts = parseInt(rateCheck.rows[0]?.count || 0, 10);
        if (recentAttempts >= 5) {
            return res.status(429).json({ error: 'Too many OTP requests for this account. Please wait 10 minutes before requesting again.' });
        }
    } catch (rateErr) {
        console.warn('OTP rate limit check error:', rateErr.message);
    }

    const isTest = await isExplicitlyFlaggedTestAccount({ email, phone });
    const otp = isTest ? '123456' : String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    try {
        await pool.query(
            `INSERT INTO otp_verifications (entityid, entitytype, phone, email, otp, expiresat) VALUES ('TEMP', 'auth', $1, $2, $3, $4)`,
            [phone || null, email || null, otp, expiresAt]
        );

        if (phone && !isTest) {
            sendUnifiedOtp(phone, otp, role || 'customer', preferredChannel).catch(otpErr => {
                console.warn('[UNIFIED_OTP] OTP send error:', otpErr.message);
            });
        }

        if (email) {
            const fromEmail = process.env.RESEND_FROM_EMAIL || '"ReDrivo" <support@redrivo.in>';
            transporter.sendMail({
                from: fromEmail,
                to: email,
                subject: 'Your ReDrivo OTP',
                text: `Your OTP is: ${otp}. Valid for 10 minutes. Do not share with anyone.`,
                html: generateOtpEmailHtml(otp, 'Your ReDrivo OTP Code', 'Use the one-time verification code below to authenticate and sign in to your ReDrivo account.')
            }).then(info => {
                console.log(`[EMAIL] OTP sent successfully to: ${email} | MessageId: ${info.messageId}`);
            }).catch(mailErr => {
                console.warn('[EMAIL] Email send failed (non-fatal):', mailErr.message);
            });
        }
        // In production: remove otp from response, send via SMS/email only
        const resp = { message: 'OTP sent' };
        if (isTest) resp.otp = otp;
        res.json(resp);
    } catch (err) {
        console.error('send-otp DB error:', err.message);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

apiRouter.post('/auth/verify-otp', verifyOtpLimiter, async (req, res) => {
    const { phone, email, otp, role } = req.body;
    if (!otp || otp.length !== 6) return res.status(400).json({ error: 'OTP must be 6 digits' });
    const val = phone || email;
    if (!val) return res.status(400).json({ error: 'Phone or email required' });

    try {
        // Find valid OTP or accept 123456 ONLY if the account is explicitly flagged as a test account in the DB
        const isTest = await isExplicitlyFlaggedTestAccount({ email: val, phone: val });
        let otpValid = false;
        if (isTest && otp === '123456') {
            otpValid = true;
        } else {
            const otpResult = await pool.query(
                `SELECT * FROM otp_verifications WHERE (phone = $1 OR email = $1) AND otp = $2 AND verifiedat IS NULL AND expiresat > NOW() ORDER BY id DESC LIMIT 1`,
                [val, otp]
            );
            const row = otpResult.rows[0];
            if (row) {
                otpValid = true;
                await pool.query(`UPDATE otp_verifications SET verifiedat = NOW() WHERE id = $1`, [row.id]);
            }
        }
        if (!otpValid) return res.status(400).json({ error: 'Invalid or expired OTP' });

        const cleanVal = val.replace('+91', '');
        const prefixedVal = val.startsWith('+91') ? val : '+91' + val;
        const isEmailInput = val.includes('@') || (email && email.includes('@'));
        const finalEmail = email ? email.trim().toLowerCase() : (isEmailInput ? val.trim().toLowerCase() : null);
        const finalPhone = isEmailInput ? (phone ? (phone.startsWith('+91') ? phone : '+91' + phone) : null) : prefixedVal;

        const buildResponse = async (userObj, isNewUser = false) => {
            // Update phone or email verification status
            if (isEmailInput) {
                await pool.query(`UPDATE users SET emailverified = 1 WHERE id = $1`, [userObj.id]).catch(() => {});
                await pool.query(`UPDATE garage_workers SET emailverified = 1 WHERE id = $1`, [userObj.id]).catch(() => {});
                userObj.emailverified = 1;
                userObj.emailVerified = 1;
            } else {
                await pool.query(`UPDATE users SET phoneverified = 1 WHERE id = $1`, [userObj.id]).catch(() => {});
                await pool.query(`UPDATE garage_workers SET phoneverified = 1 WHERE id = $1`, [userObj.id]).catch(() => {});
                userObj.phoneverified = 1;
                userObj.phoneVerified = 1;
            }

            const token = signToken({ id: userObj.id, role: userObj.role, garageId: userObj.garageId || null }, userObj.token_version || userObj.tokenversion || 1);
            return res.json({ verified: true, isNewUser, token, user: userObj });
        };

        // Admin Authentication: (1) Whitelist Check, (2) Role-specific row lookup/creation, (3) JWT issuance
        if (role === 'admin') {
            const allowedAdminEmails = (process.env.ADMIN_EMAILS || 'subanghosh7@gmail.com').split(',').map(e => e.trim().toLowerCase());
            if (!finalEmail || !allowedAdminEmails.includes(finalEmail)) {
                return res.status(403).json({ error: 'Access restricted: Unauthorized administrator email address.' });
            }
            let adminUserRes = await pool.query(
                `SELECT * FROM users WHERE email = $1 AND role = 'admin' LIMIT 1`,
                [finalEmail]
            );
            let adminUser = adminUserRes.rows[0];
            let isNewAdmin = false;
            if (!adminUser) {
                const newAdminId = `usr_adm_${Date.now()}`;
                const insertAdmin = await pool.query(
                    `INSERT INTO users (id, name, role, email, status, emailverified) VALUES ($1, 'Admin', 'admin', $2, 'active', 1) RETURNING *`,
                    [newAdminId, finalEmail]
                );
                adminUser = insertAdmin.rows[0];
                isNewAdmin = true;
            }
            return await buildResponse(adminUser, isNewAdmin);
        }

        // Investor Authentication: (1) Approved Check, (2) Signed 7-Day JWT
        if (role === 'investor') {
            if (!finalEmail) {
                return res.status(400).json({ error: 'Email required for investor verification' });
            }
            const accessRes = await pool.query(
                "SELECT * FROM investor_access_requests WHERE LOWER(email) = $1 AND status = 'approved' ORDER BY requested_at DESC LIMIT 1",
                [finalEmail]
            );
            if (accessRes.rows.length === 0) {
                return res.status(403).json({ error: 'Access unauthorized: Investor access not approved or pending review.' });
            }
            const inv = accessRes.rows[0];
            const investorToken = jwt.sign(
                {
                    id: inv.id,
                    email: finalEmail,
                    role: 'investor',
                    name: inv.name || 'Investor',
                    tokenVersion: 1
                },
                JWT_SECRET,
                { expiresIn: '7d' }
            );
            return res.json({
                verified: true,
                token: investorToken,
                user: {
                    id: inv.id,
                    email: finalEmail,
                    name: inv.name || 'Investor',
                    organization: inv.organization || null,
                    role: 'investor'
                }
            });
        }

        const isCustomerApp = (!role || role === 'customer');

        // Step 1: Check users table
        const userResult = await pool.query(
            `SELECT * FROM users WHERE phone IN ($1, $2) OR email = $3 ORDER BY CASE WHEN role = $4 THEN 0 WHEN role = 'admin' THEN 1 ELSE 2 END LIMIT 1`,
            [cleanVal, prefixedVal, val, role || 'customer']
        );
        if (userResult.rows[0]) {
            const user = userResult.rows[0];

            // Customer App Role Guards
            if (isCustomerApp) {
                if (user.role === 'marshal') {
                    return res.status(403).json({ error: 'This account is registered as a driver partner. Please use the Driver app instead.' });
                }
                if (user.role === 'garage') {
                    return res.status(403).json({ error: 'This account is registered as a garage partner. Please use the Garage portal instead.' });
                }
            }

            if (user.role === 'customer' || (isCustomerApp && user.role === 'admin')) {
                const cleanCustId = user.id.replace('_user', '');
                await pool.query(`
                    INSERT INTO customers (id, name, phone, email, status)
                    VALUES ($1, $2, $3, $4, 'active')
                    ON CONFLICT (id) DO UPDATE SET
                        phone = COALESCE(EXCLUDED.phone, customers.phone),
                        email = COALESCE(EXCLUDED.email, customers.email)
                `, [cleanCustId, user.name || null, user.phone || finalPhone, user.email || finalEmail]).catch(() => {});
            }
            return await buildResponse({ 
                id: user.id, 
                name: user.name, 
                role: (isCustomerApp && user.role === 'admin') ? 'customer' : user.role, 
                garageId: user.garageId || user.garageid, 
                status: user.status, 
                kycStatus: user.kycStatus || user.kycstatus,
                phone: user.phone,
                email: user.email,
                token_version: user.token_version || user.tokenversion || 1
            });
        }

        // If this is the Customer App, check if phone/email belongs to a garage partner before attempting registration
        if (isCustomerApp) {
            const workerCheck = await pool.query(`SELECT id FROM garage_workers WHERE phone IN ($1, $2) LIMIT 1`, [cleanVal, prefixedVal]);
            if (workerCheck.rows[0]) {
                return res.status(403).json({ error: 'This account is registered as a garage partner. Please use the Garage portal instead.' });
            }
            const garageCheck = await pool.query(`SELECT id FROM garages WHERE contact IN ($1, $2) OR email = $3 LIMIT 1`, [cleanVal, prefixedVal, val]);
            if (garageCheck.rows[0]) {
                return res.status(403).json({ error: 'This account is registered as a garage partner. Please use the Garage portal instead.' });
            }
        }

        // Step 2: Garage worker
        const workerResult = await pool.query(
            `SELECT * FROM garage_workers WHERE phone IN ($1, $2) LIMIT 1`,
            [cleanVal, prefixedVal]
        );
        if (workerResult.rows[0]) {
            const worker = workerResult.rows[0];
            return await buildResponse({ 
                id: worker.id, 
                name: worker.name, 
                role: worker.role || 'mechanic', 
                garageId: worker.garageId || worker.garageid, 
                status: 'active', 
                kycStatus: worker.kycStatus || worker.kycstatus,
                phone: worker.phone,
                email: null,
                token_version: worker.token_version || worker.tokenversion || 1
            });
        }

        // Step 3: Garage owner
        const garageResult = await pool.query(
            `SELECT * FROM garages WHERE contact IN ($1, $2) OR email = $3 LIMIT 1`,
            [cleanVal, prefixedVal, val]
        );
        if (garageResult.rows[0]) {
            const garage = garageResult.rows[0];
            return await buildResponse({ 
                id: garage.id + '_owner', 
                name: garage.name || 'Partner', 
                role: 'garage', 
                garageId: garage.id, 
                status: garage.status,
                phone: garage.contact,
                email: garage.email
            });
        }

        // Step 4: New user — auto-create based on requested role
        const targetRole = role || 'customer';
        
        if (targetRole === 'marshal') {
            const newUserId = 'marshal_' + Date.now();
            await pool.query(
                `INSERT INTO users (id, name, role, phone, email, status, kycstatus) VALUES ($1, 'New Marshal', 'marshal', $2, $3, 'active', 'pending_submission')`,
                [newUserId, finalPhone, finalEmail]
            );
            return await buildResponse({ 
                id: newUserId, 
                name: 'New Marshal', 
                role: 'marshal', 
                garageId: null, 
                status: 'active', 
                kycStatus: 'pending_submission',
                phone: finalPhone,
                email: finalEmail
            }, true);
        } else if (targetRole === 'garage') {
            const newGarageId = 'gar_' + Date.now();
            const newUserId = 'garage_' + Date.now();
            
            // Insert into garages
            await pool.query(
                `INSERT INTO garages (id, name, contact, email, status) VALUES ($1, 'New Partner Garage', $2, $3, 'active')`,
                [newGarageId, finalPhone, finalEmail]
            );
            // Insert into users
            await pool.query(
                `INSERT INTO users (id, name, role, phone, email, garageId, status) VALUES ($1, 'New Partner', 'garage', $2, $3, $4, 'active')`,
                [newUserId, finalPhone, finalEmail, newGarageId]
            );
            return await buildResponse({ 
                id: newGarageId + '_owner', 
                name: 'New Partner', 
                role: 'garage', 
                garageId: newGarageId, 
                status: 'active',
                phone: finalPhone,
                email: finalEmail
            }, true);
        } else {
            // Default: customer (name is left NULL until user completes profile)
            const newUserId = 'cust_' + Date.now();
            await pool.query(
                `INSERT INTO users (id, name, role, phone, email, status, phoneverified) VALUES ($1, NULL, 'customer', $2, $3, 'active', 1)`,
                [newUserId, finalPhone, finalEmail]
            );
            await pool.query(
                `INSERT INTO customers (id, name, phone, email, status) VALUES ($1, NULL, $2, $3, 'active')`,
                [newUserId, finalPhone, finalEmail]
            );
            return await buildResponse({ 
                id: newUserId, 
                name: null, 
                role: 'customer', 
                garageId: null, 
                status: 'active', 
                phone: finalPhone, 
                phoneverified: 1,
                phoneVerified: 1,
                email: finalEmail
            }, true);
        }

    } catch (err) {
        console.error('verify-otp error:', err.message);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

/**
 * POST /api/auth/google-signin
 * Validates Google One Tap / Credential Manager ID Token and authenticates user
 */
apiRouter.post('/auth/google-signin', loginLimiter, async (req, res) => {
    const { idToken, role } = req.body;
    if (!idToken) {
        return res.status(400).json({ error: 'Google ID token is required' });
    }

    const allowedAudiences = [
        process.env.GOOGLE_OAUTH_WEB_CLIENT_ID,
        process.env.GOOGLE_OAUTH_CUSTOMER_CLIENT_ID,
        process.env.GOOGLE_OAUTH_MARSHAL_CLIENT_ID
    ].filter(Boolean);

    if (allowedAudiences.length === 0) {
        return res.status(500).json({ error: 'Google OAuth is not configured on the server (missing Client IDs)' });
    }

    let payload;
    try {
        const ticket = await googleOAuthClient.verifyIdToken({
            idToken: idToken,
            audience: allowedAudiences
        });
        payload = ticket.getPayload();
    } catch (err) {
        console.error('[GOOGLE_AUTH] Token verification failed:', err.message);
        return res.status(401).json({ error: 'Invalid or expired Google authentication token' });
    }

    const email = payload?.email ? payload.email.toLowerCase().trim() : null;
    if (!email) {
        return res.status(400).json({ error: 'Google account does not provide a verified email' });
    }

    const displayName = payload.name || payload.given_name || 'User';
    const targetRole = role || 'customer';

    try {
        const buildResponse = async (userObj, isNewUser = false) => {
            // Auto-mark email verified since Google has already verified it
            await pool.query(`UPDATE users SET emailverified = 1 WHERE id = $1`, [userObj.id]).catch(() => {});
            const token = signToken(
                { id: userObj.id, role: userObj.role, garageId: userObj.garageId || null },
                userObj.token_version || userObj.tokenversion || 1
            );
            return res.json({ verified: true, isNewUser, token, user: userObj });
        };

        const isCustomerApp = (!role || role === 'customer');

        // Step 1: Check users table
        const userResult = await pool.query(
            `SELECT * FROM users WHERE email = $1 ORDER BY CASE WHEN role = $2 THEN 0 WHEN role = 'admin' THEN 1 ELSE 2 END LIMIT 1`,
            [email, targetRole]
        );
        if (userResult.rows[0]) {
            const user = userResult.rows[0];

            // Customer App Role Guards
            if (isCustomerApp) {
                if (user.role === 'marshal') {
                    return res.status(403).json({ error: 'This account is registered as a driver partner. Please use the Driver app instead.' });
                }
                if (user.role === 'garage') {
                    return res.status(403).json({ error: 'This account is registered as a garage partner. Please use the Garage portal instead.' });
                }
            }

            if (user.role === 'customer' || (isCustomerApp && user.role === 'admin')) {
                const cleanCustId = user.id.replace('_user', '');
                await pool.query(`
                    INSERT INTO customers (id, name, phone, email, status)
                    VALUES ($1, $2, $3, $4, 'active')
                    ON CONFLICT (id) DO UPDATE SET
                        email = COALESCE(EXCLUDED.email, customers.email)
                `, [cleanCustId, user.name || displayName, user.phone || null, user.email || email]).catch(() => {});
            }
            return await buildResponse({
                id: user.id,
                name: user.name,
                role: (isCustomerApp && user.role === 'admin') ? 'customer' : user.role,
                garageId: user.garageId || user.garageid,
                status: user.status,
                kycStatus: user.kycStatus || user.kycstatus,
                phone: user.phone,
                email: user.email,
                token_version: user.token_version || user.tokenversion || 1
            });
        }

        // Step 2: Garage owner check
        if (isCustomerApp) {
            const garageCheck = await pool.query(`SELECT id FROM garages WHERE email = $1 LIMIT 1`, [email]);
            if (garageCheck.rows[0]) {
                return res.status(403).json({ error: 'This account is registered as a garage partner. Please use the Garage portal instead.' });
            }
        }
        const garageResult = await pool.query(
            `SELECT * FROM garages WHERE email = $1 LIMIT 1`,
            [email]
        );
        if (garageResult.rows[0]) {
            const garage = garageResult.rows[0];
            return await buildResponse({
                id: garage.id + '_owner',
                name: garage.name || 'Partner',
                role: 'garage',
                garageId: garage.id,
                status: garage.status,
                phone: garage.contact,
                email: garage.email
            });
        }

        // Step 3: New user creation
        if (targetRole === 'marshal') {
            const newUserId = 'marshal_' + Date.now();
            await pool.query(
                `INSERT INTO users (id, name, role, phone, email, status, kycstatus, emailverified) VALUES ($1, $2, 'marshal', NULL, $3, 'active', 'pending_submission', 1)`,
                [newUserId, displayName, email]
            );
            return await buildResponse({
                id: newUserId,
                name: displayName,
                role: 'marshal',
                garageId: null,
                status: 'active',
                kycStatus: 'pending_submission',
                phone: null,
                email: email
            }, true);
        } else if (targetRole === 'garage') {
            const newGarageId = 'gar_' + Date.now();
            const newUserId = 'garage_' + Date.now();
            await pool.query(
                `INSERT INTO garages (id, name, contact, email, status) VALUES ($1, $2, NULL, $3, 'active')`,
                [newGarageId, displayName, email]
            );
            await pool.query(
                `INSERT INTO users (id, name, role, phone, email, garageId, status, emailverified) VALUES ($1, $2, 'garage', NULL, $3, $4, 'active', 1)`,
                [newUserId, displayName, email, newGarageId]
            );
            return await buildResponse({
                id: newUserId,
                name: displayName,
                role: 'garage',
                garageId: newGarageId,
                status: 'active',
                phone: null,
                email: email
            }, true);
        } else {
            // Default: Customer
            const newUserId = 'cust_' + Date.now();
            await pool.query(
                `INSERT INTO users (id, name, role, phone, email, status, emailverified) VALUES ($1, $2, 'customer', NULL, $3, 'active', 1)`,
                [newUserId, displayName, email]
            );
            await pool.query(
                `INSERT INTO customers (id, name, phone, email, status) VALUES ($1, $2, NULL, $3, 'active')`,
                [newUserId, displayName, email]
            );
            return await buildResponse({
                id: newUserId,
                name: displayName,
                role: 'customer',
                garageId: null,
                status: 'active',
                phone: null,
                email: email
            }, true);
        }
    } catch (err) {
        console.error('[GOOGLE_AUTH] DB error:', err.message);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// --- WORKERS ---
apiRouter.get('/garages/:id/workers', authMiddleware, (req, res) => {
    if (req.user.role !== 'admin' && req.user.garageId !== req.params.id && req.user.id !== req.params.id) {
        return res.status(403).json({ error: 'Forbidden: You do not have permission to access workers for this garage.' });
    }
    db.all("SELECT * FROM garage_workers WHERE garageId = ?", [req.params.id], (err, rows) => res.json((rows || []).map(signUserKycUrls)));
});

apiRouter.post('/garages/:id/workers', (req, res) => {
    const { name, phone, role, password } = req.body;
    const id = 'wkr_' + Date.now();
    console.log('Adding worker:', { name, phone, role, garageId: req.params.id });
    
    db.get("SELECT id FROM garage_workers WHERE garageId = ? AND phone = ?", [req.params.id, phone], (err, existing) => {
        if (existing) {
            return res.status(400).json({ error: 'A team member with this phone number already exists.' });
        }

    db.serialize(() => {
        db.run("INSERT INTO users (id, name, phone, password, role, garageId) VALUES (?, ?, ?, ?, ?, ?)", 
            [id, name, phone, password, role || 'mechanic', req.params.id], (err) => {
                if (err) console.error('Error inserting into users:', err.message);
            });
            
        db.run("INSERT INTO garage_workers (id, garageId, name, phone, role) VALUES (?, ?, ?, ?, ?)", 
            [id, req.params.id, name, phone, role], (err) => {
                if (err) {
                    console.error('Error inserting into garage_workers:', err.message);
                    return res.status(500).json({ error: 'Database error: ' + err.message });
                }
                
                db.run("UPDATE garages SET workerCount = (SELECT COUNT(*) FROM garage_workers WHERE garageId = ?) WHERE id = ?", 
                    [req.params.id, req.params.id], (errU) => {
                        if (errU) console.error('Error updating workerCount:', errU.message);
                        res.json({ success: true, id });
                    });
            });
        });
    });
});

apiRouter.delete('/garages/:id/workers/:workerId', (req, res) => {
    db.serialize(() => {
        db.run("DELETE FROM users WHERE id = ?", [req.params.workerId]);
        db.run("DELETE FROM garage_workers WHERE id = ? AND garageId = ?", [req.params.workerId, req.params.id], () => {
            db.run("UPDATE garages SET workerCount = (SELECT COUNT(*) FROM garage_workers WHERE garageId = ?) WHERE id = ?", [req.params.id, req.params.id]);
            res.json({ success: true });
        });
    });
});

apiRouter.get('/workers', authMiddleware, requireRole('admin'), (req, res) => {
    db.all("SELECT * FROM garage_workers", (err, rows) => res.json((rows || []).map(signUserKycUrls)));
});



// --- AUDIT / JOB CARDS ---
apiRouter.post('/service-requests/:id/audit', (req, res) => {
    const { items, total } = req.body;
    db.serialize(() => {
        db.run("DELETE FROM audit_items WHERE serviceRequestId = ?", [req.params.id]);
        const stmt = db.prepare("INSERT INTO audit_items (serviceRequestId, item, category, logic, rate, labor, mediaId) VALUES (?, ?, ?, ?, ?, ?, ?)");
        items.forEach(it => stmt.run([req.params.id, it.item, it.category, it.logic, it.rate, it.labor, it.mediaId]));
        stmt.finalize();
        db.run("UPDATE service_requests SET totalCustomerPrice = ?, auditStatus = 'submitted', status = 'audited' WHERE id = ?", [total, req.params.id]);
        res.json({ success: true });
    });
});

apiRouter.get('/service-requests/:id/audit', (req, res) => {
    db.all("SELECT * FROM audit_items WHERE serviceRequestId = ?", [req.params.id], (err, rows) => res.json(rows || []));
});

// --- ORDERS ---
apiRouter.get('/garages/:id/orders', authMiddleware, (req, res) => {
    if (req.user.role !== 'admin' && req.user.garageId !== req.params.id && req.user.id !== req.params.id) {
        return res.status(403).json({ error: 'Forbidden: You do not have permission to access orders for this garage.' });
    }
    db.all(`SELECT sr.*, c.name as customerName, v.plate, v.makeModel, t.garageDropoffOtp, t.garagePickupOtp, t.deliveryOtp 
            FROM service_requests sr 
            JOIN customers c ON sr.customerId = c.id 
            JOIN vehicles v ON sr.vehicleId = v.id 
            LEFT JOIN trips t ON t.serviceRequestId = sr.id
            WHERE sr.garageId = ?`, [req.params.id], (err, rows) => res.json(rows || []));
});

apiRouter.get('/workers/:id/tasks', authMiddleware, (req, res) => {
    if (req.user.role === 'admin' || req.user.id === req.params.id) {
        return fetchTasks();
    }
    db.get("SELECT garageId FROM garage_workers WHERE id = ?", [req.params.id], (errW, worker) => {
        const workerGarageId = worker ? worker.garageId : null;
        if (req.user.role === 'garage' && workerGarageId && (req.user.garageId === workerGarageId || req.user.id === workerGarageId)) {
            return fetchTasks();
        }
        return res.status(403).json({ error: 'Forbidden: You do not have permission to access tasks for this worker.' });
    });

    function fetchTasks() {
        db.all(`SELECT sr.*, c.name as customerName, v.plate, v.makeModel 
                FROM service_requests sr 
                JOIN customers c ON sr.customerId = c.id 
                JOIN vehicles v ON sr.vehicleId = v.id 
                WHERE sr.workerId = ?`, [req.params.id], (err, rows) => res.json(rows || []));
    }
});

apiRouter.get('/garages/:id', authMiddleware, (req, res) => {
    if (req.user.role !== 'admin' && req.user.garageId !== req.params.id && req.user.id !== req.params.id) {
        return res.status(403).json({ error: 'Forbidden: You do not have permission to access this garage profile.' });
    }
    db.get("SELECT * FROM garages WHERE id = $1", [req.params.id], (err, row) => {
        if (err || !row) return res.json(row);
        db.all('SELECT id, filePath AS "filePath", fileName AS "fileName", docType AS "docType" FROM media WHERE referenceId = $1', [req.params.id], (err, media) => {
            const mappedMedia = (media || []).map(m => ({
                ...m,
                filePath: generateSignedUploadUrl(m.filePath || m.filepath)
            }));
            row.documents = mappedMedia;
            if (row.photo) row.photo = generateSignedUploadUrl(row.photo);
            res.json(row);
        });
    });
});

apiRouter.put('/garages/:id', (req, res) => {
    const allowed = ['name', 'owner', 'ownerCount', 'ownercount', 'address', 'contact', 'email', 'status', 'lat', 'lng', 'businessType', 'businesstype', 'gstNumber', 'gstnumber', 'bankAccountName', 'bankaccountname', 'bankAccountNumber', 'bankaccountnumber', 'bankIFSC', 'bankifsc', 'bankName', 'bankname', 'bankBranch', 'bankbranch', 'bankVerified', 'bankverified', 'serviceType', 'servicetype', 'panNumber', 'pannumber', 'panVerified', 'panverified', 'aadhaarNumber', 'aadhaar_number', 'aadhaarnumber', 'aadhaarVerified', 'aadhaarverified', 'emailVerified', 'emailverified', 'govIdType', 'govidtype', 'accountType', 'accounttype', 'govIdNumber', 'govidnumber', 'serviceCenterType', 'authorizedCarBrands', 'authorizedBikeBrands'];
    const fields = []; const vals = [];
    
    // Case-insensitive mapping
    allowed.forEach(col => {
        const bodyVal = req.body[col]; // check direct match
        const lowerBodyVal = req.body[col.toLowerCase()]; // check lower match
        const val = (bodyVal !== undefined) ? bodyVal : lowerBodyVal;
        
        if (val !== undefined) {
            fields.push(`${col.toLowerCase()} = ?`); 
            vals.push(val);
        }
    });

    if (fields.length === 0) return res.status(400).json({ error: 'No valid fields provided' });
    
    vals.push(req.params.id);
    console.log(`Updating garage ${req.params.id} with fields:`, fields);

    db.run(`UPDATE garages SET ${fields.join(', ')} WHERE id = ?`, vals, (err) => {
        if (err) {
            console.error('Update garage error:', err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true });
    });
});

apiRouter.get('/garages/:id/stats', authMiddleware, (req, res) => {
    if (req.user.role !== 'admin' && req.user.garageId !== req.params.id && req.user.id !== req.params.id) {
        return res.status(403).json({ error: 'Forbidden: You do not have permission to access stats for this garage.' });
    }
    db.all("SELECT status, totalCustomerPrice FROM service_requests WHERE garageId = ?", [req.params.id], (err, rows) => {
        const stats = { totalOrders: rows ? rows.length : 0, pending: (rows || []).filter(r => r.status !== 'delivered').length, delivered: (rows || []).filter(r => r.status === 'delivered').length, revenue: (rows || []).reduce((acc, r) => acc + (r.totalCustomerPrice || 0), 0) };
        res.json(stats);
    });
});

apiRouter.get('/garages/:id/rates', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM garage_rates WHERE garageid = $1', [req.params.id]);
        // Normalise to camelCase for frontend compatibility
        const rows = result.rows.map(r => ({
            id: r.id,
            garageId: r.garageid,
            vehicleType: r.vehicletype,
            itemCategory: r.itemcategory,
            item: r.item,
            segment: r.segment || 'Universal',
            logicType: r.logictype,
            price: r.price,
            warrantyDays: r.warrantydays,
            warrantyKM: r.warrantykm
        }));
        res.json(rows);
    } catch (err) {
        console.error('Rates fetch error:', err.message);
        res.json([]);
    }
});

apiRouter.post('/garages/:id/rates', async (req, res) => {
    const { rates } = req.body;
    const garageId = req.params.id;
    if (rates && rates.length > 500) {
        return res.status(400).json({ error: 'Too many rates. Bulk limit is 500 items.' });
    }
    try {
        // Delete existing rates for this garage
        await pool.query('DELETE FROM garage_rates WHERE garageid = $1', [garageId]);
        // Insert new rates
        if (rates && rates.length > 0) {
                for (const r of rates) {
                    await pool.query(
                        `INSERT INTO garage_rates (garageid, vehicletype, itemcategory, item, segment, logictype, price, warrantydays, warrantykm)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                         ON CONFLICT (garageid, vehicletype, itemcategory, item, logictype) DO UPDATE
                         SET price = EXCLUDED.price, warrantydays = EXCLUDED.warrantydays, warrantykm = EXCLUDED.warrantykm`,
                        [garageId, r.vType, r.cat, r.item, r.segment || 'Universal', r.logic, r.price, r.wDays || 0, r.wKM || 0]
                    );
                }
            }
        res.json({ success: true, count: rates?.length || 0 });
    } catch (err) {
        console.error('Rates save error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- SKUs & INVENTORY ---
apiRouter.get('/skus', (req, res) => {
    db.all(`SELECT ms.id, ms.vehicleType AS "vehicleType", ms.category, ms.subcategory, 
            ms.itemName AS "itemName", ms.partType AS "partType", ms.compatibleBrands AS "compatibleBrands", 
            ms.sparePartBrand AS "sparePartBrand", ms.oemType AS "oemType", ms.unit, 
            ms.basePrice AS "basePrice", ms.vroomerPrice AS "vroomerPrice",
            (SELECT COUNT(*) FROM garage_skus gs WHERE gs.skuId = ms.id) AS "activationCount",
            (SELECT SUM(stock) FROM garage_skus gs WHERE gs.skuId = ms.id) AS "totalStock",
            (SELECT COUNT(*) FROM serialized_parts sp WHERE sp.skuId = ms.id) AS "totalSerials",
            (SELECT COUNT(*) FROM serialized_parts sp WHERE sp.skuId = ms.id AND sp.status = 'assigned') AS "assignedSerials"
            FROM master_skus ms`, (err, rows) => res.json(rows || []));
});

// CRM: update MRP and/or Vroomer Offer Price for a master SKU
apiRouter.put('/skus/:id', (req, res) => {
    const { basePrice, vroomerPrice } = req.body;
    const fields = [];
    const vals = [];
    if (basePrice !== undefined) { fields.push('basePrice = $' + (fields.length+1)); vals.push(parseFloat(basePrice)); }
    if (vroomerPrice !== undefined) { fields.push('vroomerPrice = $' + (fields.length+1)); vals.push(parseFloat(vroomerPrice)); }
    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });
    vals.push(req.params.id);
    db.run(`UPDATE master_skus SET ${fields.join(', ')} WHERE id = $${vals.length}`, vals, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// CRM: Fetch which garages have activated this SKU
apiRouter.get('/skus/:id/garages', (req, res) => {
    db.all(`SELECT g.id, g.name, g.address AS "location", gs.gearxPrice, gs.garagePrice, gs.stock, gs.status
            FROM garages g
            JOIN garage_skus gs ON g.id = gs.garageId
            WHERE gs.skuId = $1`, [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

apiRouter.get('/garages/:id/skus', (req, res) => {
    db.all(`SELECT ms.id, ms.vehicleType AS "vehicleType", ms.category, ms.subcategory,
            ms.itemName AS "itemName", ms.sparePartBrand AS "sparePartBrand",
            ms.compatibleBrands AS "compatibleBrands", ms.basePrice AS "basePrice",
            ms.partType AS "partType", ms.oemType AS "oemType", ms.unit,
            gs.gearxPrice, gs.garagePrice, gs.stock, gs.status
            FROM master_skus ms
            JOIN garage_skus gs ON ms.id = gs.skuId
            WHERE gs.garageId = $1`, [req.params.id], (err, rows) => res.json(rows || []));
});

// Save/Activate a part (POST = upsert)
apiRouter.post('/garages/:id/skus', (req, res) => {
    const { skuId, gearxPrice, garagePrice, stock, status } = req.body;
    db.run(`INSERT INTO garage_skus (garageId, skuId, gearxPrice, garagePrice, stock, status) 
            VALUES (?, ?, ?, ?, ?, ?) 
            ON CONFLICT(garageId, skuId) DO UPDATE SET 
            gearxPrice = excluded.gearxPrice, garagePrice = excluded.garagePrice, stock = excluded.stock, status = excluded.status, 
            lastUpdated = CURRENT_TIMESTAMP`,
        [req.params.id, skuId, gearxPrice, garagePrice, stock, status || 'active'], 
        () => res.json({ success: true }));
});
// Deduct stock for a part (used by Job Cards)
apiRouter.post('/garages/:id/skus/deduct', (req, res) => {
    const { itemName, category } = req.body;
    const garageId = req.params.id;

    // Find the first activated SKU that matches either the name or category
    db.get(`SELECT skuId, stock FROM garage_skus gs 
            JOIN master_skus ms ON gs.skuId = ms.id 
            WHERE gs.garageId = ? AND (ms.itemName = ? OR ms.category = ?) AND gs.stock > 0 
            LIMIT 1`, [garageId, itemName, category], (err, row) => {
        if (err || !row) return res.json({ success: false, reason: 'Part not found in stock' });

        db.run(`UPDATE garage_skus SET stock = stock - 1 WHERE garageId = ? AND skuId = ?`, 
            [garageId, row.skuId], () => {
            res.json({ success: true, skuId: row.skuId, newStock: row.stock - 1 });
        });
    });
});

// Add a brand-new custom part to master + auto-activate for this garage
apiRouter.post('/skus/custom', (req, res) => {
    const { itemName, category, subcategory, sparePartBrand, compatibleBrands, basePrice, vehicleType, garageId } = req.body;
    const skuId = 'CSKU-' + Date.now();
    db.run(`INSERT INTO master_skus (id, vehicleType, category, subcategory, itemName, sparePartBrand, compatibleBrands, basePrice, partType, oemType, unit)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Custom', 'Aftermarket', 'Piece')`,
        [skuId, vehicleType || 'Car', category, subcategory || '', itemName, sparePartBrand || '', compatibleBrands || '', parseFloat(basePrice) || 0],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            // Auto-activate for this garage
            db.run(`INSERT INTO garage_skus (garageId, skuId, myPrice, stock, status) VALUES (?, ?, ?, 0, 'active')`,
                [garageId, skuId, parseFloat(basePrice) || 0],
                () => res.json({ success: true, skuId }));
        });
});

// Check stock availability for a specific SKU at a garage
apiRouter.get('/garages/:id/skus/:skuId/check', (req, res) => {
    db.get(`SELECT gs.stock, ms.itemName, ms.sparePartBrand FROM garage_skus gs 
            JOIN master_skus ms ON ms.id = gs.skuId
            WHERE gs.garageId = ? AND gs.skuId = ?`,
        [req.params.id, req.params.skuId], (err, row) => {
            if (!row) return res.json({ available: false, stock: 0 });
            res.json({ available: row.stock > 0, stock: row.stock, itemName: row.itemName, brand: row.sparePartBrand });
        });
});

// Deduct stock for used parts (called on job submit)
apiRouter.post('/garages/:id/skus/deduct', (req, res) => {
    const { items } = req.body; // [{ skuId, qty }]
    const garageId = req.params.id;
    db.serialize(() => {
        items.forEach(({ skuId, qty }) => {
            db.run(`UPDATE garage_skus SET stock = MAX(0, stock - ?), lastUpdated = CURRENT_TIMESTAMP
                    WHERE garageId = ? AND skuId = ?`, [qty || 1, garageId, skuId]);
        });
        res.json({ success: true });
    });
});

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf', 'video/webm', 'video/mp4', 'video/quicktime', 'video/3gpp', 'video/ogg', 'video/x-matroska'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

console.log('[STARTUP-2] Probing persistent volume uploads directory permissions...');
let activeUploadsDir = path.join(__dirname, 'uploads');
try {
    if (!fs.existsSync(activeUploadsDir)) {
        fs.mkdirSync(activeUploadsDir, { recursive: true });
    }
    const testProbe = path.join(activeUploadsDir, '.volume_probe_' + Date.now());
    fs.writeFileSync(testProbe, 'test');
    fs.unlinkSync(testProbe);
    console.log('[STARTUP-2] ✓ Persistent volume directory verified writable at:', activeUploadsDir);
} catch (err) {
    console.warn('[STARTUP-2] [WARN] Primary uploads path ' + activeUploadsDir + ' not writable (' + err.message + '). Using os.tmpdir() fallback.');
    activeUploadsDir = require('os').tmpdir();
}

let activeDownloadsDir = path.join(activeUploadsDir, 'downloads');
try {
    if (!fs.existsSync(activeDownloadsDir)) {
        fs.mkdirSync(activeDownloadsDir, { recursive: true });
    }
} catch (err) {
    console.warn('[STARTUP-2] Failed to create downloads directory on volume:', err.message);
}

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only JPG, PNG, WebP, PDF, and Videos are allowed.'), false);
    }
};

const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_SIZE } });

// --- DEDICATED APK UPLOAD MULTER CONFIG (150MB LIMIT) ---
const apkStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync(activeDownloadsDir)) {
            fs.mkdirSync(activeDownloadsDir, { recursive: true });
        }
        cb(null, activeDownloadsDir);
    },
    filename: (req, file, cb) => {
        let targetName = req.query.target || req.body.target || file.originalname;
        targetName = path.basename(targetName).toLowerCase();
        if (targetName === 'driver' || targetName === 'driver.apk') targetName = 'redrivo-driver.apk';
        if (targetName === 'customer' || targetName === 'customer.apk') targetName = 'redrivo-customer.apk';
        if (targetName === 'marshal' || targetName === 'marshal.apk') targetName = 'redrivo-driver.apk';
        if (!targetName.endsWith('.apk')) targetName += '.apk';
        cb(null, targetName);
    }
});

const apkUpload = multer({
    storage: apkStorage,
    limits: { fileSize: 150 * 1024 * 1024 }, // 150MB limit
    fileFilter: (req, file, cb) => {
        if (file.originalname.toLowerCase().endsWith('.apk') || 
            file.mimetype === 'application/vnd.android.package-archive' || 
            file.mimetype === 'application/octet-stream') {
            cb(null, true);
        } else {
            cb(new Error('Only .apk files are allowed.'));
        }
    }
});

function checkMagicBytes(buffer, mimetype) {
    if (!buffer || buffer.length < 4) return false;
    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return mimetype === 'image/png';
    // JPEG: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return mimetype === 'image/jpeg' || mimetype === 'image/jpg';
    // PDF: %PDF (25 50 44 46)
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return mimetype === 'application/pdf';
    // WebP: RIFF .... WEBP
    if (buffer.length >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return mimetype === 'image/webp';
    // MP4 / QuickTime / 3GP (ISO Base Media File: ....ftyp or ....moov)
    if (buffer.length >= 8) {
        const typeTag = buffer.toString('ascii', 4, 8);
        if (typeTag === 'ftyp' || typeTag === 'moov') return mimetype === 'video/mp4' || mimetype === 'video/quicktime' || mimetype === 'video/3gpp';
    }
    // WebM / Matroska (EBML header: 1A 45 DF A3)
    if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) return mimetype === 'video/webm' || mimetype === 'video/x-matroska';
    // Ogg: OggS (4F 67 67 53)
    if (buffer[0] === 0x4F && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) return mimetype === 'video/ogg';
    return false;
}

const validateUploadedFiles = (req, res, next) => {
    const filesToCheck = [];
    if (req.file) filesToCheck.push(req.file);
    if (req.files) {
        if (Array.isArray(req.files)) filesToCheck.push(...req.files);
        else Object.values(req.files).flat().forEach(f => filesToCheck.push(f));
    }
    for (const file of filesToCheck) {
        try {
            const buf = file.buffer || (file.path && fs.existsSync(file.path) ? fs.readFileSync(file.path) : null);
            if (!buf || buf.length < 4 || !checkMagicBytes(buf, file.mimetype)) {
                return res.status(400).json({ error: `Invalid file content. The uploaded file does not match the signature for ${file.mimetype}.` });
            }
        } catch (err) {
            return res.status(400).json({ error: 'Failed to inspect uploaded file.' });
        }
    }
    next();
};

const verifyOwnership = (req, res, next) => {
    if (req.user.role !== 'admin' && req.user.id !== req.params.id) {
        return res.status(403).json({ error: 'Forbidden: You can only modify your own account.' });
    }
    next();
};

apiRouter.post('/users/:id/profile-picture', authMiddleware, verifyOwnership, upload.single('file'), validateUploadedFiles, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!isR2Configured()) {
        return res.status(500).json({ error: 'Storage service is not configured. Missing Cloudflare R2 environment variables.' });
    }
    try {
        const file = req.file;
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `${Date.now()}-${safeName}`;
        const filePath = `uploads/${filename}`;

        await uploadBufferToR2({
            key: filePath,
            buffer: file.buffer,
            mimetype: file.mimetype,
            metadata: { userId: req.params.id, type: 'profile_picture' }
        });

        const signedUrl = generateSignedUploadUrl(filePath);

        // Update both users and garage_workers tables
        await pool.query(`UPDATE users SET profilepictureurl = $1 WHERE id = $2`, [filePath, req.params.id]);
        await pool.query(`UPDATE garage_workers SET profilepictureurl = $1 WHERE id = $2`, [filePath, req.params.id]).catch(() => {});

        res.json({ success: true, profilePictureUrl: signedUrl });
    } catch (err) {
        console.error('Profile picture upload error:', err.message);
        res.status(500).json({ error: 'Failed to upload profile picture: ' + err.message });
    }
});

apiRouter.post('/workers/:id/kyc-file', authMiddleware, verifyOwnership, upload.single('file'), validateUploadedFiles, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!isR2Configured()) {
        return res.status(500).json({ error: 'Storage service is not configured. Missing Cloudflare R2 environment variables.' });
    }
    try {
        const { docType } = req.body;
        const id = req.params.id;

        const docTypeMap = {
            'pan': 'panurl',
            'panback': 'panbackurl',
            'aadhaar': 'aadhaarurl',
            'aadhaarback': 'aadhaarbackurl',
            'face': 'facephotourl',
            'dl': 'dlurl',
            'dlback': 'dlbackurl'
        };

        const colName = docTypeMap[docType];
        if (!colName) {
            return res.status(400).json({ error: 'Invalid docType: ' + docType });
        }

        const file = req.file;
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `${Date.now()}-${safeName}`;
        const filePath = `uploads/${filename}`;

        await uploadBufferToR2({
            key: filePath,
            buffer: file.buffer,
            mimetype: file.mimetype,
            metadata: { userId: id, docType }
        });

        const signedUrl = generateSignedUploadUrl(filePath);

        // Update both users and garage_workers tables
        await pool.query(`UPDATE users SET ${colName} = $1 WHERE id = $2`, [filePath, id]);
        await pool.query(`UPDATE garage_workers SET ${colName} = $1 WHERE id = $2`, [filePath, id]).catch(() => {});

        res.json({ success: true, fileUrl: signedUrl });
    } catch (err) {
        console.error('KYC file upload error:', err.message);
        res.status(500).json({ error: 'Failed to upload document: ' + err.message });
    }
});

apiRouter.put('/workers/:id/kyc', authMiddleware, verifyOwnership, upload.fields([
    { name: 'panFile', maxCount: 1 }, 
    { name: 'panBackFile', maxCount: 1 }, 
    { name: 'aadhaarFile', maxCount: 1 }, 
    { name: 'aadhaarBackFile', maxCount: 1 }, 
    { name: 'faceFile', maxCount: 1 },
    { name: 'dlFile', maxCount: 1 },
    { name: 'dlBackFile', maxCount: 1 }
]), validateUploadedFiles, async (req, res) => {
    let { name, email, panNumber, aadhaarNumber, dlNumber, kycStatus,
            dob, gender, city, address, state, pincode,
            bankAccountName, bankAccountNumber, bankIFSC, bankName } = req.body;
    const files = req.files || {};

    // ── Server-side KYC validation ──────────────────────────────────────────
    const serverErrors = [];

    if (!name || !/^[A-Za-z\s.'"-]{2,100}$/.test(name.trim()))
        serverErrors.push('Invalid Full Name: only letters and spaces allowed.');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim()))
        serverErrors.push('Invalid Email Address.');
    if (!dlNumber || !/^[A-Z]{2}[0-9]{11,13}$/.test(dlNumber.replace(/[^A-Z0-9]/g, '').toUpperCase()))
        serverErrors.push('Invalid Driving License format.');
    if (!city || city.trim().length < 2)
        serverErrors.push('Invalid City: minimum 2 characters required.');
    if (dob && !/^\d{2}[\/\-]\d{2}[\/\-]\d{4}$/.test(dob.trim()))
        serverErrors.push('Invalid Date of Birth: expected DD/MM/YYYY format.');
    if (gender && gender.trim().length < 3)
        serverErrors.push('Invalid Gender selection.');

    // Fetch existing user to preserve files if they aren't being re-uploaded
    let existingUser = {};
    try {
        const existingRes = await pool.query('SELECT panurl, panbackurl, aadhaarurl, aadhaarbackurl, facephotourl, dlurl, dlbackurl, pannumber, aadhaarnumber, dob, gender, city, vehicle_types FROM users WHERE id = $1', [req.params.id]);
        if (existingRes.rows.length > 0) {
            existingUser = existingRes.rows[0];
        }
    } catch (e) {
        console.error('Error fetching existing user for KYC preservation:', e);
    }

    // Flexible ID validation: Enforce either PAN (number + front + back) OR Aadhaar (number + front + back)
    const effectivePanNumber = (panNumber || existingUser.pannumber || '').trim().toUpperCase();
    const isPanFormatValid = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(effectivePanNumber);
    const hasPanFront = !!(files.panFile || existingUser.panurl);
    const hasPanBack = !!(files.panBackFile || existingUser.panbackurl);
    const isPanComplete = isPanFormatValid && hasPanFront && hasPanBack;

    const effectiveAadhaarRaw = (aadhaarNumber || existingUser.aadhaarnumber || '');
    const cleanAadhaarCheck = effectiveAadhaarRaw.replace(/\D/g, '');
    const isAadhaarFormatValid = /^[2-9][0-9]{11}$/.test(cleanAadhaarCheck);
    const hasAadhaarFront = !!(files.aadhaarFile || existingUser.aadhaarurl);
    const hasAadhaarBack = !!(files.aadhaarBackFile || existingUser.aadhaarbackurl);
    const isAadhaarComplete = isAadhaarFormatValid && hasAadhaarFront && hasAadhaarBack;

    // File & completeness checks (only enforced when requesting pending_approval status)
    if (kycStatus === 'pending_approval' || kycStatus === 'Pending Approval') {
        if (!isPanComplete && !isAadhaarComplete) {
            if (!effectivePanNumber && !cleanAadhaarCheck) {
                serverErrors.push('Identity verification requires either PAN Card or Aadhaar Card.');
            } else if (effectivePanNumber && !isPanComplete) {
                if (!isPanFormatValid) serverErrors.push('Invalid PAN Number. Expected format: ABCDE1234F');
                if (!hasPanFront) serverErrors.push('PAN Card front photo is required.');
                if (!hasPanBack) serverErrors.push('PAN Card back photo is required.');
            } else if (cleanAadhaarCheck && !isAadhaarComplete) {
                if (!isAadhaarFormatValid) serverErrors.push('Invalid Aadhaar Number: must be exactly 12 digits starting with 2-9.');
                if (!hasAadhaarFront) serverErrors.push('Aadhaar front photo is required.');
                if (!hasAadhaarBack) serverErrors.push('Aadhaar back photo is required.');
            }
        }

        // Live Selfie and Driving License are strictly mandatory for all drivers
        if (!files.faceFile && !existingUser.facephotourl) serverErrors.push('Live Selfie photo is required.');
        if (!files.dlFile && !existingUser.dlurl) serverErrors.push('Driving License front photo is required.');
        if (!files.dlBackFile && !existingUser.dlbackurl) serverErrors.push('Driving License back photo is required.');
    } else {
        if (effectivePanNumber && !isPanFormatValid) serverErrors.push('Invalid PAN Number. Expected format: ABCDE1234F');
        if (cleanAadhaarCheck && !isAadhaarFormatValid) serverErrors.push('Invalid Aadhaar Number: must be exactly 12 digits starting with 2-9.');
    }

    if (serverErrors.length > 0) {
        return res.status(400).json({ error: serverErrors[0], details: serverErrors });
    }

    const hasIncomingFiles = Object.values(files).some(arr => Array.isArray(arr) && arr.length > 0);
    if (hasIncomingFiles && !isR2Configured()) {
        return res.status(500).json({ error: 'Storage service is not configured. Missing Cloudflare R2 environment variables.' });
    }

    let panUrl = existingUser.panurl || null;
    if (files.panFile && files.panFile[0]) {
        const file = files.panFile[0];
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `${Date.now()}-${safeName}`;
        panUrl = `uploads/${filename}`;
        await uploadBufferToR2({ key: panUrl, buffer: file.buffer, mimetype: file.mimetype, metadata: { userId: req.params.id, docType: 'pan' } });
    }

    let panBackUrl = existingUser.panbackurl || null;
    if (files.panBackFile && files.panBackFile[0]) {
        const file = files.panBackFile[0];
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `${Date.now()}-${safeName}`;
        panBackUrl = `uploads/${filename}`;
        await uploadBufferToR2({ key: panBackUrl, buffer: file.buffer, mimetype: file.mimetype, metadata: { userId: req.params.id, docType: 'panback' } });
    }

    let aadhaarUrl = existingUser.aadhaarurl || null;
    if (files.aadhaarFile && files.aadhaarFile[0]) {
        const file = files.aadhaarFile[0];
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `${Date.now()}-${safeName}`;
        aadhaarUrl = `uploads/${filename}`;
        await uploadBufferToR2({ key: aadhaarUrl, buffer: file.buffer, mimetype: file.mimetype, metadata: { userId: req.params.id, docType: 'aadhaar' } });
    }

    let aadhaarBackUrl = existingUser.aadhaarbackurl || null;
    if (files.aadhaarBackFile && files.aadhaarBackFile[0]) {
        const file = files.aadhaarBackFile[0];
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `${Date.now()}-${safeName}`;
        aadhaarBackUrl = `uploads/${filename}`;
        await uploadBufferToR2({ key: aadhaarBackUrl, buffer: file.buffer, mimetype: file.mimetype, metadata: { userId: req.params.id, docType: 'aadhaarback' } });
    }

    let facePhotoUrl = existingUser.facephotourl || null;
    if (files.faceFile && files.faceFile[0]) {
        const file = files.faceFile[0];
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `${Date.now()}-${safeName}`;
        facePhotoUrl = `uploads/${filename}`;
        await uploadBufferToR2({ key: facePhotoUrl, buffer: file.buffer, mimetype: file.mimetype, metadata: { userId: req.params.id, docType: 'face' } });
    }

    let dlUrl = existingUser.dlurl || null;
    if (files.dlFile && files.dlFile[0]) {
        const file = files.dlFile[0];
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `${Date.now()}-${safeName}`;
        dlUrl = `uploads/${filename}`;
        await uploadBufferToR2({ key: dlUrl, buffer: file.buffer, mimetype: file.mimetype, metadata: { userId: req.params.id, docType: 'dl' } });
    }

    let dlBackUrl = existingUser.dlbackurl || null;
    if (files.dlBackFile && files.dlBackFile[0]) {
        const file = files.dlBackFile[0];
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `${Date.now()}-${safeName}`;
        dlBackUrl = `uploads/${filename}`;
        await uploadBufferToR2({ key: dlBackUrl, buffer: file.buffer, mimetype: file.mimetype, metadata: { userId: req.params.id, docType: 'dlback' } });
    }

    const cleanAadhaar = aadhaarNumber ? aadhaarNumber.replace(/\D/g, '') : (existingUser.aadhaarnumber || null);
    const cleanPan = panNumber ? panNumber.trim().toUpperCase() : (existingUser.pannumber || null);
    const cleanDL = dlNumber ? dlNumber.replace(/[^A-Z0-9]/g, '').toUpperCase() : (existingUser.dlnumber || null);
    const cleanIFSC = bankIFSC ? bankIFSC.trim().toUpperCase() : null;
    const finalKycStatus = kycStatus || 'Pending Approval';
    const finalDob = dob || existingUser.dob || null;
    const finalGender = gender || existingUser.gender || null;
    const finalCity = city || existingUser.city || null;

    const rawVehicleTypes = req.body.vehicleTypes || req.body.vehicleType || existingUser.vehicle_types || 'bike';
    let cleanVehicleTypes = 'bike';
    if (Array.isArray(rawVehicleTypes)) {
        cleanVehicleTypes = rawVehicleTypes.filter(Boolean).join(',');
    } else if (typeof rawVehicleTypes === 'string') {
        cleanVehicleTypes = rawVehicleTypes.trim();
    }
    if (!cleanVehicleTypes) cleanVehicleTypes = 'bike';

    try {
        if (cleanPan) {
            const panCheck = await pool.query(`SELECT id FROM users WHERE pannumber = $1 AND id != $2 UNION ALL SELECT id FROM garage_workers WHERE pannumber = $1 AND id != $2`, [cleanPan, req.params.id]);
            if (panCheck.rows.length > 0) return res.status(400).json({ error: 'PAN Number is already registered.' });
        }
        if (cleanAadhaar) {
            const aadhaarCheck = await pool.query(`SELECT id FROM users WHERE aadhaarnumber = $1 AND id != $2 UNION ALL SELECT id FROM garage_workers WHERE aadhaarnumber = $1 AND id != $2`, [cleanAadhaar, req.params.id]);
            if (aadhaarCheck.rows.length > 0) return res.status(400).json({ error: 'Aadhaar Number is already registered.' });
        }
        if (cleanDL) {
            const dlCheck = await pool.query(`SELECT id FROM users WHERE dlnumber = $1 AND id != $2 UNION ALL SELECT id FROM garage_workers WHERE dlnumber = $1 AND id != $2`, [cleanDL, req.params.id]);
            if (dlCheck.rows.length > 0) return res.status(400).json({ error: 'Driving License Number is already registered.' });
        }

        if (email) {
            const emailCheck = await pool.query(`SELECT id FROM users WHERE email = $1 AND id != $2`, [email, req.params.id]);
            if (emailCheck.rows.length > 0) return res.status(400).json({ error: 'Email is already registered.' });
            
            // If email is different from current, un-verify it
            const currentUserRes = await pool.query(`SELECT email FROM users WHERE id = $1`, [req.params.id]);
            if (currentUserRes.rows.length > 0 && currentUserRes.rows[0].email !== email) {
                await pool.query(`UPDATE users SET emailverified = 0 WHERE id = $1`, [req.params.id]);
            }
        }
        // Update garage_workers (may not exist — ignore error)
        await pool.query(
            `UPDATE garage_workers SET name = $1, email = $2, pannumber = $3, aadhaarnumber = $4, 
             panurl = $5, aadhaarurl = $6, facephotourl = $7, kycstatus = $8,
             dlnumber = $9, bankaccountname = $10, bankaccountnumber = $11, bankifsc = $12,
             address = $13, city = $14, state = $15, pincode = $16, dlurl = $17,
             panbackurl = $18, aadhaarbackurl = $19, dlbackurl = $20, bankname = $21,
             dob = $22, gender = $23, vehicle_types = $24
             WHERE id = $25`,
            [name, email, cleanPan, cleanAadhaar, panUrl, aadhaarUrl, facePhotoUrl, finalKycStatus,
             cleanDL, bankAccountName || null, bankAccountNumber || null, cleanIFSC, address || null, finalCity, state || null, pincode || null, dlUrl,
             panBackUrl, aadhaarBackUrl, dlBackUrl, bankName || null, finalDob, finalGender, cleanVehicleTypes, req.params.id]
        ).catch(() => {}); // ignore if no garage_worker row

        // Sync into core users table (marshals live here)
        const userUpdateRes = await pool.query(
            `UPDATE users SET name = $1, email = $2, pannumber = $3, aadhaarnumber = $4,
             panurl = $5, aadhaarurl = $6, facephotourl = $7, kycstatus = $8,
             dlnumber = $9, bankaccountname = $10, bankaccountnumber = $11, bankifsc = $12,
             address = $13, city = $14, state = $15, pincode = $16, dlurl = $17,
             panbackurl = $18, aadhaarbackurl = $19, dlbackurl = $20, bankname = $21,
             dob = $22, gender = $23, vehicle_types = $24
             WHERE id = $25`,
            [name, email, cleanPan, cleanAadhaar, panUrl, aadhaarUrl, facePhotoUrl, finalKycStatus,
             cleanDL, bankAccountName || null, bankAccountNumber || null, cleanIFSC, address || null, finalCity, state || null, pincode || null, dlUrl,
             panBackUrl, aadhaarBackUrl, dlBackUrl, bankName || null, finalDob, finalGender, cleanVehicleTypes, req.params.id]
        );

        if (userUpdateRes.rowCount === 0) {
            return res.status(404).json({ error: 'User not found in system.' });
        }

        res.json({ success: true, kycStatus: finalKycStatus });
    } catch (err) {
        console.error('KYC update error:', err);
        res.status(500).json({ error: 'Unable to save KYC details due to a system error. Please try again later or contact support.' });
    }
});

const TOP_INDIAN_BANKS = [
    "State Bank of India", "HDFC Bank", "ICICI Bank", "Axis Bank", "Punjab National Bank",
    "Bank of Baroda", "Kotak Mahindra Bank", "Canara Bank", "Union Bank of India", "Bank of India",
    "IndusInd Bank", "IDBI Bank", "Yes Bank", "Federal Bank", "Central Bank of India",
    "Indian Bank", "UCO Bank", "Indian Overseas Bank", "Punjab & Sind Bank", "IDFC FIRST Bank",
    "Bandhan Bank", "RBL Bank", "Au Small Finance Bank", "Equitas Small Finance Bank",
    "Airtel Payments Bank", "Paytm Payments Bank", "Jio Payments Bank", "India Post Payments Bank"
];

async function handleBankDetailsUpdate(req, res) {
    try {
        const id = req.params.id;
        const { accountHolderName, bankName, accountNumber, ifscCode } = req.body;
        
        const serverErrors = [];

        // 1. Account Holder Name
        if (!accountHolderName || !/^[A-Za-z\s.]{2,100}$/.test(accountHolderName.trim())) {
            serverErrors.push('Invalid Account Holder Name: must contain letters, dots, and spaces only (min 2 characters).');
        }

        // 2. Bank Name (List-only validation)
        const cleanBank = (bankName || '').trim();
        if (!cleanBank || !TOP_INDIAN_BANKS.includes(cleanBank)) {
            serverErrors.push('Invalid Bank Name: please select a valid bank from the search list.');
        }

        // 3. Account Number
        const cleanAcc = (accountNumber || '').trim();
        if (!cleanAcc || !/^[0-9]{9,18}$/.test(cleanAcc)) {
            serverErrors.push('Invalid Account Number: must be 9-18 numeric digits.');
        }

        // 4. IFSC Code
        const cleanIfsc = (ifscCode || '').trim().toUpperCase();
        if (!cleanIfsc || !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(cleanIfsc)) {
            serverErrors.push('Invalid IFSC Code: must follow 11-character format (e.g. SBIN0001234).');
        }

        if (serverErrors.length > 0) {
            return res.status(400).json({ error: serverErrors.join(' ') });
        }

        // 1-to-1 Column Mapping Updates
        await pool.query(`
            UPDATE users 
            SET bankaccountname = $1, bankname = $2, bankaccountnumber = $3, bankifsc = $4, bankverified = 1
            WHERE id = $5
        `, [accountHolderName.trim(), cleanBank, cleanAcc, cleanIfsc, id]);

        await pool.query(`
            UPDATE garage_workers 
            SET bankaccountname = $1, bankname = $2, bankaccountnumber = $3, bankifsc = $4, bankverified = 1
            WHERE id = $5
        `, [accountHolderName.trim(), cleanBank, cleanAcc, cleanIfsc, id]).catch(() => {});

        res.json({
            success: true,
            message: 'Bank details saved successfully.',
            bankDetails: {
                accountHolderName: accountHolderName.trim(),
                bankName: cleanBank,
                accountNumber: cleanAcc,
                ifscCode: cleanIfsc
            }
        });
    } catch (err) {
        console.error('Error saving bank details:', err);
        res.status(500).json({ error: 'Failed to update bank details: ' + err.message });
    }
}

apiRouter.put('/workers/:id/bank-details', handleBankDetailsUpdate);
apiRouter.put('/users/:id/bank-details', handleBankDetailsUpdate);

// ── Pincode Metadata & Locality Mapping ─────────────────────────────────────
const PINCODE_METADATA_MAP = {
    // West Bengal (Kolkata & Suburbs)
    '700091': { areaName: 'Sector V / Salt Lake', city: 'Kolkata', lat: 22.5800, lng: 88.4350 },
    '700156': { areaName: 'Newtown Action Area I & II', city: 'Kolkata', lat: 22.5850, lng: 88.4600 },
    '700056': { areaName: 'Belgharia / Dunlop', city: 'Kolkata', lat: 22.6560, lng: 88.3840 },
    '700001': { areaName: 'BBD Bagh / Central Business District', city: 'Kolkata', lat: 22.5726, lng: 88.3512 },
    '700002': { areaName: 'Cossipore / North Kolkata', city: 'Kolkata', lat: 22.6150, lng: 88.3750 },
    '700003': { areaName: 'Shyambazar / Hatibagan', city: 'Kolkata', lat: 22.5990, lng: 88.3710 },
    '700009': { areaName: 'College Street / Sealdah', city: 'Kolkata', lat: 22.5690, lng: 88.3680 },
    '700019': { areaName: 'Ballygunge / Gariahat', city: 'Kolkata', lat: 22.5280, lng: 88.3650 },
    '700029': { areaName: 'Kalighat / Rashbehari', city: 'Kolkata', lat: 22.5180, lng: 88.3490 },
    '700053': { areaName: 'New Alipore / Behala', city: 'Kolkata', lat: 22.5050, lng: 88.3290 },
    '711101': { areaName: 'Howrah Station / Golabari', city: 'Howrah', lat: 22.5892, lng: 88.3415 },

    // Maharashtra (Mumbai & Pune)
    '400050': { areaName: 'Bandra West', city: 'Mumbai', lat: 19.0596, lng: 72.8295 },
    '400051': { areaName: 'Bandra Kurla Complex (BKC)', city: 'Mumbai', lat: 19.0664, lng: 72.8680 },
    '400097': { areaName: 'Malad East', city: 'Mumbai', lat: 19.1860, lng: 72.8580 },
    '400099': { areaName: 'Andheri East / Airport', city: 'Mumbai', lat: 19.1136, lng: 72.8697 },
    '400001': { areaName: 'Fort / South Mumbai', city: 'Mumbai', lat: 18.9322, lng: 72.8347 },
    '411001': { areaName: 'Pune Camp / Station', city: 'Pune', lat: 18.5284, lng: 73.8743 },
    '411014': { areaName: 'Viman Nagar / Kharadi', city: 'Pune', lat: 18.5679, lng: 73.9143 },
    '411057': { areaName: 'Hinjawadi IT Park', city: 'Pune', lat: 18.5913, lng: 73.7389 },

    // Karnataka (Bengaluru)
    '560001': { areaName: 'MG Road / Brigade Road', city: 'Bengaluru', lat: 12.9756, lng: 77.6066 },
    '560034': { areaName: 'Koramangala 3rd/4th Block', city: 'Bengaluru', lat: 12.9352, lng: 77.6245 },
    '560038': { areaName: 'Indiranagar 100ft Road', city: 'Bengaluru', lat: 12.9719, lng: 77.6412 },
    '560066': { areaName: 'Whitefield IT Corridor', city: 'Bengaluru', lat: 12.9698, lng: 77.7500 },
    '560100': { areaName: 'Electronic City Phase 1', city: 'Bengaluru', lat: 12.8452, lng: 77.6602 },

    // Delhi NCR
    '110001': { areaName: 'Connaught Place', city: 'New Delhi', lat: 28.6304, lng: 77.2177 },
    '110020': { areaName: 'Okhla Industrial Area', city: 'New Delhi', lat: 28.5355, lng: 77.2745 },
    '122002': { areaName: 'Cyber Hub / DLF Phase 2', city: 'Gurugram', lat: 28.4900, lng: 77.0900 },
    '122018': { areaName: 'Udyog Vihar Phase 4/5', city: 'Gurugram', lat: 28.5020, lng: 77.0780 },
    '201301': { areaName: 'Noida Sector 18 / Atta Market', city: 'Noida', lat: 28.5700, lng: 77.3200 }
};

function getDirection(lat1, lng1, lat2, lng2) {
    if (lat1 === null || lng1 === null || lat2 === null || lng2 === null) return '';
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2 * Math.PI / 180);
    const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
              Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLng);
    const brng = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return directions[Math.round(brng / 45) % 8];
}

async function logPickupSearch({ pincode, address, city, lat, lng, customerId, searchType }) {
    try {
        let extractedPin = pincode;
        if (!extractedPin && address) {
            const m = address.match(/\b\d{6}\b/);
            if (m) extractedPin = m[0];
        }
        if (!extractedPin) return;

        let areaName = null;
        let detectedCity = city || 'Kolkata';
        let parsedLat = parseFloat(lat) || null;
        let parsedLng = parseFloat(lng) || null;

        if (PINCODE_METADATA_MAP[extractedPin]) {
            areaName = PINCODE_METADATA_MAP[extractedPin].areaName;
            detectedCity = PINCODE_METADATA_MAP[extractedPin].city;
            if (!parsedLat) parsedLat = PINCODE_METADATA_MAP[extractedPin].lat;
            if (!parsedLng) parsedLng = PINCODE_METADATA_MAP[extractedPin].lng;
        } else if (address) {
            const parts = address.split(',');
            areaName = parts.slice(0, 2).join(', ').trim();
        }

        await pool.query(`
            INSERT INTO pickup_searches (pincode, area_name, city, lat, lng, customer_id, search_type, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        `, [extractedPin, areaName, detectedCity, parsedLat, parsedLng, customerId || null, searchType || 'pickup_quote']);
    } catch (err) {
        console.error('[Demand Logging Error]:', err.message);
    }
}

// ── Search & Demand Endpoints ───────────────────────────────────────────────
apiRouter.post('/demand/log-search', async (req, res) => {
    try {
        const { pincode, address, city, lat, lng, customerId, searchType } = req.body;
        await logPickupSearch({ pincode, address, city, lat, lng, customerId, searchType });
        res.json({ success: true, message: 'Search event logged.' });
    } catch (err) {
        console.error('Error in log-search:', err);
        res.status(500).json({ error: 'Failed to log search event: ' + err.message });
    }
});

apiRouter.get('/marshals/:id/active-trip', async (req, res) => {
    try {
        const marshalId = req.params.id;
        const activeTripStatuses = [
            'pending_payment', 'assigned', 'pending_otp_1', 'in_transit',
            'at_garage', 'in_service', 'out_for_delivery', 'pending_delivery'
        ];
        
        const tripRes = await pool.query(`
            SELECT t.id, t.status, t.servicerequestid
            FROM trips t
            LEFT JOIN service_requests sr ON sr.id = t.servicerequestid
            WHERE (t.marshalid = $1 OR t.deliverymarshalid = $1)
              AND t.status = ANY($2::text[])
              AND (sr.status IS NULL OR sr.status NOT IN ('cancelled', 'completed', 'returned', 'drop_completed'))
            ORDER BY t.createdat DESC
            LIMIT 1
        `, [marshalId, activeTripStatuses]);

        if (tripRes.rows && tripRes.rows.length > 0) {
            const trip = tripRes.rows[0];
            return res.json({
                isBusy: true,
                status: trip.status,
                tripId: trip.id
            });
        }

        res.json({ isBusy: false });
    } catch (err) {
        console.error('Error in /marshals/:id/active-trip:', err.message);
        res.json({ isBusy: false });
    }
});

const CITY_CENTERS = {
    'kolkata': { lat: 22.5726, lng: 88.3639 },
    'mumbai': { lat: 19.0760, lng: 72.8777 },
    'pune': { lat: 18.5204, lng: 73.8567 },
    'bengaluru': { lat: 12.9716, lng: 77.5946 },
    'bangalore': { lat: 12.9716, lng: 77.5946 },
    'delhi': { lat: 28.6139, lng: 77.2090 },
    'new delhi': { lat: 28.6139, lng: 77.2090 },
    'gurugram': { lat: 28.4595, lng: 77.0266 },
    'noida': { lat: 28.5355, lng: 77.3910 }
};

apiRouter.get('/demand/recommended-pincodes', async (req, res) => {
    try {
        const city = req.query.city || 'Kolkata';
        let driverLat = req.query.lat ? parseFloat(req.query.lat) : null;
        let driverLng = req.query.lng ? parseFloat(req.query.lng) : null;
        const limit = parseInt(req.query.limit) || 5;

        // Verify driver coordinates against target city center
        const cleanCity = city.toLowerCase().trim();
        const cityRef = CITY_CENTERS[cleanCity] || CITY_CENTERS['kolkata'];
        if (driverLat !== null && driverLng !== null && cityRef) {
            const distFromCityCenter = calcDistanceKm(driverLat, driverLng, cityRef.lat, cityRef.lng);
            // If passed GPS is cross-country (> 150 km from target city), use city center reference
            if (distFromCityCenter > 150) {
                console.log(`[Demand Reference] Driver GPS (${driverLat}, ${driverLng}) is ${distFromCityCenter.toFixed(1)} km from ${city}. Using city center (${cityRef.lat}, ${cityRef.lng})`);
                driverLat = cityRef.lat;
                driverLng = cityRef.lng;
            }
        } else if ((driverLat === null || driverLng === null) && cityRef) {
            driverLat = cityRef.lat;
            driverLng = cityRef.lng;
        }

        // 1. Get configurable weights from payout_model_rates
        const ratesRes = await pool.query("SELECT * FROM payout_model_rates WHERE id = 'current_rates'");
        const rates = ratesRes.rows[0] || {};
        const searchWeight = parseFloat(rates.demand_search_weight !== undefined ? rates.demand_search_weight : 1.0);
        const bookingWeight = parseFloat(rates.demand_booking_weight !== undefined ? rates.demand_booking_weight : 3.0);

        // 2. Aggregate searches in rolling 2 hours
        const searchesRes = await pool.query(`
            SELECT pincode, MAX(area_name) as area_name, MAX(city) as city,
                   AVG(lat) as avg_lat, AVG(lng) as avg_lng,
                   COUNT(*)::int as search_count
            FROM pickup_searches
            WHERE created_at >= NOW() - INTERVAL '2 hours'
              AND (city ILIKE $1 OR $1 = '' OR $1 IS NULL)
            GROUP BY pincode
        `, [city ? `%${city}%` : '%']);

        // 3. Aggregate service requests (bookings) created in rolling 2 hours
        const twoHoursAgoEpochMs = Date.now() - (2 * 60 * 60 * 1000);
        const bookingsRes = await pool.query(`
            SELECT pincode, MAX(pickup_address) as pickup_address,
                   AVG(lat) as avg_lat, AVG(lng) as avg_lng,
                   COUNT(*)::int as booking_count
            FROM service_requests
            WHERE created_at >= $1
              AND pincode IS NOT NULL AND pincode != ''
            GROUP BY pincode
        `, [twoHoursAgoEpochMs]);


        // 4. Combine into unified demand map
        const demandMap = {};

        searchesRes.rows.forEach(r => {
            const pin = r.pincode;
            if (!demandMap[pin]) {
                demandMap[pin] = {
                    pincode: pin,
                    areaName: r.area_name || (PINCODE_METADATA_MAP[pin] ? PINCODE_METADATA_MAP[pin].areaName : `Area (${pin})`),
                    city: r.city || (PINCODE_METADATA_MAP[pin] ? PINCODE_METADATA_MAP[pin].city : city),
                    lat: r.avg_lat || (PINCODE_METADATA_MAP[pin] ? PINCODE_METADATA_MAP[pin].lat : null),
                    lng: r.avg_lng || (PINCODE_METADATA_MAP[pin] ? PINCODE_METADATA_MAP[pin].lng : null),
                    searchCount: 0,
                    bookingCount: 0
                };
            }
            demandMap[pin].searchCount += r.search_count;
        });

        bookingsRes.rows.forEach(r => {
            const pin = r.pincode;
            if (!demandMap[pin]) {
                demandMap[pin] = {
                    pincode: pin,
                    areaName: PINCODE_METADATA_MAP[pin] ? PINCODE_METADATA_MAP[pin].areaName : `Area (${pin})`,
                    city: PINCODE_METADATA_MAP[pin] ? PINCODE_METADATA_MAP[pin].city : city,
                    lat: r.avg_lat || (PINCODE_METADATA_MAP[pin] ? PINCODE_METADATA_MAP[pin].lat : null),
                    lng: r.avg_lng || (PINCODE_METADATA_MAP[pin] ? PINCODE_METADATA_MAP[pin].lng : null),
                    searchCount: 0,
                    bookingCount: 0
                };
            }
            demandMap[pin].bookingCount += r.booking_count;
        });

        // 5. Compute scores, levels, distance and directions
        const results = Object.values(demandMap).map(item => {
            const meta = PINCODE_METADATA_MAP[item.pincode] || {};
            const lat = item.lat || meta.lat || null;
            const lng = item.lng || meta.lng || null;
            const areaName = meta.areaName || item.areaName || `Area (${item.pincode})`;

            const score = (item.searchCount * searchWeight) + (item.bookingCount * bookingWeight);
            
            let demandLevel = 'Moderate';
            if (score >= 15 || item.bookingCount >= 3) demandLevel = 'Surge';
            else if (score >= 6 || item.bookingCount >= 1) demandLevel = 'High';

            let distanceKm = null;
            let direction = '';
            if (driverLat !== null && driverLng !== null && lat !== null && lng !== null) {
                distanceKm = parseFloat(calcDistanceKm(driverLat, driverLng, lat, lng).toFixed(1));
                direction = getDirection(driverLat, driverLng, lat, lng);
            }


            return {
                pincode: item.pincode,
                areaName,
                city: item.city || meta.city || city,
                demandScore: Math.round(score * 10) / 10,
                searchCount: item.searchCount,
                bookingCount: item.bookingCount,
                demandLevel,
                lat,
                lng,
                distanceKm,
                direction
            };
        });

        // Rank descending by demandScore
        results.sort((a, b) => b.demandScore - a.demandScore);

        res.json({
            success: true,
            windowHours: 2,
            city,
            weights: { searchWeight, bookingWeight },
            recommendedPincodes: results.slice(0, limit)
        });
    } catch (err) {
        console.error('Error getting recommended pincodes:', err);
        res.status(500).json({ error: 'Failed to compute recommended pincodes: ' + err.message });
    }
});

// ── Dual Payout Model (Commission % vs Subscription) ────────────────────────
// Public read endpoint for driver app and portals to consume platform payout & subscription rates
apiRouter.get('/payout-rates', async (req, res) => {
    try {
        const ratesRes = await pool.query("SELECT * FROM payout_model_rates WHERE id = 'current_rates'");
        const rates = ratesRes.rows[0] || {
            commission_rate_percent: 20.0,
            subscription_daily_price: 99.00,
            subscription_weekly_price: 499.00,
            subscription_monthly_price: 1499.00,
            subscription_quarterly_price: 3999.00,
            subscription_annual_price: 14999.00,
            demand_search_weight: 1.0,
            demand_booking_weight: 3.0
        };
        res.json({
            success: true,
            rates: {
                commissionRatePercent: parseFloat(rates.commission_rate_percent !== undefined ? rates.commission_rate_percent : 20.0),
                subscriptionDailyPrice: parseFloat(rates.subscription_daily_price !== undefined ? rates.subscription_daily_price : 99.00),
                subscriptionWeeklyPrice: parseFloat(rates.subscription_weekly_price !== undefined ? rates.subscription_weekly_price : 499.00),
                subscriptionMonthlyPrice: parseFloat(rates.subscription_monthly_price !== undefined ? rates.subscription_monthly_price : 1499.00),
                subscriptionQuarterlyPrice: parseFloat(rates.subscription_quarterly_price !== undefined ? rates.subscription_quarterly_price : 3999.00),
                subscriptionAnnualPrice: parseFloat(rates.subscription_annual_price !== undefined ? rates.subscription_annual_price : 14999.00),
                subscriptionYearlyPrice: parseFloat(rates.subscription_annual_price !== undefined ? rates.subscription_annual_price : 14999.00),
                demandSearchWeight: parseFloat(rates.demand_search_weight !== undefined ? rates.demand_search_weight : 1.0),
                demandBookingWeight: parseFloat(rates.demand_booking_weight !== undefined ? rates.demand_booking_weight : 3.0),
                updatedAt: rates.updated_at
            }
        });
    } catch (err) {
        console.error('Error fetching payout rates:', err);
        res.status(500).json({ error: 'Failed to fetch payout rates: ' + err.message });
    }
});

apiRouter.put('/admin/payout-rates', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
        const {
            commissionRatePercent,
            subscriptionDailyPrice,
            subscriptionWeeklyPrice,
            subscriptionMonthlyPrice,
            subscriptionQuarterlyPrice,
            subscriptionAnnualPrice,
            subscriptionYearlyPrice,
            demandSearchWeight,
            demandBookingWeight
        } = req.body;

        const comm = parseFloat(commissionRatePercent);
        if (isNaN(comm) || comm < 0 || comm > 100) {
            return res.status(400).json({ error: 'Commission rate must be between 0% and 100%.' });
        }

        const daily = parseFloat(subscriptionDailyPrice !== undefined ? subscriptionDailyPrice : 99.00);
        const weekly = parseFloat(subscriptionWeeklyPrice);
        const monthly = parseFloat(subscriptionMonthlyPrice);
        const quarterly = parseFloat(subscriptionQuarterlyPrice !== undefined ? subscriptionQuarterlyPrice : 3999.00);
        const annual = parseFloat(subscriptionYearlyPrice !== undefined ? subscriptionYearlyPrice : (subscriptionAnnualPrice !== undefined ? subscriptionAnnualPrice : 14999.00));

        if ([weekly, monthly, quarterly, annual].some(p => isNaN(p) || p < 0)) {
            return res.status(400).json({ error: 'Subscription prices must be non-negative numbers.' });
        }

        const searchW = demandSearchWeight !== undefined ? parseFloat(demandSearchWeight) : 1.0;
        const bookingW = demandBookingWeight !== undefined ? parseFloat(demandBookingWeight) : 3.0;

        if (isNaN(searchW) || searchW < 0 || isNaN(bookingW) || bookingW < 0) {
            return res.status(400).json({ error: 'Demand weights must be non-negative numbers.' });
        }

        await pool.query(`
            UPDATE payout_model_rates 
            SET commission_rate_percent = $1,
                subscription_daily_price = $2,
                subscription_weekly_price = $3,
                subscription_monthly_price = $4,
                subscription_annual_price = $5,
                subscription_quarterly_price = $6,
                demand_search_weight = $7,
                demand_booking_weight = $8,
                updated_at = NOW()
            WHERE id = 'current_rates'
        `, [comm, isNaN(daily) ? 99.00 : daily, weekly, monthly, annual, quarterly, searchW, bookingW]);

        res.json({
            success: true,
            message: 'Payout model rates & demand weights updated successfully.',
            rates: {
                commissionRatePercent: comm,
                subscriptionDailyPrice: isNaN(daily) ? 99.00 : daily,
                subscriptionWeeklyPrice: weekly,
                subscriptionMonthlyPrice: monthly,
                subscriptionQuarterlyPrice: quarterly,
                subscriptionAnnualPrice: annual,
                subscriptionYearlyPrice: annual,
                demandSearchWeight: searchW,
                demandBookingWeight: bookingW
            }
        });
    } catch (err) {
        console.error('Error updating payout rates:', err);
        res.status(500).json({ error: 'Failed to update rates: ' + err.message });
    }
});


function canSwitchPayoutModel(lastSwitchedAt) {
    if (!lastSwitchedAt) return true;
    const last = new Date(lastSwitchedAt);
    const now = new Date();
    return (last.getFullYear() !== now.getFullYear()) || (last.getMonth() !== now.getMonth());
}

apiRouter.put('/workers/:id/payout-plan', async (req, res) => {
    try {
        const id = req.params.id;
        const { requestedModel, requestedCycle } = req.body;

        if (!['commission', 'subscription'].includes(requestedModel)) {
            return res.status(400).json({ error: 'Invalid payout model requested.' });
        }
        if (requestedModel === 'subscription' && !['weekly', 'monthly', 'quarterly', 'yearly', 'annually', 'daily'].includes(requestedCycle)) {
            return res.status(400).json({ error: 'Invalid subscription cycle requested.' });
        }

        await syncExpiredSubscriptions();

        // Fetch driver current plan & last switched date
        const userRes = await pool.query(
            "SELECT payout_model, subscription_cycle, subscription_valid_until, payout_model_last_switched_at FROM users WHERE id = $1",
            [id]
        );
        if (userRes.rows.length === 0) return res.status(404).json({ error: 'Driver not found.' });

        const user = userRes.rows[0];

        // 1. Enforce once-per-calendar-month rule
        if (!canSwitchPayoutModel(user.payout_model_last_switched_at)) {
            return res.status(400).json({
                error: 'You can only switch your payout plan once per calendar month. Your next switch will be available on the 1st of next month.'
            });
        }

        // 2. Compute effective date
        let effectiveDate;
        const now = new Date();
        if (user.payout_model === 'subscription' && user.subscription_valid_until && new Date(user.subscription_valid_until) > now) {
            // Subscription -> Commission or Cycle change takes effect when current pre-paid subscription ends
            effectiveDate = new Date(user.subscription_valid_until);
        } else {
            // Commission -> Subscription takes effect on 1st of next calendar month at 00:00:00
            effectiveDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        }

        const effectiveDateStr = effectiveDate.toISOString().split('T')[0];

        // Update pending plan and mark last_switched_at timestamp
        await pool.query(`
            UPDATE users 
            SET pending_payout_model = $1,
                pending_subscription_cycle = $2,
                pending_effective_date = $3,
                payout_model_last_switched_at = NOW()
            WHERE id = $4
        `, [requestedModel, requestedModel === 'subscription' ? requestedCycle : null, effectiveDateStr, id]);

        await pool.query(`
            UPDATE garage_workers 
            SET pending_payout_model = $1,
                pending_subscription_cycle = $2,
                pending_effective_date = $3,
                payout_model_last_switched_at = NOW()
            WHERE id = $4
        `, [requestedModel, requestedModel === 'subscription' ? requestedCycle : null, effectiveDateStr, id]).catch(() => {});

        res.json({
            success: true,
            message: `Plan switch request saved. Your ${requestedModel} plan will take effect on ${effectiveDateStr}.`,
            pendingPlan: {
                model: requestedModel,
                cycle: requestedModel === 'subscription' ? requestedCycle : null,
                effectiveDate: effectiveDateStr
            }
        });
    } catch (err) {
        console.error('Error switching payout plan:', err);
        res.status(500).json({ error: 'Failed to request plan switch: ' + err.message });
    }
});

// ============================================================
// RAZORPAY DRIVER SUBSCRIPTION PAYMENT ENDPOINTS (LIVE SANDBOX)
// ============================================================
const Razorpay = require('razorpay');

function getRazorpayClient() {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
        throw new Error('Razorpay credentials missing from environment.');
    }
    return new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
    });
}

function getCycleDurationDays(cycle) {
    switch (cycle) {
        case 'daily': return 1; // legacy fallback
        case 'weekly': return 7;
        case 'monthly': return 30;
        case 'quarterly': return 90;
        case 'yearly':
        case 'annually': return 365;
        default: return 30;
    }
}

// 1. Create Razorpay Order (Strict Real Outbound API Call to api.razorpay.com)
apiRouter.post('/driver/subscription/create-order', async (req, res) => {
    try {
        const { driverId, cycle } = req.body;
        if (!driverId) return res.status(400).json({ error: 'Driver ID is required.' });
        if (!['weekly', 'monthly', 'quarterly', 'yearly', 'annually', 'daily'].includes(cycle)) {
            return res.status(400).json({ error: 'Invalid subscription cycle.' });
        }

        // Verify driver exists
        const driverRes = await pool.query("SELECT id, name, phone, is_test_account FROM users WHERE id = $1", [driverId]);
        if (driverRes.rows.length === 0) return res.status(404).json({ error: 'Driver not found.' });
        const driver = driverRes.rows[0];

        // Safety Gate: Block sandbox Razorpay checkout for real users unless live keys or is_test_account
        const isLiveMode = process.env.RAZORPAY_KEY_ID?.startsWith('rzp_live_');
        const isTestDriver = driver.is_test_account === true || driver.phone?.includes('9999999999') || driverId === 'm_1';
        if (!isLiveMode && !isTestDriver) {
            return res.status(403).json({
                error: 'Online subscription passes are launching shortly. Please continue earning under the standard commission model or contact support.',
                disabled: true
            });
        }

        // Fetch official rates from single source of truth
        const ratesRes = await pool.query("SELECT * FROM payout_model_rates WHERE id = 'current_rates'");
        const rates = ratesRes.rows[0] || {};
        let rateInRupees = 1499.00;
        if (cycle === 'daily') rateInRupees = parseFloat(rates.subscription_daily_price || 99.00);
        else if (cycle === 'weekly') rateInRupees = parseFloat(rates.subscription_weekly_price || 499.00);
        else if (cycle === 'monthly') rateInRupees = parseFloat(rates.subscription_monthly_price || 1499.00);
        else if (cycle === 'quarterly') rateInRupees = parseFloat(rates.subscription_quarterly_price || 3999.00);
        else if (cycle === 'annually' || cycle === 'yearly') rateInRupees = parseFloat(rates.subscription_annual_price || 14999.00);

        const amountPaise = Math.round(rateInRupees * 100);
        const receiptId = `rcpt_${Date.now().toString().slice(-8)}_${driverId.slice(-4)}`;

        // STRICT REAL OUTBOUND API CALL TO RAZORPAY
        const rzp = getRazorpayClient();
        const rzpOrder = await rzp.orders.create({
            amount: amountPaise,
            currency: 'INR',
            receipt: receiptId,
            notes: { driverId, cycle }
        });

        const paymentId = 'subpay_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        await pool.query(`
            INSERT INTO subscription_payments (
                id, driver_id, amount, currency, subscription_cycle, gateway_order_id, status, metadata, created_at, updated_at
            ) VALUES ($1, $2, $3, 'INR', $4, $5, 'created', $6, NOW(), NOW())
        `, [paymentId, driverId, rateInRupees, cycle, rzpOrder.id, JSON.stringify({ receipt: receiptId, razorpay_order: rzpOrder, driverName: driver.name, driverPhone: driver.phone })]);

        res.json({
            success: true,
            orderId: rzpOrder.id,
            amount: rzpOrder.amount,
            amountInRupees: rateInRupees,
            currency: rzpOrder.currency,
            keyId: process.env.RAZORPAY_KEY_ID,
            cycle,
            driver: {
                id: driver.id,
                name: driver.name,
                phone: driver.phone
            },
            rawRazorpayOrder: rzpOrder
        });
    } catch (err) {
        console.error('[RAZORPAY_CREATE_ORDER_ERROR]', err);
        res.status(500).json({ error: 'Razorpay order creation failed: ' + (err.error?.description || err.message) });
    }
});

// Helper for atomic payment activation and driver extension
async function activateDriverSubscriptionAtomic(gatewayOrderId, gatewayPaymentId, gatewaySignature, metadataUpdate = {}) {
    const claimRes = await pool.query(`
        UPDATE subscription_payments 
        SET status = 'captured',
            gateway_payment_id = $2,
            gateway_signature = $3,
            activated_from = NOW(),
            updated_at = NOW()
        WHERE gateway_order_id = $1 
          AND status != 'captured'
        RETURNING *;
    `, [gatewayOrderId, gatewayPaymentId, gatewaySignature]);

    if (claimRes.rows.length === 0) {
        // Race condition loss or already processed -> retrieve existing
        const existing = await pool.query("SELECT * FROM subscription_payments WHERE gateway_order_id = $1", [gatewayOrderId]);
        return { claimed: false, payment: existing.rows[0] };
    }

    const payment = claimRes.rows[0];
    const days = getCycleDurationDays(payment.subscription_cycle);

    // Atomic driver subscription validity extension using GREATEST(NOW(), valid_until)
    const updateDriverRes = await pool.query(`
        UPDATE users 
        SET payout_model = 'subscription',
            subscription_cycle = $1,
            subscription_valid_until = GREATEST(NOW(), COALESCE(subscription_valid_until, NOW())) + ($2 || ' days')::INTERVAL,
            pending_payout_model = NULL,
            pending_subscription_cycle = NULL,
            pending_effective_date = NULL,
            payout_model_last_switched_at = NOW()
        WHERE id = $3
        RETURNING id, name, phone, payout_model, subscription_cycle, subscription_valid_until;
    `, [payment.subscription_cycle, days, payment.driver_id]);

    const updatedDriver = updateDriverRes.rows[0];

    // Update payment record activated_until
    if (updatedDriver && updatedDriver.subscription_valid_until) {
        await pool.query(
            "UPDATE subscription_payments SET activated_until = $1 WHERE id = $2",
            [updatedDriver.subscription_valid_until, payment.id]
        );
    }

    // Sync SQLite users & garage_workers
    if (updatedDriver) {
        const subUntilStr = updatedDriver.subscription_valid_until ? new Date(updatedDriver.subscription_valid_until).toISOString() : null;
        db.run(`
            UPDATE users 
            SET payout_model = 'subscription',
                subscription_cycle = ?,
                subscription_valid_until = ?,
                pending_payout_model = NULL,
                pending_subscription_cycle = NULL,
                pending_effective_date = NULL
            WHERE id = ?
        `, [payment.subscription_cycle, subUntilStr, payment.driver_id], () => {});
        db.run(`
            UPDATE garage_workers 
            SET payout_model = 'subscription',
                subscription_cycle = ?,
                subscription_valid_until = ?,
                pending_payout_model = NULL,
                pending_subscription_cycle = NULL,
                pending_effective_date = NULL
            WHERE id = ?
        `, [payment.subscription_cycle, subUntilStr, payment.driver_id], () => {});
    }

    return { claimed: true, payment, driver: updatedDriver };
}

// 2. Client-Side Signature Verification & Activation (Strict HMAC Verification)
apiRouter.post('/driver/subscription/verify', async (req, res) => {
    try {
        const { orderId, paymentId, signature, driverId } = req.body;
        if (!orderId || !paymentId || !signature) {
            return res.status(400).json({ error: 'orderId, paymentId, and signature are required.' });
        }

        // STRICT HMAC-SHA256 SIGNATURE VERIFICATION
        const secret = process.env.RAZORPAY_KEY_SECRET;
        const expectedSignature = crypto
            .createHmac('sha256', secret)
            .update(`${orderId}|${paymentId}`)
            .digest('hex');

        if (signature !== expectedSignature) {
            return res.status(400).json({ 
                error: 'Invalid payment signature. Authentication failed.',
                expected: expectedSignature,
                received: signature
            });
        }

        const result = await activateDriverSubscriptionAtomic(
            orderId, 
            paymentId, 
            signature, 
            { channel: 'client_verify' }
        );

        if (!result.driver) {
            const drvRes = await pool.query("SELECT id, name, phone, payout_model, subscription_cycle, subscription_valid_until FROM users WHERE id = $1", [result.payment?.driver_id || driverId]);
            return res.json({
                success: true,
                message: 'Payment verified (already activated).',
                user: drvRes.rows[0],
                payment: result.payment
            });
        }

        res.json({
            success: true,
            message: 'Subscription payment verified and activated successfully.',
            user: result.driver,
            payment: result.payment,
            verifiedSignature: signature
        });
    } catch (err) {
        console.error('[RAZORPAY_VERIFY_ERROR]', err);
        res.status(500).json({ error: 'Payment verification failed: ' + err.message });
    }
});

// 3. Razorpay Webhook Handler (Strict Header & Payload HMAC Verification)
apiRouter.post('/webhooks/razorpay', async (req, res) => {
    try {
        const signature = req.headers['x-razorpay-signature'];
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

        if (!signature) {
            return res.status(400).json({ error: 'Missing x-razorpay-signature header' });
        }

        const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
        const expectedSig = crypto
            .createHmac('sha256', webhookSecret)
            .update(rawBody)
            .digest('hex');

        if (signature !== expectedSig) {
            console.warn('[WEBHOOK_REJECTED] Invalid signature received.');
            return res.status(400).json({ error: 'Invalid webhook signature.' });
        }

        const event = req.body.event;
        const payload = req.body.payload || {};

        if (event === 'payment.captured' || event === 'order.paid') {
            const paymentEntity = payload.payment?.entity || {};
            const orderId = paymentEntity.order_id || payload.order?.entity?.id;
            const paymentId = paymentEntity.id;

            if (orderId) {
                // 1. Try driver subscription activation
                const subResult = await activateDriverSubscriptionAtomic(
                    orderId,
                    paymentId,
                    'webhook_captured',
                    { webhookEvent: event }
                );
                if (subResult.claimed) {
                    console.log(`[WEBHOOK] ${event} driver subscription processed for ${orderId}`);
                } else {
                    // 2. Try customer ride advance payment activation
                    const rideResult = await activateRideAdvancePaymentAtomic(
                        orderId,
                        paymentId,
                        'webhook_captured',
                        { webhookEvent: event }
                    );
                    console.log(`[WEBHOOK] ${event} ride payment processed for ${orderId}, claimed: ${rideResult.claimed}`);
                }
            }
            return res.json({ status: 'ok', event });
        }

        if (event === 'payment.failed') {
            const paymentEntity = payload.payment?.entity || {};
            const orderId = paymentEntity.order_id;
            const errorDesc = paymentEntity.error_description || 'Payment failed at gateway';

            if (orderId) {
                await pool.query(`
                    UPDATE subscription_payments 
                    SET status = 'failed',
                        failure_reason = $2,
                        updated_at = NOW()
                    WHERE gateway_order_id = $1 AND status = 'created'
                `, [orderId, errorDesc]);
                await pool.query(`
                    UPDATE ride_payments 
                    SET status = 'failed',
                        failure_reason = $2,
                        updated_at = NOW()
                    WHERE gateway_order_id = $1 AND status = 'created'
                `, [orderId, errorDesc]);
                console.log(`[WEBHOOK] payment.failed marked for order ${orderId}`);
            }
            return res.json({ status: 'ok', event });
        }

        res.json({ status: 'ignored', event });
    } catch (err) {
        console.error('[WEBHOOK_ERROR]', err);
        res.status(500).json({ error: 'Webhook processing error: ' + err.message });
    }
});

// 4. CRM Subscription Ledger
apiRouter.get('/crm/driver-subscriptions', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
        await syncExpiredSubscriptions();
        const { status, cycle, driverId } = req.query;
        let query = `
            SELECT sp.*, u.name as driver_name, u.phone as driver_phone, u.payout_model as current_payout_model
            FROM subscription_payments sp
            LEFT JOIN users u ON sp.driver_id = u.id
            WHERE 1=1
        `;
        const params = [];
        let idx = 1;

        if (status) {
            query += ` AND sp.status = $${idx++}`;
            params.push(status);
        }
        if (cycle) {
            query += ` AND sp.subscription_cycle = $${idx++}`;
            params.push(cycle);
        }
        if (driverId) {
            query += ` AND sp.driver_id = $${idx++}`;
            params.push(driverId);
        }

        query += ` ORDER BY sp.created_at DESC LIMIT 100`;
        const result = await pool.query(query, params);
        res.json({ success: true, payments: result.rows });
    } catch (err) {
        console.error('Error fetching subscription ledger:', err);
        res.status(500).json({ error: 'Failed to fetch subscriptions: ' + err.message });
    }
});

// 5. CRM Admin Refund Action
apiRouter.post('/crm/driver-subscriptions/:id/refund', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
        const paymentId = req.params.id;
        const { adminId, reason } = req.body;
        if (!reason) return res.status(400).json({ error: 'A valid reason is required for refunds.' });

        const payRes = await pool.query("SELECT * FROM subscription_payments WHERE id = $1", [paymentId]);
        if (payRes.rows.length === 0) return res.status(404).json({ error: 'Subscription payment not found.' });

        const payment = payRes.rows[0];
        if (payment.status === 'refunded') return res.status(400).json({ error: 'Payment is already refunded.' });

        const days = getCycleDurationDays(payment.subscription_cycle);
        const refundDetails = {
            refundedAt: new Date().toISOString(),
            adminId: adminId || 'admin_ops',
            reason
        };

        // Mark payment record refunded
        await pool.query(`
            UPDATE subscription_payments 
            SET status = 'refunded',
                metadata = jsonb_set(metadata, '{refund_details}', $2::jsonb),
                updated_at = NOW()
            WHERE id = $1
        `, [paymentId, JSON.stringify(refundDetails)]);

        // Adjust/revoke subscription validity
        const driverRes = await pool.query("SELECT id, subscription_valid_until, payout_model FROM users WHERE id = $1", [payment.driver_id]);
        if (driverRes.rows.length > 0) {
            const driver = driverRes.rows[0];
            let newValidUntil = null;
            let newModel = driver.payout_model;

            if (driver.subscription_valid_until) {
                const currentExpiry = new Date(driver.subscription_valid_until);
                const reducedExpiry = new Date(currentExpiry.getTime() - (days * 24 * 60 * 60 * 1000));
                if (reducedExpiry > new Date()) {
                    newValidUntil = reducedExpiry.toISOString();
                } else {
                    newValidUntil = null;
                    newModel = 'commission';
                }
            } else {
                newModel = 'commission';
            }

            await pool.query(`
                UPDATE users 
                SET subscription_valid_until = $1,
                    payout_model = $2
                WHERE id = $3
            `, [newValidUntil, newModel, payment.driver_id]);

            db.run(`UPDATE users SET subscription_valid_until = ?, payout_model = ? WHERE id = ?`, [newValidUntil, newModel, payment.driver_id], () => {});
            db.run(`UPDATE garage_workers SET subscription_valid_until = ?, payout_model = ? WHERE id = ?`, [newValidUntil, newModel, payment.driver_id], () => {});
        }

        res.json({
            success: true,
            message: `Payment ${paymentId} successfully refunded and subscription duration revoked.`
        });
    } catch (err) {
        console.error('Error processing refund:', err);
        res.status(500).json({ error: 'Refund processing failed: ' + err.message });
    }
});

// ==========================================
// CUSTOMER ADVANCE PAYMENTS (RIDE BOOKING)
// ==========================================
// DUAL-LAYER ANTI-FRAUD & PROMO HELPERS
// ==========================================

function normalizeVehiclePlate(plate) {
    if (!plate || typeof plate !== 'string') return '';
    return plate.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

async function resolveVehiclePlate(vehicleId, passedPlate) {
    if (passedPlate && typeof passedPlate === 'string' && passedPlate.trim().length > 0) {
        return passedPlate.trim();
    }
    if (vehicleId) {
        try {
            const pgVeh = await pool.query("SELECT plate FROM vehicles WHERE id = $1 LIMIT 1", [vehicleId]);
            if (pgVeh.rows.length > 0 && pgVeh.rows[0].plate) {
                return pgVeh.rows[0].plate;
            }
        } catch (e) {}
        try {
            const sqliteVeh = await new Promise((resolve) => {
                db.get("SELECT plate FROM vehicles WHERE id = ?", [vehicleId], (err, row) => {
                    resolve(row || null);
                });
            });
            if (sqliteVeh && sqliteVeh.plate) {
                return sqliteVeh.plate;
            }
        } catch (e) {}
    }
    return null;
}

async function isSameCustomerAccount(custA, custB) {
    if (!custA || !custB) return false;
    if (custA === custB) return true;
    try {
        const res = await pool.query(
            `SELECT phone FROM customers WHERE id = $1 
             UNION 
             SELECT phone FROM users WHERE id = $1`, 
            [custA]
        );
        const phonesA = res.rows.map(r => r.phone).filter(Boolean);
        if (phonesA.length === 0) return false;
        
        const resB = await pool.query(
            `SELECT phone FROM customers WHERE id = $1 
             UNION 
             SELECT phone FROM users WHERE id = $1`, 
            [custB]
        );
        const phonesB = resB.rows.map(r => r.phone).filter(Boolean);
        return phonesA.some(pA => phonesB.includes(pA));
    } catch (e) {
        return false;
    }
}

async function registerPromoVehiclePlate({ plate, customerId, serviceRequestId }) {
    const norm = normalizeVehiclePlate(plate);
    if (!norm || !customerId) return null;
    try {
        const regId = 'pvr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        const insertRes = await pool.query(`
            INSERT INTO promo_vehicle_registrations (
                id, plate, normalized_plate, first_customer_id, first_promo_request_id, status, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, 'active', NOW(), NOW())
            ON CONFLICT (normalized_plate) DO NOTHING
            RETURNING *;
        `, [regId, plate, norm, customerId, serviceRequestId || null]);
        return insertRes.rows[0] || null;
    } catch (err) {
        console.warn('[PROMO_VEHICLE_REG_ERR]', err.message);
        return null;
    }
}

async function calculateServerSideFare(params) {
    const {
        customerId,
        customerPhone,
        phone,
        vehicleId,
        vehiclePlate,
        plate,
        distanceKm = 0,
        pricingMode = 'distance',
        estimatedHours = 4,
        vehicleType = 'car',
        vehicleCondition = 'Working',
        routeStops = [],
        bookingFlow = 'p2p'
    } = params;

    const typeKey = (vehicleType || 'car').toLowerCase();

    // 1. Fetch system settings
    const settingsRes = await pool.query("SELECT key, value FROM system_settings");
    const settings = {};
    settingsRes.rows.forEach(r => { settings[r.key] = r.value; });

    const dist = parseFloat(distanceKm) || 0;
    const ratePerKm = parseFloat(settings[`${typeKey}_customer_rate_per_km`] !== undefined ? settings[`${typeKey}_customer_rate_per_km`] : (settings['customer_rate_per_km'] || (typeKey === 'car' ? 30.0 : 8.0)));
    const baseFareFloor = parseFloat(settings[`${typeKey}_base_fare`] !== undefined ? settings[`${typeKey}_base_fare`] : (settings['base_fare'] || (typeKey === 'car' ? 150.0 : 50.0)));
    const haltRate = parseFloat(settings[`${typeKey}_halt_rate_per_min`] !== undefined ? settings[`${typeKey}_halt_rate_per_min`] : (settings['halt_rate_per_min'] || (typeKey === 'car' ? 5.0 : 3.0)));
    
    const defaultBaseCharge = typeKey === 'bike' ? 49.0 : 99.0;
    const platformBaseCharge = parseFloat(settings[`${typeKey}_platform_base_charge`] !== undefined ? settings[`${typeKey}_platform_base_charge`] : (settings['platform_base_charge'] || defaultBaseCharge));

    // Towing fee if vehicle is not working
    let towingFee = 0;
    if (vehicleCondition === 'Not Working') {
        const towingBase = parseFloat(settings['towing_base_fee'] || '500.0');
        const towingRatePerKm = parseFloat(settings['towing_rate_per_km'] || '30.0');
        towingFee = towingBase + (dist * towingRatePerKm);
    }

    if (pricingMode === 'hourly') {
        const hourlyRate = parseFloat(settings[`${typeKey}_hourly_rate`] || (typeKey === 'car' ? '150.0' : '80.0'));
        const hours = parseFloat(estimatedHours) || 4;
        const total = (hours * hourlyRate) + towingFee;
        const standardFare = Math.round(total * 100) / 100;
        return {
            customerFare: standardFare,
            totalCustomerPrice: standardFare,
            originalCustomerFare: standardFare,
            promoDiscountAmount: 0,
            isPromotionalRide: false,
            promoType: null,
            promoAbsorbedBy: 'redrivo',
            promoUsedCount: 0,
            promoRemainingCount: 0,
            isPlateDisqualified: false,
            promoDisqualificationReason: null,
            normalizedPlate: null,
            applicableDistanceCharge: 0,
            platformBaseCharge: 0,
            haltCharge: 0,
            towingFee: towingFee
        };
    }

    // Distance pricing mode: Platform Base Charge + max(Base Fare Floor, Distance * Rate per KM) + Halt Charges + Towing
    const rawDistanceCharge = Math.round(dist * ratePerKm);
    const applicableDistanceCharge = Math.max(baseFareFloor, rawDistanceCharge);

    let totalHaltMinutes = 0;
    if (Array.isArray(routeStops)) {
        routeStops.forEach(st => {
            totalHaltMinutes += parseInt(st.haltTime || st.halt_time) || 0;
        });
    }
    const haltCharge = totalHaltMinutes * haltRate;
    const standardTotalFare = Math.round((platformBaseCharge + applicableDistanceCharge + haltCharge + towingFee) * 100) / 100;

    // --- MULTI-OFFER PROMOTIONAL ENGINE & TIE-BREAK RESOLUTION ---
    const targetCustId = customerId || null;
    const targetPhone = customerPhone || phone || null;

    // Dual-layer Anti-Fraud: Global vehicle plate registration check across all promotional offers
    const rawPlate = await resolveVehiclePlate(vehicleId, vehiclePlate || plate);
    const normalizedPlate = normalizeVehiclePlate(rawPlate);
    let isPlateDisqualified = false;
    let promoDisqualificationReason = null;

    if (normalizedPlate) {
        try {
            const regRes = await pool.query(
                "SELECT * FROM promo_vehicle_registrations WHERE normalized_plate = $1 AND status = 'active' LIMIT 1",
                [normalizedPlate]
            );
            if (regRes.rows.length > 0) {
                const reg = regRes.rows[0];
                const isOwner = targetCustId ? await isSameCustomerAccount(reg.first_customer_id, targetCustId) : false;
                if (!isOwner) {
                    isPlateDisqualified = true;
                    promoDisqualificationReason = 'Vehicle plate is already registered to another account for promotional rides';
                }
            }
        } catch (plateErr) {
            console.warn('[PROMO_PLATE_CHECK_ERR]', plateErr.message);
        }
    }

    let winningOffer = null;
    let winningOfferUsedCount = 0;

    if (pricingMode === 'distance' && !isPlateDisqualified) {
        try {
            // 1. Fetch active offers matching current timestamp and vehicle scope
            const offersRes = await pool.query(`
                SELECT o.* FROM offers o
                WHERE o.status = 'active'
                  AND (o.start_date IS NULL OR o.start_date <= NOW())
                  AND (o.end_date >= NOW())
                  AND (o.vehicle_scope = 'both' OR o.vehicle_scope = $1)
                ORDER BY o.created_at ASC
            `, [typeKey]);

            const activeOffers = offersRes.rows || [];
            const candidateOffers = [];

            for (const offer of activeOffers) {
                let isAudienceEligible = false;
                if (offer.target_type === 'all') {
                    isAudienceEligible = true;
                } else if (offer.target_type === 'specific') {
                    if (targetCustId) {
                        const checkTarget = await pool.query(
                            `SELECT 1 FROM offer_target_customers otc
                             WHERE otc.offer_id = $1 
                               AND (otc.customer_id = $2 OR otc.customer_id IN (
                                   SELECT id FROM customers WHERE phone = (SELECT phone FROM customers WHERE id = $2 LIMIT 1)
                               )) LIMIT 1`,
                            [offer.id, targetCustId]
                        );
                        if (checkTarget.rows.length > 0) isAudienceEligible = true;
                    } else if (targetPhone) {
                        const checkTarget = await pool.query(
                            `SELECT 1 FROM offer_target_customers otc
                             JOIN customers c ON otc.customer_id = c.id
                             WHERE otc.offer_id = $1 AND c.phone = $2 LIMIT 1`,
                            [offer.id, targetPhone]
                        );
                        if (checkTarget.rows.length > 0) isAudienceEligible = true;
                    }
                }

                if (!isAudienceEligible) continue;

                // Count usage for this specific offer
                let usedCount = 0;
                if (targetCustId) {
                    const usageRes = await pool.query(
                        `SELECT COUNT(*)::int as count FROM service_requests 
                         WHERE (customerid = $1 OR customerid IN (SELECT id FROM customers WHERE phone = (SELECT phone FROM customers WHERE id = $1 LIMIT 1))) 
                           AND offer_id = $2
                           AND is_promotional_ride = true 
                           AND status NOT IN ('cancelled', 'rejected')`,
                        [targetCustId, offer.id]
                    ).catch(() => ({ rows: [{ count: 0 }] }));
                    usedCount = parseInt(usageRes.rows[0]?.count || 0, 10);
                } else if (targetPhone) {
                    const usageRes = await pool.query(
                        `SELECT COUNT(*)::int as count FROM service_requests 
                         WHERE customerid IN (SELECT id FROM customers WHERE phone = $1) 
                           AND offer_id = $2
                           AND is_promotional_ride = true 
                           AND status NOT IN ('cancelled', 'rejected')`,
                        [targetPhone, offer.id]
                    ).catch(() => ({ rows: [{ count: 0 }] }));
                    usedCount = parseInt(usageRes.rows[0]?.count || 0, 10);
                }

                const remainingCount = Math.max(0, offer.ride_count - usedCount);
                if (remainingCount > 0) {
                    candidateOffers.push({
                        offer,
                        usedCount,
                        remainingCount,
                        isSpecific: offer.target_type === 'specific',
                        endTime: new Date(offer.end_date).getTime()
                    });
                }
            }

            // TIE-BREAK RULE:
            // 1. Specific Target ('specific') takes priority over General ('all')
            // 2. Earliest End Date (expires soonest first)
            // 3. Highest Remaining Free Rides
            if (candidateOffers.length > 0) {
                candidateOffers.sort((a, b) => {
                    if (a.isSpecific !== b.isSpecific) return a.isSpecific ? -1 : 1;
                    if (a.endTime !== b.endTime) return a.endTime - b.endTime;
                    return b.remainingCount - a.remainingCount;
                });
                winningOffer = candidateOffers[0].offer;
                winningOfferUsedCount = candidateOffers[0].usedCount;
            }
        } catch (offerErr) {
            console.warn('[OFFER_RESOLUTION_ERR]', offerErr.message);
        }
    }

    let customerChargedFare = standardTotalFare;
    let promoDiscountAmount = 0;
    let isPromotionalRide = false;
    let promoType = null;
    let appliedOfferId = null;
    let appliedOfferName = null;
    const originalCustomerFare = standardTotalFare;

    if (winningOffer) {
        isPromotionalRide = true;
        promoType = 'free_ride_offer';
        appliedOfferId = winningOffer.id;
        appliedOfferName = winningOffer.name;
        const maxPromoKm = parseFloat(winningOffer.max_free_distance_km || 30.0);

        if (dist <= maxPromoKm) {
            // Option B: <= maxPromoKm is 100% free (waiving platform charge, base fare & distance charge)
            customerChargedFare = towingFee;
            promoDiscountAmount = Math.max(0, originalCustomerFare - customerChargedFare);
        } else {
            // Option B: > maxPromoKm waives first maxPromoKm, customer pays only for distance beyond maxPromoKm
            const overDistanceKm = dist - maxPromoKm;
            const marginalDistanceCharge = Math.round(overDistanceKm * ratePerKm);
            customerChargedFare = Math.round((marginalDistanceCharge + haltCharge + towingFee) * 100) / 100;
            promoDiscountAmount = Math.max(0, originalCustomerFare - customerChargedFare);
        }
    }

    return {
        customerFare: customerChargedFare,
        totalCustomerPrice: customerChargedFare,
        originalCustomerFare: originalCustomerFare,
        promoDiscountAmount: promoDiscountAmount,
        isPromotionalRide: isPromotionalRide,
        promoType: promoType,
        offerId: appliedOfferId,
        offerName: appliedOfferName,
        promoAbsorbedBy: 'redrivo',
        promoUsedCount: winningOfferUsedCount,
        promoRemainingCount: winningOffer ? Math.max(0, winningOffer.ride_count - winningOfferUsedCount - 1) : 0,
        isPlateDisqualified: !!isPlateDisqualified,
        promoDisqualificationReason: promoDisqualificationReason || null,
        normalizedPlate: normalizedPlate || null,
        applicableDistanceCharge: applicableDistanceCharge,
        platformBaseCharge: platformBaseCharge,
        haltCharge: haltCharge,
        towingFee: towingFee
    };
}

// Unified API endpoint for calculating live customer fare and driver payout
apiRouter.post('/pricing/calculate', async (req, res) => {
    try {
        const {
            customerId,
            customerPhone,
            vehicleId,
            vehiclePlate,
            plate,
            distanceKm = 0,
            pricingMode = 'distance',
            estimatedHours = 4,
            vehicleType = 'car',
            vehicleCondition = 'Working',
            routeStops = [],
            bookingFlow = 'p2p',
            driverPayoutModel = 'commission'
        } = req.body;

        const pricing = await calculateServerSideFare({
            customerId,
            customerPhone,
            vehicleId,
            vehiclePlate,
            plate,
            distanceKm,
            pricingMode,
            estimatedHours,
            vehicleType,
            vehicleCondition,
            routeStops,
            bookingFlow
        });

        const commRes = await pool.query("SELECT commission_rate_percent FROM payout_model_rates WHERE id = 'current_rates'");
        const commPct = parseFloat(commRes.rows[0]?.commission_rate_percent !== undefined ? commRes.rows[0].commission_rate_percent : 20.0);
        
        const isSubscribed = driverPayoutModel === 'subscription';
        // CRITICAL REQUIREMENT: Driver payout calculated on FULL original fare, NEVER on discounted promo fare
        const driverPayout = isSubscribed ? pricing.originalCustomerFare : Math.round(pricing.originalCustomerFare * (1 - (commPct / 100)));
        const platformCommission = pricing.originalCustomerFare - driverPayout;

        res.json({
            success: true,
            customerFare: pricing.customerFare,
            originalCustomerFare: pricing.originalCustomerFare,
            promoDiscountAmount: pricing.promoDiscountAmount,
            isPromotionalRide: pricing.isPromotionalRide,
            promoType: pricing.promoType,
            offerId: pricing.offerId || null,
            offerName: pricing.offerName || null,
            promoAbsorbedBy: pricing.promoAbsorbedBy,
            promoUsedCount: pricing.promoUsedCount,
            promoRemainingCount: pricing.promoRemainingCount,
            isPlateDisqualified: pricing.isPlateDisqualified,
            promoDisqualificationReason: pricing.promoDisqualificationReason,
            normalizedPlate: pricing.normalizedPlate,
            platformBaseCharge: pricing.platformBaseCharge,
            applicableDistanceCharge: pricing.applicableDistanceCharge,
            driverPayout,
            commissionRatePercent: commPct,
            isSubscribed,
            platformCommission
        });
    } catch (err) {
        console.error('Pricing calculation error:', err);
        res.status(500).json({ error: 'Failed to calculate pricing: ' + err.message });
    }
});

// ==========================================
// OFFERS MANAGEMENT REST APIS (CRM ADMIN)
// ==========================================

// 1. List all offers with audience counts, usage, and subsidized metrics
apiRouter.get('/offers', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
        const offersRes = await pool.query(`
            SELECT 
                o.*,
                COALESCE(
                    (SELECT COUNT(*)::int FROM offer_target_customers otc WHERE otc.offer_id = o.id),
                    0
                ) as target_customer_count,
                COALESCE(
                    (SELECT COUNT(*)::int FROM service_requests sr 
                     WHERE sr.offer_id = o.id AND sr.is_promotional_ride = true AND sr.status NOT IN ('cancelled', 'rejected')),
                    0
                ) as claimed_rides_count,
                COALESCE(
                    (SELECT SUM(sr.promo_discount_amount)::numeric FROM service_requests sr 
                     WHERE sr.offer_id = o.id AND sr.is_promotional_ride = true AND sr.status NOT IN ('cancelled', 'rejected')),
                    0
                ) as subsidized_amount_total
            FROM offers o
            ORDER BY o.created_at DESC
        `);

        const offers = [];
        for (const offer of offersRes.rows) {
            let targetCustomers = [];
            if (offer.target_type === 'specific') {
                const custRes = await pool.query(`
                    SELECT c.id, c.name, c.phone, c.email 
                    FROM offer_target_customers otc
                    JOIN customers c ON otc.customer_id = c.id
                    WHERE otc.offer_id = $1
                    ORDER BY c.name ASC
                `, [offer.id]);
                targetCustomers = custRes.rows;
            }
            offers.push({
                ...offer,
                ride_count: parseInt(offer.ride_count || 5, 10),
                max_free_distance_km: parseFloat(offer.max_free_distance_km || 30.0),
                claimed_rides_count: parseInt(offer.claimed_rides_count || 0, 10),
                subsidized_amount_total: parseFloat(offer.subsidized_amount_total || 0),
                target_customer_count: parseInt(offer.target_customer_count || 0, 10),
                target_customers: targetCustomers
            });
        }

        res.json({ success: true, offers });
    } catch (err) {
        console.error('[GET_OFFERS_ERR]', err);
        res.status(500).json({ error: 'Failed to fetch offers: ' + err.message });
    }
});

// 2. Real-time Customer Usage Ledger across offers
apiRouter.get('/offers/usage', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
        const usageRes = await pool.query(`
            SELECT 
                sr.customerid as customer_id,
                COALESCE(c.name, 'Customer') as customer_name,
                COALESCE(c.phone, '') as customer_phone,
                COALESCE(c.email, '') as customer_email,
                sr.offer_id,
                COALESCE(o.name, 'Launch Promotion') as offer_name,
                COALESCE(o.ride_count, 5) as rides_allotted,
                COALESCE(o.status, 'active') as offer_status,
                o.end_date as offer_end_date,
                COUNT(sr.id)::int as rides_used,
                COALESCE(SUM(sr.promo_discount_amount), 0)::numeric as total_subsidized,
                MAX(sr.created_at) as last_used_at
            FROM service_requests sr
            LEFT JOIN customers c ON sr.customerid = c.id
            LEFT JOIN offers o ON sr.offer_id = o.id
            WHERE sr.is_promotional_ride = true 
              AND sr.status NOT IN ('cancelled', 'rejected')
              AND sr.offer_id IS NOT NULL
            GROUP BY sr.customerid, c.name, c.phone, c.email, sr.offer_id, o.name, o.ride_count, o.status, o.end_date
            ORDER BY MAX(sr.created_at) DESC
        `);

        const usage = (usageRes.rows || []).map(row => {
            const used = parseInt(row.rides_used || 0, 10);
            const allotted = parseInt(row.rides_allotted || 5, 10);
            return {
                ...row,
                rides_used: used,
                rides_allotted: allotted,
                rides_remaining: Math.max(0, allotted - used),
                total_subsidized: parseFloat(row.total_subsidized || 0)
            };
        });

        res.json({ success: true, usage });
    } catch (err) {
        console.error('[GET_OFFERS_USAGE_ERR]', err);
        res.status(500).json({ error: 'Failed to fetch offer usage ledger: ' + err.message });
    }
});

// 3. Autocomplete Customer Search for Offer Targeting
apiRouter.get('/crm/customers/search', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        const searchPattern = `%${q}%`;
        const result = await pool.query(`
            SELECT id, name, phone, email 
            FROM customers 
            WHERE status != 'banned'
              AND ($1 = '' OR name ILIKE $2 OR phone ILIKE $2 OR email ILIKE $2)
            ORDER BY name ASC 
            LIMIT 25
        `, [q, searchPattern]);

        res.json({ success: true, customers: result.rows || [] });
    } catch (err) {
        console.error('[CUSTOMER_SEARCH_ERR]', err);
        res.status(500).json({ error: 'Customer search failed: ' + err.message });
    }
});

// 4. Create new Promotional Offer
apiRouter.post('/offers', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
        const {
            name,
            description,
            ride_count = 5,
            max_free_distance_km = 30.0,
            start_date,
            end_date,
            vehicle_scope = 'both',
            target_type = 'all',
            customer_ids = []
        } = req.body;

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return res.status(400).json({ error: 'Offer name is required.' });
        }
        if (!end_date) {
            return res.status(400).json({ error: 'Offer end date is mandatory.' });
        }
        const parsedEndDate = new Date(end_date);
        if (isNaN(parsedEndDate.getTime())) {
            return res.status(400).json({ error: 'Invalid end date format.' });
        }
        if (parsedEndDate.getTime() <= Date.now()) {
            return res.status(400).json({ error: 'End date must be in the future.' });
        }

        const rides = parseInt(ride_count, 10);
        if (isNaN(rides) || rides < 1) {
            return res.status(400).json({ error: 'Free ride allotment must be at least 1.' });
        }

        const maxDist = parseFloat(max_free_distance_km);
        if (isNaN(maxDist) || maxDist <= 0) {
            return res.status(400).json({ error: 'Maximum free distance must be greater than 0 km.' });
        }

        const validVehicleScopes = ['car', 'bike', 'both'];
        const scope = validVehicleScopes.includes(vehicle_scope) ? vehicle_scope : 'both';

        const validTargetTypes = ['all', 'specific'];
        const target = validTargetTypes.includes(target_type) ? target_type : 'all';

        if (target === 'specific' && (!Array.isArray(customer_ids) || customer_ids.length === 0)) {
            return res.status(400).json({ error: 'Please select at least one customer for a targeted offer.' });
        }

        const offerId = 'off_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        const startDateVal = start_date ? new Date(start_date).toISOString() : new Date().toISOString();
        const endDateVal = parsedEndDate.toISOString();
        const adminId = req.user?.id || 'u_admin';

        const insertRes = await pool.query(`
            INSERT INTO offers (
                id, name, description, ride_count, max_free_distance_km,
                start_date, end_date, vehicle_scope, target_type, status,
                created_by, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, NOW(), NOW())
            RETURNING *;
        `, [
            offerId, name.trim(), description ? description.trim() : null,
            rides, maxDist, startDateVal, endDateVal, scope, target, adminId
        ]);

        const newOffer = insertRes.rows[0];

        if (target === 'specific' && Array.isArray(customer_ids) && customer_ids.length > 0) {
            for (const custId of customer_ids) {
                if (!custId) continue;
                await pool.query(`
                    INSERT INTO offer_target_customers (offer_id, customer_id, created_at)
                    VALUES ($1, $2, NOW())
                    ON CONFLICT (offer_id, customer_id) DO NOTHING
                `, [offerId, custId]);
            }
        }

        res.json({ success: true, offer: newOffer });
    } catch (err) {
        console.error('[CREATE_OFFER_ERR]', err);
        res.status(500).json({ error: 'Failed to create offer: ' + err.message });
    }
});

// 5. Update Offer details or toggle status (Pause/Resume/Edit)
apiRouter.patch('/offers/:id', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const {
            name,
            description,
            ride_count,
            max_free_distance_km,
            start_date,
            end_date,
            vehicle_scope,
            target_type,
            status,
            customer_ids
        } = req.body;

        const checkRes = await pool.query("SELECT * FROM offers WHERE id = $1", [id]);
        if (checkRes.rows.length === 0) {
            return res.status(404).json({ error: 'Offer not found.' });
        }
        const existing = checkRes.rows[0];

        let updatedName = name !== undefined ? String(name).trim() : existing.name;
        let updatedDesc = description !== undefined ? (description ? String(description).trim() : null) : existing.description;
        let updatedRides = ride_count !== undefined ? parseInt(ride_count, 10) : existing.ride_count;
        let updatedMaxDist = max_free_distance_km !== undefined ? parseFloat(max_free_distance_km) : parseFloat(existing.max_free_distance_km);
        let updatedStartDate = start_date !== undefined ? new Date(start_date).toISOString() : existing.start_date;
        let updatedEndDate = existing.end_date;
        let updatedScope = vehicle_scope !== undefined ? vehicle_scope : existing.vehicle_scope;
        let updatedTarget = target_type !== undefined ? target_type : existing.target_type;
        let updatedStatus = status !== undefined ? status : existing.status;

        if (end_date !== undefined) {
            const parsedEnd = new Date(end_date);
            if (isNaN(parsedEnd.getTime())) {
                return res.status(400).json({ error: 'Invalid end date format.' });
            }
            updatedEndDate = parsedEnd.toISOString();
        }

        const updateRes = await pool.query(`
            UPDATE offers SET
                name = $1,
                description = $2,
                ride_count = $3,
                max_free_distance_km = $4,
                start_date = $5,
                end_date = $6,
                vehicle_scope = $7,
                target_type = $8,
                status = $9,
                updated_at = NOW()
            WHERE id = $10
            RETURNING *;
        `, [
            updatedName, updatedDesc, updatedRides, updatedMaxDist,
            updatedStartDate, updatedEndDate, updatedScope, updatedTarget,
            updatedStatus, id
        ]);

        if (customer_ids !== undefined && Array.isArray(customer_ids)) {
            await pool.query("DELETE FROM offer_target_customers WHERE offer_id = $1", [id]);
            if (updatedTarget === 'specific') {
                for (const custId of customer_ids) {
                    if (!custId) continue;
                    await pool.query(`
                        INSERT INTO offer_target_customers (offer_id, customer_id, created_at)
                        VALUES ($1, $2, NOW())
                        ON CONFLICT (offer_id, customer_id) DO NOTHING
                    `, [id, custId]);
                }
            }
        }

        res.json({ success: true, offer: updateRes.rows[0] });
    } catch (err) {
        console.error('[UPDATE_OFFER_ERR]', err);
        res.status(500).json({ error: 'Failed to update offer: ' + err.message });
    }
});

// 6. Delete or Archive Offer
apiRouter.delete('/offers/:id', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const checkRes = await pool.query("SELECT * FROM offers WHERE id = $1", [id]);
        if (checkRes.rows.length === 0) {
            return res.status(404).json({ error: 'Offer not found.' });
        }

        const usageCheck = await pool.query(
            "SELECT COUNT(*)::int as count FROM service_requests WHERE offer_id = $1",
            [id]
        );
        const usedCount = parseInt(usageCheck.rows[0]?.count || 0, 10);

        if (usedCount > 0) {
            await pool.query("UPDATE offers SET status = 'archived', updated_at = NOW() WHERE id = $1", [id]);
            return res.json({
                success: true,
                archived: true,
                message: `Offer has ${usedCount} associated ride records and was safely archived.`
            });
        } else {
            await pool.query("DELETE FROM offers WHERE id = $1", [id]);
            return res.json({
                success: true,
                archived: false,
                message: 'Offer deleted successfully.'
            });
        }
    } catch (err) {
        console.error('[DELETE_OFFER_ERR]', err);
        res.status(500).json({ error: 'Failed to delete offer: ' + err.message });
    }
});

// Dedicated endpoint to check vehicle promo eligibility
apiRouter.post('/promo/check-vehicle', async (req, res) => {
    try {
        const { plate, vehicleId, customerId } = req.body;
        const rawPlate = await resolveVehiclePlate(vehicleId, plate);
        const norm = normalizeVehiclePlate(rawPlate);
        if (!norm) {
            return res.json({ success: true, eligible: true, message: 'No vehicle plate provided' });
        }

        const regRes = await pool.query(
            "SELECT * FROM promo_vehicle_registrations WHERE normalized_plate = $1 AND status = 'active' LIMIT 1",
            [norm]
        );

        if (regRes.rows.length === 0) {
            return res.json({
                success: true,
                eligible: true,
                normalizedPlate: norm,
                registered: false,
                message: 'Vehicle plate is eligible for promotional rides'
            });
        }

        const reg = regRes.rows[0];
        const isOwner = customerId ? await isSameCustomerAccount(reg.first_customer_id, customerId) : false;

        if (isOwner) {
            return res.json({
                success: true,
                eligible: true,
                normalizedPlate: norm,
                registered: true,
                isOwner: true,
                message: 'Vehicle plate is registered to this account and eligible'
            });
        } else {
            return res.json({
                success: true,
                eligible: false,
                normalizedPlate: norm,
                registered: true,
                isOwner: false,
                message: 'Vehicle plate is already registered to another account for promotional rides'
            });
        }
    } catch (err) {
        console.error('[PROMO_CHECK_VEHICLE_ERR]', err);
        res.status(500).json({ error: 'Failed to check vehicle promo status: ' + err.message });
    }
});

// Atomic helper for activating customer ride advance payment
async function activateRideAdvancePaymentAtomic(orderId, paymentId, signature, meta = {}) {
    const updateRes = await pool.query(`
        UPDATE ride_payments
        SET status = 'captured',
            gateway_payment_id = $2,
            gateway_signature = $3,
            metadata = jsonb_set(metadata, '{claim_source}', $4::jsonb),
            updated_at = NOW()
        WHERE gateway_order_id = $1 AND status != 'captured'
        RETURNING *;
    `, [orderId, paymentId, signature, JSON.stringify(meta)]);

    if (updateRes.rows.length === 0) {
        const existing = await pool.query("SELECT * FROM ride_payments WHERE gateway_order_id = $1", [orderId]);
        return { claimed: false, payment: existing.rows[0] };
    }

    const payment = updateRes.rows[0];
    const payMeta = payment.metadata || {};

    // 1. Clear customer outstanding balance if settled in this payment
    if (payMeta.outstandingBalance > 0) {
        await pool.query("UPDATE customers SET outstanding_balance = 0 WHERE id = $1", [payment.customer_id]);
    }

    // 2. PUBLISH TO DRIVERS: Now insert service_requests with status 'pending' and is_advance_paid = true
    const draftId = payment.service_request_id;
    const reqMeta = payMeta.requestParams || {};
    const pricingObj = payMeta.pricingObj || {};

    const isPromo = pricingObj.isPromotionalRide || reqMeta.is_promotional_ride || false;
    const promoType = isPromo ? (pricingObj.promoType || 'first_n_rides_free') : null;
    const origFare = isPromo ? (pricingObj.originalCustomerFare || payment.estimated_fare) : (payment.estimated_fare || 0);
    const discountAmt = isPromo ? (pricingObj.promoDiscountAmount || 0) : 0;
    const absorbedBy = isPromo ? (pricingObj.promoAbsorbedBy || 'redrivo') : 'redrivo';
    const offerId = pricingObj.offerId || reqMeta.offerId || reqMeta.offer_id || null;

    // SQLite dual-write for legacy polling feeds
    db.run(
        `INSERT INTO service_requests
         (id, customerId, vehicleId, garageId, date, status, totalCustomerPrice,
          lat, lng, pickup_address, drop_address, issue, service_category, booking_flow, pickup_drop_type, route_stops, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET status = 'pending'`,
        [
            draftId, payment.customer_id, reqMeta.vehicleId || null, reqMeta.garageId || null,
            new Date().toISOString().split('T')[0], payment.estimated_fare,
            reqMeta.lat || null, reqMeta.lng || null,
            reqMeta.pickup_address || null, reqMeta.drop_address || null,
            reqMeta.issue || 'Pending Driver Inspection', reqMeta.serviceCategory || 'Standard Service',
            reqMeta.bookingFlow || 'p2p', reqMeta.pickupDropType || 'Pickup',
            JSON.stringify(reqMeta.routeStops || []), Date.now()
        ]
    );

    // PostgreSQL write
    await pool.query(`
        INSERT INTO service_requests (
            id, customerid, vehicleid, garageid, date, status, totalcustomerprice,
            lat, lng, pickup_address, drop_address, is_advance_paid, created_at,
            is_promotional_ride, promo_type, original_customer_fare, promo_discount_amount, promo_absorbed_by, offer_id
        ) VALUES ($1, $2, $3, $4, CURRENT_DATE, 'pending', $5, $6, $7, $8, $9, true, EXTRACT(EPOCH FROM NOW())*1000, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (id) DO UPDATE SET 
            status = 'pending', 
            is_advance_paid = true,
            is_promotional_ride = EXCLUDED.is_promotional_ride,
            promo_type = EXCLUDED.promo_type,
            original_customer_fare = EXCLUDED.original_customer_fare,
            promo_discount_amount = EXCLUDED.promo_discount_amount,
            promo_absorbed_by = EXCLUDED.promo_absorbed_by,
            offer_id = EXCLUDED.offer_id;
    `, [
        draftId, payment.customer_id, reqMeta.vehicleId || null, reqMeta.garageId || null,
        payment.estimated_fare, reqMeta.lat || null, reqMeta.lng || null,
        reqMeta.pickup_address || null, reqMeta.drop_address || null,
        isPromo, promoType, origFare, discountAmt, absorbedBy, offerId
    ]).catch(e => console.error("PG service_requests insert error:", e));

    if (isPromo) {
        const resolvedPlate = await resolveVehiclePlate(reqMeta.vehicleId, reqMeta.plate || reqMeta.vehiclePlate);
        if (resolvedPlate) {
            await registerPromoVehiclePlate({
                plate: resolvedPlate,
                customerId: payment.customer_id,
                serviceRequestId: draftId
            });
        }
    }

    return { claimed: true, payment };
}

// 1. Create Customer Advance Payment Order
apiRouter.post('/customer/booking/create-order', async (req, res) => {
    try {
        const {
            customerId, vehicleId, vehiclePlate, plate, garageId,
            lat, lng, pickup_address, drop_address,
            distanceKm, pricingMode, estimatedHours,
            vehicleType, vehicleCondition, routeStops,
            issue, serviceType, bookingFlow, pickupDropType,
            tripId, requestId, amount
        } = req.body;

        // Safety Kill Switch: Check if customer advance payments feature is enabled OR live keys active
        const featRes = await pool.query("SELECT value FROM system_settings WHERE key = 'enable_customer_advance_payment'");
        const isGlobalEnabled = featRes.rows[0]?.value === 'true' || process.env.ENABLE_CUSTOMER_ADVANCE_PAYMENT === 'true' || process.env.RAZORPAY_KEY_ID?.startsWith('rzp_live_');

        // Check if customer is a verified test account from database
        let isTestAccount = false;
        try {
            const custRes = await pool.query("SELECT is_test_account, phone FROM customers WHERE id = $1 UNION SELECT is_test_account, phone FROM users WHERE id = $1", [customerId]);
            if (custRes.rows[0]?.is_test_account === true || custRes.rows[0]?.phone?.includes('9999999999') || customerId === 'cust_test_9999999999') {
                isTestAccount = true;
            }
        } catch(e) {}

        const isEnabled = isGlobalEnabled || isTestAccount;
        if (!isEnabled) {
            return res.status(403).json({
                error: 'Customer advance payments are currently disabled in production.',
                disabled: true
            });
        }

        // Ensure customer exists in PostgreSQL customers table
        await pool.query(`
            INSERT INTO customers (id, name, phone, email)
            VALUES ($1, 'Customer', '+919999999999', 'customer@redrivo.com')
            ON CONFLICT (id) DO NOTHING;
        `, [customerId]);

        // Check outstanding balance on debt ledger
        const custRes = await pool.query("SELECT outstanding_balance FROM customers WHERE id = $1", [customerId]);
        const outstandingBalance = parseFloat(custRes.rows[0]?.outstanding_balance || 0);

        // Calculate fare: use explicit amount if passed from confirmed bid, or calculate server-side
        let calculatedFare = parseFloat(amount);
        let pricingObj = null;
        if (isNaN(calculatedFare) || calculatedFare < 0) {
            pricingObj = await calculateServerSideFare({
                customerId,
                vehicleId,
                vehiclePlate,
                plate,
                distanceKm, pricingMode, estimatedHours,
                vehicleType: vehicleType || 'car',
                vehicleCondition: vehicleCondition || 'Working',
                routeStops: routeStops || [],
                bookingFlow: bookingFlow || 'p2p'
            });
            calculatedFare = typeof pricingObj === 'object' ? pricingObj.totalCustomerPrice : pricingObj;
        }

        const totalPayableRupees = Math.max(1.00, calculatedFare + outstandingBalance);
        const amountPaise = Math.round(totalPayableRupees * 100);

        const targetRequestId = requestId || tripId || ('req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6));
        const receiptId = `rcpt_ride_${Date.now().toString().slice(-8)}`;

        // STRICT REAL OUTBOUND CALL TO RAZORPAY
        const rzp = getRazorpayClient();
        const rzpOrder = await rzp.orders.create({
            amount: amountPaise,
            currency: 'INR',
            receipt: receiptId,
            notes: { customerId, targetRequestId, tripId: tripId || '', outstandingBalance }
        });

        const paymentId = `ridepay_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const requestParams = {
            vehicleId, vehiclePlate, plate, garageId, lat, lng, pickup_address, drop_address,
            distanceKm, pricingMode, estimatedHours, vehicleType, vehicleCondition,
            routeStops, issue, serviceCategory: serviceType || issue || 'Standard Service',
            bookingFlow, pickupDropType, tripId,
            is_promotional_ride: pricingObj?.isPromotionalRide || false
        };

        await pool.query(`
            INSERT INTO ride_payments (
                id, service_request_id, customer_id, estimated_fare, amount_paid,
                gateway_order_id, status, metadata, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, 'created', $7, NOW(), NOW())
        `, [
            paymentId, targetRequestId, customerId, calculatedFare, totalPayableRupees,
            rzpOrder.id, JSON.stringify({ rzpOrder, requestParams, pricingObj, outstandingBalance, tripId })
        ]);

        res.json({
            success: true,
            orderId: rzpOrder.id,
            amount: rzpOrder.amount,
            amountInRupees: totalPayableRupees,
            currency: rzpOrder.currency,
            keyId: process.env.RAZORPAY_KEY_ID,
            draftRequestId: targetRequestId,
            tripId: tripId || null,
            outstandingBalanceIncluded: outstandingBalance,
            calculatedFare,
            pricing: pricingObj
        });
    } catch (err) {
        console.error('[CUSTOMER_CREATE_ORDER_ERROR]', err);
        res.status(500).json({ error: 'Failed to create payment order: ' + (err.error?.description || err.message) });
    }
});

// 2. Cryptographic Verification & Dispatch Gate
apiRouter.post('/customer/booking/verify-advance', async (req, res) => {
    try {
        const { orderId, paymentId, signature, draftRequestId, tripId, requestId } = req.body;
        if (!orderId || !paymentId || !signature) {
            return res.status(400).json({ error: 'Missing payment verification parameters.' });
        }

        // Strict HMAC-SHA256 Authentication
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(`${orderId}|${paymentId}`)
            .digest('hex');

        if (expectedSignature !== signature) {
            return res.status(400).json({
                error: 'Invalid payment signature. Authentication failed.',
                expected: expectedSignature,
                received: signature
            });
        }

        // Update ride_payments status to captured
        await pool.query(`
            UPDATE ride_payments
            SET status = 'captured',
                gateway_payment_id = $1,
                gateway_signature = $2,
                updated_at = NOW()
            WHERE gateway_order_id = $3
        `, [paymentId, signature, orderId]);

        const targetTripId = tripId;
        const targetReqId = draftRequestId || requestId;
        if (targetTripId) {
            await pool.query("UPDATE trips SET status = 'pending_otp_1' WHERE id = $1", [targetTripId]);
        }
        if (targetReqId) {
            await pool.query("UPDATE service_requests SET status = 'marshal_assigned' WHERE id = $1", [targetReqId]);
            await pool.query("UPDATE service_request_bids SET status = 'accepted' WHERE service_request_id = $1", [targetReqId]);
        }

        res.json({
            success: true,
            message: 'Advance payment verified and driver dispatched.',
            requestId: targetReqId,
            tripId: targetTripId,
            paymentId,
            verifiedSignature: signature
        });
    } catch (err) {
        console.error('[CUSTOMER_VERIFY_PAYMENT_ERROR]', err);
        res.status(500).json({ error: 'Verification failed: ' + err.message });
    }
});

// 3. Customer Cancellation & Tiered Auto-Refund
apiRouter.post('/customer/booking/cancel', async (req, res) => {
    try {
        const { requestId, customerId, reason } = req.body;
        if (!requestId) return res.status(400).json({ error: 'Request ID is required.' });

        const payRes = await pool.query("SELECT * FROM ride_payments WHERE service_request_id = $1", [requestId]);
        if (payRes.rows.length === 0) return res.status(404).json({ error: 'Ride payment record not found.' });
        const payment = payRes.rows[0];

        if (payment.status === 'refunded') {
            return res.status(400).json({ error: 'Payment is already fully refunded.' });
        }

        // Fetch dynamic system settings for cancellation
        const settingsRes = await pool.query("SELECT key, value FROM system_settings WHERE key IN ('customer_cancellation_fee', 'customer_cancellation_grace_seconds')");
        const settings = {};
        settingsRes.rows.forEach(r => { settings[r.key] = r.value; });

        const cancellationFee = parseFloat(settings['customer_cancellation_fee'] || '50.0');
        const graceSeconds = parseInt(settings['customer_cancellation_grace_seconds'] || '180');

        // Check service request status
        const srRes = await pool.query("SELECT status, workerid, created_at FROM service_requests WHERE id = $1", [requestId]);
        const sr = srRes.rows[0] || {};

        let refundAmount = parseFloat(payment.amount_paid);
        let feeDeducted = 0;

        // Tiered cancellation policy
        if (sr.status === 'marshal_assigned' && sr.workerid) {
            // Check time elapsed since creation / assignment
            const elapsed = Math.floor((Date.now() - (parseFloat(sr.created_at) || Date.now())) / 1000);
            if (elapsed > graceSeconds) {
                feeDeducted = Math.min(cancellationFee, refundAmount);
                refundAmount = Math.max(0, refundAmount - feeDeducted);
            }
        }

        let rzpRefund = null;
        if (refundAmount > 0 && payment.gateway_payment_id) {
            const rzp = getRazorpayClient();
            rzpRefund = await rzp.payments.refund(payment.gateway_payment_id, {
                amount: Math.round(refundAmount * 100),
                notes: { reason: reason || 'customer_cancellation', requestId, feeDeducted }
            });
        }

        const newStatus = refundAmount === parseFloat(payment.amount_paid) ? 'refunded' : 'partially_refunded';
        await pool.query(`
            UPDATE ride_payments
            SET status = $1,
                refund_id = $2,
                refund_amount = $3,
                fare_difference = $4,
                updated_at = NOW()
            WHERE id = $5
        `, [newStatus, rzpRefund?.id || 'manual_refund', refundAmount, feeDeducted, payment.id]);

        // Update service_requests status
        await pool.query("UPDATE service_requests SET status = 'cancelled' WHERE id = $1", [requestId]);
        db.run("UPDATE service_requests SET status = 'cancelled' WHERE id = ?", [requestId], () => {});

        res.json({
            success: true,
            message: `Booking cancelled. ₹${refundAmount.toFixed(2)} refunded. Fee deducted: ₹${feeDeducted.toFixed(2)}.`,
            refundAmount,
            feeDeducted,
            refundId: rzpRefund?.id || null
        });
    } catch (err) {
        console.error('[CUSTOMER_CANCEL_ERROR]', err);
        res.status(500).json({ error: 'Cancellation failed: ' + (err.error?.description || err.message) });
    }
});

// 4. 60-Second No Driver Found Auto-Refund
apiRouter.post('/customer/booking/timeout-refund', async (req, res) => {
    try {
        const { requestId } = req.body;
        if (!requestId) return res.status(400).json({ error: 'Request ID is required.' });

        const payRes = await pool.query("SELECT * FROM ride_payments WHERE service_request_id = $1", [requestId]);
        if (payRes.rows.length === 0) return res.status(404).json({ error: 'Ride payment record not found.' });
        const payment = payRes.rows[0];

        if (payment.status === 'refunded') {
            return res.json({ success: true, message: 'Already refunded.', refundAmount: payment.refund_amount });
        }

        const refundAmount = parseFloat(payment.amount_paid);
        let rzpRefund = null;

        if (payment.gateway_payment_id) {
            const rzp = getRazorpayClient();
            rzpRefund = await rzp.payments.refund(payment.gateway_payment_id, {
                amount: Math.round(refundAmount * 100),
                notes: { reason: 'driver_search_timeout_60s', requestId }
            });
        }

        await pool.query(`
            UPDATE ride_payments
            SET status = 'refunded',
                refund_id = $1,
                refund_amount = $2,
                updated_at = NOW()
            WHERE id = $3
        `, [rzpRefund?.id || 'timeout_refund', refundAmount, payment.id]);

        await pool.query("UPDATE service_requests SET status = 'returned' WHERE id = $1", [requestId]);
        db.run("UPDATE service_requests SET status = 'returned' WHERE id = ?", [requestId], () => {});

        res.json({
            success: true,
            message: 'Search timed out. 100% advance payment refunded automatically.',
            refundAmount,
            refundId: rzpRefund?.id || null
        });
    } catch (err) {
        console.error('[TIMEOUT_REFUND_ERROR]', err);
        res.status(500).json({ error: 'Timeout refund failed: ' + (err.error?.description || err.message) });
    }
});

// =========================================================================
// SYMMETRIC CANCELLATION & NO-SHOW ENGINE (TIER 1 - TIER 4)
// =========================================================================

// Cancellation Settings: GET
apiRouter.get('/settings/cancellation', async (req, res) => {
    try {
        const sRes = await pool.query("SELECT key, value FROM system_settings WHERE key IN ('customer_free_cancel_window_seconds', 'customer_cancellation_fee', 'driver_noshow_timeout_minutes', 'driver_noshow_penalty', 'customer_noshow_wait_minutes', 'customer_noshow_penalty', 'gps_arrival_geofence_meters')");
        const settings = {
            customer_free_cancel_window_seconds: 180,
            customer_cancellation_fee: 50.0,
            driver_noshow_timeout_minutes: 60,
            driver_noshow_penalty: 49.0,
            customer_noshow_wait_minutes: 10,
            customer_noshow_penalty: 99.0,
            gps_arrival_geofence_meters: 300
        };
        (sRes.rows || []).forEach(r => {
            const num = Number(r.value);
            settings[r.key] = isNaN(num) ? r.value : num;
        });
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Cancellation Settings: POST (Admin)
apiRouter.post('/settings/cancellation', authMiddleware, requireRole('admin'), async (req, res) => {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') {
        return res.status(400).json({ error: 'Settings object is required' });
    }
    try {
        const keys = [
            'customer_free_cancel_window_seconds',
            'customer_cancellation_fee',
            'driver_noshow_timeout_minutes',
            'driver_noshow_penalty',
            'customer_noshow_wait_minutes',
            'customer_noshow_penalty',
            'gps_arrival_geofence_meters'
        ];
        for (const k of keys) {
            if (settings[k] !== undefined) {
                await pool.query(
                    "INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value",
                    [k, String(settings[k])]
                );
                try {
                    db.run(
                        "INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value",
                        [k, String(settings[k])]
                    );
                } catch(e) {}
            }
        }
        res.json({ success: true, message: 'Cancellation settings updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Mark Driver Arrived at Pickup (GPS + Timestamp)
apiRouter.post('/trips/:id/mark-arrived', authMiddleware, async (req, res) => {
    const tripId = req.params.id;
    const { lat, lng } = req.body;
    try {
        const tripRes = await pool.query("SELECT * FROM trips WHERE id = $1", [tripId]);
        if (tripRes.rows.length === 0) return res.status(404).json({ error: 'Trip not found' });
        const trip = tripRes.rows[0];

        // Fetch dynamic arrival geofence setting (default 300m)
        const sRes = await pool.query("SELECT value FROM system_settings WHERE key = 'gps_arrival_geofence_meters'");
        const geofenceMeters = sRes.rows[0] ? parseInt(sRes.rows[0].value || '300', 10) : 300;
        const geofenceKm = geofenceMeters / 1000;

        // Geofence check if coordinates supplied
        if (lat && lng && trip.pickuplat && trip.pickuplng) {
            const distKm = calcDistanceKm(parseFloat(lat), parseFloat(lng), parseFloat(trip.pickuplat), parseFloat(trip.pickuplng));
            if (distKm > geofenceKm) {
                return res.status(400).json({
                    error: `Arrival verification failed: You are ${Math.round(distKm * 1000)}m from the pickup pin. Please move closer (within ${geofenceMeters}m) to mark arrival.`
                });
            }
        }

        const now = new Date();
        await pool.query(`
            UPDATE trips
            SET status = 'arrived',
                arrived_at = $1,
                marshallat = COALESCE($2, marshallat),
                marshallng = COALESCE($3, marshallng)
            WHERE id = $4
        `, [now, lat || null, lng || null, tripId]);

        if (trip.servicerequestid) {
            await pool.query("UPDATE service_requests SET status = 'arrived', arrived_at = $1 WHERE id = $2", [now, trip.servicerequestid]);
        }

        // Priority 1 Notification: Dispatch Arrival Alerts (Customer FCM Push + Driver FCM Push)
        (async () => {
            try {
                const cust = await getTripCustomerInfo(trip);
                const custId = cust?.id || trip.customerid || trip.customerId;
                if (custId) {
                    notifyUserFCM(custId, 'Driver Arrived', 'ReDrivo Alert: Your driver has arrived at your pickup location. Please head to your vehicle now to start your trip.', {
                        tripId,
                        type: 'driver_arrived'
                    });
                }
                const driverId = trip.marshalid || trip.workerid;
                if (driverId) {
                    notifyUserFCM(driverId, 'Arrived at Pickup', 'Arrival verified. Customer notified. Please wait for customer at vehicle.', {
                        tripId,
                        type: 'driver_arrived'
                    });
                }
            } catch (notifErr) {
                console.warn('[MARK_ARRIVED_NOTIF_ERR]', notifErr.message);
            }
        })();

        res.json({ success: true, message: 'Driver arrival recorded successfully', arrivedAt: now });
    } catch (err) {
        console.error('[MARK_ARRIVED_ERROR]', err);
        res.status(500).json({ error: err.message });
    }
});

// Cancellation Quote: Confirm-Before-Action calculation
apiRouter.post('/trips/:id/cancellation-quote', authMiddleware, async (req, res) => {
    const tripId = req.params.id;
    const { requestedBy } = req.body; // 'customer' or 'driver' or 'admin'
    try {
        const tripRes = await pool.query(`
            SELECT t.*, sr.created_at as sr_created_at, sr.assigned_at as sr_assigned_at,
                   sr.totalcustomerprice, sr.workerid
            FROM trips t
            LEFT JOIN service_requests sr ON t.servicerequestid = sr.id
            WHERE t.id = $1
        `, [tripId]);
        if (tripRes.rows.length === 0) return res.status(404).json({ error: 'Trip not found' });
        const trip = tripRes.rows[0];

        const sRes = await pool.query("SELECT key, value FROM system_settings WHERE key IN ('customer_free_cancel_window_seconds', 'customer_cancellation_fee', 'driver_noshow_timeout_minutes', 'driver_noshow_penalty', 'customer_noshow_wait_minutes', 'customer_noshow_penalty')");
        const settings = {};
        sRes.rows.forEach(r => { settings[r.key] = r.value; });

        const freeWindowSec = parseInt(settings['customer_free_cancel_window_seconds'] || '180');
        const standardCancelFee = parseFloat(settings['customer_cancellation_fee'] || '50.0');
        const driverNoshowTimeoutMin = parseInt(settings['driver_noshow_timeout_minutes'] || '60');
        const driverNoshowPenalty = parseFloat(settings['driver_noshow_penalty'] || '49.0');
        const customerNoshowWaitMin = parseInt(settings['customer_noshow_wait_minutes'] || '10');
        const customerNoshowPenalty = parseFloat(settings['customer_noshow_penalty'] || '99.0');

        const payRes = await pool.query("SELECT * FROM ride_payments WHERE service_request_id = $1 OR trip_id = $2", [trip.servicerequestid, tripId]);
        const payment = payRes.rows[0];
        const prepaidAmount = payment ? parseFloat(payment.amount_paid || 0) : parseFloat(trip.totalcustomerprice || 0);

        const driverId = trip.marshalid || trip.workerid;
        let isSubscribed = false;
        if (driverId) {
            const subRes = await pool.query("SELECT payout_model, subscription_valid_until FROM users WHERE id = $1", [driverId]);
            const drv = subRes.rows[0];
            isSubscribed = drv && drv.payout_model === 'subscription' && drv.subscription_valid_until && new Date(drv.subscription_valid_until) >= new Date();
        }

        const now = Date.now();
        const assignedAt = new Date(trip.assigned_at || trip.sr_assigned_at || trip.createdat || now).getTime();
        const arrivedAt = trip.arrived_at ? new Date(trip.arrived_at).getTime() : null;
        const elapsedSinceAssignmentSec = Math.floor((now - assignedAt) / 1000);
        const elapsedSinceArrivalSec = arrivedAt ? Math.floor((now - arrivedAt) / 1000) : 0;

        const pickupEtaMin = parseFloat(trip.pickup_eta_minutes || 15);
        const effectiveDriverTimeoutSec = Math.max(driverNoshowTimeoutMin, Math.ceil(pickupEtaMin * 1.5)) * 60;

        let tier = 'tier1_free_cancel';
        let tierName = 'Free Cancellation Window';
        let customerFee = 0;
        let refundAmount = prepaidAmount;
        let driverPayout = 0;
        let driverPenalty = 0;
        let canCancel = true;
        let waitRemainingSeconds = 0;
        let description = '';

        if (requestedBy === 'driver' || trip.status === 'arrived') {
            if (arrivedAt) {
                const requiredWaitSec = customerNoshowWaitMin * 60;
                if (elapsedSinceArrivalSec < requiredWaitSec) {
                    canCancel = false;
                    waitRemainingSeconds = requiredWaitSec - elapsedSinceArrivalSec;
                    tier = 'waiting_customer';
                    tierName = 'Driver Waiting at Pickup';
                    description = `Driver must wait ${Math.ceil(waitRemainingSeconds / 60)} more minute(s) before reporting customer no-show.`;
                } else {
                    tier = 'tier4_customer_noshow';
                    tierName = 'Tier 4: Customer No-Show';
                    customerFee = customerNoshowPenalty;
                    refundAmount = Math.max(0, prepaidAmount - customerNoshowPenalty);
                    driverPayout = isSubscribed ? customerNoshowPenalty : Math.round(customerNoshowPenalty * 0.8 * 100) / 100;
                    description = `Customer did not arrive after ${customerNoshowWaitMin} mins wait. Customer is charged ₹${customerFee} penalty, driver receives ₹${driverPayout} compensation.`;
                }
            }
        } else {
            if (elapsedSinceAssignmentSec >= effectiveDriverTimeoutSec && !arrivedAt) {
                tier = 'tier3_driver_noshow';
                tierName = 'Tier 3: Driver No-Show';
                customerFee = 0;
                refundAmount = prepaidAmount;
                driverPenalty = driverNoshowPenalty;
                description = `Driver did not arrive within ${Math.round(effectiveDriverTimeoutSec / 60)} minutes. Customer receives 100% full refund (₹${refundAmount}), driver assessed ₹${driverPenalty} penalty.`;
            } else if (arrivedAt) {
                tier = 'tier4_customer_noshow';
                tierName = 'Cancellation After Driver Arrival';
                customerFee = customerNoshowPenalty;
                refundAmount = Math.max(0, prepaidAmount - customerNoshowPenalty);
                driverPayout = isSubscribed ? customerNoshowPenalty : Math.round(customerNoshowPenalty * 0.8 * 100) / 100;
                description = `Driver has already reached pickup location. Cancellation fee ₹${customerFee} applies. Driver receives ₹${driverPayout}.`;
            } else if (elapsedSinceAssignmentSec > freeWindowSec) {
                tier = 'tier2_standard_cancel';
                tierName = 'Tier 2: Standard Cancellation';
                customerFee = Math.min(standardCancelFee, prepaidAmount > 0 ? prepaidAmount : standardCancelFee);
                refundAmount = Math.max(0, prepaidAmount - customerFee);
                driverPayout = Math.round(customerFee * 0.8 * 100) / 100;
                description = `Free cancellation window (${Math.round(freeWindowSec / 60)} mins) has passed. Cancellation fee of ₹${customerFee} applies.`;
            } else {
                tier = 'tier1_free_cancel';
                tierName = 'Tier 1: Free Cancellation';
                customerFee = 0;
                refundAmount = prepaidAmount;
                description = `Within free cancellation window (${Math.round(freeWindowSec / 60)} mins). ₹0 charge, 100% refund (₹${refundAmount}).`;
            }
        }

        res.json({
            success: true,
            tripId,
            tier,
            tierName,
            customerFee,
            refundAmount,
            driverPayout,
            driverPenalty,
            canCancel,
            waitRemainingSeconds,
            prepaidAmount,
            description
        });
    } catch (err) {
        console.error('[CANCEL_QUOTE_ERROR]', err);
        res.status(500).json({ error: err.message });
    }
});

// Cancel Symmetric: Atomic, idempotent execution across all 4 tiers
apiRouter.post(['/trips/:id/cancel-symmetric', '/trips/:id/cancel'], authMiddleware, async (req, res) => {
    const tripId = req.params.id;
    const { reason, requestedBy } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Lock trip atomically
        const tripRes = await client.query(`
            SELECT t.*, sr.created_at as sr_created_at, sr.assigned_at as sr_assigned_at,
                   sr.totalcustomerprice, sr.workerid, sr.id as sr_id, sr.customerid
            FROM trips t
            LEFT JOIN service_requests sr ON t.servicerequestid = sr.id
            WHERE t.id = $1
            FOR UPDATE
        `, [tripId]);

        if (tripRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Trip not found' });
        }
        const trip = tripRes.rows[0];

        // Idempotency check: if already completed or cancelled
        if (['cancelled', 'completed', 'customer_noshow', 'driver_noshow'].includes(trip.status)) {
            await client.query('ROLLBACK');
            return res.json({
                success: true,
                message: `Trip is already marked as ${trip.status}. No additional penalty or refund was processed.`,
                status: trip.status,
                alreadyProcessed: true
            });
        }

        // Fetch settings
        const sRes = await client.query("SELECT key, value FROM system_settings WHERE key IN ('customer_free_cancel_window_seconds', 'customer_cancellation_fee', 'driver_noshow_timeout_minutes', 'driver_noshow_penalty', 'customer_noshow_wait_minutes', 'customer_noshow_penalty')");
        const settings = {};
        sRes.rows.forEach(r => { settings[r.key] = r.value; });

        const freeWindowSec = parseInt(settings['customer_free_cancel_window_seconds'] || '180');
        const standardCancelFee = parseFloat(settings['customer_cancellation_fee'] || '50.0');
        const driverNoshowTimeoutMin = parseInt(settings['driver_noshow_timeout_minutes'] || '60');
        const driverNoshowPenalty = parseFloat(settings['driver_noshow_penalty'] || '49.0');
        const customerNoshowWaitMin = parseInt(settings['customer_noshow_wait_minutes'] || '10');
        const customerNoshowPenalty = parseFloat(settings['customer_noshow_penalty'] || '99.0');

        // Fetch payment
        const payRes = await client.query("SELECT * FROM ride_payments WHERE service_request_id = $1 OR trip_id = $2 FOR UPDATE", [trip.servicerequestid, tripId]);
        const payment = payRes.rows[0];
        const prepaidAmount = payment ? parseFloat(payment.amount_paid || 0) : parseFloat(trip.totalcustomerprice || 0);

        // Fetch driver subscription rate
        const driverId = trip.marshalid || trip.workerid;
        let isSubscribed = false;
        if (driverId) {
            const subRes = await client.query("SELECT payout_model, subscription_valid_until FROM users WHERE id = $1", [driverId]);
            const drv = subRes.rows[0];
            isSubscribed = drv && drv.payout_model === 'subscription' && drv.subscription_valid_until && new Date(drv.subscription_valid_until) >= new Date();
        }

        const now = Date.now();
        const assignedAt = new Date(trip.assigned_at || trip.sr_assigned_at || trip.createdat || now).getTime();
        const arrivedAt = trip.arrived_at ? new Date(trip.arrived_at).getTime() : null;
        const elapsedSinceAssignmentSec = Math.floor((now - assignedAt) / 1000);
        const elapsedSinceArrivalSec = arrivedAt ? Math.floor((now - arrivedAt) / 1000) : 0;
        const pickupEtaMin = parseFloat(trip.pickup_eta_minutes || 15);
        const effectiveDriverTimeoutSec = Math.max(driverNoshowTimeoutMin, Math.ceil(pickupEtaMin * 1.5)) * 60;

        let finalTier = 'tier1_free_cancel';
        let customerFee = 0;
        let refundAmount = prepaidAmount;
        let driverPayout = 0;
        let driverPenalty = 0;
        let newTripStatus = 'cancelled';

        if (requestedBy === 'driver' && arrivedAt) {
            const requiredWaitSec = customerNoshowWaitMin * 60;
            if (elapsedSinceArrivalSec < requiredWaitSec) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    error: `Cannot report customer no-show yet. Must wait full ${customerNoshowWaitMin} minutes. ${Math.ceil((requiredWaitSec - elapsedSinceArrivalSec) / 60)} min remaining.`
                });
            }
            finalTier = 'tier4_customer_noshow';
            newTripStatus = 'customer_noshow';
            customerFee = customerNoshowPenalty;
            refundAmount = Math.max(0, prepaidAmount - customerNoshowPenalty);
            driverPayout = isSubscribed ? customerNoshowPenalty : Math.round(customerNoshowPenalty * 0.8 * 100) / 100;
        } else {
            if (elapsedSinceAssignmentSec >= effectiveDriverTimeoutSec && !arrivedAt) {
                finalTier = 'tier3_driver_noshow';
                newTripStatus = 'driver_noshow';
                customerFee = 0;
                refundAmount = prepaidAmount;
                driverPenalty = driverNoshowPenalty;
            } else if (arrivedAt) {
                finalTier = 'tier4_customer_noshow';
                newTripStatus = 'customer_noshow';
                customerFee = customerNoshowPenalty;
                refundAmount = Math.max(0, prepaidAmount - customerNoshowPenalty);
                driverPayout = isSubscribed ? customerNoshowPenalty : Math.round(customerNoshowPenalty * 0.8 * 100) / 100;
            } else if (elapsedSinceAssignmentSec > freeWindowSec) {
                finalTier = 'tier2_standard_cancel';
                newTripStatus = 'cancelled';
                customerFee = Math.min(standardCancelFee, prepaidAmount > 0 ? prepaidAmount : standardCancelFee);
                refundAmount = Math.max(0, prepaidAmount - customerFee);
                driverPayout = Math.round(customerFee * 0.8 * 100) / 100;
            } else {
                finalTier = 'tier1_free_cancel';
                newTripStatus = 'cancelled';
                customerFee = 0;
                refundAmount = prepaidAmount;
            }
        }

        // Razorpay refund execution
        let rzpRefund = null;
        if (payment && payment.gateway_payment_id && refundAmount > 0 && payment.status !== 'refunded') {
            try {
                const rzp = getRazorpayClient();
                rzpRefund = await rzp.payments.refund(payment.gateway_payment_id, {
                    amount: Math.round(refundAmount * 100),
                    notes: {
                        tripId,
                        tier: finalTier,
                        customerFee,
                        reason: reason || finalTier
                    }
                });
            } catch (rErr) {
                console.warn('[RAZORPAY_REFUND_NOTICE]', rErr.message);
            }
        }

        // Update ride_payments
        if (payment) {
            const payStatus = refundAmount === prepaidAmount ? 'refunded' : (refundAmount > 0 ? 'partially_refunded' : payment.status);
            await client.query(`
                UPDATE ride_payments
                SET status = $1,
                    refund_id = $2,
                    refund_amount = $3,
                    fare_difference = $4,
                    updated_at = NOW()
                WHERE id = $5
            `, [payStatus, rzpRefund?.id || 'refund_' + Date.now(), refundAmount, customerFee, payment.id]);
        }

        // Ledger entries in incentives table
        if (driverId) {
            if (driverPenalty > 0) {
                const penaltyId = `pen_noshow_${Date.now()}`;
                await client.query(`
                    INSERT INTO incentives (id, userid, tripid, amount, type, status)
                    VALUES ($1, $2, $3, $4, 'driver_noshow_penalty', 'completed')
                `, [penaltyId, driverId, tripId, -driverPenalty]);

                // Create appealable Dispute record
                const dispId = `disp_${Date.now()}`;
                await client.query(`
                    INSERT INTO disputes (id, tripId, customerId, marshalId, reason, status, deductionAmount)
                    VALUES ($1, $2, $3, $4, $5, 'pending', $6)
                `, [dispId, tripId, trip.customerid || null, driverId, `Driver No-Show Penalty (${driverNoshowTimeoutMin}m threshold exceeded)`, driverPenalty]);
            }

            if (driverPayout > 0) {
                const payoutId = `inc_payout_${Date.now()}`;
                await client.query(`
                    INSERT INTO incentives (id, userid, tripid, amount, type, status)
                    VALUES ($1, $2, $3, $4, 'cancellation_compensation', 'completed')
                `, [payoutId, driverId, tripId, driverPayout]);
            }
        }

        // Update trips table
        await client.query(`
            UPDATE trips
            SET status = $1,
                cancellation_tier = $2,
                cancellation_reason = $3,
                cancellation_fee = $4,
                refund_amount = $5,
                penalty_amount = $6
            WHERE id = $7
        `, [newTripStatus, finalTier, reason || finalTier, customerFee, refundAmount, driverPenalty, tripId]);

        if (trip.sr_id) {
            await client.query(`
                UPDATE service_requests
                SET status = $1,
                    cancellation_tier = $2
                WHERE id = $3
            `, [newTripStatus, finalTier, trip.sr_id]);
        }

        await client.query('COMMIT');

        // Priority 1: Dispatch cancellation notifications & email receipts asynchronously
        (async () => {
            try {
                const cust = await getTripCustomerInfo(trip, pool);
                const custId = cust?.id || trip.customerid || trip.customerId;

                if (finalTier === 'tier1_free_cancel') {
                    if (custId) {
                        notifyUserFCM(custId, 'Booking Cancelled (Free)', `Your booking was cancelled within the free cancellation window. ₹${refundAmount.toFixed(2)} (100%) has been refunded.`, {
                            tripId,
                            tier: finalTier,
                            refundAmount: String(refundAmount),
                            customerFee: '0',
                            type: 'trip_cancelled'
                        });
                    }
                    if (driverId) {
                        notifyUserFCM(driverId, 'Booking Cancelled', `Trip was cancelled by customer within free window (₹0 fee). You have been returned to available driver pool.`, {
                            tripId,
                            tier: finalTier,
                            type: 'trip_cancelled'
                        });
                    }
                } else if (finalTier === 'tier2_standard_cancel') {
                    if (custId) {
                        notifyUserFCM(custId, 'Booking Cancelled', `Booking cancelled while driver was en route. Cancellation fee: ₹${customerFee.toFixed(2)}. Refund: ₹${refundAmount.toFixed(2)}.`, {
                            tripId,
                            tier: finalTier,
                            refundAmount: String(refundAmount),
                            customerFee: String(customerFee),
                            type: 'trip_cancelled'
                        });
                    }
                    if (driverId) {
                        notifyUserFCM(driverId, 'Trip Cancelled — Compensation Credited', `Customer cancelled while you were en route. ₹${driverPayout.toFixed(2)} compensation has been credited to your wallet.`, {
                            tripId,
                            tier: finalTier,
                            driverPayout: String(driverPayout),
                            type: 'trip_cancelled'
                        });
                    }
                } else if (finalTier === 'tier3_driver_noshow') {
                    if (custId) {
                        notifyUserFCM(custId, 'Driver No-Show — Full Refund', `We apologize, your driver did not reach on time. 100% refund of ₹${refundAmount.toFixed(2)} has been processed.`, {
                            tripId,
                            tier: finalTier,
                            refundAmount: String(refundAmount),
                            customerFee: '0',
                            type: 'trip_cancelled'
                        });
                    }
                    if (driverId) {
                        notifyUserFCM(driverId, 'Driver No-Show Penalty', `Trip cancelled due to arrival timeout. A penalty of ₹${driverPenalty.toFixed(2)} was debited. You may appeal on Dispute Board.`, {
                            tripId,
                            tier: finalTier,
                            driverPenalty: String(driverPenalty),
                            type: 'trip_cancelled'
                        });
                    }
                } else if (finalTier === 'tier4_customer_noshow') {
                    if (custId) {
                        notifyUserFCM(custId, 'Customer No-Show Recorded', `Trip cancelled as Customer No-Show after driver arrival. No-show fee: ₹${customerFee.toFixed(2)}. Refund: ₹${refundAmount.toFixed(2)}.`, {
                            tripId,
                            tier: finalTier,
                            refundAmount: String(refundAmount),
                            customerFee: String(customerFee),
                            type: 'trip_cancelled'
                        });
                    }
                    if (driverId) {
                        notifyUserFCM(driverId, 'Customer No-Show Compensation', `Customer no-show recorded. ₹${driverPayout.toFixed(2)} payout has been credited to your wallet.`, {
                            tripId,
                            tier: finalTier,
                            driverPayout: String(driverPayout),
                            type: 'trip_cancelled'
                        });
                    }
                }

                // Send transactional email receipt to customer
                await sendCancellationEmailReceipt({
                    trip,
                    cust,
                    tier: finalTier,
                    refundAmount,
                    customerFee,
                    originalFare: prepaidAmount,
                    reason: reason || finalTier
                });
            } catch (notifErr) {
                console.warn('[CANCEL_NOTIF_ERROR]', notifErr.message);
            }
        })();

        res.json({
            success: true,
            tripId,
            tier: finalTier,
            status: newTripStatus,
            customerFee,
            refundAmount,
            driverPayout,
            driverPenalty,
            refundId: rzpRefund?.id || null,
            message: `Trip cancelled under ${finalTier}. Refund: ₹${refundAmount.toFixed(2)}, Fee: ₹${customerFee.toFixed(2)}.`
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[CANCEL_SYMMETRIC_ERROR]', err);
        res.status(500).json({ error: 'Cancellation failed: ' + err.message });
    } finally {
        client.release();
    }
});

// 5. Driver Fallback: Record Shortfall & Complete Delivery
apiRouter.post('/trips/:id/record-shortfall', async (req, res) => {
    try {
        const tripId = req.params.id;
        const { shortfallAmount, customerId } = req.body;
        const amount = parseFloat(shortfallAmount) || 0;

        if (amount > 0 && customerId) {
            await pool.query(`
                UPDATE customers 
                SET outstanding_balance = COALESCE(outstanding_balance, 0) + $1 
                WHERE id = $2
            `, [amount, customerId]);
        }

        res.json({
            success: true,
            message: `Shortfall of ₹${amount.toFixed(2)} recorded to customer debt ledger. Delivery can proceed.`,
            outstandingAdded: amount
        });
    } catch (err) {
        console.error('[RECORD_SHORTFALL_ERROR]', err);
        res.status(500).json({ error: 'Failed to record shortfall: ' + err.message });
    }
});

// 6. CRM Ride Payments Ledger & Admin Refunds
apiRouter.get('/crm/ride-payments', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
        const { status, customerId } = req.query;
        let query = `
            SELECT rp.*, c.name as customer_name, c.phone as customer_phone
            FROM ride_payments rp
            LEFT JOIN customers c ON rp.customer_id = c.id
            WHERE 1=1
        `;
        const params = [];
        let idx = 1;
        if (status) { query += ` AND rp.status = $${idx++}`; params.push(status); }
        if (customerId) { query += ` AND rp.customer_id = $${idx++}`; params.push(customerId); }
        query += ` ORDER BY rp.created_at DESC LIMIT 100`;

        const result = await pool.query(query, params);
        res.json({ success: true, payments: result.rows });
    } catch (err) {
        console.error('Error fetching ride payments:', err);
        res.status(500).json({ error: 'Failed to fetch ride payments: ' + err.message });
    }
});

const OWNER_DOC_MAP = {
    'owner_aadhaar': 'aadhaarPath',
    'owner_pan': 'panPath'
};
const ALLOWED_MEDIA_DOC_TYPES = ['gst', 'cheque', 'trade_license', 'workshop_photo', 'banner', 'agreement', 'document', 'pan', 'aadhaar', 'dl', 'profile'];

apiRouter.post('/upload-kyc', authMiddleware, upload.single('file'), validateUploadedFiles, async (req, res) => {
    const { entityId, docType } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!isR2Configured()) {
        return res.status(500).json({ error: 'Storage service is not configured. Missing Cloudflare R2 environment variables.' });
    }
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `${Date.now()}-${safeName}`;
    const filePath = 'uploads/' + filename;
    const fileName = req.file.originalname;

    try {
        await uploadBufferToR2({
            key: filePath,
            buffer: req.file.buffer,
            mimetype: req.file.mimetype,
            metadata: { entityId: entityId || '', docType: docType || '' }
        });

        if (docType && docType.startsWith('owner_')) {
            const field = OWNER_DOC_MAP[docType];
            if (!field) {
                return res.status(400).json({ error: 'Invalid owner docType: ' + docType });
            }
            db.get("SELECT garageId FROM garage_owners WHERE id = ?", [entityId], (err, owner) => {
                if (err || !owner) {
                    return res.status(404).json({ error: 'Owner record not found' });
                }
                if (req.user.role !== 'admin' && owner.garageId !== req.user.garageId && owner.garageId !== req.user.id) {
                    return res.status(403).json({ error: 'Forbidden: You do not own this garage partner profile.' });
                }
                db.run(`UPDATE garage_owners SET ${field} = ? WHERE id = ?`, [filePath, entityId], (errU) => {
                    if (errU) return res.status(500).json({ error: errU.message });
                    res.json({ success: true, filePath: generateSignedUploadUrl(filePath) });
                });
            });
        } else {
            if (!docType || !ALLOWED_MEDIA_DOC_TYPES.includes(docType)) {
                return res.status(400).json({ error: 'Invalid media docType: ' + docType });
            }
            if (req.user.role !== 'admin' && entityId !== req.user.garageId && entityId !== req.user.id) {
                return res.status(403).json({ error: 'Forbidden: You do not own this entity.' });
            }
            const id = 'doc_' + Date.now();
            db.run("INSERT INTO media (id, referenceId, filePath, fileName, docType) VALUES (?, ?, ?, ?, ?) ON CONFLICT (referenceId, docType) DO UPDATE SET filePath = EXCLUDED.filePath, fileName = EXCLUDED.fileName",
                [id, entityId, filePath, fileName, docType], () => res.json({ success: true, filePath: generateSignedUploadUrl(filePath) }));
        }
    } catch (err) {
        console.error('Upload KYC error:', err.message);
        res.status(500).json({ error: 'Failed to upload document: ' + err.message });
    }
});

apiRouter.post('/media', authMiddleware, upload.single('file'), validateUploadedFiles, async (req, res) => {
    const { referenceId, type } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!referenceId) {
        return res.status(400).json({ error: 'referenceId is required' });
    }
    if (!isR2Configured()) {
        return res.status(500).json({ error: 'Storage service is not configured. Missing Cloudflare R2 environment variables.' });
    }

    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `${Date.now()}-${safeName}`;
    const filePath = 'uploads/' + filename;
    const fileName = req.file.originalname;
    const id = 'media_' + Date.now();

    // Ownership Authorization Check
    let isAuthorized = false;
    if (req.user.role === 'admin') {
        isAuthorized = true;
    } else if (referenceId === req.user.id || referenceId === req.user.garageId) {
        isAuthorized = true;
    } else {
        try {
            // 1. Check if referenceId is a Trip
            const tripCheck = await pool.query(
                `SELECT t.marshalid, t.deliverymarshalid, sr.garageid, sr.customerid 
                 FROM trips t 
                 LEFT JOIN service_requests sr ON t.servicerequestid = sr.id 
                 WHERE t.id = $1`,
                [referenceId]
            );
            if (tripCheck.rows.length > 0) {
                const t = tripCheck.rows[0];
                if (t.marshalid === req.user.id || 
                    t.deliverymarshalid === req.user.id || 
                    t.customerid === req.user.id ||
                    (req.user.garageId && (t.garageid === req.user.garageId || t.garageid === req.user.id))) {
                    isAuthorized = true;
                }
            } else {
                // 2. Check if referenceId is a Service Request
                const srCheck = await pool.query(
                    `SELECT customerid, workerid, garageid FROM service_requests WHERE id = $1`,
                    [referenceId]
                );
                if (srCheck.rows.length > 0) {
                    const sr = srCheck.rows[0];
                    if (sr.customerid === req.user.id || 
                        sr.workerid === req.user.id || 
                        (req.user.garageId && (sr.garageid === req.user.garageId || sr.garageid === req.user.id))) {
                        isAuthorized = true;
                    }
                }
            }
        } catch (dbErr) {
            console.error('Media ownership verification error:', dbErr.message);
        }
    }

    if (!isAuthorized) {
        return res.status(403).json({ error: 'Forbidden: You do not have permission to upload media for this entity.' });
    }

    try {
        await uploadBufferToR2({
            key: filePath,
            buffer: req.file.buffer,
            mimetype: req.file.mimetype,
            metadata: { referenceId, type: type || 'document' }
        });

        db.run("INSERT INTO media (id, referenceId, filePath, fileName, docType) VALUES (?, ?, ?, ?, ?) ON CONFLICT (referenceId, docType) DO UPDATE SET filePath = EXCLUDED.filePath, fileName = EXCLUDED.fileName",
            [id, referenceId, filePath, fileName, type || 'document'], (err) => {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                res.json({ success: true, id, filePath: generateSignedUploadUrl(filePath) });
            });
    } catch (err) {
        console.error('Media upload error:', err.message);
        res.status(500).json({ error: 'Failed to upload media: ' + err.message });
    }
});

apiRouter.post('/garages/:id/documents', authMiddleware, upload.single('file'), validateUploadedFiles, async (req, res) => {
    const { docType } = req.body;
    const garageId = req.params.id;
    if (req.user.role !== 'admin' && garageId !== req.user.garageId && garageId !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden: You do not own this garage profile.' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!isR2Configured()) {
        return res.status(500).json({ error: 'Storage service is not configured. Missing Cloudflare R2 environment variables.' });
    }
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `${Date.now()}-${safeName}`;
    const filePath = 'uploads/' + filename;
    const fileName = req.file.originalname;
    const id = 'doc_' + Date.now();

    try {
        await uploadBufferToR2({
            key: filePath,
            buffer: req.file.buffer,
            mimetype: req.file.mimetype,
            metadata: { garageId, docType }
        });

        db.run("INSERT INTO media (id, referenceId, filePath, fileName, docType) VALUES (?, ?, ?, ?, ?) ON CONFLICT (referenceId, docType) DO UPDATE SET filePath = EXCLUDED.filePath, fileName = EXCLUDED.fileName",
            [id, garageId, filePath, fileName, docType], (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, filePath: generateSignedUploadUrl(filePath) });
            });
    } catch (err) {
        console.error('Garage document upload error:', err.message);
        res.status(500).json({ error: 'Failed to upload garage document: ' + err.message });
    }
});

apiRouter.delete('/garages/:id/documents/:docType', authMiddleware, (req, res) => {
    const garageId = req.params.id;
    if (req.user.role !== 'admin' && garageId !== req.user.garageId && garageId !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden: You do not own this garage profile.' });
    }
    db.run("DELETE FROM media WHERE referenceId = $1 AND docType = $2", [garageId, req.params.docType], (err) => {
        res.json({ success: !err });
    });
});

apiRouter.get('/crm/entities', authMiddleware, requireRole('admin'), (req, res) => {
    db.all("SELECT * FROM garages", (errG, garages) => {
        db.all("SELECT * FROM users WHERE role = 'customer'", (errC, customers) => {
            db.all("SELECT sr.*, c.name as customerName FROM service_requests sr JOIN customers c ON sr.customerId = c.id", (errS, requests) => {
                res.json({ garages: garages || [], customers: customers || [], requests: requests || [] });
            });
        });
    });
});

apiRouter.patch('/media/:id', (req, res) => {
    const { status } = req.body;
    db.run("UPDATE media SET status = ? WHERE id = ?", [status, req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

apiRouter.patch('/service-requests/:id', (req, res) => {
    const allowed = ['status', 'workerId', 'garageId', 'totalCustomerPrice', 'auditStatus'];
    const fields = []; const vals = [];
    allowed.forEach(k => {
        if (req.body[k] !== undefined) {
            fields.push(`${k} = ?`);
            vals.push(req.body[k]);
        }
    });
    if (fields.length === 0) return res.json({ success: true });
    vals.push(req.params.id);
    db.run(`UPDATE service_requests SET ${fields.join(', ')} WHERE id = ?`, vals, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

apiRouter.patch('/trips/:id', (req, res) => {
    const allowed = ['status', 'endOdometer', 'startOdometer', 'rating', 'deliveryOtp', 'garagePickupOtp', 'garageDropoffOtp', 'deliveryMarshalId', 'marshalId', 'feedback'];
    const fields = []; const vals = [];
    allowed.forEach(k => {
        if (req.body[k] !== undefined) {
            fields.push(`${k} = ?`);
            vals.push(req.body[k]);
        }
    });
    if (fields.length === 0) return res.json({ success: true });
    vals.push(req.params.id);
    db.run(`UPDATE trips SET ${fields.join(', ')} WHERE id = ?`, vals, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});
// --- MULTI-OWNER MANAGEMENT ---
apiRouter.get('/garages/:id/owners', authMiddleware, (req, res) => {
    if (req.user.role !== 'admin' && req.user.garageId !== req.params.id && req.user.id !== req.params.id) {
        return res.status(403).json({ error: 'Forbidden: You do not have permission to access owners for this garage.' });
    }
    db.all("SELECT * FROM garage_owners WHERE garageId = ? ORDER BY createdAt ASC", [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

apiRouter.post('/garages/:id/owners', (req, res) => {
    const { name, phone, altPhone, email, aadhaar, pan } = req.body;
    const id = 'own_' + Date.now();
    db.run("INSERT INTO garage_owners (id, garageId, name, phone, altPhone, email, aadhaar, pan) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [id, req.params.id, name, phone, altPhone, email, aadhaar, pan], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id });
        });
});

apiRouter.put('/owners/:id', (req, res) => {
    const allowed = ['name', 'phone', 'altPhone', 'email', 'aadhaar', 'pan', 'phoneVerified', 'altPhoneVerified', 'emailVerified', 'aadhaarVerified', 'panVerified'];
    const fields = []; const vals = [];
    allowed.forEach(col => {
        if (req.body[col] !== undefined) {
            fields.push(`${col} = ?`);
            vals.push(req.body[col]);
        }
    });
    if (fields.length === 0) return res.json({ success: true });
    vals.push(req.params.id);
    db.run(`UPDATE garage_owners SET ${fields.join(', ')} WHERE id = ?`, vals, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

apiRouter.delete('/owners/:id', (req, res) => {
    db.run("DELETE FROM garage_owners WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Generic Verifier (Simulates OTP/KYC success)
apiRouter.patch('/verify-field', (req, res) => {
    const { entityId, entityType, field, status } = req.body;
    if (entityType !== 'garage' && entityType !== 'owner') {
        return res.status(400).json({ error: 'Invalid entityType' });
    }
    const allowedFields = ['pan', 'aadhaar', 'bank', 'kyc', 'email', 'phone'];
    if (!allowedFields.includes(field)) {
        return res.status(400).json({ error: 'Invalid field' });
    }
    const table = entityType === 'garage' ? 'garages' : 'garage_owners';
    const column = field + 'Verified';
    
    db.run(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [status ? 1 : 0, entityId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// --- SERIALIZED PARTS MANAGEMENT ---
apiRouter.get('/serialized-parts', authMiddleware, requireRole('admin', 'garage'), (req, res) => {
    let query = "SELECT * FROM serialized_parts";
    let params = [];
    if (req.user.role === 'garage') {
        const garageId = req.user.garageId || req.user.id;
        query += " WHERE garageId = ?";
        params.push(garageId);
    }
    query += " ORDER BY assignedAt DESC";
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

apiRouter.post('/serialized-parts/bulk', (req, res) => {
    const { skuId, items } = req.body; // items = [{ garageId, serials: [] }]
    if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'Invalid items' });
    
    let totalSerials = 0;
    items.forEach(it => { if (it.serials) totalSerials += it.serials.length; });
    if (totalSerials > 500) return res.status(400).json({ error: 'Too many items. Maximum 500 serials per request.' });

    const flatSerials = [];
    items.forEach(it => {
        it.serials.forEach(sn => {
            flatSerials.push([ 'ser_' + Math.random().toString(36).substr(2, 9), skuId, sn.trim(), it.garageId ]);
        });
    });

    if (flatSerials.length === 0) return res.json({ success: true, count: 0 });

    const placeholders = flatSerials.map(() => "(?, ?, ?, ?, 'assigned')").join(", ");
    const sql = `INSERT INTO serialized_parts (id, skuId, serialNumber, garageId, status) VALUES ${placeholders}`;
    const params = flatSerials.flat();

    db.run(sql, params, (err) => {
        if (err) {
            if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Duplicate Serial Number detected!' });
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, count: flatSerials.length });
    });
});

apiRouter.post('/validate-part', (req, res) => {
    const { serialNumber, garageId } = req.body;
    db.get("SELECT sp.*, ms.itemName, ms.category FROM serialized_parts sp JOIN master_skus ms ON sp.skuId = ms.id WHERE sp.serialNumber = ? AND sp.garageId = ? AND sp.status = 'assigned'",
        [serialNumber, garageId], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.json({ valid: false, reason: 'Serial number not found, already used, or not assigned to this garage.' });
            res.json({ valid: true, part: row });
        });
});

apiRouter.patch('/serialized-parts/:id', (req, res) => {
    const { status, orderId } = req.body;
    db.run("UPDATE serialized_parts SET status = ?, orderId = ?, usedAt = ? WHERE id = ?",
        [status, orderId, status === 'used' ? new Date().toISOString() : null, req.params.id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
});

// --- MISSING ENDPOINTS ADDED FOR E2E WORKFLOW ---

apiRouter.post('/customers', authMiddleware, requireRole('admin'), (req, res) => {
    const { id, name, phone, email } = req.body;
    db.run("INSERT INTO customers (id, name, phone, email) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, email = EXCLUDED.email",
        [id || `cust_${Date.now()}`, name, phone, email], (err) => {
            if (err) {
                console.error("POST /customers DB error:", err.message);
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true, id: id || `cust_${Date.now()}` });
        });
});

apiRouter.get('/vehicles/:id', authMiddleware, (req, res) => {
    db.get("SELECT * FROM vehicles WHERE id = ?", [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Vehicle not found' });
        if (row.photo) row.photo = generateSignedUploadUrl(row.photo);
        res.json(row);
    });
});

apiRouter.post('/vehicles', upload.single('photo'), async (req, res) => {
    try {
        let { id, customerId, make, model, type, plate, photo, fuel, transmission } = req.body || {};
        const cleanCustId = (customerId || req.user?.id || '').replace('_user', '');
        const vehId = id || `veh_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

        // Handle binary file upload via Multer -> Cloudflare R2
        if (req.file) {
            const ext = path.extname(req.file.originalname) || (req.file.mimetype === 'image/png' ? '.png' : (req.file.mimetype === 'image/webp' ? '.webp' : '.jpg'));
            const key = `uploads/${Date.now()}-${vehId}${ext}`;
            await uploadBufferToR2({
                key,
                buffer: req.file.buffer,
                mimetype: req.file.mimetype,
                metadata: { vehicleId: vehId, customerId: cleanCustId, type: 'vehicle_photo' }
            });
            photo = key;
        } else if (typeof photo === 'string' && photo.startsWith('data:image/')) {
            // Defensive fallback: Auto-decode incoming Base64 payload and store in Cloudflare R2 as binary
            try {
                const matches = photo.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
                if (matches && matches.length === 3) {
                    const mimeType = matches[1];
                    const base64Data = matches[2];
                    const buffer = Buffer.from(base64Data, 'base64');
                    const ext = mimeType.split('/')[1] === 'jpeg' ? '.jpg' : (mimeType.split('/')[1] === 'png' ? '.png' : (mimeType.split('/')[1] === 'webp' ? '.webp' : '.jpg'));
                    const key = `uploads/${Date.now()}-${vehId}.${ext}`;
                    await uploadBufferToR2({
                        key,
                        buffer,
                        mimetype: mimeType,
                        metadata: { vehicleId: vehId, customerId: cleanCustId, type: 'vehicle_photo_b64_fallback' }
                    });
                    photo = key;
                }
            } catch (b64Err) {
                console.error('[POST /vehicles Base64 Upload Warning]', b64Err.message);
            }
        }

        db.run("INSERT INTO vehicles (id, customerId, make, model, type, plate, photo, fuel, transmission) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [vehId, cleanCustId, make, model, type, plate, photo || null, fuel || 'Petrol', transmission || 'Manual'], async (err) => {
                if (err) {
                    console.error("POST /vehicles DB error:", err.message);
                    return res.status(500).json({ error: err.message });
                }
                try {
                    await pool.query(
                        `INSERT INTO vehicles (id, customerid, make, model, type, plate, photo, fuel, transmission) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO UPDATE SET customerid=$2, make=$3, model=$4, type=$5, plate=$6, photo=$7, fuel=$8, transmission=$9`,
                        [vehId, cleanCustId, make, model, type, plate, photo || null, fuel || 'Petrol', transmission || 'Manual']
                    );
                } catch (pgE) {
                    console.error("POST /vehicles PG error:", pgE.message);
                }
                res.json({ success: true, id: vehId, photo: photo ? generateSignedUploadUrl(photo) : null, rawPhoto: photo });
            });
    } catch (routeErr) {
        console.error("POST /vehicles server error:", routeErr);
        res.status(500).json({ error: routeErr.message || 'Failed to create vehicle' });
    }
});

apiRouter.put('/vehicles/:id', upload.single('photo'), async (req, res) => {
    try {
        const { make, model, type, plate, fuel, transmission } = req.body || {};
        let photo = req.body?.photo;
        const vehId = req.params.id;

        db.get("SELECT * FROM vehicles WHERE id = ?", [vehId], async (err, existing) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!existing) return res.status(404).json({ error: 'Vehicle not found' });

            // Check if vehicle plate is locked due to ride history
            if (plate !== undefined && existing.plate && normalizeVehiclePlate(plate) !== normalizeVehiclePlate(existing.plate)) {
                try {
                    const histRes = await pool.query(
                        `SELECT COUNT(*)::int as count FROM trips WHERE (vehicleid = $1 OR servicerequestid IN (SELECT id FROM service_requests WHERE vehicleid = $1)) AND status != 'cancelled'`,
                        [vehId]
                    ).catch(() => ({ rows: [{ count: 0 }] }));
                    const hasRides = parseInt(histRes.rows[0]?.count || 0, 10) > 0;
                    if (hasRides) {
                        return res.status(400).json({
                            error: 'This vehicle is linked to completed ride history. Direct plate changes are locked. Please submit a Plate Change Request with RC and Insurance documents for verification.',
                            locked: true,
                            requirePlateChangeRequest: true
                        });
                    }
                } catch (e) {
                    console.warn('[VEHICLE_LOCK_CHECK_WARN]', e.message);
                }
            }

            // Handle binary file upload via Multer -> Cloudflare R2
            if (req.file) {
                const ext = path.extname(req.file.originalname) || (req.file.mimetype === 'image/png' ? '.png' : (req.file.mimetype === 'image/webp' ? '.webp' : '.jpg'));
                const key = `uploads/${Date.now()}-${vehId}${ext}`;
                await uploadBufferToR2({
                    key,
                    buffer: req.file.buffer,
                    mimetype: req.file.mimetype,
                    metadata: { vehicleId: vehId, customerId: existing.customerId || existing.customerid, type: 'vehicle_photo_update' }
                });
                photo = key;
            } else if (typeof photo === 'string' && photo.startsWith('data:image/')) {
                // Defensive fallback: Auto-decode incoming Base64 payload and store in Cloudflare R2 as binary
                try {
                    const matches = photo.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
                    if (matches && matches.length === 3) {
                        const mimeType = matches[1];
                        const base64Data = matches[2];
                        const buffer = Buffer.from(base64Data, 'base64');
                        const ext = mimeType.split('/')[1] === 'jpeg' ? '.jpg' : (mimeType.split('/')[1] === 'png' ? '.png' : (mimeType.split('/')[1] === 'webp' ? '.webp' : '.jpg'));
                        const key = `uploads/${Date.now()}-${vehId}.${ext}`;
                        await uploadBufferToR2({
                            key,
                            buffer,
                            mimetype: mimeType,
                            metadata: { vehicleId: vehId, customerId: existing.customerId || existing.customerid, type: 'vehicle_photo_update_b64' }
                        });
                        photo = key;
                    }
                } catch (b64Err) {
                    console.error('[PUT /vehicles Base64 Upload Warning]', b64Err.message);
                }
            }

            const updatedMake = make !== undefined ? make : existing.make;
            const updatedModel = model !== undefined ? model : existing.model;
            const updatedType = type !== undefined ? type : existing.type;
            const updatedPlate = plate !== undefined ? plate : existing.plate;
            const updatedPhoto = (photo !== undefined && photo !== null && photo !== '') ? photo : existing.photo;
            const updatedFuel = fuel !== undefined ? fuel : existing.fuel;
            const updatedTransmission = transmission !== undefined ? transmission : existing.transmission;

            db.run("UPDATE vehicles SET make=?, model=?, type=?, plate=?, photo=?, fuel=?, transmission=? WHERE id=?",
                [updatedMake, updatedModel, updatedType, updatedPlate, updatedPhoto, updatedFuel, updatedTransmission, vehId],
                async (updateErr) => {
                    if (updateErr) {
                        console.error("PUT /vehicles DB error:", updateErr.message);
                        return res.status(500).json({ error: updateErr.message });
                    }
                    try {
                        await pool.query(
                            `UPDATE vehicles SET make=$1, model=$2, type=$3, plate=$4, photo=$5, fuel=$6, transmission=$7 WHERE id=$8`,
                            [updatedMake, updatedModel, updatedType, updatedPlate, updatedPhoto, updatedFuel, updatedTransmission, vehId]
                        );
                    } catch (pgE) {
                        console.error("PUT /vehicles PG error:", pgE.message);
                    }
                    res.json({ success: true, photo: updatedPhoto ? generateSignedUploadUrl(updatedPhoto) : null, rawPhoto: updatedPhoto });
                }
            );
        });
    } catch (routeErr) {
        console.error("PUT /vehicles server error:", routeErr);
        res.status(500).json({ error: routeErr.message || 'Failed to update vehicle' });
    }
});

apiRouter.delete('/vehicles/:id', (req, res) => {
    db.run("DELETE FROM vehicles WHERE id=?", [req.params.id], (err) => res.json({ success: true }));
});

// --- VEHICLE PLATE CHANGE REQUEST PIPELINE (CRM & CUSTOMER) ---

apiRouter.post('/vehicles/:id/plate-change-request', upload.fields([
    { name: 'rcDoc', maxCount: 1 },
    { name: 'insuranceDoc', maxCount: 1 },
    { name: 'form29_30Doc', maxCount: 1 },
    { name: 'rc_doc', maxCount: 1 },
    { name: 'insurance_doc', maxCount: 1 },
    { name: 'form29_30_doc', maxCount: 1 }
]), validateUploadedFiles, async (req, res) => {
    try {
        const vehicleId = req.params.id;
        const customerId = req.user?.id || req.body.customerId || req.body.customer_id;
        const requestedPlate = req.body.requestedPlate || req.body.requested_plate || req.body.plate;
        const isOwnershipChanged = req.body.isOwnershipChanged === 'true' || req.body.isOwnershipChanged === true || req.body.is_ownership_changed === 'true' || req.body.is_ownership_changed === true;

        if (!requestedPlate || typeof requestedPlate !== 'string' || !requestedPlate.trim()) {
            return res.status(400).json({ error: 'Requested plate number is mandatory.' });
        }

        const normalizedRequested = normalizeVehiclePlate(requestedPlate);
        if (!normalizedRequested || normalizedRequested.length < 4) {
            return res.status(400).json({ error: 'Invalid license plate number format.' });
        }

        // Fetch vehicle to get current plate
        let currentPlate = '';
        let vehOwnerId = customerId;
        const pgVeh = await pool.query("SELECT * FROM vehicles WHERE id = $1", [vehicleId]).catch(() => ({ rows: [] }));
        if (pgVeh.rows.length > 0) {
            currentPlate = pgVeh.rows[0].plate || '';
            if (pgVeh.rows[0].customerid) vehOwnerId = pgVeh.rows[0].customerid;
        } else {
            const sqVeh = await new Promise((resolve) => {
                db.get("SELECT * FROM vehicles WHERE id = ?", [vehicleId], (err, row) => resolve(row || null));
            });
            if (sqVeh) {
                currentPlate = sqVeh.plate || '';
                if (sqVeh.customerId) vehOwnerId = sqVeh.customerId;
            }
        }

        if (!currentPlate) {
            return res.status(404).json({ error: 'Vehicle not found.' });
        }

        if (normalizeVehiclePlate(currentPlate) === normalizedRequested) {
            return res.status(400).json({ error: 'Requested new plate must be different from current plate.' });
        }

        // Handle uploaded documents
        const files = req.files || {};
        const rcFile = files['rcDoc']?.[0] || files['rc_doc']?.[0];
        const insFile = files['insuranceDoc']?.[0] || files['insurance_doc']?.[0];
        const formFile = files['form29_30Doc']?.[0] || files['form29_30_doc']?.[0];

        let rcDocUrl = req.body.rcDocUrl || req.body.rc_doc_url || null;
        let insuranceDocUrl = req.body.insuranceDocUrl || req.body.insurance_doc_url || null;
        let form2930DocUrl = req.body.form29_30DocUrl || req.body.form29_30_doc_url || null;

        const requestId = 'vpcr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

        if (rcFile) {
            const ext = path.extname(rcFile.originalname) || '.jpg';
            const key = `uploads/plate_req_${requestId}_rc${ext}`;
            await uploadBufferToR2({ key, buffer: rcFile.buffer, mimetype: rcFile.mimetype, metadata: { customerId: vehOwnerId, vehicleId, docType: 'rc' } });
            rcDocUrl = key;
        }

        if (insFile) {
            const ext = path.extname(insFile.originalname) || '.jpg';
            const key = `uploads/plate_req_${requestId}_ins${ext}`;
            await uploadBufferToR2({ key, buffer: insFile.buffer, mimetype: insFile.mimetype, metadata: { customerId: vehOwnerId, vehicleId, docType: 'insurance' } });
            insuranceDocUrl = key;
        }

        if (formFile) {
            const ext = path.extname(formFile.originalname) || '.jpg';
            const key = `uploads/plate_req_${requestId}_form2930${ext}`;
            await uploadBufferToR2({ key, buffer: formFile.buffer, mimetype: formFile.mimetype, metadata: { customerId: vehOwnerId, vehicleId, docType: 'form29_30' } });
            form2930DocUrl = key;
        }

        if (!rcDocUrl) {
            return res.status(400).json({ error: 'RC (Registration Certificate) document upload is mandatory.' });
        }
        if (!insuranceDocUrl) {
            return res.status(400).json({ error: 'Vehicle Insurance certificate upload is mandatory.' });
        }
        if (isOwnershipChanged && !form2930DocUrl) {
            return res.status(400).json({ error: 'Form 29/30 document is mandatory when ownership has changed.' });
        }

        // Insert into PostgreSQL
        await pool.query(`
            INSERT INTO vehicle_plate_change_requests (
                id, customer_id, vehicle_id, current_plate, requested_plate, normalized_requested_plate,
                rc_doc_url, insurance_doc_url, is_ownership_changed, form29_30_doc_url, status, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', NOW(), NOW())
        `, [
            requestId, vehOwnerId || 'unknown_customer', vehicleId, currentPlate, requestedPlate.trim(), normalizedRequested,
            rcDocUrl, insuranceDocUrl, isOwnershipChanged, form2930DocUrl
        ]);

        // Dual-write to SQLite
        db.run(
            `INSERT INTO vehicle_plate_change_requests
             (id, customerId, vehicleId, currentPlate, requestedPlate, normalizedRequestedPlate, rcDocUrl, insuranceDocUrl, isOwnershipChanged, form29_30DocUrl, status, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            [
                requestId, vehOwnerId || 'unknown_customer', vehicleId, currentPlate, requestedPlate.trim(), normalizedRequested,
                rcDocUrl, insuranceDocUrl, isOwnershipChanged ? 1 : 0, form2930DocUrl, new Date().toISOString(), new Date().toISOString()
            ],
            () => {}
        );

        res.json({
            success: true,
            requestId,
            message: 'Vehicle plate change request submitted successfully. Pending CRM verification.',
            currentPlate,
            requestedPlate: requestedPlate.trim(),
            status: 'pending'
        });
    } catch (err) {
        console.error('[PLATE_CHANGE_REQ_ERR]', err);
        res.status(500).json({ error: 'Failed to submit plate change request: ' + err.message });
    }
});

apiRouter.get('/vehicles/:id/plate-change-requests', async (req, res) => {
    try {
        const vehicleId = req.params.id;
        const result = await pool.query(
            "SELECT * FROM vehicle_plate_change_requests WHERE vehicle_id = $1 ORDER BY created_at DESC",
            [vehicleId]
        );
        const rows = result.rows.map(row => ({
            ...row,
            rc_doc_signed_url: row.rc_doc_url ? generateSignedUploadUrl(row.rc_doc_url) : null,
            insurance_doc_signed_url: row.insurance_doc_url ? generateSignedUploadUrl(row.insurance_doc_url) : null,
            form29_30_doc_signed_url: row.form29_30_doc_url ? generateSignedUploadUrl(row.form29_30_doc_url) : null
        }));
        res.json({ success: true, requests: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /crm/vehicle-plate-requests
apiRouter.get('/crm/vehicle-plate-requests', async (req, res) => {
    try {
        const { status } = req.query;
        let query = `
            SELECT 
                r.*,
                c.name as customer_name,
                c.phone as customer_phone,
                c.email as customer_email,
                v.make as vehicle_make,
                v.model as vehicle_model,
                v.type as vehicle_type
            FROM vehicle_plate_change_requests r
            LEFT JOIN customers c ON r.customer_id = c.id
            LEFT JOIN vehicles v ON r.vehicle_id = v.id
        `;
        const params = [];
        if (status && status !== 'all') {
            query += ` WHERE r.status = $1`;
            params.push(status);
        }
        query += ` ORDER BY r.created_at DESC`;

        const result = await pool.query(query, params);
        const rows = result.rows.map(row => ({
            ...row,
            rc_doc_signed_url: row.rc_doc_url ? generateSignedUploadUrl(row.rc_doc_url) : null,
            insurance_doc_signed_url: row.insurance_doc_url ? generateSignedUploadUrl(row.insurance_doc_url) : null,
            form29_30_doc_signed_url: row.form29_30_doc_url ? generateSignedUploadUrl(row.form29_30_doc_url) : null
        }));

        res.json({ success: true, count: rows.length, requests: rows });
    } catch (err) {
        console.error('[CRM_GET_PLATE_REQS_ERR]', err);
        res.status(500).json({ error: 'Failed to fetch plate change requests: ' + err.message });
    }
});

// POST /crm/vehicle-plate-requests/:id/approve
apiRouter.post('/crm/vehicle-plate-requests/:id/approve', async (req, res) => {
    try {
        const requestId = req.params.id;
        const reqRes = await pool.query("SELECT * FROM vehicle_plate_change_requests WHERE id = $1", [requestId]);
        if (reqRes.rows.length === 0) {
            return res.status(404).json({ error: 'Plate change request not found.' });
        }

        const request = reqRes.rows[0];
        if (request.status === 'approved') {
            return res.status(400).json({ error: 'This request has already been approved.' });
        }

        const reviewerId = req.user?.id || 'admin';
        const now = new Date();

        // 1. Update request status to 'approved'
        await pool.query(
            `UPDATE vehicle_plate_change_requests 
             SET status = 'approved', reviewed_by = $1, reviewed_at = $2, updated_at = $2 
             WHERE id = $3`,
            [reviewerId, now, requestId]
        );
        db.run(
            `UPDATE vehicle_plate_change_requests SET status = 'approved', reviewedBy = ?, reviewedAt = ?, updatedAt = ? WHERE id = ?`,
            [reviewerId, now.toISOString(), now.toISOString(), requestId],
            () => {}
        );

        // 2. Update vehicle table with new plate
        const newPlate = request.requested_plate;
        const normNewPlate = request.normalized_requested_plate;
        const vehicleId = request.vehicle_id;
        const customerId = request.customer_id;

        await pool.query(
            "UPDATE vehicles SET plate = $1 WHERE id = $2",
            [newPlate, vehicleId]
        );
        db.run("UPDATE vehicles SET plate = ? WHERE id = ?", [newPlate, vehicleId], () => {});

        // 3. Update / re-run promo_vehicle_registrations anti-fraud tracking
        const oldNormPlate = request.current_plate ? normalizeVehiclePlate(request.current_plate) : '';
        if (oldNormPlate) {
            await pool.query(
                `UPDATE promo_vehicle_registrations 
                 SET plate = $1, normalized_plate = $2, updated_at = NOW() 
                 WHERE normalized_plate = $3 AND first_customer_id = $4`,
                [newPlate, normNewPlate, oldNormPlate, customerId]
            );
        }

        // Ensure new plate is registered in anti-fraud table
        await pool.query(`
            INSERT INTO promo_vehicle_registrations (
                id, plate, normalized_plate, first_customer_id, first_promo_request_id, status, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, 'active', NOW(), NOW())
            ON CONFLICT (normalized_plate) DO UPDATE SET first_customer_id = EXCLUDED.first_customer_id, plate = EXCLUDED.plate, updated_at = NOW();
        `, ['pvr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6), newPlate, normNewPlate, customerId, requestId]);

        // 4. Dispatch notification to customer
        notifyUserFCM(customerId, 'Plate Change Approved', `Your vehicle plate change request for ${newPlate} has been approved.`, {
            type: 'plate_change_approved',
            vehicleId,
            newPlate,
            requestId
        });

        res.json({
            success: true,
            message: `Plate change request approved. Vehicle ${vehicleId} updated to ${newPlate}.`,
            vehicleId,
            newPlate,
            status: 'approved'
        });
    } catch (err) {
        console.error('[CRM_APPROVE_PLATE_REQ_ERR]', err);
        res.status(500).json({ error: 'Failed to approve plate change request: ' + err.message });
    }
});

// POST /crm/vehicle-plate-requests/:id/reject
apiRouter.post('/crm/vehicle-plate-requests/:id/reject', async (req, res) => {
    try {
        const requestId = req.params.id;
        const { reason } = req.body;
        const reqRes = await pool.query("SELECT * FROM vehicle_plate_change_requests WHERE id = $1", [requestId]);
        if (reqRes.rows.length === 0) {
            return res.status(404).json({ error: 'Plate change request not found.' });
        }

        const request = reqRes.rows[0];
        const reviewerId = req.user?.id || 'admin';
        const now = new Date();
        const rejReason = reason || 'Document verification failed or invalid details.';

        // 1. Update request status to 'rejected'
        await pool.query(
            `UPDATE vehicle_plate_change_requests 
             SET status = 'rejected', rejection_reason = $1, reviewed_by = $2, reviewed_at = $3, updated_at = $3 
             WHERE id = $4`,
            [rejReason, reviewerId, now, requestId]
        );
        db.run(
            `UPDATE vehicle_plate_change_requests SET status = 'rejected', rejectionReason = ?, reviewedBy = ?, reviewedAt = ?, updatedAt = ? WHERE id = ?`,
            [rejReason, reviewerId, now.toISOString(), now.toISOString(), requestId],
            () => {}
        );

        // 2. Dispatch notification to customer
        notifyUserFCM(request.customer_id, 'Plate Change Request Rejected', `Your plate change request for ${request.requested_plate} was rejected: ${rejReason}`, {
            type: 'plate_change_rejected',
            vehicleId: request.vehicle_id,
            requestedPlate: request.requested_plate,
            reason: rejReason,
            requestId
        });

        res.json({
            success: true,
            message: `Plate change request rejected.`,
            requestId,
            status: 'rejected',
            reason: rejReason
        });
    } catch (err) {
        console.error('[CRM_REJECT_PLATE_REQ_ERR]', err);
        res.status(500).json({ error: 'Failed to reject plate change request: ' + err.message });
    }
});

const createRequest = async (req, res) => {
    try {
        const {
            id, customerId, vehicleId, vehiclePlate, plate, garageId, date, status, totalCustomerPrice, workerId,
            lat, lng, pickup_address, drop_address,
            issue, serviceType, bookingFlow, pickupDropType, route_stops,
            distanceKm, pricingMode, estimatedHours, vehicleType, vehicle_condition
        } = req.body;
        // Normalise service category — accept either field name
        const serviceCategory = serviceType || issue || 'Standard Service';

        let routeStopsParsed = [];
        try {
            if (route_stops) {
                const parsed = typeof route_stops === 'string' ? JSON.parse(route_stops) : route_stops;
                if (Array.isArray(parsed)) {
                    routeStopsParsed = parsed.map(stop => {
                        return {
                            address: stop.address || '',
                            lat: parseFloat(stop.lat),
                            lng: parseFloat(stop.lng),
                            otp: stop.otp || String(Math.floor(1000 + Math.random() * 9000)),
                            otpVerified: stop.otpVerified || false
                        };
                    });
                }
            }
        } catch (e) {
            console.warn("Failed to parse route_stops:", e);
        }
        const routeStopsString = JSON.stringify(routeStopsParsed);

        // Calculate pricing & promotional eligibility
        const pricing = await calculateServerSideFare({
            customerId,
            vehicleId,
            vehiclePlate: vehiclePlate || plate,
            plate: plate || vehiclePlate,
            distanceKm: distanceKm || 0,
            pricingMode: pricingMode || 'distance',
            estimatedHours: estimatedHours || 4,
            vehicleType: vehicleType || 'car',
            vehicleCondition: vehicle_condition || req.body.vehicleCondition || 'Working',
            routeStops: routeStopsParsed,
            bookingFlow: bookingFlow || 'p2p'
        });

        const finalPrice = totalCustomerPrice !== undefined && totalCustomerPrice !== null && !isNaN(parseFloat(totalCustomerPrice)) 
            ? parseFloat(totalCustomerPrice) 
            : pricing.customerFare;

        const isPromo = pricing.isPromotionalRide || false;
        const promoType = isPromo ? pricing.promoType : null;
        const origFare = isPromo ? pricing.originalCustomerFare : finalPrice;
        const discountAmt = isPromo ? pricing.promoDiscountAmount : 0;
        const absorbedBy = isPromo ? pricing.promoAbsorbedBy : 'redrivo';
        
        const insertReq = async (assignedGarageId) => {
            // 1. SQLite Write
            db.run(
                `INSERT INTO service_requests
                 (id, customerId, vehicleId, garageId, date, status, totalCustomerPrice, workerId,
                  lat, lng, pickup_address, drop_address, issue, service_category, booking_flow, pickup_drop_type, route_stops, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET status = EXCLUDED.status, totalCustomerPrice = EXCLUDED.totalCustomerPrice`,
                [
                    id, customerId, vehicleId || null, assignedGarageId || garageId || null,
                    date || new Date().toISOString().split('T')[0], status || 'pending', finalPrice, workerId || null,
                    lat || null, lng || null,
                    pickup_address || null, drop_address || null,
                    issue || null, serviceCategory, bookingFlow || 'p2p', pickupDropType || 'Pickup', routeStopsString, Date.now()
                ], async (err) => {
                    if (err) {
                        console.error('Error creating request in SQLite:', err.message);
                        return res.status(500).json({ error: err.message });
                    }

                    // 2. PostgreSQL Write
                    try {
                        const offerId = pricing.offerId || null;
                        await pool.query(`
                            INSERT INTO service_requests (
                                id, customerid, vehicleid, garageid, date, status, totalcustomerprice, workerid,
                                lat, lng, pickup_address, drop_address, service_category, booking_flow, pickup_drop_type, route_stops, created_at,
                                is_promotional_ride, promo_type, original_customer_fare, promo_discount_amount, promo_absorbed_by, offer_id
                            ) VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, EXTRACT(EPOCH FROM NOW())*1000, $16, $17, $18, $19, $20, $21)
                            ON CONFLICT (id) DO UPDATE SET
                                status = EXCLUDED.status,
                                totalcustomerprice = EXCLUDED.totalcustomerprice,
                                is_promotional_ride = EXCLUDED.is_promotional_ride,
                                promo_type = EXCLUDED.promo_type,
                                original_customer_fare = EXCLUDED.original_customer_fare,
                                promo_discount_amount = EXCLUDED.promo_discount_amount,
                                promo_absorbed_by = EXCLUDED.promo_absorbed_by,
                                offer_id = EXCLUDED.offer_id;
                        `, [
                            id, customerId, vehicleId || null, assignedGarageId || garageId || null,
                            status || 'pending', finalPrice, workerId || null,
                            lat || null, lng || null, pickup_address || null, drop_address || null,
                            serviceCategory, bookingFlow || 'p2p', pickupDropType || 'Pickup', routeStopsString,
                            isPromo, promoType, origFare, discountAmt, absorbedBy, offerId
                        ]);

                        // 3. Register promo vehicle plate if applicable
                        if (isPromo) {
                            const resolvedPlate = await resolveVehiclePlate(vehicleId, vehiclePlate || plate);
                            if (resolvedPlate) {
                                await registerPromoVehiclePlate({
                                    plate: resolvedPlate,
                                    customerId,
                                    serviceRequestId: id
                                });
                            }
                        }
                    } catch (pgErr) {
                        console.warn('[CREATE_REQUEST_PG_WARN]', pgErr.message);
                    }

                    res.json({
                        success: true,
                        id,
                        totalCustomerPrice: finalPrice,
                        isPromotionalRide: isPromo,
                        promoDiscountAmount: discountAmt,
                        originalCustomerFare: origFare,
                        offerId: pricing.offerId || null,
                        offerName: pricing.offerName || null
                    });
                });
        };

        if (!garageId) {
            findClosestActiveGarage(lat, lng, (closestId) => {
                insertReq(closestId);
            });
        } else {
            insertReq(garageId);
        }
    } catch (createErr) {
        console.error('[CREATE_REQUEST_ERR]', createErr);
        res.status(500).json({ error: 'Failed to create request: ' + createErr.message });
    }
};
apiRouter.post('/service-requests', authMiddleware, requireRole('customer', 'admin'), createRequest);
apiRouter.post('/requests', authMiddleware, requireRole('customer', 'admin'), createRequest);

function calcDistanceKm(lat1, lng1, lat2, lng2) {
    if (!lat1 || !lng1 || !lat2 || !lng2) return null;
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function findClosestActiveGarage(lat, lng, callback) {
    db.all("SELECT id, lat, lng, name FROM garages WHERE status = 'active' AND (is_test = FALSE OR is_test IS NULL)", (err, rows) => {
        if (err || !rows || rows.length === 0) {
            return callback(null);
        }
        const parsedLat = parseFloat(lat);
        const parsedLng = parseFloat(lng);
        if (isNaN(parsedLat) || isNaN(parsedLng)) {
            return callback(rows[0].id);
        }
        let closestId = rows[0].id;
        let minDist = Infinity;
        rows.forEach(g => {
            const gLat = parseFloat(g.lat);
            const gLng = parseFloat(g.lng);
            if (!isNaN(gLat) && !isNaN(gLng)) {
                const dist = calcDistanceKm(parsedLat, parsedLng, gLat, gLng);
                if (dist !== null && dist < minDist) {
                    minDist = dist;
                    closestId = g.id;
                }
            }
        });
        callback(closestId);
    });
}

apiRouter.get('/marshals/available-pickups', async (req, res) => {
    const marshalLat = parseFloat(req.query.lat);
    const marshalLng = parseFloat(req.query.lng);
    const marshalId = req.query.marshalId;

    try {
        let maxDistSetting = 10.0;
        try {
            const sRes = await pool.query("SELECT value FROM system_settings WHERE key = 'max_pickup_distance_km'");
            if (sRes.rows && sRes.rows.length > 0) maxDistSetting = parseFloat(sRes.rows[0].value) || 10.0;
        } catch(e) {}

        let query = `
            SELECT 
                sr.id,
                sr.status as "status",
                COALESCE(sr.lat, 0) as "pickupLat",
                COALESCE(sr.lng, 0) as "pickupLng",
                sr.pickup_address as "pickupAddress",
                sr.drop_address as "dropAddress",
                sr.date as "pickupDate",
                sr.issue as "pickupTime",
                c.name as "customerName",
                COALESCE(sr.service_category, sr.issue, 'Standard Service') as "issue",
                COALESCE(sr.service_category, sr.issue, 'Standard Service') as "serviceType",
                COALESCE(sr.pickup_drop_type, 'Pickup') as "pickupDropType",
                sr.booking_flow as "bookingFlow",
                v.make as "vehicleMake",
                v.model as "vehicleModel",
                v.make || ' ' || v.model as "vehicleFullName",
                v.type as "vehicleSubType",
                v.plate as "vehicleRegNumber",
                v.photo as "vehiclePhoto",
                v.fuel as "vehicleFuel",
                v.transmission as "vehicleTransmission",
                sr.created_at as "createdAt"
            FROM service_requests sr 
            LEFT JOIN customers c ON sr.customerId = c.id 
            LEFT JOIN vehicles v ON sr.vehicleId = v.id
            WHERE (sr.status = 'pending' OR sr.status = 'scheduled') 
              AND (sr.workerId IS NULL OR sr.workerId = '')
        `;
        const params = [];
        if (marshalId) {
            params.push(marshalId);
            query += ` AND sr.id NOT IN (
                SELECT service_request_id 
                FROM service_request_bids 
                WHERE marshal_id = $${params.length} 
                  AND status IN ('pending', 'declined', 'accepted')
            )`;
        }

        const srRes = await pool.query(query, params);
        let result = srRes.rows || [];
        const now = Date.now();
        
        result = result.filter(row => {
            const createdAt = parseInt(row.createdAt || now);
            const ageSeconds = (now - createdAt) / 1000;
            
            if (!isNaN(marshalLat) && !isNaN(marshalLng)) {
                const pLat = parseFloat(row.pickupLat) || 0;
                const pLng = parseFloat(row.pickupLng) || 0;
                if (pLat === 0 && pLng === 0) return true;
                const dist = calcDistanceKm(marshalLat, marshalLng, pLat, pLng);
                if (dist === null) return true;
                
                // RESTRICTION: Must be within dynamic maximum pickup distance setting
                if (dist > maxDistSetting) return false;
                
                const status = (row.status || '').trim().toLowerCase();
                if (status === 'scheduled') {
                    if (ageSeconds > 600) return false;
                    if (ageSeconds <= 200) return dist <= Math.min(5.0, maxDistSetting);
                    if (ageSeconds <= 400) return dist <= Math.min(10.0, maxDistSetting);
                    return dist <= maxDistSetting;
                } else {
                    if (ageSeconds > 90) return false;
                    if (ageSeconds <= 30) return dist <= Math.min(5.0, maxDistSetting);
                    if (ageSeconds <= 60) return dist <= Math.min(10.0, maxDistSetting);
                    return dist <= maxDistSetting;
                }
            }
            return true;
        });

        res.json(result);
    } catch (err) {
        console.error('Error fetching available pickups:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Driver Bidding: Submit active bid (Driver taps Accept on their phone modal)
apiRouter.post('/service-requests/:id/bid', async (req, res) => {
    const requestId = req.params.id;
    const { marshalId } = req.body;
    if (!marshalId) return res.status(400).json({ error: 'marshalId is required' });

    try {
        const mRes = await pool.query("SELECT * FROM users WHERE id = $1 AND role = 'marshal'", [marshalId]);
        if (mRes.rows.length === 0) return res.status(404).json({ error: 'Marshal not found' });
        const marshal = mRes.rows[0];
        if (marshal.kycstatus !== 'approved' && marshal.kycstatus !== 'verified' && marshal.kycstatus !== 'Approved') {
            return res.status(400).json({ error: 'KYC not approved' });
        }

        const bidId = `bid_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        await pool.query(`
            INSERT INTO service_request_bids (id, service_request_id, marshal_id, status, created_at)
            VALUES ($1, $2, $3, 'pending', NOW())
            ON CONFLICT (service_request_id, marshal_id) DO UPDATE SET status = 'pending', created_at = NOW()
        `, [bidId, requestId, marshalId]);

        res.json({ success: true, message: 'Bid submitted successfully', bidId });
    } catch (err) {
        console.error('Error submitting driver bid:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Driver Decline: Driver explicitly rejects or modal 10s countdown times out
apiRouter.post('/service-requests/:id/decline', async (req, res) => {
    const requestId = req.params.id;
    const { marshalId } = req.body;
    if (!marshalId) return res.status(400).json({ error: 'marshalId is required' });

    try {
        const bidId = `bid_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        await pool.query(`
            INSERT INTO service_request_bids (id, service_request_id, marshal_id, status, created_at)
            VALUES ($1, $2, $3, 'declined', NOW())
            ON CONFLICT (service_request_id, marshal_id) DO UPDATE SET status = 'declined', created_at = NOW()
        `, [bidId, requestId, marshalId]);

        res.json({ success: true, message: 'Pickup declined successfully', bidId });
    } catch (err) {
        console.error('Error declining pickup:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Driver Bidding: Fetch bids actively submitted by drivers for this request
apiRouter.get('/service-requests/:id/bids', authMiddleware, async (req, res) => {
    const requestId = req.params.id;
    try {
        const srRes = await pool.query("SELECT lat, lng, status FROM service_requests WHERE id = $1", [requestId]);
        if (srRes.rows.length === 0) return res.json([]);
        const sr = srRes.rows[0];
        const reqLat = parseFloat(sr.lat) || 22.5525;
        const reqLng = parseFloat(sr.lng) || 88.3524;

        // Query marshals who have ACTUALLY submitted a bid for this service request
        const bRes = await pool.query(`
            SELECT b.id as bid_id, b.created_at,
                   u.id as marshal_id, u.name, u.rating, u.lat, u.lng,
                   u.profilepictureurl, u.facephotourl
            FROM service_request_bids b
            JOIN users u ON b.marshal_id = u.id
            WHERE b.service_request_id = $1
              AND b.status = 'pending'
            ORDER BY b.created_at ASC
        `, [requestId]);

        const bids = [];
        (bRes.rows || []).forEach(m => {
            const mLat = parseFloat(m.lat);
            const mLng = parseFloat(m.lng);
            let dist = 1.2;
            if (!isNaN(mLat) && !isNaN(mLng) && !isNaN(reqLat) && !isNaN(reqLng)) {
                const calculated = calcDistanceKm(mLat, mLng, reqLat, reqLng);
                if (calculated !== null) dist = calculated;
            }
            bids.push({
                marshalId: m.marshal_id,
                marshalName: m.name || 'Verified Driver',
                rating: parseFloat(m.rating || 5.0).toFixed(1),
                distance: parseFloat(dist.toFixed(1)),
                eta: Math.max(3, Math.round(dist * 2.5)),
                photo: generateSignedUploadUrl(m.profilepictureurl || m.facephotourl || null)
            });
        });

        res.json(bids);
    } catch (err) {
        console.error('Error fetching driver bids:', err.message);
        res.json([]);
    }
});

const acceptPickupHandler = async (req, res) => {
    const { marshalId } = req.body;
    const requestId = req.params.id;
    
    try {
        const pgRes = await pool.query("SELECT * FROM users WHERE id = $1 AND role = 'marshal'", [marshalId]);
        const marshal = pgRes && pgRes.rows ? pgRes.rows[0] : null;
        if (!marshal) {
            return res.status(404).json({ error: 'Marshal not found in CRM database' });
        }
        if (marshal.kycstatus !== 'approved' && marshal.kycstatus !== 'verified' && marshal.kycstatus !== 'Approved') {
            return res.status(400).json({ error: `Action Blocked: Your KYC documents status is '${marshal.kycstatus}'. You cannot accept Pickups until approved.` });
        }

        db.get("SELECT value FROM system_settings WHERE key = 'max_pickup_distance_km'", [], (err, settingRow) => {
            const maxDistSetting = settingRow ? parseFloat(settingRow.value) : 10.0;

            db.get("SELECT lat, lng, workerId, status, pickup_drop_type, booking_flow FROM service_requests WHERE id = ?", [requestId], (err, serviceReq) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!serviceReq) return res.status(404).json({ error: 'Service request not found' });
                
                if (serviceReq.workerId && serviceReq.status === 'marshal_assigned') {
                    return res.status(400).json({ error: 'This pickup request has already been confirmed by another marshal.' });
                }
                if (serviceReq.status !== 'pending' && serviceReq.status !== 'scheduled' && serviceReq.status !== 'pending_payment') {
                    if (serviceReq.status === 'cancelled') {
                        return res.status(400).json({ error: 'This pickup request has been cancelled by the customer.' });
                    }
                    return res.status(400).json({ error: 'This booking request is no longer active.' });
                }
                
                const lat = serviceReq.lat || 19.0760;
                const lng = serviceReq.lng || 72.8777;

                // Geofence check on acceptance
                if (marshal.lat && marshal.lng && serviceReq.lat && serviceReq.lng) {
                    const dist = calcDistanceKm(marshal.lat, marshal.lng, serviceReq.lat, serviceReq.lng);
                    if (dist !== null && dist > maxDistSetting) {
                        return res.status(400).json({ error: `Cannot accept pickup: You are ${dist.toFixed(1)}km away, which exceeds the maximum limit of ${maxDistSetting}km.` });
                    }
                }
            
            // Lock driver in pending_payment state until advance payment is verified
            db.run("UPDATE service_requests SET workerId = ?, status = 'pending_payment' WHERE id = ?", [marshalId, requestId], (errU) => {
                if (errU) return res.status(500).json({ error: errU.message });
                
                const tripId = `trip_${Date.now()}`;
                const otp1 = String(Math.floor(1000 + Math.random() * 9000));
                const garageDropoffOtp = String(Math.floor(1000 + Math.random() * 9000));
                const garagePickupOtp = String(Math.floor(1000 + Math.random() * 9000));
                const deliveryOtp = String(Math.floor(1000 + Math.random() * 9000));
                
                const initialStatus = 'pending_payment';
                
                db.run(
                    `INSERT INTO trips (id, serviceRequestId, marshalId, status, otp1, garageDropoffOtp, garagePickupOtp, deliveryOtp, pickupLat, pickupLng) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [tripId, requestId, marshalId, initialStatus, otp1, garageDropoffOtp, garagePickupOtp, deliveryOtp, lat, lng],
                    (errT) => {
                        if (errT) return res.status(500).json({ error: errT.message });
                        res.json({ success: true, tripId, otp1, garageDropoffOtp, garagePickupOtp, deliveryOtp });
                    }
                );
            });
        });
    });
} catch (errPg) {
        console.error('Postgres error querying marshal:', errPg.message);
        return res.status(500).json({ error: 'Database error querying marshal: ' + errPg.message });
    }
};

apiRouter.post('/service-requests/:id/accept-pickup', acceptPickupHandler);
apiRouter.post('/service-requests/:id/select-marshal', acceptPickupHandler);

apiRouter.post('/trips/:id/confirm-payment', async (req, res) => {
    const tripId = req.params.id;
    try {
        await pool.query("UPDATE trips SET status = 'pending_otp_1' WHERE id = $1", [tripId]);
        await pool.query("UPDATE service_requests SET status = 'marshal_assigned' WHERE id = (SELECT servicerequestid FROM trips WHERE id = $1)", [tripId]);
        res.json({ success: true, message: 'Trip payment confirmed and driver dispatched' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

apiRouter.post('/trips/:id/cancel-timeout', async (req, res) => {
    const tripId = req.params.id;
    try {
        const tripRes = await pool.query("SELECT servicerequestid FROM trips WHERE id = $1", [tripId]);
        const sId = tripRes.rows[0]?.servicerequestid;
        await pool.query("UPDATE trips SET status = 'cancelled' WHERE id = $1", [tripId]);
        if (sId) {
            await pool.query("UPDATE service_requests SET workerId = NULL, status = 'cancelled' WHERE id = $1", [sId]);
            await pool.query("UPDATE service_request_bids SET status = 'expired' WHERE service_request_id = $1", [sId]);
            try { db.run("UPDATE service_requests SET workerId = NULL, status = 'cancelled' WHERE id = ?", [sId]); } catch(e) {}
            try { db.run("UPDATE service_request_bids SET status = 'expired' WHERE service_request_id = ?", [sId]); } catch(e) {}
        }
        try { db.run("UPDATE trips SET status = 'cancelled' WHERE id = ?", [tripId]); } catch(e) {}
        res.json({ success: true, message: 'Trip cancelled due to payment timeout; driver released back to pool' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


const assignGarage = (req, res) => {
    const { garageId } = req.body;
    db.run("UPDATE service_requests SET garageId = ?, status = 'in_transit' WHERE id = ?", [garageId, req.params.id], (err) => res.json({ success: true }));
};
apiRouter.put('/service-requests/:id/assign-garage', assignGarage);
apiRouter.put('/requests/:id/assign-garage', assignGarage);

apiRouter.put('/requests/:id/quote', (req, res) => {
    const { garageId } = req.body;
    db.run("UPDATE service_requests SET garageId = ?, status = 'pending_inspection_approval' WHERE id = ?", [garageId, req.params.id], (err) => {
        res.json({ success: true, inspectionQuote: 120 });
    });
});

apiRouter.post('/requests/:id/approve-inspection', (req, res) => {
    db.run("UPDATE service_requests SET status = 'in_transit' WHERE id = ?", [req.params.id], (err) => res.json({ success: true }));
});

function verifyHandoverMedia(tripId, expectedDocTypes, callback) {
    if (!expectedDocTypes || expectedDocTypes.length === 0) {
        return callback(null, true);
    }
    db.all("SELECT docType FROM media WHERE referenceId = ?", [tripId], (err, rows) => {
        if (err) return callback(err, false);
        const uploadedTypes = new Set((rows || []).map(r => r.docType || r.doctype || ''));
        const allUploaded = expectedDocTypes.every(type => uploadedTypes.has(type));
        callback(null, allUploaded);
    });
}

apiRouter.post('/trips/:id/verify-stop-otp', (req, res) => {
    const tripId = req.params.id;
    const { stopIndex, otp } = req.body;
    
    if (stopIndex === undefined || !otp) {
        return res.status(400).json({ error: "Missing stopIndex or otp in request body" });
    }

    db.get(
        `SELECT r.id, r.route_stops 
         FROM service_requests r
         JOIN trips t ON r.id = t.serviceRequestId
         WHERE t.id = ?`,
        [tripId],
        (err, reqRow) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!reqRow) return res.status(404).json({ error: "Trip or service request not found" });

            let stops = [];
            try {
                if (reqRow.route_stops) {
                    stops = JSON.parse(reqRow.route_stops);
                }
            } catch (e) {
                return res.status(500).json({ error: "Failed to parse route stops from database" });
            }

            const idx = parseInt(stopIndex, 10);
            if (isNaN(idx) || idx < 0 || idx >= stops.length) {
                return res.status(400).json({ error: "Invalid stopIndex" });
            }

            const stop = stops[idx];
            if (stop.otp !== String(otp).trim()) {
                return res.status(400).json({ error: "Incorrect verification OTP" });
            }

            stop.otpVerified = true;

            const updatedStopsString = JSON.stringify(stops);
            db.run(
                `UPDATE service_requests SET route_stops = ? WHERE id = ?`,
                [updatedStopsString, reqRow.id],
                (errU) => {
                    if (errU) return res.status(500).json({ error: errU.message });

                    const allStopsVerified = stops.every(s => s.otpVerified);
                    res.json({ success: true, allStopsVerified });
                }
            );
        }
    );
});

apiRouter.put('/trips/:id/status', (req, res) => {
    const { status, startOdometer, garageDropOdometer, endOdometer } = req.body;
    
    let expectedMedia = [];
    if (status === 'in_transit') expectedMedia = ['360_pickup', 'odometer_start'];
    if (status === 'at_garage') expectedMedia = ['360_dropoff_garage', 'odometer_dropoff_garage'];
    if (status === 'out_for_delivery') expectedMedia = ['360_pickup_garage', 'odometer_pickup_garage'];
    if (status === 'completed') expectedMedia = ['360_delivery', 'odometer_end'];

    verifyHandoverMedia(req.params.id, expectedMedia, async (err, isValid) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!isValid && expectedMedia.length > 0) {
            return res.status(400).json({ error: `Mandatory VehicleStateAudit media (${expectedMedia.join(', ')}) not found. Please upload first.` });
        }

        try {
            const tripRes = await pool.query(
                `SELECT t.*, sr.pricing_mode, sr.estimated_hours, sr.id as sr_id 
                 FROM trips t 
                 LEFT JOIN service_requests sr ON t.servicerequestid = sr.id 
                 WHERE t.id = $1`,
                [req.params.id]
            );
            const currentTrip = tripRes.rows[0];

            let rentalStartedAt = currentTrip?.rentalstartedat;
            let rentalExpiresAt = currentTrip?.rentalexpiresat;

            if (status === 'in_transit' && currentTrip?.pricing_mode === 'hourly' && !rentalStartedAt) {
                rentalStartedAt = new Date();
                const estHours = parseFloat(currentTrip.estimated_hours || 1);
                rentalExpiresAt = new Date(rentalStartedAt.getTime() + estHours * 60 * 60 * 1000);
            }

            const fields = ['status = ?'];
            const params = [status];
            
            if (startOdometer !== undefined) { fields.push('startOdometer = ?'); params.push(startOdometer); }
            if (garageDropOdometer !== undefined) { fields.push('garageDropOdometer = ?'); params.push(garageDropOdometer); }
            if (endOdometer !== undefined) { fields.push('endOdometer = ?'); params.push(endOdometer); }
            if (rentalStartedAt !== undefined) { fields.push('rentalstartedat = ?'); params.push(rentalStartedAt); }
            if (rentalExpiresAt !== undefined) { fields.push('rentalexpiresat = ?'); params.push(rentalExpiresAt); }
            
            params.push(req.params.id);

            db.run(`UPDATE trips SET ${fields.join(', ')} WHERE id = ?`, params, (errU) => {
                if (errU) return res.status(500).json({ error: errU.message });
                
                if (currentTrip && currentTrip.sr_id) {
                    const reqId = currentTrip.sr_id;
                    let reqStatus = status;
                    if (status === 'completed') reqStatus = 'drop_completed';

                    const srFields = ['status = ?'];
                    const srParams = [reqStatus];
                    if (rentalStartedAt !== undefined) { srFields.push('rentalstartedat = ?'); srParams.push(rentalStartedAt); }
                    if (rentalExpiresAt !== undefined) { srFields.push('rentalexpiresat = ?'); srParams.push(rentalExpiresAt); }
                    srParams.push(reqId);

                    db.run(`UPDATE service_requests SET ${srFields.join(', ')} WHERE id = ?`, srParams);
                }
                res.json({ success: true, rentalStartedAt, rentalExpiresAt });
            });
        } catch (dbErr) {
            console.error('Error updating trip status:', dbErr.message);
            res.status(500).json({ error: dbErr.message });
        }
    });
});

apiRouter.post('/trips', authMiddleware, requireRole('admin', 'marshal'), (req, res) => {
    const { id, serviceRequestId, marshalId, status, startOdometer, pickupLat, pickupLng } = req.body;
    const tripId = id || `trip_${Date.now()}`;
    db.run(
        `INSERT INTO trips (id, serviceRequestId, marshalId, status, startOdometer, pickupLat, pickupLng) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [tripId, serviceRequestId, marshalId, status || 'pending_otp_1', startOdometer, pickupLat, pickupLng],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: tripId });
        }
    );
});

apiRouter.post('/trips/:id/approve-audit', authMiddleware, async (req, res) => {
    const tripId = req.params.id;
    try {
        const tripRes = await pool.query(
            `SELECT t.id, t.servicerequestid, sr.customerid 
             FROM trips t 
             LEFT JOIN service_requests sr ON t.servicerequestid = sr.id 
             WHERE t.id = $1`,
            [tripId]
        );
        const trip = tripRes.rows[0];
        if (!trip) {
            return res.status(404).json({ error: 'Trip not found' });
        }

        // Allow the trip's customer owner or an admin
        if (req.user.role !== 'admin' && trip.customerid !== req.user.id) {
            return res.status(403).json({ error: 'Forbidden: You do not have permission to approve the audit for this trip.' });
        }

        if (trip.servicerequestid) {
            await pool.query(
                `UPDATE service_requests SET auditstatus = 'approved', status = 'in_progress' WHERE id = $1`,
                [trip.servicerequestid]
            );
            db.run(
                `UPDATE service_requests SET auditStatus = 'approved', status = 'in_progress' WHERE id = ?`,
                [trip.servicerequestid]
            );
        }

        res.json({ success: true, message: 'Trip audit approved successfully.' });
    } catch (err) {
        console.error('Error approving trip audit:', err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
apiRouter.post('/trips/:id/audit', (req, res) => res.json({ success: true, customerEstimate: 600 }));

apiRouter.post('/trips/:id/verify-otp-1', async (req, res) => {
    const { otp } = req.body;
    try {
        const tripRes = await pool.query(
            `SELECT t.*, sr.pricing_mode, sr.estimated_hours, sr.id as sr_id 
             FROM trips t 
             LEFT JOIN service_requests sr ON t.servicerequestid = sr.id 
             WHERE t.id = $1`,
            [req.params.id]
        );
        const trip = tripRes.rows[0];
        if (!trip) return res.status(404).json({ error: 'Trip not found' });
        
        const tripOtp1 = trip.otp1;
        if (tripOtp1 !== otp) {
            return res.status(400).json({ error: 'Invalid Handover OTP' });
        }

        let rentalStartedAt = trip.rentalstartedat;
        let rentalExpiresAt = trip.rentalexpiresat;

        if (trip.pricing_mode === 'hourly' && !rentalStartedAt) {
            rentalStartedAt = new Date();
            const estHours = parseFloat(trip.estimated_hours || 1);
            rentalExpiresAt = new Date(rentalStartedAt.getTime() + estHours * 60 * 60 * 1000);

            await pool.query(
                `UPDATE trips SET rentalstartedat = $1, rentalexpiresat = $2 WHERE id = $3`,
                [rentalStartedAt, rentalExpiresAt, req.params.id]
            );
            if (trip.sr_id) {
                await pool.query(
                    `UPDATE service_requests SET rentalstartedat = $1, rentalexpiresat = $2 WHERE id = $3`,
                    [rentalStartedAt, rentalExpiresAt, trip.sr_id]
                );
            }
        }
        
        res.json({ success: true, rentalStartedAt, rentalExpiresAt });
    } catch (err) {
        console.error('Error verifying OTP 1:', err.message);
        res.status(500).json({ error: err.message });
    }
});

function calcDistanceKm(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return 0;
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

apiRouter.post('/trips/:id/create-extension-order', authMiddleware, async (req, res) => {
    const tripId = req.params.id;
    const durationMinutes = parseInt(req.body.durationMinutes || req.body.minutes, 10);

    if (!durationMinutes || isNaN(durationMinutes) || durationMinutes <= 0) {
        return res.status(400).json({ error: 'durationMinutes must be a positive integer (e.g. 15, 30, 60)' });
    }

    try {
        const tripRes = await pool.query(
            `SELECT t.*, sr.pricing_mode, sr.estimated_hours, sr.totalcustomerprice, sr.vehicle_condition, sr.id as sr_id, sr.customerid as customerId 
             FROM trips t 
             LEFT JOIN service_requests sr ON t.servicerequestid = sr.id 
             WHERE t.id = $1`,
            [tripId]
        );
        const trip = tripRes.rows[0];
        if (!trip) return res.status(404).json({ error: 'Trip not found' });

        if (trip.pricing_mode !== 'hourly') {
            return res.status(400).json({ error: 'Trip is not an hourly rental booking' });
        }

        // Safety Gate: Block sandbox Razorpay checkout for real users unless live keys or is_test_account
        const isLiveMode = process.env.RAZORPAY_KEY_ID?.startsWith('rzp_live_');
        let isTestAccount = false;
        try {
            const custRes = await pool.query("SELECT is_test_account, phone FROM customers WHERE id = $1 UNION SELECT is_test_account, phone FROM users WHERE id = $1", [trip.customerid]);
            if (custRes.rows[0]?.is_test_account === true || custRes.rows[0]?.phone?.includes('9999999999') || trip.customerid === 'cust_test_9999999999') {
                isTestAccount = true;
            }
        } catch(e) {}

        if (!isLiveMode && !isTestAccount) {
            return res.status(403).json({
                error: 'Online rental extensions are launching shortly. Any extra time is automatically calculated and settled at trip dropoff.',
                disabled: true
            });
        }

        // Fetch hourly rate from system settings
        const settingsRes = await pool.query("SELECT key, value FROM system_settings");
        const settings = {};
        settingsRes.rows.forEach(r => { settings[r.key] = r.value; });
        const hourlyRate = parseFloat(settings['car_hourly_rate'] || '150.0');

        const extensionHours = durationMinutes / 60;
        const addedAmount = Math.round(extensionHours * hourlyRate);

        const rzp = getRazorpayClient();
        const rzpOrder = await rzp.orders.create({
            amount: Math.round(addedAmount * 100), // in paise
            currency: 'INR',
            receipt: `ext_${Date.now()}_${tripId.slice(-4)}`,
            notes: {
                type: 'rental_extension',
                tripId,
                durationMinutes,
                hourlyRate
            }
        });

        res.json({
            success: true,
            orderId: rzpOrder.id,
            amount: rzpOrder.amount,
            amountInRupees: addedAmount,
            currency: rzpOrder.currency || 'INR',
            keyId: process.env.RAZORPAY_KEY_ID,
            durationMinutes
        });
    } catch (err) {
        console.error('Error creating extension order:', err.message);
        res.status(500).json({ error: 'Failed to create payment order: ' + err.message });
    }
});

apiRouter.post('/trips/:id/verify-extension-payment', authMiddleware, async (req, res) => {
    const tripId = req.params.id;
    const { orderId, paymentId, signature, durationMinutes: reqMins } = req.body;

    if (!orderId || !paymentId || !signature) {
        return res.status(400).json({ error: 'orderId, paymentId, and signature are required' });
    }

    // 1. Verify HMAC-SHA256 signature
    const expectedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');

    if (expectedSignature !== signature) {
        return res.status(400).json({
            error: 'Invalid payment signature. Verification failed.',
            expected: expectedSignature,
            received: signature
        });
    }

    try {
        const tripRes = await pool.query(
            `SELECT t.*, sr.pricing_mode, sr.estimated_hours, sr.totalcustomerprice, sr.id as sr_id, sr.customerid as customerId 
             FROM trips t 
             LEFT JOIN service_requests sr ON t.servicerequestid = sr.id 
             WHERE t.id = $1`,
            [tripId]
        );
        const trip = tripRes.rows[0];
        if (!trip) return res.status(404).json({ error: 'Trip not found' });

        // 2. IDEMPOTENCY CHECK: if paymentId already in rental_extensions, return immediately
        const currentExtensions = Array.isArray(trip.rental_extensions) ? trip.rental_extensions : [];
        const existingExtension = currentExtensions.find(e => e.paymentId === paymentId);
        if (existingExtension) {
            return res.json({
                success: true,
                idempotent: true,
                rentalExpiresAt: trip.rentalexpiresat,
                durationMinutes: existingExtension.durationMinutes,
                addedAmount: existingExtension.addedAmount
            });
        }

        const durationMinutes = parseInt(reqMins || 15, 10);
        const extensionHours = durationMinutes / 60;
        const settingsRes = await pool.query("SELECT key, value FROM system_settings");
        const settings = {};
        settingsRes.rows.forEach(r => { settings[r.key] = r.value; });
        const hourlyRate = parseFloat(settings['car_hourly_rate'] || '150.0');
        const addedAmount = Math.round(extensionHours * hourlyRate);

        // 3. REFUND IF TRIP IS ALREADY COMPLETED OR CANCELLED
        if (trip.status === 'completed' || trip.status === 'cancelled') {
            try {
                const rzp = getRazorpayClient();
                await rzp.payments.refund(paymentId, {
                    amount: Math.round(addedAmount * 100),
                    notes: { reason: 'trip_already_completed', tripId }
                });
                return res.status(400).json({
                    error: 'Trip has already been completed. Payment was automatically refunded.',
                    refunded: true
                });
            } catch (refErr) {
                console.error('Auto-refund failed:', refErr.message);
                return res.status(500).json({ error: 'Trip is completed and auto-refund failed: ' + refErr.message });
            }
        }

        // 4. Strict Extension Calculation: Add duration to current rentalExpiresAt (NOT Date.now())
        const currentExpiresAtMs = trip.rentalexpiresat ? new Date(trip.rentalexpiresat).getTime() : Date.now();
        const newExpiresAt = new Date(currentExpiresAtMs + durationMinutes * 60 * 1000);

        const newExtensionEntry = {
            extensionId: `ext_${Date.now()}`,
            paymentId,
            orderId,
            durationMinutes,
            addedAmount,
            hourlyRate,
            extendedAt: new Date().toISOString(),
            previousExpiresAt: trip.rentalexpiresat || new Date().toISOString(),
            newExpiresAt: newExpiresAt.toISOString()
        };
        const updatedExtensions = [...currentExtensions, newExtensionEntry];

        const updatedTotalCustomerPrice = (parseFloat(trip.totalcustomerprice) || 0) + addedAmount;
        const updatedEstimatedHours = (parseFloat(trip.estimated_hours) || 1) + extensionHours;

        // 5. Update trips & service_requests table
        await pool.query(
            `UPDATE trips 
             SET rentalexpiresat = $1, rental_extensions = $2::jsonb 
             WHERE id = $3`,
            [newExpiresAt, JSON.stringify(updatedExtensions), tripId]
        );

        if (trip.sr_id) {
            await pool.query(
                `UPDATE service_requests 
                 SET rentalexpiresat = $1, 
                     rental_extensions = $2::jsonb,
                     totalcustomerprice = $3,
                     estimated_hours = $4
                 WHERE id = $5`,
                [newExpiresAt, JSON.stringify(updatedExtensions), updatedTotalCustomerPrice, updatedEstimatedHours, trip.sr_id]
            );
        }

        // 6. Dispute Resolution / Partial Coverage Check
        const nowMs = Date.now();
        const isOvertime = newExpiresAt.getTime() <= nowMs;
        const deficitMinutes = isOvertime ? Math.ceil((nowMs - newExpiresAt.getTime()) / 60000) : 0;

        if (!isOvertime) {
            // Customer fully covered overtime debt! Auto-resolve open overtime dispute
            await pool.query(
                `UPDATE disputes 
                 SET status = 'resolved_extension', 
                     resolution_note = $1,
                     uncovered_deficit_minutes = 0
                 WHERE (tripid = $2 OR tripId = $2) AND dispute_type = 'overtime_movement' AND status IN ('pending', 'partially_covered')`,
                [`Auto-resolved: Customer paid ₹${addedAmount} for +${durationMinutes}m extension (Payment ID: ${paymentId})`, tripId]
            );
        } else {
            // Partial coverage: update deficit minutes and note
            await pool.query(
                `UPDATE disputes 
                 SET status = 'partially_covered', 
                     uncovered_deficit_minutes = $1,
                     resolution_note = $2
                 WHERE (tripid = $2 OR tripId = $2) AND dispute_type = 'overtime_movement' AND status = 'pending'`,
                [deficitMinutes, `Partial Extension: Customer paid ₹${addedAmount} for +${durationMinutes}m. Outstanding deficit: ${deficitMinutes}m remaining`, tripId]
            );
        }

        res.json({
            success: true,
            rentalExpiresAt: newExpiresAt.toISOString(),
            durationMinutes,
            addedAmount,
            totalCustomerPrice: updatedTotalCustomerPrice,
            estimatedHours: updatedEstimatedHours,
            rentalExtensions: updatedExtensions,
            isOvertime,
            deficitMinutes
        });
    } catch (err) {
        console.error('Error verifying extension payment:', err.message);
        res.status(500).json({ error: 'Failed to verify extension payment: ' + err.message });
    }
});

apiRouter.post('/trips/:id/extend-rental', authMiddleware, async (req, res) => {
    const tripId = req.params.id;
    const durationMinutes = parseInt(req.body.durationMinutes || req.body.minutes, 10);

    if (!durationMinutes || isNaN(durationMinutes) || durationMinutes <= 0) {
        return res.status(400).json({ error: 'durationMinutes must be a positive integer (e.g. 15, 30, 60)' });
    }

    try {
        const tripRes = await pool.query(
            `SELECT t.*, sr.pricing_mode, sr.estimated_hours, sr.totalcustomerprice, sr.vehicle_condition, sr.id as sr_id 
             FROM trips t 
             LEFT JOIN service_requests sr ON t.servicerequestid = sr.id 
             WHERE t.id = $1`,
            [tripId]
        );
        const trip = tripRes.rows[0];
        if (!trip) return res.status(404).json({ error: 'Trip not found' });

        if (trip.pricing_mode !== 'hourly') {
            return res.status(400).json({ error: 'Trip is not an hourly rental booking' });
        }

        // Fetch hourly rate from system settings
        const settingsRes = await pool.query("SELECT key, value FROM system_settings");
        const settings = {};
        settingsRes.rows.forEach(r => { settings[r.key] = r.value; });
        const hourlyRate = parseFloat(settings['car_hourly_rate'] || '150.0');

        const extensionHours = durationMinutes / 60;
        const addedAmount = Math.round(extensionHours * hourlyRate);

        // Strict extension calculation from current rentalExpiresAt
        const currentExpiresAtMs = trip.rentalexpiresat ? new Date(trip.rentalexpiresat).getTime() : Date.now();
        const newExpiresAt = new Date(currentExpiresAtMs + durationMinutes * 60 * 1000);

        const currentExtensions = Array.isArray(trip.rental_extensions) ? trip.rental_extensions : [];
        const newExtensionEntry = {
            extensionId: `ext_${Date.now()}`,
            durationMinutes,
            addedAmount,
            hourlyRate,
            extendedAt: new Date().toISOString(),
            previousExpiresAt: trip.rentalexpiresat || new Date().toISOString(),
            newExpiresAt: newExpiresAt.toISOString()
        };
        const updatedExtensions = [...currentExtensions, newExtensionEntry];

        const updatedTotalCustomerPrice = (parseFloat(trip.totalcustomerprice) || 0) + addedAmount;
        const updatedEstimatedHours = (parseFloat(trip.estimated_hours) || 1) + extensionHours;

        // Update trips table
        await pool.query(
            `UPDATE trips 
             SET rentalexpiresat = $1, rental_extensions = $2::jsonb 
             WHERE id = $3`,
            [newExpiresAt, JSON.stringify(updatedExtensions), tripId]
        );

        // Update service_requests table
        if (trip.sr_id) {
            await pool.query(
                `UPDATE service_requests 
                 SET rentalexpiresat = $1, 
                     rental_extensions = $2::jsonb,
                     totalcustomerprice = $3,
                     estimated_hours = $4
                 WHERE id = $5`,
                [newExpiresAt, JSON.stringify(updatedExtensions), updatedTotalCustomerPrice, updatedEstimatedHours, trip.sr_id]
            );
        }

        // Dispute Resolution Check
        const nowMs = Date.now();
        const isOvertime = newExpiresAt.getTime() <= nowMs;
        const deficitMinutes = isOvertime ? Math.ceil((nowMs - newExpiresAt.getTime()) / 60000) : 0;

        if (!isOvertime) {
            await pool.query(
                `UPDATE disputes 
                 SET status = 'resolved_extension', 
                     resolution_note = $1,
                     uncovered_deficit_minutes = 0
                 WHERE (tripid = $2 OR tripId = $2) AND dispute_type = 'overtime_movement' AND status IN ('pending', 'partially_covered')`,
                [`Auto-resolved: Customer added +${durationMinutes}m extension for ₹${addedAmount}`, tripId]
            );
        } else {
            await pool.query(
                `UPDATE disputes 
                 SET status = 'partially_covered', 
                     uncovered_deficit_minutes = $1,
                     resolution_note = $2
                 WHERE (tripid = $2 OR tripId = $2) AND dispute_type = 'overtime_movement' AND status = 'pending'`,
                [deficitMinutes, `Partial Extension: Customer added +${durationMinutes}m. Outstanding deficit: ${deficitMinutes}m remaining`, tripId]
            );
        }

        res.json({
            success: true,
            rentalExpiresAt: newExpiresAt.toISOString(),
            durationMinutes,
            addedAmount,
            totalCustomerPrice: updatedTotalCustomerPrice,
            estimatedHours: updatedEstimatedHours,
            rentalExtensions: updatedExtensions,
            isOvertime,
            deficitMinutes
        });
    } catch (err) {
        console.error('Error extending rental:', err.message);
        res.status(500).json({ error: 'Failed to extend rental: ' + err.message });
    }
});

apiRouter.post('/trips/:id/location', async (req, res) => {
    const tripId = req.params.id;
    const { lat, lng, speed, accuracy } = req.body;

    if (lat === undefined || lng === undefined) {
        return res.status(400).json({ error: 'lat and lng are required' });
    }

    const curLat = parseFloat(lat);
    const curLng = parseFloat(lng);
    const curAccuracy = accuracy !== undefined && accuracy !== null ? parseFloat(accuracy) : null;
    const rawSpeed = speed !== undefined && speed !== null ? parseFloat(speed) : null;

    try {
        const tripRes = await pool.query(
            `SELECT t.*, sr.pricing_mode, sr.estimated_hours, sr.customerid as customerId 
             FROM trips t 
             LEFT JOIN service_requests sr ON t.servicerequestid = sr.id 
             WHERE t.id = $1`,
            [tripId]
        );
        const trip = tripRes.rows[0];
        if (!trip) return res.status(404).json({ error: 'Trip not found' });

        const now = new Date();
        const lastLat = trip.last_lat ? parseFloat(trip.last_lat) : (trip.pickuplat ? parseFloat(trip.pickuplat) : null);
        const lastLng = trip.last_lng ? parseFloat(trip.last_lng) : (trip.pickuplng ? parseFloat(trip.pickuplng) : null);
        const lastTime = trip.last_location_time ? new Date(trip.last_location_time).getTime() : now.getTime();
        
        const deltaMs = Math.max(1000, now.getTime() - lastTime);
        const deltaHours = deltaMs / (1000 * 3600);

        let deltaDistKm = 0;
        if (lastLat !== null && lastLng !== null) {
            deltaDistKm = calcDistanceKm(lastLat, lastLng, curLat, curLng);
        }

        const calcSpeedKmH = deltaHours > 0 ? (deltaDistKm / deltaHours) : 0;
        
        // Priority 1: Hardware device GPS speed (in km/h). Priority 2: Calculated velocity
        let effectiveSpeedKmH = calcSpeedKmH;
        if (rawSpeed !== null && !isNaN(rawSpeed) && rawSpeed >= 0) {
            const devSpeedKmH = rawSpeed <= 60 ? (rawSpeed * 3.6) : rawSpeed;
            if (deltaDistKm >= 0.01 || devSpeedKmH < 10) {
                effectiveSpeedKmH = devSpeedKmH;
            }
        }

        let consecutivePings = trip.consecutive_moving_pings || 0;
        let overtimeDistanceKm = parseFloat(trip.overtime_distance_km || 0);
        let disputeFlagged = !!trip.overtime_dispute_flagged;
        let trail = Array.isArray(trip.overtime_trail) ? trip.overtime_trail : [];

        const isHourly = trip.pricing_mode === 'hourly';
        const isTransit = trip.status === 'in_transit' || trip.status === 'picked_up' || trip.status === 'pending_delivery' || trip.status === 'out_for_delivery';
        const expiresAtMs = trip.rentalexpiresat ? new Date(trip.rentalexpiresat).getTime() : null;
        const isInOvertime = isHourly && isTransit && expiresAtMs && (now.getTime() > expiresAtMs);

        // Safeguards:
        // 1. Accuracy gate: if accuracy > 35m, reject from distance accumulation
        const isAccuracyValid = curAccuracy === null || curAccuracy <= 35;
        // 2. Displacement gate: >= 25 meters (0.025 km)
        const isDisplacementValid = deltaDistKm >= 0.025;
        // 3. Speed threshold: > 10 km/h
        const isSpeedOverThreshold = effectiveSpeedKmH > 10.0;

        if (isInOvertime && isAccuracyValid) {
            if (isSpeedOverThreshold && isDisplacementValid) {
                consecutivePings += 1;
                // Require >= 2 consecutive pings before counting distance
                if (consecutivePings >= 2) {
                    overtimeDistanceKm += deltaDistKm;
                    
                    // Downsample trail: append if >= 50m displacement or >= 30s elapsed from last point
                    const lastTrailPoint = trail[trail.length - 1];
                    const timeSinceLastPointMs = lastTrailPoint ? (now.getTime() - new Date(lastTrailPoint.t).getTime()) : Infinity;
                    const distSinceLastPointKm = lastTrailPoint ? calcDistanceKm(lastTrailPoint.lat, lastTrailPoint.lng, curLat, curLng) : Infinity;

                    if (distSinceLastPointKm >= 0.05 || timeSinceLastPointMs >= 30000 || trail.length === 0) {
                        trail.push({
                            lat: Number(curLat.toFixed(6)),
                            lng: Number(curLng.toFixed(6)),
                            speed: Math.round(effectiveSpeedKmH),
                            t: now.toISOString()
                        });
                        // Hard cap at 200 points
                        if (trail.length > 200) {
                            trail = [trail[0], ...trail.slice(-199)];
                        }
                    }

                    // 3km Dispute Trigger
                    if (overtimeDistanceKm >= 3.0 && !disputeFlagged) {
                        disputeFlagged = true;
                        const dispId = `disp_ot_${Date.now()}`;
                        await pool.query(
                            `INSERT INTO disputes (
                                id, tripid, customerid, marshalid, dispute_type, 
                                booked_duration_hours, rental_expires_at, overtime_distance_km, 
                                location_trail, reason, status, createdat
                            ) VALUES ($1, $2, $3, $4, 'overtime_movement', $5, $6, $7, $8::jsonb, $9, 'pending', NOW())
                            ON CONFLICT (id) DO NOTHING`,
                            [
                                dispId,
                                tripId,
                                trip.customerId || trip.customerid || null,
                                trip.marshalId || trip.marshalid || null,
                                parseFloat(trip.estimated_hours || 1),
                                trip.rentalexpiresat,
                                overtimeDistanceKm,
                                JSON.stringify(trail),
                                `Trip time exceeded by ${overtimeDistanceKm.toFixed(1)} km at >10 km/h without extension`
                            ]
                        );
                        // NOTE: NEVER set is_payment_on_hold = 1 for the driver!
                    } else if (disputeFlagged) {
                        // Update existing dispute distance & trail
                        await pool.query(
                            `UPDATE disputes 
                             SET overtime_distance_km = $1, location_trail = $2::jsonb 
                             WHERE (tripid = $3 OR tripId = $3) AND dispute_type = 'overtime_movement'`,
                            [overtimeDistanceKm, JSON.stringify(trail), tripId]
                        );
                    }
                }
            } else if (!isSpeedOverThreshold || deltaDistKm < 0.01) {
                // Stationary dwell or crawl: reset consecutive moving streak
                consecutivePings = 0;
            }
        }

        // Update trip state
        await pool.query(
            `UPDATE trips 
             SET marshalLat = $1, marshalLng = $2, 
                 last_lat = $1, last_lng = $2, last_speed = $3, last_location_time = $4,
                 consecutive_moving_pings = $5, overtime_distance_km = $6, 
                 overtime_dispute_flagged = $7, overtime_trail = $8::jsonb 
             WHERE id = $9`,
            [curLat, curLng, effectiveSpeedKmH, now, consecutivePings, overtimeDistanceKm, disputeFlagged, JSON.stringify(trail), tripId]
        );

        if (trip.servicerequestid) {
            await pool.query(
                `UPDATE service_requests 
                 SET overtime_distance_km = $1, overtime_dispute_flagged = $2 
                 WHERE id = $3`,
                [overtimeDistanceKm, disputeFlagged, trip.servicerequestid]
            );
        }

        res.json({
            success: true,
            speedKmH: Math.round(effectiveSpeedKmH),
            overtimeDistanceKm: Number(overtimeDistanceKm.toFixed(2)),
            overtimeDisputeFlagged: disputeFlagged,
            isInOvertime
        });
    } catch (err) {
        console.error('Error processing trip location:', err.message);
        res.status(500).json({ error: 'Failed to process location: ' + err.message });
    }
});

apiRouter.post('/trips/:id/verify-garage-dropoff', (req, res) => {
    const { otp } = req.body;
    db.get("SELECT garageDropoffOtp FROM trips WHERE id = ?", [req.params.id], (err, trip) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!trip) return res.status(404).json({ error: 'Trip not found' });
        
        const dbOtp = trip.garageDropoffOtp || trip.garagedropoffotp;
        if (dbOtp !== otp) {
            return res.status(400).json({ error: 'Invalid Garage Dropoff OTP' });
        }
        
        res.json({ success: true });
    });
});

apiRouter.post('/trips/:id/verify-garage-pickup', (req, res) => {
    const { otp } = req.body;
    db.get("SELECT garagePickupOtp FROM trips WHERE id = ?", [req.params.id], (err, trip) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!trip) return res.status(404).json({ error: 'Trip not found' });
        
        const dbOtp = trip.garagePickupOtp || trip.garagepickupotp;
        if (dbOtp !== otp) {
            return res.status(400).json({ error: 'Invalid Garage Pickup OTP' });
        }
        
        res.json({ success: true });
    });
});

// --- NEW MARSHAL DROPOFF ENDPOINTS ---
apiRouter.post('/trips/:id/ready-for-delivery', (req, res) => {
    // Garage marks the car as ready. Generate OTPs and default to original marshal.
    const deliveryOtp = String(Math.floor(1000 + Math.random() * 9000));
    const garagePickupOtp = String(Math.floor(1000 + Math.random() * 9000));
    db.run(
        "UPDATE trips SET status = 'ready_for_delivery', deliveryOtp = ?, garagePickupOtp = ?, deliveryMarshalId = marshalId WHERE id = ?",
        [deliveryOtp, garagePickupOtp, req.params.id],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, deliveryOtp, garagePickupOtp }); // Included in response for testing
        }
    );
});

apiRouter.put('/trips/:id/reassign-delivery', (req, res) => {
    const { newMarshalId } = req.body;
    db.run(
        "UPDATE trips SET deliveryMarshalId = ? WHERE id = ?",
        [newMarshalId, req.params.id],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

apiRouter.post('/trips/:id/start-delivery', (req, res) => {
    db.get("SELECT status FROM trips WHERE id = ?", [req.params.id], (err, trip) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!trip) return res.status(404).json({ error: 'Trip not found' });
        if (trip.status !== 'ready_for_delivery') {
            return res.status(400).json({ error: 'Cannot start delivery from status: ' + trip.status });
        }
        db.run(
            "UPDATE trips SET status = 'out_for_delivery' WHERE id = ?",
            [req.params.id],
            (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true });
            }
        );
    });
});

apiRouter.post('/trips/:id/submit-delivery-media', (req, res) => {
    const { odometer } = req.body;
    db.get("SELECT status FROM trips WHERE id = ?", [req.params.id], (err, trip) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!trip) return res.status(404).json({ error: 'Trip not found' });
        if (trip.status !== 'out_for_delivery') {
            return res.status(400).json({ error: 'Cannot submit delivery media from status: ' + trip.status });
        }
        db.run(
            "UPDATE trips SET status = 'pending_delivery', endOdometer = ? WHERE id = ?",
            [odometer || null, req.params.id],
            (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true });
            }
        );
    });
});

apiRouter.post('/trips/:id/complete-delivery', (req, res) => {
    const { otp, odometer } = req.body;
    
    verifyHandoverMedia(req.params.id, ['360_delivery', 'odometer_end'], (errM, isValid) => {
        if (errM) return res.status(500).json({ error: errM.message });
        if (!isValid) {
            return res.status(400).json({ error: 'Mandatory VehicleStateAudit media (360_delivery, odometer_end) not found. Please upload first.' });
        }
        
        db.get("SELECT trips.status, trips.deliveryOtp, trips.startOdometer, trips.endOdometer, trips.deliveryMarshalId, trips.marshalId, trips.serviceRequestId, service_requests.totalcustomerprice, service_requests.marshalcommission, service_requests.pricing_mode, service_requests.estimated_hours, service_requests.vehicle_type, service_requests.unextended_overtime_cost, u.rating as marshal_rating FROM trips JOIN service_requests ON trips.serviceRequestId = service_requests.id LEFT JOIN users u ON trips.marshalId = u.id WHERE trips.id = ?", [req.params.id], (err, trip) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!trip) return res.status(404).json({ error: 'Trip not found' });
            
            const tripDeliveryOtp = trip.deliveryOtp || trip.deliveryotp;
            const tripDeliveryMarshalId = trip.deliveryMarshalId || trip.deliverymarshalid || trip.marshalId || trip.marshalid;
            const tripMarshalId = trip.marshalId || trip.marshalid;
            const tripServiceRequestId = trip.serviceRequestId || trip.servicerequestid;
            const totalCustomerPrice = trip.totalcustomerprice || trip.totalCustomerPrice || 0;
            const marshalRating = trip.marshal_rating !== null && trip.marshal_rating !== undefined ? parseFloat(trip.marshal_rating) : 5.0;
            const isHourly = trip.pricing_mode === 'hourly' || trip.pricingmode === 'hourly';

            if (trip.status !== 'pending_delivery' && trip.status !== 'out_for_delivery') {
                return res.status(400).json({ error: 'Trip cannot be completed from status: ' + trip.status });
            }
            if (tripDeliveryOtp !== otp) {
                return res.status(400).json({ error: 'Invalid Delivery OTP' });
            }
        
        db.run("UPDATE trips SET status = 'completed', endOdometer = COALESCE(?, endOdometer) WHERE id = ?", [odometer || null, req.params.id], (err2) => {
            if (err2) return res.status(500).json({ error: err2.message });
            
            db.run("UPDATE service_requests SET status = 'drop_completed' WHERE id = ?", [tripServiceRequestId], async (errSR) => {
                if (errSR) console.error("Failed to update service request status:", errSR.message);
                
                db.all("SELECT key, value FROM system_settings WHERE key IN ('marshal_rating_threshold', 'commission_high_tier', 'commission_low_tier', 'base_fare', 'customer_rate_per_km', 'car_hourly_rate', 'bike_hourly_rate')", [], async (err3, rows) => {
                    const settings = {};
                    (rows || []).forEach(r => { settings[r.key] = r.value; });
                    
                    const baseFare = parseFloat(settings['base_fare'] || '50.0');
                    const vType = (trip.vehicle_type || trip.vehicletype || 'car').toLowerCase();
                    
                    try {
                        const ratesRes = await pool.query("SELECT commission_rate_percent FROM payout_model_rates WHERE id = 'current_rates'");
                        const commissionRatePercent = ratesRes.rows[0] ? parseFloat(ratesRes.rows[0].commission_rate_percent) : 20.0;
                        
                        // Fetch driver plan
                        const driverRes = await pool.query("SELECT payout_model, subscription_valid_until FROM users WHERE id = $1", [tripMarshalId]);
                        const driver = driverRes.rows[0] || { payout_model: 'commission' };
                        const isSubscribed = driver.payout_model === 'subscription' && 
                                             driver.subscription_valid_until && 
                                             new Date(driver.subscription_valid_until) >= new Date();
                        
                        const payoutMultiplier = isSubscribed ? 1.0 : Math.max(0, (1 - (commissionRatePercent / 100)));
                        let inserts = [];
                        let baseAmount = 0;
                        let extraAmount = 0;
                        let distance = 0;
                        let rate = 0;
                        let baseRatePerKm = 0;
                        let totalCredited = 0;

                        if (isHourly) {
                            // --- HOURLY RENTAL DRIVER PAYOUT (FLOOR-UNDER-COMMISSION MODEL) ---
                            const hslabsRes = await pool.query(
                                "SELECT maxhours as \"maxHours\", rateperhour as \"ratePerHour\" FROM hourly_incentive_slabs WHERE LOWER(COALESCE(vehicle_type, 'car')) = $1 ORDER BY maxhours ASC",
                                [vType]
                            );
                            const hslabs = hslabsRes.rows || [];
                            const authorizedHours = Math.max(0.5, parseFloat(trip.estimated_hours || trip.estimatedhours || 1.0));
                            
                            const matchingHslab = hslabs.find(s => authorizedHours <= Number(s.maxHours)) || hslabs[hslabs.length - 1];
                            const defaultSlabRate = vType === 'bike' ? 40.0 : 80.0;
                            const slabRatePerHour = matchingHslab ? Number(matchingHslab.ratePerHour) : defaultSlabRate;
                            const slabFloor = Math.round(authorizedHours * slabRatePerHour);

                            const custPriceTotal = parseFloat(trip.totalcustomerprice || trip.totalCustomerPrice || 0);
                            const unextOt = parseFloat(trip.unextended_overtime_cost || trip.unextendedovertimecost || 0);
                            const customerAuthorizedFare = Math.max(0, custPriceTotal - unextOt);
                            const defaultHourlyCustomerRate = vType === 'bike' ? 75.0 : 150.0;
                            const baseCustFare = customerAuthorizedFare > 0 ? customerAuthorizedFare : Math.round(authorizedHours * defaultHourlyCustomerRate);

                            const standardPayout = Math.round(baseCustFare * payoutMultiplier);
                            const finalAuthorizedPayout = Math.max(standardPayout, isSubscribed ? baseCustFare : slabFloor);
                            totalCredited = finalAuthorizedPayout;
                            baseAmount = finalAuthorizedPayout;

                            const insId = `inc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}_1_base`;
                            if (tripMarshalId === tripDeliveryMarshalId) {
                                inserts.push([insId, tripMarshalId, req.params.id, finalAuthorizedPayout, 'hourly_booking_base', 'pending']);
                            } else {
                                inserts.push([insId, tripMarshalId, req.params.id, finalAuthorizedPayout / 2, 'hourly_booking_base', 'pending']);
                                inserts.push([`inc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}_2_base`, tripDeliveryMarshalId, req.params.id, finalAuthorizedPayout / 2, 'hourly_booking_base', 'pending']);
                            }
                        } else {
                            // --- DISTANCE RIDE DRIVER PAYOUT ---
                            const slabsRes = await pool.query(
                                "SELECT maxDistance, ratePerKm FROM incentive_slabs WHERE LOWER(COALESCE(vehicle_type, 'car')) = $1 ORDER BY maxDistance ASC",
                                [vType]
                            );
                            const slabs = (slabsRes.rows || []).map(s => ({
                                maxDistance: s.maxDistance !== undefined ? s.maxDistance : s.maxdistance,
                                ratePerKm: s.ratePerKm !== undefined ? s.ratePerKm : s.rateperkm
                            }));

                            const endOdm = odometer || trip.endOdometer || trip.endodometer || 0;
                            const startOdm = trip.startOdometer || trip.startodometer || 0;
                            distance = Math.max(0, endOdm - startOdm);

                            rate = 15.0;
                            if (slabs.length > 0) {
                                const matchingSlab = slabs.find(s => distance <= s.maxDistance);
                                rate = matchingSlab ? matchingSlab.ratePerKm : slabs[slabs.length - 1].ratePerKm;
                            }

                            baseRatePerKm = parseFloat(settings['customer_rate_per_km'] || '25.0');
                            baseAmount = distance * baseRatePerKm;
                            extraAmount = distance * Math.max(0, rate - baseRatePerKm);

                            if (baseAmount + extraAmount < baseFare) {
                                baseAmount = baseFare;
                                extraAmount = 0;
                            }

                            const finalBase = baseAmount * payoutMultiplier;
                            const finalExtra = extraAmount * payoutMultiplier;
                            totalCredited = finalBase + finalExtra;

                            if (tripMarshalId === tripDeliveryMarshalId) {
                                inserts.push([`inc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}_1_base`, tripMarshalId, req.params.id, finalBase, 'trip_bonus_base', 'pending']);
                                if (finalExtra > 0) {
                                    inserts.push([`inc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}_1_extra`, tripMarshalId, req.params.id, finalExtra, 'trip_bonus_extra', 'pending']);
                                }
                            } else {
                                inserts.push([`inc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}_1_base`, tripMarshalId, req.params.id, finalBase / 2, 'trip_bonus_base', 'pending']);
                                if (finalExtra > 0) {
                                    inserts.push([`inc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}_1_extra`, tripMarshalId, req.params.id, finalExtra / 2, 'trip_bonus_extra', 'pending']);
                                }
                                inserts.push([`inc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}_2_base`, tripDeliveryMarshalId, req.params.id, finalBase / 2, 'trip_bonus_base', 'pending']);
                                if (finalExtra > 0) {
                                    inserts.push([`inc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}_2_extra`, tripDeliveryMarshalId, req.params.id, finalExtra / 2, 'trip_bonus_extra', 'pending']);
                                }
                            }
                        }

                        let completed = 0;
                        const onInsertsFinished = async () => {
                            try {
                                // 1. HOURLY RENTAL OVERTIME SETTLEMENT & DISPUTE AUTO-RESOLUTION
                                let overtimeSettlement = { overtimeMinutes: 0, overtimeCost: 0, driverOvertimePayout: 0, disputeResolved: false };
                                const tripInfoRes = await pool.query(
                                    `SELECT t.rentalexpiresat, t.rentalstartedat, sr.pricing_mode, sr.totalcustomerprice, sr.customerid, sr.vehicle_type 
                                     FROM trips t 
                                     JOIN service_requests sr ON t.servicerequestid = sr.id 
                                     WHERE t.id = $1`,
                                    [req.params.id]
                                );
                                const tripInfo = tripInfoRes.rows[0];

                                if (tripInfo && tripInfo.pricing_mode === 'hourly' && tripInfo.rentalexpiresat) {
                                    const expiresAtMs = new Date(tripInfo.rentalexpiresat).getTime();
                                    const nowMs = Date.now();
                                    if (nowMs > expiresAtMs) {
                                        const overtimeMinutes = Math.ceil((nowMs - expiresAtMs) / (60 * 1000));
                                        const vt = (tripInfo.vehicle_type || 'car').toLowerCase();
                                        const rateSettingKey = vt === 'bike' ? 'bike_hourly_rate' : 'car_hourly_rate';
                                        const settingsRes = await pool.query("SELECT value FROM system_settings WHERE key = $1", [rateSettingKey]);
                                        const defaultRate = vt === 'bike' ? '75.0' : '150.0';
                                        const hourlyRate = parseFloat(settingsRes.rows[0]?.value || defaultRate);
                                        const overtimeCost = Math.round((overtimeMinutes / 60) * hourlyRate);

                                        if (overtimeCost > 0) {
                                            await pool.query(
                                                `UPDATE service_requests 
                                                 SET unextended_overtime_cost = $1, 
                                                     totalcustomerprice = COALESCE(totalcustomerprice, 0) + $1 
                                                 WHERE id = $2`,
                                                [overtimeCost, tripServiceRequestId]
                                            );

                                            if (tripInfo.customerid) {
                                                await pool.query(
                                                    `UPDATE customers 
                                                     SET outstanding_balance = COALESCE(outstanding_balance, 0) + $1 
                                                     WHERE id = $2`,
                                                    [overtimeCost, tripInfo.customerid]
                                                );
                                            }

                                            await pool.query(
                                                `UPDATE disputes 
                                                 SET status = 'resolved_paid_at_checkout',
                                                     resolution_note = $1,
                                                     uncovered_deficit_minutes = 0
                                                 WHERE (tripid = $2 OR tripId = $2) AND dispute_type = 'overtime_movement' AND status IN ('pending', 'partially_covered')`,
                                                [`Auto-billed ₹${overtimeCost} for ${overtimeMinutes}m unextended overtime at trip completion`, req.params.id]
                                            );

                                            // Itemized Overtime Driver Payout Insert
                                            const driverOtPayout = Math.round(overtimeCost * payoutMultiplier);
                                            if (driverOtPayout > 0) {
                                                const otInsId = `inc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}_ot`;
                                                await pool.query(
                                                    "INSERT INTO incentives (id, userid, tripid, amount, type, status) VALUES ($1, $2, $3, $4, $5, $6)",
                                                    [otInsId, tripMarshalId, req.params.id, driverOtPayout, 'hourly_overtime_payout', 'pending']
                                                ).catch(e => console.error("Error inserting hourly_overtime_payout:", e.message));

                                                db.run(
                                                    "INSERT INTO incentives (id, userId, tripId, amount, type, status) VALUES (?, ?, ?, ?, ?, ?)",
                                                    [otInsId, tripMarshalId, req.params.id, driverOtPayout, 'hourly_overtime_payout', 'pending'],
                                                    () => {}
                                                );
                                            }

                                            overtimeSettlement = { overtimeMinutes, overtimeCost, driverOvertimePayout: driverOtPayout, disputeResolved: true };
                                        }
                                    }
                                }

                                        // 2. POST-TRIP FARE RECONCILIATION
                                        let reconciliationInfo = { status: 'none' };
                                        const rpRes = await pool.query("SELECT * FROM ride_payments WHERE service_request_id = $1", [tripServiceRequestId]);
                                        if (rpRes.rows.length > 0) {
                                            const payment = rpRes.rows[0];
                                            const advancePaid = parseFloat(payment.amount_paid);
                                            const actualCustomerFare = Math.max(baseFare, baseAmount + extraAmount);
                                            const diff = actualCustomerFare - advancePaid;

                                            const graceRes = await pool.query("SELECT value FROM system_settings WHERE key = 'customer_shortfall_grace_buffer'");
                                            const graceBuffer = parseFloat(graceRes.rows[0]?.value || '50.0');

                                            if (diff < 0) {
                                                const refundAmt = Math.round(Math.abs(diff) * 100) / 100;
                                                let rzpRef = null;
                                                if (payment.gateway_payment_id) {
                                                    try {
                                                        const rzp = getRazorpayClient();
                                                        rzpRef = await rzp.payments.refund(payment.gateway_payment_id, {
                                                            amount: Math.round(refundAmt * 100),
                                                            notes: { reason: 'post_trip_overpayment_refund', tripId: req.params.id }
                                                        });
                                                    } catch (eRef) {
                                                        console.error('[AUTO_REFUND_ERROR]', eRef.message);
                                                    }
                                                }
                                                await pool.query(`
                                                    UPDATE ride_payments 
                                                    SET status = 'partially_refunded', actual_fare = $1, refund_amount = $2,
                                                        refund_id = $3, fare_difference = $4, updated_at = NOW()
                                                    WHERE id = $5
                                                `, [actualCustomerFare, refundAmt, rzpRef?.id || 'auto_refund', diff, payment.id]);
                                                reconciliationInfo = { status: 'overpayment_refunded', refundAmount: refundAmt, refundId: rzpRef?.id };
                                            } else if (diff > 0) {
                                                if (diff <= graceBuffer) {
                                                    await pool.query(`
                                                        UPDATE ride_payments 
                                                        SET status = 'settled', actual_fare = $1, fare_difference = $2, updated_at = NOW()
                                                        WHERE id = $3
                                                    `, [actualCustomerFare, diff, payment.id]);
                                                    reconciliationInfo = { status: 'grace_absorbed', shortfall: diff };
                                                } else {
                                                    await pool.query("UPDATE customers SET outstanding_balance = COALESCE(outstanding_balance, 0) + $1 WHERE id = $2", [diff, payment.customer_id]);
                                                    await pool.query(`
                                                        UPDATE ride_payments 
                                                        SET status = 'settled', actual_fare = $1, fare_difference = $2, updated_at = NOW()
                                                        WHERE id = $3
                                                    `, [actualCustomerFare, diff, payment.id]);
                                                    reconciliationInfo = { status: 'shortfall_recorded_to_ledger', shortfall: diff };
                                                }
                                            } else {
                                                await pool.query("UPDATE ride_payments SET status = 'settled', actual_fare = $1, updated_at = NOW() WHERE id = $2", [actualCustomerFare, payment.id]);
                                                reconciliationInfo = { status: 'exact_match' };
                                            }
                                        }

                                        res.json({ 
                                            success: true, 
                                            message: 'Delivery completed and commission credited', 
                                            commissionCredited: totalCredited, 
                                            distanceUsed: distance, 
                                            rateUsed: rate, 
                                            baseFareUsed: baseRatePerKm,
                                            payoutModelApplied: isSubscribed ? 'subscription (100% payout)' : `commission (${commissionRatePercent}% deducted)`,
                                            reconciliation: reconciliationInfo,
                                            overtimeSettlement
                                        });
                                    } catch (eFin) {
                                        console.error('Finalization error:', eFin);
                                        res.json({ success: true, message: 'Delivery completed (warning: ' + eFin.message + ')' });
                                    }
                                };

                                if (inserts.length === 0) {
                                    return onInsertsFinished();
                                }
                                inserts.forEach(insert => {
                                    db.run(
                                        "INSERT INTO incentives (id, userId, tripId, amount, type, status) VALUES (?, ?, ?, ?, ?, ?)",
                                        insert,
                                        () => {
                                            pool.query(
                                                "INSERT INTO incentives (id, userid, tripid, amount, type, status) VALUES ($1, $2, $3, $4, $5, $6)",
                                                [insert[0], insert[1], insert[2], insert[3], insert[4], insert[5]]
                                            ).catch(e => console.error("PG Sync Error:", e));

                                            completed++;
                                            if (completed === inserts.length) {
                                                onInsertsFinished();
                                            }
                                        }
                                    );
                                });
                            } catch (e) {
                                console.error('Settlement calculation error:', e);
                                res.status(500).json({ error: 'Failed to settle trip payout: ' + e.message });
                            }
                        });
                    });
                });
            });
        });
    });

// Helper function for Driver Wallet & Earnings Summary
async function getDriverWalletSummary(userId) {
    const userRes = await pool.query("SELECT is_payment_on_hold, rating, bankaccountname, bankaccountnumber, bankifsc, bankname, upi_id, bankverified FROM users WHERE id = $1", [userId]);
    const user = userRes.rows[0];
    const hold = user ? (user.is_payment_on_hold || 0) : 0;
    const rating = user ? (user.rating || 5.0) : 5.0;

    const incRes = await pool.query("SELECT id, amount, type, status, createdat, tripid FROM incentives WHERE userid = $1 ORDER BY createdat DESC", [userId]);
    const rows = incRes.rows || [];

    const wdrRes = await pool.query("SELECT id, amount, payout_method, status, utr_number, rejection_reason, created_at, processed_at FROM withdrawal_requests WHERE driver_id = $1 ORDER BY created_at DESC", [userId]);
    const wdrRows = wdrRes.rows || [];

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    
    let todayEarnings = 0;
    let weekEarnings = 0;
    let monthEarnings = 0;
    let grossEarnings = 0;

    rows.forEach(r => {
        const amt = parseFloat(r.amount || 0);
        const date = new Date(r.createdat).getTime();

        if (amt > 0) {
            grossEarnings += amt;
            if (date >= startOfDay) {
                todayEarnings += amt;
            }
            const oneWeekAgo = now.getTime() - (7 * 24 * 60 * 60 * 1000);
            if (date >= oneWeekAgo) {
                weekEarnings += amt;
            }
            const oneMonthAgo = now.getTime() - (30 * 24 * 60 * 60 * 1000);
            if (date >= oneMonthAgo) {
                monthEarnings += amt;
            }
        }
    });

    // Compute total completed withdrawals and pending requested withdrawals
    let totalWithdrawn = 0;
    let pendingWithdrawals = 0;
    wdrRows.forEach(w => {
        const wAmt = parseFloat(w.amount || 0);
        if (w.status === 'completed') {
            totalWithdrawn += wAmt;
        } else if (w.status === 'requested') {
            pendingWithdrawals += wAmt;
        }
    });

    const withdrawableBalance = Math.max(0, Math.round((grossEarnings - totalWithdrawn - pendingWithdrawals) * 100) / 100);

    const tripCountRes = await pool.query(
        "SELECT COUNT(DISTINCT tripid) as count FROM incentives WHERE userid = $1 AND type LIKE 'trip_bonus%' AND createdat >= TO_TIMESTAMP($2 / 1000.0)",
        [userId, startOfDay]
    );
    const todayTrips = parseInt(tripCountRes.rows[0]?.count || 0);

    // Build unified recent transactions list
    const incentiveTx = rows.slice(0, 15).map(r => ({
        id: r.id,
        tripId: r.tripid,
        amount: parseFloat(r.amount || 0),
        type: r.type,
        status: r.status,
        date: r.createdat
    }));

    const withdrawalTx = wdrRows.slice(0, 10).map(w => ({
        id: w.id,
        amount: parseFloat(w.amount || 0),
        type: 'withdrawal',
        status: w.status,
        utrNumber: w.utr_number,
        rejectionReason: w.rejection_reason,
        date: w.created_at
    }));

    const combinedTransactions = [...incentiveTx, ...withdrawalTx]
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, 20);

    return {
        todayEarnings: Math.round(todayEarnings),
        weekEarnings: Math.round(weekEarnings),
        monthEarnings: Math.round(monthEarnings),
        overallEarnings: Math.round(grossEarnings),
        totalGrossEarned: Math.round(grossEarnings),
        totalWithdrawn: Math.round(totalWithdrawn),
        pendingWithdrawals: Math.round(pendingWithdrawals),
        withdrawableBalance: Math.round(withdrawableBalance),
        minimumWithdrawal: 100,
        todayTrips: todayTrips,
        is_payment_on_hold: hold,
        rating: parseFloat(rating.toFixed(2)),
        bankDetails: {
            accountHolderName: user?.bankaccountname || '',
            accountNumber: user?.bankaccountnumber || '',
            bankName: user?.bankname || '',
            ifsc: user?.bankifsc || '',
            upiId: user?.upi_id || '',
            isConfigured: !!(user?.bankaccountnumber && user?.bankifsc)
        },
        recentTransactions: combinedTransactions
    };
}

// GET earnings statistics for a marshal/driver
apiRouter.get('/users/:id/earnings', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin' && req.user.id !== req.params.id) {
        return res.status(403).json({ error: 'Forbidden: You do not have permission to access earnings for this user.' });
    }
    try {
        const data = await getDriverWalletSummary(req.params.id);
        res.json(data);
    } catch (err) {
        console.error('Earnings fetch error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET wallet statistics for a marshal/driver
apiRouter.get('/users/:id/wallet', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin' && req.user.id !== req.params.id) {
        return res.status(403).json({ error: 'Forbidden: You do not have permission to access wallet for this user.' });
    }
    try {
        const data = await getDriverWalletSummary(req.params.id);
        res.json(data);
    } catch (err) {
        console.error('Wallet fetch error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST request withdrawal (Driver initiates withdrawal request)
apiRouter.post('/users/:id/withdrawals', async (req, res) => {
    const userId = req.params.id;
    const { amount, payoutMethod } = req.body;
    const withdrawAmount = parseFloat(amount);
    
    if (isNaN(withdrawAmount) || withdrawAmount < 100) {
        return res.status(400).json({ error: 'Minimum withdrawal amount is ₹100' });
    }
    
    try {
        const userRes = await pool.query("SELECT is_payment_on_hold, bankaccountname, bankaccountnumber, bankifsc, bankname, upi_id FROM users WHERE id = $1", [userId]);
        const user = userRes.rows[0];
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        if (user.is_payment_on_hold === 1) {
            return res.status(400).json({ error: 'Withdrawal failed. Your payouts are currently on hold due to a pending dispute.' });
        }

        if (!user.bankaccountnumber && !user.upi_id) {
            return res.status(400).json({ error: 'Please save your bank account or UPI details before requesting a withdrawal.' });
        }
        
        // Calculate live available balance
        const incRes = await pool.query("SELECT SUM(amount) as gross FROM incentives WHERE userid = $1 AND amount > 0", [userId]);
        const gross = parseFloat(incRes.rows[0]?.gross || 0);

        const wdrRes = await pool.query("SELECT status, SUM(amount) as total FROM withdrawal_requests WHERE driver_id = $1 GROUP BY status", [userId]);
        let completed = 0;
        let pending = 0;
        (wdrRes.rows || []).forEach(r => {
            if (r.status === 'completed') completed += parseFloat(r.total || 0);
            if (r.status === 'requested') pending += parseFloat(r.total || 0);
        });

        const availableBalance = Math.max(0, gross - completed - pending);
        
        if (availableBalance < withdrawAmount) {
            return res.status(400).json({ error: `Insufficient available balance. Your withdrawable balance is ₹${Math.floor(availableBalance)}.` });
        }
        
        const withdrawalId = `wdr_${Date.now()}`;
        const method = payoutMethod || (user.bankaccountnumber ? 'bank_transfer' : 'upi');

        // Insert into PostgreSQL
        await pool.query(`
            INSERT INTO withdrawal_requests (
                id, driver_id, amount, payout_method, 
                account_holder_name, account_number, bank_name, ifsc_code, upi_id, 
                status, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'requested', NOW(), NOW())
        `, [
            withdrawalId, userId, withdrawAmount, method,
            user.bankaccountname || '', user.bankaccountnumber || '', user.bankname || '', user.bankifsc || '', user.upi_id || ''
        ]);

        // Mirror to SQLite
        db.run(`
            INSERT INTO withdrawal_requests (
                id, driver_id, amount, payout_method, 
                account_holder_name, account_number, bank_name, ifsc_code, upi_id, 
                status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [
            withdrawalId, userId, withdrawAmount, method,
            user.bankaccountname || '', user.bankaccountnumber || '', user.bankname || '', user.bankifsc || '', user.upi_id || ''
        ], (errDb) => {
            if (errDb) console.error("SQLite withdrawal_requests insert error:", errDb.message);
        });
        
        const newAvailableBalance = Math.max(0, availableBalance - withdrawAmount);
        res.json({ 
            success: true, 
            message: 'Withdrawal request submitted successfully! Admin will process your payout.',
            requestId: withdrawalId,
            withdrawableBalance: Math.round(newAvailableBalance)
        });
    } catch (err) {
        console.error('Withdrawal request error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET admin withdrawal requests queue
apiRouter.get('/admin/withdrawals', authMiddleware, requireRole('admin'), async (req, res) => {
    const statusFilter = req.query.status;
    try {
        let query = `
            SELECT w.*, u.name as driver_name, u.phone as driver_phone, u.role as driver_type, u.rating as driver_rating
            FROM withdrawal_requests w
            LEFT JOIN users u ON w.driver_id = u.id
        `;
        let params = [];
        if (statusFilter && statusFilter !== 'all') {
            query += ` WHERE w.status = $1`;
            params.push(statusFilter);
        }
        query += ` ORDER BY w.created_at DESC`;

        const result = await pool.query(query, params);
        res.json(result.rows || []);
    } catch (err) {
        console.error('Admin withdrawals fetch error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET admin executive financials summary (Revenue, Driver Payouts, Net Profit, Order Counts)
apiRouter.get('/admin/executive-financials', authMiddleware, requireRole('admin'), async (req, res) => {
    const { range, startDate, endDate, businessLine } = req.query;
    const bLine = (businessLine || 'all').toLowerCase();
    
    try {
        const now = new Date();
        const istOffset = 5.5 * 60 * 60 * 1000;
        const istNow = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + istOffset);
        
        let startUtc, endUtc;
        endUtc = new Date(now.getTime() + 60000);

        if (range === 'today') {
            const istStart = new Date(istNow.getFullYear(), istNow.getMonth(), istNow.getDate(), 0, 0, 0, 0);
            startUtc = new Date(istStart.getTime() - istOffset);
        } else if (range === 'week') {
            const day = istNow.getDay();
            const diff = (day === 0 ? 6 : day - 1);
            const istStart = new Date(istNow.getFullYear(), istNow.getMonth(), istNow.getDate() - diff, 0, 0, 0, 0);
            startUtc = new Date(istStart.getTime() - istOffset);
        } else if (range === 'month') {
            const istStart = new Date(istNow.getFullYear(), istNow.getMonth(), 1, 0, 0, 0, 0);
            startUtc = new Date(istStart.getTime() - istOffset);
        } else if (range === 'year') {
            const istStart = new Date(istNow.getFullYear(), 0, 1, 0, 0, 0, 0);
            startUtc = new Date(istStart.getTime() - istOffset);
        } else if (range === 'custom' && startDate) {
            startUtc = new Date(startDate + 'T00:00:00+05:30');
            if (endDate) {
                endUtc = new Date(endDate + 'T23:59:59.999+05:30');
            }
        } else {
            const istStart = new Date(istNow.getFullYear(), istNow.getMonth(), 1, 0, 0, 0, 0);
            startUtc = new Date(istStart.getTime() - istOffset);
        }

        const startEpoch = startUtc.getTime();
        const endEpoch = endUtc.getTime();

        let row = { completed_count: 0, total_attempts: 0, gross_revenue: 0, total_payout: 0 };

        if (bLine === 'rentals') {
            const rQuery = `
                WITH completed_rentals AS (
                    SELECT 
                        rb.id,
                        rb.totalamount,
                        rb.vehiclerentalamount,
                        rb.driverfeeamount
                    FROM rental_bookings rb
                    WHERE rb.status IN ('completed', 'closed')
                      AND rb.createdat >= $1 AND rb.createdat <= $2
                ),
                all_rentals AS (
                    SELECT COUNT(rb.id)::int AS total_attempts
                    FROM rental_bookings rb
                    WHERE rb.createdat >= $1 AND rb.createdat <= $2
                )
                SELECT 
                    COUNT(cr.id)::int AS completed_count,
                    COALESCE((SELECT total_attempts FROM all_rentals), 0)::int AS total_attempts,
                    COALESCE(SUM(cr.totalamount), 0)::float AS gross_revenue,
                    COALESCE(SUM(COALESCE(cr.vehiclerentalamount * 0.8, 0) + COALESCE(cr.driverfeeamount, 0)), 0)::float AS total_payout
                FROM completed_rentals cr
            `;
            const rRes = await pool.query(rQuery, [startUtc.toISOString(), endUtc.toISOString()]);
            row = rRes.rows[0] || row;
        } else if (bLine === 'garage') {
            const gQuery = `
                WITH completed_sr AS (
                    SELECT 
                        sr.id AS sr_id,
                        sr.totalcustomerprice,
                        sr.parts_cost,
                        sr.labor_cost,
                        sr.inspection_fee
                    FROM service_requests sr
                    WHERE sr.status IN ('completed', 'drop_completed', 'work_completed')
                      AND (sr.booking_flow = 'garage' OR sr.garageid IS NOT NULL)
                      AND sr.created_at >= $1 AND sr.created_at <= $2
                ),
                all_sr AS (
                    SELECT COUNT(sr.id)::int AS total_attempts
                    FROM service_requests sr
                    WHERE (sr.booking_flow = 'garage' OR sr.garageid IS NOT NULL)
                      AND sr.created_at >= $1 AND sr.created_at <= $2
                ),
                sr_payments AS (
                    SELECT 
                        service_request_id,
                        SUM(amount_paid) AS total_paid
                    FROM ride_payments
                    WHERE status IN ('captured', 'completed', 'paid')
                    GROUP BY service_request_id
                )
                SELECT 
                    COUNT(csr.sr_id)::int AS completed_count,
                    COALESCE((SELECT total_attempts FROM all_sr), 0)::int AS total_attempts,
                    COALESCE(SUM(
                        COALESCE(
                            sp.total_paid,
                            csr.totalcustomerprice,
                            (COALESCE(csr.parts_cost, 0) + COALESCE(csr.labor_cost, 0) + COALESCE(csr.inspection_fee, 0))
                        )
                    ), 0)::float AS gross_revenue,
                    COALESCE(SUM(COALESCE(csr.parts_cost, 0) + COALESCE(csr.labor_cost, 0)), 0)::float AS total_payout
                FROM completed_sr csr
                LEFT JOIN sr_payments sp ON csr.sr_id = sp.service_request_id
            `;
            const gRes = await pool.query(gQuery, [startEpoch, endEpoch]);
            row = gRes.rows[0] || row;
        } else {
            // Drivers (p2p) or All Combined
            let tripsFilter = `t.status = 'completed' AND t.createdat >= $1 AND t.createdat <= $2`;
            let attemptsFilter = `sr.created_at >= $3 AND sr.created_at <= $4`;

            if (bLine === 'drivers') {
                tripsFilter += ` AND (sr.booking_flow = 'p2p' OR (sr.booking_flow IS NULL AND sr.garageid IS NULL))`;
                attemptsFilter += ` AND (sr.booking_flow = 'p2p' OR (sr.booking_flow IS NULL AND sr.garageid IS NULL))`;
            }

            const p2pQuery = `
                WITH completed_trips AS (
                    SELECT 
                        t.id AS trip_id,
                        t.servicerequestid,
                        t.marshalid,
                        t.createdat AS trip_created_at,
                        sr.totalcustomerprice,
                        sr.baseamount,
                        sr.extraamount
                    FROM trips t
                    JOIN service_requests sr ON t.servicerequestid = sr.id
                    WHERE ${tripsFilter}
                ),
                all_sr_attempts AS (
                    SELECT COUNT(sr.id)::int AS total_attempts
                    FROM service_requests sr
                    WHERE ${attemptsFilter}
                ),
                trip_payments AS (
                    SELECT 
                        service_request_id,
                        SUM(amount_paid) AS total_paid
                    FROM ride_payments
                    WHERE status IN ('captured', 'completed', 'paid')
                    GROUP BY service_request_id
                ),
                trip_incentives AS (
                    SELECT 
                        tripid,
                        SUM(amount) AS total_driver_payout
                    FROM incentives
                    WHERE type != 'withdrawal'
                    GROUP BY tripid
                )
                SELECT 
                    COUNT(ct.trip_id)::int AS completed_count,
                    COALESCE((SELECT total_attempts FROM all_sr_attempts), 0)::int AS total_attempts,
                    COALESCE(SUM(
                        COALESCE(
                            tp.total_paid,
                            ct.totalcustomerprice,
                            (COALESCE(ct.baseamount, 0) + COALESCE(ct.extraamount, 0) + 99)
                        )
                    ), 0)::float AS gross_revenue,
                    COALESCE(SUM(COALESCE(ti.total_driver_payout, 0)), 0)::float AS total_payout
                FROM completed_trips ct
                LEFT JOIN trip_payments tp ON ct.servicerequestid = tp.service_request_id
                LEFT JOIN trip_incentives ti ON ct.trip_id = ti.tripid
            `;
            const pRes = await pool.query(p2pQuery, [startUtc.toISOString(), endUtc.toISOString(), startEpoch, endEpoch]);
            row = pRes.rows[0] || row;
        }

        const completedCount = parseInt(row.completed_count) || 0;
        const totalAttempts = parseInt(row.total_attempts) || 0;
        const completionRate = totalAttempts > 0 
            ? Math.round(((completedCount / totalAttempts) * 100) * 10) / 10 
            : (completedCount > 0 ? 100.0 : 100.0);

        const revenue = Math.round((parseFloat(row.gross_revenue) || 0) * 100) / 100;
        const payout = Math.round((parseFloat(row.total_payout) || 0) * 100) / 100;
        const netProfit = Math.round((revenue - payout) * 100) / 100;
        const marginPercent = revenue > 0 ? Math.round(((netProfit / revenue) * 100) * 10) / 10 : 0.0;
        const avgPayoutPerOrder = completedCount > 0 ? Math.round((payout / completedCount) * 100) / 100 : 0.0;

        res.json({
            businessLine: bLine,
            range: range || 'month',
            startDate: startUtc.toISOString(),
            endDate: endUtc.toISOString(),
            completedCount,
            totalAttempts,
            completionRate,
            revenue,
            payout,
            netProfit,
            marginPercent,
            avgPayoutPerOrder
        });
    } catch (err) {
        console.error('Executive financials fetch error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST admin complete withdrawal (Mark Paid with UTR)
apiRouter.post('/admin/withdrawals/:id/complete', authMiddleware, requireRole('admin'), async (req, res) => {
    const withdrawalId = req.params.id;
    const { utrNumber, adminNotes, processedBy } = req.body;

    if (!utrNumber || String(utrNumber).trim() === '') {
        return res.status(400).json({ error: 'Bank Transaction / UTR Number is mandatory to mark payout complete.' });
    }

    try {
        const wRes = await pool.query("SELECT * FROM withdrawal_requests WHERE id = $1", [withdrawalId]);
        const wdr = wRes.rows[0];
        if (!wdr) {
            return res.status(404).json({ error: 'Withdrawal request not found' });
        }
        if (wdr.status === 'completed') {
            return res.status(400).json({ error: 'This withdrawal has already been completed.' });
        }

        await pool.query(`
            UPDATE withdrawal_requests 
            SET status = 'completed', utr_number = $1, admin_notes = $2, processed_by = $3, processed_at = NOW(), updated_at = NOW()
            WHERE id = $4
        `, [utrNumber.trim(), adminNotes || null, processedBy || 'admin', withdrawalId]);

        db.run(`
            UPDATE withdrawal_requests 
            SET status = 'completed', utr_number = ?, admin_notes = ?, processed_by = ?, processed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [utrNumber.trim(), adminNotes || null, processedBy || 'admin', withdrawalId]);

        res.json({ success: true, message: 'Withdrawal payout marked completed successfully.' });
    } catch (err) {
        console.error('Admin complete withdrawal error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST admin reject withdrawal (with reason)
apiRouter.post('/admin/withdrawals/:id/reject', authMiddleware, requireRole('admin'), async (req, res) => {
    const withdrawalId = req.params.id;
    const { reason, adminNotes, processedBy } = req.body;

    if (!reason || String(reason).trim() === '') {
        return res.status(400).json({ error: 'Rejection reason is required.' });
    }

    try {
        const wRes = await pool.query("SELECT * FROM withdrawal_requests WHERE id = $1", [withdrawalId]);
        const wdr = wRes.rows[0];
        if (!wdr) {
            return res.status(404).json({ error: 'Withdrawal request not found' });
        }
        if (wdr.status === 'completed') {
            return res.status(400).json({ error: 'Cannot reject a withdrawal that has already been completed.' });
        }

        await pool.query(`
            UPDATE withdrawal_requests 
            SET status = 'rejected', rejection_reason = $1, admin_notes = $2, processed_by = $3, processed_at = NOW(), updated_at = NOW()
            WHERE id = $4
        `, [reason.trim(), adminNotes || null, processedBy || 'admin', withdrawalId]);

        db.run(`
            UPDATE withdrawal_requests 
            SET status = 'rejected', rejection_reason = ?, admin_notes = ?, processed_by = ?, processed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [reason.trim(), adminNotes || null, processedBy || 'admin', withdrawalId]);

        res.json({ success: true, message: 'Withdrawal request rejected. Funds restored to driver available balance.' });
    } catch (err) {
        console.error('Admin reject withdrawal error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST submit rating for a trip
apiRouter.post('/trips/:id/rate', async (req, res) => {
    const { rating } = req.body;
    const tripId = req.params.id;
    if (rating === undefined || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Valid rating (1-5) is required' });
    }
    try {
        await pool.query("UPDATE trips SET rating = $1 WHERE id = $2", [rating, tripId]);
        
        const tripRes = await pool.query("SELECT marshalid, serviceRequestId FROM trips WHERE id = $1", [tripId]);
        const trip = tripRes.rows[0];
        if (trip) {
            const marshalId = trip.marshalid;
            const avgRes = await pool.query("SELECT AVG(rating) as avg_rating FROM trips WHERE marshalid = $1 AND rating IS NOT NULL", [marshalId]);
            const newAvg = parseFloat(avgRes.rows[0].avg_rating || 5.0);
            
            await pool.query("UPDATE users SET rating = $1 WHERE id = $2", [newAvg, marshalId]);
            await pool.query("UPDATE garage_workers SET rating = $1 WHERE id = $2", [newAvg, marshalId]).catch(() => {});
            
            if (rating === 5) {
                const reqRes = await pool.query("SELECT totalcustomerprice FROM service_requests WHERE id = $1", [trip.servicerequestid]);
                const ticketSize = reqRes.rows[0] ? parseFloat(reqRes.rows[0].totalcustomerprice || 0) : 0;
                
                const bonusSetting = await pool.query("SELECT value FROM system_settings WHERE key = 'bonus_5_star_percentage'");
                const bonusPercent = bonusSetting.rows[0] ? parseFloat(bonusSetting.rows[0].value || 5.0) : 5.0;
                
                const bonusAmount = ticketSize * (bonusPercent / 100);
                if (bonusAmount > 0) {
                    const bonusId = `bonus_${Date.now()}`;
                    await pool.query(
                        "INSERT INTO incentives (id, userid, tripid, amount, type, status) VALUES ($1, $2, $3, $4, '5_star_bonus', 'pending')",
                        [bonusId, marshalId, tripId, bonusAmount]
                    );
                }
            }
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Rating submission error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST file a dispute
apiRouter.post('/disputes', async (req, res) => {
    const { tripId, customerId, marshalId, reason } = req.body;
    if (!tripId || !reason) {
        return res.status(400).json({ error: 'Trip ID and reason are required' });
    }
    try {
        const id = `disp_${Date.now()}`;
        await pool.query(
            "INSERT INTO disputes (id, tripId, customerId, marshalId, reason, status) VALUES ($1, $2, $3, $4, $5, 'pending')",
            [id, tripId, customerId || null, marshalId || null, reason]
        );
        
        if (marshalId) {
            await pool.query("UPDATE users SET is_payment_on_hold = 1 WHERE id = $1", [marshalId]);
            await pool.query("UPDATE garage_workers SET is_payment_on_hold = 1 WHERE id = $1", [marshalId]).catch(() => {});
        }
        
        res.json({ success: true, disputeId: id });
    } catch (err) {
        console.error('Dispute creation error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET all disputes
apiRouter.get('/disputes', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
        const disputes = await pool.query(`
            SELECT disputes.*,
                   sr.pickup_address, sr.drop_address,
                   v.makeModel as vehicle_model, v.plate as vehicle_plate,
                   u.name as marshal_name, u.phone as marshal_phone,
                   c.name as customer_name
            FROM disputes
            LEFT JOIN trips t ON disputes.tripId = t.id
            LEFT JOIN service_requests sr ON t.serviceRequestId = sr.id
            LEFT JOIN vehicles v ON sr.vehicleId = v.id
            LEFT JOIN users u ON disputes.marshalId = u.id
            LEFT JOIN customers c ON disputes.customerId = c.id
            ORDER BY disputes.createdAt DESC
        `);
        res.json(disputes.rows || []);
    } catch (err) {
        console.error('Disputes fetch error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST resolve a dispute
apiRouter.post('/disputes/:id/resolve', authMiddleware, requireRole('admin'), async (req, res) => {
    const disputeId = req.params.id;
    const { action, deductionAmount, resolutionNote } = req.body;
    
    const allowedActions = ['dismissed', 'penalized', 'acknowledged', 'waived', 'resolved_extension', 'resolved_paid_at_checkout'];
    if (!action || !allowedActions.includes(action)) {
        return res.status(400).json({ error: `Action must be one of: ${allowedActions.join(', ')}` });
    }
    
    try {
        const dispRes = await pool.query("SELECT * FROM disputes WHERE id = $1", [disputeId]);
        const dispute = dispRes.rows[0];
        if (!dispute) {
            return res.status(404).json({ error: 'Dispute not found' });
        }
        
        const marshalId = dispute.marshalid || dispute.marshalId;
        const tripId = dispute.tripid || dispute.tripId;
        const finalDeduction = action === 'penalized' ? parseFloat(deductionAmount || 0) : 0;
        const note = resolutionNote || dispute.resolution_note || `Resolved as ${action.toUpperCase()}`;
        
        await pool.query(
            "UPDATE disputes SET status = $1, deductionAmount = $2, resolution_note = $3 WHERE id = $4",
            [action, finalDeduction, note, disputeId]
        );
        
        if (marshalId) {
            await pool.query("UPDATE users SET is_payment_on_hold = 0 WHERE id = $1", [marshalId]);
            await pool.query("UPDATE garage_workers SET is_payment_on_hold = 0 WHERE id = $1", [marshalId]).catch(() => {});
            
            if (action === 'penalized' && finalDeduction > 0) {
                const penaltyId = `pen_${Date.now()}`;
                await pool.query(
                    "INSERT INTO incentives (id, userid, tripid, amount, type, status) VALUES ($1, $2, $3, $4, 'penalty', 'completed')",
                    [penaltyId, marshalId, tripId, -finalDeduction]
                );
            }
        }
        
        res.json({ success: true, status: action, resolutionNote: note });
    } catch (err) {
        console.error('Dispute resolution error:', err.message);
        res.status(500).json({ error: err.message });
    }
});


// --- HEALTH CHECK ---
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        const uploadsPath = path.join(__dirname, 'uploads');
        let uploadsExists = false;
        let uploadsWritable = false;
        try {
            uploadsExists = fs.existsSync(uploadsPath);
            fs.accessSync(uploadsPath, fs.constants.W_OK);
            uploadsWritable = true;
        } catch (errAccess) {}

        res.json({
            status: 'ok',
            db: 'connected',
            env: process.env.NODE_ENV || 'development',
            uptime: Math.floor(process.uptime()),
            dirname: __dirname,
            cwd: process.cwd(),
            uploadsDir: uploadsPath,
            uploadsExists,
            uploadsWritable
        });
    } catch (e) {
        res.status(500).json({ status: 'error', db: 'disconnected', message: e.message });
    }
});

// --- ANALYTICS INGESTION ---
app.post('/api/analytics', (req, res) => {
    const { app: appName, event, properties, userId, sessionId } = req.body;
    if (!event || !appName) return res.json({ ok: false });
    pool.query(
        `INSERT INTO analytics_events (app, event, properties, userid, sessionid)
         VALUES ($1, $2, $3, $4, $5)`,
        [appName, event, JSON.stringify(properties || {}), userId || null, sessionId || null]
    ).catch(e => console.error("Analytics log error:", e.message)); // catch and log, never block
    res.json({ ok: true });
});

// --- APPLY RATE LIMITERS TO SPECIFIC AUTH ROUTES ---
app.use('/api/auth/login', loginLimiter);
app.use('/api/upload-kyc', uploadLimiter);

// --- STATIC ROUTES ---

// ============================================================================
// INVESTOR ACCESS & TRACTION PLATFORM ENDPOINTS
// ============================================================================

const investorRequestLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10,
    message: { error: 'Too many access requests from this IP. Please try again in an hour.' }
});

/**
 * POST /api/investor-access/request
 * Public endpoint to submit a pending investor access request
 */
apiRouter.post('/investor-access/request', investorRequestLimiter, async (req, res) => {
    const { name, email, organization, note } = req.body;
    if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'Valid institutional email is required.' });
    }
    const cleanEmail = email.trim().toLowerCase();
    const cleanName = (name || '').trim();
    const cleanOrg = (organization || '').trim();
    const cleanNote = (note || '').trim();

    try {
        const id = 'inv_req_' + Date.now();
        await pool.query(`
            INSERT INTO investor_access_requests (id, name, email, organization, scheduling_link_or_note, status, requested_at)
            VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
            ON CONFLICT (id) DO NOTHING
        `, [id, cleanName, cleanEmail, cleanOrg, cleanNote]);

        res.json({
            success: true,
            message: 'Your access request has been submitted for administrative approval.',
            status: 'pending',
            id
        });
    } catch (err) {
        console.error('investor-access request error:', err.message);
        res.status(500).json({ error: 'Failed to record access request.' });
    }
});

/**
 * GET /api/admin/investor-requests
 * Admin endpoint to list all investor access requests
 */
apiRouter.get('/admin/investor-requests', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
        const { status } = req.query;
        let query = 'SELECT * FROM investor_access_requests';
        const params = [];
        if (status && status !== 'all') {
            query += ' WHERE status = $1';
            params.push(status);
        }
        query += ' ORDER BY requested_at DESC';
        const result = await pool.query(query, params);
        res.json({ success: true, requests: result.rows });
    } catch (err) {
        console.error('GET /admin/investor-requests error:', err.message);
        res.status(500).json({ error: 'Failed to fetch access requests.' });
    }
});

/**
 * PATCH /api/admin/investor-requests/:id
 * Admin mutation to approve or reject an access request
 */
apiRouter.patch('/admin/investor-requests/:id', authMiddleware, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const { status, rejectionReason } = req.body;
    if (!['approved', 'rejected', 'pending'].includes(status)) {
        return res.status(400).json({ error: 'Status must be approved, rejected, or pending.' });
    }

    try {
        const result = await pool.query(`
            UPDATE investor_access_requests
            SET status = $1,
                decided_at = NOW(),
                decided_by = $2,
                rejection_reason = $3,
                updated_at = NOW()
            WHERE id = $4
            RETURNING *
        `, [status, req.user.id, rejectionReason || null, id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Investor access request not found.' });
        }

        res.json({
            success: true,
            message: `Request marked as ${status}.`,
            request: result.rows[0]
        });
    } catch (err) {
        console.error('PATCH /admin/investor-requests/:id error:', err.message);
        res.status(500).json({ error: 'Failed to update access request.' });
    }
});

// ============================================================================
// GARAGE PARTNER APPLICATION ENDPOINTS
// ============================================================================

const garageApplicationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10,
    message: { error: 'Too many application submissions from this IP. Please try again in an hour.' }
});

/**
 * POST /api/garage-applications
 * Public lead-capture endpoint for garage partner applications
 */
apiRouter.post('/garage-applications', garageApplicationLimiter, async (req, res) => {
    const { garage_name, garageName, owner_name, ownerName, phone, city, pincode, service_bays, serviceBays, services_offered, servicesOffered } = req.body;
    
    const cleanGarageName = (garage_name || garageName || '').trim();
    const cleanOwnerName = (owner_name || ownerName || '').trim();
    const cleanPhone = (phone || '').trim();
    const cleanCity = (city || '').trim();
    const cleanPincode = (pincode || '').trim();
    const cleanServiceBays = (service_bays || serviceBays || '').trim();
    const cleanServicesOffered = (services_offered || servicesOffered || '').trim();

    if (!cleanGarageName) {
        return res.status(400).json({ error: 'Workshop / Garage name is required.' });
    }
    if (!cleanOwnerName) {
        return res.status(400).json({ error: 'Owner / Manager name is required.' });
    }
    if (!cleanPhone) {
        return res.status(400).json({ error: 'Contact phone number is required.' });
    }

    const phoneDigits = cleanPhone.replace(/\D/g, '');
    if (phoneDigits.length < 10) {
        return res.status(400).json({ error: 'A valid phone number with at least 10 digits is required.' });
    }

    try {
        const id = 'gar_app_' + Date.now();
        await pool.query(`
            INSERT INTO garage_applications (id, garage_name, owner_name, phone, city, pincode, service_bays, services_offered, status, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW(), NOW())
            ON CONFLICT (id) DO NOTHING
        `, [id, cleanGarageName, cleanOwnerName, cleanPhone, cleanCity, cleanPincode, cleanServiceBays, cleanServicesOffered]);

        // Mirror to SQLite if active
        db.run(`
            INSERT INTO garage_applications (id, garage_name, owner_name, phone, city, pincode, service_bays, services_offered, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [id, cleanGarageName, cleanOwnerName, cleanPhone, cleanCity, cleanPincode, cleanServiceBays, cleanServicesOffered], () => {});

        res.json({
            success: true,
            message: 'Your garage partnership application has been submitted successfully.',
            id
        });
    } catch (err) {
        console.error('garage-applications submit error:', err.message);
        res.status(500).json({ error: 'Failed to record garage partner application.' });
    }
});

/**
 * GET /api/admin/garage-applications
 * Admin endpoint to list all partner garage applications
 */
apiRouter.get('/admin/garage-applications', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
        const { status } = req.query;
        let query = 'SELECT * FROM garage_applications';
        const params = [];
        if (status && status !== 'all') {
            query += ' WHERE status = $1';
            params.push(status);
        }
        query += ' ORDER BY created_at DESC';
        const result = await pool.query(query, params);
        res.json({ success: true, applications: result.rows });
    } catch (err) {
        console.error('GET /admin/garage-applications error:', err.message);
        res.status(500).json({ error: 'Failed to fetch garage applications.' });
    }
});

/**
 * GET /api/traction/live-metrics
 * Protected live metrics query endpoint for approved investors and administrators
 */
apiRouter.get('/traction/live-metrics', authMiddleware, requireRole('investor', 'admin'), async (req, res) => {
    try {
        // 1. Executive Aggregates (Completed Bookings & GMV)
        const gmvRes = await pool.query(`
            SELECT 
                COUNT(*) as total_orders,
                COUNT(*) FILTER (WHERE status = 'completed') as completed_orders,
                COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled_orders,
                COALESCE(SUM(totalcustomerprice) FILTER (WHERE status = 'completed'), 0) as completed_gmv,
                COALESCE(SUM(marshal_commission) FILTER (WHERE status = 'completed'), 0) as driver_payouts
            FROM service_requests
            WHERE is_test = FALSE
        `);

        // 2. Subscription Revenue
        const subRes = await pool.query(`
            SELECT 
                COALESCE(SUM(amount), 0) as subscription_gmv,
                COUNT(*) FILTER (WHERE status IN ('active', 'captured', 'success')) as active_subscriptions
            FROM subscription_payments
            WHERE is_test = FALSE
        `);

        // 3. Vertical Breakdown
        const verticalRes = await pool.query(`
            SELECT 
                COALESCE(service_category, 'unspecified') as vertical,
                COUNT(*) as total_inquiries,
                COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
                COALESCE(SUM(totalcustomerprice) FILTER (WHERE status = 'completed'), 0) as gmv
            FROM service_requests
            WHERE is_test = FALSE
            GROUP BY service_category
        `);

        // 4. Active Supply Counts
        const supplyRes = await pool.query(`
            SELECT 
                (SELECT COUNT(*) FROM users WHERE role IN ('marshal', 'driver') AND status = 'active' AND is_test = FALSE) as onboarded_drivers,
                (SELECT COUNT(*) FROM users WHERE role IN ('marshal', 'driver') AND is_online = 1 AND is_test = FALSE) as online_drivers,
                (SELECT COUNT(*) FROM garages WHERE status = 'active' AND is_test = FALSE) as certified_garages
        `);

        // 5. Repeat Customer Rate
        const repeatRes = await pool.query(`
            WITH cust_completed AS (
                SELECT customerid, COUNT(*) as trip_count
                FROM service_requests
                WHERE status = 'completed' AND is_test = FALSE AND customerid IS NOT NULL
                GROUP BY customerid
            )
            SELECT 
                COUNT(*) as total_unique_customers,
                COUNT(*) FILTER (WHERE trip_count >= 2) as repeat_customers
            FROM cust_completed
        `);

        // 6. Geographic Distribution
        const geoRes = await pool.query(`
            SELECT 
                COALESCE(NULLIF(pincode, ''), 'Kolkata Metro') as location,
                COUNT(*) as total_orders,
                COALESCE(SUM(totalcustomerprice) FILTER (WHERE status = 'completed'), 0) as gmv
            FROM service_requests
            WHERE is_test = FALSE
            GROUP BY location
        `);

        const completedGmv = parseFloat(gmvRes.rows[0].completed_gmv || 0);
        const subGmv = parseFloat(subRes.rows[0].subscription_gmv || 0);
        const totalGmv = completedGmv + subGmv;
        const totalOrders = parseInt(gmvRes.rows[0].total_orders || 0, 10);
        const completedOrders = parseInt(gmvRes.rows[0].completed_orders || 0, 10);
        const cancelledOrders = parseInt(gmvRes.rows[0].cancelled_orders || 0, 10);
        const driverPayouts = parseFloat(gmvRes.rows[0].driver_payouts || 0);
        const netRevenue = totalGmv - driverPayouts;
        const takeRatePct = totalGmv > 0 ? ((netRevenue / totalGmv) * 100).toFixed(1) : '0.0';
        const completionRatePct = totalOrders > 0 ? ((completedOrders / totalOrders) * 100).toFixed(1) : 'N/A';
        const cancellationRatePct = totalOrders > 0 ? ((cancelledOrders / totalOrders) * 100).toFixed(1) : 'N/A';
        const totalCust = parseInt(repeatRes.rows[0]?.total_unique_customers || 0, 10);
        const repeatCust = parseInt(repeatRes.rows[0]?.repeat_customers || 0, 10);
        const repeatRatePct = totalCust > 0 ? ((repeatCust / totalCust) * 100).toFixed(1) : '0.0';

        res.json({
            success: true,
            asOf: new Date().toISOString(),
            metrics: {
                gmv: totalGmv,
                bookingGmv: completedGmv,
                subscriptionGmv: subGmv,
                netRevenue,
                takeRatePct,
                totalOrders,
                completedOrders,
                cancelledOrders,
                completionRatePct,
                cancellationRatePct,
                activeSubscriptions: parseInt(subRes.rows[0].active_subscriptions || 0, 10),
                onboardedDrivers: parseInt(supplyRes.rows[0].onboarded_drivers || 0, 10),
                onlineDrivers: parseInt(supplyRes.rows[0].online_drivers || 0, 10),
                certifiedGarages: parseInt(supplyRes.rows[0].certified_garages || 0, 10),
                uniqueCustomers: totalCust,
                repeatCustomers: repeatCust,
                repeatRatePct,
                verticals: verticalRes.rows,
                geoDistribution: geoRes.rows
            }
        });
    } catch (err) {
        console.error('Live metrics calculation error:', err.message);
        res.status(500).json({ error: 'Failed to compute live traction metrics.' });
    }
});


app.use('/api', apiRouter);

app.get('/uploads/:filename', async (req, res) => {
    const { exp, sig } = req.query;
    if (!exp || !sig) {
        return res.status(401).json({ error: 'Access denied: Authentication credentials missing.' });
    }

    const expNum = parseInt(exp, 10);
    if (isNaN(expNum) || Date.now() > expNum * 1000) {
        return res.status(401).json({ error: 'Access denied: Link has expired.' });
    }

    const filename = path.basename(req.params.filename);
    const stringToSign = `${filename}:${exp}`;
    const expectedSig = crypto.createHmac('sha256', FILE_SIGNING_SECRET).update(stringToSign).digest('hex');

    const sigBuffer = Buffer.from(String(sig), 'utf8');
    const expectedBuffer = Buffer.from(expectedSig, 'utf8');
    if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
        return res.status(403).json({ error: 'Access denied: Invalid signature.' });
    }

    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');

    // 1. Try Cloudflare R2 first
    if (isR2Configured()) {
        try {
            const r2Key = `uploads/${filename}`;
            const r2Obj = await getR2ObjectStream(r2Key);
            if (r2Obj && r2Obj.Body) {
                if (r2Obj.ContentType) res.setHeader('Content-Type', r2Obj.ContentType);
                if (r2Obj.ContentLength) res.setHeader('Content-Length', r2Obj.ContentLength);
                res.setHeader('Cache-Control', 'private, max-age=900');
                return r2Obj.Body.pipe(res);
            }
        } catch (r2Err) {
            // If not found in R2, proceed to local disk fallback
        }
    }

    // 2. Fallback to local disk if file exists
    const targetPath = path.join(activeUploadsDir, filename);
    if (fs.existsSync(targetPath)) {
        return res.sendFile(targetPath);
    }

    return res.status(404).json({ error: 'File not found.' });
});

// --- DOMAIN-SPECIFIC PATH ISOLATION (DEFENSE IN DEPTH) ---
// On customer domain (redrivo.com / redrivo.in), do NOT expose administrative portals or internal uploads
const RESTRICTED_PORTALS_ON_CUSTOMER_DOMAIN = [
    '/admin',
    '/crm',
    '/garage',
    '/redrivo-garage-portal',
    '/vroomly-garage-portal',
    '/marshal',
    '/vroomly-marshal-app',
    '/vroomly-customer-app',
    '/uploads'
];

// On garage domain (garages.redrivo.com / garage.redrivo.in), only expose garage portal and APIs
const RESTRICTED_PORTALS_ON_GARAGE_DOMAIN = [
    '/admin',
    '/crm',
    '/customer',
    '/vroomly-customer-app',
    '/marshal',
    '/vroomly-marshal-app',
    '/uploads'
];

// On driver domain (drivers.redrivo.com / drivers.redrivo.in), only expose driver app and APIs
const RESTRICTED_PORTALS_ON_DRIVER_DOMAIN = [
    '/admin',
    '/crm',
    '/customer',
    '/vroomly-customer-app',
    '/garage',
    '/redrivo-garage-portal',
    '/vroomly-garage-portal',
    '/uploads'
];

app.use((req, res, next) => {
    if (isCustomerDomain(req)) {
        const p = req.path.toLowerCase();
        for (const restricted of RESTRICTED_PORTALS_ON_CUSTOMER_DOMAIN) {
            if (p === restricted || p.startsWith(restricted + '/')) {
                return res.status(404).send('Not Found');
            }
        }
    }
    if (isGarageDomain(req)) {
        const p = req.path.toLowerCase();
        for (const restricted of RESTRICTED_PORTALS_ON_GARAGE_DOMAIN) {
            if (p === restricted || p.startsWith(restricted + '/')) {
                return res.status(404).send('Not Found');
            }
        }
    }
    if (isDriverDomain(req)) {
        const p = req.path.toLowerCase();
        for (const restricted of RESTRICTED_PORTALS_ON_DRIVER_DOMAIN) {
            if (p === restricted || p.startsWith(restricted + '/')) {
                return res.status(404).send('Not Found');
            }
        }
    }
    next();
});

// Clean canonical redirects:
// /customer on customer domain -> /
// /garage on garage domain -> /
// /marshal on driver domain -> /
app.use((req, res, next) => {
    if (isCustomerDomain(req)) {
        if (req.path === '/customer' || req.path === '/customer/') {
            return res.redirect(301, '/');
        }
        if (req.path.startsWith('/customer/')) {
            const target = req.path.replace(/^\/customer/, '') || '/';
            return res.redirect(301, target);
        }
    }
    if (isGarageDomain(req)) {
        if (req.path === '/garage' || req.path === '/garage/' || 
            req.path === '/garages' || req.path === '/garages/' ||
            req.path === '/redrivo-garage-portal' || req.path === '/redrivo-garage-portal/' ||
            req.path === '/vroomly-garage-portal' || req.path === '/vroomly-garage-portal/') {
            return res.redirect(301, '/');
        }
        if (req.path.startsWith('/garage/')) {
            const target = req.path.replace(/^\/garage/, '') || '/';
            return res.redirect(301, target);
        }
        if (req.path.startsWith('/garages/')) {
            const target = req.path.replace(/^\/garages/, '') || '/';
            return res.redirect(301, target);
        }
    }
    if (isDriverDomain(req)) {
        if (req.path === '/marshal' || req.path === '/marshal/' ||
            req.path === '/driver' || req.path === '/driver/' ||
            req.path === '/drivers' || req.path === '/drivers/' ||
            req.path === '/vroomly-marshal-app' || req.path === '/vroomly-marshal-app/') {
            return res.redirect(301, '/');
        }
        if (req.path.startsWith('/marshal/')) {
            const target = req.path.replace(/^\/marshal/, '') || '/';
            return res.redirect(301, target);
        }
        if (req.path.startsWith('/driver/')) {
            const target = req.path.replace(/^\/driver/, '') || '/';
            return res.redirect(301, target);
        }
        if (req.path.startsWith('/drivers/')) {
            const target = req.path.replace(/^\/drivers/, '') || '/';
            return res.redirect(301, target);
        }
    }
    next();
});

// Customer Web App Static Serving (at root on customer domain)
const customerStatic = express.static(path.join(__dirname, 'public/customer'));
// Garage Partner Portal Static Serving (at root on garage domain)
const garageStatic = express.static(path.join(__dirname, 'public/garage'));
// Driver App Static Serving (at root on driver domain)
const driverStatic = express.static(path.join(__dirname, 'public/marshal'));

app.use((req, res, next) => {
    if (isCustomerDomain(req) && !req.path.startsWith('/api')) {
        return customerStatic(req, res, next);
    }
    if (isGarageDomain(req) && !req.path.startsWith('/api')) {
        return garageStatic(req, res, next);
    }
    if (isDriverDomain(req) && !req.path.startsWith('/api')) {
        return driverStatic(req, res, next);
    }
    next();
});

// --- DYNAMIC PORTAL HTML HANDLER (AUTOMATED CONTENT-HASH CACHE-BUSTING & ZERO-STALE DEPLOYMENTS) ---
const portalAssetHashCache = new Map();

function getAssetContentHash(diskPath) {
    try {
        if (!fs.existsSync(diskPath)) return null;
        const stat = fs.statSync(diskPath);
        const cacheKey = `${diskPath}_${stat.mtimeMs}_${stat.size}`;
        if (portalAssetHashCache.has(cacheKey)) {
            return portalAssetHashCache.get(cacheKey);
        }
        const content = fs.readFileSync(diskPath);
        const hash = crypto.createHash('md5').update(content).digest('hex').slice(0, 10);
        portalAssetHashCache.set(cacheKey, hash);
        return hash;
    } catch (_) {
        return null;
    }
}

function servePortalHtml(portalFolder, req, res) {
    try {
        const portalDir = path.join(__dirname, 'public', portalFolder);
        const indexPath = path.join(portalDir, 'index.html');
        if (!fs.existsSync(indexPath)) {
            return res.status(404).send('Portal index not found');
        }

        let html = fs.readFileSync(indexPath, 'utf8');

        // Dynamically replace relative script / stylesheet references with live content hashes
        html = html.replace(/(?:src|href)=["'](\.?\/?(?:js\/|css\/)?([a-zA-Z0-9_\-]+\.(?:js|css)))(\?v=[^"']*)?["']/g, (match, fullRelPath, filename) => {
            const attr = match.startsWith('src') ? 'src' : 'href';
            const cleanRelPath = fullRelPath.replace(/^\.?\//, '');
            const diskPath = path.join(portalDir, cleanRelPath);
            const version = getAssetContentHash(diskPath) || Math.floor(Date.now() / 1000);
            return `${attr}="${fullRelPath.split('?')[0]}?v=${version}"`;
        });

        // Set strict no-cache headers on the HTML document itself
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Content-Type', 'text/html; charset=UTF-8');
        return res.send(html);
    } catch (err) {
        console.error(`[PORTAL_HTML_ERR] Failed to serve ${portalFolder} HTML:`, err);
        return res.status(500).send('Error rendering portal');
    }
}

app.use('/uploads', (req, res) => {
    res.status(401).json({ error: 'Access denied: Invalid or unauthenticated request.' });
});

// Dynamic Portal HTML Entrypoints (Intercepts index.html and root requests with live mtime cache busters)
// 1. CRM Portal (api.redrivo.in/crm and /admin)
app.get(['/crm', '/crm/', '/crm/index.html', '/admin', '/admin/', '/admin/index.html'], (req, res) => servePortalHtml('crm', req, res));

// 2. Customer Portal (api.redrivo.in/customer and aliases)
app.get(['/customer', '/customer/', '/customer/index.html', '/vroomly-customer-app', '/vroomly-customer-app/', '/vroomly-customer-app/index.html'], (req, res) => servePortalHtml('customer', req, res));

// 3. Garage Partner Portal (api.redrivo.in/garage and aliases)
app.get(['/garage', '/garage/', '/garage/index.html', '/garages', '/garages/', '/garages/index.html', '/redrivo-garage-portal', '/redrivo-garage-portal/', '/redrivo-garage-portal/index.html', '/vroomly-garage-portal', '/vroomly-garage-portal/', '/vroomly-garage-portal/index.html'], (req, res) => servePortalHtml('garage', req, res));

// 4. Marshal / Driver App (api.redrivo.in/marshal and aliases)
app.get(['/marshal', '/marshal/', '/marshal/index.html', '/drivers', '/drivers/', '/drivers/index.html', '/vroomly-marshal-app', '/vroomly-marshal-app/', '/vroomly-marshal-app/index.html'], (req, res) => servePortalHtml('marshal', req, res));

// Static Asset Serving (Images, Fonts, Media, JS/CSS bundles)
app.use('/garage', express.static(path.join(__dirname, 'public/garage')));
app.use('/redrivo-garage-portal', express.static(path.join(__dirname, 'public/garage')));
app.use('/vroomly-garage-portal', express.static(path.join(__dirname, 'public/garage')));

app.use('/customer', express.static(path.join(__dirname, 'public/customer')));
app.use('/vroomly-customer-app', express.static(path.join(__dirname, 'public/customer')));

app.use('/marshal', express.static(path.join(__dirname, 'public/marshal')));
app.use('/vroomly-marshal-app', express.static(path.join(__dirname, 'public/marshal')));

app.use('/crm', express.static(path.join(__dirname, 'public/crm')));
app.use('/admin', express.static(path.join(__dirname, 'public/crm')));

// Root Public Favicons & Brand Assets
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '4h',
    index: false
}));

// Public Downloads with Persistent Volume Priority (APKs & App Distribution)
app.get('/downloads/:filename', (req, res) => {
    const rawFilename = req.params.filename;
    const safeFilename = path.basename(rawFilename); // Prevent path traversal
    
    // 1. Check persistent volume downloads first (/app/uploads/downloads/<filename>)
    const volumePath = path.join(activeDownloadsDir, safeFilename);
    // 2. Fallback to repository static directory for local development
    const repoPath = path.join(__dirname, 'public/downloads', safeFilename);

    let targetPath = null;
    if (fs.existsSync(volumePath)) {
        targetPath = volumePath;
    } else if (fs.existsSync(repoPath)) {
        targetPath = repoPath;
    }

    if (!targetPath) {
        return res.status(404).json({ error: 'Download not found' });
    }

    if (safeFilename.endsWith('.apk')) {
        res.setHeader('Content-Type', 'application/vnd.android.package-archive');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
        res.setHeader('Cache-Control', 'public, max-age=14400, must-revalidate');
    }

    res.sendFile(targetPath);
});

app.use('/downloads', express.static(path.join(__dirname, 'public/downloads'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.apk')) {
            res.setHeader('Content-Type', 'application/vnd.android.package-archive');
            const filename = path.basename(filePath);
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        }
    }
}));


// --- GLOBAL ERROR HANDLER ---
app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large. Max 5MB allowed.' });
    if (err.message && err.message.includes('Invalid file type')) return res.status(415).json({ error: err.message });
    console.error('Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
});

app.get('/', (req, res) => {
    if (isCustomerDomain(req)) {
        return servePortalHtml('customer', req, res);
    }
    if (isGarageDomain(req)) {
        return servePortalHtml('garage', req, res);
    }
    if (isDriverDomain(req)) {
        return servePortalHtml('marshal', req, res);
    }
    res.redirect('/customer/');
});

app.get('/index.html', (req, res) => {
    if (isCustomerDomain(req)) {
        return servePortalHtml('customer', req, res);
    }
    if (isGarageDomain(req)) {
        return servePortalHtml('garage', req, res);
    }
    if (isDriverDomain(req)) {
        return servePortalHtml('marshal', req, res);
    }
    res.redirect('/customer/');
});
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: Math.floor(process.uptime()) }));

console.log('[STARTUP-3] Starting Express HTTP server on 0.0.0.0:' + PORT + '...');
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[STARTUP-4] ✓ GearX server running on 0.0.0.0:${PORT} [${process.env.NODE_ENV || 'development'}]`);
});
// trigger fresh deploy
