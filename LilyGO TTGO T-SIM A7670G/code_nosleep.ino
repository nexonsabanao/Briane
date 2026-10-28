/*
 * Project: Continuous Weather-based Flood Alert System (No-Sleep & Real-Time Sync)
 * Device: LilyGO TTGO T-SIM A7670G
 * Description: Continuous monitoring version — ESP32 stays fully awake (zero sleep
 *   latency, zero lost rain tips), real-time admin config sync, bulk SMS dispatch,
 *   standalone GPS + BME280 + BH1750 + AJ-SR04T ultrasonic, dual WiFi + GPRS
 *   failover, and a LittleFS offline queue.
 */

#define TINY_GSM_MODEM_A76XXSSL  // +CCH TLS sockets — required so cellular requests can carry auth headers
#define TINY_GSM_DEBUG Serial    // TEMPORARY: prints AT traffic ([timestamp] lines) to diagnose +CCH issues

// Feed the task watchdog inside TinyGSM waits: the A76xxSSL driver can block 75 s per
// call and starve the loop watchdog, which would reboot the ESP32 mid-request.
void feedWDT();  // declared early; the macro expands inside TinyGSM templates
#ifndef TINY_GSM_YIELD_MS
#define TINY_GSM_YIELD_MS 0
#endif
#define TINY_GSM_YIELD() { feedWDT(); delay(TINY_GSM_YIELD_MS); }
#include <Adafruit_BME280.h>
#include <Adafruit_Sensor.h>
#include <ArduinoHttpClient.h>
#include <ArduinoJson.h>
#include <BH1750.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <TinyGPS++.h>
#include <TinyGsmClient.h>
#include <ctype.h>
#include <stdlib.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <esp_task_wdt.h>
#include <time.h>

#if ARDUINOJSON_VERSION_MAJOR < 7
#error "ArduinoJson v7+ is required. Update via Arduino Library Manager."
#endif

// --- Firebase Configuration ---
const char server[] = "firestore.googleapis.com";
const int port = 443;
const String firebaseProjectId = "weather-project-a5fb5";
const String firebaseApiKey = "AIzaSyCBrJFnwz7zl4NdJHxh__a43E-76HLmvLY";

// --- Device Identity ---
// Dedicated Firebase Auth account (scripts/grant-roles.mjs). Credentials are kept
// OUT of version control: put them in a local device_secrets.h (copy
// device_secrets.example.h). Without that file the sketch still compiles but has
// no credentials, so it cannot authenticate and Firestore rejects its writes.
#if __has_include("device_secrets.h")
  #include "device_secrets.h"
#else
  #warning "device_secrets.h not found - building WITHOUT device credentials. See device_secrets.example.h."
  const char DEVICE_EMAIL[]    = "";
  const char DEVICE_PASSWORD[] = "";
#endif
const uint64_t ID_TOKEN_REFRESH_MARGIN_US = 300000000ULL; // re-mint 5 min before expiry

// --- SIM Card Settings ---
const char apn[] = "internet.globe.com.ph";

// --- WiFi Settings (Updated from Admin) ---
String wifiSsid = "";
String wifiPass = "";

// --- Pin Definitions for T-SIM A7670G ---
#define MODEM_RX 27
#define MODEM_TX 26
#define MODEM_PWRKEY 4
#define MODEM_DTR 25

#define BOARD_POWERON_PIN 12
#define BATTERY_PIN 35
#define RAIN_GAUGE_PIN 34

// I2C Pins for BME280 + BH1750
#define I2C_SDA 32
#define I2C_SCL 33

// JSN-SR04T Ultrasonic Water Level Sensor
#define ULTRASONIC_TRIG 14
#define ULTRASONIC_ECHO 36

// GPS Module (standalone, on Serial2)
#define BOARD_GPS_TX_PIN 21
#define BOARD_GPS_RX_PIN 22
#define BOARD_RST_PIN 5

// --- Sensor Calibration Constants ---
float sensorHeightCm = 200.0;
const float BUCKET_SIZE = 0.2794;
float maxClearSkyLux = 65000.0;
float basePressure = 1013.25;

// AJ-SR04T ultrasonic limits. Measure the real face-to-zero-water distance and
// update sensorHeightCm above during installation calibration.
#define ULTRASONIC_MIN_DISTANCE_CM 25.0f
#define ULTRASONIC_MAX_DISTANCE_CM 450.0f
#define ULTRASONIC_TIMEOUT_US      30000UL

// --- Configurable Thresholds & 3-Tier Alert Messages (code_nosleep only) ---
float alertL1Rain = 20.0;
float alertL1WaterRise = 0.5;
String alertMessageL1 = "FLOOD ADVISORY: Light to moderate rainfall detected. Please monitor local conditions.";

float alertL2Rain = 50.0;
float alertL2WaterRise = 1.0;
String alertMessageL2 = "FLOOD ALERT: Heavy rainfall & rising water levels. Prepare for possible evacuation.";

float alertL3Rain = 100.0;
float alertL3WaterRise = 2.0;
// Rain-intensity trigger bands (mm/h) - PAGASA rainfall-warning analogues:
// yellow 7.5 / orange 15 / red 30. A 0 threshold disables that trigger.
float alertL1RainRate = 7.5;
float alertL2RainRate = 15.0;
float alertL3RainRate = 30.0;
// Absolute gauge-stage triggers (cm of calibrated water level).
// 0 = disabled - set these to the site stages after calibrating mountHeight.
float alertL1WaterLevel = 0.0;
float alertL2WaterLevel = 0.0;
float alertL3WaterLevel = 0.0;
String alertMessageL3 = "FLOOD EMERGENCY: Critical water levels & rapid rising flood! Evacuate to higher ground immediately!";

String alertMessage = "FLOOD ALERT: Heavy rainfall & rising water levels. Prepare for possible evacuation.";
float alertCooldownHours = 5.0;
int liveStreamIntervalSec = 10; // Dynamic Firestore live-doc upload cadence (Default: 10s)
bool maintenanceMode = false;
float tempOffset = 0.0;
float waterOffset = 0.0;

// Manual SMS dispatch (admin "Alert Command Center"): 0 = none, 1/2/3 = force that tier's message.
int manualSmsLevelRequest = 0;

// --- Alert state machine tuning ---
// Hysteresis: a lower level must clear the next-lower threshold by this margin
// before stepping down, so threshold-line oscillation can't retrigger SMS blasts.
#define REARM_MARGIN_RAIN_MM    5.0f
#define REARM_MARGIN_WATERRISE  0.1f
#define SMS_RETRY_BACKOFF_MS    60000UL

// --- Global Rain & Sensor State ---
float dailyRainfall = 0.0; // Resets daily at midnight
uint64_t lastSmsTime = 0;  // Monotonic microseconds (esp_timer), NOT wall-clock — immune to NTP/GPS time jumps
int lastAlertLevelSent = 0; // 0 = None, 1 = Level 1 Advisory, 2 = Level 2 Alert, 3 = Level 3 Emergency
                            // Only advances on SUCCESSFUL SMS dispatch (failed dispatches retry)
int lastHistoryAckLevel = 0; // Highest alert level already written to history — advances regardless of
                             // maintenance mode / SMS success so escalations log exactly once
unsigned long smsRetryNotBeforeMs = 0; // millis() gate for retrying a failed dispatch
int lastSimCheckDay = -1;

#define RAIN_WINDOW_MINUTES    60  // largest rain-rate window — the ring holds this many one-minute slots
// Rain-rate window is admin-selectable (5/10/60 min) at runtime — see rainRateWindowMin.
// Short window = true intensity that decays quickly after rain stops.
#define DEBOUNCE_MS            300
// A bucket physically can't tip faster than ~300 ms; closer edges are noise (bounce/EMI).
#define DEBOUNCE_US            (DEBOUNCE_MS * 1000ULL)
#define US_PER_MINUTE          60000000ULL
#define INVALID_TIMESTAMP      0xFFFFFFFFFFFFFFFFULL
// Per-batch sanity cap: 30 tips ≈ 503 mm/h — beyond world-record rain, so more is noise.
#define MAX_TIPS_PER_MINUTE    30
#define MIN_REPORTABLE_RATE    0.05f
// Ignore gauge edges for the first 60 s after boot: modem power-up RF induces phantom tips.
#define STARTUP_GRACE_US       (60ULL * 1000000ULL)

typedef uint32_t tip_count_t;
typedef int8_t  buffer_index_t;

tip_count_t     todayTips = 0;
uint64_t        lastMinuteTickUs = INVALID_TIMESTAMP;
uint64_t        lastTipTimeUs = INVALID_TIMESTAMP;
tip_count_t     minuteTips[RAIN_WINDOW_MINUTES] = {0};
buffer_index_t  currentIndex = 0;
bool            bufferInitialized = false;

volatile tip_count_t isr_pendingTips = 0;
// True during SMS blasts: GSM TX induces phantom gauge edges, so the ISR drops them.
// Cost: ~1 real tip per blast — far better than corrupted daily rainfall.
volatile bool smsTxWindow = false;

// Boot grace: skip water reads for 60 s so modem power-up/registration RF
// can't corrupt the ultrasonic echo (same EMI fix as the rain gauge).
#define BOOT_GRACE_MS 60000UL
volatile bool bootGraceActive = true;
unsigned long bootGraceStart = 0;

// Rise-rate pipeline: median of last 3 rates (rejects outliers) + outage hold/decay.
#define RATE_HISTORY_SIZE 3
// 10 s samples. Each reading first passes through a wave-smoothing ring buffer
// (waterSmoothBuf), then a rolling window (admin-selectable 5/10/60 min) computes
// the canonical cm/min rate. Arrays are sized for the MAXIMUM window/smoothing.
#define WATER_RATE_SAMPLE_INTERVAL_MS 10000UL
// Ignore tiny ultrasonic fluctuations in the rolling-window result.
#define WATER_LEVEL_DEADBAND_CM        0.15f
#define MAX_RISE_WINDOW_MINUTES        60       // largest admin-selectable rise window
#define MAX_RISE_SMOOTH_SLOTS          30       // 5 min @ 10 s samples
#define WATER_LEVEL_HISTORY_CAPACITY   (MAX_RISE_WINDOW_MINUTES * 6 + 12)  // 372 slots ≈ 62 min
float  waterSmoothBuf[MAX_RISE_SMOOTH_SLOTS];
int    waterSmoothCount = 0;
int    waterSmoothIndex = 0;
float  waterSmoothSum   = 0.0f;

// --- Admin-configurable rate computation (weather/config) ----------------------
// Canonical units NEVER change for storage, alerts, and history: rain = mm/h,
// water rise = cm/min. The chosen unit only changes reported/displayed values.
// Changing any unit or window clears the sliding-window histories (see
// resetRateHistories) so no data mixes between schemes.
String rainRateUnit = "mm/h";          // "mm/h" | "mm/min"
String riseRateUnit = "cm/min";        // "cm/h" | "cm/min"
int    rainRateWindowMin = 10;         // 5 | 10 | 60 min
int    riseRateWindowMin = 5;          // 5 | 10 | 60 min
int    riseSmoothMin = 2;              // 1 | 2 | 5 min
// Runtime values derived from the admin settings above.
unsigned long riseRateWindowMs = 300000UL;   // riseRateWindowMin * 60000
int           riseSmoothSlots  = 12;         // riseSmoothMin * 6 (10 s samples)
// Last-applied settings (persisted) — a difference triggers a rate-history reset.
String lastRainRateUnit = "";
String lastRiseRateUnit = "";
int    lastRainRateWindowMin = 0;
int    lastRiseRateWindowMin = 0;
int    lastRiseSmoothMin = 0;

float rateHistory[RATE_HISTORY_SIZE];
int rateHistoryCount = 0;
float lastWaterLevel = -1.0f;
unsigned long lastWaterLevelTime = 0;
float waterLevelHistory[WATER_LEVEL_HISTORY_CAPACITY];
unsigned long waterLevelTimeHistory[WATER_LEVEL_HISTORY_CAPACITY];
int waterLevelHistoryCount = 0;
int waterLevelHistoryIndex = 0;
float waterRiseRateCMM = 0.0f;
unsigned long lastValidWaterMs = 0;
bool outageDecayLogged = false;
#define RATE_OUTAGE_HOLD_MS  1800000UL  // 30 min
#define RATE_OUTAGE_DECAY_MS 1800000UL  // 30 min

// Ultrasonic health: 5 failed pings = offline; ping gap grows after EMI.
int consecutiveSampleFailures = 0;
#define MAX_CONSECUTIVE_FAILURES 5
bool ultrasonicAvailable = true;     // uploaded to Firestore as waterSensorOk
#define SAMPLE_DELAY_BASE_MS 60
#define SAMPLE_DELAY_EMI_MS  100
int ultrasonicSampleDelay = SAMPLE_DELAY_BASE_MS;

float latitude = 0.0;
float longitude = 0.0;
bool gpsHasValidFix = false;

// Sensor availability flags
bool bmeAvailable = false;
bool bh1750Available = false;

// Per-cycle cached sensor readings
float cachedTemp = 0.0;
float cachedHum = 0.0;
float cachedPres = 0.0;
float cachedLux = -1.0;
float cachedWaterLevel = -1.0;
float cachedRiseRate = 0.0;
float cachedDewPoint = 0.0;
float cachedHeatIndex = 0.0;
float cachedCloudCover = -1.0;
float cachedPresTrend = 0.0;
float cachedBattVolt = 0.0;
String cachedRainIntensity = "None";
bool sensorsCachedThisCycle = false;

// Pressure trend tracking (WMO standard 3-hour barometric tendency)
#define PRESSURE_HISTORY_SIZE 36
float pressureHistory[PRESSURE_HISTORY_SIZE];
unsigned long pressureTimeHistory[PRESSURE_HISTORY_SIZE];
int pressureHistoryIndex = 0;
int pressureHistoryCount = 0;
unsigned long lastPressureRecord = 0;

// Timing Millis Counters for Continuous No-Sleep Loop
unsigned long lastUploadMillis = 0;
unsigned long lastHistoryMillis = 0;  // 1-hour Firestore history log timer
unsigned long lastConfigMillis = 0;
unsigned long lastSimCheckMillis = 0;
unsigned long lastSerialPrintMillis = 0;
unsigned long lastUserSyncMillis = 0; // 6-hour LittleFS user recipient sync timer
// Last-applied weather/config "usersVersion". 64-bit: the web app stamps it with
// Date.now() (a 13-digit ms value ~1.7e12) which does NOT fit a 32-bit unsigned
// long — storing it in one overflowed to garbage and broke change detection.
uint64_t lastSyncedUsersVersion = 0;
unsigned long historyIntervalMs = 3600000UL; // weather_history cadence — admin-configurable (weather/config "historyIntervalMin", minutes; default 60 = 1 hour)

// Hardware Objects
HardwareSerial SerialAT(1);
TinyGsm modem(SerialAT);
WiFiClientSecure wifiClient;
HttpClient wifiHttp(wifiClient, server, port);

bool wifiHasInternet = false;
unsigned long lastInternetVerifyMs = 0; // Last successful internet probe (60s cache in ensureConnection)

// --- Device auth token state (monotonic-clock expiry, immune to wall-clock jumps) ---
String firebaseIdToken = "";
String firebaseRefreshToken = "";
uint64_t idTokenExpiryUs = 0;

// --- TLS CA bundle (LittleFS /certs/ca-bundle.pem; empty = setInsecure()) ---
// Get Google Trust Services roots from https://pki.google.com/.
String tlsCaCertPem = "";
Preferences preferences;
Adafruit_BME280 bme;
BH1750 lightMeter;
#define SerialGPS Serial2
TinyGPSPlus gps;

// --- Forward Function Declarations ---
void initRainBuffer();
int advanceRainBuffer();
void recordRainTips(tip_count_t tips);
float getRainToday_mm();
float getRainRate_mmh();
void syncTime();
String getISOTime();
void connectWiFi();
void clearWifiCredentials();
void connectGPRS();
void recoverModem();
void ensureConnection();
void updateGPS();
void pumpGps(); // non-blocking NMEA drain — defined just before updateGPS()
void maybeMidDispatchUpload(); // best-effort live upload during SMS pacing gaps
int sendAtHttpRequest(const char *host, String method, String path, String payload,
                      String &responseBody, bool allowPut, bool strictJson, String extraHeaders);
int sendFirestoreRequest(String method, String path, String payload, String &responseBody);
bool deviceHasCredentials();
bool deviceEnsureIdToken(bool forceRefresh);
void loadTlsCaBundle();
void applyTls(WiFiClientSecure &client);
void uploadLiveToFirestore();
void fetchConfig();
bool syncRecipientsFromFirebase();
bool uploadToHistory();
void checkSimStatus();
void checkSimStatusIfNeeded();
void logErrorToFirestore(String type, String message);
void resetManualTrigger();
void resetSensorData();
void resetRateHistories();
void checkRateSettingsChanged();
void resetSensorTrigger();
float getRainRateDisplay();
float getRiseRateDisplay();
bool fetchUsersAndSendSMS(int &ackedLevel);
int computeAlertLevel(float dailyRainMM, float rainRateMMH, float riseCMM, float waterLevelCm);
void checkDailyRainReset();
String urlEncode(const String &value);
bool saveOfflineReading(String payload);
void flushOfflineQueue();
void readAllSensors();
bool waitForNetworkCustom(unsigned long timeoutMs = 60000L);
void feedWDT();

static inline uint64_t getMicrosMonotonic() {
  return esp_timer_get_time();
}

void initRainBuffer() {
  // Monotonic clock throughout: the rain window measures relative time only, and
  // wall-clock jumps from syncTime() would corrupt the sliding-window math.
  uint64_t now = getMicrosMonotonic();
  if (now == INVALID_TIMESTAMP) return;

  if (!bufferInitialized) {
    lastMinuteTickUs = now;
    currentIndex = 0;
    memset(minuteTips, 0, sizeof(minuteTips));
    bufferInitialized = true;
    Serial.println("[RAIN] Continuous rain buffer initialized.");
  } else if (now < lastMinuteTickUs) {
    lastMinuteTickUs = now;
  }
}

int advanceRainBuffer() {
  if (!bufferInitialized) return -1;
  uint64_t now = getMicrosMonotonic();
  if (now == INVALID_TIMESTAMP || now < lastMinuteTickUs) return -1;

  uint64_t elapsed = now - lastMinuteTickUs;
  int minutesPassed = (int)(elapsed / US_PER_MINUTE);
  if (minutesPassed <= 0) return 0;

  int toAdvance = (minutesPassed > RAIN_WINDOW_MINUTES) ? RAIN_WINDOW_MINUTES : minutesPassed;
  for (int i = 0; i < toAdvance; i++) {
    currentIndex = (buffer_index_t)((currentIndex + 1) % RAIN_WINDOW_MINUTES);
    minuteTips[currentIndex] = 0;
  }

  lastMinuteTickUs += (uint64_t)minutesPassed * US_PER_MINUTE;

  if (now > lastMinuteTickUs && (now - lastMinuteTickUs) > 30000000ULL) {
    lastMinuteTickUs = now - (now % US_PER_MINUTE);
  }
  return toAdvance;
}

float getRainToday_mm() {
  return (float)todayTips * BUCKET_SIZE;
}

// Single source of truth for tier evaluation (loop, dispatch, mid-dispatch re-eval).
// Four trigger families per level — rain, rain intensity, water rise, gauge stage —
// 0 disables a trigger; a -1 waterLevelCm (sensor dropout) never fires a stage.
int computeAlertLevel(float dailyRainMM, float rainRateMMH, float riseCMM, float waterLevelCm) {
  if ((alertL3Rain > 0 && dailyRainMM >= alertL3Rain) ||
      (alertL3RainRate > 0 && rainRateMMH >= alertL3RainRate) ||
      (alertL3WaterRise > 0 && riseCMM >= alertL3WaterRise) ||
      (alertL3WaterLevel > 0 && waterLevelCm >= 0 && waterLevelCm >= alertL3WaterLevel)) return 3;
  if ((alertL2Rain > 0 && dailyRainMM >= alertL2Rain) ||
      (alertL2RainRate > 0 && rainRateMMH >= alertL2RainRate) ||
      (alertL2WaterRise > 0 && riseCMM >= alertL2WaterRise) ||
      (alertL2WaterLevel > 0 && waterLevelCm >= 0 && waterLevelCm >= alertL2WaterLevel)) return 2;
  if ((alertL1Rain > 0 && dailyRainMM >= alertL1Rain) ||
      (alertL1RainRate > 0 && rainRateMMH >= alertL1RainRate) ||
      (alertL1WaterRise > 0 && riseCMM >= alertL1WaterRise) ||
      (alertL1WaterLevel > 0 && waterLevelCm >= 0 && waterLevelCm >= alertL1WaterLevel)) return 1;
  return 0;
}

