# Flood Alert System

Flood monitoring station for a barangay in the Philippines. An ESP32 board (LilyGO TTGO T-SIM A7670G) reads the weather and water level sensors, uploads everything to Firebase, and sends SMS flood alerts to registered residents. There is a public dashboard and an admin panel, both plain HTML/JS.

## What it does

- Reads temperature, humidity, pressure (BME280), light (BH1750), rainfall (tipping bucket), and water level (AJ-SR04T ultrasonic).
- Tracks how fast the water rises. Positive value = rising, negative = draining.
- Sends SMS alerts in three tiers (Advisory / Warning / Emergency). Thresholds are set in the admin panel.
- Uploads to Firestore live. When the network is down, readings are queued on flash and synced later.
- The admin panel can change WiFi, thresholds, cooldowns, and can remotely reset the rain and ultrasonic data. GPS is not affected by the reset.

---

## Hardware

Board: LilyGO TTGO T-SIM A7670G. A plain ESP32 with a SIMCOM A7670 modem and GPS.

| Component | Pins |
| --- | --- |
| BME280 + BH1750 (I2C) | SDA 32, SCL 33 |
| Ultrasonic | Trig 14, Echo 36 |
| Rain gauge | 34 (interrupt) |
| GPS | TX 21, RX 22, RST 5 |
| Modem | TX 26, RX 27, PwrKey 4 |

Wiring notes that will bite you if ignored:

- The rain gauge pin (GPIO 34) is input-only and has no internal pull-up. It needs an external 10k resistor to 3.3V. Never pull it to 5V, the pin is not 5V tolerant.
- The ultrasonic Echo pin puts out 5V when the sensor runs on 5V, and GPIO 36 is not 5V tolerant either. Use a voltage divider (1k/2k works).
- The ultrasonic cannot measure anything closer than 25cm. Mount it high enough that the water never gets that close, even at peak flood.
- Water level = mountHeight - distance + offset. Both values are editable in the admin panel. If you move the sensor, re-measure mountHeight or every reading will be wrong.
- The power supply must survive ~2A GSM transmit spikes. A weak supply browns out the modem mid-SMS.
- The SIM must be registered (PH SIM Registration Act) and have load, or alerts silently stop. The device checks its balance daily.
- For RF-heavy sites: add 100 nF ceramic + 470–1000 µF bulk capacitance near the ultrasonic sensor, use twisted or shielded cable for long sensor runs, keep GSM antenna/modem power wires away from sensor wires, and consider a separate regulated supply for the ultrasonic.

---

## Firmware

`code_nosleep.ino` is the active firmware. It runs continuously (no sleep) under a 90-second watchdog. `code.ino` is the old deep-sleep version, kept for reference.

