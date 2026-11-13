#!/usr/bin/env python3
import json
import os
import re
import subprocess
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

PH_PATTERN = re.compile(r'\{\w+\}')

def get_placeholders(text):
    return sorted(PH_PATTERN.findall(str(text)))

def verify_placeholders(orig, trans):
    return get_placeholders(orig) == get_placeholders(trans)

def load_english_parts():
    parts = {}
    for i in range(1, 10):
        fname = f'part-{i}-of-9.json'
        fpath = os.path.join(EXPORT_DIR, fname)
        with open(fpath, 'r', encoding='utf-8') as f:
            parts[fname] = json.load(f)
    return parts

print("Translator engine module initialized.")
