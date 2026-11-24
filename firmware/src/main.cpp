/*
 * ESP32-DevKitC (WROOM-32D) — MQTT relay controller
 *
 *  - 1..15 relays on user-selected GPIOs (only boot/flash-safe pins accepted), state persisted in NVS
 *  - On-board schedules (time + weekdays -> ON/OFF), local time from NTP + POSIX timezone
 *  - MQTT: status (LWT), info, relay/<n>/set|state, schedule[/set], telemetry, cmd
 *  - USB provisioning: newline-delimited JSON on UART0 @115200 (see docs/DESIGN.md §3.2)
 *  - Up to 5 saved Wi-Fi networks; joins the strongest known one
 *  - Phone setup (captive portal): own Wi-Fi "PlugPilot-xxxxxx" opens when no saved network is
 *    reachable for 60 s, when nothing is saved yet, or on a short press of BOOT
 *  - Optional SHT3x (SHT30/31/35) temperature & humidity sensor on I2C: SDA GPIO21, SCL GPIO22,
 *    auto-detected at 0x44/0x45, published every 15 s on <base>/<id>/sensor (retained)
 *  - Hold BOOT (GPIO0) for 5 s => factory reset
 *  - Task watchdog 15 s
 *  - MQTT over TLS (port 8883) for cloud brokers, CA roots in ca_bundle.h
 */
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <esp_task_wdt.h>
#include <esp_system.h>
#include <time.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Wire.h>
#include "ca_bundle.h"
#include "portal_html.h"

#ifndef FW_VERSION
#define FW_VERSION "1.0.0-local"
#endif

// ---------- Hardware ----------
// GPIOs that are safe to drive a relay on ESP32-WROOM-32(D): excludes strapping pins (0,2,5,12,15),
// SPI flash (6-11), UART0 used for USB provisioning (1,3) and input-only pins (34-39).
static const uint8_t SAFE_PINS[] = {4, 13, 14, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33};
static const uint8_t MAX_RELAYS = sizeof(SAFE_PINS);
static const uint8_t DEFAULT_PINS[] = {16, 17, 18, 19, 23, 25, 26, 27};
static const uint8_t BOOT_BTN_PIN = 0;          // on-board BOOT button, read only after boot
static const uint32_t FACTORY_RESET_HOLD_MS = 5000;
static const uint32_t TELEMETRY_INTERVAL_MS = 30000;
static const uint32_t WDT_TIMEOUT_S = 15;
static const time_t CLOCK_VALID_AFTER = 1700000000;   // 2023-11: anything earlier = NTP not synced yet
static const uint8_t MAX_NETS = 5;                    // saved Wi-Fi networks
static const uint32_t PORTAL_AFTER_MS = 60000;        // offline this long => open phone setup
static const uint32_t PORTAL_IDLE_MS = 180000;        // close phone setup after 3 min with no phone on it
static const uint32_t WIFI_TRY_MS = 12000;            // per network attempt
static const uint32_t PORTAL_TEST_MS = 20000;         // phone setup: test a new network this long
static const uint8_t SENSOR_SDA = 21, SENSOR_SCL = 22; // ESP32 default I2C pins
static const uint32_t SENSOR_INTERVAL_MS = 15000;
static const uint32_t SENSOR_PROBE_MS = 30000;         // look for a (re)connected sensor this often

// ---------- Config (NVS namespace "cfg") ----------
struct Config {
  String mqttHost, mqttUser, mqttPass;
  uint16_t mqttPort = 1883;
  bool mqttTls = false;       // MQTTS (cloud brokers such as HiveMQ Cloud / EMQX)
  String deviceId;
  String base = "home";
  String tz = "ICT-7";        // POSIX TZ string; Thailand = UTC+7
  uint8_t relayCount = sizeof(DEFAULT_PINS);
  bool activeLow = true;      // most opto relay boards are active-LOW
  bool restoreState = true;   // restore relay states after power loss
} cfg;

uint8_t relayPins[MAX_RELAYS];

Preferences prefs;
WiFiClient netClient;
WiFiClientSecure tlsClient;
PubSubClient mqtt;

uint16_t relayMask = 0;       // bit n = relay n+1 ON
String topicPrefix;           // "<base>/<id>/"

// ---------- Schedules (NVS namespace "sched") ----------
struct Rule {
  uint8_t ch;        // 1-based relay channel
  uint16_t minute;   // minutes after local midnight
  bool on;           // ON or OFF
  uint8_t days;      // bit0 = Sunday ... bit6 = Saturday (tm_wday)
  bool en;
};
static const uint8_t MAX_RULES = 20;
Rule rules[MAX_RULES];
uint8_t ruleCount = 0;

// ---------- Helpers ----------
static String defaultDeviceId() {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);   // works before the Wi-Fi driver starts
  char buf[16];
  snprintf(buf, sizeof(buf), "esp32-%02x%02x%02x", mac[3], mac[4], mac[5]);
  return String(buf);
}

static bool isSafePin(int p) {
  for (uint8_t s : SAFE_PINS) if (s == p) return true;
  return false;
}

static bool clockValid() { return time(nullptr) > CLOCK_VALID_AFTER; }

static String localTimeStr() {
  if (!clockValid()) return "";
  time_t now = time(nullptr);
  struct tm lt;
  localtime_r(&now, &lt);
  char buf[24];
  strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &lt);
  return String(buf);
}

// Parses and validates a relay pin list. Returns the count, or -1 and sets *err.
static int parsePins(JsonVariantConst v, uint8_t* out, const char** err) {
  if (!v.is<JsonArrayConst>()) { *err = "relay_pins must be an array"; return -1; }
  JsonArrayConst arr = v.as<JsonArrayConst>();
  if (arr.size() < 1 || arr.size() > MAX_RELAYS) { *err = "relay_pins: choose 1-15 pins"; return -1; }
  int n = 0;
  for (JsonVariantConst x : arr) {
    if (!x.is<int>() || !isSafePin(x.as<int>())) { *err = "relay_pins: GPIO not allowed (strapping/flash/input-only)"; return -1; }
    for (int k = 0; k < n; k++)
      if (out[k] == x.as<int>()) { *err = "relay_pins: duplicate GPIO"; return -1; }
    out[n++] = (uint8_t)x.as<int>();
  }
  return n;
}

static void loadConfig() {
  prefs.begin("cfg", true);
  cfg.mqttHost = prefs.getString("mqtt_host", "");
  cfg.mqttPort = prefs.getUShort("mqtt_port", 1883);
  cfg.mqttTls = prefs.getBool("mqtt_tls", cfg.mqttPort == 8883);
  cfg.mqttUser = prefs.getString("mqtt_user", "");
  cfg.mqttPass = prefs.getString("mqtt_pass", "");
  cfg.deviceId = prefs.getString("device_id", "");
  cfg.base = prefs.getString("base", "home");
  cfg.tz = prefs.getString("tz", "ICT-7");
  cfg.activeLow = prefs.getBool("active_low", true);
  cfg.restoreState = prefs.getBool("restore", true);

  // Relay pins: user selection ("pins" blob, firmware >= 1.0.6) or the default map.
  bool havePins = false;
  if (prefs.isKey("pins")) {
    size_t n = prefs.getBytesLength("pins");
    if (n >= 1 && n <= MAX_RELAYS && prefs.getBytes("pins", relayPins, n) == n) {
      havePins = true;
      for (size_t k = 0; k < n; k++) if (!isSafePin(relayPins[k])) havePins = false;
      if (havePins) cfg.relayCount = n;
    }
  }
  if (!havePins) {
    uint8_t cnt = constrain(prefs.getUChar("relay_cnt", sizeof(DEFAULT_PINS)), 1, (int)sizeof(DEFAULT_PINS));
    memcpy(relayPins, DEFAULT_PINS, cnt);
    cfg.relayCount = cnt;
  }
  prefs.end();

  if (cfg.deviceId.isEmpty()) cfg.deviceId = defaultDeviceId();
  topicPrefix = cfg.base + "/" + cfg.deviceId + "/";
  setenv("TZ", cfg.tz.c_str(), 1);
  tzset();
}

