const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { validateLocale } = require('./validate-export.cjs');

const EXPORT_DIR = path.join(__dirname, '..', 'i18n-export');
const DONE_DIR = path.join(EXPORT_DIR, 'done');

const LOCALES = [
  'ar-SA', 'az-AZ', 'bn-BD', 'de-DE', 'es-ES',
  'fa-IR', 'fr-FR', 'hi-IN', 'id-ID', 'it-IT',
  'ja-JP', 'ko-KR', 'nl-NL', 'pl-PL', 'pt-BR',
  'ru-RU', 'tr-TR', 'uk-UA', 'ur-PK', 'vi-VN',
  'zh-CN'
];

const PH = /\{(\w+)\}/g;

function phOf(s) {
  return (String(s).match(PH) || []).sort().join(',');
}

console.log('Script loaded. Total locales to process:', LOCALES.length);
