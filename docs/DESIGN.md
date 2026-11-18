# ESP32 IoT Control System — System Design

> บอร์ดเป้าหมาย: **ESP32-DevKitC (ESP32-WROOM-32D, 4 MB flash, ไม่มี PSRAM)**
> เวอร์ชันเอกสาร: 1.0 · 2026-11-18

---

## 1. Requirements

### 1.1 Functional
| # | Requirement |
|---|---|
| F1 | ควบคุมอุปกรณ์ไฟฟ้า (ผ่านรีเลย์) สูงสุด 8 ช่องต่อบอร์ด ด้วยคำสั่ง ON / OFF / TOGGLE จากเว็บ |
| F2 | เว็บแสดงสถานะจริงของรีเลย์ (state feedback จากบอร์ด ไม่ใช่แค่สถานะที่กดสั่ง) |
| F3 | แสดงสถานะออนไลน์/ออฟไลน์ของบอร์ด + telemetry (RSSI, uptime, free heap, IP) |
| F4 | ค้นหาบอร์ดอัตโนมัติ (auto-discovery) ไม่ต้องลงทะเบียนในเว็บเอง |
| F5 | **ตั้งค่าบอร์ดผ่านเบราว์เซอร์ทาง USB** (Wi-Fi, MQTT broker, Device ID, รีเลย์ active-low) โดยไม่ต้องแก้โค้ด |
| F6 | **แฟลชเฟิร์มแวร์ผ่านเบราว์เซอร์ทาง USB** โดยไม่ต้องติดตั้ง esptool/IDE |
| F7 | บอร์ดจำสถานะรีเลย์และค่า config หลังไฟดับ |
| F8 | Factory reset ที่บอร์ดได้ (กดปุ่ม BOOT ค้าง 5 วินาที) |

### 1.2 Non-functional
| ด้าน | เป้าหมาย |
|---|---|
| Latency | กด → รีเลย์ทำงาน → state กลับมาที่เว็บ < 300 ms ใน LAN |
| Availability | บอร์ด reconnect Wi-Fi/MQTT เองแบบ exponential backoff, รีเลย์คงสถานะเดิมระหว่างหลุด |
| Scale | 1–50 บอร์ด, ผู้ใช้เว็บพร้อมกัน 1–20 คน (บ้าน / ห้องแล็บ / SME) |
| Security | MQTT ต้องมี username/password, รองรับ WSS/TLS เมื่อใช้งานนอก LAN |
| Deploy | เว็บเป็น static files — โฮสต์ที่ไหนก็ได้ (GitHub Pages, Nginx, localhost) ไม่ต้องมี backend |

### 1.3 Constraints / Assumptions
- **Web Serial API** ใช้ได้เฉพาะ Chrome / Edge / Opera บนเดสก์ท็อป และต้องเป็น *secure context* (`https://` หรือ `http://localhost`)
- เบราว์เซอร์คุยกับ MQTT ได้เฉพาะผ่าน **WebSocket** → broker ต้องเปิด listener แบบ WS (เช่น Mosquitto port 9001)
- ถ้าเว็บโฮสต์บน `https://` ต้องใช้ `wss://` (mixed content ถูกบล็อก)
- DevKitC มีวงจร auto-reset (DTR/RTS → EN/IO0) จึงแฟลชได้โดยไม่ต้องกดปุ่ม BOOT
- ต้องติดตั้งไดรเวอร์ USB-UART (CP210x หรือ CH340 ตามรุ่นบอร์ด) บน Windows

---

## 2. High-Level Architecture

![สถาปัตยกรรม MQTT](../web/img/architecture.svg)

(ภาพเดียวกันอยู่ในแท็บ “ภาพรวมระบบ” ของเว็บ — ไฟล์ต้นฉบับ `web/img/architecture.svg`)

