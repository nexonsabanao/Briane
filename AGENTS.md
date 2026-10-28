# Flood Alert System Agent

This repository contains a weather-based flood alert system with an ESP32 firmware project and a Firebase web dashboard.

## Scope
- Firmware lives in `LilyGO TTGO T-SIM A7670G/code_nosleep.ino` — the active no-sleep sketch (ESP32 stays awake under a 90 s watchdog). It is the only firmware file in the repo; there is no `code.ino`.
- Frontend and admin UI live under `Web UI/`.
- Shared configuration is described in `README.md` and `Web UI/firebase-config.js`.

## Mission
Support development of the flood monitoring system by helping with:
- Arduino/ESP32 firmware updates and debugging
- Firebase data model and web dashboard updates
- admin and dashboard logic improvements
- hardware and sensor integration work
- configuration and reliability improvements

## Working rules
- Keep the firmware and web app compatible with the existing Firebase schema and device data flow.
- Prefer small, targeted changes that preserve the project architecture.
- Maintain the README as the source of truth for setup and hardware assumptions.
- When editing sensor or alert logic, keep threshold behavior consistent with the documented flood logic.
- Use plain JavaScript, HTML, and CSS for the web UI unless a project-wide requirement justifies a framework.
- Preserve the existing folder structure and file naming conventions.
- Avoid introducing dependencies unless they are clearly justified by the project.

## High-priority files
- `README.md`
- `LilyGO TTGO T-SIM A7670G/code_nosleep.ino`
- `Web UI/firebase-config.js`
- `Web UI/dashboard/dashboard.js`
- `Web UI/admin/admin-dashboard.js`
- `firestore.rules`

## Constraints
- Do not silently break GSM/GPS or sensor communication flows.
- Do not remove alert logic or emergency mode behavior without a clear justification.
- Do not hardcode Firebase credentials into committed files unless explicitly required for local development.
- Keep device setup instructions and configuration values aligned with the deployed project.

## Preferred workflow
1. Review the relevant firmware or web file before making changes.
2. Validate the smallest possible behavior or syntax check after the edit.
3. Keep commit scope narrow and relevant to the issue being fixed.
4. If a change affects both firmware and web UI, update both sides together.

## Build & validation
Firmware uses ArduinoJson v7+ (won't compile on v6). The sketch folder name must match the `.ino` name, so copy it into a matching folder first:

```bash
arduino-cli compile --fqbn esp32:esp32:esp32 <sketch-folder>
```

- Board: **ESP32 Dev Module** (`esp32:esp32:esp32`). All pins are `#define`d in the sketch.
- Flash budget is tight — the sketch sits at ~93% of program storage; check the size line after every compile.
- Apply `scripts/tinygsm-a76xxssl-peer-close.patch` (or copy `scripts/tinygsm-patched/TinyGsmClientA76xxSSL.h` over the stock file) before compiling — the stock driver strands socket data on the A7670 and breaks cellular HTTPS.
- Web UI is plain HTML/JS/CSS; validate JS with `node --check`.
- Firestore rules tests live in `firebase-tests/` (`npm test`, needs Java + the Firestore emulator). Deploy rules with `firebase deploy --only firestore:rules`.

## Expected outputs
- Clear, minimal code edits
- Safe handling of Firebase and device connectivity issues
- Documentation updates when behavior or setup changes
- Stability-first fixes for alerts, sensors, and cloud sync
