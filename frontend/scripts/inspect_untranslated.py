import json
import os

with open('src/i18n/locales/en.json', 'r', encoding='utf-8') as f:
    en_data = json.load(f)

with open('src/i18n/locales/az.json', 'r', encoding='utf-8') as f:
    az_data = json.load(f)

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
az_flat = flatten(az_data)

untranslated = []
for k, en_val in en_flat.items():
    if az_flat.get(k) == en_val and len(en_val) > 2:
        untranslated.append((k, en_val))

print('Total untranslated in az.json:', len(untranslated))
print('Sample untranslated keys and values:')
for k, v in untranslated[:40]:
    print(f'  {k}: "{v}"')
