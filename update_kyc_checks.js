const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { Pool } = require('pg');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const nodemailer = require('nodemailer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
app.set('trust proxy', 1); // Crucial for Render/reverse proxies to accurately identify client IPs for rate limiting

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-change-me';
const BCRYPT_ROUNDS = 12;


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

    const results = await Promise.all(checks);
    for (let r of results) {
        if (r.rows && r.rows.length > 0) {
            return r.rows[0]; // returns {id, role}
        }
    }
    return null;
}

// --- SECURITY MIDDLEWARE ---
app.use(helmet({
    contentSecurityPolicy: false // disabled to allow inline scripts in existing HTML
}));

const allowedOrigins = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
    origin: (origin, cb) => {
        // Allow requests with no origin (mobile apps, curl, Postman)
        if (!origin) return cb(null, true);
        // If FRONTEND_URL is set, check against whitelist; otherwise allow all
        if (!process.env.FRONTEND_URL || allowedOrigins.includes(origin)) return cb(null, true);
        cb(new Error('CORS: Origin not allowed'));
    },
    credentials: true
}));

app.use(express.json({ limit: '10mb' }));
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

const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 30,
    message: { error: 'Upload limit reached. Try again in 1 hour.' }
});

app.use('/api', globalLimiter);

// --- JWT HELPERS ---
function signToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
}

