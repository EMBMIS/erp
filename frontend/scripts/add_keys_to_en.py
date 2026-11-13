import json
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EN_FILE = os.path.join(BASE_DIR, 'src', 'i18n', 'locales', 'en.json')

with open(EN_FILE, 'r', encoding='utf-8') as f:
    en_tree = json.load(f)

if 'ui' not in en_tree:
    en_tree['ui'] = {}

en_tree['ui']['notAvailableForYourRole'] = "Not available for your role"
en_tree['ui']['unavailable'] = "Unavailable"

with open(EN_FILE, 'w', encoding='utf-8') as f:
    json.dump(en_tree, f, ensure_ascii=False, indent=2)
    f.write('\n')

print("Added notAvailableForYourRole and unavailable to en.json")
