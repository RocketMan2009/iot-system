/*
 * ESP32-DevKitC (WROOM-32D) — MQTT relay controller
 *
 *  - Up to 8 relays, state persisted in NVS
 *  - MQTT: status (LWT), info (discovery), relay/<n>/set|state, telemetry, cmd
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
#include "ca_bundle.h"

#ifndef FW_VERSION
#define FW_VERSION "1.0.0-local"
#endif

// ---------- Hardware (validated: no strapping / flash / input-only pins) ----------
static const uint8_t RELAY_PINS[] = {16, 17, 18, 19, 23, 25, 26, 27};
static const uint8_t RELAY_COUNT = sizeof(RELAY_PINS) / sizeof(RELAY_PINS[0]);
static const uint8_t BOOT_BTN_PIN = 0;          // on-board BOOT button, read only after boot
static const uint32_t FACTORY_RESET_HOLD_MS = 5000;
static const uint32_t TELEMETRY_INTERVAL_MS = 30000;
static const uint32_t WDT_TIMEOUT_S = 15;

// ---------- Config (NVS namespace "cfg") ----------
struct Config {
  String wifiSsid, wifiPass;
  String mqttHost, mqttUser, mqttPass;
  uint16_t mqttPort = 1883;
  bool mqttTls = false;       // MQTTS (cloud brokers such as HiveMQ Cloud / EMQX)
  String deviceId;
  String base = "home";
  uint8_t relayCount = RELAY_COUNT;
  bool activeLow = true;      // most opto relay boards are active-LOW
  bool restoreState = true;   // restore relay states after power loss
} cfg;

Preferences prefs;
WiFiClient netClient;
WiFiClientSecure tlsClient;
PubSubClient mqtt;

uint8_t relayMask = 0;        // bit n = relay n+1 ON
String topicPrefix;           // "<base>/<id>/"

// ---------- Helpers ----------
static String defaultDeviceId() {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);   // works before the Wi-Fi driver starts
  char buf[16];
  snprintf(buf, sizeof(buf), "esp32-%02x%02x%02x", mac[3], mac[4], mac[5]);
  return String(buf);
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
  cfg.relayCount = constrain(prefs.getUChar("relay_cnt", RELAY_COUNT), 1, RELAY_COUNT);
  cfg.activeLow = prefs.getBool("active_low", true);
  cfg.restoreState = prefs.getBool("restore", true);
  prefs.end();
  if (cfg.deviceId.isEmpty()) cfg.deviceId = defaultDeviceId();
  topicPrefix = cfg.base + "/" + cfg.deviceId + "/";
}

static void factoryReset() {
  Serial.println("# factory reset: clearing NVS");
  prefs.begin("cfg", false); prefs.clear(); prefs.end();
  prefs.begin("relay", false); prefs.clear(); prefs.end();
  delay(200);
  ESP.restart();
}

// ---------- Relays ----------
static inline bool relayOn(uint8_t idx) { return relayMask & (1u << idx); }

static void writeRelayPin(uint8_t idx) {
  bool on = relayOn(idx);
  digitalWrite(RELAY_PINS[idx], (on ^ cfg.activeLow) ? HIGH : LOW);
}

static void publishRelayState(uint8_t idx) {
  if (!mqtt.connected()) return;
  String t = topicPrefix + "relay/" + String(idx + 1) + "/state";
  mqtt.publish(t.c_str(), relayOn(idx) ? "ON" : "OFF", true);
}

static void saveRelayMask() {
  prefs.begin("relay", false);
  if (prefs.getUChar("mask", 0xFF) != relayMask) prefs.putUChar("mask", relayMask);  // avoid needless flash writes
  prefs.end();
}

// cmd: "ON" | "OFF" | "TOGGLE" (case-insensitive). Returns false on bad input.
static bool setRelay(uint8_t idx, String cmd) {
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
  publishRelayState(idx);   // always echo, even if unchanged (confirms command to UI)
  Serial.printf("# relay %u -> %s\n", idx + 1, target ? "ON" : "OFF");
  return true;
}

static void initRelays() {
  if (cfg.restoreState) {
    prefs.begin("relay", true);
    relayMask = prefs.getUChar("mask", 0);
    prefs.end();
  } else {
    relayMask = 0;
  }
  for (uint8_t i = 0; i < RELAY_COUNT; i++) {
    if (i >= cfg.relayCount) relayMask &= ~(1u << i);
    // set the level BEFORE switching to output to avoid a glitch on boot
    digitalWrite(RELAY_PINS[i], (relayOn(i) ^ cfg.activeLow) ? HIGH : LOW);
    pinMode(RELAY_PINS[i], OUTPUT);
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
      configTime(0, 0, "pool.ntp.org", "time.google.com");   // real clock for TLS certificate checks
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
  JsonArray arr = doc["relays"].to<JsonArray>();
  for (uint8_t i = 0; i < cfg.relayCount; i++) {
    JsonObject r = arr.add<JsonObject>();
    r["ch"] = i + 1;
    r["gpio"] = RELAY_PINS[i];
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

  if (!t.startsWith(topicPrefix)) return;
  String sub = t.substring(topicPrefix.length());   // e.g. "relay/3/set" or "cmd"

  if (sub.startsWith("relay/") && sub.endsWith("/set")) {
    int ch = sub.substring(6, sub.length() - 4).toInt();   // 1-based
    if (ch < 1 || !setRelay(ch - 1, p)) Serial.printf("# bad relay cmd: %s = %s\n", topic, p.c_str());
  } else if (sub == "cmd") {
    if (p == "reboot") { mqtt.publish((topicPrefix + "status").c_str(), "offline", true); delay(100); ESP.restart(); }
    else if (p == "ping") { publishInfo(); publishTelemetry(); }
    else if (p == "all_off") { for (uint8_t i = 0; i < cfg.relayCount; i++) setRelay(i, "OFF"); }
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
  lastTelemetry = millis();
  mqtt.subscribe((topicPrefix + "relay/+/set").c_str(), 1);
  mqtt.subscribe((topicPrefix + "cmd").c_str(), 1);
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
    i["wifi"] = wifiStateStr();
    i["ip"] = WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : "";
    i["rssi"] = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
    i["mqtt"] = mqtt.connected();
    i["relay_mask"] = relayMask;
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
    // Partial update: only keys present in the request are written.
    prefs.begin("cfg", false);
    auto putStr = [&](const char* key) {
      if (req[key].is<const char*>()) prefs.putString(key, req[key].as<const char*>());
    };
    putStr("wifi_ssid"); putStr("wifi_pass");
    putStr("mqtt_host"); putStr("mqtt_user"); putStr("mqtt_pass");
    putStr("device_id"); putStr("base");
    if (req["mqtt_port"].is<int>()) prefs.putUShort("mqtt_port", req["mqtt_port"].as<uint16_t>());
    if (req["mqtt_tls"].is<bool>()) prefs.putBool("mqtt_tls", req["mqtt_tls"].as<bool>());
    if (req["relay_count"].is<int>()) prefs.putUChar("relay_cnt", constrain(req["relay_count"].as<int>(), 1, (int)RELAY_COUNT));
    if (req["active_low"].is<bool>()) prefs.putBool("active_low", req["active_low"].as<bool>());
    if (req["restore_state"].is<bool>()) prefs.putBool("restore", req["restore_state"].as<bool>());
    prefs.end();
    JsonDocument d;
    d["ok"] = true;
    d["type"] = "set_config";
    d["rebooting"] = true;
    reply(d);
    Serial.flush();
    delay(300);
    ESP.restart();

  } else if (cmd == "relay") {
    int ch = req["ch"] | 0;
    String st = req["state"] | "TOGGLE";
    if (ch < 1 || !setRelay(ch - 1, st)) { replyError("relay", "bad ch/state"); return; }
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

static char lineBuf[1024];
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
  pinMode(BOOT_BTN_PIN, INPUT_PULLUP);

  if (cfg.mqttTls) {
    tlsClient.setCACert(CA_BUNDLE);
    tlsClient.setHandshakeTimeout(10);   // seconds; default (120 s) would trip the watchdog
    mqtt.setClient(tlsClient);
  } else {
    mqtt.setClient(netClient);
  }
  mqtt.setCallback(onMqttMessage);
  mqtt.setBufferSize(1024);
  mqtt.setKeepAlive(30);
  mqtt.setSocketTimeout(5);     // keep connect attempts well under the WDT timeout

  esp_task_wdt_init(WDT_TIMEOUT_S, true);
  esp_task_wdt_add(NULL);

  Serial.printf("\n# ESP32 relay controller fw=%s id=%s\n", FW_VERSION, cfg.deviceId.c_str());
  if (cfg.wifiSsid.isEmpty())
    Serial.println("# not provisioned: open the web app > Provision tab and connect over USB");
}

void loop() {
  serialTask();
  wifiTask();
  mqttTask();
  buttonTask();
  esp_task_wdt_reset();
  delay(5);
}
