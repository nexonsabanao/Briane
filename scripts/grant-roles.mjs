#!/usr/bin/env node
/**
 * grant-roles.mjs — one-time identity setup for the BRIANE flood alert system.
 *
 * What it does:
 *   1. Creates the dedicated DEVICE Firebase Auth account the ESP32 signs in with.
 *   2. Sets custom claims:  { role: 'device' } on the device account,
 *                           { role: 'admin' } on any human admins you pass.
 *   3. Optionally sets the device account's initial password (--device-pass).
 *
 * Custom claims are what firestore.rules keys off of:
 *   auth.token.role == 'device'  → may write weather/current, reset manualSmsTrigger
 *   auth.token.role == 'admin'   → full config control (Firestore can read Firestore docs,
 *                                  so admin access is also allowed via the users/{uid}.role doc)
 *
 * Usage:
 *   npm install firebase-admin            # once, in this folder
 *   # Put your service account key at ./serviceAccountKey.json (Firebase Console →
 *   # Project settings → Service accounts → Generate new private key)
 *   node grant-roles.mjs --device-email device@briane.local \
 *        [--device-pass 'long-random-password'] \
 *        [--admin-email you@example.com] [--admin-email second.admin@example.com]
 *
 * IMPORTANT: after granting/removing claims, affected users must sign in again
 * (or refresh their token) before the new role takes effect. The ESP32 picks the
 * claim up on its next automatic token mint (~1 h TTL).
 */

import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

// Resolve serviceAccountKey.json next to THIS script, regardless of where
// you invoke node from.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const deviceEmail = arg('device-email');
const devicePass = arg('device-pass');
const adminPass = arg('admin-pass');
const adminEmails = process.argv.flatMap((v, i) =>
  v === '--admin-email' ? [process.argv[i + 1]] : []);

if (!deviceEmail) {
  console.error('Usage: node grant-roles.mjs --device-email <email> [--device-pass <pw>] [--admin-email <email> ...] [--admin-pass <pw>]');
  process.exit(1);
}

const keyPath = arg('service-account') || join(SCRIPT_DIR, 'serviceAccountKey.json');
if (!existsSync(keyPath)) {
  console.error(`Missing ${keyPath}. Generate a private key in Firebase Console → Project settings → Service accounts.`);
  process.exit(1);
}

initializeApp({ credential: cert(keyPath) });
const auth = getAuth();

async function ensureUser(email, password, emailVerified) {
  try {
    const user = await auth.getUserByEmail(email);
    console.log(`Found existing account: ${email} (uid ${user.uid})`);
    if (password) await auth.updateUser(user.uid, { password });
    return user.uid;
  } catch {
    const pw = password || randomUUID() + 'Aa1!';
    const user = await auth.createUser({
      email,
      password: pw,
      emailVerified,
      disabled: false,
    });
    console.log(`Created account: ${email} (uid ${user.uid})`);
    if (!password) console.log(`  ⚠️ Random password generated: ${pw}`);
    return user.uid;
  }
}

const deviceUid = await ensureUser(deviceEmail, devicePass, true);
await auth.setCustomUserClaims(deviceUid, { role: 'device' });
console.log(`✅ role=device claim set on ${deviceEmail}`);

for (const email of adminEmails) {
  const uid = await ensureUser(email, adminPass, true);
  await auth.setCustomUserClaims(uid, { role: 'admin' });
  console.log(`✅ role=admin claim set on ${email}`);
}

console.log('\nNext steps:');
console.log(' 1. Put the SAME email + password into code_nosleep.ino DEVICE_EMAIL / DEVICE_PASSWORD.');
console.log(' 2. Flash the firmware BEFORE deploying the tightened rules.');
console.log(' 3. Verify serial log shows "[AUTH] ✅ Device signed in."');
console.log(' 4. Then deploy: firebase deploy --only firestore:rules,hosting');