function authMiddleware(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authorization token required' });
    }
    try {
        req.user = jwt.verify(header.split(' ')[1], JWT_SECRET);
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

let transporter;
const transporterReady = new Promise((resolve) => {
    nodemailer.createTestAccount((err, account) => {
        if (err) {
            console.error('Ethereal account creation failed, using fallback transporter');
            transporter = nodemailer.createTransport({ jsonTransport: true }); // fallback no-op
        } else {
            transporter = nodemailer.createTransport({
                host: 'smtp.ethereal.email', port: 587, secure: false,
                auth: { user: account.user, pass: account.pass }
            });
        }
        resolve();
    });
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = {
    convertQuery: (sql) => {
        let i = 1;
        return sql.replace(/\?/g, () => "$" + (i++));
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
    console.log('Connected to Neon PostgreSQL.');
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
            panUrl TEXT, aadhaarUrl TEXT, facePhotoUrl TEXT, kycStatus TEXT DEFAULT 'pending_submission'
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
            "ALTER TABLE users ADD COLUMN kycStatus TEXT DEFAULT 'pending_submission'"
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
            kycStatus TEXT DEFAULT 'pending_submission',
            FOREIGN KEY(garageId) REFERENCES garages(id)
        )`);

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
            FOREIGN KEY(workerId) REFERENCES users(id)
        )`);
        db.run("ALTER TABLE service_requests ADD COLUMN workerId TEXT", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN auditStatus TEXT DEFAULT 'pending'", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN service_category TEXT DEFAULT 'Standard Service'", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN inspection_fee REAL DEFAULT 299", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN parts_cost REAL DEFAULT 0", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN labor_cost REAL DEFAULT 0", () => {});
        db.run("ALTER TABLE service_requests ADD COLUMN marshal_commission REAL DEFAULT 0", () => {});

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
            pickupLat REAL,
            pickupLng REAL,
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(serviceRequestId) REFERENCES service_requests(id),
            FOREIGN KEY(marshalId) REFERENCES users(id)
        )`);

        // Global Settings
        db.run(`CREATE TABLE IF NOT EXISTS system_settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )`, () => {
            // Default commission percentage to 2%
            db.run(`INSERT INTO system_settings (key, value) VALUES ('marshal_commission_percentage', '2.0') ON CONFLICT(key) DO NOTHING`);
        });

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
         'lat REAL', 'lng REAL', 'accountType TEXT', 'govIdNumber TEXT', 'ownerCount INTEGER DEFAULT 1'
        ].forEach(col => db.run(`ALTER TABLE garages ADD COLUMN ${col}`, () => {}));

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
            garageId TEXT, skuId TEXT, redrivoPrice REAL, garagePrice REAL, stock INTEGER DEFAULT 0,
            status TEXT DEFAULT 'active', lastUpdated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(garageId, skuId),
            FOREIGN KEY(garageId) REFERENCES garages(id),
            FOREIGN KEY(skuId) REFERENCES master_skus(id)
        )`);

        // Migration for garage_skus
        [
            "ALTER TABLE garage_skus ADD COLUMN redrivoPrice REAL",
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

        // Seed Admin (hash password in production)
        db.get("SELECT * FROM users WHERE id = 'u_admin'", (err, row) => {
            if (!row) {
                bcrypt.hash('admin', BCRYPT_ROUNDS).then(hash => {
                    db.run("INSERT INTO users (id, name, email, phone, role, password, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        ['u_admin', 'Admin', 'admin@vroomer.com', '+910000000000', 'admin', hash, 'active']);
                });
            }
        });

        // Migration: Ensure garage_workers has all required columns in PostgreSQL
        ['email TEXT', 'panNumber TEXT', 'aadhaarNumber TEXT', 'panUrl TEXT', 'aadhaarUrl TEXT', 'facePhotoUrl TEXT', 'kycStatus TEXT DEFAULT \'pending_submission\''].forEach(col => {
            db.run(`ALTER TABLE garage_workers ADD COLUMN ${col}`, () => {});
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

const apiRouter = express.Router();

apiRouter.get('/admin/system/health', (req, res) => {
    res.json({ status: 'active', message: 'Backend is running correctly', timestamp: new Date() });
});

apiRouter.get('/health', (req, res) => {
    res.json({ status: 'active', message: 'Backend is running correctly' });
});

// --- BASIC ENTITY ROUTES ---
apiRouter.get('/customers', (req, res) => {
    db.all("SELECT * FROM customers", (err, rows) => res.json(rows || []));
});

apiRouter.get('/vehicles', (req, res) => {
    db.all("SELECT * FROM vehicles", (err, rows) => res.json(rows || []));
});

apiRouter.get('/requests', (req, res) => {
    db.all("SELECT * FROM service_requests", (err, rows) => res.json(rows || []));
});

apiRouter.get('/garages', (req, res) => {
    db.all("SELECT * FROM garages", (err, rows) => res.json(rows || []));
});

apiRouter.post('/garages', (req, res) => {
    const { id, name, owner, phone, location, gmapLink, type, commissionRate, joinedDate } = req.body;
    db.run(`INSERT INTO garages (id, name, owner, contact, address, status, serviceType, joinedDate) 
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        [id, name, owner, phone, location, type === 'Both' ? 'Both' : (type === 'Bike' ? 'Bike' : 'Car'), joinedDate || new Date().toISOString()],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id });
        });
});


apiRouter.post('/users', async (req, res) => {
    try {
        const { id, name, phone, email, role, password, status } = req.body;
        if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required' });
        
        const existing = await checkUniqueEntity(phone);
        if (existing) {
            return res.status(400).json({ error: 'A ' + (existing.role || 'user') + ' with this phone number already exists in the system.' });
        }
        
        await pool.query(
            "INSERT INTO users (id, name, phone, email, role, password, status) VALUES ($1, $2, $3, $4, $5, $6, $7)",
            [id || 'u_' + Date.now(), name, phone, email, role || 'customer', password, status || 'active']
        );
        res.json({ success: true, id });
    } catch (err) {
        console.error('POST /users error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

apiRouter.get('/users', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM users");
        res.json(result.rows || []);
    } catch (err) {
        console.error('GET /users error:', err.message);
        res.json([]);
    }
});

apiRouter.patch('/users/:id', async (req, res) => {
    let id = req.params.id;
    if (id.endsWith('_owner')) {
        const garageId = id.replace('_owner', '');
        const userLookup = await pool.query(`SELECT id FROM users WHERE garageid = $1 AND role = 'garage' LIMIT 1`, [garageId]);
        if (userLookup.rows[0]) {
            id = userLookup.rows[0].id;
        }
    }
    const allowed = ['kycStatus', 'panVerified', 'aadhaarVerified', 'bankVerified', 'status', 'name', 'email', 'phone', 'emailVerified'];
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
            const exists = await pool.query(`SELECT id FROM users WHERE email = $1 AND id != $2`, [req.body.email, id]);
            if (exists.rows.length > 0) return res.status(400).json({ error: 'Email is already associated with another account.' });
            // Only reset if we are not actively verifying it in the same request
            if (req.body.emailVerified === undefined) {
                fields.push(`emailverified = $${idx++}`);
                vals.push(0);
            }
        }

        vals.push(id);
        await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`, vals);

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
            if (req.body.name) { sqFields.push("name = ?"); sqVals.push(req.body.name); }
            if (req.body.email) { sqFields.push("email = ?"); sqVals.push(req.body.email); }
            if (req.body.phone) { sqFields.push("phone = ?"); sqVals.push(req.body.phone); }
            if (sqFields.length > 0) {
                sqVals.push(id);
                db.run(`UPDATE customers SET ${sqFields.join(', ')} WHERE id = ?`, sqVals, (err) => {
                    if (err) console.warn('SQLite customers sync failed:', err.message);
                });
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
apiRouter.put('/users/:id', async (req, res) => {
    let id = req.params.id;
    if (id.endsWith('_owner')) {
        const garageId = id.replace('_owner', '');
        const userLookup = await pool.query(`SELECT id FROM users WHERE garageid = $1 AND role = 'garage' LIMIT 1`, [garageId]);
        if (userLookup.rows[0]) {
            id = userLookup.rows[0].id;
        }
    }
    const allowed = ['kycStatus', 'panVerified', 'aadhaarVerified', 'bankVerified', 'status', 'name', 'email', 'phone', 'emailVerified'];
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
            const exists = await pool.query(`SELECT id FROM users WHERE email = $1 AND id != $2`, [req.body.email, id]);
            if (exists.rows.length > 0) return res.status(400).json({ error: 'Email is already associated with another account.' });
            if (req.body.emailVerified === undefined) {
                fields.push(`emailverified = $${idx++}`);
                vals.push(0);
            }
        }

        vals.push(id);
        await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`, vals);
        
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
            if (req.body.name) { sqFields.push("name = ?"); sqVals.push(req.body.name); }
            if (req.body.email) { sqFields.push("email = ?"); sqVals.push(req.body.email); }
            if (req.body.phone) { sqFields.push("phone = ?"); sqVals.push(req.body.phone); }
            if (sqFields.length > 0) {
                sqVals.push(id);
                db.run(`UPDATE customers SET ${sqFields.join(', ')} WHERE id = ?`, sqVals, (err) => {
                    if (err) console.warn('SQLite customers sync failed:', err.message);
                });
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
    const { field, value } = req.body;
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

        if (field === 'email') {
            try {
                await transporterReady;
                await transporter.sendMail({
                    from: '"ReDrivo" <support@redrivo.in>',
                    to: value,
                    subject: 'Verify your new email',
                    text: `Your verification OTP is: ${otp}. Valid for 10 minutes.`
                });
            } catch (mailErr) {
                console.warn('Email send failed (non-fatal):', mailErr.message);
            }
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

apiRouter.get('/trips', (req, res) => {
    db.all(`
        SELECT trips.*, 
               u.name AS "marshalName", 
               u.phone AS "marshalPhone",
               u.facePhotoUrl AS "marshalPhoto",
               u.emailVerified AS "emailVerified",
               u.phoneVerified AS "phoneVerified",
               u.dlVerified AS "dlVerified"
        FROM trips
        LEFT JOIN users u ON trips.marshalId = u.id
    `, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

apiRouter.get('/media', (req, res) => {
    const { referenceId } = req.query;
    let query = "SELECT * FROM media";
    let params = [];
    if (referenceId) {
        query += " WHERE referenceId = ?";
        params.push(referenceId);
    }
    db.all(query, params, (err, rows) => res.json(rows || []));
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
        const token = signToken({ id: user.id, role: user.role, garageId: user.garageId });
        res.json({ ...user, password: undefined, token });
    });
});

apiRouter.post('/auth/send-otp', otpLimiter, async (req, res) => {
    const { email, phone } = req.body;
    if (!phone && !email)
        return res.status(400).json({ error: 'Phone or email is required' });

    // Clean expired OTPs (housekeeping)
    pool.query("DELETE FROM otp_verifications WHERE expiresat < NOW()").catch(() => {});

    const otp = process.env.NODE_ENV !== 'production' ? '123456' : String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    try {
        await pool.query(
            `INSERT INTO otp_verifications (entityid, entitytype, phone, email, otp, expiresat) VALUES ('TEMP', 'auth', $1, $2, $3, $4)`,
            [phone || null, email || null, otp, expiresAt]
        );

        if (email) {
            try {
                await transporterReady;
                await transporter.sendMail({ from: '"ReDrivo" <support@redrivo.in>', to: email, subject: 'Your ReDrivo OTP', text: `Your OTP is: ${otp}. Valid for 10 minutes. Do not share with anyone.` });
            } catch(mailErr) {
                console.warn('Email send failed (non-fatal):', mailErr.message);
            }
        }
        // In production: remove otp from response, send via SMS only
        const resp = { message: 'OTP sent' };
        if (process.env.NODE_ENV !== 'production') resp.otp = otp;
        res.json(resp);
    } catch (err) {
        console.error('send-otp DB error:', err.message);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

apiRouter.post('/auth/verify-otp', async (req, res) => {
    const { phone, email, otp, role } = req.body;
    if (!otp || otp.length !== 6) return res.status(400).json({ error: 'OTP must be 6 digits' });
    const val = phone || email;
    if (!val) return res.status(400).json({ error: 'Phone or email required' });

    try {
        // Find valid OTP
        const otpResult = await pool.query(
            `SELECT * FROM otp_verifications WHERE (phone = $1 OR email = $1) AND otp = $2 AND verifiedat IS NULL AND expiresat > NOW() ORDER BY id DESC LIMIT 1`,
            [val, otp]
        );
        const row = otpResult.rows[0];
        if (!row) return res.status(400).json({ error: 'Invalid or expired OTP' });

        // Mark OTP as used
        await pool.query(`UPDATE otp_verifications SET verifiedat = NOW() WHERE id = $1`, [row.id]);

        const cleanVal = val.replace('+91', '');
        const prefixedVal = val.startsWith('+91') ? val : '+91' + val;

        const buildResponse = async (userObj, isNewUser = false) => {
            // Update phone or email verification status
            if (val.includes('@')) {
                await pool.query(`UPDATE users SET emailverified = 1 WHERE id = $1`, [userObj.id]).catch(() => {});
                await pool.query(`UPDATE garage_workers SET emailverified = 1 WHERE id = $1`, [userObj.id]).catch(() => {});
            } else {
                await pool.query(`UPDATE users SET phoneverified = 1 WHERE id = $1`, [userObj.id]).catch(() => {});
                await pool.query(`UPDATE garage_workers SET phoneverified = 1 WHERE id = $1`, [userObj.id]).catch(() => {});
            }

            const token = signToken({ id: userObj.id, role: userObj.role, garageId: userObj.garageId || null });
            return res.json({ verified: true, isNewUser, token, user: userObj });
        };

        // Step 1: Check users table
        const userResult = await pool.query(
            `SELECT * FROM users WHERE phone IN ($1, $2) OR email = $3 ORDER BY CASE WHEN role = $4 THEN 0 ELSE 1 END LIMIT 1`,
            [cleanVal, prefixedVal, val, role || 'customer']
        );
        if (userResult.rows[0]) {
            const user = userResult.rows[0];
            return await buildResponse({ 
                id: user.id, 
                name: user.name, 
                role: user.role, 
                garageId: user.garageId || user.garageid, 
                status: user.status, 
                kycStatus: user.kycStatus || user.kycstatus,
                phone: user.phone,
                email: user.email
            });
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
                email: null
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
                [newUserId, prefixedVal, email || null]
            );
            return await buildResponse({ 
                id: newUserId, 
                name: 'New Marshal', 
                role: 'marshal', 
                garageId: null, 
                status: 'active', 
                kycStatus: 'pending_submission',
                phone: prefixedVal,
                email: email || null
            }, true);
        } else if (targetRole === 'garage') {
            const newGarageId = 'gar_' + Date.now();
            const newUserId = 'garage_' + Date.now();
            
            // Insert into garages
            await pool.query(
                `INSERT INTO garages (id, name, contact, email, status) VALUES ($1, 'New Partner Garage', $2, $3, 'active')`,
                [newGarageId, prefixedVal, email || null]
            );
            // Insert into users
            await pool.query(
                `INSERT INTO users (id, name, role, phone, email, garageId, status) VALUES ($1, 'New Partner', 'garage', $2, $3, $4, 'active')`,
                [newUserId, prefixedVal, email || null, newGarageId]
            );
            return await buildResponse({ 
                id: newGarageId + '_owner', 
                name: 'New Partner', 
                role: 'garage', 
                garageId: newGarageId, 
                status: 'active',
                phone: prefixedVal,
                email: email || null
            }, true);
        } else {
            // Default: customer
            const newUserId = 'cust_' + Date.now();
            await pool.query(
                `INSERT INTO users (id, name, role, phone, email, status) VALUES ($1, 'New Customer', 'customer', $2, $3, 'active')`,
                [newUserId, prefixedVal, email || null]
            );
            await pool.query(
                `INSERT INTO customers (id, name, phone, email, status) VALUES ($1, 'New Customer', $2, $3, 'active')`,
                [newUserId, prefixedVal, email || null]
            );
            return await buildResponse({ 
                id: newUserId, 
                name: 'New Customer', 
                role: 'customer', 
                garageId: null, 
                status: 'active',
                phone: prefixedVal,
                email: email || null
            }, true);
        }

    } catch (err) {
        console.error('verify-otp error:', err.message);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// --- WORKERS ---
apiRouter.get('/garages/:id/workers', (req, res) => {
    db.all("SELECT * FROM garage_workers WHERE garageId = ?", [req.params.id], (err, rows) => res.json(rows || []));
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

apiRouter.get('/workers', (req, res) => {
    db.all("SELECT * FROM garage_workers", (err, rows) => res.json(rows || []));
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
apiRouter.get('/garages/:id/orders', (req, res) => {
    db.all(`SELECT sr.*, c.name as customerName, v.plate, v.makeModel 
            FROM service_requests sr 
            JOIN customers c ON sr.customerId = c.id 
            JOIN vehicles v ON sr.vehicleId = v.id 
            WHERE sr.garageId = ?`, [req.params.id], (err, rows) => res.json(rows || []));
});

apiRouter.get('/workers/:id/tasks', (req, res) => {
    db.all(`SELECT sr.*, c.name as customerName, v.plate, v.makeModel 
            FROM service_requests sr 
            JOIN customers c ON sr.customerId = c.id 
            JOIN vehicles v ON sr.vehicleId = v.id 
            WHERE sr.workerId = ?`, [req.params.id], (err, rows) => res.json(rows || []));
});

apiRouter.get('/garages/:id', (req, res) => {
    db.get("SELECT * FROM garages WHERE id = $1", [req.params.id], (err, row) => {
        if (err || !row) return res.json(row);
        db.all('SELECT id, filePath AS "filePath", fileName AS "fileName", docType AS "docType" FROM media WHERE referenceId = $1', [req.params.id], (err, media) => {
            row.documents = media || [];
            res.json(row);
        });
    });
});

apiRouter.put('/garages/:id', (req, res) => {
    const allowed = ['name', 'owner', 'ownerCount', 'ownercount', 'address', 'contact', 'email', 'status', 'lat', 'lng', 'businessType', 'businesstype', 'gstNumber', 'gstnumber', 'bankAccountName', 'bankaccountname', 'bankAccountNumber', 'bankaccountnumber', 'bankIFSC', 'bankifsc', 'bankName', 'bankname', 'bankBranch', 'bankbranch', 'bankVerified', 'bankverified', 'serviceType', 'servicetype', 'panNumber', 'pannumber', 'panVerified', 'panverified', 'aadhaarNumber', 'aadhaar_number', 'aadhaarnumber', 'aadhaarVerified', 'aadhaarverified', 'emailVerified', 'emailverified', 'govIdType', 'govidtype', 'accountType', 'accounttype', 'govIdNumber', 'govidnumber'];
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

apiRouter.get('/garages/:id/stats', (req, res) => {
    db.all("SELECT status, totalCustomerPrice FROM service_requests WHERE garageId = ?", [req.params.id], (err, rows) => {
        const stats = { totalOrders: rows.length, pending: rows.filter(r => r.status !== 'delivered').length, delivered: rows.filter(r => r.status === 'delivered').length, revenue: rows.reduce((acc, r) => acc + (r.totalCustomerPrice || 0), 0) };
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
    db.all(`SELECT g.id, g.name, g.address AS "location", gs.redrivoPrice, gs.garagePrice, gs.stock, gs.status
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
            gs.redrivoPrice, gs.garagePrice, gs.stock, gs.status
            FROM master_skus ms
            JOIN garage_skus gs ON ms.id = gs.skuId
            WHERE gs.garageId = $1`, [req.params.id], (err, rows) => res.json(rows || []));
});

// Save/Activate a part (POST = upsert)
apiRouter.post('/garages/:id/skus', (req, res) => {
    const { skuId, redrivoPrice, garagePrice, stock, status } = req.body;
    db.run(`INSERT INTO garage_skus (garageId, skuId, redrivoPrice, garagePrice, stock, status) 
            VALUES (?, ?, ?, ?, ?, ?) 
            ON CONFLICT(garageId, skuId) DO UPDATE SET 
            redrivoPrice = excluded.redrivoPrice, garagePrice = excluded.garagePrice, stock = excluded.stock, status = excluded.status, 
            lastUpdated = CURRENT_TIMESTAMP`,
        [req.params.id, skuId, redrivoPrice, garagePrice, stock, status || 'active'], 
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

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

const storage = multer.diskStorage({
    destination: 'uploads/',
    filename: (req, file, cb) => {
        // Sanitize filename to prevent path traversal
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, Date.now() + '-' + safeName);
    }
});

const fileFilter = (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only JPG, PNG, WebP, and PDF are allowed.'), false);
    }
};

const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_SIZE } });

apiRouter.put('/workers/:id/kyc', upload.fields([
    { name: 'panFile', maxCount: 1 }, 
    { name: 'aadhaarFile', maxCount: 1 }, 
    { name: 'faceFile', maxCount: 1 }
]), async (req, res) => {
    const { name, email, panNumber, aadhaarNumber, dlNumber, kycStatus,
            bankAccountName, bankAccountNumber, bankIFSC } = req.body;
    const files = req.files || {};

    // ── Server-side KYC validation (mirrors frontend kyc-validation.js) ────
    const serverErrors = [];

    if (!name || !/^[A-Za-z\s.'"-]{2,100}$/.test(name.trim()))
        serverErrors.push('Invalid Full Name: only letters and spaces allowed.');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim()))
        serverErrors.push('Invalid Email Address.');
    if (!panNumber || !/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(panNumber.trim().toUpperCase()))
        serverErrors.push('Invalid PAN Number. Expected format: ABCDE1234F');
    if (!aadhaarNumber || !/^[2-9][0-9]{11}$/.test(aadhaarNumber.replace(/\D/g, '')))
        serverErrors.push('Invalid Aadhaar Number: must be exactly 12 digits starting with 2-9.');
    if (!dlNumber || !/^[A-Z]{2}[0-9]{11,13}$/.test(dlNumber.replace(/[^A-Z0-9]/g, '').toUpperCase()))
        serverErrors.push('Invalid Driving License format.');
    if (!bankAccountName || !/^[A-Za-z\s.]{2,100}$/.test(bankAccountName.trim()))
        serverErrors.push('Invalid Account Holder Name: only letters and spaces allowed.');
    if (!bankAccountNumber || !/^[0-9]{9,18}$/.test(bankAccountNumber.trim()))
        serverErrors.push('Invalid Account Number: must be 9-18 digits only.');
    if (!bankIFSC || !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(bankIFSC.trim().toUpperCase()))
        serverErrors.push('Invalid IFSC Code. Expected format: SBIN0001234');

    // File checks (only enforced when requesting pending_approval status)
    if (kycStatus === 'pending_approval') {
        if (!files.panFile) serverErrors.push('PAN Card photo is required.');
        if (!files.aadhaarFile) serverErrors.push('Aadhaar photo is required.');
        if (!files.faceFile) serverErrors.push('Live Selfie photo is required.');
    }

    if (serverErrors.length > 0) {
        return res.status(400).json({ error: serverErrors[0], details: serverErrors });
    }

    const panUrl = files.panFile ? 'uploads/' + files.panFile[0].filename : null;
    const aadhaarUrl = files.aadhaarFile ? 'uploads/' + files.aadhaarFile[0].filename : null;
    const facePhotoUrl = files.faceFile ? 'uploads/' + files.faceFile[0].filename : null;
    const cleanAadhaar = aadhaarNumber.replace(/\D/g, '');
    const cleanPan = panNumber.trim().toUpperCase();
    const cleanDL = dlNumber.replace(/[^A-Z0-9]/g, '').toUpperCase();
    const cleanIFSC = bankIFSC.trim().toUpperCase();
    const finalKycStatus = kycStatus || 'pending_approval';

    try {
        if (cleanPan) {
            const panCheck = await pool.query(`SELECT id FROM users WHERE pannumber = $1 AND id != $2 UNION ALL SELECT id FROM garage_workers WHERE pannumber = $1 AND id != $2`, [cleanPan, req.params.id]);
            if (panCheck.rows.length > 0) return res.status(400).json({ error: 'PAN Number is already registered.' });
        }
        if (cleanAadhaar) {
            const aadhaarCheck = await pool.query(`SELECT id FROM users WHERE aadhaarnumber = $1 AND id != $2 UNION ALL SELECT id FROM garage_workers WHERE aadhaarnumber = $1 AND id != $2`, [cleanAadhaar, req.params.id]);
            if (aadhaarCheck.rows.length > 0) return res.status(400).json({ error: 'Aadhaar Number is already registered.' });
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
             dlnumber = $9, bankaccountname = $10, bankaccountnumber = $11, bankifsc = $12
             WHERE id = $13`,
            [name, email, cleanPan, cleanAadhaar, panUrl, aadhaarUrl, facePhotoUrl, finalKycStatus,
             cleanDL, bankAccountName, bankAccountNumber, cleanIFSC, req.params.id]
        ).catch(() => {}); // ignore if no garage_worker row

        // Sync into core users table (marshals live here)
        await pool.query(
            `UPDATE users SET name = $1, email = $2, pannumber = $3, aadhaarnumber = $4,
             panurl = $5, aadhaarurl = $6, facephotourl = $7, kycstatus = $8,
             dlnumber = $9, bankaccountname = $10, bankaccountnumber = $11, bankifsc = $12
             WHERE id = $13`,
            [name, email, cleanPan, cleanAadhaar, panUrl, aadhaarUrl, facePhotoUrl, finalKycStatus,
             cleanDL, bankAccountName, bankAccountNumber, cleanIFSC, req.params.id]
        );

        res.json({ success: true, kycStatus: finalKycStatus });
    } catch (err) {
        console.error('KYC update error:', err.message);
        res.status(500).json({ error: 'Failed to save KYC: ' + err.message });
    }
});
apiRouter.post('/upload-kyc', upload.single('file'), (req, res) => {
    const { entityId, docType } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const filePath = 'uploads/' + req.file.filename;
    const fileName = req.file.originalname;

    if (docType.startsWith('owner_')) {
        const field = docType.replace('owner_', '') + 'Path'; // aadhaarPath or panPath
        db.run(`UPDATE garage_owners SET ${field} = ? WHERE id = ?`, [filePath, entityId], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, filePath });
        });
    } else {
        const id = 'doc_' + Date.now();
        db.run("INSERT INTO media (id, referenceId, filePath, fileName, docType) VALUES (?, ?, ?, ?, ?) ON CONFLICT (referenceId, docType) DO UPDATE SET filePath = EXCLUDED.filePath, fileName = EXCLUDED.fileName",
            [id, entityId, filePath, fileName, docType], () => res.json({ success: true, filePath }));
    }
});

apiRouter.post('/garages/:id/documents', upload.single('file'), (req, res) => {
    const { docType } = req.body;
    const garageId = req.params.id;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const filePath = 'uploads/' + req.file.filename;
    const fileName = req.file.originalname;
    const id = 'doc_' + Date.now();

    db.run("INSERT INTO media (id, referenceId, filePath, fileName, docType) VALUES (?, ?, ?, ?, ?) ON CONFLICT (referenceId, docType) DO UPDATE SET filePath = EXCLUDED.filePath, fileName = EXCLUDED.fileName",
        [id, garageId, filePath, fileName, docType], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, filePath });
        });
});

