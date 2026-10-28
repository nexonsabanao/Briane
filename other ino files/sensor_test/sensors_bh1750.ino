/*
 * Tab: sensors_bh1750.ino
 * BH1750 ambient light sensor on I2C (default address 0x23).
 *
 * TEST: read lux. 0 lux is VALID (total darkness); a negative value means
 * the sensor errored. Shield it with your hand — the reading should drop.
 */

void probeBH1750() {
  if (lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE)) {
    bh1750OK = true;
    Serial.println("[BH1750] found on I2C (0x23).");
  } else {
    bh1750OK = false;
    Serial.println("[BH1750] ❌ NOT FOUND — check SDA=32, SCL=33 and the ADDR jumper (0x23/0x5C).");
  }
}

void testBH1750() {
  Serial.println("\n[BH1750] ── deep test ──");
  if (!bh1750OK) {
    testResults[T_BH1750] = 3;
    Serial.println("[BH1750] ❌ FAIL — sensor was not found at boot.");
    return;
  }

  float lux = lightMeter.readLightLevel();
  lastLux = lux;

  if (lux < 0) {
    testResults[T_BH1750] = 3;
    Serial.println("[BH1750] ❌ FAIL — readLightLevel() errored.");
    return;
  }

  Serial.printf("  light level: %.0f lux\n", lux);
  if (lux == 0) Serial.println("  (pitch dark — cover the sensor with your hand and re-test to confirm it reacts)");
  testResults[T_BH1750] = 1;
  Serial.println("[BH1750] ✅ OK — light reading valid. Cover/uncover the sensor to watch it change.");
}