```
                         ┌───────────────────────────────────────────┐
                         │        Web App (static HTML/JS)           │
                         │  ┌───────────┐ ┌───────────┐ ┌──────────┐ │
                         │  │ Dashboard │ │ Provision │ │ Flasher  │ │
                         │  │ (mqtt.js) │ │(WebSerial)│ │(esptool- │ │
                         │  │           │ │           │ │   js)    │ │
                         │  └─────┬─────┘ └─────┬─────┘ └────┬─────┘ │
                         └────────┼─────────────┼────────────┼───────┘
                    MQTT over     │             │   USB      │  USB
                    WebSocket     │             │ (115200)   │ (ROM bootloader,
                    ws:// / wss://│             │ JSON lines │  921600)
                                  ▼             ▼            ▼
                     ┌────────────────────┐   ┌───────────────────────┐
                     │  Mosquitto broker  │   │   ESP32-DevKitC (USB) │
                     │  :1883  (TCP)      │◄──┤   Firmware            │
                     │  :9001  (WS)       │   │   - WiFi STA          │
                     │  auth + ACL        │──►│   - PubSubClient      │
                     └────────────────────┘   │   - NVS (Preferences) │
                          ▲  MQTT/TCP 1883    │   - Relay x8          │
                          │                   └───────────┬───────────┘
                     อุปกรณ์อื่นๆ /                        │ GPIO
                     Home Assistant /                     ▼
                     Node-RED (ทางเลือก)          [ Relay module ] ─► โหลด AC/DC
```

**หลักการ:** เว็บไม่มี backend ของตัวเอง — broker คือ "แหล่งความจริง" (retained messages) ทำให้ระบบเรียบง่าย ทุก client เห็นสถานะเดียวกัน และเพิ่ม client อื่น (Home Assistant, Node-RED, มือถือ) ได้ทันที

### 2.1 สาม flow หลัก

**(A) Control flow**
```
User คลิก  ─► Web publish  home/<id>/relay/3/set  "ON"   (QoS1, not retained)
            ─► Broker ─► ESP32 สั่ง GPIO, บันทึก NVS
            ─► ESP32 publish home/<id>/relay/3/state "ON" (QoS1, retained)
            ─► Broker ─► Web ทุกหน้าที่เปิดอยู่ อัปเดต UI
```
UI แสดงสถานะ "pending" ระหว่างรอ state จริง (ไม่ optimistic) → ถ้าบอร์ดไม่ตอบใน 3 วินาที แสดง timeout

**(B) Provisioning flow (USB)**
```
Web ─ requestPort() ─► open 115200 ─► {"cmd":"info"}  ─► บอร์ดตอบ {"ok":true,"info":{...}}
    ─► {"cmd":"scan"} ─► รายชื่อ SSID
    ─► {"cmd":"set_config", ...} ─► บอร์ดเขียน NVS ─► {"ok":true} ─► reboot ─► online ใน MQTT
```

**(C) Flash flow (USB)**
```
Web ─ requestPort() ─► esptool-js: DTR/RTS reset เข้า ROM bootloader ─► sync ─► detect chip
    ─► (option) erase flash ─► write images @offsets ─► verify ─► hard reset
```

---

## 3. Deep Dive

### 3.1 MQTT Topic Contract

`<base>` ค่าเริ่มต้น = `home`, `<id>` ค่าเริ่มต้น = `esp32-XXXXXX` (3 byte ท้ายของ MAC)

| Topic | ทิศทาง | Payload | QoS | Retain | หมายเหตุ |
|---|---|---|---|---|---|
| `<base>/<id>/status` | ESP→ | `online` / `offline` | 1 | ✔ | `offline` ตั้งเป็น **LWT** |
| `<base>/<id>/info` | ESP→ | JSON: `{id, fw, chip, mac, ip, relays:[{ch,gpio}]}` | 1 | ✔ | ใช้สำหรับ auto-discovery |
| `<base>/<id>/relay/<n>/state` | ESP→ | `ON` / `OFF` | 1 | ✔ | n = 1..8 |
| `<base>/<id>/relay/<n>/set` | →ESP | `ON` / `OFF` / `TOGGLE` | 1 | ✘ | **ห้าม retain** (กันสั่งซ้ำตอน reconnect) |
| `<base>/<id>/telemetry` | ESP→ | JSON: `{rssi, uptime, heap, ip}` | 0 | ✘ | ทุก 30 วินาที |
| `<base>/<id>/cmd` | →ESP | `reboot` / `ping` / `all_off` | 1 | ✘ | คำสั่งระดับอุปกรณ์ |
| `<base>/<id>/schedule/set` | →ESP | JSON array ของ rule (ดู §3.8) | 1 | ✘ | แทนที่ตารางเวลาทั้งหมด |
| `<base>/<id>/schedule` | ESP→ | `{tz, time, rules:[…]}` | 1 | ✔ | ตารางเวลาที่ใช้งานจริง; ถ้าคำสั่งผิดจะส่งแบบไม่ retain พร้อม `error` |

