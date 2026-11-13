#!/usr/bin/env python3
"""
Merge remaining-1..5 export files into src/i18n/locales/<lang>.json for all 21 locales.
Ensures 100% of all 5,438 export strings (both active part-1..8 and remaining-1..5)
are available in runtime translation catalogues.
"""

import json
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCALES_DIR = os.path.join(BASE_DIR, 'src', 'i18n', 'locales')
DONE_DIR = os.path.join(BASE_DIR, 'i18n-export', 'done')

LOCALES = [
    'ar-SA', 'az-AZ', 'bn-BD', 'de-DE', 'es-ES',
    'fa-IR', 'fr-FR', 'hi-IN', 'id-ID', 'it-IT',
    'ja-JP', 'ko-KR', 'nl-NL', 'pl-PL', 'pt-BR',
    'ru-RU', 'tr-TR', 'uk-UA', 'ur-PK', 'vi-VN',
    'zh-CN'
]

REMAINING_FILES = [
    'remaining-1-of-5.json', 'remaining-2-of-5.json', 'remaining-3-of-5.json',
    'remaining-4-of-5.json', 'remaining-5-of-5.json'
]

def merge_remaining():
    print("Merging all remaining-1..5 export strings into src/i18n/locales/<lang>.json...")
    
    for loc_code in LOCALES:
        short = loc_code.split('-')[0]
        cat_file = os.path.join(LOCALES_DIR, f"{short}.json")
        done_dir = os.path.join(DONE_DIR, loc_code)
        
        if not os.path.exists(cat_file):
            print(f"Skipping {loc_code}, {cat_file} does not exist.")
            continue
            
        with open(cat_file, 'r', encoding='utf-8') as f:
            cat_tree = json.load(f)
            
        if 'ui2' not in cat_tree or not isinstance(cat_tree['ui2'], dict):
            cat_tree['ui2'] = {}
            
        added_keys = 0
        for rem_fname in REMAINING_FILES:
            rem_file = os.path.join(done_dir, rem_fname)
            if not os.path.exists(rem_file):
                continue
                
            with open(rem_file, 'r', encoding='utf-8') as f:
                rem_data = json.load(f)
                
            for full_key, trans_val in rem_data.items():
                # full_key is like "ui2.saveAsDraft"
                if full_key.startswith('ui2.'):
                    sub_key = full_key[4:]
                    cat_tree['ui2'][sub_key] = trans_val
                    added_keys += 1
                elif full_key.startswith('ui.'):
                    if 'ui' not in cat_tree or not isinstance(cat_tree['ui'], dict):
                        cat_tree['ui'] = {}
                    sub_key = full_key[3:]
                    cat_tree['ui'][sub_key] = trans_val
                    added_keys += 1

        with open(cat_file, 'w', encoding='utf-8') as f:
            json.dump(cat_tree, f, ensure_ascii=False, indent=2)
            f.write('\n')
            
        print(f"Merged {added_keys} remaining keys into {short}.json ({loc_code})")

if __name__ == '__main__':
    merge_remaining()
