import sys

with open('C:/Users/Suban/OneDrive/Documents/vroomly-backend/index.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Fix syntax error on line 548
if lines[547].strip() == '});':
    lines[547] = '        }\n'

# Fix kycStatus quotes on line 1148
if '"kycStatus"' in lines[1148]:
    lines[1148] = lines[1148].replace('"kycStatus"', 'kycstatus')

# Add PG query logging
for i, line in enumerate(lines):
    if line.strip() == "const pool = new Pool({ connectionString: process.env.DATABASE_URL });":
        lines[i] = """const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const originalQuery = pool.query;
pool.query = function(...args) {
    console.log('[PG QUERY]:', args[0]);
    if (args[1]) console.log('[PG PARAMS]:', args[1]);
    return originalQuery.apply(this, args);
};
"""
        break

with open('C:/Users/Suban/OneDrive/Documents/vroomly-backend/index.js', 'w', encoding='utf-8') as f:
    f.writelines(lines)
