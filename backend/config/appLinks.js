/**
 * Browser-facing app links (email CTAs, OAuth redirect targets, billing
 * URLs) — every link the backend hands to a browser must come from here.
 *
 * The app can be served at the root of its host (the default) or under a
 * path of a shared host, e.g. https://example.com/erp. APP_BASE_PATH names
 * that path ('/erp', empty for the root). The frontend is built for the same
 * path (VITE_BASE_PATH, see vite.config.js and docker-compose.prod.yml), so
 * the prefix lives in one setting for both.
 */

function originFor(envName, fallback) {
  return (process.env[envName] || fallback).replace(/\/+$/, '');
}

function pathPrefix() {
  return (process.env.APP_BASE_PATH || '').replace(/\/+$/, '');
}

/** Frontend app links: login/reset/supplier-portal pages. */
function appBase() {
  return `${originFor('FRONTEND_URL', 'http://localhost:3000')}${pathPrefix()}`;
}

/** Backend API entry through the same host: OAuth redirect_uris. */
function apiBase() {
  return `${originFor('BASE_URL', 'http://localhost:3001')}${pathPrefix()}`;
}

module.exports = { appBase, apiBase };
