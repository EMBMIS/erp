const fs = require('fs');
const path = require('path');
const { validateLocale } = require('./validate-export.cjs');

const EXPORT_DIR = path.join(__dirname, '..', 'i18n-export');
const DONE_DIR = path.join(EXPORT_DIR, 'done');

const LOCALES = [
  { code: 'ar-SA', short: 'ar', name: 'Arabic' },
  { code: 'az-AZ', short: 'az', name: 'Azerbaijani' },
  { code: 'bn-BD', short: 'bn', name: 'Bengali' },
  { code: 'de-DE', short: 'de', name: 'German' },
  { code: 'es-ES', short: 'es', name: 'Spanish' },
  { code: 'fa-IR', short: 'fa', name: 'Persian' },
  { code: 'fr-FR', short: 'fr', name: 'French' },
  { code: 'hi-IN', short: 'hi', name: 'Hindi' },
  { code: 'id-ID', short: 'id', name: 'Indonesian' },
  { code: 'it-IT', short: 'it', name: 'Italian' },
  { code: 'ja-JP', short: 'ja', name: 'Japanese' },
  { code: 'ko-KR', short: 'ko', name: 'Korean' },
  { code: 'nl-NL', short: 'nl', name: 'Dutch' },
  { code: 'pl-PL', short: 'pl', name: 'Polish' },
  { code: 'pt-BR', short: 'pt', name: 'Portuguese (Brazil)' },
  { code: 'ru-RU', short: 'ru', name: 'Russian' },
  { code: 'tr-TR', short: 'tr', name: 'Turkish' },
  { code: 'uk-UA', short: 'uk', name: 'Ukrainian' },
  { code: 'ur-PK', short: 'ur', name: 'Urdu' },
  { code: 'vi-VN', short: 'vi', name: 'Vietnamese' },
  { code: 'zh-CN', short: 'zh', name: 'Chinese (Simplified)' },
];

const PH = /\{(\w+)\}/g;

function extractPlaceholders(s) {
  return (String(s).match(PH) || []).sort().join(',');
}

console.log('Registered locales:', LOCALES.length);
