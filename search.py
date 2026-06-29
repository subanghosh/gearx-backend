with open('C:/Users/Suban/OneDrive/Documents/vroomly-backend/index.js', 'r', encoding='utf-8') as f:
    for i, line in enumerate(f):
        if 'kycStatus' in line and '"' in line:
            print(f"{i+1}: {line.strip()}")
