def search_backend_index():
    with open(r"c:\Users\Suban\OneDrive\Documents\vroomly-backend\index.js", 'r', encoding='utf-8') as f:
        for idx, line in enumerate(f, 1):
            if "static" in line or "customer" in line or "marshal" in line:
                if len(line) < 120:
                    print(f"{idx}: {line.strip()}")

search_backend_index()
