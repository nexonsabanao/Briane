/*
 * Tab: sensors_bme280.ino
 * BME280 temperature / humidity / pressure on I2C (SDA 32, SCL 33).
 * Probes both common addresses (0x76 and 0x77) like the deployed firmware.
 *
 * TEST plausibility ranges:
 *   temperature −40…85 °C, humidity 0…100 %, pressure 300…1100 hPa
 */

void probeBME280() {
  if (bme.begin(0x76) || bme.begin(0x77)) {
    bmeOK = true;
    bme.setSampling(Adafruit_BME280::MODE_NORMAL,
                    Adafruit_BME280::SAMPLING_X2,
                    Adafruit_BME280::SAMPLING_X16,
                    Adafruit_BME280::SAMPLING_X1,
                    Adafruit_BME280::FILTER_X16,
                    Adafruit_BME280::STANDBY_MS_500);
    Serial.println("[BME280] found on I2C (0x76/0x77).");
  } else {
    bmeOK = false;
    Serial.println("[BME280] ❌ NOT FOUND — check SDA=32, SCL=33, VCC=3.3V, and address jumper (0x76/0x77).");
  }
}

void testBME280() {
  Serial.println("\n[BME280] ── deep test ──");
  if (!bmeOK) {
    testResults[T_BME] = 3;
    Serial.println("[BME280] ❌ FAIL — sensor was not found at boot.");
    return;
  }

  float t = bme.readTemperature();
  float p = bme.readPressure() / 100.0f;   // Pa → hPa
  float h = bme.readHumidity();
  lastTemp = t; lastHum = h; lastPres = p;

  Serial.printf("  temperature: %.1f °C\n  humidity:    %.1f %%\n  pressure:    %.1f hPa\n", t, h, p);

  bool tOK = (t > -40 && t < 85);
  bool hOK = (h >= 0 && h <= 100);
  bool pOK = (p > 300 && p < 1100);

  if (tOK && hOK && pOK) {
    testResults[T_BME] = 1;
    Serial.println("[BME280] ✅ OK — all values plausible.");
  } else {
    testResults[T_BME] = 2;
    Serial.println("[BME280] ⚠️ WARN — a value is outside the plausible range; recheck sensor placement/cover.");
  }
}