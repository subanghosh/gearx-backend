import sys

with open('C:/Users/Suban/OneDrive/Documents/vroomly-backend/index.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Fix syntax error on line 548
content = content.replace("        if (existing) {\n            return res.status(400).json({ error: 'A ' + (existing.role || 'user') + ' with this phone number already exists in the system.' });\n        });\n        }", "        if (existing) {\n            return res.status(400).json({ error: 'A ' + (existing.role || 'user') + ' with this phone number already exists in the system.' });\n        }\n        }")

# Fix kycStatus quoting
content = content.replace('"kycStatus"', 'kycstatus')

# Add PG query logging
pool_decl = "const pool = new Pool({ connectionString: process.env.DATABASE_URL });"
pool_wrapper = """const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const originalQuery = pool.query;
pool.query = function(...args) {
    console.log('[PG QUERY]:', args[0]);
    if (args[1]) console.log('[PG PARAMS]:', args[1]);
    return originalQuery.apply(this, args);
};
"""
content = content.replace(pool_decl, pool_wrapper)

with open('C:/Users/Suban/OneDrive/Documents/vroomly-backend/index.js', 'w', encoding='utf-8') as f:
    f.write(content)
