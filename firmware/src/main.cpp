/*
 * ESP32-DevKitC (WROOM-32D) — MQTT relay controller
 *
 *  - 1..15 relays on user-selected GPIOs (only boot/flash-safe pins accepted), state persisted in NVS
 *  - On-board schedules (time + weekdays -> ON/OFF), local time from NTP + POSIX timezone
 *  - MQTT: status (LWT), info, relay/<n>/set|state, schedule[/set], telemetry, cmd
 *  - USB provisioning: newline-delimited JSON on UART0 @115200 (see docs/DESIGN.md §3.2)
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
#include "ca_bundle.h"

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

// ---------- Config (NVS namespace "cfg") ----------
struct Config {
  String wifiSsid, wifiPass;
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
  cfg.wifiSsid = prefs.getString("wifi_ssid", "");
  cfg.wifiPass = prefs.getString("wifi_pass", "");
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
  for (const char* ns : {"cfg", "relay", "sched"}) { prefs.begin(ns, false); prefs.clear(); prefs.end(); }
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

// ---------- Wi-Fi (non-blocking with backoff) ----------
uint32_t wifiNextAttempt = 0, wifiBackoff = 1000;
bool wifiWasConnected = false;

static void wifiTask() {
  if (cfg.wifiSsid.isEmpty()) return;  // provisioning mode
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiWasConnected) {
      wifiWasConnected = true;
      wifiBackoff = 1000;
      Serial.printf("# wifi connected, ip=%s rssi=%d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
      // NTP: needed for TLS certificate checks and for schedules (local time via cfg.tz)
      configTzTime(cfg.tz.c_str(), "pool.ntp.org", "time.google.com");
    }
    return;
  }
  if (wifiWasConnected) {
    wifiWasConnected = false;
    Serial.println("# wifi lost");
  }
  if (millis() < wifiNextAttempt) return;
  Serial.printf("# wifi connecting to '%s' ...\n", cfg.wifiSsid.c_str());
  WiFi.disconnect();
  WiFi.begin(cfg.wifiSsid.c_str(), cfg.wifiPass.c_str());
  wifiNextAttempt = millis() + wifiBackoff + 8000;   // give each attempt ~8 s
  wifiBackoff = std::min<uint32_t>(wifiBackoff * 2, 30000);
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
    else if (p == "ping") { publishInfo(); publishTelemetry(); publishSchedule(); }
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

static const char* wifiStateStr() {
  if (cfg.wifiSsid.isEmpty()) return "unconfigured";
  switch (WiFi.status()) {
    case WL_CONNECTED: return "connected";
    case WL_NO_SSID_AVAIL: return "ssid_not_found";
    case WL_CONNECT_FAILED: return "auth_failed";
    default: return "connecting";
  }
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
    i["wifi_ssid"] = cfg.wifiSsid;
    i["has_wifi_pass"] = !cfg.wifiPass.isEmpty();
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
    reply(d);

  } else if (cmd == "scan") {
    Serial.println("# scanning wifi ...");
    if (WiFi.status() != WL_CONNECTED) WiFi.disconnect();   // scan fails while a connect attempt is running
    int n = WiFi.scanNetworks(false, false);
    JsonDocument d;
    d["ok"] = n >= 0;
    d["type"] = "scan";
    JsonArray arr = d["networks"].to<JsonArray>();
    for (int k = 0; k < n && k < 25; k++) {
      JsonObject o = arr.add<JsonObject>();
      o["ssid"] = WiFi.SSID(k);
      o["rssi"] = WiFi.RSSI(k);
      o["secure"] = WiFi.encryptionType(k) != WIFI_AUTH_OPEN;
    }
    WiFi.scanDelete();
    wifiNextAttempt = 0;   // resume connecting right away
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

    // Partial update: only keys present in the request are written.
    prefs.begin("cfg", false);
    auto putStr = [&](const char* key) {
      if (req[key].is<const char*>()) prefs.putString(key, req[key].as<const char*>());
    };
    putStr("wifi_ssid"); putStr("wifi_pass");
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

// ---------- BOOT button: hold 5 s => factory reset ----------
static void buttonTask() {
  static uint32_t pressedAt = 0;
  if (digitalRead(BOOT_BTN_PIN) == LOW) {
    if (pressedAt == 0) pressedAt = millis();
    else if (millis() - pressedAt > FACTORY_RESET_HOLD_MS) factoryReset();
  } else {
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
  initRelays();                 // before networking, so loads don't glitch
  loadRules();
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
  if (cfg.wifiSsid.isEmpty())
    Serial.println("# not provisioned: open the web app > Provision tab and connect over USB");
}

void loop() {
  serialTask();
  wifiTask();
  mqttTask();
  scheduleTask();
  buttonTask();
  esp_task_wdt_reset();
  delay(5);
}
