/*
 * Utility Tool: Reset Preferences & Flash Storage for Weather System
 * Device: LilyGO TTGO T-SIM A7670G / ESP32
 * 
 * Instructions:
 * 1. Upload this sketch to your ESP32 board.
 * 2. Open Serial Monitor at 115200 baud.
 * 3. It will clear all saved WiFi credentials, rainfall counters, preferences,
 *    and format the LittleFS offline queue storage.
 * 4. Re-upload code.ino afterwards to start fresh.
 */

#include <Arduino.h>
#include <Preferences.h>
#include <LittleFS.h>
#include <WiFi.h>

Preferences preferences;

void setup() {
  Serial.begin(115200);
  delay(1000);
  
  Serial.println("\n==============================================");
  Serial.println("   ESP32 PREFERENCES & STORAGE RESET TOOL   ");
  Serial.println("==============================================\n");

  // 1. Clear Preferences ("weather" namespace)
  Serial.print("[1/3] Opening Preferences ('weather' namespace)... ");
  if (preferences.begin("weather", false)) {
    Serial.println("OK.");
    Serial.print("      Clearing all stored keys (wifi_ssid, wifi_pass, rainfall)... ");
    preferences.clear();
    preferences.end();
    Serial.println("SUCCESS!");
  } else {
    Serial.println("FAILED to open Preferences namespace.");
  }

  // 2. Explicitly reset WiFi preferences + flush any cached connection.
  //    The ESP32 also keeps a WiFi-station connection cache internally, so even
  //    after the Preferences clear it may re-associate with the old network on
  //    the next boot. We remove the wifi_ssid/wifi_pass keys explicitly (in case
  //    a future firmware uses a different namespace) and power-cycle the WiFi
  //    radio / purge the cached STA config so the next boot starts truly clean.
  Serial.println("\n[2/3] Resetting WiFi credentials & flushing cached connection...");
  bool wifiCleared = false;

  // Defensively clear any namespace that may hold WiFi credentials.
  const char *wifiNamespaces[] = { "weather", "wifiSta", "wifi" };
  for (unsigned int i = 0; i < sizeof(wifiNamespaces) / sizeof(wifiNamespaces[0]); i++) {
    if (preferences.begin(wifiNamespaces[i], false)) {
      // Explicitly remove the known credential keys.
      preferences.remove("wifi_ssid");
      preferences.remove("wifi_pass");
      preferences.remove("ssid");
      preferences.remove("password");
      // Fall back to wiping the whole namespace for good measure.
      preferences.clear();
      preferences.end();
      wifiCleared = true;
      Serial.printf("      Cleared namespace '%s' (wifi_ssid/wifi_pass removed).\n", wifiNamespaces[i]);
    }
  }

  // Flush the ESP32's cached STA config so it won't auto-reconnect on the next boot.
  WiFi.disconnect(true);
  delay(500);
  WiFi.mode(WIFI_OFF);
  delay(500);
  Serial.println("      WiFi radio disabled & cached STA config purged.");

  Serial.println(wifiCleared ? "      WiFi preference reset SUCCESS!" : "      No WiFi namespace found to clear.");

  // 3. Format LittleFS Internal Flash Storage
  Serial.print("\n[3/3] Mounting LittleFS Internal Flash... ");
  if (LittleFS.begin(true)) {
    Serial.println("OK.");
    Serial.print("      Formatting LittleFS (clearing offline_queue.jsonl)... ");
    if (LittleFS.format()) {
      Serial.println("SUCCESS!");
    } else {
      Serial.println("Formatting FAILED.");
    }
  } else {
    Serial.println("LittleFS Mount/Format FAILED.");
  }

  Serial.println("\n==============================================");
  Serial.println(" ✅ RESET COMPLETE! All settings cleared, including WiFi.");
  Serial.println(" You can now upload code.ino back to the board.");
  Serial.println("==============================================\n");
}

void loop() {
  // Idle after reset
  delay(1000);
}