const char* alertMessageForLevel(int level) {
  switch (level) {
    case 3:  return alertMessageL3.c_str();
    case 2:  return alertMessageL2.c_str();
    default: return alertMessageL1.c_str();
  }
}

// Stamp alert SMS with the local (PHT) issue time, captured once per dispatch so every
// recipient sees the same moment. Omitted before the clock syncs; never trims the stamp.
static String withSmsTimestamp(
    const String& msg, time_t issuedUtc) {
  if (issuedUtc < 1700000000ULL) {
    return msg;  // clock not synced yet
  }
  time_t pht = issuedUtc + 8UL * 3600UL;
  struct tm tmv;
  gmtime_r(&pht, &tmv);
  char stamp[32];
  strftime(stamp, sizeof(stamp),
      "\nIssued: %m/%d/%Y %I:%M%p", &tmv);
  String out = msg + stamp;
  if (out.length() > 160) {
    int keep = 160 - (int)strlen(stamp);
    if (keep > 4) {
      out = msg.substring(0, keep - 3);
      out += "...";
      out += stamp;
    } else {
      out = msg.substring(0, 160);
    }
  }
  return out;
}

float getRainRate_mmh() {
  // Rain over the admin-selectable window (5/10/60 min) of the minuteTips[] buffer,
  // scaled to mm/h (canonical). Only tips inside the window count — tracks CURRENT
  // rain, deliberately distinct from the daily total.
  int w = rainRateWindowMin;
  if (w < 1) w = 1;
  if (w > RAIN_WINDOW_MINUTES) w = RAIN_WINDOW_MINUTES;
  if (!bufferInitialized) return 0.0f;

  uint32_t recentTips = 0;
  for (int i = 0; i < w; i++) {
    int idx = (int)currentIndex - i;
    if (idx < 0) idx += RAIN_WINDOW_MINUTES;
    recentTips += minuteTips[idx];
  }
  float rate = (float)recentTips * BUCKET_SIZE * (60.0f / (float)w);
  return (rate < MIN_REPORTABLE_RATE) ? 0.0f : rate;
}

// Reported rain rate in the admin-chosen unit (canonical is always mm/h).
float getRainRateDisplay() {
  float mmh = getRainRate_mmh();
  return (rainRateUnit == "mm/min") ? (mmh / 60.0f) : mmh;
}

// Reported water-rise rate in the admin-chosen unit (canonical is always cm/min).
float getRiseRateDisplay() {
  return (riseRateUnit == "cm/h") ? (cachedRiseRate * 60.0f) : cachedRiseRate;
}

void recordRainTips(tip_count_t tips) {
  if (tips == 0) return;
  if (tips > MAX_TIPS_PER_MINUTE) tips = MAX_TIPS_PER_MINUTE;

  uint64_t nowUs = getMicrosMonotonic();

  minuteTips[currentIndex] += tips;
  todayTips += tips;

  float increment = (float)tips * BUCKET_SIZE;
  dailyRainfall = getRainToday_mm();

  lastTipTimeUs = nowUs;

  // Persist at most once per minute — NVS writes on every tip cause steady flash wear
  // during heavy rain. Values live in RAM between saves; setup() restores from last save.
  static uint64_t lastPersistUs = 0;
  if (nowUs - lastPersistUs >= 60000000ULL) {
    lastPersistUs = nowUs;
    preferences.begin("weather", false);
    preferences.putFloat("dailyRainfall", dailyRainfall);
    preferences.end();
  }

  Serial.printf("[RAIN GAUGE] +%.2f mm (%d tips) | Daily: %.2f mm | Rate (10m): %.1f mm/h\n",
                increment, tips, dailyRainfall, getRainRate_mmh());
}

void IRAM_ATTR rainGaugeISR() {
  static uint64_t lastInterruptUs = 0;
  uint64_t now = getMicrosMonotonic();
  if (now < STARTUP_GRACE_US) return;   // boot: modem power-up + RF registration noise
  if (smsTxWindow) return;              // SMS transmit: GSM RF bursts induce phantom edges
  if ((now - lastInterruptUs) >= DEBOUNCE_US) {
    lastInterruptUs = now;
    isr_pendingTips++;
  }
}

// ==============================================================
//                          SETUP
// ==============================================================
void setup() {
  // Set local timezone to Philippine Time (PHT, UTC+8)
  setenv("TZ", "PHT-8", 1);
  tzset();

  pinMode(BOARD_POWERON_PIN, OUTPUT);
  digitalWrite(BOARD_POWERON_PIN, HIGH);

  pinMode(MODEM_DTR, OUTPUT);
  digitalWrite(MODEM_DTR, LOW);

  pinMode(MODEM_PWRKEY, OUTPUT);
  digitalWrite(MODEM_PWRKEY, LOW);

  Serial.begin(115200);
  delay(100);
  Serial.println("\n=== ULAN System Starting (Continuous No-Sleep Mode) ===");

  pinMode(BATTERY_PIN, INPUT); // Must precede the first readBatteryVoltage() call below
  float initBatt = readBatteryVoltage();
  Serial.printf("[POWER CHECK] Measured Battery Voltage: %.2fV\n", initBatt);

  if (!LittleFS.begin(true)) {
    Serial.println("LittleFS Mount Failed!");
  } else {
    Serial.println("LittleFS Storage Mounted Successfully.");
  }

  preferences.begin("weather", false);
  dailyRainfall = preferences.getFloat("dailyRainfall", 0.0);
  lastSyncedUsersVersion = preferences.getULong64("usersVer", 0);
  // Restore the last-applied rate scheme so a reboot can't falsely detect a
  // unit/window change (which would reset sensor data on every boot).
  lastRainRateUnit = preferences.getString("lastRainRateUnit", "");
  lastRiseRateUnit = preferences.getString("lastRiseRateUnit", "");
  lastRainRateWindowMin = preferences.getInt("lastRainRateWindowMin", 0);
  lastRiseRateWindowMin = preferences.getInt("lastRiseRateWindowMin", 0);
  lastRiseSmoothMin = preferences.getInt("lastRiseSmoothMin", 0);
  preferences.end();

  todayTips = (tip_count_t)(dailyRainfall / BUCKET_SIZE + 0.5);
  initRainBuffer();

  Serial.printf("Restored Rainfall from memory: Daily=%.2f mm (%d tips)\n",
                dailyRainfall, todayTips);

  // ⚠️ Held LOW permanently — correct ONLY if GPIO 5 is an active-LOW enable. If it is
  // the GPS RESET_N instead, the GPS stays in reset and no NMEA arrives. Check the
  // LilyGO schematic before blaming code for GPS faults.
  pinMode(BOARD_RST_PIN, OUTPUT);
  digitalWrite(BOARD_RST_PIN, LOW);

  SerialAT.setRxBufferSize(2048);
  SerialAT.begin(115200, SERIAL_8N1, MODEM_RX, MODEM_TX);
  // Larger RX buffer: sensor reads block for hundreds of ms; at 9600 baud the default
  // 256-byte buffer would overflow and drop NMEA sentences.
  SerialGPS.setRxBufferSize(1024);
  SerialGPS.begin(9600, SERIAL_8N1, BOARD_GPS_RX_PIN, BOARD_GPS_TX_PIN);

  if (!modem.testAT(1000)) {
    delay(300);
    if (!modem.testAT(1000)) {
      Serial.println("[MODEM] Modem is OFF. Pulsing PWRKEY to turn ON...");
      digitalWrite(MODEM_PWRKEY, LOW);
      delay(100);
      digitalWrite(MODEM_PWRKEY, HIGH);
      delay(1000);
      digitalWrite(MODEM_PWRKEY, LOW);
      delay(3000);
    }
  }

  Serial.println("Initializing modem...");
  if (!modem.init()) {
    delay(1000);
    modem.init();
  }

  SerialAT.println("AT+CSSLCFG=\"sslversion\",0,3"); delay(100); while (SerialAT.available()) SerialAT.read();
  SerialAT.println("AT+CSSLCFG=\"enableSNI\",0,1"); delay(100); while (SerialAT.available()) SerialAT.read();
  SerialAT.println("AT+CSSLCFG=\"ignorertctime\",0,1"); delay(100); while (SerialAT.available()) SerialAT.read();
  SerialAT.println("AT+CFUN=1"); delay(100); while (SerialAT.available()) SerialAT.read();
  SerialAT.println("AT+CNMP=2"); delay(100); while (SerialAT.available()) SerialAT.read();

  Serial.print("Checking SIM card readiness...");
  unsigned long cpinStart = millis();
  while (millis() - cpinStart < 5000) {
    if (modem.getSimStatus() == SIM_READY) {
      Serial.println(" SIM READY!");
      break;
    }
    delay(500);
  }

  // Purge the SMS inbox at boot: leftovers pile up into "+SMS FULL", which silently
  // blocks outgoing alert SMS. Boot leftovers are at most stale balance replies.
  purgeSmsStorage(true, "boot");

  if (!waitForNetworkCustom(30000L)) {
    Serial.println("[CELLULAR WARNING] Network check timed out. Proceeding...");
    Serial.println("[CELLULAR WARNING] No operator at boot - the GPRS failure ladder will escalate recovery.");
  } else {
    Serial.print("Operator: "); Serial.println(modem.getOperator());
  }

  // TLS validation: uses the LittleFS CA bundle when present (loadTlsCaBundle),
  // otherwise falls back to unvalidated TLS. Probes fail open — see probeTlsEndpoint.
  loadTlsCaBundle();
  applyTls(wifiClient);

  preferences.begin("weather", true);
  String storedSsid = preferences.getString("wifi_ssid", "");
  String storedPass = preferences.getString("wifi_pass", "");
  preferences.end();

  if (storedSsid.length() > 0) {
    wifiSsid = storedSsid;
    wifiPass = storedPass;
  }
  if (wifiSsid.length() > 0) {
    connectWiFi();
  }

  connectGPRS();

  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(100000);

  // Some BME280 breakout modules ship with SDO tied high (address 0x77, not 0x76).
  if (bme.begin(0x76) || bme.begin(0x77)) {
    bmeAvailable = true;
    bme.setSampling(Adafruit_BME280::MODE_NORMAL,
                    Adafruit_BME280::SAMPLING_X2,
                    Adafruit_BME280::SAMPLING_X16,
                    Adafruit_BME280::SAMPLING_X1,
                    Adafruit_BME280::FILTER_X16,
                    Adafruit_BME280::STANDBY_MS_500);
    Serial.println("BME280 sensor found.");
  } else {
    Serial.println("BME280 not found! Using defaults.");
  }

  if (lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE)) {
    bh1750Available = true;
    Serial.println("BH1750 light sensor found.");
  } else {
    Serial.println("BH1750 not found!");
  }

  pinMode(ULTRASONIC_TRIG, OUTPUT);
  pinMode(ULTRASONIC_ECHO, INPUT);
  digitalWrite(ULTRASONIC_TRIG, LOW);

  // Boot grace: modem power-up RF corrupts ultrasonic echoes (observed 0.5→12 cm/min
  // phantom spikes). Matches the rain gauge's 60 s grace.
  bootGraceStart = millis();
  bootGraceActive = true;
  Serial.printf("[BOOT] 🛡️ Boot grace active for %lu ms (EMI protection, matches rain gauge)\n", BOOT_GRACE_MS);

  pinMode(BATTERY_PIN, INPUT);

  // HARDWARE: GPIO 34 is input-only, NO internal pull-up — the bucket needs an external
  // 10 kΩ pull-up to 3.3 V or the interrupt fires on noise. The deployed gauge has it;
  // keep it on any replacement gauge.
  pinMode(RAIN_GAUGE_PIN, INPUT);
  attachInterrupt(digitalPinToInterrupt(RAIN_GAUGE_PIN), rainGaugeISR, FALLING);

  memset(pressureHistory, 0, sizeof(pressureHistory));
  memset(pressureTimeHistory, 0, sizeof(pressureTimeHistory));

#if defined(ESP_IDF_VERSION_MAJOR) && ESP_IDF_VERSION_MAJOR >= 5
  esp_task_wdt_config_t wdt_config = {.timeout_ms = 90000,
                                     .idle_core_mask = (1 << portNUM_PROCESSORS) - 1,
                                     .trigger_panic = true};
  // The core usually inits the TWDT first; if not, init() arms it here. Verify the
  // result so a silently-unarmed watchdog is visible in the boot log.
  if (esp_task_wdt_reconfigure(&wdt_config) == ESP_OK) {
    Serial.println("[WDT] ✅ Task watchdog reconfigured (90 s, panic).");
  } else if (esp_task_wdt_init(&wdt_config) == ESP_OK) {
    Serial.println("[WDT] ✅ Task watchdog initialized (90 s, panic).");
  } else {
    Serial.println("[WDT] ⚠️ Could not configure the task watchdog — continuing without it.");
  }
#else
  if (esp_task_wdt_init(90, true) == ESP_OK) {
    Serial.println("[WDT] ✅ Task watchdog initialized (90 s, panic).");
  } else {
    Serial.println("[WDT] ⚠️ Task watchdog already initialized by the core — keeping core settings.");
  }
#endif

  // Initial config fetch
  ensureConnection();
  fetchConfig();

  Serial.println("=== System Ready (Continuous No-Sleep Mode Active) ===\n");
  Serial.printf("[SMS] CS (voice/SMS) registration at boot: %s\n", isCsRegistered() ? "registered" : "NOT registered — dispatches will run the recovery ladder");
}

void feedWDT() {
  static bool taskSubscribed = false;
  if (!taskSubscribed) {
    esp_err_t addErr = esp_task_wdt_add(NULL);
    if (addErr == ESP_OK) {
      taskSubscribed = true;
    } else if (esp_task_wdt_reset() == ESP_OK) {
      // Already subscribed (e.g. via an earlier code path) — mark and continue.
      taskSubscribed = true;
    }
    // else: the TWDT is not initialized yet — retry on the next call instead of
    // pretending the task is protected.
    return;
  }
  esp_task_wdt_reset();
}

// ==============================================================
//                        MAIN LOOP
// ==============================================================
void loop() {
  feedWDT();

  unsigned long now = millis();

  // 1. Continuously encode GPS sentences
  while (SerialGPS.available()) {
    gps.encode(SerialGPS.read());
  }
  if (gps.location.isValid()) {
    latitude = gps.location.lat();
    longitude = gps.location.lng();
    gpsHasValidFix = true;
  }

  // 2. Advance 60-minute rain buffer
  advanceRainBuffer();

  // 3. Process rain gauge tips immediately from ISR
  if (isr_pendingTips > 0) {
    noInterrupts();
    tip_count_t pending = isr_pendingTips;
    isr_pendingTips = 0;
    interrupts();

    initRainBuffer();
    recordRainTips(pending);
  }

  // 4. Check Daily Rain Reset at Midnight (60s gate — NVS reads every pass are wasteful;
  //    syncTime() still calls it directly right after each successful time sync)
  static unsigned long lastRainResetCheckMs = 0;
  if (now - lastRainResetCheckMs >= 60000UL) {
    lastRainResetCheckMs = now;
    checkDailyRainReset();

    // Heap guard: log-only warning (max once per minute) so heap fragmentation
    // surfaces in the serial log long before allocation failures break uploads.
    static unsigned long lastHeapWarnMs = 0;
    uint32_t freeHeapNow = ESP.getFreeHeap();
    if (freeHeapNow < 40960UL && now - lastHeapWarnMs >= 60000UL) {
      lastHeapWarnMs = now;
      Serial.printf("[HEAP] ⚠️ Free heap low: %u bytes — watch for allocation failures.\n", (unsigned)freeHeapNow);
    }
  }

  // 5. REAL-TIME Firebase Config Check — 5s cadence on WiFi, 30s over GPRS
  // (each poll is a blocking AT HTTPS session that can take many seconds on cellular)
  unsigned long configIntervalMs = (WiFi.status() == WL_CONNECTED && wifiHasInternet) ? 5000UL : 30000UL;
  if (now - lastConfigMillis >= configIntervalMs || lastConfigMillis == 0) {
    lastConfigMillis = now;
    fetchConfig(); // Firestore is now the primary (and only) live config source
  }

  // 5b. Periodic / First-boot LittleFS User Recipient Sync (Every 6 hours or if cache missing)
  if (now - lastUserSyncMillis >= 21600000UL || lastUserSyncMillis == 0 || !LittleFS.exists("/recipients.txt")) {
    lastUserSyncMillis = now;
    syncRecipientsFromFirebase();
  }

  // 6. Dynamic Upload Interval Logic
  int rawAlertLevel = computeAlertLevel(getRainToday_mm(), getRainRate_mmh(), waterRiseRateCMM, cachedWaterLevel);
  float dailyRainVal = getRainToday_mm();
  float riseRateVal = waterRiseRateCMM;

  // Re-arm hysteresis: a lower raw level only takes effect after clearing its
  // thresholds by a margin — prevents threshold-line flapping from re-blasting SMS.
  int currentAlertLevel = rawAlertLevel;
  if (rawAlertLevel > 0 && rawAlertLevel < lastAlertLevelSent) {
    float rainGate  = ((rawAlertLevel == 1) ? alertL1Rain : (rawAlertLevel == 2) ? alertL2Rain : alertL3Rain) - REARM_MARGIN_RAIN_MM;
    float riseGate  = ((rawAlertLevel == 1) ? alertL1WaterRise : (rawAlertLevel == 2) ? alertL2WaterRise : alertL3WaterRise) - REARM_MARGIN_WATERRISE;
    bool rainCleared = (rainGate <= 0) || (dailyRainVal < rainGate);
    bool riseCleared = (riseGate <= 0) || (riseRateVal < riseGate);
    if (!(rainCleared && riseCleared)) {
      currentAlertLevel = lastAlertLevelSent; // Still inside the margin — hold previous level
    }
  }

  bool isEmergency = (currentAlertLevel > 0);

  // De-escalation: 30 min below ALL thresholds resets the level, so a fresh event
  // can notify again via escalation instead of the stale level suppressing it.
  static unsigned long calmSinceMillis = 0;
  if (!isEmergency) {
    if (calmSinceMillis == 0) {
      calmSinceMillis = now;
    } else if (now - calmSinceMillis >= 1800000UL && lastAlertLevelSent != 0) {
      Serial.println("[ALERT] Conditions cleared for 30+ min — resetting alert level tracking.");
      lastAlertLevelSent = 0;
      lastHistoryAckLevel = 0;
      calmSinceMillis = now; // Restart window so this fires only once per clearing period
    }
  } else {
    calmSinceMillis = 0;
  }

  // 6a. Firestore Live Telemetry Stream (Configurable cadence: 5s to 60s, Default: 10s)
  unsigned long liveStreamIntervalMs = (unsigned long)max(5, liveStreamIntervalSec) * 1000UL;
  if (now - lastUploadMillis >= liveStreamIntervalMs || lastUploadMillis == 0) {
    lastUploadMillis = now;
    sensorsCachedThisCycle = false;
    ensureConnection();
    updateGPS();
    readAllSensors();
    uploadLiveToFirestore(); // Firestore weather/current is the sole live doc (10s cadence)

    flushOfflineQueue();
  }

  // 6b. Firestore History Log ("historyIntervalMin", default 60 min, or immediately
  // on a new alert trigger). Ack uses lastHistoryAckLevel — committed only after the
  // upload confirms (or queues offline); failures back off like SMS.
  static unsigned long historyRetryNotBeforeMs = 0;
  bool historyRetryAllowed = (historyRetryNotBeforeMs == 0) || ((long)(now - historyRetryNotBeforeMs) >= 0);
  bool historyDue = (now - lastHistoryMillis >= historyIntervalMs || lastHistoryMillis == 0);
  bool alertTriggered = (isEmergency && currentAlertLevel > lastHistoryAckLevel);
  if ((historyDue || alertTriggered) && historyRetryAllowed) {
    lastHistoryMillis = now;
    ensureConnection();
    readAllSensors();
    if (uploadToHistory()) {
      if (currentAlertLevel > lastHistoryAckLevel) lastHistoryAckLevel = currentAlertLevel;
      historyRetryNotBeforeMs = 0;
    } else {
      historyRetryNotBeforeMs = now + SMS_RETRY_BACKOFF_MS;
      Serial.println("[HISTORY] ⚠️ History log FAILED — level NOT acknowledged, retrying after backoff.");
    }
  }

  // 7. SMS Alert Dispatch Check (Escalation, Cooldown & Failure-Retry Logic)
  // Monotonic clock — wall-clock jumps after syncTime() would re-trigger SMS blasts.
  uint64_t cooldownUs = (uint64_t)(alertCooldownHours * 3600.0 * 1000000.0);
  bool isEscalation = (currentAlertLevel > lastAlertLevelSent);
  bool cooldownExpired = (getMicrosMonotonic() - lastSmsTime > cooldownUs);

  // Send SMS when active AND (cooldown expired OR escalated). A failed dispatch leaves
  // lastAlertLevelSent untouched and retries after backoff instead of swallowing the alert.
  if (!maintenanceMode && isEmergency && (cooldownExpired || isEscalation)
      && (smsRetryNotBeforeMs == 0 || (long)(now - smsRetryNotBeforeMs) >= 0)) {
    if (isEscalation) {
      Serial.printf("[ALERT ESCALATION] ⚡ Severity escalated from Level %d to Level %d! Overriding cooldown...\n",
                    lastAlertLevelSent, currentAlertLevel);
    }
    ensureConnection();
    int ackedLevel = currentAlertLevel;
    smsTxWindow = true;   // suppress rain-gauge ISR during GSM TX bursts (EMI phantom tips)
    bool dispatchedOk = fetchUsersAndSendSMS(ackedLevel);
    smsTxWindow = false;
    if (dispatchedOk) {
      lastSmsTime = getMicrosMonotonic();
      lastAlertLevelSent = (ackedLevel > currentAlertLevel) ? ackedLevel : currentAlertLevel;
      smsRetryNotBeforeMs = 0;
    } else {
      smsRetryNotBeforeMs = now + SMS_RETRY_BACKOFF_MS;
      Serial.println("[ALERT] ⚠️ SMS dispatch FAILED — level NOT acknowledged, retrying after backoff.");
    }
  }

  // 8. SIM Balance Check (Daily after midnight — checkSimStatusIfNeeded() gates on day change)
  if (now - lastSimCheckMillis >= 86400000 || lastSimCheckMillis == 0) {
    lastSimCheckMillis = now;
    checkSimStatusIfNeeded();
  }

  // 9. Real-Time Serial Print Diagnostic (Every 5 seconds)
  if (now - lastSerialPrintMillis >= 5000) {
    lastSerialPrintMillis = now;
    sensorsCachedThisCycle = false;
    readAllSensors();

    Serial.println(F("========================================"));
    Serial.print(F("Mode        : Continuous (No Sleep)\n"));
    Serial.print(F("Temperature : ")); Serial.print(cachedTemp, 1); Serial.println(F(" °C"));
    Serial.print(F("Feels Like  : ")); Serial.print(cachedHeatIndex, 1); Serial.println(F(" °C"));
    Serial.print(F("Dew Point   : ")); Serial.print(cachedDewPoint, 1); Serial.println(F(" °C"));
    Serial.print(F("Humidity    : ")); Serial.print(cachedHum, 1); Serial.println(F(" %"));
    Serial.print(F("Pressure    : ")); Serial.print(cachedPres, 1); Serial.println(F(" hPa"));
    Serial.print(F("Illuminance : ")); Serial.print(cachedLux, 1); Serial.println(F(" lx"));
    if (cachedCloudCover < 0) Serial.println(F("Cloud Cover : [Night / Low Light]"));
    else { Serial.print(F("Cloud Cover : ")); Serial.print(cachedCloudCover, 0); Serial.println(F(" %")); }
    Serial.print(F("Rainfall    : ")); Serial.print(dailyRainfall, 2); Serial.println(F(" mm"));
    Serial.print(F("Rain Rate   : ")); Serial.print(getRainRateDisplay(), 2); Serial.println(rainRateUnit + " (" + String(rainRateWindowMin) + " min)");
    Serial.print(F("Rain Status : ")); Serial.println(cachedRainIntensity);
    Serial.print(F("Bucket Tips : ")); Serial.println(todayTips);
    Serial.print(F("Water Level : ")); Serial.print(cachedWaterLevel, 1); Serial.println(F(" cm"));
    Serial.print(F("Water Rise  : ")); Serial.print(getRiseRateDisplay(), 2); Serial.println(riseRateUnit + " (" + String(riseRateWindowMin) + " min)");
    Serial.print(F("Battery     : ")); Serial.print(cachedBattVolt, 2); Serial.println(F(" V"));
    Serial.println(F("========================================\n"));
  }

  delay(10); // Small yield
}