static void factoryReset() {
  Serial.println("# factory reset: clearing NVS");
  for (const char* ns : {"cfg", "relay", "sched", "wifi"}) { prefs.begin(ns, false); prefs.clear(); prefs.end(); }
  delay(200);
  ESP.restart();
}

// ---------- Relays ----------
static inline bool relayOn(uint8_t idx) { return relayMask & (1u << idx); }

static void writeRelayPin(uint8_t idx) {
  digitalWrite(relayPins[idx], (relayOn(idx) ^ cfg.activeLow) ? HIGH : LOW);
}

static void publishRelayState(uint8_t idx) {
  if (!mqtt.connected()) return;
  String t = topicPrefix + "relay/" + String(idx + 1) + "/state";
  const char* v = relayOn(idx) ? "ON" : "OFF";
  mqtt.publish(t.c_str(), v, true);
  Serial.printf("# mqtt tx %s = %s\n", t.c_str(), v);
}

static void saveRelayMask() {
  prefs.begin("relay", false);
  if (prefs.getUShort("mask16", 0xFFFF) != relayMask) prefs.putUShort("mask16", relayMask);  // avoid needless flash writes
  prefs.end();
}

// cmd: "ON" | "OFF" | "TOGGLE" (case-insensitive). Returns false on bad input.
// source: who asked ("mqtt", "usb", "cmd", "schedule") — only used for the serial log.
static bool setRelay(uint8_t idx, String cmd, const char* source = "mqtt") {
  if (idx >= cfg.relayCount) return false;
  cmd.toUpperCase();
  bool target;
  if (cmd == "ON" || cmd == "1" || cmd == "TRUE") target = true;
  else if (cmd == "OFF" || cmd == "0" || cmd == "FALSE") target = false;
  else if (cmd == "TOGGLE") target = !relayOn(idx);
  else return false;

  if (target) relayMask |= (1u << idx);
  else relayMask &= ~(1u << idx);
  writeRelayPin(idx);
  saveRelayMask();
  // e.g. "# relay CH3 GPIO18 -> ON (pin LOW, active-low) [mqtt]"
  Serial.printf("# relay CH%u GPIO%u -> %s (pin %s, active-%s) [%s]\n", idx + 1, relayPins[idx],
                target ? "ON" : "OFF", digitalRead(relayPins[idx]) ? "HIGH" : "LOW",
                cfg.activeLow ? "low" : "high", source);
  publishRelayState(idx);   // always echo, even if unchanged (confirms command to UI)
  return true;
}

static void initRelays() {
  relayMask = 0;
  if (cfg.restoreState) {
    prefs.begin("relay", true);
    if (prefs.isKey("mask16")) relayMask = prefs.getUShort("mask16", 0);
    else if (prefs.isKey("mask")) relayMask = prefs.getUChar("mask", 0);   // firmware <= 1.0.5
    prefs.end();
  }
  relayMask &= (1u << cfg.relayCount) - 1;
  for (uint8_t i = 0; i < cfg.relayCount; i++) {
    // set the level BEFORE switching to output to avoid a glitch on boot
    digitalWrite(relayPins[i], (relayOn(i) ^ cfg.activeLow) ? HIGH : LOW);
    pinMode(relayPins[i], OUTPUT);
  }
}

// ---------- Schedules ----------
static int parseHHMM(const char* s) {
  int h, m;
  if (!s || sscanf(s, "%d:%d", &h, &m) != 2 || h < 0 || h > 23 || m < 0 || m > 59) return -1;
  return h * 60 + m;
}

// strict: reject the whole list on the first bad rule (commands from users);
// lenient: skip bad rules (loading from NVS after the relay count changed).
static bool parseRules(JsonArrayConst arr, Rule* out, uint8_t& n, bool strict, const char** err) {
  n = 0;
  if (arr.size() > MAX_RULES) { *err = "max 20 rules"; if (strict) return false; }
  for (JsonObjectConst r : arr) {
    if (n >= MAX_RULES) break;
    int ch = r["ch"] | 0;
    int minute = parseHHMM(r["t"] | "");
    String act = r["a"] | "";
    act.toUpperCase();
    int days = r["d"] | 127;
    const char* e = nullptr;
    if (ch < 1 || ch > cfg.relayCount) e = "rule: ch out of range";
    else if (minute < 0) e = "rule: t must be HH:MM";
    else if (act != "ON" && act != "OFF") e = "rule: a must be ON or OFF";
    else if (days < 1 || days > 127) e = "rule: d must be 1-127 (weekday bits)";
    if (e) {
      if (strict) { *err = e; return false; }
      continue;
    }
    out[n++] = {(uint8_t)ch, (uint16_t)minute, act == "ON", (uint8_t)days, r["en"] | true};
  }
  return true;
}

static void rulesToJson(JsonArray arr) {
  for (uint8_t i = 0; i < ruleCount; i++) {
    const Rule& r = rules[i];
    JsonObject o = arr.add<JsonObject>();
    char t[6];
    snprintf(t, sizeof(t), "%02u:%02u", r.minute / 60, r.minute % 60);
    o["ch"] = r.ch;
    o["t"] = t;
    o["a"] = r.on ? "ON" : "OFF";
    o["d"] = r.days;
    o["en"] = r.en;
  }
}

static void loadRules() {
  prefs.begin("sched", true);
  String s = prefs.isKey("rules") ? prefs.getString("rules", "[]") : String("[]");
  prefs.end();
  JsonDocument doc;
  const char* err = nullptr;
  if (deserializeJson(doc, s) || !parseRules(doc.as<JsonArrayConst>(), rules, ruleCount, false, &err)) ruleCount = 0;
}

static void saveRules() {
  JsonDocument doc;
  rulesToJson(doc.to<JsonArray>());
  String s;
  serializeJson(doc, s);
  prefs.begin("sched", false);
  prefs.putString("rules", s);
  prefs.end();
}

// Retained "<prefix>schedule": current rules + timezone + board clock. An error is sent
// non-retained so the stored copy keeps showing the rules that are actually active.
static void publishSchedule(const char* error = nullptr) {
  if (!mqtt.connected()) return;
  JsonDocument doc;
  doc["tz"] = cfg.tz;
  doc["time"] = localTimeStr();
  if (error) doc["error"] = error;
  rulesToJson(doc["rules"].to<JsonArray>());
  String out;
  serializeJson(doc, out);
  mqtt.publish((topicPrefix + "schedule").c_str(), out.c_str(), error == nullptr);
}

