/*
 * ============================================================
 *  SENSOR BENCH TEST — LilyGO TTGO T-SIM A7670G
 * ============================================================
 *  Multi-tab sketch that deep-tests EVERY sensor one at a time
 *  and prints PASS / WARN / FAIL verdicts with hints.
 *
 *  Tabs (all must stay in this folder — the Arduino IDE joins
 *  them into one sketch; keep only ONE .ino per folder in the
 *  deployed firmware to avoid duplicate-definition errors):
 *    sensor_test.ino        (this file) setup, loop, shared state
 *    sensors_rain.ino       tipping bucket (GPIO 34, ISR + debounce)
 *    sensors_ultrasonic.ino JSN-SR04T water level (GPIO 14/36)
 *    sensors_bme280.ino     BME280 temp/humidity/pressure (I2C)
 *    sensors_bh1750.ino     BH1750 light (I2C)
 *    sensors_gps.ino        GPS on Serial2 (GPIO 21/22)
 *    sensors_battery.ino    battery ADC (GPIO 35)
 *    sensors_summary.ino    PASS/FAIL verdict table every 30 s
 *
 *  HOW IT RUNS:
 *    • Rain gauge and GPS stream live, continuously.
 *    • Every 5 s ONE sensor gets a deep test (round-robin).
 *    • Every 30 s a summary table prints with verdicts.
 *
 *  Verdicts: OK / WARN / FAIL / WAIT (waiting for you to act,
 *  e.g. "tip the bucket" or "take the GPS outside").
 * ============================================================
 */

#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include <BH1750.h>
#include <TinyGPS++.h>

// ---------- Pins (identical to the deployed firmware) ----------
#define RAIN_GAUGE_PIN    34
#define ULTRASONIC_TRIG   14
#define ULTRASONIC_ECHO   36
#define BATTERY_PIN       35
#define I2C_SDA           32
#define I2C_SCL           33
#define GPS_RX            22
#define GPS_TX            21
#define SerialGPS         Serial2

// Test-mode rain boot grace is shorter than the deployed 60 s
// so you can check the bucket quickly after flashing.
#define TEST_RAIN_GRACE_MS 10000UL

// ---------- Shared globals (this tab is FIRST in the build,
// so every other tab can read these) ----------
Adafruit_BME280 bme;
BH1750          lightMeter;
TinyGPSPlus     gps;

bool   bmeOK          = false;
bool   bh1750OK       = false;

float  lastTemp       = 0.0f;
float  lastHum        = 0.0f;
float  lastPres       = 0.0f;
float  lastLux        = -1.0f;
float  lastDistance   = -1.0f;
float  lastWaterLevel = -1.0f;
float  lastBatteryV   = 0.0f;

uint32_t rainTipsTotal = 0;   // tips counted since boot (test sketch)
bool     rainGraceActive = true;

// Test bookkeeping: 0=not tested yet, 1=OK, 2=WARN, 3=FAIL
#define TEST_COUNT 4
#define T_BME      0
#define T_BH1750   1
#define T_ULTRA    2
#define T_BATT     3
int testResults[TEST_COUNT] = {0, 0, 0, 0};
const char *TEST_NAMES[TEST_COUNT] = {"BME280", "BH1750", "ULTRASONIC", "BATTERY"};

int  currentTest = 0;
unsigned long lastTestMs = 0;
unsigned long lastSummaryMs = 0;

// Cross-tab prototypes — the IDE's auto-prototype generator skips the
// IRAM_ATTR ISR, so declare every cross-tab function explicitly here.
void IRAM_ATTR rainGaugeISR();
void pumpRainTips();
void pumpGPS();
void probeBME280();
void probeBH1750();
void testBME280();
void testBH1750();
void testUltrasonic();
void testBattery();
void printSummary();

void setup() {
  Serial.begin(115200);
  delay(1500);

  Serial.println("\n=================================================");
  Serial.println("   SENSOR BENCH TEST — every sensor, one by one");
  Serial.println("=================================================\n");

  // Rain gauge (see sensors_rain.ino)
  pinMode(RAIN_GAUGE_PIN, INPUT);
  attachInterrupt(digitalPinToInterrupt(RAIN_GAUGE_PIN), rainGaugeISR, FALLING);

  // I2C bus (see sensors_bme280.ino / sensors_bh1750.ino)
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(100000);
  probeBME280();
  probeBH1750();

  // Ultrasonic (see sensors_ultrasonic.ino)
  pinMode(ULTRASONIC_TRIG, OUTPUT);
  pinMode(ULTRASONIC_ECHO, INPUT);
  digitalWrite(ULTRASONIC_TRIG, LOW);

  // Battery ADC (see sensors_battery.ino)
  pinMode(BATTERY_PIN, INPUT);

  // GPS (see sensors_gps.ino)
  SerialGPS.begin(9600, SERIAL_8N1, GPS_RX, GPS_TX);

  Serial.println("\nEvery 5 s one sensor is deep-tested (round-robin).");
  Serial.println("Rain gauge and GPS stream live. Summary every 30 s.\n");
}

void loop() {
  pumpRainTips();   // prints immediately when the bucket tips
  pumpGPS();        // drains NMEA, reports fix changes

  if (millis() - lastTestMs >= 5000) {
    lastTestMs = millis();
    switch (currentTest % TEST_COUNT) {
      case T_BME:    testBME280();     break;
      case T_BH1750: testBH1750();     break;
      case T_ULTRA:  testUltrasonic(); break;
      case T_BATT:   testBattery();    break;
    }
    currentTest++;
  }

  if (millis() - lastSummaryMs >= 30000) {
    lastSummaryMs = millis();
    printSummary();
  }
}