// ==============================================================
//              SENSOR READING FUNCTIONS
// ==============================================================

// Sanity ceiling for the rise rate — real floods never approach ±100 cm/min; it only
// caps absurd values from a glitch burst that slips past the median filters.
float clampRiseRateSanity(float rate) {
  if (rate > 100.0f) return 100.0f;
  if (rate < -100.0f) return -100.0f;
  return rate;
}

// Median of n floats (n <= 9). Sorts a copy so caller ordering is preserved.
float fltMedian(const float* src, int n) {
  float buf[9];
  memcpy(buf, src, sizeof(float) * n);
  for (int i = 0; i < n - 1; i++) {
    for (int j = i + 1; j < n; j++) {
      if (buf[j] < buf[i]) {
        float t = buf[i];
        buf[i] = buf[j];
        buf[j] = t;
      }
    }
  }
  return buf[n / 2];
}

float readUltrasonicDistance() {
  digitalWrite(ULTRASONIC_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(ULTRASONIC_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(ULTRASONIC_TRIG, LOW);

  // 30 ms supports the configured maximum distance while still timing out
  // cleanly when the AJ sensor receives no echo.
  unsigned long duration = pulseIn(ULTRASONIC_ECHO, HIGH,
                                   ULTRASONIC_TIMEOUT_US);
  if (duration == 0) return -1.0;

  // Speed of sound is temperature-compensated; fall back to 28 °C until the
  // BME280 produces a sample (cachedTemp==0 means "not cached yet").
  float tempC = (bmeAvailable && cachedTemp != 0.0f && cachedTemp > -20.0f && cachedTemp < 60.0f) ? cachedTemp : 28.0f;
  float speedOfSoundCmPerUs = (331.3f + 0.606f * tempC) * 0.0001f;

  float distance = (duration * speedOfSoundCmPerUs) / 2.0f;
  if (distance < ULTRASONIC_MIN_DISTANCE_CM ||
      distance > ULTRASONIC_MAX_DISTANCE_CM) {
    Serial.printf("[WATER] Invalid AJ ultrasonic distance: %.1f cm\n",
                  distance);
    return -1.0f;
  }
  return distance;
}

float calculateWaterLevel() {
  // Median-of-9 tolerates up to 4 corrupted pings; hardware faults are caught by
  // the range guard + failure counter below.
  const int NUM_SAMPLES = 9;
  const float MAX_JUMP_CM = 50.0f;   // max realistic change between consecutive pings

  float readings[NUM_SAMPLES];
  int validCount = 0;
  int rejectedJumps = 0;

  for (int i = 0; i < NUM_SAMPLES; i++) {
    feedWDT();
    float d = readUltrasonicDistance();

    if (d < 0.0f) {  // ping failed — track so a dead sensor is flagged, not silent
      consecutiveSampleFailures++;
      if (consecutiveSampleFailures >= MAX_CONSECUTIVE_FAILURES) {
        if (ultrasonicAvailable) {
          Serial.printf("[WATER] ⛔ Sensor offline: %d consecutive failed pings\n", consecutiveSampleFailures);
          ultrasonicAvailable = false;
        }
        return -1.0f;
      }
      delay(ultrasonicSampleDelay);
      continue;
    }

    consecutiveSampleFailures = 0;
    if (!ultrasonicAvailable) {
      Serial.println(F("[WATER] ✅ Sensor recovered - back online"));
      ultrasonicAvailable = true;
    }

    // Reject sudden jumps - the EMI signature of a GSM burst.
    if (validCount > 0 && fabs(d - readings[validCount - 1]) > MAX_JUMP_CM) {
      Serial.printf("[WATER] ⚠️ Rejected jump: %.1f → %.1f cm (EMI)\n", readings[validCount - 1], d);
      rejectedJumps++;
      continue;
    }
    readings[validCount++] = d;
    delay(ultrasonicSampleDelay);
  }

  // Fail sparse or mass-rejected cycles so they never feed the rate pipeline.
  if (validCount < 3) return -1.0f;
  if (rejectedJumps > NUM_SAMPLES / 2) {
    Serial.println(F("[WATER] ⛔ Mass ping rejection - cycle discarded (EMI)"));
    return -1.0f;
  }

  // Longer ping gap after an EMI-corrupted cycle.
  ultrasonicSampleDelay = (rejectedJumps > 0) ? SAMPLE_DELAY_EMI_MS : SAMPLE_DELAY_BASE_MS;

  // Require ≥3 pings within 10 cm of the median - a lone outlier is corruption.
  float medianDistance = fltMedian(readings, validCount);
  const float MAX_AGREE_CM = 10.0f;
  int agreeingPings = 0;
  for (int i = 0; i < validCount; i++) {
    if (fabs(readings[i] - medianDistance) <= MAX_AGREE_CM) agreeingPings++;
  }
  if (agreeingPings < 3) {
    Serial.printf("[WATER] ⛔ Only %d of %d pings agree with median %.1f cm - cycle rejected (EMI)\n",
                  agreeingPings, validCount, medianDistance);
    return -1.0f;
  }

  // Never clamp an impossible result to zero — a negative level or one above the
  // sensor height means bad calibration/splash and must not feed the rise rate.
  float waterLevel = (sensorHeightCm - medianDistance) + waterOffset;
  if (waterLevel < 0.0f || waterLevel > sensorHeightCm) {
    Serial.printf("[WATER] Invalid calculated level: %.1f cm "
                  "(distance %.1f cm, sensor height %.1f cm)\n",
                  waterLevel, medianDistance, sensorHeightCm);
    return -1.0f;
  }

  return waterLevel;
}

float calculateDewPoint(float temp, float humidity) {
  if (humidity <= 0) return 0;
  float a = 17.27, b = 237.7;
  float gamma = (a * temp) / (b + temp) + log(humidity / 100.0);
  return (b * gamma) / (a - gamma);
}

float calculateHeatIndex(float temp, float humidity) {
  if (temp < 27.0) return temp;
  float T = temp * 9.0 / 5.0 + 32.0;
  float R = humidity;
  float HI = -42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R -
             6.83783e-3 * T * T - 5.481717e-2 * R * R + 1.22874e-3 * T * T * R +
             8.5282e-4 * T * R * R - 1.99e-6 * T * T * R * R;
  return (HI - 32.0) * 5.0 / 9.0;
}

float estimateCloudCover(float lux) {
  time_t now; time(&now);
  bool haveTime = (now >= 1600000000); // RTC synced?
  float decimalHour = 0.0f;

  if (haveTime) {
    struct tm timeinfo;
    localtime_r(&now, &timeinfo);
    decimalHour = timeinfo.tm_hour + (timeinfo.tm_min / 60.0f);

    // Night is decided by TIME OF DAY, not by lux: a dark, cloudy morning is still
    // daytime (so it should report high cloud cover, not "[Night / Low Light]").
    if (decimalHour < 6.0f || decimalHour > 18.0f) return -1.0f;
  } else {
    // No synced clock yet: fall back to the old lux heuristic ONLY as a
    // pre-time-sync guard so we don't guess "night" before we know the hour.
    if (lux < 5.0f) return -1.0f;
  }

  float expectedClearLux = maxClearSkyLux;
  if (haveTime) {
    // Solar elevation diurnal sine curve model:
    // Calculates theoretical clear-sky lux based on sun angle at this hour of the day
    float solarFactor = sinf((decimalHour - 6.0f) / 12.0f * 3.14159265f);
    if (solarFactor < 0.08f) solarFactor = 0.08f;
    expectedClearLux = maxClearSkyLux * solarFactor;
  }

  float clearSkyRatio = lux / expectedClearLux;
  if (clearSkyRatio > 1.0f) clearSkyRatio = 1.0f;
  float cloudCover = (1.0f - clearSkyRatio) * 100.0f;
  return max(0.0f, min(100.0f, cloudCover));
}

String classifyRainIntensity(float rateMMH) {
  if (rateMMH <= 0) return "None";
  if (rateMMH < 2.5) return "Light";
  if (rateMMH < 7.5) return "Moderate";
  if (rateMMH < 50.0) return "Heavy";
  return "Violent";
}

void recordPressure(float pressure) {
  // Monotonic seconds only: mixing wall-clock with millis() timelines corrupts the
  // delta math the moment time syncs (epoch jump of decades in either direction).
  unsigned long nowSec = (unsigned long)(getMicrosMonotonic() / 1000000ULL);

  if (nowSec - lastPressureRecord >= 300 || lastPressureRecord == 0) {
    pressureHistory[pressureHistoryIndex] = pressure;
    pressureTimeHistory[pressureHistoryIndex] = nowSec;
    pressureHistoryIndex = (pressureHistoryIndex + 1) % PRESSURE_HISTORY_SIZE;
    if (pressureHistoryCount < PRESSURE_HISTORY_SIZE) pressureHistoryCount++;
    lastPressureRecord = nowSec;
  }
}

float calculatePressureTrend() {
  if (pressureHistoryCount < 2) return 0.0f;
  int oldestIdx = (pressureHistoryIndex - pressureHistoryCount + PRESSURE_HISTORY_SIZE) % PRESSURE_HISTORY_SIZE;
  int newestIdx = (pressureHistoryIndex - 1 + PRESSURE_HISTORY_SIZE) % PRESSURE_HISTORY_SIZE;

  float deltaP = pressureHistory[newestIdx] - pressureHistory[oldestIdx];
  unsigned long elapsedSec = pressureTimeHistory[newestIdx] - pressureTimeHistory[oldestIdx];
  if (elapsedSec < 180) return 0.0f;

  float elapsedHours = (float)elapsedSec / 3600.0f;
  // Normalized to standard WMO 3-hour barometric tendency (hPa / 3 hours)
  float trend3h = (deltaP / elapsedHours) * 3.0f;
  return trend3h;
}

float calculateWaterRiseRate(float currentLevel) {
  // Store valid readings every 10 s, smooth them in a wave-smoothing ring buffer
  // (waterSmoothBuf, riseSmoothMin), then compute the rate over a rolling
  // riseRateWindowMin window of the smoothed levels. Reacts within one sample:
  // a sustained rise shows up immediately — just not driven by a wave crest.
  unsigned long nowMs = millis();

  // Outage: hold 30 min, then decay to 0 so stale data cannot pin an alert tier.
  if (currentLevel < 0.0f) {
    // Drop ALL pre-outage state so recovery compares only fresh readings — a bad
    // cycle must not leave stale samples that later age into a false rise/fall
    // rate. waterRiseRateCMM itself is intentionally kept for the hold/decay.
    waterSmoothCount = 0;
    waterSmoothIndex = 0;
    waterSmoothSum = 0.0f;
    waterLevelHistoryCount = 0;
    waterLevelHistoryIndex = 0;
    rateHistoryCount = 0;

    unsigned long outageMs = nowMs - lastValidWaterMs;
    if (outageMs < RATE_OUTAGE_HOLD_MS) return waterRiseRateCMM;

    if (!outageDecayLogged) {
      Serial.println(F("[WATER] Sensor outage > 30 min - decaying stale rise rate to 0"));
      outageDecayLogged = true;
    }

    float frac = (outageMs - RATE_OUTAGE_HOLD_MS) /
                 (float)RATE_OUTAGE_DECAY_MS;
    if (frac >= 1.0f) {
      waterRiseRateCMM = 0.0f;
      return 0.0f;
    }

    waterRiseRateCMM *= (1.0f - frac);
    return waterRiseRateCMM;
  }

  lastValidWaterMs = nowMs;
  outageDecayLogged = false;

  // Add a new sample only after the intended sampling interval.
  if (lastWaterLevelTime != 0 &&
      (nowMs - lastWaterLevelTime) < WATER_RATE_SAMPLE_INTERVAL_MS) {
    return waterRiseRateCMM;
  }

  lastWaterLevel = currentLevel;
  lastWaterLevelTime = nowMs;

  // Wave-smoothing ring buffer: O(1) running mean via a running sum (subtract the
  // slot being overwritten once full). Store the smoothed level in the rate history.
  if (waterSmoothCount >= riseSmoothSlots) {
    waterSmoothSum -= waterSmoothBuf[waterSmoothIndex];
  }
  waterSmoothBuf[waterSmoothIndex] = currentLevel;
  waterSmoothSum += currentLevel;
  waterSmoothIndex = (waterSmoothIndex + 1) % riseSmoothSlots;
  if (waterSmoothCount < riseSmoothSlots) waterSmoothCount++;
  float smoothedLevel = waterSmoothSum / (float)waterSmoothCount;

  waterLevelHistory[waterLevelHistoryIndex] = smoothedLevel;
  waterLevelTimeHistory[waterLevelHistoryIndex] = nowMs;
  waterLevelHistoryIndex =
      (waterLevelHistoryIndex + 1) % WATER_LEVEL_HISTORY_CAPACITY;
  if (waterLevelHistoryCount < WATER_LEVEL_HISTORY_CAPACITY) {
    waterLevelHistoryCount++;
  }

  // Oldest sample still inside the rolling window; history is oversized so delayed
  // uploads don't immediately destroy it.
  int newestIndex = (waterLevelHistoryIndex - 1 +
                     WATER_LEVEL_HISTORY_CAPACITY) %
                    WATER_LEVEL_HISTORY_CAPACITY;
  int oldestIndex = newestIndex;

  for (int i = 1; i < waterLevelHistoryCount; i++) {
    int candidate = (newestIndex - i + WATER_LEVEL_HISTORY_CAPACITY) %
                    WATER_LEVEL_HISTORY_CAPACITY;
    if (nowMs - waterLevelTimeHistory[candidate] >= riseRateWindowMs) {
      oldestIndex = candidate;
      break;
    }
    oldestIndex = candidate;
  }

  unsigned long windowMs = nowMs - waterLevelTimeHistory[oldestIndex];

  // Keep collecting 10-second samples until the configured window is available.
  if (windowMs < riseRateWindowMs) {
    waterRiseRateCMM = 0.0f;
    Serial.printf("[WATER RATE] Collecting window: %.1f / %.1f s\n",
                  windowMs / 1000.0f,
                  riseRateWindowMs / 1000.0f);
    return waterRiseRateCMM;
  }

  float levelChange = waterLevelHistory[newestIndex] -
                      waterLevelHistory[oldestIndex];
  bool insignificantChange = fabs(levelChange) < WATER_LEVEL_DEADBAND_CM;
  float minutesElapsed = windowMs / 60000.0f;
  // Signed rate: positive = rising, negative = draining. Loose sanity ceiling only —
  // real floods never approach ±100 cm/min; it just caps glitch bursts.
  float rawRate = insignificantChange
                    ? 0.0f
                    : clampRiseRateSanity(levelChange / minutesElapsed);

  Serial.printf(
      "[WATER RATE] Window: %.1f s | Start: %.2f cm | End: %.2f cm | "
      "Change: %.2f cm | Raw rate: %.2f cm/min\n",
      windowMs / 1000.0f,
      waterLevelHistory[oldestIndex],
      waterLevelHistory[newestIndex],
      levelChange,
      rawRate);

  // Slide the rate history and use a median to reject one bad window.
  for (int i = RATE_HISTORY_SIZE - 1; i > 0; i--) {
    rateHistory[i] = rateHistory[i - 1];
  }
  rateHistory[0] = rawRate;
  if (rateHistoryCount < RATE_HISTORY_SIZE) rateHistoryCount++;

  waterRiseRateCMM = (rateHistoryCount < RATE_HISTORY_SIZE)
                       ? rawRate
                       : fltMedian(rateHistory, rateHistoryCount);

  Serial.printf("[WATER RATE] Filtered result: %.2f cm/min\n",
                waterRiseRateCMM);
  return waterRiseRateCMM;
}

float readBatteryVoltage() {
  // Median-of-5 rejects GSM TX rail sag. analogReadMilliVolts() uses the chip's
  // factory ADC calibration — far more accurate than raw counts scaled by 3.3 V.
  int samples[5];
  for (int i = 0; i < 5; i++) {
    samples[i] = analogReadMilliVolts(BATTERY_PIN);
    delayMicroseconds(200);
  }
  for (int i = 1; i < 5; i++) { // insertion sort — trivial at n=5
    int key = samples[i];
    int j = i - 1;
    while (j >= 0 && samples[j] > key) {
      samples[j + 1] = samples[j];
      j--;
    }
    samples[j + 1] = key;
  }
  int raw = samples[2];               // median, in millivolts at the pin
  return (raw / 1000.0) * 2.1;        // × 2.1 = LilyGO onboard battery divider ratio
}

// ==============================================================
//              CONNECTIVITY & FIRESTORE FUNCTIONS
// ==============================================================

// Load the CA trust bundle from LittleFS. Concatenate GTS Root R1..R4 from
// https://pki.google.com/ to cover firestore.googleapis.com.
void loadTlsCaBundle() {
  if (!LittleFS.exists("/certs/ca-bundle.pem")) {
    Serial.println("[TLS] ⚠️ No CA bundle on flash — HTTPS runs WITHOUT certificate validation.");
    return;
  }
  File f = LittleFS.open("/certs/ca-bundle.pem", "r");
  if (!f || f.size() == 0 || f.size() > 16384) {
    if (f) f.close();
    Serial.println("[TLS] ⚠️ CA bundle missing or oversized (>16KB) — skipping validation setup.");
    return;
  }
  tlsCaCertPem = f.readString();
  f.close();

  // Best-effort push into modem NV so AT-side HTTPS validates too. A failure here
  // only means the MODEM path stays unvalidated; WiFi path still uses the bundle.
  SerialAT.printf("AT+CCERTDOWN=\"ca-bundle.pem\",%d\r\n", tlsCaCertPem.length());
  unsigned long start = millis();
  bool ready = false;
  while (millis() - start < 5000) {
    while (SerialAT.available()) {
      String chunk = SerialAT.readString();
      if (chunk.indexOf('>') != -1 || chunk.indexOf("CONNECT") != -1) ready = true;
    }
    if (ready) break;
    delay(20);
    pumpGps();
    feedWDT();
  }
  if (ready) {
    SerialAT.print(tlsCaCertPem);
    delay(300);
    while (SerialAT.available()) SerialAT.read();
    SerialAT.println("AT+CSSLCFG=\"cacert\",0,\"ca-bundle.pem\"");
    delay(150); while (SerialAT.available()) SerialAT.read();
    Serial.println("[TLS] ✅ CA bundle loaded (" + String(tlsCaCertPem.length()) + " bytes, modem + WiFi).");
  } else {
    Serial.println("[TLS] ⚠️ Modem cert upload not acknowledged — modem path stays unvalidated.");
    while (SerialAT.available()) SerialAT.read();
  }
}

void applyTls(WiFiClientSecure &client) {
  if (tlsCaCertPem.length() > 0) client.setCACert(tlsCaCertPem.c_str());
  else client.setInsecure();
}

// Probe with the CA bundle but fail OPEN to unvalidated TLS — a stale bundle can
// never brick field connectivity; fallback is loudly logged.
bool probeTlsEndpoint(const char *host) {
  if (tlsCaCertPem.length() > 0) {
    WiFiClientSecure pinned;
    pinned.setCACert(tlsCaCertPem.c_str());
    pinned.setTimeout(3);
    feedWDT();
    if (pinned.connect(host, port)) {
      pinned.stop();
      return true;
    }
    Serial.println("[TLS] ⚠️ Pinned-CA handshake FAILED — falling back to unvalidated probe.");
  }
  WiFiClientSecure fallback;
  fallback.setInsecure();
  fallback.setTimeout(3);
  feedWDT();
  bool ok = fallback.connect(host, port);
  fallback.stop();
  return ok;
}

void connectWiFi() {
  if (wifiSsid.length() == 0) return;
  Serial.print("Connecting to WiFi: "); Serial.println(wifiSsid);
  WiFi.persistent(false); // We manage credentials in Preferences — never let the ESP32
                          // store/rejoin a stale network from its own NVS.
  WiFi.mode(WIFI_STA);
  WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 10000) {
    delay(500); feedWDT(); Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println(" associated!");
    feedWDT();
    if (probeTlsEndpoint(server)) {
      wifiHasInternet = true;
      lastInternetVerifyMs = millis();
      Serial.println("[WiFi] Internet verified.");
      // WiFi + internet success is logged to the admin System Logs terminal,
      // rate-limited to one entry per minute so a flapping network can't spam.
      static uint64_t lastWifiLogUs = 0;
      if (getMicrosMonotonic() - lastWifiLogUs >= 60000000ULL) {
        lastWifiLogUs = getMicrosMonotonic();
        logErrorToFirestore("WIFI", "Connected to WiFi '" + wifiSsid + "' — internet verified");
      }
      syncTime();
      return;
    } else {
      wifiHasInternet = false;
      Serial.println("[WiFi] AP connected but NO INTERNET.");
    }
  } else {
    wifiHasInternet = false;
    Serial.println(" failed.");
  }

  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
}

// Tear down a saved WiFi network: wipe our Preferences keys AND detach the radio
// with persistent storage disabled, or the ESP32 auto-rejoins and stays powered.
void clearWifiCredentials() {
  if (wifiSsid.length() == 0 && WiFi.status() != WL_CONNECTED) return; // nothing to clear

  wifiSsid = "";
  wifiPass = "";
  WiFi.persistent(false);      // don't let the ESP32 re-store a stale network in NVS
  WiFi.disconnect(true);       // force-drop any current association
  WiFi.mode(WIFI_OFF);         // fully power down the radio so it can't linger on the old AP
  preferences.begin("weather", false);
  preferences.remove("wifi_ssid");
  preferences.remove("wifi_pass");
  preferences.end();
  wifiHasInternet = false;
}

static uint8_t gprsFailCount = 0; // consecutive failed GPRS cycles - drives the no-operator recovery ladder

void connectGPRS() {
  feedWDT();
  int csq = modem.getSignalQuality();
  // No-operator escalation: the modem answers AT yet gprsConnect() can never succeed
  // while unregistered — escalate recovery each failed cycle instead of looping.
  if (!modem.isNetworkConnected()) {
    String op = modem.getOperator();
    Serial.printf("[CELLULAR] Not registered to any operator (%s) - consecutive GPRS failures: %d\n", op.c_str(), gprsFailCount);
    if (op.length() == 0) {
      Serial.println("[CELLULAR] Empty operator - SIM may be unregistered, deactivated, or out of coverage.");
    }
    if (gprsFailCount >= 9) {
      Serial.println("[CELLULAR] 9 consecutive GPRS failures - full modem power cycle...");
      recoverModem();
      gprsFailCount = 0;
    } else if (gprsFailCount >= 6) {
      Serial.println("[CELLULAR] 6 consecutive GPRS failures - radio restart (CFUN 0/1)...");
      SerialAT.println("AT+CFUN=0"); delay(1500); while (SerialAT.available()) SerialAT.read();
      SerialAT.println("AT+CFUN=1"); delay(1500); while (SerialAT.available()) SerialAT.read();
      waitForNetworkCustom(30000L);
    } else if (gprsFailCount >= 3) {
      Serial.println("[CELLULAR] 3 consecutive GPRS failures - re-selecting operator (AT+COPS=0)...");
      SerialAT.println("AT+COPS=0"); delay(300); while (SerialAT.available()) SerialAT.read();
      waitForNetworkCustom(30000L);
    }
  }

  if (csq == 99 || csq <= 0 || csq > 31) {
    Serial.printf("[CELLULAR] CSQ: %d (NO SIGNAL)\n", csq);
    if (wifiHasInternet) return;
  } else {
    Serial.printf("[CELLULAR] CSQ: %d ", csq);
    if (csq < 10) Serial.println("(WEAK)");
    else if (csq < 15) Serial.println("(FAIR)");
    else Serial.println("(GOOD)");
  }

  if (modem.isGprsConnected()) {
    SerialAT.println("AT+NETOPEN");
    delay(150);
    while (SerialAT.available()) SerialAT.read();
    return;
  }

  if (csq == 99 || csq <= 0 || csq > 31) return;

  Serial.print("Connecting to GPRS ("); Serial.print(apn); Serial.print(")...");
  for (int attempt = 0; attempt < 2; attempt++) {
    feedWDT();
    if (modem.gprsConnect(apn)) {
      Serial.println(" success!");
      gprsFailCount = 0;
      SerialAT.println("AT+NETOPEN");
      delay(150);
      while (SerialAT.available()) SerialAT.read();
      if (!wifiHasInternet) syncTime();
      return;
    }
    feedWDT();
    delay(1000);
  }

  if (!wifiHasInternet) {
    feedWDT();
    if (modem.gprsConnect("http.globe.com.ph")) {
      Serial.println(" Fallback APN success!");
      gprsFailCount = 0;
      SerialAT.println("AT+NETOPEN");
      delay(150);
      while (SerialAT.available()) SerialAT.read();
      syncTime();
      return;
    }
  }
  if (!wifiHasInternet) gprsFailCount++;
}

bool waitForNetworkCustom(unsigned long timeoutMs) {
  Serial.print("Waiting for network (2G/4G)...");
  unsigned long start = millis();
  while (millis() - start < timeoutMs) {
    feedWDT();
    pumpGps(); // registration can take 10-30 s — keep NMEA flowing meanwhile
    if (modem.isNetworkConnected()) {
      Serial.println(" Connected (TinyGSM)!");
      return true;
    }

    SerialAT.println("AT+CREG?");
    delay(250);
    String cregResp = "";
    while (SerialAT.available()) cregResp += (char)SerialAT.read();
    if (cregResp.indexOf("+CREG: 0,1") != -1 || cregResp.indexOf("+CREG: 0,5") != -1 ||
        cregResp.indexOf("+CREG: 1,1") != -1 || cregResp.indexOf("+CREG: 1,5") != -1) {
      Serial.println(" Connected (2G/3G CREG)!");
      return true;
    }

    SerialAT.println("AT+CEREG?");
    delay(250);
    String ceregResp = "";
    while (SerialAT.available()) ceregResp += (char)SerialAT.read();
    if (ceregResp.indexOf("+CEREG: 0,1") != -1 || ceregResp.indexOf("+CEREG: 0,5") != -1 ||
        ceregResp.indexOf("+CEREG: 1,1") != -1 || ceregResp.indexOf("+CEREG: 1,5") != -1) {
      Serial.println(" Connected (4G LTE CEREG)!");
      return true;
    }

    delay(1000);
  }
  Serial.println(" TIMEOUT");
  return false;
}

void recoverModem() {
  Serial.println("[MODEM RECOVERY] ⚠️ Modem is unresponsive or turned OFF! Executing hardware power cycle & re-init...");

  // 1. Hardware PWRKEY pulse to turn modem back ON
  digitalWrite(MODEM_PWRKEY, LOW);
  delay(100);
  digitalWrite(MODEM_PWRKEY, HIGH);
  delay(1000);
  digitalWrite(MODEM_PWRKEY, LOW);
  delay(3000);

  // 2. Re-initialize AT & SSL configurations
  modem.init();
  SerialAT.println("AT+CSSLCFG=\"sslversion\",0,3"); delay(100); while (SerialAT.available()) SerialAT.read();
  SerialAT.println("AT+CSSLCFG=\"enableSNI\",0,1"); delay(100); while (SerialAT.available()) SerialAT.read();
  SerialAT.println("AT+CSSLCFG=\"ignorertctime\",0,1"); delay(100); while (SerialAT.available()) SerialAT.read();
  SerialAT.println("AT+CFUN=1"); delay(100); while (SerialAT.available()) SerialAT.read();
  SerialAT.println("AT+CNMP=2"); delay(100); while (SerialAT.available()) SerialAT.read();

  // 3. Re-establish GPRS connection
  modem.gprsConnect(apn);
  SerialAT.println("AT+NETOPEN");
  delay(150);
  while (SerialAT.available()) SerialAT.read();
  Serial.println("[MODEM RECOVERY] ✅ Hardware power cycle & re-initialization complete.");
}

void ensureConnection() {
  feedWDT();
  digitalWrite(MODEM_DTR, LOW);

  if (wifiSsid.length() > 0 && WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  if (WiFi.status() == WL_CONNECTED && wifiHasInternet) {
    // Cache a successful verification for 60s — ensureConnection() runs on every
    // upload/config cycle and a fresh TLS handshake each time is pure overhead.
    if (millis() - lastInternetVerifyMs < 60000UL) {
      // Recently verified — trust the cached result.
    } else {
      feedWDT();
      if (!probeTlsEndpoint(server)) {
        wifiHasInternet = false;
        Serial.println("[WiFi] Lost internet — switching to cellular.");
      } else {
        lastInternetVerifyMs = millis();
      }
    }
  }

  // Self-healing: If modem is turned off, frozen, or not responding to AT commands, trigger hardware recovery
  if (!modem.testAT(500)) {
    recoverModem();
  }

  if (!modem.isGprsConnected()) {
    connectGPRS();
  }
}

// Non-blocking NMEA drain: keeps the GPS UART from overflowing during long blocking
// waits. Do NOT call blocking updateGPS() here — it waits up to 15 s for a fix.
void pumpGps() {
  while (SerialGPS.available()) {
    gps.encode(SerialGPS.read());
  }
}

void updateGPS() {
  unsigned long gpsStart = millis();
  const unsigned long GPS_TIMEOUT_MS = 15000;
  bool gotFix = false;

  while (millis() - gpsStart < GPS_TIMEOUT_MS) {
    while (SerialGPS.available()) {
      gps.encode(SerialGPS.read());
    }
    if (gps.location.isValid() && gps.location.isUpdated()) {
      latitude = gps.location.lat();
      longitude = gps.location.lng();
      gpsHasValidFix = true;
      gotFix = true;
      break;
    }
    feedWDT();
    delay(10);
  }
  if (!gotFix && gpsHasValidFix) {
    // Keep last known valid lat/lng
  }
}

// Shared AT-command HTTPS client used as fallback. strictJson: only fill responseBody
// when a JSON object is found (Firestore responses are always JSON).
int sendAtHttpRequest(const char *host, String method, String path, String payload,
                      String &responseBody, bool allowPut, bool strictJson, String extraHeaders) {
  responseBody = "";

  ensureConnection();
  while (SerialAT.available()) SerialAT.read();

  SerialAT.println("AT+HTTPTERM"); delay(150); while (SerialAT.available()) SerialAT.read();
  SerialAT.println("AT+HTTPINIT"); delay(150); while (SerialAT.available()) SerialAT.read();
  SerialAT.println("AT+HTTPPARA=\"CID\",1"); delay(100); while (SerialAT.available()) SerialAT.read();
  SerialAT.println("AT+HTTPPARA=\"SSLCFG\",0"); delay(100); while (SerialAT.available()) SerialAT.read();

  String fullUrl = "https://" + String(host) + path;
  SerialAT.printf("AT+HTTPPARA=\"URL\",\"%s\"\r\n", fullUrl.c_str());
  delay(150); while (SerialAT.available()) SerialAT.read();

  // Callers pass any required headers (method override, Authorization) pre-joined.
  if (extraHeaders.length() > 0) {
    SerialAT.print("AT+HTTPPARA=\"USERDATA\",\"");
    SerialAT.print(extraHeaders);
    SerialAT.println("\"");
    delay(100); while (SerialAT.available()) SerialAT.read();
  }

  if (payload.length() > 0) {
    SerialAT.println("AT+HTTPPARA=\"CONTENT\",\"application/json\"");
    delay(100); while (SerialAT.available()) SerialAT.read();

    SerialAT.printf("AT+HTTPDATA=%d,10000\r\n", payload.length());

    unsigned long dataStart = millis();
    bool gotDownload = false;
    String promptBuf = "";
    while (millis() - dataStart < 5000) {
      while (SerialAT.available()) {
        char c = SerialAT.read();
        promptBuf += c;
        if (promptBuf.indexOf("DOWNLOAD") != -1) {
          gotDownload = true;
          break;
        }
      }
      if (gotDownload) break;
      pumpGps();
      delay(10);
    }

    if (gotDownload) {
      SerialAT.print(payload);
      delay(300);
      while (SerialAT.available()) SerialAT.read();
    } else {
      SerialAT.println("AT+HTTPTERM");
      return -1;
    }
  }

  bool isPut = (allowPut && method == "PUT");
  int action = (method == "POST" || method == "PATCH" || isPut) ? 1 : 0;
  SerialAT.printf("AT+HTTPACTION=%d\r\n", action);

  unsigned long start = millis();
  int statusCode = -1;
  int dataLen = 0;
  while (millis() - start < 20000) {
    if (SerialAT.available()) {
      String line = SerialAT.readStringUntil('\n');
      line.trim();
      if (line.startsWith("+HTTPACTION:")) {
        int firstComma = line.indexOf(',');
        int secondComma = line.indexOf(',', firstComma + 1);
        if (firstComma != -1 && secondComma != -1) {
          statusCode = line.substring(firstComma + 1, secondComma).toInt();
          dataLen = line.substring(secondComma + 1).toInt();
        }
        break;
      }
    }
    pumpGps();
    feedWDT();
    delay(20);
  }

  // Read error response bodies as well (e.g. 401/403) so reasons are visible.
  if (dataLen > 0) {
    delay(150);
    while (SerialAT.available()) SerialAT.read();
    SerialAT.printf("AT+HTTPREAD=0,%d\r\n", dataLen);

    // Cap accumulated response at dataLen + 4KB so a misbehaving modem spewing
    // data can't grow the String unbounded and fragment/exhaust the heap.
    const size_t RESPONSE_CAP = (size_t)dataLen + 4096;
    String rawResponse = "";
    rawResponse.reserve(RESPONSE_CAP < 1024 ? RESPONSE_CAP : 1024);
    unsigned long readStart = millis();
    unsigned long totalStart = millis();
    bool capped = false;

    while (millis() - totalStart < 30000) {
      while (SerialAT.available()) {
        rawResponse += (char)SerialAT.read();
        readStart = millis();
        if (rawResponse.length() > RESPONSE_CAP) { capped = true; break; }
      }
      if (capped) break;
      // The A76XX ends large reads with a "+HTTPREAD: 0" terminator — prefer breaking
      // on it; the OK/length heuristic stays as a fallback for older firmwares.
      if (rawResponse.indexOf("+HTTPREAD: 0") != -1) break;
      if (rawResponse.indexOf("OK") != -1 && rawResponse.length() > dataLen) break;
      if (rawResponse.length() > 0 && (millis() - readStart > 5000)) break;
      pumpGps();
      feedWDT();
      delay(20);
    }

    // --- Reassemble the body from the +HTTPREAD block framing ---
    // The raw stream interleaves ~18-char block headers roughly every 1KB; substring
    // extraction once left them inside the idToken signature, causing 403
    // PERMISSION_DENIED on every call. Walk the framing: each marker is followed by
    // exactly <n> body bytes.
    String body = "";
    {
      size_t pos = 0;
      while (true) {
        int m = rawResponse.indexOf("+HTTPREAD: ", pos);
        if (m == -1) break;
        int lineEnd = rawResponse.indexOf("\r\n", m);
        if (lineEnd == -1) break;
        long n = rawResponse.substring(m + 11, lineEnd).toInt();
        if (n <= 0) break;  // "+HTTPREAD: 0" terminator block
        body += rawResponse.substring(lineEnd + 2, lineEnd + 2 + n);
        pos = lineEnd + 2 + (size_t)n;
      }
    }
    if (body.length() == 0) body = rawResponse;  // no block framing seen — raw fallback
    if ((int)body.length() != dataLen) {
      Serial.printf("[NET] ⚠️ HTTPREAD reassembled %u bytes but HTTPACTION reported %d — response framing suspect.\n",
                    (unsigned)body.length(), dataLen);
    }

    int jsonStart = body.indexOf('{');
    int jsonEnd = body.lastIndexOf('}');
    int arrStart = body.indexOf('[');
    int arrEnd = body.lastIndexOf(']');
    // runQuery returns a JSON ARRAY — keep it intact; otherwise fall back to the
    // first JSON object. Required to parse runQuery results over the modem.
    if (arrStart != -1 && arrEnd > arrStart && (jsonStart == -1 || arrStart <= jsonStart)) {
      responseBody = body.substring(arrStart, arrEnd + 1);
    } else if (jsonStart != -1 && jsonEnd != -1 && jsonEnd > jsonStart) {
      responseBody = body.substring(jsonStart, jsonEnd + 1);
    } else if (!strictJson) {
      responseBody = body;
    }
  }

  SerialAT.println("AT+HTTPTERM");
  delay(100);
  while (SerialAT.available()) SerialAT.read();

  return statusCode;
}

// --- Cellular HTTPS with real headers (modem TLS socket) ---
// AT+HTTPPARA="USERDATA" silently drops the ~1000-char idToken (requests went out
// anonymous → 403). Stream raw HTTP over a modem TLS socket (+CCHOPEN) instead, where
// headers of any length ride inside the encrypted tunnel.
static TinyGsmClientSecure modemTlsClient(modem, 0);

static int sendModemHttpsRequest(const char *host, const String &method, const String &path,
                                 const String &payload, String &responseBody,
                                 const String &bearer, bool patchOverride) {
  responseBody = "";
  modemTlsClient.stop();

  // Health gate: +CCHOPEN can't tell if the AT link/PDP context is alive — without
  // this, a dead GPRS session burns the full 75 s connect timeout every attempt.
  ensureConnection();

  // One bounded retry: a connected-but-empty response (peer reset) is usually
  // transient — a fresh +CCHOPEN on a closed socket recovers it in most cases.
  int statusCode = -1;
  for (int exchange = 0; exchange < 2; exchange++) {
    unsigned long t0 = millis();
    bool connected = false;
    for (int connectAttempt = 0; connectAttempt < 2 && !connected; connectAttempt++) {
      if (connectAttempt > 0) {
        // First attempt failed — clear the half-open socket state and confirm the AT
        // link before retrying; if the modem is gone entirely, defer recovery to the
        // next cycle's ensureConnection()/recoverModem().
        Serial.println(F("[NET] TLS connect failed — closing socket and retrying once."));
        SerialAT.println(F("AT+CCHCLOSE=0"));
        delay(200);
        while (SerialAT.available()) SerialAT.read();
        modemTlsClient.stop();
        if (!modem.testAT(2000)) {
          Serial.println(F("[NET] ❌ Modem unresponsive after TLS failure — deferring recovery to the next cycle."));
          return -1;
        }
      }
      feedWDT();
      connected = modemTlsClient.connect(host, 443);
    }
    if (!connected) {
      Serial.printf("[NET] ❌ Modem TLS socket connect failed (+CCHOPEN) after %lu ms — "
                    "check the [GSM_DEBUG] trace above for the +CCHOPEN error code.\n",
                    millis() - t0);
      return -1;
    }
    Serial.printf("[NET] TLS socket connected in %lu ms.\n", millis() - t0);

  String head;
  head.reserve(path.length() + bearer.length() + 192);
  head += method;
  head += " ";
  head += path;
  head += " HTTP/1.0\r\n";  // HTTP/1.0 + Connection: close → never chunked, EOF-delimited
  head += "Host: ";
  head += host;
  head += "\r\n";
  if (bearer.length() > 0) {
    head += "Authorization: Bearer ";
    head += bearer;
    head += "\r\n";
  }
  if (patchOverride) {
    head += "X-HTTP-Method-Override: PATCH\r\n";
  }
  head += "Content-Type: application/json\r\n";
  head += "Content-Length: ";
  head += String(payload.length());
  head += "\r\nConnection: close\r\n\r\n";

  // Send the whole head in ONE +CCHSEND — chunking creates extra TLS record
  // boundaries, and a single mangled byte in the bearer reads as a tampered JWT
  // (403 PERMISSION_DENIED). If rejected, abort and let the retry loop re-open.
  size_t sent = modemTlsClient.print(head);
  if (sent != head.length()) {
    Serial.printf("[NET] ❌ +CCHSEND rejected the request head (%u of %u bytes sent).\n",
                  (unsigned)sent, (unsigned)head.length());
    modemTlsClient.stop();
    if (exchange == 0) { feedWDT(); delay(1000); continue; }
    return -1;
  }
  if (payload.length() > 0) {
    sent += modemTlsClient.print(payload);
    if (sent != head.length() + payload.length()) {
      Serial.printf("[NET] ❌ +CCHSEND rejected the request body (%u of %u bytes sent).\n",
                    (unsigned)sent, (unsigned)(head.length() + payload.length()));
      modemTlsClient.stop();
      if (exchange == 0) { feedWDT(); delay(1000); continue; }
      return -1;
    }
  }
  Serial.printf("[NET] Request sent: %u of %u bytes (headers %u, body %u).\n",
                (unsigned)sent, (unsigned)(head.length() + payload.length()),
                (unsigned)head.length(), (unsigned)payload.length());

  // Drain headers + body until the server closes the connection (or timeout).
  const size_t RESPONSE_CAP = 96 * 1024;
  String rawResponse;
  rawResponse.reserve(2048);
  unsigned long totalStart = millis();
  unsigned long lastData = millis();
  while (millis() - totalStart < 30000UL) {
    bool gotData = false;
    while (modemTlsClient.available()) {
      if (rawResponse.length() >= RESPONSE_CAP) break;
      rawResponse += (char)modemTlsClient.read();
      gotData = true;
    }
    if (gotData) lastData = millis();
    if (rawResponse.length() >= RESPONSE_CAP) break;
    if (!modemTlsClient.connected() && !modemTlsClient.available() &&
        millis() - lastData > 1500) {
      break;
    }
    if (millis() - lastData > 8000UL) break;
    pumpGps();
    feedWDT();
    delay(10);
  }
  Serial.printf("[NET] Response: %u bytes in %lu ms, framing %s.\n",
                (unsigned)rawResponse.length(), millis() - t0,
                rawResponse.startsWith("HTTP/") ? "OK (HTTP/…)" : "MISSING (empty or garbage)");
  modemTlsClient.stop();

  if (rawResponse.startsWith("HTTP/")) {
    int sp = rawResponse.indexOf(' ');
    statusCode = rawResponse.substring(sp + 1).toInt();
  }

  // Extract the JSON body (same array/object handling as the modem HTTP engine —
  // runQuery replies are JSON arrays).
  int jsonStart = rawResponse.indexOf('{');
  int jsonEnd   = rawResponse.lastIndexOf('}');
  int arrStart  = rawResponse.indexOf('[');
  int arrEnd    = rawResponse.lastIndexOf(']');
  if (arrStart != -1 && arrEnd > arrStart && (jsonStart == -1 || arrStart <= jsonStart)) {
    responseBody = rawResponse.substring(arrStart, arrEnd + 1);
  } else if (jsonStart != -1 && jsonEnd > jsonStart) {
    responseBody = rawResponse.substring(jsonStart, jsonEnd + 1);
  } else {
    responseBody = "";
  }

  // A connected-but-empty exchange (peer reset → 0-byte "framing MISSING" response)
  // is usually transient: retry the whole exchange exactly once before giving up.
  if (statusCode == -1 && exchange == 0) {
    Serial.println(F("[NET] ⚠️ Invalid/empty HTTPS response — retrying the exchange once."));
    feedWDT();
    delay(1000);
    continue;
  }
  break;
  }
  return statusCode;
}

// --- Authenticated transport wrappers ---
// Both transports attach the device idToken and retry once after a forced token
// refresh on 401/403; fall back to legacy unauthenticated behavior without credentials.

// Selects the transport for an HTTP wrapper: WiFi when verified, else the modem.
// This is the single place that decides "which internet am I on right now?"
static bool wifiLinkActive() {
  return WiFi.status() == WL_CONNECTED && wifiHasInternet;
}

// --- Transport-aware auth ---
// WiFi: WiFiClientSecure + HttpClient with Authorization: Bearer.
// Cellular: A7670 hardware HTTPS engine (sendAtHttpRequest).

static int firestoreOnce(String method, String path, String payload, String &responseBody, const String &bearer) {
  responseBody = "";

  if (wifiLinkActive()) {
    wifiHttp.stop();
    wifiHttp.beginRequest();
    if (method == "GET") wifiHttp.get(path);
    else if (method == "POST") wifiHttp.post(path);
    else if (method == "PATCH") wifiHttp.patch(path);

    if (bearer.length() > 0) {
      wifiHttp.sendHeader("Authorization", "Bearer " + bearer);
    }
    if (method == "PATCH") {
      wifiHttp.sendHeader("X-HTTP-Method-Override", "PATCH");
    }

    if (method != "GET" && payload.length() > 0) {
      wifiHttp.sendHeader("Content-Type", "application/json");
      wifiHttp.sendHeader("Content-Length", String(payload.length()));
      wifiHttp.beginBody();
      wifiHttp.print(payload);
      wifiHttp.endRequest();
    } else {
      wifiHttp.endRequest();
    }

    int status = wifiHttp.responseStatusCode();
    if (status > 0) responseBody = wifiHttp.responseBody();
    wifiHttp.stop();
    return status;
  }

  // Modem (SIM/GPRS): raw HTTP over the modem's +CCH TLS socket. The old AT+HTTP
  // engine dropped the ~1000-char Authorization header (USERDATA limit) → 403.
  Serial.printf("[AUTH] Modem path: TLS socket request, Authorization header %s (%u chars).\n",
                bearer.length() > 0 ? "attached" : "ABSENT", (unsigned)bearer.length());
  return sendModemHttpsRequest(server, method, path, payload, responseBody, bearer,
                               method == "PATCH");
}

int sendFirestoreRequest(String method, String path, String payload, String &responseBody) {
  deviceEnsureIdToken(false);

  int status = firestoreOnce(method, path, payload, responseBody, firebaseIdToken);
  if ((status == 401 || status == 403) && deviceEnsureIdToken(true)) {
    Serial.println("[AUTH] Firestore request rejected — refreshing idToken and retrying once.");
    Serial.printf("[AUTH]   (HTTP %d) %.180s\n", status, responseBody.c_str());
    status = firestoreOnce(method, path, payload, responseBody, firebaseIdToken);
  }
  return status;
}

// --- Device identity: sign-in / refresh / ensure ---------------------------------------

bool deviceHasCredentials() {
  return DEVICE_EMAIL[0] != '\0' && DEVICE_PASSWORD[0] != '\0';
}

// POST to a Google identity endpoint over whichever transport is currently alive.
static int postIdentityEndpoint(const char *host, const char *pathWithKey,
                                const String &body, String &responseBody) {
  responseBody = "";
  if (WiFi.status() == WL_CONNECTED && wifiHasInternet) {
    WiFiClientSecure client;
    applyTls(client);
    client.setTimeout(8);
    HttpClient http(client, host, port);
    http.post(pathWithKey, "application/json", body);
    int status = http.responseStatusCode();
    if (status > 0) responseBody = http.responseBody();
    http.stop();
    return status;
  }

  return sendAtHttpRequest(host, "POST", pathWithKey, body, responseBody, false, true, "");
}

// --- idToken diagnostics ---
// Decodes the JWT payload (no signature check) — useful because a tampered token
// and a rules denial return the SAME 403.
static int b64val(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;  // '=' padding or garbage
}

static void logIdTokenDiagnostics(const char *via) {
  if (firebaseIdToken.length() == 0) { Serial.println("[AUTH] ⚠️ idToken is empty."); return; }
  const int dot1 = firebaseIdToken.indexOf('.');
  const int dot2 = firebaseIdToken.indexOf('.', dot1 + 1);
  // A JWT has exactly two dots: header.payload.signature. A third dot means
  // junk was spliced into the string somewhere.
  const bool jwtShaped = (dot1 > 0 && dot2 > dot1);
  const bool extraDot = jwtShaped && firebaseIdToken.indexOf('.', dot2 + 1) > dot2;
  const char *tail = firebaseIdToken.c_str() + firebaseIdToken.length() - 6;
  Serial.printf("[AUTH] idToken: len=%u jwt=%s%s via=%s head=%.6s tail=%.6s\n",
                (unsigned)firebaseIdToken.length(), jwtShaped ? "yes" : "NO",
                extraDot ? "+extra-dot" : "", via,
                firebaseIdToken.c_str(), tail);
  if (!jwtShaped) return;

  String p = firebaseIdToken.substring(dot1 + 1, dot2);
  p.replace("-", "+");
  p.replace("_", "/");
  while (p.length() % 4) p += '=';
  static uint8_t decoded[768];
  size_t out = 0;
  for (size_t i = 0; i + 3 < p.length() && out + 3 < sizeof(decoded); i += 4) {
    int a = b64val(p[i]), b = b64val(p[i + 1]), c = b64val(p[i + 2]), d = b64val(p[i + 3]);
    if (a < 0 || b < 0) break;
    decoded[out++] = (a << 2) | (b >> 4);
    if (c < 0) break;
    decoded[out++] = ((b & 0x0F) << 4) | (c >> 2);
    if (d < 0) break;
    decoded[out++] = ((c & 0x03) << 6) | d;
  }
  decoded[out] = 0;

  JsonDocument doc;
  if (deserializeJson(doc, decoded) != DeserializationError::Ok) {
    Serial.println("[AUTH] ⚠️ idToken payload is not valid JSON — token string is corrupted.");
    return;
  }
  const char *role  = doc["role"].is<const char*>() ? doc["role"].as<const char*>() : "ABSENT";
  const char *email = doc["email"].is<const char*>() ? doc["email"].as<const char*>() : "none";
  const char *aud   = doc["aud"].is<const char*>() ? doc["aud"].as<const char*>() : "?";
  const char *sub   = doc["sub"].is<const char*>() ? doc["sub"].as<const char*>() : "?";
  unsigned long expIn = 0;
  if (doc["exp"].is<unsigned long>()) {
    time_t now = time(nullptr);
    if (now > 1000000000UL) expIn = doc["exp"].as<unsigned long>() - (unsigned long)now;
  }
  Serial.printf("[AUTH] token says: role=%s aud=%s email=%s sub=%.10s expIn=%lus\n",
                role, aud, email, sub, (unsigned long)expIn);
  if (strcmp(email, DEVICE_EMAIL) != 0) {
    Serial.printf("[AUTH] ❌ Token belongs to '%s' but DEVICE_EMAIL is '%s' —\n"
                  "       the sketch signing in is NOT the account that holds the role claim.\n"
                   "       Fix DEVICE_EMAIL on this build, or run grant-roles.mjs for '%s'.\n",
                  email, DEVICE_EMAIL, email);
  } else if (strcmp(role, "device") != 0) {
    Serial.println("[AUTH] ⚠️ Correct account, but role claim is not 'device' — run scripts/grant-roles.mjs, then power-cycle to re-sign-in.");
  }
}

static bool deviceSignIn() {
  JsonDocument req;
  req["email"] = DEVICE_EMAIL;
  req["password"] = DEVICE_PASSWORD;
  req["returnSecureToken"] = true;
  String body; serializeJson(req, body);

  String resp;
  String pathWithKey = "/v1/accounts:signInWithPassword?key=" + firebaseApiKey;
  int status = postIdentityEndpoint("identitytoolkit.googleapis.com",
                                    pathWithKey.c_str(), body, resp);
  if (status != 200) {
    Serial.printf("[AUTH] ⚠️ Device sign-in failed (HTTP %d). %s\n", status, resp.c_str());
    return false;
  }
  // A clean response is ~1340 bytes (idToken 960 + refreshToken 247 + envelope);
  // other lengths mean the modem mangled the read or a different account signed in.
  Serial.printf("[AUTH] Sign-in response: %u bytes.\n", (unsigned)resp.length());

  JsonDocument res;
  if (deserializeJson(res, resp) != DeserializationError::Ok ||
      !res["idToken"].is<const char*>() || !res["refreshToken"].is<const char*>()) {
    Serial.println("[AUTH] ⚠️ Sign-in response missing tokens.");
    return false;
  }

  firebaseIdToken = res["idToken"].as<String>();
  firebaseRefreshToken = res["refreshToken"].as<String>();
  logIdTokenDiagnostics("fresh sign-in");
  unsigned long expiresInSec = res["expiresIn"].is<unsigned long>() ? res["expiresIn"].as<unsigned long>() : 3600UL;
  idTokenExpiryUs = getMicrosMonotonic()
                    + ((uint64_t)expiresInSec * 1000000ULL)
                    - ID_TOKEN_REFRESH_MARGIN_US;
  Serial.printf("[AUTH] ✅ Device signed in. Token valid for ~%lus.\n", (unsigned long)expiresInSec);
  return true;
}

static bool deviceRefreshIdToken() {
  if (firebaseRefreshToken.length() == 0) return false;

  JsonDocument req;
  req["grant_type"] = "refresh_token";
  req["refresh_token"] = firebaseRefreshToken;
  String body; serializeJson(req, body);

  String resp;
  String pathWithKey = "/v1/token?key=" + firebaseApiKey;
  int status = postIdentityEndpoint("securetoken.googleapis.com",
                                    pathWithKey.c_str(), body, resp);
  if (status != 200) return false;

  JsonDocument res;
  if (deserializeJson(res, resp) != DeserializationError::Ok || !res["id_token"].is<const char*>()) return false;

  firebaseIdToken = res["id_token"].as<String>();
  if (res["refresh_token"].is<const char*>()) firebaseRefreshToken = res["refresh_token"].as<String>();
  logIdTokenDiagnostics("token refresh");
  unsigned long expiresInSec = res["expires_in"].is<unsigned long>() ? res["expires_in"].as<unsigned long>() : 3600UL;
  idTokenExpiryUs = getMicrosMonotonic()
                    + ((uint64_t)expiresInSec * 1000000ULL)
                    - ID_TOKEN_REFRESH_MARGIN_US;
  Serial.printf("[AUTH] 🔄 idToken refreshed (valid ~%lus).\n", (unsigned long)expiresInSec);
  return true;
}

bool deviceEnsureIdToken(bool forceRefresh) {
  if (!deviceHasCredentials()) return false;

  uint64_t nowUs = getMicrosMonotonic();
  if (!forceRefresh && firebaseIdToken.length() > 0 && nowUs < idTokenExpiryUs) return true;

  // Prefer silent refresh; fall back to a full password sign-in.
  if (firebaseRefreshToken.length() > 0 && deviceRefreshIdToken()) return true;
  return deviceSignIn();
}

void readAllSensors() {
  if (sensorsCachedThisCycle) return;

  cachedTemp = 0.0; cachedHum = 0.0; cachedPres = 0.0;
  if (bmeAvailable) {
    float t = bme.readTemperature();
    float h = bme.readHumidity();
    float p = bme.readPressure() / 100.0F;
    if (!isnan(t)) cachedTemp = t + tempOffset;
    if (!isnan(h)) cachedHum = h;
    if (!isnan(p)) { cachedPres = p; recordPressure(p); }
  }

  cachedLux = -1.0;
  if (bh1750Available) {
    float lux = lightMeter.readLightLevel();
    if (lux >= 0) cachedLux = lux;
  }

  // Ultrasonic EMI protection: skip reads during modem power-up (boot grace)
  // and SMS transmit bursts — both emit GSM RF that corrupts the echo.
  if (bootGraceActive) {
    if (millis() - bootGraceStart >= BOOT_GRACE_MS) {
      bootGraceActive = false;
      Serial.println(F("[BOOT] ✅ Boot grace ended - ultrasonic sensor now active"));
    }
  }

  if (!bootGraceActive && !smsTxWindow) {
    cachedWaterLevel = calculateWaterLevel();
    cachedRiseRate = calculateWaterRiseRate(cachedWaterLevel);
  }

  cachedBattVolt = readBatteryVoltage();

  cachedDewPoint = calculateDewPoint(cachedTemp, cachedHum);
  cachedHeatIndex = calculateHeatIndex(cachedTemp, cachedHum);
  cachedCloudCover = estimateCloudCover(cachedLux);
  cachedPresTrend = calculatePressureTrend();
  cachedRainIntensity = classifyRainIntensity(getRainRate_mmh());

  sensorsCachedThisCycle = true;
}

void uploadLiveToFirestore() {
  readAllSensors();

  String path = "/v1/projects/" + firebaseProjectId + "/databases/(default)/documents/weather/current?key=" + firebaseApiKey;

  JsonDocument doc;
  JsonObject flds = doc["fields"].to<JsonObject>();
  // "rainfall" is TODAY'S rain (resets at midnight) — every consumer (dashboard hero,
  // threshold bar, history charts) treats it as a daily running total, never cumulative.
  flds["rainfall"]["doubleValue"] = getRainToday_mm();
  flds["lat"]["doubleValue"] = latitude;
  flds["lng"]["doubleValue"] = longitude;
  flds["lastSeen"]["stringValue"] = getISOTime();
  flds["temperature"]["doubleValue"] = cachedTemp;
  flds["humidity"]["doubleValue"] = cachedHum;
  flds["pressure"]["doubleValue"] = cachedPres;
  flds["lightLevel"]["doubleValue"] = cachedLux;
  flds["waterLevel"]["doubleValue"] = cachedWaterLevel;
  flds["dewPoint"]["doubleValue"] = cachedDewPoint;
  flds["heatIndex"]["doubleValue"] = cachedHeatIndex;
  flds["rainRate"]["doubleValue"] = getRainRate_mmh();
  flds["rainRateUnit"]["stringValue"]     = rainRateUnit;
  flds["rainRateWindowMin"]["doubleValue"] = (double)rainRateWindowMin;
  flds["rainIntensity"]["stringValue"] = cachedRainIntensity;
  flds["cloudCover"]["doubleValue"] = cachedCloudCover;
  flds["pressureTrend"]["doubleValue"] = cachedPresTrend;
  flds["waterRiseRate"]["doubleValue"] = cachedRiseRate;
  flds["riseRateUnit"]["stringValue"]     = riseRateUnit;
  flds["riseRateWindowMin"]["doubleValue"] = (double)riseRateWindowMin;
  flds["battery"]["doubleValue"] = cachedBattVolt;
  // Additive health fields — extra keys in this PATCH are ignored by the dashboard,
  // so these cannot break existing consumers:
  flds["gpsFix"]["booleanValue"] = gpsHasValidFix; // lat/lng are 0,0 until the first fix
  flds["freeHeap"]["doubleValue"] = (double)ESP.getFreeHeap();
  flds["waterSensorOk"]["booleanValue"] = ultrasonicAvailable; // false during outages — dashboards can surface this instead of guessing from the "--" level

  String payload;
  serializeJson(doc, payload);

  Serial.println("\n>>> UPLOADING LIVE DATA TO FIRESTORE (weather/current) <<<");
  String resp;
  int statusCode = sendFirestoreRequest("PATCH", path, payload, resp);
  if (statusCode == 200) {
    Serial.println(">>> ✅ FIRESTORE LIVE STATUS DOC SUCCESS (HTTP 200) <<<");
  } else {
    Serial.printf(">>> ⚠️ LIVE UPLOAD FAILED (HTTP %d) <<<\n", statusCode);
  }
}

// Mid-dispatch telemetry: upload after every 10th recipient, never every gap — a slow
// upload would stack minutes onto a blast. Best-effort; failures never abort.
void maybeMidDispatchUpload() {
    unsigned long now = millis();
    if (lastUploadMillis != 0 && now - lastUploadMillis < (unsigned long)liveStreamIntervalSec * 1000UL) return;
    Serial.println("[SMS DISPATCH] Radio idle between recipients — running a due live-doc upload...");
    uploadLiveToFirestore();
    lastUploadMillis = now; // count the attempt so the main loop doesn't duplicate it right after the blast
}

bool uploadToHistory() {
  time_t now; time(&now);
  if (now < 1600000000) {
    Serial.println("[HISTORY] ⚠️ Time not synced yet — history entry skipped (not acked, will retry).");
    return false;
  }

  String path = "/v1/projects/" + firebaseProjectId + "/databases/(default)/documents/weather_history?key=" + firebaseApiKey;
  readAllSensors();

  JsonDocument doc;
  JsonObject flds = doc["fields"].to<JsonObject>();
  // Same daily-total semantics as the live doc — history consumers aggregate
  // this field per day (see dashboard.js dailyTotals).
  flds["rainfall"]["doubleValue"] = getRainToday_mm();
  flds["temperature"]["doubleValue"] = cachedTemp;
  flds["humidity"]["doubleValue"] = cachedHum;
  flds["pressure"]["doubleValue"] = cachedPres;
  flds["lightLevel"]["doubleValue"] = cachedLux;
  flds["waterLevel"]["doubleValue"] = cachedWaterLevel;
  flds["dewPoint"]["doubleValue"] = cachedDewPoint;
  flds["heatIndex"]["doubleValue"] = cachedHeatIndex;
  flds["rainRate"]["doubleValue"] = getRainRate_mmh();
  flds["rainRateUnit"]["stringValue"]     = rainRateUnit;
  flds["rainRateWindowMin"]["doubleValue"] = (double)rainRateWindowMin;
  flds["cloudCover"]["doubleValue"] = cachedCloudCover;
  flds["pressureTrend"]["doubleValue"] = cachedPresTrend;
  flds["waterRiseRate"]["doubleValue"] = cachedRiseRate;
  flds["riseRateUnit"]["stringValue"]     = riseRateUnit;
  flds["riseRateWindowMin"]["doubleValue"] = (double)riseRateWindowMin;
  flds["timestamp"]["timestampValue"] = getISOTime();

  String payload; serializeJson(doc, payload);
  String resp;
  int statusCode = sendFirestoreRequest("POST", path, payload, resp);
  if (statusCode == 200 || statusCode == 201) {
    Serial.println(">>> ✅ FIREBASE HISTORY LOG CREATED <<<");
    return true;
  }
  Serial.printf(">>> ⚠️ HISTORY UPLOAD FAILED (HTTP %d) - Saving to Offline LittleFS Queue <<<\n", statusCode);
  // Counts as delivered only if the record was durably queued for later flush —
  // otherwise the caller leaves the alert level unacked and retries with backoff.
  return saveOfflineReading(payload);
}

// ==============================================================
//              REAL-TIME CONFIG & ALERTS
// ==============================================================

// Clamp cloud-fetched values to sane ranges so an admin-panel typo can't brick
// the sampling cadence, disable all alerts, or spam SMS blasts.
float clampFloat(float v, float lo, float hi) { return (v < lo) ? lo : (v > hi) ? hi : v; }

void fetchConfig() {
  String path = "/v1/projects/" + firebaseProjectId + "/databases/(default)/documents/weather/config?key=" + firebaseApiKey;
  String response;
  int statusCode = sendFirestoreRequest("GET", path, "", response);

  if (statusCode == 200) {
    response.trim();
    if (response.length() == 0 || response[0] != '{') return;

    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, response);
    if (error) return;

    if (doc.containsKey("fields")) {
      JsonObject fields = doc["fields"];

      auto getDouble = [&](const char* key, float defaultValue) -> float {
          if (!fields.containsKey(key)) return defaultValue;
          JsonObject field = fields[key];
          if (field.containsKey("doubleValue")) return field["doubleValue"].as<float>();
          if (field.containsKey("integerValue")) return field["integerValue"].as<String>().toFloat();
          return defaultValue;
      };

      auto getInt = [&](const char* key, int defaultValue) -> int {
          if (!fields.containsKey(key)) return defaultValue;
          JsonObject field = fields[key];
          if (field.containsKey("integerValue")) return field["integerValue"].as<String>().toInt();
          if (field.containsKey("doubleValue")) return field["doubleValue"].as<int>();
          return defaultValue;
      };

      alertL1Rain = clampFloat(getDouble("alertL1Rain", alertL1Rain), 0.0f, 10000.0f);
      alertL1WaterRise = clampFloat(getDouble("alertL1WaterRise", alertL1WaterRise), 0.0f, 100.0f);
      if (fields.containsKey("alertMessageL1")) {
        alertMessageL1 = fields["alertMessageL1"]["stringValue"].as<String>();
      }

      alertL2Rain = clampFloat(getDouble("alertL2Rain", alertL2Rain), 0.0f, 10000.0f);
      alertL2WaterRise = clampFloat(getDouble("alertL2WaterRise", alertL2WaterRise), 0.0f, 100.0f);
      if (fields.containsKey("alertMessageL2")) {
        alertMessageL2 = fields["alertMessageL2"]["stringValue"].as<String>();
      } else if (fields.containsKey("alertMessage")) {
        alertMessageL2 = fields["alertMessage"]["stringValue"].as<String>();
      }

      alertL3Rain = clampFloat(getDouble("alertL3Rain", alertL3Rain), 0.0f, 10000.0f);
      alertL3WaterRise = clampFloat(getDouble("alertL3WaterRise", alertL3WaterRise), 0.0f, 100.0f);
      alertL1RainRate = clampFloat(getDouble("alertL1RainRate", alertL1RainRate), 0.0f, 500.0f);
      alertL2RainRate = clampFloat(getDouble("alertL2RainRate", alertL2RainRate), 0.0f, 500.0f);
      alertL3RainRate = clampFloat(getDouble("alertL3RainRate", alertL3RainRate), 0.0f, 500.0f);
      alertL1WaterLevel = clampFloat(getDouble("alertL1WaterLevel", alertL1WaterLevel), 0.0f, 1000.0f);
      alertL2WaterLevel = clampFloat(getDouble("alertL2WaterLevel", alertL2WaterLevel), 0.0f, 1000.0f);
      alertL3WaterLevel = clampFloat(getDouble("alertL3WaterLevel", alertL3WaterLevel), 0.0f, 1000.0f);
      if (fields.containsKey("alertMessageL3")) {
        alertMessageL3 = fields["alertMessageL3"]["stringValue"].as<String>();
      }

      if (fields.containsKey("alertMessage")) {
        alertMessage = fields["alertMessage"]["stringValue"].as<String>();
      }

      if (fields.containsKey("wifiSSID")) {
        String newSsid = fields["wifiSSID"]["stringValue"].as<String>();
        newSsid.trim();
        if (newSsid.length() == 0) {
          // Blank field means "no WiFi" — clear the stored credential so the device
          // stops trying to rejoin the old network instead of keeping a stale one.
          if (wifiSsid.length() > 0) {
            clearWifiCredentials();
          }
        } else if (newSsid != wifiSsid) {
          wifiSsid = newSsid;
          preferences.begin("weather", false);
          preferences.putString("wifi_ssid", wifiSsid);
          preferences.end();
          wifiHasInternet = false;
        }
      } else if (wifiSsid.length() > 0) {
        // Field absent entirely — same clear semantics.
        clearWifiCredentials();
      }
      if (fields.containsKey("wifiPass")) {
        String newPass = fields["wifiPass"]["stringValue"].as<String>();
        if (newPass != wifiPass) {
          wifiPass = newPass;
          preferences.begin("weather", false);
          preferences.putString("wifi_pass", wifiPass);
          preferences.end();
          wifiHasInternet = false;
        }
      }

      alertCooldownHours = clampFloat(getDouble("alertCooldown", alertCooldownHours), 0.1f, 72.0f);
      // weather_history cadence, in minutes (1 min – 24 h; default 60).
      historyIntervalMs = (unsigned long)clampFloat(getInt("historyIntervalMin", (int)(historyIntervalMs / 60000UL)), 1.0f, 1440.0f) * 60000UL;
      Serial.printf("[CONFIG] History log interval: %lu min (historyIntervalMin)\n", (unsigned long)(historyIntervalMs / 60000UL));
      if (fields.containsKey("liveStreamInterval")) liveStreamIntervalSec = (int)clampFloat(getInt("liveStreamInterval", liveStreamIntervalSec), 5.0f, 3600.0f);

      if (fields.containsKey("maintenanceMode")) {
        maintenanceMode = fields["maintenanceMode"]["booleanValue"];
      }

      // Admin-configurable rate computation (units & sliding windows).
      // Canonical thresholds/alerts never change unit; only reporting/display does.
      if (fields.containsKey("rainRateUnit")) {
        String u = fields["rainRateUnit"]["stringValue"].as<String>(); u.trim();
        if (u == "mm/h" || u == "mm/min") rainRateUnit = u;
      }
      if (fields.containsKey("riseRateUnit")) {
        String u = fields["riseRateUnit"]["stringValue"].as<String>(); u.trim();
        if (u == "cm/h" || u == "cm/min") riseRateUnit = u;
      }
      if (fields.containsKey("rainRateWindowMin")) {
        int v = getInt("rainRateWindowMin", rainRateWindowMin);
        if (v == 5 || v == 10 || v == 60) rainRateWindowMin = v;
      }
      if (fields.containsKey("riseRateWindowMin")) {
        int v = getInt("riseRateWindowMin", riseRateWindowMin);
        if (v == 5 || v == 10 || v == 60) { riseRateWindowMin = v; riseRateWindowMs = (unsigned long)v * 60000UL; }
      }
      if (fields.containsKey("riseSmoothMin")) {
        int v = getInt("riseSmoothMin", riseSmoothMin);
        if (v >= 1 && v <= 5) { riseSmoothMin = v; riseSmoothSlots = v * 6; }
      }
      checkRateSettingsChanged();

      tempOffset = clampFloat(getDouble("tempOffset", tempOffset), -20.0f, 20.0f);
      waterOffset = clampFloat(getDouble("waterOffset", waterOffset), -100.0f, 100.0f);
      sensorHeightCm = clampFloat(getDouble("mountHeight", sensorHeightCm), 50.0f, 1000.0f);

      if (fields.containsKey("manualSmsTrigger")) {
        bool trigger = fields["manualSmsTrigger"]["booleanValue"];
        if (trigger) {
          manualSmsLevelRequest = 0;
          if (fields.containsKey("manualSmsLevel") && fields["manualSmsLevel"].containsKey("stringValue")) {
            String lvl = fields["manualSmsLevel"]["stringValue"].as<String>();
            lvl.trim();
            if (lvl == "1" || lvl == "2" || lvl == "3") manualSmsLevelRequest = lvl.toInt();
          }
          Serial.printf("⚡ MANUAL SMS TRIGGER DETECTED FROM ADMIN! (mode: %d — 0=live, 1-3=forced level)\n", manualSmsLevelRequest);
          int manualAck = 0;
          smsTxWindow = true;   // suppress rain-gauge ISR during GSM TX bursts (EMI phantom tips)
          fetchUsersAndSendSMS(manualAck); // Manual test — dispatch result not tied to alert state machine
          smsTxWindow = false;
          manualSmsLevelRequest = 0; // consumed — one-shot edge trigger
          resetManualTrigger();
          return;
        }
      }

      // Admin-triggered sensor data reset (one-shot flag, like manualSmsTrigger):
      // zeroes rain tips/totals/rate + ultrasonic history. GPS untouched.
      if (fields.containsKey("sensorResetTrigger") &&
          fields["sensorResetTrigger"]["booleanValue"]) {
        Serial.println("⚡ SENSOR RESET TRIGGER DETECTED FROM ADMIN!");
        resetSensorData();
        resetSensorTrigger(); // consume the flag so the reset runs exactly once
      }

      if (fields.containsKey("usersVersion")) {
        // usersVersion is Date.now() — a 13-digit millisecond value (~1.7e12).
        // Parse it as a true 64-bit integer: the old getDouble() path returned a
        // float (≈7 significant digits, so the value was already lossy) and then
        // cast an out-of-range float to a 32-bit unsigned long (undefined
        // behaviour). The comparison below therefore silently failed and the
        // recipient cache never refreshed when a user changed their phone number.
        uint64_t ver = 0;
        JsonObject verField = fields["usersVersion"];
        if (verField["integerValue"].is<const char*>()) {
          ver = strtoull(verField["integerValue"].as<const char*>(), nullptr, 10);
        } else if (verField["integerValue"].is<long long>()) {
          ver = (uint64_t)verField["integerValue"].as<long long>();
        } else if (verField["doubleValue"].is<double>()) {
          ver = (uint64_t)verField["doubleValue"].as<double>();
        }
        if (ver > lastSyncedUsersVersion) {
          Serial.printf("[USERS SYNC] 🔄 Users list update detected in Firestore (%llu > %llu)! Triggering LittleFS sync...\n",
                        (unsigned long long)ver, (unsigned long long)lastSyncedUsersVersion);
          uint64_t prevVersion = lastSyncedUsersVersion;
          lastSyncedUsersVersion = ver;
          if (!syncRecipientsFromFirebase()) {
            // Roll the version back so the next config poll retries promptly.
            // Otherwise a transient failure would leave the new phone number
            // un-synced for up to 6 h (the periodic sync is NVS-backed and NVS
            // still holds the old value).
            lastSyncedUsersVersion = prevVersion;
            Serial.println("[USERS SYNC] ⚠️ Sync failed — version rolled back; will retry on the next config poll.");
          }
        }
      }

      maxClearSkyLux = clampFloat(getDouble("maxClearLux", maxClearSkyLux), 1000.0f, 200000.0f);
      basePressure = clampFloat(getDouble("basePressure", basePressure), 800.0f, 1100.0f);
    }
  }
}

void checkDailyRainReset() {
  time_t now; time(&now);
  if (now < 1600000000) return; // Time not synced yet

  struct tm timeinfo;
  localtime_r(&now, &timeinfo);

  int currentDay = timeinfo.tm_mday;
  int currentMon = timeinfo.tm_mon + 1;
  int currentYear = timeinfo.tm_year + 1900;

  preferences.begin("weather", false);
  int savedDay = preferences.getInt("lastResetDay", -1);
  int savedMon = preferences.getInt("lastResetMon", -1);
  int savedYear = preferences.getInt("lastResetYear", -1);

  if (savedDay == -1 || savedMon == -1 || savedYear == -1) {
    preferences.putInt("lastResetDay", currentDay);
    preferences.putInt("lastResetMon", currentMon);
    preferences.putInt("lastResetYear", currentYear);
    preferences.end();
    Serial.printf("[RAIN RESET] Baseline date initialized (%04d-%02d-%02d).\n",
                  currentYear, currentMon, currentDay);
    return;
  }

  if (currentDay != savedDay || currentMon != savedMon || currentYear != savedYear) {
    todayTips = 0;
    dailyRainfall = 0.0;
    lastAlertLevelSent = 0;    // Reset alert level tracking for the new day
    lastHistoryAckLevel = 0;

    preferences.putFloat("dailyRainfall", 0.0);
    preferences.putInt("lastResetDay", currentDay);
    preferences.putInt("lastResetMon", currentMon);
    preferences.putInt("lastResetYear", currentYear);
    preferences.end();

    Serial.printf("[RAIN RESET] 🌧️ Date changed from %04d-%02d-%02d to %04d-%02d-%02d! Daily rain reset to 0.0 mm\n",
                  savedYear, savedMon, savedDay, currentYear, currentMon, currentDay);
  } else {
    preferences.end();
  }
}

// Remote sensor data reset (admin "Reset Sensor Data"): zeroes bucket tips, daily
// rain, the 10-min rain-rate window, and the ultrasonic rise pipeline so the next
// valid reading starts a fresh baseline. GPS + alert-escalation state untouched
// (measurement reset only — the midnight reset keeps its own rollover semantics).
void resetSensorData() {
  // Capture the pre-reset state for the audit log + serial report.
  float prevDailyRain = dailyRainfall;
  tip_count_t prevTips = todayTips;

  // --- Tipping bucket (rain) ---
  todayTips = 0;
  dailyRainfall = 0.0;
  memset(minuteTips, 0, sizeof(minuteTips)); // rate window reads 0 mm/h immediately
  lastTipTimeUs = INVALID_TIMESTAMP;
  // lastMinuteTickUs / currentIndex keep running: the circular clock stays
  // aligned to real time and the zeroed slots simply report a 0 rate.

  // --- Ultrasonic water level / rise rate ---
  waterLevelHistoryCount = 0;
  waterLevelHistoryIndex = 0;
  rateHistoryCount = 0;
  waterSmoothCount = 0;
  waterSmoothIndex = 0;
  waterSmoothSum = 0.0f;
  lastWaterLevel = -1.0f;
  lastWaterLevelTime = 0;
  lastValidWaterMs = 0;
  outageDecayLogged = false;
  waterRiseRateCMM = 0.0f;
  cachedWaterLevel = -1.0;
  cachedRiseRate = 0.0;
  consecutiveSampleFailures = 0;  // fresh health window — a flaky sensor gets a new chance
  ultrasonicAvailable = true;

  // Persist so a reboot can't resurrect old totals. Write only when the value
  // differs — a stuck trigger flag would otherwise re-flash NVS every poll.
  preferences.begin("weather", false);
  if (preferences.getFloat("dailyRainfall", 0.0f) != 0.0f) {
    preferences.putFloat("dailyRainfall", 0.0);
  }
  preferences.end();

  cachedRainIntensity = "None";

  Serial.printf("[SENSOR RESET] 🧹 Remote reset applied — cleared %.2f mm (%lu tips) + rain rate + water-level history (GPS untouched).\n",
                prevDailyRain, (unsigned long)prevTips);

  // Audit trail → admin System Logs terminal (same channel as DISPATCH).
  // Best-effort: a failed POST skips the entry; the reset is already complete.
  logErrorToFirestore("SENSOR_RESET",
      "Remote sensor reset applied — cleared " + String(prevDailyRain, 2) + " mm (" +
      String((unsigned long)prevTips) + " tips), rain rate, and water-level history.");
}

// Clear ONLY the sliding-window histories when the admin changes a unit or window.
// The daily rainfall total, GPS, and alert state are intentionally kept.
void resetRateHistories() {
  memset(minuteTips, 0, sizeof(minuteTips));   // rain-rate sliding window
  lastTipTimeUs = INVALID_TIMESTAMP;

  waterLevelHistoryCount = 0;
  waterLevelHistoryIndex = 0;
  rateHistoryCount = 0;
  waterSmoothCount = 0;
  waterSmoothIndex = 0;
  waterSmoothSum = 0.0f;
  lastWaterLevel = -1.0f;
  lastWaterLevelTime = 0;
  lastValidWaterMs = 0;
  outageDecayLogged = false;
  waterRiseRateCMM = 0.0f;
  cachedRiseRate = 0.0;
  consecutiveSampleFailures = 0;

  Serial.println("[RATE] 🔄 Sliding-window histories cleared (unit/window change) — re-warming with the new scheme.");
}

// After config is fetched: if the admin changed any rate unit/window/smoothing
// setting, clear the sliding-window histories so no data mixes between schemes.
// Persisted latches mean a reboot can't falsely trigger this. Uses the lighter
// resetRateHistories() — daily rain totals and GPS are deliberately untouched.
void checkRateSettingsChanged() {
  bool hasScheme = (lastRainRateUnit.length() > 0 || lastRiseRateUnit.length() > 0);
  bool changed =
      hasScheme &&
      (lastRainRateUnit != rainRateUnit ||
       lastRainRateWindowMin != rainRateWindowMin ||
       lastRiseRateUnit != riseRateUnit ||
       lastRiseRateWindowMin != riseRateWindowMin ||
       lastRiseSmoothMin != riseSmoothMin);

  if (changed) {
    resetRateHistories();
    // Log the NEW scheme that is now in use — the admin sees confirmation in the
    // System Logs that the updated rate computation was applied and is active.
    logErrorToFirestore("RATE_SCHEME",
        "Rate computation updated & applied — now using rain " + rainRateUnit + " " +
        String(rainRateWindowMin) + " min, rise " + riseRateUnit + " " +
        String(riseRateWindowMin) + " min, smoothing " + String(riseSmoothMin) +
        " min. Histories reset.");
    Serial.println("[RATE] ✅ Updated rate computation is now in use: rain " +
                   rainRateUnit + " " + String(rainRateWindowMin) + " min, rise " +
                   riseRateUnit + " " + String(riseRateWindowMin) + " min, smoothing " +
                   String(riseSmoothMin) + " min.");
  } else if (!hasScheme) {
    // First config fetch after boot with no previously latched scheme — log the
    // scheme the device is actively using (confirmation, once per boot).
    logErrorToFirestore("RATE_SCHEME",
        "Rate computation active — rain " + rainRateUnit + " " +
        String(rainRateWindowMin) + " min, rise " + riseRateUnit + " " +
        String(riseRateWindowMin) + " min, smoothing " + String(riseSmoothMin) + " min.");
  }

  lastRainRateUnit = rainRateUnit;
  lastRainRateWindowMin = rainRateWindowMin;
  lastRiseRateUnit = riseRateUnit;
  lastRiseRateWindowMin = riseRateWindowMin;
  lastRiseSmoothMin = riseSmoothMin;

  // Persist only when the stored scheme actually differs — fetchConfig polls every
  // few seconds and rewriting identical NVS entries would waste flash cycles.
  preferences.begin("weather", false);
  bool schemeDiffers =
      preferences.getString("lastRainRateUnit", "") != lastRainRateUnit ||
      preferences.getString("lastRiseRateUnit", "") != lastRiseRateUnit ||
      preferences.getInt("lastRainRateWindowMin", 0) != lastRainRateWindowMin ||
      preferences.getInt("lastRiseRateWindowMin", 0) != lastRiseRateWindowMin ||
      preferences.getInt("lastRiseSmoothMin", 0) != lastRiseSmoothMin;
  if (schemeDiffers) {
    preferences.putString("lastRainRateUnit", lastRainRateUnit);
    preferences.putString("lastRiseRateUnit", lastRiseRateUnit);
    preferences.putInt("lastRainRateWindowMin", lastRainRateWindowMin);
    preferences.putInt("lastRiseRateWindowMin", lastRiseRateWindowMin);
    preferences.putInt("lastRiseSmoothMin", lastRiseSmoothMin);
  }
  preferences.end();
}

// Queue cap: a long outage would otherwise fill the partition and break saves.
// Drop-oldest past the limit.
#define OFFLINE_QUEUE_MAX_BYTES      65536UL
#define OFFLINE_FLUSH_MAX_PER_CYCLE  10

bool saveOfflineReading(String payload) {
  if (LittleFS.exists("/offline_queue.jsonl")) {
    File f = LittleFS.open("/offline_queue.jsonl", "r");
    if (f && f.size() > OFFLINE_QUEUE_MAX_BYTES) {
      size_t skipTo = f.size() / 2;
      f.seek(skipTo);
      // Align to next record boundary; track whether one actually exists past the
      // midpoint so a torn/unterminated write can't silently wipe the whole queue.
      bool foundBoundary = false;
      while (f.available()) { if (f.read() == '\n') { foundBoundary = true; break; } }
      String tail = f.readString();
      f.close();
      if (!foundBoundary) {
        // No record boundary past the midpoint = single oversized/corrupt record.
        // Clear it explicitly rather than "keeping" an empty tail that looks normal.
        LittleFS.remove("/offline_queue.jsonl");
        Serial.println("[OFFLINE QUEUE] ⚠️ Cap reached but no record boundary found — cleared corrupt queue file.");
      } else {
        LittleFS.remove("/offline_queue.tmp");
        File tmp = LittleFS.open("/offline_queue.tmp", "w");
        if (tmp) {
          tmp.print(tail);
          tmp.close();
          LittleFS.remove("/offline_queue.jsonl");
          LittleFS.rename("/offline_queue.tmp", "/offline_queue.jsonl");
          Serial.println("[OFFLINE QUEUE] ⚠️ Size cap reached — dropped oldest half of queued records.");
        }
      }
    } else if (f) {
      f.close();
    }
  }

  File file = LittleFS.open("/offline_queue.jsonl", "a");
  if (file) {
    file.println(payload);
    file.close();
    Serial.println("[OFFLINE QUEUE] Saved payload to LittleFS Flash.");
    return true;
  }
  Serial.println("[OFFLINE QUEUE] ❌ Failed to open queue for append — payload NOT persisted.");
  return false;
}

void flushOfflineQueue() {
  if (!(WiFi.status() == WL_CONNECTED && wifiHasInternet) && !modem.isGprsConnected()) return;
  if (!LittleFS.exists("/offline_queue.jsonl")) return;

  File file = LittleFS.open("/offline_queue.jsonl", "r");
  if (!file) return;

  Serial.println("[OFFLINE QUEUE] Reconnected! Flushing cached readings to Firestore...");
  String path = "/v1/projects/" + firebaseProjectId + "/databases/(default)/documents/weather_history?key=" + firebaseApiKey;

  // Rewrite the queue with only records that actually uploaded (HTTP 2xx) — a mid-flush
  // disconnect must not permanently lose data. Uploads are capped per cycle.
  String remaining = "";
  int sent = 0;
  int kept = 0;
  int attempts = 0;

  while (file.available()) {
    feedWDT();
    String line = file.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;

    if (attempts >= OFFLINE_FLUSH_MAX_PER_CYCLE) {
      remaining += line;
      remaining += '\n';
      kept++;
      continue;
    }
    attempts++;

    String resp;
    int status = sendFirestoreRequest("POST", path, line, resp);
    if (status >= 200 && status < 300) {
      sent++;
    } else {
      // Log status + reason: a 403 (missing device claim / rules deny) and a 401
      // (token/header problem) need different fixes — surface it.
      Serial.printf("[OFFLINE QUEUE] ⚠️ record kept (HTTP %d): %.160s\n", status, resp.c_str());
      remaining += line;
      remaining += '\n';
      kept++;
    }
    delay(200);
  }
  file.close();

  // Atomic swap: write survivors to temp file, then replace the queue
  if (kept == 0) {
    LittleFS.remove("/offline_queue.jsonl");
  } else {
    LittleFS.remove("/offline_queue.tmp");
    File tmp = LittleFS.open("/offline_queue.tmp", "w");
    if (tmp) {
      tmp.print(remaining);
      tmp.close();
      LittleFS.remove("/offline_queue.jsonl");
      LittleFS.rename("/offline_queue.tmp", "/offline_queue.jsonl");
    } else {
      Serial.println("[OFFLINE QUEUE] ⚠️ Could not rewrite queue; keeping original file intact.");
    }
  }

  Serial.printf("[OFFLINE QUEUE] Uploaded %d offline records, %d kept for retry.\n", sent, kept);
}

void checkSimStatusIfNeeded() {
  time_t now; time(&now);
  if (now < 1600000000) return;

  struct tm timeinfo;
  localtime_r(&now, &timeinfo);

  if (timeinfo.tm_mday != lastSimCheckDay) {
    ensureConnection();
    checkSimStatus();
    lastSimCheckDay = timeinfo.tm_mday;
  }
}

// --- SMS storage housekeeping ---
// A full SIM inbox raises "+SMS FULL", silently blocking outgoing alert SMS.
static bool readModemOk(unsigned long timeoutMs) {
  String s = "";
  unsigned long t = millis();
  while (millis() - t < timeoutMs) {
    while (SerialAT.available()) {
      s += (char)SerialAT.read();
      if (s.indexOf("OK") != -1) return true;
    }
    feedWDT();
  }
  return false;
}

static void deleteSmsIndexes(const int *idx, int count) {
  for (int i = 0; i < count; i++) {
    SerialAT.printf("AT+CMGD=%d\r\n", idx[i]);
    readModemOk(1000);
    while (SerialAT.available()) SerialAT.read();
  }
}

static void purgeSmsStorage(bool all, const char *why) {
  Serial.printf("[SMS] 🧹 Purging %s SMS storage (%s)\n", all ? "ALL" : "READ", why);
  SerialAT.println("AT+CMGF=1");  // text mode — CMGDA ranges differ in PDU mode
  delay(100);
  while (SerialAT.available()) SerialAT.read();
  SerialAT.println(all ? "AT+CMGDA=\"DEL ALL\"" : "AT+CMGDA=\"DEL READ\"");
  readModemOk(2000);
  while (SerialAT.available()) SerialAT.read();
}

static String readModemResponse(unsigned long timeoutMs) {
  String s = "";
  unsigned long t = millis();
  while (millis() - t < timeoutMs) {
    while (SerialAT.available()) {
      s += (char)SerialAT.read();
      if (s.indexOf("OK") != -1 || s.indexOf("ERROR") != -1) return s;
    }
    feedWDT();
  }
  return s;
}

// Parses "<tag> <mode>,<stat>" for stat 1 (home) or 5 (roaming) — the states in
// which the modem can actually submit SMS on the voice/SMS domain.
static bool parseRegStat(const String &resp, const char *tag) {
  int p = resp.indexOf(tag);
  if (p == -1) return false;
  int comma = resp.indexOf(',', p);
  if (comma == -1) return false;
  int stat = resp.substring(comma + 1).toInt();
  return stat == 1 || stat == 5;
}

// CS-domain (voice/SMS) registration check — GPRS/PS attach alone is NOT sufficient:
// data can be perfect while SMS submits fail with CMS ERROR 331.
static bool isCsRegistered() {
  while (SerialAT.available()) SerialAT.read();
  SerialAT.println("AT+CREG?");
  String r = readModemResponse(1000);
  bool registered = parseRegStat(r, "+CREG:");
  while (SerialAT.available()) SerialAT.read();
  SerialAT.println("AT+CEREG?");
  r = readModemResponse(1000);
  registered = registered || parseRegStat(r, "+CEREG:");
  while (SerialAT.available()) SerialAT.read();
  return registered;
}

// Recovery ladder before SMS: fast path returns if already CS-registered; otherwise
// nudge operator re-selection, then restart the radio (cure for stuck registration).
static bool ensureSmsReady(unsigned long timeoutMs) {
  if (isCsRegistered()) return true;
  Serial.println("[SMS] ⚠️ CS (voice/SMS) registration missing — running recovery ladder...");
  unsigned long start = millis();

  // Step 1: operator re-selection (revives CS registration without a long data outage)
  Serial.println("[SMS] 🔁 AT+COPS=0 — re-selecting operator...");
  while (SerialAT.available()) SerialAT.read();
  SerialAT.println("AT+COPS=0");
  readModemResponse(5000);
  while (millis() - start < timeoutMs && !isCsRegistered()) { feedWDT(); pumpGps(); delay(500); }
  if (isCsRegistered()) {
    Serial.println("[SMS] ✅ CS registration restored (operator re-selection).");
    return true;
  }
  if (millis() - start >= timeoutMs) {
    Serial.println("[SMS] ❌ CS registration still missing after recovery — SMS will likely fail this round.");
    return false;
  }

  // Step 2: radio restart — drops data too; the next ensureConnection() re-attaches GPRS.
  Serial.println("[SMS] 🔁 Radio restart (AT+CFUN cycle) — recovering stuck registration...");
  while (SerialAT.available()) SerialAT.read();
  SerialAT.println("AT+CFUN=0");
  readModemResponse(3000);
  delay(1000);
  SerialAT.println("AT+CFUN=1");
  readModemResponse(3000);
  while (millis() - start < timeoutMs && !isCsRegistered()) { feedWDT(); pumpGps(); delay(500); }

  if (isCsRegistered()) {
    Serial.println("[SMS] ✅ CS registration restored (radio restart).");
    return true;
  }
  Serial.println("[SMS] ❌ CS registration still missing after recovery — SMS will likely fail this round.");
  return false;
}

// --- PH mobile number normalization ---
// Numbers come from self-service registration — treat as hostile. Normalize local
// formats to E.164 (+639XXXXXXXXX); return "" for anything that isn't a PH mobile.
static String normalizeSmsNumber(const String &raw) {
  String d;
  for (unsigned int i = 0; i < raw.length(); i++) {
    char c = raw[i];
    if (c >= '0' && c <= '9') d += c;  // ignore '+', spaces, dashes, parens
  }
  if (d.length() == 11 && d.startsWith("09")) d = d.substring(1);        // 09XXXXXXXXX
  else if (d.length() == 12 && d.startsWith("639")) d = d.substring(2);  // 639XXXXXXXXX
  if (d.length() == 10 && d.startsWith("9")) return "+63" + d;           // 9XXXXXXXXX
  return "";
}

void checkSimStatus() {
  Serial.println("Checking SIM Status via SMS (DATA BAL to 8080)...");

  // Same GSM TX-burst EMI risk as a dispatch — suppress rain-gauge counting
  // for the duration of the transmission.
  smsTxWindow = true;
  bool balSent = modem.sendSMS("8080", "DATA BAL");
  smsTxWindow = false;
  if (!balSent) {
    Serial.println("❌ Failed to send SMS request to 8080");
    logErrorToFirestore("SIM", "Failed to send DATA BAL request to 8080.");
    return;
  }
  Serial.println("✅ Request sent. Waiting 20s for reply...");

  for (int i = 0; i < 10; i++) {
    delay(2000);
    feedWDT();
  }

  SerialAT.println("AT+CMGL=\"REC UNREAD\"");
  String response = "";
  unsigned long timeout = millis() + 5000;
  while (millis() < timeout) {
    if (SerialAT.available()) response += SerialAT.readString();
    feedWDT();
  }

  // Collect all unread message indexes
  int unreadIdx[32];
  int unreadCount = 0;
  int scanPos = 0;
  while (unreadCount < 32) {
    int p = response.indexOf("+CMGL:", scanPos);
    if (p == -1) break;
    int comma = response.indexOf(',', p);
    if (comma == -1) break;
    int idx = response.substring(p + 7, comma).toInt();
    if (idx > 0) unreadIdx[unreadCount++] = idx;
    scanPos = p + 7;
  }

  // Simple approach: find the LATEST message from 8080
  // No keyword matching - just trust the sender number
  String cleanMsg = "";
  int balanceIndex = -1;
  for (int i = 0; i < unreadCount; i++) {
    feedWDT();
    SerialAT.printf("AT+CMGR=%d\r\n", unreadIdx[i]);
    delay(1000);
    String fullContent = SerialAT.readString();

    int cmgPos = fullContent.indexOf("+CMGR:");
    int headerEnd = (cmgPos != -1) ? fullContent.indexOf('\n', cmgPos) : -1;
    int footerStart = fullContent.lastIndexOf("OK");
    String body = "";
    if (headerEnd != -1 && footerStart > headerEnd) {
      body = fullContent.substring(headerEnd + 1, footerStart);
      body.trim();
      body.replace("\"", "");
    }

    // Check if sender is 8080 - if so, use this message (latest wins)
    if (cmgPos != -1 && headerEnd != -1 &&
        fullContent.substring(cmgPos, headerEnd).indexOf("8080") != -1) {
      cleanMsg = body;
      balanceIndex = unreadIdx[i];
    }
  }

  if (cleanMsg.length() > 0) {
    Serial.printf("[SIM] Balance reply from 8080 (index %d): %s\n", balanceIndex, cleanMsg.c_str());

    String path = "/v1/projects/" + firebaseProjectId + "/databases/(default)/documents/weather/sim?key=" + firebaseApiKey;
    JsonDocument doc;
    JsonObject fields = doc["fields"].to<JsonObject>();
    fields["status"]["stringValue"] = cleanMsg;
    fields["lastCheck"]["stringValue"] = getISOTime();

    String payload; serializeJson(doc, payload);
    String resp;
    sendFirestoreRequest("PATCH", path, payload, resp);

    Serial.println("SIM Status updated.");
  } else {
    logErrorToFirestore("SIM", unreadCount > 0
                        ? "No 8080 reply found among unread messages."
                        : "DATA BAL request sent. No reply found yet.");
  }

  // Housekeeping: clear all unread messages
  deleteSmsIndexes(unreadIdx, unreadCount);
}

void logErrorToFirestore(String type, String message) {
  String path = "/v1/projects/" + firebaseProjectId + "/databases/(default)/documents/logs?key=" + firebaseApiKey;
  JsonDocument doc;
  JsonObject fields = doc["fields"].to<JsonObject>();
  fields["type"]["stringValue"] = type;
  fields["message"]["stringValue"] = message;
  fields["timestamp"]["stringValue"] = getISOTime();

  String payload; serializeJson(doc, payload);
  String resp;
  sendFirestoreRequest("POST", path, payload, resp);
}

void resetManualTrigger() {
  // Reset the admin's manual SMS flag in the Firestore config document.
  String fsPath = "/v1/projects/" + firebaseProjectId + "/databases/(default)/documents/weather/config?updateMask.fieldPaths=manualSmsTrigger&key=" + firebaseApiKey;
  JsonDocument doc;
  JsonObject flds = doc["fields"].to<JsonObject>();
  flds["manualSmsTrigger"]["booleanValue"] = false;
  String payload; serializeJson(doc, payload);
  String resp;
  sendFirestoreRequest("PATCH", fsPath, payload, resp);
  Serial.println("Manual trigger reset to false (Firestore).");
}

void resetSensorTrigger() {
  // Consume the one-shot reset flag (mirrors resetManualTrigger). A failed PATCH
  // leaves it set → the next poll just re-runs an already-zero reset (idempotent).
  String fsPath = "/v1/projects/" + firebaseProjectId + "/databases/(default)/documents/weather/config?updateMask.fieldPaths=sensorResetTrigger&key=" + firebaseApiKey;
  JsonDocument doc;
  JsonObject flds = doc["fields"].to<JsonObject>();
  flds["sensorResetTrigger"]["booleanValue"] = false;
  String payload; serializeJson(doc, payload);
  String resp;
  sendFirestoreRequest("PATCH", fsPath, payload, resp);
  Serial.println("Sensor reset trigger reset to false (Firestore).");
}

// ==============================================================
//       LITTLEFS RECIPIENT PAGINATED SYNC & SMS DISPATCH
// ==============================================================

String urlEncode(const String &value) {
  String encoded = "";
  encoded.reserve(value.length() * 3);
  const char *hex = "0123456789ABCDEF";
  for (unsigned int i = 0; i < value.length(); i++) {
    char c = value[i];
    if (isalnum((unsigned char)c) || c == '-' || c == '_' || c == '.' || c == '~') {
      encoded += c;
    } else {
      encoded += '%';
      encoded += hex[(c >> 4) & 0xF];
      encoded += hex[c & 0xF];
    }
  }
  return encoded;
}

// Fetch all users via Firestore runQuery (POST): keeps the ~1000-char idToken out
// of the URL — the A7670 returns HTTP 713 if it rides in a GET.
#define USERS_QUERY_LIMIT 1000
static int fetchUsersRunQuery(String &responseBody, int limit = USERS_QUERY_LIMIT) {
  String path = "/v1/projects/" + firebaseProjectId + "/databases/(default)/documents:runQuery?key=" + firebaseApiKey;
  JsonDocument q;
  q["structuredQuery"]["from"][0]["collectionId"] = "users";
  q["structuredQuery"]["limit"] = limit;
  String body;
  serializeJson(q, body);
  return sendFirestoreRequest("POST", path, body, responseBody);
}

bool syncRecipientsFromFirebase() {
  Serial.println("\n[USERS SYNC] 🔄 Starting LittleFS recipient list synchronization from Firebase...");
  ensureConnection();

  // Create temporary file to ensure atomic update (safe against deletes & mid-sync crashes)
  File tempFile = LittleFS.open("/recipients.tmp", "w");
  if (!tempFile) {
    Serial.println("[USERS SYNC] ❌ Failed to open /recipients.tmp for writing.");
    return false;
  }

  int totalSynced = 0;
  bool syncSuccess = true;

  // Dedupe guard: duplicates in the cache would each get an SMS. Sized to the query
  // limit; the dispatch path dedupes again as defense-in-depth.
  static String seenNumbers[USERS_QUERY_LIMIT];
  static int seenCount = 0;
  seenCount = 0;
  auto alreadySeen = [&](const String &phone) -> bool {
    for (int i = 0; i < seenCount; i++) {
      if (seenNumbers[i] == phone) return true;
    }
    return false;
  };

  // fetchUsersRunQuery uses a POST (runQuery), so the device idToken rides in the
  // Authorization header and the URL stays short — this sync works over SIM-only too.
  String response;
  int statusCode = fetchUsersRunQuery(response, USERS_QUERY_LIMIT);
  if (statusCode == 200) {
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, response);
    if (err) {
      Serial.printf("[USERS SYNC] ❌ JSON Deserialization error: %s\n", err.c_str());
      syncSuccess = false;
    } else {
      // runQuery returns an ARRAY of result objects, each containing a "document" key.
      // Defensively also accept a wrapped {"documents":[...]} shape if ever returned.
      JsonArray results = JsonArray();
      if (doc.is<JsonArray>()) {
        results = doc.as<JsonArray>();
      } else if (doc.containsKey("documents") && doc["documents"].is<JsonArray>()) {
        results = doc["documents"].as<JsonArray>();
      }

      if (results.isNull()) {
        Serial.println("[USERS SYNC] ❌ runQuery returned unexpected JSON shape.");
        syncSuccess = false;
      } else {
        for (JsonObject result : results) {
          feedWDT();
          JsonObject userDoc = result["document"].is<JsonObject>() ? result["document"].as<JsonObject>() : result;
          if (!userDoc.containsKey("fields")) continue;
          JsonObject fields = userDoc["fields"];

          // Exclude disabled accounts
          if (fields.containsKey("disabled") && fields["disabled"]["booleanValue"].as<bool>() == true) {
            continue;
          }

          if (fields.containsKey("phoneNumber") && fields["phoneNumber"].containsKey("stringValue")) {
            String phone = normalizeSmsNumber(fields["phoneNumber"]["stringValue"].as<String>());
            if (phone.length() == 0) {
              Serial.println("[USERS SYNC] ⚠️ Skipping invalid PH mobile number — fix it in the users collection.");
            } else if (alreadySeen(phone)) {
              Serial.printf("[USERS SYNC] ⚠️ Duplicate number %s — skipped (another account already registered it).\n", phone.c_str());
            } else {
              if (seenCount < (int)(sizeof(seenNumbers) / sizeof(seenNumbers[0]))) {
                seenNumbers[seenCount++] = phone;
              } else {
                // Numbers beyond the cap can no longer be tracked here; the
                // dispatch-side dedupe still prevents double-texting them.
                Serial.println("[USERS SYNC] ⚠️ Dedupe list full — recipient written without tracking.");
              }
              tempFile.println(phone);
              totalSynced++;
            }
          }
        }

        // Visibility: runQuery silently truncates at the limit — if the result count
        // reaches the cap there may be more users than were synchronized.
        if ((int)results.size() >= USERS_QUERY_LIMIT) {
          Serial.printf("[USERS SYNC] ⚠️ Query result count reached the limit (%d) — there may be more users than were synced.\n", USERS_QUERY_LIMIT);
        }
      }
    }
  } else {
    Serial.printf("[USERS SYNC] ❌ Firestore runQuery failed (HTTP %d). Aborting sync.\n", statusCode);
    syncSuccess = false;
  }

  tempFile.close();

  if (syncSuccess) {
    if (LittleFS.exists("/recipients.txt")) {
      LittleFS.remove("/recipients.txt");
    }
    LittleFS.rename("/recipients.tmp", "/recipients.txt");

    preferences.begin("weather", false);
    preferences.putULong64("usersVer", lastSyncedUsersVersion);
    preferences.end();

    Serial.printf("[USERS SYNC] ✅ Successfully synchronized %d active recipients to LittleFS /recipients.txt!\n\n", totalSynced);
  } else {
    LittleFS.remove("/recipients.tmp");
    Serial.println("[USERS SYNC] ⚠️ Sync failed. Kept existing /recipients.txt intact.\n");
  }

  // Callers use the result to decide whether to retry (see fetchConfig's
  // usersVersion handling — a failed sync rolls the version back).
  return syncSuccess;
}