Discovery: เว็บ subscribe `<base>/+/info` และ `<base>/+/status` → ได้รายการบอร์ดทั้งหมดทันทีจาก retained messages

**ลบบอร์ดออกจากระบบ:** publish payload ว่าง (retained) ไปที่ `info`, `status`, `relay/+/state` เว็บมีปุ่ม "Forget" ทำให้

### 3.2 Serial Provisioning Protocol (115200 8N1, newline-delimited JSON)

ทุกคำสั่งคือ JSON 1 บรรทัด, ทุกคำตอบคือ JSON 1 บรรทัดที่ขึ้นต้นด้วย `{` ; บรรทัดอื่นถือเป็น log

| Request | Response |
|---|---|
| `{"cmd":"info"}` | `{"ok":true,"type":"info","info":{fw,chip,mac,id,wifi_ssid,mqtt_host,mqtt_port,base,active_low,wifi:"connected"/...,ip,mqtt:bool}}` |
| `{"cmd":"scan"}` | `{"ok":true,"type":"scan","networks":[{"ssid","rssi","secure"}]}` |
| `{"cmd":"set_config","wifi_ssid":..,"wifi_pass":..,"mqtt_host":..,"mqtt_port":1883,"mqtt_user":..,"mqtt_pass":..,"device_id":..,"base":..,"active_low":true}` | `{"ok":true,"type":"set_config"}` แล้ว reboot |
| `{"cmd":"set_config","relay_pins":[16,17,32],"tz":"ICT-7"}` | เลือกขารีเลย์เอง (1–15 ขาจาก safe list) และ timezone — ขาที่ไม่ปลอดภัยถูกปฏิเสธก่อนบันทึก |
| `{"cmd":"set_schedule","rules":[…]}` | `{"ok":true,"type":"set_schedule","count":N}` |
| `{"cmd":"relay","ch":1,"state":"TOGGLE"}` | `{"ok":true,"type":"relay","ch":1,"state":"ON"}` (ทดสอบสายไฟก่อนติดตั้ง) |
| `{"cmd":"reboot"}` / `{"cmd":"factory_reset"}` | `{"ok":true,...}` |

- รหัสผ่านถูกเขียนลง NVS แต่ **ไม่เคยถูกส่งกลับ** ใน `info` (ส่งแค่ `has_wifi_pass:true`)
- ฟิลด์ที่ไม่ส่งมาใน `set_config` = คงค่าเดิม (partial update) — เปลี่ยนแค่ broker ได้โดยไม่ต้องกรอก Wi-Fi ใหม่

### 3.3 Firmware Design (Arduino-ESP32 บน PlatformIO)

```
setup():  load NVS → init relays (restore saved mask, ก่อนเปิด Wi-Fi) → WiFi.begin
loop():   serialTask()  ─ อ่าน JSON line, ไม่ block
          wifiTask()    ─ state machine + backoff 1s→30s
          mqttTask()    ─ reconnect backoff, client.loop()
          buttonTask()  ─ GPIO0 ค้าง 5s → factory reset
          telemetryTask() ทุก 30s
          esp_task_wdt_reset()
```
- **Task WDT** 15 วินาที — ถ้า loop ค้างบอร์ดรีบูตเอง
- **NVS** (`Preferences`, namespace `cfg` และ `relay`) — บันทึก relay mask เฉพาะเมื่อเปลี่ยน (flash wear ต่ำ)
- รีเลย์ถูกตั้งค่า output **ก่อน** Wi-Fi เพื่อไม่ให้โหลดกระพริบตอนบูต
- ถ้ายังไม่มี config Wi-Fi → บอร์ดรออยู่ใน "provisioning mode" และพิมพ์ hint ทาง serial

