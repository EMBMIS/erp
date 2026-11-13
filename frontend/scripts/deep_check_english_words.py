import json
import os
import re

locales_dir = 'src/i18n/locales'
with open(os.path.join(locales_dir, 'en.json'), 'r', encoding='utf-8') as f:
    en_data = json.load(f)

def flatten(obj, prefix=''):
    flat = {}
    for k, v in obj.items():
        key = f'{prefix}.{k}' if prefix else k
        if isinstance(v, dict):
            flat.update(flatten(v, key))
        elif isinstance(v, str):
            flat[key] = v
    return flat

en_flat = flatten(en_data)

# Common english words that indicate untranslated UI text
ENGLISH_WORDS = set([
    'Create', 'Edit', 'Delete', 'View', 'Search', 'Filter', 'Select', 'Enter', 'No', 'found',
    'Item', 'Items', 'Warehouse', 'Supplier', 'Suppliers', 'Customer', 'Customers', 'Order', 'Orders',
    'Invoice', 'Invoices', 'Payment', 'Payments', 'Report', 'Settings', 'Overview', 'History',
    'Details', 'Management', 'Dashboard', 'Approval', 'Approvals', 'Status', 'Actions',
    'Total', 'Amount', 'Date', 'Price', 'Quantity', 'Tax', 'Discount', 'Balance', 'Required'
])

for fname in sorted(os.listdir(locales_dir)):
    if fname == 'en.json' or not fname.endswith('.json'):
        continue
    with open(os.path.join(locales_dir, fname), 'r', encoding='utf-8') as f:
        loc_data = json.load(f)
    loc_flat = flatten(loc_data)
    
    matches = []
    for k, v in loc_flat.items():
        # Check if value contains any English keywords
        words = set(re.findall(r'\b[A-Za-z]+\b', v))
        eng_found = words.intersection(ENGLISH_WORDS)
        if eng_found and fname not in ['en.json']:
            matches.append((k, v, eng_found))
            
    print(f"{fname}: {len(matches)} keys containing English words.")
    for k, v, eng_found in matches[:5]:
        # Clean print for windows console
        v_clean = v.encode('ascii', 'replace').decode('ascii')
        print(f"   {k}: '{v_clean}' (found: {list(eng_found)})")
