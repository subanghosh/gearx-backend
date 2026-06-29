import re

with open('C:/Users/Suban/OneDrive/Documents/vroomly-backend/index.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Find all occurrences of pool.query(
queries = re.findall(r'pool\.query\((.*?)\)', content, re.DOTALL)
for q in queries:
    if 'users' in q.lower() and 'kycstatus' in q.lower():
        print("MATCH:\n", q.strip()[:200])