### 3.4 Pin Assignment (ESP32-WROOM-32D) — ผ่าน `validate_pinmap.py` แล้ว ✔

ตั้งแต่ v1.0.6 เลือกขาเองได้จากรูปบอร์ดในแท็บ “ตั้งค่าบอร์ด (USB)” — เฉพาะขาใน safe list:
`4, 13, 14, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33` (14 = PWM สั้น ๆ ตอนบูต, 21/22 = I²C ปกติ)
เฟิร์มแวร์ตรวจซ้ำและปฏิเสธขาอื่น; เปลี่ยนขาแล้วสถานะรีเลย์ทุกช่องเริ่มที่ OFF. ตารางด้านล่างคือค่าเริ่มต้น:

| Channel | GPIO | เหตุผล |
|---|---|---|
| Relay 1 | 16 | ว่างบน WROOM (ไม่มี PSRAM) |
| Relay 2 | 17 | ว่างบน WROOM |
| Relay 3 | 18 | ไม่ใช่ strapping |
| Relay 4 | 19 | ไม่ใช่ strapping |
| Relay 5 | 23 | ไม่ใช่ strapping |
| Relay 6 | 25 | ไม่ใช่ strapping |
| Relay 7 | 26 | ไม่ใช่ strapping |
| Relay 8 | 27 | ไม่ใช่ strapping |
| Factory reset | 0 (ปุ่ม BOOT) | อ่านหลังบูตเท่านั้น — strapping pin แต่ปลอดภัย |

**จงใจเลี่ยง:**
- **GPIO 6–11** — ต่อกับ SPI flash (ใช้แล้วชิปค้าง)
- **GPIO 12** — MTDI strapping: ถ้าเป็น HIGH ตอนบูต flash จะถูกตั้งเป็น 1.8 V → บูตไม่ขึ้น
- **GPIO 0, 2, 5, 15** — strapping; โมดูลรีเลย์ active-low มัก pull-up ขา IN อาจทำให้บูตผิดโหมด
- **GPIO 34–39** — input only
- **GPIO 21/22** — เว้นไว้สำหรับ I²C (เซนเซอร์ในอนาคต)
- **GPIO 1/3** — UART0 ใช้สำหรับ provisioning

**ข้อควรระวังด้านไฟฟ้า:** ใช้โมดูลรีเลย์ที่มี optocoupler + transistor driver (ESP32 ห้ามขับคอยล์ตรง: GPIO ≤ 40 mA, แนะนำ ≤ 20 mA) และจ่ายไฟคอยล์ 5 V แยกจาก 3V3 ของบอร์ด, ต่อ GND ร่วม งานไฟ 220 VAC ต้องให้ช่างไฟฟ้าตรวจและมีกล่องปิดมิดชิด

### 3.5 Flash Layout (Arduino-ESP32, default partitions 4 MB)

| Image | Offset |
|---|---|
| `bootloader.bin` | `0x1000` |
| `partitions.bin` | `0x8000` |
| `boot_app0.bin` | `0xE000` |
| `firmware.bin` | `0x10000` |
| หรือ `merged.bin` (รวมทั้งหมด) | `0x0` |

`firmware/merge_bin.py` (extra_script) สร้าง `merged.bin` ให้อัตโนมัติหลัง build → ผู้ใช้เลือกไฟล์เดียวในหน้า Flasher

### 3.6 Web App Design

