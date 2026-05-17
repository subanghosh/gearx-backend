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
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-change-me';
const BCRYPT_ROUNDS = 12;

// --- SECURITY MIDDLEWARE ---
app.use(helmet({
    contentSecurityPolicy: false // disabled to allow inline scripts in existing HTML
}));

const allowedOrigins = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
    origin: (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        cb(new Error('CORS: Origin not allowed'));
    },
    credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// --- RATE LIMITERS ---
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' }
});

const otpLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    message: { error: 'Too many OTP requests. Please wait 10 minutes.' }
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
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
        return sql.replace(/\?/g, () => "\$" + (i++));
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
            id SERIAL PRIMARY KEY, entityId TEXT, entityType TEXT, phone TEXT, email TEXT,
            otp TEXT NOT NULL, createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expiresAt TIMESTAMP, verifiedAt TIMESTAMP
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

apiRouter.get('/users', (req, res) => {
    db.all("SELECT * FROM users", (err, rows) => res.json(rows || []));
});

apiRouter.get('/trips', (req, res) => {
    db.all("SELECT * FROM service_progress", (err, rows) => res.json(rows || [])); // progress as trips
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
    pool.query("DELETE FROM otp_verifications WHERE expiresAt < NOW()").catch(() => {});
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.run("INSERT INTO otp_verifications (entityId, entityType, phone, email, otp, expiresAt) VALUES ('TEMP', 'auth', ?, ?, ?, ?)",
        [phone, email, otp, expiresAt], async (err) => {
            if (err) return res.status(500).json({ error: 'Database error: ' + err.message });
            if (email) {
                try {
                    await transporterReady;
                    await transporter.sendMail({ from: '"GearX" <support@gearx.in>', to: email, subject: 'Your GearX OTP', text: `Your OTP is: ${otp}. Valid for 10 minutes. Do not share with anyone.` });
                } catch(mailErr) {
                    console.warn('Email send failed (non-fatal):', mailErr.message);
                }
            }
            // In production: remove otp from response, send via SMS only
            const resp = { message: 'OTP sent' };
            if (process.env.NODE_ENV !== 'production') resp.otp = otp;
            res.json(resp);
        });
});

