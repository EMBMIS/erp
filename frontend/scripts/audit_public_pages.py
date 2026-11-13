import os
import re
import json

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCALES_DIR = os.path.join(BASE_DIR, 'src', 'i18n', 'locales')

def flatten(obj, prefix=''):
    flat = {}
    for k, v in obj.items():
        key = f'{prefix}.{k}' if prefix else k
        if isinstance(v, dict):
            flat.update(flatten(v, key))
        elif isinstance(v, str):
            flat[key] = v
    return flat

with open(os.path.join(LOCALES_DIR, 'en.json'), 'r', encoding='utf-8') as f:
    en_flat = flatten(json.load(f))

public_files = [
    'src/pages/Login.jsx',
    'src/pages/Signup.jsx',
    'src/pages/VerifyEmail.jsx',
    'src/pages/CustomerContractResponse.jsx',
    'src/pages/CustomerDeliveryConfirmation.jsx',
    'src/pages/CustomerOrderResponse.jsx',
    'src/pages/CustomerQuotationResponse.jsx',
    'src/pages/DeliveryConfirmationSuccess.jsx',
    'src/pages/supplier-portal/DeliveryStatus.jsx',
    'src/pages/supplier-portal/PartnershipInvitation.jsx',
    'src/pages/supplier-portal/RFQResponse.jsx',
    'src/pages/supplier-portal/SalesRfqResponse.jsx',
    'src/pages/supplier-portal/SupplierPortalDashboard.jsx',
    'src/pages/supplier-portal/ThankYou.jsx'
]

t_pattern = re.compile(r"t\(['\"]([^'\"]+)['\"]\)")
jsx_text_pattern = re.compile(r">([^<>{}\n]+)<")

print("=== AUDIT OF PUBLIC PAGES ===")
for rel_path in public_files:
    filepath = os.path.join(BASE_DIR, rel_path)
    if os.path.exists(filepath):
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
        
        t_calls = t_pattern.findall(content)
        missing_keys = [k for k in t_calls if k not in en_flat]
        
        raw_texts = [t.strip() for t in jsx_text_pattern.findall(content) if t.strip() and not t.strip().startswith('import') and len(t.strip()) > 1]
        
        print(f"{os.path.basename(filepath)}:")
        print(f"   t() calls: {len(t_calls)}, Missing in en.json: {len(missing_keys)}")
        if missing_keys:
            print(f"   Missing keys: {missing_keys[:10]}")
        print(f"   Raw JSX text nodes (hardcoded): {len(raw_texts)}")
        if raw_texts:
            print(f"   Samples of raw text: {raw_texts[:5]}")
        print("-" * 50)
