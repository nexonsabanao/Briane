/*
 * Tab: sensors_gps.ino
 * Standalone GPS on Serial2 (module TX → ESP32 RX = GPIO 22,
 * ESP32 TX → module RX = GPIO 21), 9600 baud, parsed by TinyGPS++.
 *
 * TEST (continuous via pumpGPS + verdict in summary):
 *   ✅ OK     — NMEA flowing and a position fix with satellites
 *   ⚠️ WARN   — NMEA flowing but no fix yet (needs open sky, 1–5 min cold start)
 *   ❌ FAIL   — zero bytes received (check RX=22/TX=21 swap, baud, or antenna)
 */

uint32_t gpsBytesSeen = 0;
bool gpsHadFix = false;
bool gpsWarnedNoBytes = false;

void pumpGPS() {
  while (SerialGPS.available()) {
    gpsBytesSeen++;
    gps.encode(SerialGPS.read());
  }

  if (!gpsWarnedNoBytes && millis() > 30000 && gpsBytesSeen == 0) {
    gpsWarnedNoBytes = true;
    Serial.println("[GPS] ❌ No NMEA bytes after 30 s — check the RX/TX wiring (module TX → GPIO 22) and antenna.");
  }

  static bool lastFixPrinted = false;
  bool fixNow = gps.location.isValid();
  if (fixNow && !gpsHadFix) {
    gpsHadFix = true;
    Serial.printf("[GPS] ✅ FIX! lat %.6f, lng %.6f, satellites %u\n",
                  gps.location.lat(), gps.location.lng(), (unsigned)gps.satellites.value());
  }
  if (!fixNow) gpsHadFix = false;
}

void testGPS() {
  Serial.println("\n[GPS] ── deep test ──");
  Serial.printf("  NMEA bytes seen: %u | sentences with fix: %u\n",
                (unsigned)gpsBytesSeen, (unsigned)gps.sentencesWithFix());

  if (gps.location.isValid()) {
    Serial.printf("  position: %.6f, %.6f | satellites: %u | altitude: %.1f m\n",
                  gps.location.lat(), gps.location.lng(),
                  (unsigned)gps.satellites.value(),
                  gps.altitude.isValid() ? gps.altitude.meters() : 0.0f);
    Serial.println("[GPS] ✅ OK — position fix acquired.");
  } else if (gpsBytesSeen == 0) {
    Serial.println("[GPS] ❌ FAIL — zero NMEA bytes. Wiring swap (RX/TX), wrong baud, dead antenna, or no power.");
  } else {
    Serial.println("[GPS] ⚠️ WARN — NMEA is flowing but no fix yet. Take the antenna outside / near a window; a cold start can take 1–5 minutes.");
  }
}