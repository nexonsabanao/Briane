/*
 * Tab: sensors_rain.ino
 * Tipping bucket rain gauge (GPIO 34, reed switch, FALLING interrupt).
 * Wiring: gauge signal → GPIO 34, 10 kΩ pull-up to 3.3 V, 100 nF to GND.
 *
 * TEST: manually flip the bucket. Each tip prints immediately:
 *   [RAIN] TIP! total: 3 | 0.84 mm
 * If no tips appear after the 10 s boot grace → wiring/EMI problem.
 */

#define RAIN_DEBOUNCE_MS     300UL
#define RAIN_GRACE_MS        10000UL

volatile uint32_t rainIsrTips = 0;

void IRAM_ATTR rainGaugeISR() {
  static uint32_t lastMs = 0;
  uint32_t now = millis();
  if (now - lastMs >= RAIN_DEBOUNCE_MS) {
    lastMs = now;
    rainIsrTips++;
  }
}

void pumpRainTips() {
  if (millis() < RAIN_GRACE_MS) {
    if (rainGraceActive && millis() > 2000) {
      Serial.println("[RAIN] boot grace active — tips ignored for the first 10 s");
      rainGraceActive = false;
    }
    noInterrupts();
    rainIsrTips = 0;   // drop boot-time noise like the deployed firmware does
    interrupts();
    return;
  }
  rainGraceActive = false;

  noInterrupts();
  uint32_t pending = rainIsrTips;
  rainIsrTips = 0;
  interrupts();

  if (pending == 0) return;
  rainTipsTotal += pending;
  Serial.printf("[RAIN] TIP! +%u | total since boot: %u tips\n", (unsigned)pending, (unsigned)rainTipsTotal);
}