/*
 * Tab: sensors_battery.ino
 * Battery voltage on GPIO 35 through the LilyGO's onboard divider (× 2.1).
 * Same calibrated reading as the deployed firmware (analogReadMilliVolts,
 * median of 5) plus a Li-ion plausibility verdict.
 *
 * TEST: 3.0–4.2 V = OK (percentage shown). Outside that = WARN.
 */

int readBatteryMilliVoltsMedian() {
  int samples[5];
  for (int i = 0; i < 5; i++) {
    samples[i] = analogReadMilliVolts(BATTERY_PIN);   // eFuse-calibrated mV
    delayMicroseconds(200);
  }
  for (int i = 1; i < 5; i++) {
    int key = samples[i];
    int j = i - 1;
    while (j >= 0 && samples[j] > key) { samples[j + 1] = samples[j]; j--; }
    samples[j + 1] = key;
  }
  return samples[2];
}

void testBattery() {
  Serial.println("\n[BATT] ── deep test ──");
  int mv = readBatteryMilliVoltsMedian();
  lastBatteryV = (mv / 1000.0f) * 2.1f;   // × 2.1 = onboard divider ratio

  int pct = (int)round(((lastBatteryV - 3.0f) / 1.2f) * 100.0f);
  pct = max(0, min(100, pct));

  Serial.printf("  battery: %.2f V (≈ %d%%)\n", lastBatteryV, pct);

  if (lastBatteryV >= 3.0f && lastBatteryV <= 4.25f) {
    testResults[T_BATT] = 1;
    Serial.println("[BATT] ✅ OK — Li-ion voltage plausible.");
  } else if (lastBatteryV > 2.5f && lastBatteryV < 4.6f) {
    testResults[T_BATT] = 2;
    Serial.println("[BATT] ⚠️ WARN — voltage is outside the healthy Li-ion range (3.0–4.2 V). Charge or recheck the wiring.");
  } else {
    testResults[T_BATT] = 3;
    Serial.println("[BATT] ❌ FAIL — implausible voltage. If no battery is connected this is expected.");
  }
}