// Dispatch alert SMS to all recipients. TRUE = may ack (≥1 sent or no valid
// recipients); FALSE = caller retries after backoff. ackedLevel = highest level
// actually delivered — may rise mid-dispatch.
bool fetchUsersAndSendSMS(int &ackedLevel) {
  updateGPS();

  if (!modem.isNetworkConnected()) {
    Serial.println("Cellular disconnected! Attempting high-priority registration for SMS...");
    waitForNetworkCustom(15000L);
  }
  // SMS needs CS (voice-domain) registration, not just data — verify and recover
  // before burning send attempts (fast path returns immediately when registered).
  ensureSmsReady(45000L);

  // Drop already-read SMS before every blast so a full inbox can't block the outgoing
  // alerts (+SMS FULL). Unread messages are left for the daily balance sweep.
  purgeSmsStorage(false, "pre-dispatch");

  // Message selection: an admin per-level request forces that exact content and locks
  // it against live mid-dispatch escalation; otherwise use live threshold computation.
  bool manualLocked = (manualSmsLevelRequest != 0);
  int effectiveLevel;
  String msg;

  if (manualSmsLevelRequest >= 1 && manualSmsLevelRequest <= 3) {
    effectiveLevel = manualSmsLevelRequest;
    msg = alertMessageForLevel(effectiveLevel);
    Serial.printf("[SMS] 🔒 Admin-forced Level %d message — live escalation disabled for this dispatch.\n", effectiveLevel);
  } else {
    // Default to the mildest message so a manual test-trigger during calm weather
    // doesn't mass-text an evacuation warning. Re-evaluated against real thresholds.
    effectiveLevel = 1;
    msg = alertMessageL1;

    int entryLevel = computeAlertLevel(getRainToday_mm(), getRainRate_mmh(), waterRiseRateCMM, cachedWaterLevel);
    if (entryLevel > effectiveLevel) {
      effectiveLevel = entryLevel;
      msg = alertMessageForLevel(effectiveLevel);
    }
  }
  ackedLevel = manualLocked ? 0 : effectiveLevel; // manual dispatches never touch the alert state machine
  time_t issuedUtc = time(nullptr); // same Issued moment on every SMS
  logErrorToFirestore("DISPATCH", "SMS dispatch triggered — Level " + String(effectiveLevel) +
                                  (manualLocked ? " (admin manual test)" : ""));

  int totalSent = 0;
  int totalValid = 0;
  int processedRecipients = 0; // telemetry gate: live-doc upload only every 10 processed recipients

  // Dispatch-side dedupe: 64-bit FNV-1a hashes (4096 slots, no heap). The old 8 KB
  // string buffer capped at ~615 numbers — past USERS_QUERY_LIMIT duplicates could
  // double-text; hash collisions (~1 in 2×10¹⁰) are far below any real risk.
  static uint64_t seenDispatchHashes[4096];
  static int seenDispatchCount = 0;
  seenDispatchCount = 0; // fresh scope per dispatch run

  auto dispatchHash = [](const String &phone) -> uint64_t {
    uint64_t h = 1469598103934665603ULL;  // FNV-1a 64-bit offset basis
    for (unsigned int i = 0; i < phone.length(); i++) {
      h ^= (uint8_t)phone[i];
      h *= 1099511628211ULL;              // FNV-1a 64-bit prime
    }
    return h;
  };
  auto dispatchAlreadySeen = [&](const String &phone) -> bool {
    uint64_t h = dispatchHash(phone);
    for (int i = 0; i < seenDispatchCount; i++) {
      if (seenDispatchHashes[i] == h) return true;
    }
    return false;
  };
  auto rememberDispatchNumber = [&](const String &phone) -> bool {
    if (seenDispatchCount >= (int)(sizeof(seenDispatchHashes) / sizeof(seenDispatchHashes[0]))) return false;
    seenDispatchHashes[seenDispatchCount++] = dispatchHash(phone);
    return true;
  };

  // Mid-dispatch re-eval: conditions may spike mid-blast — upgrade the message for
  // remaining recipients at ANY level jump (L1→L2 included), never downgrade.
  auto refreshEscalation = [&]() {
    if (manualLocked) return; // admin-forced content — no live upgrades mid-blast
    int curLevel = computeAlertLevel(getRainToday_mm(), getRainRate_mmh(), waterRiseRateCMM, cachedWaterLevel);
    if (curLevel > effectiveLevel) {
      effectiveLevel = curLevel;
      ackedLevel = curLevel;
      msg = alertMessageForLevel(curLevel);
      Serial.printf("[SMS] ⚡ Level %d escalation detected mid-dispatch! Updating message for remaining recipients...\n", curLevel);
    }
  };

  // --- 1. Preferred Fast Dispatch from Local LittleFS Cache (Zero Cloud Dependency) ---
  if (LittleFS.exists("/recipients.txt")) {
    File file = LittleFS.open("/recipients.txt", "r");
    if (file && file.size() > 0) {
      Serial.println("[SMS DISPATCH] 📂 Streaming recipients directly from LittleFS Flash (Zero Cloud Delay)...");
      int recipientIndex = 0;

      while (file.available()) {
        feedWDT();
        pumpGps();
        String phone = file.readStringUntil('\n');
        phone.trim();
        String normalized = normalizeSmsNumber(phone);
        if (normalized.length() == 0) {
          Serial.printf("[SMS DISPATCH] ⛔ Invalid PH mobile number '%s' — skipping (fix it in the users collection).\n", phone.c_str());
          continue;
        }
        phone = normalized;

        // Skip numbers already messaged in this dispatch (see dedupe note above).
        if (dispatchAlreadySeen(phone)) {
          Serial.printf("[SMS DISPATCH] ⏭️ Duplicate recipient %s — skipping (already messaged this dispatch).\n", phone.c_str());
          continue;
        }
        if (!rememberDispatchNumber(phone)) {
          Serial.println("[SMS DISPATCH] ⚠️ Dedupe buffer full — further duplicates may not be caught this dispatch.");
        }

        recipientIndex++;
        totalValid++;

        refreshEscalation();

        bool sentSuccess = false;
        for (int attempt = 1; attempt <= 2; attempt++) {
          feedWDT();
          pumpGps();
          if (!modem.isNetworkConnected()) {
            Serial.printf("Network dropped before SMS to %s. Re-registering cellular...\n", phone.c_str());
            waitForNetworkCustom(10000L);
          }

          while (SerialAT.available()) SerialAT.read();

          Serial.printf("[SMS #%d] Attempt %d sending to %s...\n", recipientIndex, attempt, phone.c_str());
          if (modem.sendSMS(phone, withSmsTimestamp(msg, issuedUtc))) {
            sentSuccess = true;
            totalSent++;
            Serial.printf("[SMS #%d] ✅ Sent to %s (SUCCESS)\n", recipientIndex, phone.c_str());
            break;
          } else {
            Serial.printf("[SMS #%d] ❌ Attempt %d failed for %s\n", recipientIndex, attempt, phone.c_str());
            while (SerialAT.available()) SerialAT.read();
            // A failed send with a full inbox (+SMS FULL) needs slots freed to retry —
            // purge everything; alert delivery outranks stored carrier messages.
            purgeSmsStorage(true, "send failed — freeing possible full inbox");
            // Retry only makes sense if the voice/SMS domain is reachable again.
            ensureSmsReady(20000L);
            pumpGps();
            feedWDT();
          }
        }

        if (sentSuccess) {
          // Flush after every message: keeps the inbox at zero through long dispatches
          // so no later recipient hits a full-storage failure mid-blast.
          purgeSmsStorage(false, "post-send");
        } else {
          logErrorToFirestore("SMS", "Failed to send SMS to " + phone + " after 2 attempts.");
        }

        processedRecipients++;
        // 6s carrier rate-limit delay between numbers
        if (file.available()) {
          Serial.printf("[SMS #%d] Cooldown: Waiting 6s before next recipient...\n", recipientIndex);
          if (processedRecipients % 10 == 0) maybeMidDispatchUpload();
          for (int c = 0; c < 6; c++) {
            delay(1000);
            pumpGps();
            feedWDT();
          }
        }
      }

      file.close();
      Serial.printf("[SMS DISPATCH] ✅ LittleFS Bulk SMS Complete: Sent %d/%d messages.\n", totalSent, totalValid);
      logErrorToFirestore("DISPATCH", "Bulk SMS complete: sent " + String(totalSent) + " of " + String(totalValid) + " messages (Level " + String(effectiveLevel) + ").");
      return (totalSent > 0 || totalValid == 0);
    }
    if (file) file.close();
  }

  // --- 2. Fallback: Live Firestore Fetch via runQuery (if local file missing/empty) ---
  Serial.println("[SMS DISPATCH] ⚠️ Local recipient cache empty or missing. Falling back to live Firestore query...");

  bool fetchOk = true;

  // runQuery POST carries the device idToken in the Authorization header (URL stays
  // short), so this fallback also works when only SIM internet is available.
  String response;
  int statusCode = fetchUsersRunQuery(response, USERS_QUERY_LIMIT);
  if (statusCode != 200) {
    Serial.printf("[SMS DISPATCH] ❌ Firestore runQuery failed (HTTP %d).\n", statusCode);
    fetchOk = false;
  } else {
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, response);
    if (err) {
      Serial.println("[SMS DISPATCH] ❌ JSON deserialization error on runQuery result.");
      fetchOk = false;
    } else {
      JsonArray results = JsonArray();
      if (doc.is<JsonArray>()) {
        results = doc.as<JsonArray>();
      } else if (doc.containsKey("documents") && doc["documents"].is<JsonArray>()) {
        results = doc["documents"].as<JsonArray>();
      }

      if (results.isNull()) {
        Serial.println("[SMS DISPATCH] ❌ runQuery returned unexpected JSON shape.");
        fetchOk = false;
      } else {
        for (JsonObject result : results) {
          feedWDT();
          JsonObject userDoc = result["document"].is<JsonObject>() ? result["document"].as<JsonObject>() : result;
          if (!userDoc.containsKey("fields")) continue;
          JsonObject fields = userDoc["fields"];
          if (fields.containsKey("disabled") && fields["disabled"]["booleanValue"].as<bool>() == true) continue;
          if (!fields.containsKey("phoneNumber") || !fields["phoneNumber"].containsKey("stringValue")) continue;

          String phone = normalizeSmsNumber(fields["phoneNumber"]["stringValue"].as<String>());
          if (phone.length() == 0) {
            Serial.println("[SMS DISPATCH] ⛔ Invalid PH mobile number in users collection — skipping.");
            continue;
          }

          // Skip numbers already messaged in this dispatch (see dedupe note above).
          if (dispatchAlreadySeen(phone)) {
            Serial.printf("[SMS DISPATCH] ⏭️ Duplicate recipient %s — skipping (already messaged this dispatch).\n", phone.c_str());
            continue;
          }
          if (!rememberDispatchNumber(phone)) {
            Serial.println("[SMS DISPATCH] ⚠️ Dedupe buffer full — further duplicates may not be caught this dispatch.");
          }

          totalValid++;

          refreshEscalation();

          bool sentSuccess = false;
          for (int attempt = 1; attempt <= 2; attempt++) {
            feedWDT();
            pumpGps();
            if (!modem.isNetworkConnected()) {
              waitForNetworkCustom(10000L);
            }
            while (SerialAT.available()) SerialAT.read();

            Serial.printf("[FALLBACK SMS %d] Attempt %d sending to %s...\n", totalValid, attempt, phone.c_str());
            if (modem.sendSMS(phone, withSmsTimestamp(msg, issuedUtc))) {
              sentSuccess = true;
              totalSent++;
              Serial.printf("[FALLBACK SMS %d] ✅ Sent to %s (SUCCESS)\n", totalValid, phone.c_str());
              break;
            } else {
              while (SerialAT.available()) SerialAT.read();
              purgeSmsStorage(true, "send failed — freeing possible full inbox");
              ensureSmsReady(20000L);
              pumpGps();
              feedWDT();
            }
          }

          if (sentSuccess) {
            // Same per-message flush as the primary path.
            purgeSmsStorage(false, "post-send");
          } else {
            logErrorToFirestore("SMS", "Failed to send SMS to " + phone + " after 2 attempts.");
          }

          processedRecipients++;
          // 6s carrier rate-limit pacing between numbers
          if (processedRecipients % 10 == 0) maybeMidDispatchUpload();
          for (int c = 0; c < 6; c++) { delay(1000); pumpGps(); feedWDT(); }
        }
      }
    }
  }

  if (totalValid == 0 && !fetchOk) {
    Serial.println("[SMS DISPATCH] ⚠️ No recipients reachable and cloud fetch failed.");
    return false; // Nothing confirmed delivered or skipped — let the caller retry
  }
  Serial.printf("[SMS DISPATCH] ✅ Fallback Bulk SMS Complete: Sent %d/%d messages.\n", totalSent, totalValid);
  logErrorToFirestore("DISPATCH", "Fallback bulk SMS complete: sent " + String(totalSent) + " of " + String(totalValid) + " messages (Level " + String(effectiveLevel) + ").");
  return (totalSent > 0 || totalValid == 0);
}

