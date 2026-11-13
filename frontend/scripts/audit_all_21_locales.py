import json
import os

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

print(f"Total English keys: {len(en_flat)}")

for fname in sorted(os.listdir(locales_dir)):
    if fname == 'en.json' or not fname.endswith('.json'):
        continue
    with open(os.path.join(locales_dir, fname), 'r', encoding='utf-8') as f:
        loc_data = json.load(f)
    loc_flat = flatten(loc_data)
    
    same_as_en = []
    for k, en_val in en_flat.items():
        loc_val = loc_flat.get(k, '')
        if loc_val == en_val and len(en_val) > 2 and not en_val.isdigit() and en_val not in ['CRM', 'ERP', 'ID', 'VAT', 'SKU', 'RFQ', 'AI']:
            same_as_en.append((k, en_val))
            
    pct_translated = ((len(en_flat) - len(same_as_en)) / len(en_flat)) * 100
    print(f"{fname.padEnd(8) if hasattr(fname, 'padEnd') else fname}: {len(same_as_en)} untranslated / {len(en_flat)} total ({pct_translated:.1f}% TRANSLATED!)")
