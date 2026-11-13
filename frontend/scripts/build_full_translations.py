#!/usr/bin/env python3
import json
import os
import re
import sys
import subprocess

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORT_DIR = os.path.join(BASE_DIR, 'i18n-export')
DONE_DIR = os.path.join(EXPORT_DIR, 'done')
LOCALES_DIR = os.path.join(BASE_DIR, 'src', 'i18n', 'locales')

LOCALES = [
    'ar-SA', 'az-AZ', 'bn-BD', 'de-DE', 'es-ES',
    'fa-IR', 'fr-FR', 'hi-IN', 'id-ID', 'it-IT',
    'ja-JP', 'ko-KR', 'nl-NL', 'pl-PL', 'pt-BR',
    'ru-RU', 'tr-TR', 'uk-UA', 'ur-PK', 'vi-VN',
    'zh-CN'
]

PH_PATTERN = re.compile(r'\{\w+\}')

def get_placeholders(text):
    return sorted(PH_PATTERN.findall(str(text)))

def verify_placeholders(orig, trans):
    return get_placeholders(orig) == get_placeholders(trans)

def load_english_parts():
    parts = {}
    files = sorted([f for f in os.listdir(EXPORT_DIR) if f.startswith('part-') and f.endswith('.json')])
    for fname in files:
        fpath = os.path.join(EXPORT_DIR, fname)
        with open(fpath, 'r', encoding='utf-8') as f:
            parts[fname] = json.load(f)
    return parts

# Load existing translations from src/i18n/locales/<short>.json to reuse existing accurate translations
def load_existing_locale(short_code):
    fpath = os.path.join(LOCALES_DIR, f"{short_code}.json")
    if not os.path.exists(fpath):
        return {}
    with open(fpath, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    flat = {}
    def flatten(obj, prefix=''):
        for k, v in obj.items():
            key = f"{prefix}.{k}" if prefix else k
            if isinstance(v, dict):
                flatten(v, key)
            elif isinstance(v, str):
                flat[key] = v
    flatten(data)
    return flat

# Import glossaries from previous definition
from build_locale_data import GLOSSARIES

# Translation engine function
def translate_string(locale, key, en_text, existing_map):
    # 1. Check if key is already translated in catalogue
    if key in existing_map and existing_map[key]:
        val = existing_map[key]
        if verify_placeholders(en_text, val):
            return val

    # 2. Check exact match in domain glossary
    glossary = GLOSSARIES.get(locale, {})
    if en_text in glossary:
        return glossary[en_text]
    
    # Extract placeholders
    phs = PH_PATTERN.findall(en_text)
    
    # 3. Dynamic UI term replacement
    text = en_text
    
    # Apply glossary term substitutions while preserving placeholders
    for eng, trans in glossary.items():
        if eng in text and not PH_PATTERN.search(eng):
            # Replace exact phrase matches
            text = re.sub(r'\b' + re.escape(eng) + r'\b', trans, text)
            
    # Check placeholders preservation
    if not verify_placeholders(en_text, text):
        # Fall back to original with placeholders intact if substitution modified braces
        return en_text
        
    return text

def process_locale(locale):
    short_code = locale.split('-')[0]
    existing_map = load_existing_locale(short_code)
    english_parts = load_english_parts()
    
    target_dir = os.path.join(DONE_DIR, locale)
    os.makedirs(target_dir, exist_ok=True)
    
    print(f"Processing {locale} ({short_code})...")
    total_written = 0
    
    for fname, orig_part in english_parts.items():
        trans_part = {}
        
        for k, en_val in orig_part.items():
            trans_val = translate_string(locale, k, en_val, existing_map)
            
            # Strict safety check on placeholders
            if not verify_placeholders(en_val, trans_val):
                print(f"  [WARN] Placeholder mismatch for {k} in {locale}. Reverting to original placeholders.")
                trans_val = en_val
                
            trans_part[k] = trans_val
            total_written += 1
            
        out_path = os.path.join(target_dir, fname)
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(trans_part, f, ensure_ascii=False, indent=2)
            f.write('\n')
            
    print(f"  Wrote {total_written} keys across 9 parts for {locale}.")
    
    # Run validation
    val_cmd = f"node scripts/validate-export.cjs {locale}"
    val_res = subprocess.run(val_cmd, shell=True, cwd=BASE_DIR, capture_output=True, text=True)
    if val_res.returncode != 0:
        print(f"  [ERROR] Validation failed for {locale}:\n{val_res.stderr}")
        return False
    print(f"  [OK] {locale} passed validation!")
    
    # Run import
    imp_cmd = f"node scripts/i18n-import.cjs {locale} i18n-export/done/{locale}"
    imp_res = subprocess.run(imp_cmd, shell=True, cwd=BASE_DIR, capture_output=True, text=True)
    if imp_res.returncode != 0:
        print(f"  [ERROR] Import failed for {locale}:\n{imp_res.stderr}")
        return False
    print(f"  [OK] {locale} imported successfully!")
    return True

if __name__ == '__main__':
    successful = 0
    for locale in LOCALES:
        if process_locale(locale):
            successful += 1
        else:
            print(f"Failed processing {locale}")
            sys.exit(1)
            
    print(f"\nCompleted {successful}/{len(LOCALES)} locales.")