// Accepts [rule, ...] or {"rules":[...]}. Used by MQTT "schedule/set" and USB "set_schedule".
static bool applySchedule(JsonVariantConst v, const char** err) {
  JsonArrayConst arr = v.is<JsonArrayConst>() ? v.as<JsonArrayConst>() : v["rules"].as<JsonArrayConst>();
  if (arr.isNull()) { *err = "expected a JSON array of rules"; return false; }
  Rule tmp[MAX_RULES];
  uint8_t n = 0;
  if (!parseRules(arr, tmp, n, true, err)) return false;
  memcpy(rules, tmp, sizeof(Rule) * n);
  ruleCount = n;
  saveRules();
  Serial.printf("# schedule saved: %u rule(s), tz=%s, now=%s\n", ruleCount, cfg.tz.c_str(),
                clockValid() ? localTimeStr().c_str() : "(clock not synced)");
  publishSchedule();
  return true;
}

// Runs once per local minute; fires every enabled rule for this weekday + HH:MM.
static void scheduleTask() {
  static int lastMinute = -1;
  if (!clockValid() || ruleCount == 0) return;
  time_t now = time(nullptr);
  struct tm lt;
  localtime_r(&now, &lt);
  int minute = lt.tm_hour * 60 + lt.tm_min;
  if (minute == lastMinute) return;
  lastMinute = minute;
  for (uint8_t i = 0; i < ruleCount; i++) {
    const Rule& r = rules[i];
    if (!r.en || r.minute != minute || !(r.days & (1u << lt.tm_wday))) continue;
    Serial.printf("# schedule %02u:%02u CH%u -> %s\n", r.minute / 60, r.minute % 60, r.ch, r.on ? "ON" : "OFF");
    setRelay(r.ch - 1, r.on ? "ON" : "OFF", "schedule");
  }
}

// ---------- Saved Wi-Fi networks (NVS namespace "wifi": n, s0..s4, p0..p4) ----------
// nets[0] is the most recently added/used one. Passwords never leave the board.
struct Net { String ssid, pass; };
Net nets[MAX_NETS];
uint8_t netCount = 0;

static void saveNets() {
  prefs.begin("wifi", false);
  prefs.clear();
  prefs.putUChar("n", netCount);
  for (uint8_t i = 0; i < netCount; i++) {
    prefs.putString(("s" + String(i)).c_str(), nets[i].ssid);
    prefs.putString(("p" + String(i)).c_str(), nets[i].pass);
  }
  prefs.end();
}

static void loadNets() {
  prefs.begin("wifi", true);
  bool have = prefs.isKey("n");
  netCount = std::min<uint8_t>(prefs.getUChar("n", 0), MAX_NETS);
  for (uint8_t i = 0; i < netCount; i++) {
    nets[i].ssid = prefs.getString(("s" + String(i)).c_str(), "");
    nets[i].pass = prefs.getString(("p" + String(i)).c_str(), "");
  }
  prefs.end();
  if (have) return;
  // First boot after firmware <= 1.0.x: import its single network (keys left in place for downgrades).
  prefs.begin("cfg", true);
  String s = prefs.isKey("wifi_ssid") ? prefs.getString("wifi_ssid", "") : String();
  String p = prefs.isKey("wifi_pass") ? prefs.getString("wifi_pass", "") : String();
  prefs.end();
  if (s.length()) { nets[0] = {s, p}; netCount = 1; }
  saveNets();
}

static int findNet(const String& ssid) {
  for (uint8_t i = 0; i < netCount; i++) if (nets[i].ssid == ssid) return i;
  return -1;
}

// Adds or updates a network and moves it to the front. pass == nullptr keeps the saved password.
static void rememberNet(const String& ssid, const String* pass) {
  int found = findNet(ssid);
  String p = pass ? *pass : (found >= 0 ? nets[found].pass : String());
  int last = found >= 0 ? found : std::min<int>(netCount, MAX_NETS - 1);
  if (found < 0 && netCount < MAX_NETS) netCount++;
  for (int k = last; k > 0; k--) nets[k] = nets[k - 1];   // oldest drops off when full
  nets[0] = {ssid, p};
  saveNets();
  Serial.printf("# wifi saved '%s' (%u network(s))\n", ssid.c_str(), netCount);
}

static bool forgetNet(const String& ssid) {
  int found = findNet(ssid);
  if (found < 0) return false;
  for (int k = found; k < netCount - 1; k++) nets[k] = nets[k + 1];
  nets[--netCount] = Net();
  saveNets();
  Serial.printf("# wifi forgot '%s' (%u network(s) left)\n", ssid.c_str(), netCount);
  return true;
}

// ---------- Wi-Fi connection manager (non-blocking) ----------
// Idle -> Scanning -> Trying (each known network, strongest first) -> Up
//                          \-> Waiting (backoff) -> Scanning ... -> Portal after 60 s offline
enum class WS : uint8_t { Idle, Scanning, Trying, Waiting, Up, Portal };
WS ws = WS::Idle;
uint8_t cand[MAX_NETS], candCount = 0, candIdx = 0;
uint32_t wsDeadline = 0, wifiBackoff = 5000, offlineSince = 0;
String trySsid;
int16_t firstReason = 0;          // last failure of nets[0] (the one just configured): reason code, -1 = timeout
volatile uint8_t discReason = 0;  // last STA disconnect reason from the Wi-Fi driver
volatile bool discFlag = false;

// Last scan, de-duplicated and sorted by signal; shared by the connection manager, USB "scan" and phone setup.
struct Seen { String ssid; int8_t rssi; bool lock; };
static const uint8_t MAX_SEEN = 20;
Seen seen[MAX_SEEN];
uint8_t seenCount = 0;
uint32_t seenAt = 0;

static const char* reasonStr(int r) {
  switch (r) {
    case 0: return "";
    case WIFI_REASON_NO_AP_FOUND: return "ssid_not_found";
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_802_1X_AUTH_FAILED: return "auth_failed";
    default: return "connect_failed";
  }
}

static void cacheScan(int n) {
  seenCount = 0;
  for (int k = 0; k < n; k++) {
    String s = WiFi.SSID(k);
    if (s.isEmpty()) continue;
    int8_t r = WiFi.RSSI(k);
    int f = -1;
    for (uint8_t j = 0; j < seenCount; j++) if (seen[j].ssid == s) f = j;
    if (f >= 0) { if (r > seen[f].rssi) seen[f].rssi = r; continue; }
    if (seenCount < MAX_SEEN) seen[seenCount++] = {s, r, WiFi.encryptionType(k) != WIFI_AUTH_OPEN};
  }
  for (uint8_t i = 1; i < seenCount; i++)   // insertion sort, strongest first
    for (uint8_t j = i; j > 0 && seen[j].rssi > seen[j - 1].rssi; j--) std::swap(seen[j], seen[j - 1]);
  WiFi.scanDelete();
  seenAt = millis();
}

static int seenRssi(const String& ssid) {
  for (uint8_t j = 0; j < seenCount; j++) if (seen[j].ssid == ssid) return seen[j].rssi;
  return -1000;
}

