import json
import os

with open('src/i18n/locales/en.json', 'r', encoding='utf-8') as f:
    en_data = json.load(f)

with open('src/i18n/locales/az.json', 'r', encoding='utf-8') as f:
    az_data = json.load(f)

def flatten(obj, prefix=''):
    flat = {}
    for k, v in obj.items():
        key = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            flat.update(flatten(v, key))
        elif isinstance(v, str):
            flat[key] = v
    return flat

en_flat = flatten(en_data)
az_flat = flatten(az_data)

untranslated = {}
for k, en_val in en_flat.items():
    if az_flat.get(k) == en_val and len(en_val) > 2:
        section = k.split('.')[0]
        untranslated.setdefault(section, []).append((k, en_val))

print(f"Total remaining untranslated: {sum(len(v) for v in untranslated.values())}")
for section, items in sorted(untranslated.items()):
    print(f"Section '{section}': {len(items)} items. Samples:")
    for k, v in items[:5]:
        # Escape any special unicode chars for clean printing on Windows
        v_clean = repr(v)
        print(f"   {k}: {v_clean}")