Libraries: ArduinoJson v7+ (won't compile on v6), Adafruit BME280 + Unified Sensor, BH1750, TinyGPSPlus, ArduinoHttpClient, and TinyGSM (lewisxhe fork).

One important thing about TinyGSM: the stock driver strands socket data on the A7670 after the server closes the connection, which breaks every cellular HTTPS call. Apply `scripts/tinygsm-a76xxssl-peer-close.patch` to the library, or copy `scripts/tinygsm-patched/TinyGsmClientA76xxSSL.h` over the stock file.

The firmware also filters phantom rain tips caused by GSM bursts (boot grace period, 300ms debounce, and a window that ignores gauge pulses while the modem is transmitting).

Build with arduino-cli:

```bash
arduino-cli core install esp32:esp32
arduino-cli lib install ArduinoJson "Adafruit BME280 Library" "Adafruit Unified Sensor" BH1750 "ArduinoHttpClient" TinyGPSPlus

# sketch folder name must match the .ino name
mkdir -p /tmp/code_nosleep && cp "LilyGO TTGO T-SIM A7670G/code_nosleep.ino" /tmp/code_nosleep/
# optional: include your local device credentials (see "Before flashing")
cp "LilyGO TTGO T-SIM A7670G/device_secrets.h" /tmp/code_nosleep/ 2>/dev/null || true
arduino-cli compile --fqbn esp32:esp32:esp32 /tmp/code_nosleep
```

Select "ESP32 Dev Module" in the Arduino IDE. All pins are #defined in the sketch.

Before flashing:

1. Put your Firebase project ID and API key in the sketch.
2. Copy `LilyGO TTGO T-SIM A7670G/device_secrets.example.h` to `device_secrets.h` and fill in the device email/password. That file is gitignored, so the credentials are never committed. Run `scripts/grant-roles.mjs` once first to create the device account and admin claims — without the device claim, Firestore rejects all writes.
3. Optional: add a CA bundle (Google Trust Services R1-R4) at `data/certs/ca-bundle.pem` in LittleFS so HTTPS is properly certificate-checked. Without it, TLS still works but is unvalidated.

The device account credentials live in the local, gitignored `device_secrets.h`, not in the repo.

After boot, `[AUTH] ✅ Device signed in.` and `[WDT] ✅` in the serial monitor mean everything is fine.

## Web UI

Plain HTML/JS/CSS, no framework. Put your Firebase web app config in `Web UI/firebase-config.js`, then:

```bash
firebase deploy --only hosting
```

## Firestore rules

`firestore.rules` scopes access: the device writes telemetry and logs, admins get full access, everyone else can only read the public data. If you edit the rules, deploy them, an undeployed rules file protects nothing:

```bash
firebase deploy --only firestore:rules
```

`firebase-tests/` has an emulator test suite for the rules (needs Java).

---

## Alerts

- Three tiers, each with its own rainfall, rain rate, water rise, and water level thresholds. Escalation overrides the SMS cooldown. De-escalation waits for a 30-minute calm window.
- Daily rain resets at midnight.
- The rain rate is a rolling window over bucket tips (default 10 min) and the rise rate is a rolling window over ultrasonic readings taken every 10 s (default 5 min), smoothed through a configurable 1–5 min averaging ring buffer (wave rejection), with a sanity ceiling at ±100 cm/min. Changing a unit or window makes the device reset its rate history so no data mixes between schemes.
- **Window = sensitivity:** a longer window makes a burst read as a smaller rate (a +30 cm surge ≈ 5.8 cm/min on a 5-min window but ≈ 0.5 cm/min on a 60-min window). If you permanently change the window, re-tune the Water Rise thresholds from real site history on that window — the defaults (5-min rise, 10-min rain) are the recommended starting point.
- **Configurable rate computation (admin → System Behavior → Rate Computation):** pick the rain-rate unit (mm/h, mm/min), rain window (5/10/60 min), rise unit (cm/h, cm/min), rise window (5/10/60 min), and wave smoothing (1/2/5 min). Thresholds are ALWAYS stored and computed canonically (rain mm/h, rise cm/min) — admin inputs and both dashboards convert to your chosen unit for display. Any change to these settings clears the device's rate histories on the next config poll (`RATE_SCHEME` log entry) so old-scheme data never mixes with the new scheme.
- **The water-rise unit is cm/min everywhere** — device firmware, alert thresholds, and dashboards all use cm/min. Start with Level 1 = 0.5, Level 2 = 1.0, Level 3 = 2.0 cm/min, then calibrate with your site's historical data. If you ever change units, rescale thresholds *and* the dashboards together. History records uploaded before the switch stay in cm/h until they age out (or enable the history TTL) — the admin panel warns if it loads threshold values that look like old cm/h numbers.
- `waterLevel` and `lightLevel` upload -1 when the sensor read fails. `lat`/`lng` are 0,0 until the first GPS fix. `waterSensorOk` goes false while the ultrasonic is offline.
- If the device stops uploading, the dashboards show OFFLINE after 15 minutes.

## Maintenance

- Clean the rain gauge funnel monthly. A clogged funnel silently reports no rain.
- Wipe the ultrasonic sensor face now and then. Algae and sludge ruin the readings.
- Keep the SIM loaded. The device logs its balance daily.
- History grows forever unless you add a TTL:

```bash
gcloud firestore fields ttls update timestamp --collection-group=weather_history --enable-ttl
```

## Project structure

```
├── LilyGO TTGO T-SIM A7670G/   firmware (code_nosleep.ino is the live one)
├── Web UI/                     public dashboard, admin panel, login
├── scripts/grant-roles.mjs     one-time account setup
├── firebase-tests/             rules tests
├── backups/                    old rules for rollback
└── firestore.rules
```
