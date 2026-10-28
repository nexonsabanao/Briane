/*
 * Tab: sensors_summary.ino
 * Prints the PASS/WARN/FAIL table every 30 seconds, including the
 * continuously-streaming rain gauge and GPS status.
 */

const char *verdictWord(int code) {
  switch (code) {
    case 1:  return "OK  ";
    case 2:  return "WARN";
    case 3:  return "FAIL";
    default: return "WAIT";
  }
}

void printSummary() {
  Serial.println("\n=============== SENSOR SUMMARY ===============");
  Serial.printf("BME280      : %s | %.1f °C, %.0f %%, %.1f hPa\n",
                verdictWord(testResults[T_BME]), lastTemp, lastHum, lastPres);
  Serial.printf("BH1750      : %s | %.0f lux\n",
                verdictWord(testResults[T_BH1750]), lastLux);
  Serial.printf("ULTRASONIC  : %s | dist %.1f cm, water %.1f cm\n",
                verdictWord(testResults[T_ULTRA]), lastDistance, lastWaterLevel);
  Serial.printf("BATTERY     : %s | %.2f V\n",
                verdictWord(testResults[T_BATT]), lastBatteryV);

  const char *rainV = (rainTipsTotal > 0) ? "OK  " : "WAIT";
  Serial.printf("RAIN GAUGE  : %s | %u tip(s) since boot — flip the bucket to test\n",
                rainV, (unsigned)rainTipsTotal);

  const char *gpsV = gps.location.isValid() ? "OK  "
                   : (gpsBytesSeen > 0 ? "WARN" : "WAIT");
  Serial.printf("GPS         : %s | %u NMEA bytes, fix: %s, sats: %u\n",
                gpsV, (unsigned)gpsBytesSeen,
                gps.location.isValid() ? "YES" : "no",
                (unsigned)(gps.satellites.isValid() ? gps.satellites.value() : 0));
  Serial.println("==============================================\n");
}