// Known networks in range strongest first, then the rest (hidden SSIDs never show up in a scan).
static void buildCandidates() {
  candCount = candIdx = 0;
  for (uint8_t i = 0; i < netCount; i++) if (seenRssi(nets[i].ssid) > -1000) cand[candCount++] = i;
  for (uint8_t i = 1; i < candCount; i++)
    for (uint8_t j = i; j > 0 && seenRssi(nets[cand[j]].ssid) > seenRssi(nets[cand[j - 1]].ssid); j--) std::swap(cand[j], cand[j - 1]);
  for (uint8_t i = 0; i < netCount; i++) if (seenRssi(nets[i].ssid) == -1000) cand[candCount++] = i;
}

String apSsid, apPass;
static void startPortal(bool keepSta);

static void tryNext() {
  if (candIdx >= candCount) {
    Serial.printf("# wifi: no saved network reachable, retry in %lus", (unsigned long)wifiBackoff / 1000);
    if (millis() - offlineSince < PORTAL_AFTER_MS) Serial.printf(" (phone setup Wi-Fi '%s' opens after 60 s offline)", apSsid.c_str());
    Serial.println();
    ws = WS::Waiting;
    wsDeadline = millis() + wifiBackoff;
    wifiBackoff = std::min<uint32_t>(wifiBackoff * 2, 60000);
    return;
  }
  const Net& n = nets[cand[candIdx++]];
  trySsid = n.ssid;
  Serial.printf("# wifi connecting to '%s' (%d dBm) ...\n", n.ssid.c_str(), seenRssi(n.ssid) > -1000 ? seenRssi(n.ssid) : 0);
  discFlag = false;
  WiFi.begin(n.ssid.c_str(), n.pass.c_str());
  ws = WS::Trying;
  wsDeadline = millis() + WIFI_TRY_MS;
}

static void wifiStartScan() {
  WiFi.disconnect();
  if (seenAt && millis() - seenAt < 5000) { buildCandidates(); tryNext(); return; }   // fresh enough
  WiFi.scanDelete();
  if (WiFi.scanNetworks(true) == WIFI_SCAN_FAILED) { buildCandidates(); tryNext(); return; }
  ws = WS::Scanning;
  wsDeadline = millis() + 15000;
}

static void enterUp() {
  ws = WS::Up;
  wifiBackoff = 5000;
  if (netCount && WiFi.SSID() == nets[0].ssid) firstReason = 0;
  Serial.printf("# wifi connected to '%s', ip=%s rssi=%d\n", WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI());
  // NTP: needed for TLS certificate checks and for schedules (local time via cfg.tz)
  configTzTime(cfg.tz.c_str(), "pool.ntp.org", "time.google.com");
}

static void portalTask();

static void wifiTask() {
  if (ws == WS::Portal) { portalTask(); return; }
  bool up = WiFi.status() == WL_CONNECTED;
  switch (ws) {
    case WS::Idle:
      offlineSince = millis();
      if (netCount == 0) {
        Serial.println("# no Wi-Fi saved yet: use the web app over USB, or phone setup");
        startPortal(false);
      } else {
        wifiStartScan();
      }
      break;
    case WS::Scanning: {
      int n = WiFi.scanComplete();
      if (n == WIFI_SCAN_RUNNING && millis() < wsDeadline) break;
      if (n >= 0) cacheScan(n); else WiFi.scanDelete();
      buildCandidates();
      tryNext();
      break;
    }
    case WS::Trying:
      if (up) { enterUp(); break; }
      if (discFlag || millis() > wsDeadline) {
        int r = discFlag ? discReason : -1;
        Serial.printf("# wifi '%s' failed: %s\n", trySsid.c_str(), r < 0 ? "timeout" : reasonStr(r));
        if (netCount && trySsid == nets[0].ssid) firstReason = r;
        WiFi.disconnect();
        tryNext();
      }
      break;
    case WS::Waiting:
      if (millis() < wsDeadline) break;
      if (netCount == 0 || millis() - offlineSince > PORTAL_AFTER_MS) startPortal(false);
      else wifiStartScan();
      break;
    case WS::Up:
      if (up) break;
      Serial.println("# wifi lost");
      offlineSince = millis();
      wifiBackoff = 5000;
      wifiStartScan();
      break;
    case WS::Portal:
      break;
  }
}

// ---------- Phone setup: own access point + captive portal ----------
WebServer web(80);
DNSServer dns;
enum class TestSt : uint8_t { None, Testing, Ok, Failed };
TestSt testSt = TestSt::None;
String testSsid, testPass;
int16_t testReason = 0;
uint32_t testDeadline = 0, portalCloseAt = 0, portalActive = 0, portalScanAt = 0;
bool portalScanning = false;
const IPAddress PORTAL_IP(192, 168, 4, 1);

static void loadApCredentials() {
  apSsid = "PlugPilot-" + defaultDeviceId().substring(6);   // MAC based, stays the same if Device ID changes
  prefs.begin("sys", false);                                  // not cleared by factory reset (matches a label on the box)
  apPass = prefs.getString("ap_pass", "");
  if (apPass.length() < 8) {
    char buf[12];
    snprintf(buf, sizeof(buf), "%08lu", (unsigned long)(esp_random() % 100000000UL));
    apPass = buf;
    prefs.putString("ap_pass", apPass);
  }
  prefs.end();
}

static void portalStartScan() {
  if (portalScanning || testSt == TestSt::Testing) return;
  WiFi.scanDelete();
  portalScanning = WiFi.scanNetworks(true) != WIFI_SCAN_FAILED;
  portalScanAt = millis();
}

static void startPortal(bool keepSta) {
  if (!keepSta) WiFi.disconnect();
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAPConfig(PORTAL_IP, PORTAL_IP, IPAddress(255, 255, 255, 0));
  WiFi.softAP(apSsid.c_str(), apPass.c_str());
  dns.setErrorReplyCode(DNSReplyCode::NoError);
  dns.start(53, "*", PORTAL_IP);
  web.begin();
  ws = WS::Portal;
  testSt = TestSt::None;
  portalActive = portalScanAt = millis();
  portalCloseAt = 0;
  Serial.printf("# phone setup ON: join Wi-Fi '%s' password %s, then open http://192.168.4.1\n", apSsid.c_str(), apPass.c_str());
}

static void stopPortal() {
  web.stop();
  dns.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  portalScanning = false;
  testPass = "";
  Serial.println("# phone setup OFF");
  if (WiFi.status() == WL_CONNECTED) {
    enterUp();
  } else {
    offlineSince = millis();     // another full minute of retries before the portal reopens
    wifiBackoff = 5000;
    ws = WS::Waiting;
    wsDeadline = 0;
  }
}

static void portalSendState() {
  JsonDocument d;
  d["id"] = cfg.deviceId;
  d["fw"] = FW_VERSION;
  d["scanning"] = portalScanning;
  JsonArray sv = d["saved"].to<JsonArray>();
  for (uint8_t i = 0; i < netCount; i++) sv.add(nets[i].ssid);
  JsonArray ns = d["nets"].to<JsonArray>();
  for (uint8_t j = 0; j < seenCount; j++) {
    JsonObject o = ns.add<JsonObject>();
    o["s"] = seen[j].ssid;
    o["r"] = seen[j].rssi;
    o["l"] = seen[j].lock;
  }
  JsonObject t = d["test"].to<JsonObject>();
  static const char* const ST[] = {"", "testing", "ok", "failed"};
  t["st"] = ST[(int)testSt];
  t["ssid"] = testSsid;
  t["reason"] = testSt == TestSt::Failed ? (testReason < 0 ? "connect_failed" : reasonStr(testReason)) : "";
  String out;
  serializeJson(d, out);
  web.sendHeader("Cache-Control", "no-store");
  web.send(200, "application/json", out);
}

