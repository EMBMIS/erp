#!/usr/bin/env python3
"""
Deep Auditor for Hardcoded English Text across all JSX files in frontend/src/.
Lists JSX files and specific line numbers that contain raw English string literals
instead of calling t('key').
"""

import os
import re

SRC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src')

# Pattern to detect candidate hardcoded English text in JSX elements/props
TEXT_JSX_PATTERN = re.compile(r'>\s*([A-Z][a-z0-9,.\'\s\-\:\?\!\(\)]+)\s*<')
PROPS_PATTERN = re.compile(r'(placeholder|title|label|heading|description|alt|toast\.(?:success|error|info|warning))\(\s*["\']([A-Z][a-z0-9,.\'\s\-\:\?\!]+)["\']')

unwired_files = {}

for root, _, files in os.walk(SRC_DIR):
    for f in files:
        if f.endswith('.jsx') or f.endswith('.js'):
            filepath = os.path.join(root, f)
            rel_path = os.path.relpath(filepath, SRC_DIR)
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as fp:
                lines = fp.readlines()
                
            matches = []
            for idx, line in enumerate(lines, 1):
                # Ignore import lines, console logs, comments, classNames, svg paths
                if line.strip().startswith('import') or 'console.log' in line or 'className=' in line or 'd="' in line:
                    continue
                    
                jsx_match = TEXT_JSX_PATTERN.findall(line)
                for m in jsx_match:
                    clean = m.strip()
                    # Filter out simple single-word technical tokens or numbers
                    if len(clean) > 3 and not clean.isupper() and not re.match(r'^\d+$', clean):
                        if '{t(' not in line and 't(' not in line:
                            matches.append((idx, 'JSX Text', clean))

            if matches:
                unwired_files[rel_path] = matches

print(f"=== HARDCODED JSX ENGLISH TEXT AUDIT ({len(unwired_files)} FILES) ===")
total_hardcoded = sum(len(m) for m in unwired_files.values())
print(f"Total candidate hardcoded English instances found: {total_hardcoded}\n")

for fpath, m_list in sorted(unwired_files.items(), key=lambda x: -len(x[1]))[:25]:
    print(f"{fpath} ({len(m_list)} instances):")
    for lnum, mtype, txt in m_list[:4]:
        print(f"   Line {lnum}: [{mtype}] \"{txt}\"")
    if len(m_list) > 4:
        print(f"   ... and {len(m_list) - 4} more\n")
