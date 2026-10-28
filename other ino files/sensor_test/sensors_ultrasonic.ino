/*
 * Tab: sensors_ultrasonic.ino
 * JSN-SR04T water level (Trig GPIO 14, Echo GPIO 36).
 * Same reading method as the deployed firmware: 5 pings @ 40 ms,
 * median filter, 25–450 cm valid window, 30 µs echo timeout.
 *
 * TEST: every round prints each ping and the median verdict:
 *   [ULTRA] pings: 5/5 valid | median 102.4 cm | water level 97.6 cm  → OK
 * FAIL: 0/5 valid  → check Trig/ECHO wiring or 25 cm blind zone.
 */

#define ULTRA_SAMPLES      5
#define ULTRA_PING_GAP_MS  40
#define ULTRA_MIN_CM       25.0f
#define ULTRA_MAX_CM       450.0f
#define TEST_MOUNT_HEIGHT  200.0f   // transducer → "zero" water reference (cm)

float readUltrasonicOnce() {
  digitalWrite(ULTRASONIC_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(ULTRASONIC_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(ULTRASONIC_TRIG, LOW);

  long duration = pulseIn(ULTRASONIC_ECHO, HIGH, 30000UL);
  if (duration == 0) return -1.0f;

  float distance = (duration * 0.0343f) / 2.0f;   // ~20 °C speed of sound
  if (distance < ULTRA_MIN_CM || distance > ULTRA_MAX_CM) return -1.0f;
  return distance;
}

void testUltrasonic() {
  Serial.println("\n[ULTRA] ── deep test: 5 pings, median filtered ──");
  float readings[ULTRA_SAMPLES];
  int valid = 0;

  for (int i = 0; i < ULTRA_SAMPLES; i++) {
    float d = readUltrasonicOnce();
    readings[valid] = d;
    if (d > 0.0f) {
      valid++;
      Serial.printf("  ping %d: %.1f cm  ✓\n", i + 1, d);
    } else {
      Serial.printf("  ping %d: NO ECHO (timeout or out of 25–450 cm)\n", i + 1);
    }
    delay(ULTRA_PING_GAP_MS);
  }

  if (valid == 0) {
    testResults[T_ULTRA] = 3;
    Serial.println("[ULTRA] ❌ FAIL — no valid echo. Check TRIG=GPIO14, ECHO=GPIO36, power, and the 25 cm blind zone.");
    lastDistance = lastWaterLevel = -1.0f;
    return;
  }

  // Median of the valid readings (same technique as deployed firmware)
  for (int i = 0; i < valid - 1; i++) {
    for (int j = i + 1; j < valid; j++) {
      if (readings[j] < readings[i]) { float t = readings[i]; readings[i] = readings[j]; readings[j] = t; }
    }
  }
  float median = readings[valid / 2];
  lastDistance = median;
  lastWaterLevel = (TEST_MOUNT_HEIGHT - median);

  Serial.printf("[ULTRA] median distance: %.1f cm | water level (mount 200 cm): %.1f cm\n", median, lastWaterLevel);

  if (valid == ULTRA_SAMPLES) {
    testResults[T_ULTRA] = 1;
    Serial.println("[ULTRA] ✅ OK — all pings valid.");
  } else {
    testResults[T_ULTRA] = 2;
    Serial.printf("[ULTRA] ⚠️ WARN — only %d/%d pings valid (ripple, splash, or range edge).\n", valid, ULTRA_SAMPLES);
  }
}