static void portalRedirect() {
  web.sendHeader("Location", "http://192.168.4.1/", true);
  web.send(302, "text/plain", "");
}

static void setupPortalRoutes() {
  web.on("/", HTTP_GET, [] {
    // Phones probe e.g. connectivitycheck.gstatic.com/ : send them to our page so the sign-in sheet opens.
    if (web.hostHeader() != "192.168.4.1") return portalRedirect();
    web.sendHeader("Cache-Control", "no-store");
    web.send_P(200, "text/html; charset=utf-8", PORTAL_HTML);
  });
  web.on("/api/state", HTTP_GET, portalSendState);
  web.on("/api/scan", HTTP_POST, [] { portalStartScan(); portalSendState(); });
  web.on("/api/connect", HTTP_POST, [] {
    String s = web.arg("ssid"), p = web.arg("pass");
    if (s.isEmpty() || s.length() > 32 || p.length() > 63 || (p.length() && p.length() < 8))
      return web.send(400, "application/json", "{\"error\":\"bad_input\"}");
    if (portalScanning || testSt == TestSt::Testing) return web.send(409, "application/json", "{\"error\":\"busy\"}");
    Serial.printf("# phone setup: testing '%s' ...\n", s.c_str());
    WiFi.disconnect();
    testSsid = s;
    testPass = p;
    testSt = TestSt::Testing;
    testDeadline = millis() + PORTAL_TEST_MS;
    discFlag = false;
    WiFi.begin(s.c_str(), p.c_str());
    portalSendState();
  });
  web.on("/api/forget", HTTP_POST, [] { forgetNet(web.arg("ssid")); portalSendState(); });
  web.onNotFound(portalRedirect);   // captive-portal probes (generate_204, hotspot-detect.html, ...)
}

static void portalTask() {
  dns.processNextRequest();
  web.handleClient();
  bool phoneOn = WiFi.softAPgetStationNum() > 0;
  if (phoneOn) portalActive = millis();

  if (portalScanning) {
    int n = WiFi.scanComplete();
    if (n == WIFI_SCAN_RUNNING && millis() - portalScanAt < 15000) return;
    portalScanning = false;
    if (n >= 0) cacheScan(n); else WiFi.scanDelete();
    // Nobody is setting the board up and a saved network is back (e.g. the router finished booting): leave.
    if (!phoneOn && testSt != TestSt::Testing) {
      for (uint8_t i = 0; i < netCount; i++)
        if (seenRssi(nets[i].ssid) > -1000) { Serial.printf("# saved Wi-Fi '%s' is back\n", nets[i].ssid.c_str()); stopPortal(); return; }
    }
  }

  switch (testSt) {
    case TestSt::Testing:
      if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("# phone setup: '%s' works, ip=%s\n", testSsid.c_str(), WiFi.localIP().toString().c_str());
        rememberNet(testSsid, &testPass);
        firstReason = 0;
        testPass = "";
        testSt = TestSt::Ok;
        portalCloseAt = millis() + 15000;   // let the phone read the result first
        configTzTime(cfg.tz.c_str(), "pool.ntp.org", "time.google.com");
      } else if (discFlag || millis() > testDeadline) {
        testReason = discFlag ? discReason : -1;
        Serial.printf("# phone setup: '%s' failed: %s\n", testSsid.c_str(), testReason < 0 ? "timeout" : reasonStr(testReason));
        WiFi.disconnect();
        testPass = "";
        testSt = TestSt::Failed;
      }
      return;
    case TestSt::Ok:
      if (millis() > portalCloseAt) stopPortal();
      return;
    default:
      break;
  }

  if (netCount > 0 && millis() - portalActive > PORTAL_IDLE_MS) {
    Serial.println("# phone setup: nobody connected for 3 min, retrying saved Wi-Fi");
    stopPortal();
  } else if (!phoneOn && netCount > 0 && WiFi.status() != WL_CONNECTED && millis() - portalScanAt > 30000) {
    portalStartScan();   // background check for a saved network
  }
}

// ---------- SHT3x temperature / humidity sensor (I2C) ----------
// No library: single-shot measurement, high repeatability, no clock stretching (0x2400), CRC-8 checked.
struct {
  bool enabled = false;     // false when GPIO21/22 are used as relay pins
  bool present = false;     // answered at 0x44/0x45
  bool ok = false;          // last reading valid
  uint8_t addr = 0, fails = 0;
  float t = NAN, h = NAN;
  const char* err = "";
  uint32_t lastRead = 0, lastProbe = 0, lastLog = 0;
  bool probed = false, readOnce = false;
} sht;

static uint8_t shtCrc(const uint8_t* d) {
  uint8_t c = 0xFF;
  for (int i = 0; i < 2; i++) {
    c ^= d[i];
    for (int b = 0; b < 8; b++) c = (c & 0x80) ? (uint8_t)((c << 1) ^ 0x31) : (uint8_t)(c << 1);
  }
  return c;
}

static bool shtProbe() {
  for (uint8_t a : {0x44, 0x45}) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) { sht.addr = a; return true; }
  }
  return false;
}

static bool shtRead(float& t, float& h, const char** err) {
  Wire.beginTransmission(sht.addr);
  Wire.write(0x24);
  Wire.write(0x00);
  if (Wire.endTransmission() != 0) { *err = "no_ack"; return false; }
  delay(16);   // max measurement time 15.5 ms
  if (Wire.requestFrom((int)sht.addr, 6) != 6) { *err = "short_read"; return false; }
  uint8_t b[6];
  for (uint8_t& x : b) x = Wire.read();
  if (shtCrc(b) != b[2] || shtCrc(b + 3) != b[5]) { *err = "crc"; return false; }
  t = -45.0f + 175.0f * (float)((b[0] << 8) | b[1]) / 65535.0f;
  h = 100.0f * (float)((b[3] << 8) | b[4]) / 65535.0f;
  return true;
}

// Retained "<prefix>sensor": {"type":"SHT3x","ok":true,"t":28.4,"h":61.2} or {"ok":false,"error":...}
static void publishSensor() {
  if (!mqtt.connected() || !sht.enabled || (!sht.present && !sht.readOnce)) return;
  JsonDocument doc;
  doc["type"] = "SHT3x";
  doc["ok"] = sht.ok;
  if (sht.ok) {
    doc["t"] = serialized(String(sht.t, 1));
    doc["h"] = serialized(String(sht.h, 1));
  } else {
    doc["error"] = *sht.err ? sht.err : "not_found";
  }
  String out;
  serializeJson(doc, out);
  mqtt.publish((topicPrefix + "sensor").c_str(), out.c_str(), true);
}

static void initSensor() {
  for (uint8_t i = 0; i < cfg.relayCount; i++)
    if (relayPins[i] == SENSOR_SDA || relayPins[i] == SENSOR_SCL) {
      Serial.println("# sensor: GPIO21/22 are relay pins, SHT3x disabled");
      return;
    }
  sht.enabled = Wire.begin(SENSOR_SDA, SENSOR_SCL, 100000);
  Wire.setTimeOut(50);
}

