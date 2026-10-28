// device_secrets.example.h — template for the local device credentials.
//
// The real file (device_secrets.h) is gitignored so the device password is never
// committed. Copy this file to device_secrets.h and fill in the values created by
// scripts/grant-roles.mjs:
//
//   cp "LilyGO TTGO T-SIM A7670G/device_secrets.example.h" \
//      "LilyGO TTGO T-SIM A7670G/device_secrets.h"
//
// Without device_secrets.h the sketch still compiles but has no device
// credentials, so it cannot authenticate and Firestore rejects its writes.
#pragma once

// Firebase Auth account the ESP32 signs in with (scripts/grant-roles.mjs --device-email).
const char DEVICE_EMAIL[]    = "";   // e.g. "device@yourproject.local"

// Password for that account (--device-pass). Keep this out of version control.
const char DEVICE_PASSWORD[] = "";