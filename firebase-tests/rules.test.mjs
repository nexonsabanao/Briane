/**
 * rules.test.mjs — persona coverage for the locked-down BRIANE rules.
 *
 * Run (from this folder):
 *   npm install
 *   npm test          # starts the Firestore emulator via firebase-tools CLI
 *
 * Personas mirror scripts/grant-roles.mjs custom claims:
 *   device  → { role: 'device' }
 *   admin   → { role: 'admin' }
 *   user    → email_verified, no claim
 *
 * The system is Firestore-only (live telemetry lives in weather/current), so this
 * suite tests Firestore rules exclusively. There is no Realtime Database anymore.
 */
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'node:test';
import {
  doc, getDoc, setDoc, updateDoc, collection, addDoc, getDocs, query,
} from 'firebase/firestore';

let testEnv;

const PROJECT_ID = 'briane-rules-test';

function authedDb(uid, claims = {}, emailVerified = true) {
  return testEnv.authenticatedContext(uid, { ...claims, email_verified: emailVerified }).firestore();
}
function unauthedDb() {
  return testEnv.unauthenticatedContext().firestore();
}

function readRules(p) {
  return readFileSync(new URL(p, import.meta.url), 'utf8');
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readRules('../firestore.rules') },
  });
});

beforeEach(async () => {
  await testEnv.clearFirestore();

  // Seed: admin profile doc + existing usersVersion baseline.
  const admin = authedDb('admin-1', { role: 'admin' });
  await assertSucceeds(setDoc(doc(admin, 'users', 'admin-1'), { role: 'admin', email: 'a@a' }));
  const device = authedDb('device-1', { role: 'device' });
  await assertSucceeds(setDoc(doc(device, 'weather/config'), { usersVersion: 100 }, { merge: true }));
});

afterAll(async () => {
  await testEnv.cleanup();
});

describe('ANONYMOUS', () => {
  it('can READ public telemetry + config', async () => {
    const db = unauthedDb();
    await assertSucceeds(getDoc(doc(db, 'weather/config')));
    await assertSucceeds(getDoc(doc(db, 'weather/current')));
    await assertSucceeds(getDocs(query(collection(db, 'weather_history'))));
  });

  it('cannot WRITE anything', async () => {
    const db = unauthedDb();
    await assertFails(updateDoc(doc(db, 'weather/config'), { alertL3Rain: 0.01 }));
    await assertFails(setDoc(doc(db, 'weather/current'), { waterLevel: 5 }));
    await assertFails(addDoc(collection(db, 'logs'), { type: 'X', message: 'spam' }));
    await assertFails(addDoc(collection(db, 'weather_history'), { temperature: 99 }));
    await assertFails(getDocs(query(collection(db, 'users')))); // list denied
  });
});

describe('DEVICE (claim role=device)', () => {
  it('can write Firestore weather/current and create history/log docs', async () => {
    const db = authedDb('device-1', { role: 'device' });
    await assertSucceeds(setDoc(doc(db, 'weather/current'), { waterLevel: 12.5, temperature: 27 }, { merge: true }));
    await assertSucceeds(addDoc(collection(db, 'weather_history'), { timestamp: 't' }));
    await assertSucceeds(addDoc(collection(db, 'logs'), { type: 'SIM', message: 'ok' }));
  });

  it('can ONLY reset manualSmsTrigger to false in config', async () => {
    const db = authedDb('device-1', { role: 'device' });
    await assertSucceeds(
      setDoc(doc(db, 'weather/config'),
        { manualSmsTrigger: false }, { merge: true })
    );
    await assertFails(
      setDoc(doc(db, 'weather/config'),
        { manualSmsTrigger: true }, { merge: true })
    );
    await assertFails(
      setDoc(doc(db, 'weather/config'),
        { alertL3Rain: 0 }, { merge: true })
    );
  });

  it('can ONLY consume sensorResetTrigger back to false in config', async () => {
    const db = authedDb('device-1', { role: 'device' });
    await assertSucceeds(
      setDoc(doc(db, 'weather/config'),
        { sensorResetTrigger: false }, { merge: true })
    );
    await assertFails(
      setDoc(doc(db, 'weather/config'),
        { sensorResetTrigger: true }, { merge: true })
    );
    await assertFails(
      setDoc(doc(db, 'weather/config'),
        { sensorResetTrigger: false, alertL3Rain: 0 }, { merge: true })
    );
  });

  it('can read (but not write) user profiles for the SMS cache', async () => {
    const db = authedDb('device-1', { role: 'device' });
    await assertSucceeds(getDocs(query(collection(db, 'users'))));

    const victim = authedDb('victim-1');
    await assertSucceeds(setDoc(doc(victim, 'users', 'victim-1'),
      { role: 'user', phoneNumber: '+639170000000' }));
    const asDevice = authedDb('device-1', { role: 'device' });
    await assertFails(updateDoc(doc(asDevice, 'users', 'victim-1'), { disabled: true }));
  });
});

describe('VERIFIED USER', () => {
  it('can bump usersVersion FORWARD only', async () => {
    const db = authedDb('user-1');
    await assertSucceeds(setDoc(doc(db, 'weather/config'), { usersVersion: 200 }, { merge: true }));
    await assertFails(setDoc(doc(db, 'weather/config'), { usersVersion: 50 }, { merge: true }));
  });

  it('cannot touch other config fields or telemetry', async () => {
    const db = authedDb('user-1');
    await assertFails(setDoc(doc(db, 'weather/config'), { wifiPass: 'hax' }, { merge: true }));
    await assertFails(setDoc(doc(db, 'weather/current'), { waterLevel: 0 }, { merge: true }));
    await assertFails(addDoc(collection(db, 'weather_history'), {}));
  });

  it('can update own phoneNumber but not role/disabled', async () => {
    const me = authedDb('user-1');
    await assertSucceeds(setDoc(doc(me, 'users', 'user-1'), { role: 'user' }));
    await assertSucceeds(updateDoc(doc(me, 'users', 'user-1'), { phoneNumber: '+639171111111' }));
    await assertFails(updateDoc(doc(me, 'users', 'user-1'), { role: 'admin' }));
  });

  it('unverified accounts cannot bump usersVersion', async () => {
    const db = authedDb('troll-1', {}, false);
    await assertFails(setDoc(doc(db, 'weather/config'), { usersVersion: 999 }, { merge: true }));
  });
});

describe('ADMIN (claim role=admin)', () => {
  it('has full config control incl. Firestore current (simulation push)', async () => {
    const db = authedDb('admin-1', { role: 'admin' });
    await assertSucceeds(setDoc(doc(db, 'weather/config'), { alertCooldown: 2, wifiPass: 'new' }, { merge: true }));
    await assertSucceeds(setDoc(doc(db, 'weather/current'), { isSimulated: true }, { merge: true }));
  });

  it('can manage users and logs', async () => {
    const admin = authedDb('admin-1', { role: 'admin' });
    await assertSucceeds(getDocs(query(collection(admin, 'logs'))));
    const target = authedDb('u2');
    await assertSucceeds(setDoc(doc(target, 'users', 'u2'), { role: 'user' }));
    await assertSucceeds(updateDoc(doc(admin, 'users', 'u2'), { disabled: true }));
  });
});