// ==============================================================
//              TIME UTILITIES
// ==============================================================

// Days-from-civil epoch conversion. NEVER use mktime(): setup() sets TZ=PHT-8, so
// mktime applies the offset itself and would shift the clock 8 h behind UTC.
static time_t tmToEpochUtc(int year, int month, int day, int hour, int min, int sec) {
  year -= (month <= 2);
  const int era = (year >= 0 ? year : year - 399) / 400;
  const unsigned yoe = (unsigned)(year - era * 400);
  const unsigned doy = (153u * (unsigned)(month + (month > 2 ? -3 : 9)) + 2u) / 5u + (unsigned)day - 1u;
  const unsigned doe = yoe * 365u + yoe / 4u - yoe / 100u + doy;
  long long days = (long long)era * 146097LL + (long long)doe - 719468LL;
  return (time_t)(days * 86400LL + (long long)hour * 3600LL + (long long)min * 60LL + (long long)sec);
}

void syncTime() {
  Serial.println("Syncing time from network...");
  int year, month, day, hour, min, sec;
  float timezone;
  if (modem.getNetworkTime(&year, &month, &day, &hour, &min, &sec, &timezone)) {
    // +CCLK returns NETWORK-LOCAL wall time; convert to UTC by subtracting the
    // quarter-hour offset reported by the carrier.
    time_t t = tmToEpochUtc(year, month, day, hour, min, sec);
    t -= (time_t)(timezone * 15 * 60);
    struct timeval now = {.tv_sec = t, .tv_usec = 0};
    settimeofday(&now, NULL);
    Serial.printf("Time synced from network! UTC epoch: %ld\n", (long)t);
    checkDailyRainReset();
  } else {
    Serial.println("Network time failed, trying GPS...");
    unsigned long start = millis();
    while (millis() - start < 2000) {
      while (SerialGPS.available()) gps.encode(SerialGPS.read());
      feedWDT();
      delay(5);
    }
    if (gps.date.isValid() && gps.time.isValid()) {
      // GPS sentences are already UTC — no offset applied.
      time_t t = tmToEpochUtc(gps.date.year(), gps.date.month(), gps.date.day(),
                              gps.time.hour(), gps.time.minute(), gps.time.second());
      struct timeval now = {.tv_sec = t, .tv_usec = 0};
      settimeofday(&now, NULL);
      Serial.printf("Time synced from GPS! UTC epoch: %ld\n", (long)t);
      checkDailyRainReset();
    } else {
      Serial.println("GPS time also unavailable.");
    }
  }
}

String getISOTime() {
  time_t now; time(&now);
  struct tm timeinfo;
  gmtime_r(&now, &timeinfo);
  char buffer[25];
  strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &timeinfo);
  return String(buffer);
}

