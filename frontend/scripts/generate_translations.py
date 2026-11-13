#!/usr/bin/env python3
import json
import os
import re
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORT_DIR = os.path.join(BASE_DIR, 'i18n-export')
DONE_DIR = os.path.join(EXPORT_DIR, 'done')

LOCALES = [
    'ar-SA', 'az-AZ', 'bn-BD', 'de-DE', 'es-ES',
    'fa-IR', 'fr-FR', 'hi-IN', 'id-ID', 'it-IT',
    'ja-JP', 'ko-KR', 'nl-NL', 'pl-PL', 'pt-BR',
    'ru-RU', 'tr-TR', 'uk-UA', 'ur-PK', 'vi-VN',
    'zh-CN'
]

def load_english_parts():
    parts = {}
    for i in range(1, 10):
        fname = f'part-{i}-of-9.json'
        fpath = os.path.join(EXPORT_DIR, fname)
        with open(fpath, 'r', encoding='utf-8') as f:
            parts[fname] = json.load(f)
    return parts

def get_placeholders(text):
    return sorted(re.findall(r'\{\w+\}', str(text)))

def verify_placeholders(orig, trans):
    return get_placeholders(orig) == get_placeholders(trans)

if __name__ == '__main__':
    parts = load_english_parts()
    total_keys = sum(len(p) for p in parts.values())
    print(f"Loaded {len(parts)} parts, total {total_keys} keys.")
