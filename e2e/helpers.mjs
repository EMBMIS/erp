// Shared helpers for the cross-module E2E journeys.
//
// Every journey seeds its own admin user (unique email per run) through the
// public /api/auth/register endpoint, logs in through the real login page, and
// then creates data that carries a run-specific suffix so reruns on a shared
// database never collide.
//
// NOTE: no `import.meta` here — Playwright's transform pipeline loads helper
// files as CommonJS, so ESM-only syntax explodes at load time. The DB seeding
// helper lives in db.cjs for the same reason.

import { promoteToAdmin } from './db.cjs';

export const E2E_PASSWORD = 'E2Epass!234';

/** Run-specific suffix (time + random) so reruns cannot collide. */
export function makeSuffix(prefix = '') {
  const rand = Math.floor(Math.random() * 1296).toString(36);
  return `${prefix}${Date.now().toString(36)}${rand}`;
}

/**
 * Register (or, on a once-in-a-blue-moon email collision, log into) a
 * dedicated ADMIN user for this run. Returns credentials + JWT.
 */
export async function seedAdminUser(request) {
  const suffix = makeSuffix();
  const email = `e2e.${suffix}@gmail.com`;
  const payload = {
    email,
    password: E2E_PASSWORD,
    first_name: 'E2E',
    last_name: 'Journeys',
    role: 'ADMIN',
  };

  // Registration ignores (and rejects) a requested role: every self-registration is a USER. Register, promote the
  // throw-away user in the database, then log in so the token carries the ADMIN role.
  const { role: _requested, ...registration } = payload;
  let res = await request.post('/api/auth/register', { data: registration });
  if (res.status() === 400) {
    res = await request.post('/api/auth/login', { data: { email, password: E2E_PASSWORD } });
  } else if (res.ok() && (await promoteToAdmin(email))) {
    res = await request.post('/api/auth/login', { data: { email, password: E2E_PASSWORD } });
  }
  if (!res.ok()) {
    throw new Error(`Failed to seed admin user: ${res.status()} ${(await res.text()).slice(0, 300)}`);
  }
  const body = await res.json();
  return { suffix, email, password: E2E_PASSWORD, user: body.data.user, token: body.data.token };
}

/** Log in through the real login page. Fails loudly if the form is not there. */
export async function loginViaUi(page, { email, password }) {
  await page.goto('/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForURL((url) => url.pathname !== '/login', { timeout: 20000 }),
    page.click('button[type="submit"]'),
  ]);
}

/** Small JSON helper over the request fixture with a bearer token attached. */
export async function api(request, token, method, path, data) {
  const opts = { headers: { Authorization: `Bearer ${token}` } };
  if (data !== undefined) opts.data = data;
  const res = await request[method](path, opts);
  const body = res.status() === 204 ? null : await res.json().catch(() => null);
  if (!res.ok()) {
    throw new Error(`${method.toUpperCase()} ${path} -> ${res.status()}: ${JSON.stringify(body)?.slice(0, 300)}`);
  }
  return { status: res.status(), body };
}
