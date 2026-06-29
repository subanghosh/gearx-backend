import sys
lines=open('C:/Users/Suban/OneDrive/Documents/vroomly-backend/index.js', 'r', encoding='utf-8').readlines()
for i, l in enumerate(lines):
    if '"kycStatus"' in l:
        print(f'{i+1}: {l}')