apiRouter.delete('/garages/:id/documents/:docType', (req, res) => {
    db.run("DELETE FROM media WHERE referenceId = $1 AND docType = $2", [req.params.id, req.params.docType], (err) => {
        res.json({ success: !err });
    });
});

apiRouter.get('/crm/entities', (req, res) => {
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
    const fields = []; const vals = [];
    Object.keys(req.body).forEach(k => {
        fields.push(`${k} = ?`);
        vals.push(req.body[k]);
    });
    vals.push(req.params.id);
    db.run(`UPDATE service_requests SET ${fields.join(', ')} WHERE id = ?`, vals, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});
// --- MULTI-OWNER MANAGEMENT ---
apiRouter.get('/garages/:id/owners', (req, res) => {
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
    const table = entityType === 'garage' ? 'garages' : 'garage_owners';
    const column = field + 'Verified';
    
    db.run(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [status ? 1 : 0, entityId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// --- SERIALIZED PARTS MANAGEMENT ---
apiRouter.get('/serialized-parts', (req, res) => {
    db.all("SELECT * FROM serialized_parts ORDER BY assignedAt DESC", (err, rows) => res.json(rows || []));
});

apiRouter.post('/serialized-parts/bulk', (req, res) => {
    const { skuId, items } = req.body; // items = [{ garageId, serials: [] }]
    if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'Invalid items' });

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

apiRouter.post('/customers', (req, res) => {
    const { id, name, phone, email } = req.body;
    db.run("INSERT INTO customers (id, name, phone, email) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, email = EXCLUDED.email",
        [id || `cust_${Date.now()}`, name, phone, email], (err) => {
            res.json({ success: true, id: id || `cust_${Date.now()}` });
        });
});

apiRouter.post('/vehicles', (req, res) => {
    const { id, customerId, make, model, type, plate, photo } = req.body;
    db.run("INSERT INTO vehicles (id, customerId, make, model, type, plate, photo) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [id, customerId, make, model, type, plate, photo], (err) => {
            res.json({ success: true, id });
        });
});

apiRouter.put('/vehicles/:id', (req, res) => {
    const { make, model, type, plate, photo } = req.body;
    db.run("UPDATE vehicles SET make=?, model=?, type=?, plate=?, photo=? WHERE id=?",
        [make, model, type, plate, photo, req.params.id], (err) => res.json({ success: true }));
});

apiRouter.delete('/vehicles/:id', (req, res) => {
    db.run("DELETE FROM vehicles WHERE id=?", [req.params.id], (err) => res.json({ success: true }));
});

const createRequest = (req, res) => {
    const { id, customerId, vehicleId, garageId, date, status, totalCustomerPrice, workerId } = req.body;
    db.run(`INSERT INTO service_requests (id, customerId, vehicleId, garageId, date, status, totalCustomerPrice, workerId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, customerId, vehicleId, garageId || null, date, status || 'pending', totalCustomerPrice || 0, workerId || null], (err) => {
            res.json({ success: true, id });
        });
};
apiRouter.post('/service-requests', createRequest);
apiRouter.post('/requests', createRequest);

apiRouter.get('/marshals/available-pickups', (req, res) => {
    db.all(
        `SELECT sr.*, c.name as customerName 
         FROM service_requests sr 
         LEFT JOIN customers c ON sr.customerId = c.id 
         WHERE sr.status = 'pending' AND (sr.workerId IS NULL OR sr.workerId = '')`,
        [],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

apiRouter.post('/service-requests/:id/accept-pickup', async (req, res) => {
    const { marshalId } = req.body;
    const requestId = req.params.id;
    
    try {
        const pgRes = await pool.query("SELECT * FROM users WHERE id = $1 AND role = 'marshal'", [marshalId]);
        const marshal = pgRes && pgRes.rows ? pgRes.rows[0] : null;
        if (!marshal) {
            return res.status(404).json({ error: 'Marshal not found in CRM database' });
        }
        if (marshal.kycstatus !== 'approved' && marshal.kycstatus !== 'verified') {
            return res.status(400).json({ error: `Action Blocked: Your KYC documents status is '${marshal.kycstatus}'. You cannot accept Pickups until approved.` });
        }

        db.get("SELECT lat, lng FROM service_requests WHERE id = ?", [requestId], (err, serviceReq) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!serviceReq) return res.status(404).json({ error: 'Service request not found' });
            
            const lat = serviceReq.lat || 19.0760;
            const lng = serviceReq.lng || 72.8777;
            
            db.run("UPDATE service_requests SET workerId = ?, status = 'marshal_assigned' WHERE id = ?", [marshalId, requestId], (errU) => {
                if (errU) return res.status(500).json({ error: errU.message });
                
                const tripId = `trip_${Date.now()}`;
                const otp1 = String(Math.floor(1000 + Math.random() * 9000));
                const otp2 = String(Math.floor(1000 + Math.random() * 9000));
                
                db.run(
                    `INSERT INTO trips (id, serviceRequestId, marshalId, status, otp1, deliveryOtp, pickupLat, pickupLng) 
                     VALUES (?, ?, ?, 'pending_otp_1', ?, ?, ?, ?)`,
                    [tripId, requestId, marshalId, otp1, otp2, lat, lng],
                    (errT) => {
                        if (errT) return res.status(500).json({ error: errT.message });
                        res.json({ success: true, tripId, otp1 });
                    }
                );
            });
        });
    } catch (errPg) {
        console.error('Postgres error querying marshal:', errPg.message);
        return res.status(500).json({ error: 'Database error querying marshal: ' + errPg.message });
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

apiRouter.post('/trips', (req, res) => {
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

apiRouter.post('/trips/:id/approve-audit', (req, res) => res.json({ success: true }));
apiRouter.post('/trips/:id/audit', (req, res) => res.json({ success: true, customerEstimate: 600 }));

// --- NEW MARSHAL DROPOFF ENDPOINTS ---
apiRouter.post('/trips/:id/ready-for-delivery', (req, res) => {
    // Garage marks the car as ready. Generate OTP and default to original marshal.
    const deliveryOtp = String(Math.floor(1000 + Math.random() * 9000));
    db.run(
        "UPDATE trips SET status = 'ready_for_delivery', deliveryOtp = ?, deliveryMarshalId = marshalId WHERE id = ?",
        [deliveryOtp, req.params.id],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, deliveryOtp }); // Included in response for testing
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
    db.run(
        "UPDATE trips SET status = 'out_for_delivery' WHERE id = ?",
        [req.params.id],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            
            // Here we would trigger an SMS to the customer with the deliveryOtp
            // Example: sendSms(customerPhone, `Your car is out for delivery. OTP: ${trip.deliveryOtp}`);
            
            res.json({ success: true });
        }
    );
});

apiRouter.post('/trips/:id/complete-delivery', (req, res) => {
    const { otp } = req.body;
    db.get("SELECT trips.deliveryOtp, trips.deliveryMarshalId, trips.marshalId, trips.serviceRequestId, service_requests.totalcustomerprice FROM trips JOIN service_requests ON trips.serviceRequestId = service_requests.id WHERE trips.id = ?", [req.params.id], (err, trip) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!trip) return res.status(404).json({ error: 'Trip not found' });
        
        if (trip.deliveryOtp !== otp) {
            return res.status(400).json({ error: 'Invalid Delivery OTP' });
        }
        
        db.run("UPDATE trips SET status = 'completed' WHERE id = ?", [req.params.id], (err2) => {
            if (err2) return res.status(500).json({ error: err2.message });
            
            db.get("SELECT value FROM system_settings WHERE key = 'marshal_commission_percentage'", [], (err3, setting) => {
                const commissionRate = setting && setting.value ? parseFloat(setting.value) : 2.0;
                const ticketSize = trip.totalcustomerprice || 0;
                const totalCommission = ticketSize * (commissionRate / 100);
                
                let inserts = [];
                if (trip.marshalId === trip.deliveryMarshalId) {
                    inserts.push([`inc_${Date.now()}_1`, trip.marshalId, req.params.id, totalCommission, 'trip_bonus', 'pending']);
                } else {
                    inserts.push([`inc_${Date.now()}_1`, trip.marshalId, req.params.id, totalCommission / 2, 'trip_bonus', 'pending']);
                    inserts.push([`inc_${Date.now()}_2`, trip.deliveryMarshalId, req.params.id, totalCommission / 2, 'trip_bonus', 'pending']);
                }
                
                let completed = 0;
                inserts.forEach(insert => {
                    db.run(
                        "INSERT INTO incentives (id, userId, tripId, amount, type, status) VALUES (?, ?, ?, ?, ?, ?)",
                        insert,
                        () => {
                            completed++;
                            if (completed === inserts.length) {
                                res.json({ success: true, message: 'Delivery completed and commission credited', commissionCredited: totalCommission });
                            }
                        }
                    );
                });
                
                if (inserts.length === 0) {
                    res.json({ success: true, message: 'Delivery completed' });
                }
            });
        });
    });
});


// --- HEALTH CHECK ---
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', db: 'connected', env: process.env.NODE_ENV, uptime: Math.floor(process.uptime()) });
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
app.use('/api', apiRouter);
app.use('/uploads', express.static('uploads'));

// Garage Portal
app.use('/garage', express.static(path.join(__dirname, '../redrivo-garage-portal')));
app.use('/redrivo-garage-portal', express.static(path.join(__dirname, '../redrivo-garage-portal')));

// Customer App
app.use('/customer', express.static(path.join(__dirname, '../redrivo-customer-app')));
app.use('/redrivo-customer-app', express.static(path.join(__dirname, '../redrivo-customer-app')));

// Marshal App
app.use('/marshal', express.static(path.join(__dirname, '../redrivo-marshal-app')));
app.use('/redrivo-marshal-app', express.static(path.join(__dirname, '../redrivo-marshal-app')));

// CRM (Admin)
app.use('/crm', express.static(path.join(__dirname, '../Anti_Gravity')));
app.use('/admin', express.static(path.join(__dirname, '../Anti_Gravity')));

// --- GLOBAL ERROR HANDLER ---
app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large. Max 5MB allowed.' });
    if (err.message && err.message.includes('Invalid file type')) return res.status(415).json({ error: err.message });
    console.error('Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => console.log(`ReDrivo server running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`));