static void sensorTask() {
  if (!sht.enabled) return;
  uint32_t now = millis();
  if (!sht.present) {
    if (sht.probed && now - sht.lastProbe < SENSOR_PROBE_MS) return;
    bool first = !sht.probed;
    sht.probed = true;
    sht.lastProbe = now;
    if (!shtProbe()) {
      if (first) Serial.println("# sensor: no SHT3x on SDA GPIO21 / SCL GPIO22 (optional)");
      return;
    }
    sht.present = true;
    sht.fails = 0;
    sht.lastRead = 0;
    Serial.printf("# sensor: SHT3x found at 0x%02X (SDA GPIO21, SCL GPIO22)\n", sht.addr);
  }
  if (sht.lastRead && now - sht.lastRead < SENSOR_INTERVAL_MS) return;
  sht.lastRead = now ? now : 1;
  float t, h;
  const char* err = "";
  if (shtRead(t, h, &err)) {
    bool changed = !sht.ok;
    sht.t = t; sht.h = h; sht.ok = true; sht.fails = 0; sht.readOnce = true;
    if (changed || now - sht.lastLog > 300000) {
      sht.lastLog = now;
      Serial.printf("# sensor %.1f C  %.1f %%RH\n", t, h);
    }
    publishSensor();
  } else if (++sht.fails >= 3) {
    // three bad readings in a row: report it, then look for the sensor again
    Serial.printf("# sensor: SHT3x read failed (%s), check wiring\n", err);
    sht.err = err;
    sht.ok = false;
    sht.present = false;
    publishSensor();
    sht.lastProbe = now;
  }
}

// ---------- MQTT ----------
uint32_t mqttNextAttempt = 0, mqttBackoff = 1000, lastTelemetry = 0;

static void publishInfo() {
  JsonDocument doc;
  doc["id"] = cfg.deviceId;
  doc["fw"] = FW_VERSION;
  doc["chip"] = ESP.getChipModel();
  doc["mac"] = WiFi.macAddress();
  doc["ip"] = WiFi.localIP().toString();
  doc["tz"] = cfg.tz;
  if (sht.enabled) {   // where a sensor goes (present or not), for the web wiring hints
    JsonObject s = doc["sensor"].to<JsonObject>();
    s["type"] = "SHT3x";
    s["sda"] = SENSOR_SDA;
    s["scl"] = SENSOR_SCL;
    s["present"] = sht.present;
  }
  JsonArray arr = doc["relays"].to<JsonArray>();
  for (uint8_t i = 0; i < cfg.relayCount; i++) {
    JsonObject r = arr.add<JsonObject>();
    r["ch"] = i + 1;
    r["gpio"] = relayPins[i];
  }
  String out;
  serializeJson(doc, out);
  mqtt.publish((topicPrefix + "info").c_str(), out.c_str(), true);
}

static void publishTelemetry() {
  JsonDocument doc;
  doc["rssi"] = WiFi.RSSI();
  doc["uptime"] = millis() / 1000;
  doc["heap"] = ESP.getFreeHeap();
  doc["ip"] = WiFi.localIP().toString();
  doc["time"] = localTimeStr();
  String out;
  serializeJson(doc, out);
  mqtt.publish((topicPrefix + "telemetry").c_str(), out.c_str(), false);
}

static void onMqttMessage(char* topic, byte* payload, unsigned int len) {
  String t(topic);
  String p;
  p.reserve(len);
  for (unsigned int i = 0; i < len; i++) p += (char)payload[i];
  p.trim();

  Serial.printf("# mqtt rx %s = %s%s\n", topic, p.c_str(), len == 0 ? "(empty)" : "");
  if (!t.startsWith(topicPrefix)) return;
  String sub = t.substring(topicPrefix.length());   // e.g. "relay/3/set" or "cmd"

  if (sub.startsWith("relay/") && sub.endsWith("/set")) {
    int ch = sub.substring(6, sub.length() - 4).toInt();   // 1-based
    if (ch < 1 || !setRelay(ch - 1, p, "mqtt"))
      Serial.printf("# bad relay cmd: %s = %s (valid: CH1-%u, ON/OFF/TOGGLE)\n", topic, p.c_str(), cfg.relayCount);
  } else if (sub == "schedule/set") {
    JsonDocument doc;
    const char* err = "invalid JSON";
    if (deserializeJson(doc, p) || !applySchedule(doc.as<JsonVariantConst>(), &err)) {
      Serial.printf("# schedule rejected: %s\n", err);
      publishSchedule(err);
    }
  } else if (sub == "cmd") {
    if (p == "reboot") { mqtt.publish((topicPrefix + "status").c_str(), "offline", true); delay(100); ESP.restart(); }
    else if (p == "ping") { publishInfo(); publishTelemetry(); publishSchedule(); publishSensor(); }
    else if (p == "all_off") { for (uint8_t i = 0; i < cfg.relayCount; i++) setRelay(i, "OFF", "cmd"); }
  }
}

static void mqttTask() {
  if (WiFi.status() != WL_CONNECTED || cfg.mqttHost.isEmpty()) return;
  if (mqtt.connected()) {
    mqtt.loop();
    if (millis() - lastTelemetry > TELEMETRY_INTERVAL_MS) {
      lastTelemetry = millis();
      publishTelemetry();
    }
    return;
  }
  if (millis() < mqttNextAttempt) return;

  Serial.printf("# mqtt connecting %s://%s:%u as %s ...\n", cfg.mqttTls ? "mqtts" : "mqtt",
                cfg.mqttHost.c_str(), cfg.mqttPort, cfg.deviceId.c_str());
  mqtt.setServer(cfg.mqttHost.c_str(), cfg.mqttPort);
  String willTopic = topicPrefix + "status";
  bool ok = mqtt.connect(cfg.deviceId.c_str(),
                         cfg.mqttUser.isEmpty() ? nullptr : cfg.mqttUser.c_str(),
                         cfg.mqttPass.isEmpty() ? nullptr : cfg.mqttPass.c_str(),
                         willTopic.c_str(), 1, true, "offline");
  if (!ok) {
    Serial.printf("# mqtt failed, rc=%d, retry in %lus\n", mqtt.state(), (unsigned long)mqttBackoff / 1000);
    if (cfg.mqttTls) {
      char err[100];
      if (tlsClient.lastError(err, sizeof(err))) Serial.printf("# tls error: %s\n", err);
    }
    mqttNextAttempt = millis() + mqttBackoff;
    mqttBackoff = std::min<uint32_t>(mqttBackoff * 2, 30000);
    return;
  }
  mqttBackoff = 1000;
  Serial.println("# mqtt connected");
  mqtt.publish(willTopic.c_str(), "online", true);
  publishInfo();
  for (uint8_t i = 0; i < cfg.relayCount; i++) publishRelayState(i);
  publishTelemetry();
  publishSchedule();
  publishSensor();
  lastTelemetry = millis();
  // Log exactly what we listen to, so a mismatching external topic is easy to spot.
  // (Topics are case-sensitive: "ROCKETMAN/..." != "rocketman/...")
  for (const String& sub : {topicPrefix + "relay/+/set", topicPrefix + "schedule/set", topicPrefix + "cmd"}) {
    bool subOk = mqtt.subscribe(sub.c_str(), 1);
    Serial.printf("# mqtt sub %s %s\n", sub.c_str(), subOk ? "ok" : "FAILED");
  }
}

