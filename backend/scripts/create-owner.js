#!/usr/bin/env node
/**
 * Create (or reset the password of) the platform-owner account.
 *
 * Goes through models/User rather than writing SQL, so the password is hashed
 * exactly the way login verifies it — bcrypt, 10 rounds. A hand-written INSERT
 * with a hash produced some other way is the classic way to end up with an
 * account that exists and cannot log in.
 *
 * Credentials come from the ENVIRONMENT, not argv:
 *
 *   OWNER_EMAIL=qira@erp.com OWNER_PASSWORD='…' node scripts/create-owner.js
 *
 * Arguments land in shell history and in `ps` output for every user on the
 * box; a leading space before the command keeps it out of history entirely in
 * bash (HISTCONTROL=ignorespace) and most other shells.
 *
 * This only creates the LOGIN. It does not grant owner rights — those come
 * from PLATFORM_OWNER_EMAIL in the server environment, which is checked per
 * request. Setting one without the other does nothing useful, by design:
 * ownership is deployment configuration, not a property of a row that anyone
 * with database access could flip.
 */
require('dotenv').config();
const { pool } = require('../config/database');
const User = require('../models/User');

const email = (process.env.OWNER_EMAIL || '').trim().toLowerCase();
const password = process.env.OWNER_PASSWORD || '';
const firstName = process.env.OWNER_FIRST_NAME || 'Platform';
const lastName = process.env.OWNER_LAST_NAME || 'Owner';

async function main() {
  if (!email || !password) {
    console.error('Set OWNER_EMAIL and OWNER_PASSWORD in the environment.');
    console.error("  OWNER_EMAIL=you@example.com OWNER_PASSWORD='…' node scripts/create-owner.js");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('OWNER_PASSWORD must be at least 8 characters.');
    process.exit(1);
  }

  const existing = await User.findByEmail(email);

  if (existing) {
    // Reset rather than fail. Re-running this is the normal way to recover a
    // lost owner password, and a script that only works once is a script you
    // cannot use in the situation you actually need it.
    // setPassword, not changePassword: the latter demands the current password,
    // which is exactly what someone running this script does not have. It also
    // clears must_change_password itself, so that is not repeated below.
    await User.setPassword(existing.id, password);
    await pool.query(
      `UPDATE users SET role = 'ADMIN', is_active = true, email_verified = true WHERE id = $1`,
      [existing.id]
    );
    console.log(`Updated existing account: ${email} (password reset, role ADMIN, active)`);
  } else {
    const user = await User.create({
      email,
      password,
      first_name: firstName,
      last_name: lastName,
      role: 'ADMIN',
    });
    // Marked verified, because otherwise this account cannot log in at all.
    // users.email_verified defaults to false and User.authenticate throws
    // EMAIL_NOT_VERIFIED on it, so a freshly created owner would be locked out
    // waiting for a confirmation mail — which never arrives if the address is
    // an internal one on a domain the deployment does not receive mail for.
    //
    // Legitimate here and nowhere else: verification exists to prove that a
    // SELF-REGISTERING stranger controls the address they claimed. Whoever runs
    // this already has shell access to the server, so there is nothing left for
    // that check to establish.
    await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [user.id]);
    console.log(`Created account: ${user.email} (role ${user.role}, email verified)`);
  }

  const configured = (process.env.PLATFORM_OWNER_EMAIL || '').trim().toLowerCase();
  if (configured !== email) {
    console.log('');
    console.log('The login now exists, but it is NOT yet the platform owner.');
    console.log(`  PLATFORM_OWNER_EMAIL is currently ${configured ? `"${configured}"` : 'unset'}.`);
    console.log(`  Set PLATFORM_OWNER_EMAIL=${email} in backend/.env and restart the backend.`);
  } else {
    console.log('PLATFORM_OWNER_EMAIL already matches — App Statistics will be visible after signing in again.');
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Failed:', err.message);
    pool.end();
    process.exit(1);
  });