| โมดูล | Library | ความรับผิดชอบ |
|---|---|---|
| `js/mqtt-dashboard.js` | mqtt.js 5 (CDN) | connect/auth, discovery, render cards, publish commands, pending/timeout |
| `js/provision.js` | Web Serial API | line reader, JSON request/response แบบ promise + timeout, ฟอร์ม config, scan Wi-Fi, serial console |
| `js/flasher.js` | esptool-js 0.4 (CDN, ESM) | เลือกไฟล์ + offset, erase, write + progress, reset |
| `js/util.js` (`serialLock`) | — | กันไม่ให้ Provision และ Flasher เปิดพอร์ตเดียวกันพร้อมกัน + helper ร่วม |

State ฝั่งเว็บ: ค่าการเชื่อมต่อ broker เก็บใน `localStorage` (รหัสผ่านจะเก็บเฉพาะเมื่อผู้ใช้ติ๊ก "จำรหัสผ่าน"), ชื่อเล่นของรีเลย์เก็บใน `localStorage` ต่อ browser

### 3.7 Deployment profiles

| Profile | Web | Broker | ESP32 ↔ broker | Web ↔ broker |
|---|---|---|---|---|
| **Cloud (แนะนำ, ใช้ได้ทุกที่)** | GitHub Pages (`https://`), CI build เฟิร์มแวร์ + `manifest.json` (SHA-256) | HiveMQ Cloud / EMQX Cloud | MQTTS 8883, ตรวจ root CA (`ca_bundle.h`) + NTP | WSS 8884 `/mqtt` |
| LAN | `http://localhost` | Mosquitto (Docker) | MQTT 1883 | WS 9001 |

ขั้นตอนนำขึ้นเว็บ: [DEPLOY.md](DEPLOY.md)

### 3.8 Schedules (ตั้งเวลาเปิด-ปิด)

ตารางเวลาเก็บใน NVS และ**ทำงานบนบอร์ด** (ไม่ต้องเปิดเว็บ/ไม่ต้องมี server)

```json
[{"ch":1,"t":"18:30","a":"ON","d":127,"en":true},
 {"ch":1,"t":"23:00","a":"OFF","d":62,"en":true}]
```
| field | ความหมาย |
|---|---|
| `ch` | ช่องรีเลย์ 1..N |
| `t` | เวลาท้องถิ่น `HH:MM` |
| `a` | `ON` / `OFF` |
| `d` | bitmask วัน: bit0 = อาทิตย์ … bit6 = เสาร์ (127 = ทุกวัน, 62 = จ–ศ, 65 = ส–อา) |
| `en` | เปิด/ปิด rule นั้น |

- สูงสุด 20 rule; เวลาท้องถิ่นจาก NTP + POSIX TZ (`ICT-7` = ประเทศไทย) ตั้งในแท็บตั้งค่าบอร์ด
- ตรวจทุกนาที — rule ที่ตรงกับวันและ `HH:MM` จะสั่ง `setRelay` (log `[schedule]`) และ publish `/state` เหมือนสั่งจาก MQTT
- ถ้าบอร์ดยังไม่ได้เวลา (ยังไม่ต่อเน็ต) จะไม่ทำงานตามเวลา จนกว่า NTP จะซิงก์ — หลังไฟดับสถานะรีเลย์มาจาก NVS (`restore_state`)
- ทางเลือกที่ไม่ได้เลือก: ให้เว็บหรือ server เป็นตัวจับเวลา → ต้องเปิดค้างไว้ตลอด / ต้องมี backend

---

## 4. Scale & Reliability

| ประเด็น | การออกแบบ |
|---|---|
| Load | 50 บอร์ด × (telemetry 1 msg/30s + state change) ≈ < 5 msg/s → Mosquitto ตัวเดียวบน Raspberry Pi รับได้สบาย (รองรับหลักหมื่น msg/s) |
| Broker ล่ม | บอร์ดคงสถานะรีเลย์เดิม, reconnect เอง; เว็บแสดง "Disconnected" และ reconnect อัตโนมัติ |
| Wi-Fi หลุด | backoff 1→30 s; ไม่ reboot วนเพื่อไม่ให้รีเลย์กระพริบ |
| ไฟดับ | relay mask อยู่ใน NVS → กลับมาสถานะเดิม (ปรับเป็น "OFF ทุกช่องตอนบูต" ได้ด้วย `restore_state:false`) |
| คำสั่งซ้ำ / ซ้อน | `set` ไม่ retain, state เป็น idempotent (`ON` ซ้ำ = ไม่มีผล) |
| Monitoring | `status` LWT + telemetry; ต่อยอดได้ด้วย Telegraf → InfluxDB → Grafana โดย subscribe `<base>/+/telemetry` |