// ---------- Serial provisioning ----------
static void reply(JsonDocument& doc) {
  serializeJson(doc, Serial);
  Serial.println();
}

static void replyError(const char* type, const char* msg) {
  JsonDocument d;
  d["ok"] = false;
  d["type"] = type;
  d["error"] = msg;
  reply(d);
}

// "connected" | "portal" | "unconfigured" | "auth_failed" / "ssid_not_found" / "connect_failed"
// (last failure of the newest saved network) | "connecting"
static const char* wifiStateStr() {
  if (WiFi.status() == WL_CONNECTED) return "connected";
  if (ws == WS::Portal) return "portal";
  if (netCount == 0) return "unconfigured";
  if (firstReason) return firstReason < 0 ? "connect_failed" : reasonStr(firstReason);
  return "connecting";
}

static void addNetworks(JsonDocument& d) {
  JsonArray arr = d["networks"].to<JsonArray>();
  for (uint8_t i = 0; i < netCount; i++) arr.add(nets[i].ssid);
}

static void handleCommand(const char* line) {
  JsonDocument req;
  if (deserializeJson(req, line)) { replyError("parse", "invalid json"); return; }
  String cmd = req["cmd"] | "";

  if (cmd == "info") {
    JsonDocument d;
    d["ok"] = true;
    d["type"] = "info";
    JsonObject i = d["info"].to<JsonObject>();
    i["fw"] = FW_VERSION;
    i["chip"] = ESP.getChipModel();
    i["rev"] = ESP.getChipRevision();
    i["flash_mb"] = ESP.getFlashChipSize() / (1024 * 1024);
    i["mac"] = WiFi.macAddress();
    i["device_id"] = cfg.deviceId;
    i["base"] = cfg.base;
    // wifi_ssid: the network in use, else the newest saved one
    i["wifi_ssid"] = WiFi.status() == WL_CONNECTED ? WiFi.SSID() : (netCount ? nets[0].ssid : String());
    i["has_wifi_pass"] = netCount && !nets[0].pass.isEmpty();
    JsonArray wn = i["wifi_networks"].to<JsonArray>();
    for (uint8_t k = 0; k < netCount; k++) wn.add(nets[k].ssid);
    i["wifi_max"] = MAX_NETS;
    i["ap_ssid"] = apSsid;
    i["ap_pass"] = apPass;      // USB only (physical access); never published over MQTT
    i["portal"] = ws == WS::Portal;
    i["mqtt_host"] = cfg.mqttHost;
    i["mqtt_port"] = cfg.mqttPort;
    i["mqtt_tls"] = cfg.mqttTls;
    i["mqtt_user"] = cfg.mqttUser;
    i["has_mqtt_pass"] = !cfg.mqttPass.isEmpty();
    i["relay_count"] = cfg.relayCount;
    i["active_low"] = cfg.activeLow;
    i["restore_state"] = cfg.restoreState;
    i["tz"] = cfg.tz;
    i["time"] = localTimeStr();
    i["wifi"] = wifiStateStr();
    i["ip"] = WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : "";
    i["rssi"] = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
    i["mqtt"] = mqtt.connected();
    i["relay_mask"] = relayMask;
    i["topic_prefix"] = topicPrefix;
    JsonArray pins = i["relay_pins"].to<JsonArray>();
    for (uint8_t k = 0; k < cfg.relayCount; k++) pins.add(relayPins[k]);
    JsonArray safe = i["safe_pins"].to<JsonArray>();
    for (uint8_t s : SAFE_PINS) safe.add(s);
    rulesToJson(i["schedule"].to<JsonArray>());
    JsonObject sn = i["sensor"].to<JsonObject>();
    sn["type"] = "SHT3x";
    sn["enabled"] = sht.enabled;          // false = GPIO21/22 used by relays
    sn["present"] = sht.present;
    sn["ok"] = sht.ok;
    if (sht.present) sn["addr"] = sht.addr;
    if (sht.ok) { sn["t"] = serialized(String(sht.t, 1)); sn["h"] = serialized(String(sht.h, 1)); }
    if (*sht.err) sn["error"] = sht.err;
    reply(d);

  } else if (cmd == "scan") {
    Serial.println("# scanning wifi ...");
    // wait for a background scan to finish (a second scan can't start while one runs)
    for (uint32_t t0 = millis(); WiFi.scanComplete() == WIFI_SCAN_RUNNING && millis() - t0 < 10000;) { delay(50); esp_task_wdt_reset(); }
    bool connecting = ws != WS::Up && ws != WS::Portal;
    if (connecting) WiFi.disconnect();   // scan fails while a connect attempt is running
    int n = WiFi.scanNetworks(false, false);
    if (n >= 0) cacheScan(n); else WiFi.scanDelete();
    portalScanning = false;
    JsonDocument d;
    d["ok"] = n >= 0;
    d["type"] = "scan";
    JsonArray arr = d["networks"].to<JsonArray>();
    for (uint8_t k = 0; k < seenCount; k++) {
      JsonObject o = arr.add<JsonObject>();
      o["ssid"] = seen[k].ssid;
      o["rssi"] = seen[k].rssi;
      o["secure"] = seen[k].lock;
      o["saved"] = findNet(seen[k].ssid) >= 0;
    }
    if (connecting) { ws = WS::Waiting; wsDeadline = 0; }   // resume connecting right away (uses this scan)
    reply(d);

  } else if (cmd == "wifi_add" || cmd == "wifi_forget") {
    // Manage saved networks without rebooting (e.g. add the office Wi-Fi while at home).
    String s = req["ssid"] | "";
    JsonDocument d;
    d["type"] = cmd;
    if (cmd == "wifi_add") {
      String p = req["pass"] | "";
      if (s.isEmpty() || s.length() > 32 || p.length() > 63 || (p.length() && p.length() < 8)) {
        replyError(cmd.c_str(), "ssid 1-32 chars, password empty or 8-63 chars"); return;
      }
      if (req["pass"].is<const char*>()) rememberNet(s, &p); else rememberNet(s, nullptr);
      d["ok"] = true;
    } else {
      bool ok = forgetNet(s);
      d["ok"] = ok;
      if (!ok) d["error"] = "not saved";
    }
    addNetworks(d);
    reply(d);

  } else if (cmd == "portal") {
    // Open phone setup now (same as a short press of BOOT).
    if (ws != WS::Portal) startPortal(WiFi.status() == WL_CONNECTED);
    JsonDocument d;
    d["ok"] = true;
    d["type"] = "portal";
    d["ap_ssid"] = apSsid;
    reply(d);

  } else if (cmd == "set_config") {
    // Validate everything that can be wrong BEFORE writing anything.
    uint8_t newPins[MAX_RELAYS];
    int newCount = -1;
    if (!req["relay_pins"].isNull()) {
      const char* err = nullptr;
      newCount = parsePins(req["relay_pins"].as<JsonVariantConst>(), newPins, &err);
      if (newCount < 0) { replyError("set_config", err); return; }
    }
    if (req["tz"].is<const char*>() && strlen(req["tz"].as<const char*>()) > 40) { replyError("set_config", "tz too long"); return; }
    String newSsid = req["wifi_ssid"] | "";
    String newPass = req["wifi_pass"] | "";
    if (newSsid.length() > 32 || newPass.length() > 63 || (newPass.length() && newPass.length() < 8)) {
      replyError("set_config", "wifi: ssid 1-32 chars, password empty or 8-63 chars"); return;
    }

    // Partial update: only keys present in the request are written.
    prefs.begin("cfg", false);
    auto putStr = [&](const char* key) {
      if (req[key].is<const char*>()) prefs.putString(key, req[key].as<const char*>());
    };
    putStr("mqtt_host"); putStr("mqtt_user"); putStr("mqtt_pass");
    putStr("device_id"); putStr("base"); putStr("tz");
    if (req["mqtt_port"].is<int>()) prefs.putUShort("mqtt_port", req["mqtt_port"].as<uint16_t>());
    if (req["mqtt_tls"].is<bool>()) prefs.putBool("mqtt_tls", req["mqtt_tls"].as<bool>());
    if (req["active_low"].is<bool>()) prefs.putBool("active_low", req["active_low"].as<bool>());
    if (req["restore_state"].is<bool>()) prefs.putBool("restore", req["restore_state"].as<bool>());
    bool pinsChanged = newCount > 0 &&
                       (newCount != cfg.relayCount || memcmp(newPins, relayPins, newCount) != 0);
    if (pinsChanged) prefs.putBytes("pins", newPins, newCount);
    prefs.end();
    if (pinsChanged) {
      // channel numbers now mean different GPIOs: start with every relay OFF
      prefs.begin("relay", false); prefs.clear(); prefs.end();
      Serial.printf("# relay pins changed: %d channel(s), all relays start OFF\n", newCount);
    }
    // Wi-Fi: added to the saved list (front = tried first on a tie); other saved networks are kept.
    if (newSsid.length()) rememberNet(newSsid, req["wifi_pass"].is<const char*>() ? &newPass : nullptr);
    JsonDocument d;
    d["ok"] = true;
    d["type"] = "set_config";
    d["rebooting"] = true;
    reply(d);
    Serial.flush();
    delay(300);
    ESP.restart();

  } else if (cmd == "set_schedule") {
    const char* err = nullptr;
    if (!applySchedule(req.as<JsonVariantConst>(), &err)) { replyError("set_schedule", err); return; }
    JsonDocument d;
    d["ok"] = true;
    d["type"] = "set_schedule";
    d["count"] = ruleCount;
    reply(d);

  } else if (cmd == "relay") {
    int ch = req["ch"] | 0;
    String st = req["state"] | "TOGGLE";
    if (ch < 1 || !setRelay(ch - 1, st, "usb")) { replyError("relay", "bad ch/state"); return; }
    JsonDocument d;
    d["ok"] = true;
    d["type"] = "relay";
    d["ch"] = ch;
    d["state"] = relayOn(ch - 1) ? "ON" : "OFF";
    reply(d);

  } else if (cmd == "reboot") {
    JsonDocument d; d["ok"] = true; d["type"] = "reboot"; reply(d);
    Serial.flush(); delay(200); ESP.restart();

  } else if (cmd == "factory_reset") {
    JsonDocument d; d["ok"] = true; d["type"] = "factory_reset"; reply(d);
    Serial.flush(); factoryReset();

  } else {
    replyError("unknown", "unknown cmd");
  }
}