apiRouter.post('/auth/verify-otp', (req, res) => {
    const { phone, email, otp } = req.body;
    if (!otp || otp.length !== 6) return res.status(400).json({ error: 'OTP must be 6 digits' });
    const val = phone || email;
    if (!val) return res.status(400).json({ error: 'Phone or email required' });

    db.get(`SELECT * FROM otp_verifications WHERE (phone = ? OR email = ?) AND otp = ? AND verifiedAt IS NULL AND expiresAt > CURRENT_TIMESTAMP ORDER BY id DESC LIMIT 1`,
        [val, val, otp], (err, row) => {
            if (!row) return res.status(400).json({ error: 'Invalid or expired OTP' });
            db.run("UPDATE otp_verifications SET verifiedAt = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);

            const cleanVal = val.replace('+91', '');
            const prefixedVal = val.startsWith('+91') ? val : '+91' + val;

            const buildResponse = (userObj, isNewUser = false) => {
                const token = signToken({ id: userObj.id, role: userObj.role, garageId: userObj.garageId || null });
                return res.json({ verified: true, isNewUser, token, user: userObj });
            };

            // Step 1: Check users table
            db.get("SELECT * FROM users WHERE phone IN (?, ?) OR email = ?", [cleanVal, prefixedVal, val], (errU, user) => {
                if (user) {
                    return buildResponse({ id: user.id, name: user.name, role: user.role, garageId: user.garageId, status: user.status, kycStatus: user.kycStatus });
                }

                // Step 2: Garage worker
                db.get("SELECT gw.*, gw.garageId FROM garage_workers gw WHERE gw.phone IN (?, ?)", [cleanVal, prefixedVal], (errW, worker) => {
                    if (worker) {
                        return buildResponse({ id: worker.id, name: worker.name, role: worker.role || 'mechanic', garageId: worker.garageId, status: 'active', kycStatus: worker.kycStatus });
                    }

                    // Step 3: Garage owner
                    db.get("SELECT * FROM garages WHERE contact IN (?, ?) OR email = ?", [cleanVal, prefixedVal, val], (errG, garage) => {
                        if (garage) {
                            return buildResponse({ id: garage.id + '_owner', name: garage.name || 'Partner', role: 'garage', garageId: garage.id, status: garage.status });
                        }

                        // Step 4: New user — auto-create garage + user record
                        const gid = 'gar_' + Date.now();
                        const contactField = phone || null;
                        const emailField = email || null;
                        db.run("INSERT INTO garages (id, name, contact, email, status) VALUES (?, 'New Partner', ?, ?, 'pending')",
                            [gid, contactField, emailField], () => {
                                db.run("INSERT INTO users (id, name, role, phone, email, garageId, status) VALUES (?, 'New Partner', 'garage', ?, ?, ?, 'pending')",
                                    [gid + '_owner', contactField, emailField, gid], () => {
                                        return buildResponse({ id: gid + '_owner', name: 'New Partner', role: 'garage', garageId: gid, status: 'pending' }, true);
                                    });
                            });
                    });
                });
            });
        });
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
]), (req, res) => {
    const { name, email, panNumber, aadhaarNumber, dlNumber, kycStatus } = req.body;
    const files = req.files || {};
    
    const panUrl = files.panFile ? 'uploads/' + files.panFile[0].filename : null;
    const aadhaarUrl = files.aadhaarFile ? 'uploads/' + files.aadhaarFile[0].filename : null;
    const facePhotoUrl = files.faceFile ? 'uploads/' + files.faceFile[0].filename : null;

    db.serialize(() => {
        // Sync into garage_workers
        db.run("UPDATE garage_workers SET name = ?, email = ?, panNumber = ?, aadhaarNumber = ?, panUrl = ?, aadhaarUrl = ?, facePhotoUrl = ?, kycStatus = ? WHERE id = ?",
            [name, email, panNumber, aadhaarNumber, panUrl, aadhaarUrl, facePhotoUrl, kycStatus, req.params.id], () => {
                
                // Sync into CRM core users
                db.run("UPDATE users SET name = ?, email = ?, panNumber = ?, aadhaarNumber = ?, panUrl = ?, aadhaarUrl = ?, facePhotoUrl = ?, kycStatus = ? WHERE id = ?",
                    [name, email, panNumber, aadhaarNumber, panUrl, aadhaarUrl, facePhotoUrl, kycStatus, req.params.id], (err) => {
                        if (err) return res.status(500).json({ error: 'Sync failed: ' + err.message });
                        res.json({ success: true, kycStatus });
                    });
            });
    });
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
    db.run("INSERT INTO users (id, name, phone, email, role) VALUES (?, ?, ?, ?, 'customer')",
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
    const { id, serviceRequestId } = req.body;
    db.run(`INSERT INTO service_progress (order_id, category) VALUES (?, 'trip')`, [serviceRequestId], function(err) {
        res.json({ success: true, id: id || this.lastID });
    });
});

apiRouter.post('/trips/:id/approve-audit', (req, res) => res.json({ success: true }));
apiRouter.post('/trips/:id/audit', (req, res) => res.json({ success: true, customerEstimate: 600 }));


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
        `INSERT INTO analytics_events (app, event, properties, user_id, session_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [appName, event, JSON.stringify(properties || {}), userId || null, sessionId || null]
    ).catch(() => {}); // silent — analytics never blocks
    res.json({ ok: true });
});

// --- APPLY RATE LIMITERS TO SPECIFIC AUTH ROUTES ---
app.use('/api/auth/send-otp', otpLimiter);
app.use('/api/auth/login', loginLimiter);
app.use('/api/upload-kyc', uploadLimiter);

// --- STATIC ROUTES ---
app.use('/api', apiRouter);
app.use('/uploads', express.static('uploads'));
app.use('/garage', express.static(path.join(__dirname, '../vroomly-garage-portal')));
app.use('/customer', express.static(path.join(__dirname, '../vroomly-customer-app')));
app.use('/marshal', express.static(path.join(__dirname, '../vroomly-marshal-app')));
app.use('/crm', express.static(path.join(__dirname, '../Anti_Gravity')));

// --- GLOBAL ERROR HANDLER ---
app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large. Max 5MB allowed.' });
    if (err.message && err.message.includes('Invalid file type')) return res.status(415).json({ error: err.message });
    console.error('Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => console.log(`GearX server running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`));