---

## 5. Security

1. Mosquitto: `allow_anonymous false` + `password_file` + ACL แยกสิทธิ์ (บอร์ดเขียนได้เฉพาะ topic ของตัวเอง, ผู้ใช้เว็บสั่ง `set` ได้)
2. นอก LAN: ใช้ `wss://` ผ่าน reverse proxy (Nginx/Caddy + Let's Encrypt) และ MQTT TLS port 8883 สำหรับบอร์ด
3. Provisioning ทาง USB ต้องเข้าถึงตัวบอร์ดทางกายภาพ = trust boundary ที่ชัดเจน (ไม่มี SoftAP เปิดค้าง)
4. หน้าเว็บไม่มี secret ฝังในโค้ด

---

## 6. Trade-off Analysis

| การตัดสินใจ | เลือก | ทางเลือกอื่น | เหตุผล / สิ่งที่ยอมเสีย |
|---|---|---|---|
| Transport ควบคุม | **MQTT ผ่าน broker** | HTTP REST บน ESP32 โดยตรง | Pub/Sub, หลาย client, LWT, ทำงานข้าม NAT ได้ / ยอมต้องมี broker 1 ตัว |
| Backend เว็บ | **ไม่มี (static)** | Node.js + DB | ง่าย, ไม่มี server ให้ดูแล / ไม่มีประวัติ, schedule, user management ในตัว |
| Provisioning | **USB Web Serial** | SoftAP captive portal, BLE (Improv) | ปลอดภัย, ไม่ต้องสลับ Wi-Fi มือถือ, ใช้ได้กับขั้นตอนแฟลชในหน้าเดียวกัน / ต้องเสียบ USB และใช้ Chrome/Edge |
| Firmware framework | **Arduino-ESP32 (PlatformIO)** | ESP-IDF ล้วน | เร็ว, lib พร้อม (PubSubClient, ArduinoJson) / ควบคุม low-level ได้น้อยกว่า, binary ใหญ่กว่าเล็กน้อย |
| Flasher | **esptool-js** | ESP Web Tools (web component) | ควบคุม offset/erase เองได้, รับ .bin จากผู้ใช้ / ต้องเขียน UI เอง |
| UI state | **รอ state จริง** | Optimistic update | สถานะบนจอตรงกับของจริงเสมอ / ช้ากว่า ~ 1 RTT |

---

## 7. สิ่งที่ควรกลับมาทบทวนเมื่อระบบโตขึ้น

1. **> 50 บอร์ด หรือหลายผู้ใช้/หลายบ้าน** → เพิ่ม backend (auth, RBAC, ประวัติการสั่ง, schedule) และย้าย topic เป็น `<tenant>/<site>/<id>/...`
2. **OTA ผ่าน Wi-Fi** → ใช้ `HTTPUpdate` + topic `<base>/<id>/ota` (URL + SHA256) เพื่อไม่ต้องเสียบ USB ทุกครั้ง; ต้องเปลี่ยน partition เป็น OTA สองช่อง (default ของ Arduino มีแล้ว)
3. **Home Assistant** → publish MQTT Discovery (`homeassistant/switch/<id>_<n>/config`)
4. **Broker HA** → EMQX/HiveMQ cluster หรือ managed broker เมื่อ downtime ยอมรับไม่ได้
5. **Secure Boot + Flash Encryption** สำหรับผลิตภัณฑ์จริง (หมายเหตุ: เปิดแล้วจะแฟลชผ่าน esptool-js แบบ plain ไม่ได้)
6. **Provisioning ไร้สาย** → เพิ่ม Improv-BLE / ESP-Touch สำหรับผู้ใช้ทั่วไปที่ไม่มีคอมพิวเตอร์