static char lineBuf[2048];
static size_t lineLen = 0;

static void serialTask() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      lineBuf[lineLen] = '\0';
      if (lineLen > 0 && lineBuf[0] == '{') handleCommand(lineBuf);
      lineLen = 0;
    } else if (lineLen < sizeof(lineBuf) - 1) {
      lineBuf[lineLen++] = c;
    } else {
      lineLen = 0;   // overflow: drop line
      replyError("parse", "line too long");
    }
  }
}

// ---------- BOOT button: short press => phone setup, hold 5 s => factory reset ----------
static void buttonTask() {
  static uint32_t pressedAt = 0;
  if (digitalRead(BOOT_BTN_PIN) == LOW) {
    if (pressedAt == 0) pressedAt = millis();
    else if (millis() - pressedAt > FACTORY_RESET_HOLD_MS) factoryReset();
  } else {
    uint32_t held = pressedAt ? millis() - pressedAt : 0;
    if (held >= 50 && held < 2000 && ws != WS::Portal) {
      Serial.println("# BOOT pressed: opening phone setup");
      startPortal(WiFi.status() == WL_CONNECTED);
    }
    pressedAt = 0;
  }
}

// ---------- Arduino entry points ----------
void setup() {
  Serial.begin(115200);
  delay(50);
  loadConfig();
  WiFi.persistent(false);       // don't let the WiFi lib write its own copy to flash
  WiFi.setHostname(cfg.deviceId.c_str());   // core 2.x: must precede WiFi.mode()
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false); // we manage reconnects ourselves
  WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t info) {
    uint8_t r = info.wifi_sta_disconnected.reason;
    if (r == WIFI_REASON_ASSOC_LEAVE) return;   // our own WiFi.disconnect()
    discReason = r;
    discFlag = true;
  }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  initRelays();                 // before networking, so loads don't glitch
  initSensor();
  loadRules();
  loadNets();
  loadApCredentials();          // after WiFi.mode(): esp_random() is a true RNG once the radio is on
  setupPortalRoutes();
  pinMode(BOOT_BTN_PIN, INPUT_PULLUP);

  if (cfg.mqttTls) {
    tlsClient.setCACert(CA_BUNDLE);
    tlsClient.setHandshakeTimeout(10);   // seconds; default (120 s) would trip the watchdog
    mqtt.setClient(tlsClient);
  } else {
    mqtt.setClient(netClient);
  }
  mqtt.setCallback(onMqttMessage);
  mqtt.setBufferSize(2048);     // schedules (20 rules) and info with 15 relays
  mqtt.setKeepAlive(30);
  mqtt.setSocketTimeout(5);     // keep connect attempts well under the WDT timeout

  esp_task_wdt_init(WDT_TIMEOUT_S, true);
  esp_task_wdt_add(NULL);

  Serial.printf("\n# ESP32 relay controller fw=%s id=%s\n", FW_VERSION, cfg.deviceId.c_str());
  Serial.printf("# topics: %srelay/<1-%u>/set  (payload ON / OFF / TOGGLE)\n", topicPrefix.c_str(), cfg.relayCount);
  for (uint8_t i = 0; i < cfg.relayCount; i++)
    Serial.printf("# pinmap CH%u -> GPIO%u (%s)\n", i + 1, relayPins[i], relayOn(i) ? "ON" : "OFF");
  Serial.printf("# schedule: %u rule(s), tz=%s\n", ruleCount, cfg.tz.c_str());
  for (uint8_t i = 0; i < netCount; i++) Serial.printf("# wifi saved %u: '%s'\n", i + 1, nets[i].ssid.c_str());
  Serial.printf("# phone setup: Wi-Fi '%s' password %s (opens when no saved Wi-Fi is reachable for 60 s, or press BOOT briefly)\n",
                apSsid.c_str(), apPass.c_str());
}

void loop() {
  serialTask();
  wifiTask();
  mqttTask();
  scheduleTask();
  sensorTask();
  buttonTask();
  esp_task_wdt_reset();
  delay(5);
}
