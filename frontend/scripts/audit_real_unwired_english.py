#!/usr/bin/env python3
"""
Comprehensive Auditor for unwired English text across all React JSX files in frontend/src/.
Searches for text nodes in JSX, th/td headers, placeholders, toasts, and column definitions
that do NOT use the t() i18n helper function.
"""

import os
import re

SRC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src')

# Regexes for detecting hardcoded text in JSX
JSX_TEXT = re.compile(r'>\s*([A-Za-z][A-Za-z0-9\s\,\.\-\_\:\?\!\/\(\)]+)\s*<')
PLACEHOLDER = re.compile(r'placeholder=["\']([^"\']+)["\']')
TITLE_PROP = re.compile(r'title=["\']([^"\']+)["\']')
TOAST_MSG = re.compile(r'toast\.(?:success|error|info|warning)\(["\']([^"\']+)["\']')
COL_HEADER = re.compile(r'header:\s*["\']([^"\']+)["\']')

results = {}

for root, _, files in os.walk(SRC_DIR):
    for file in files:
        if file.endswith('.jsx') or file.endswith('.js'):
            filepath = os.path.join(root, file)
            rel_path = os.path.relpath(filepath, SRC_DIR)
            
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()

            file_issues = []
            for idx, line in enumerate(lines, 1):
                # Skip comments, imports, logs, classNames, svg paths
                stripped = line.strip()
                if stripped.startswith('//') or stripped.startswith('import') or 'className=' in stripped or 'd="' in stripped or 'console.' in stripped:
                    continue
                
                # Check for JSX text not using t()
                if 't(' not in line:
                    for text in JSX_TEXT.findall(line):
                        text = text.strip()
                        if len(text) > 2 and not text.isdigit() and not text.isupper() and not text.startswith('bg-') and not text.startswith('text-'):
                            file_issues.append((idx, 'JSX Text', text))
                            
                    for ph in PLACEHOLDER.findall(line):
                        if len(ph) > 2:
                            file_issues.append((idx, 'Placeholder', ph))
                            
                    for title in TITLE_PROP.findall(line):
                        if len(title) > 2:
                            file_issues.append((idx, 'Title Prop', title))
                            
                    for toast in TOAST_MSG.findall(line):
                        if len(toast) > 2:
                            file_issues.append((idx, 'Toast Message', toast))

                    for col in COL_HEADER.findall(line):
                        if len(col) > 2:
                            file_issues.append((idx, 'Column Header', col))

            if file_issues:
                results[rel_path] = file_issues

print(f"=== COMPREHENSIVE UNWIRED ENGLISH AUDIT ({len(results)} FILES) ===")
total_issues = sum(len(v) for v in results.values())
print(f"Total unwired English occurrences: {total_issues}\n")

sorted_files = sorted(results.items(), key=lambda x: -len(x[1]))
for fpath, issues in sorted_files[:30]:
    print(f"FILE {fpath} ({len(issues)} occurrences):")
    for lnum, itype, txt in issues[:5]:
        print(f"   Line {lnum}: [{itype}] \"{txt}\"")
    if len(issues) > 5:
        print(f"   ... and {len(issues) - 5} more\n")
