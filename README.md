<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="web/img/logo-dark.svg">
    <img src="web/img/logo-light.svg" alt="PlugPilot — MQTT · Web Serial · Browser Flasher" width="480">
  </picture>
</p>

# PlugPilot — ESP32 Control Hub

> **มือใหม่ เริ่มตรงนี้:** เปิด https://rocketman2009.github.io/iot-system/ แล้วทำตามแท็บ **★ เริ่มต้นใช้งาน**
> 6 ขั้น: เตรียมของ → สมัคร MQTT (ใช้ Gmail ได้) → ต่อสาย → ลงโปรแกรมบอร์ด → ตั้งค่า Wi-Fi → ทดลองเปิด-ปิด

เว็บแอปควบคุมอุปกรณ์ไฟฟ้าผ่าน **MQTT** + ตั้งค่าและ **แฟลช ESP32 ผ่านเบราว์เซอร์** (Web Serial / esptool-js)
บอร์ดเป้าหมาย: ESP32-DevKitC (ESP32-WROOM-32D)

รายละเอียดการออกแบบ: [docs/DESIGN.md](docs/DESIGN.md)

![สถาปัตยกรรม MQTT ของ PlugPilot](web/img/architecture.svg)

> **ไม่อยากติดตั้งอะไรบนเครื่อง?** นำขึ้น GitHub Pages + HiveMQ Cloud ให้ทุกคนใช้ผ่าน URL เดียว: [docs/DEPLOY.md](docs/DEPLOY.md)
> (GitHub Actions จะ build เฟิร์มแวร์ให้ และหน้าเว็บมีปุ่ม “แฟลชเลย (1 คลิก)”)
>
> ส่วนด้านล่างนี้เป็นการรันแบบ local ใน LAN

```
IoT System/
├── docs/DESIGN.md          System design (requirements, topics, protocol, trade-offs)
├── firmware/               PlatformIO project (Arduino-ESP32)
│   ├── platformio.ini
│   ├── merge_bin.py        สร้าง merged.bin หลัง build
│   └── src/main.cpp
├── web/                    Static web app (ไม่มี build step)
│   ├── index.html
│   ├── css/style.css
│   └── js/  app · mqtt-dashboard · provision · flasher · util
└── broker/                 Mosquitto (docker-compose, config, ACL)
```

## Quick start

### 1. Broker (Mosquitto)
ใช้ Docker:
```bash
cd broker
docker run --rm -v "$PWD:/m" eclipse-mosquitto:2.0.20 mosquitto_passwd -c -b /m/passwd webadmin <รหัสผ่าน>
docker compose up -d
```
เพิ่มผู้ใช้สำหรับบอร์ด (ชื่อผู้ใช้ = Device ID เพื่อให้ ACL จำกัดสิทธิ์เฉพาะ topic ของตัวเอง):
```bash
docker run --rm -v "$PWD:/m" eclipse-mosquitto:2.0.20 mosquitto_passwd -b /m/passwd esp32-a1b2c3 <รหัสผ่าน>
```
(ไม่มี Docker: ติดตั้ง Mosquitto for Windows แล้วใช้ `mosquitto.conf` เดียวกัน โดยแก้ path ของ `password_file`, `acl_file`, `persistence_location`)

### 2. Build เฟิร์มแวร์
```bash
cd firmware
pio run
```
ได้ไฟล์ `.pio/build/esp32dev/merged.bin` (แฟลชที่ 0x0)

### 3. เปิดเว็บ
ต้องเปิดผ่าน `http://localhost` หรือ `https://` (Web Serial ต้องการ secure context) ด้วย Chrome/Edge
```bash
python -m http.server 8080 --directory web
```
แล้วเปิด http://localhost:8080

### 4. ใช้งาน
1. **แฟลชเฟิร์มแวร์** → เลือก `merged.bin` → “เชื่อมต่อ & แฟลช” → เลือกพอร์ต COM ของบอร์ด
2. **ตั้งค่าบอร์ด (USB)** → “เลือกพอร์ต” → สแกน Wi-Fi → กรอก MQTT host (IP ของเครื่องที่รัน broker, port 1883) → บันทึก
3. **แดชบอร์ด** → ใส่ `ws://<broker-ip>:9001` + user/pass → เชื่อมต่อ → บอร์ดขึ้นมาเองอัตโนมัติ

## การต่อสาย (ค่าเริ่มต้น)

| Relay | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| GPIO | 16 | 17 | 18 | 19 | 23 | 25 | 26 | 27 |

- ใช้โมดูลรีเลย์ที่มี optocoupler/transistor driver, จ่ายไฟคอยล์ 5 V แยก, GND ร่วมกับ ESP32
- **ห้ามใช้** GPIO 6–11 (flash), GPIO 12 (strapping — บูตไม่ขึ้น), GPIO 34–39 (input only)
- กดปุ่ม **BOOT** ค้าง 5 วินาที (หลังบูตแล้ว) = factory reset
- งานไฟ 220 V ต้องติดตั้งในกล่องปิดมิดชิดและให้ช่างไฟฟ้าตรวจสอบ

## MQTT topics (สรุป)

| Topic | Payload |
|---|---|
| `home/<id>/relay/<n>/set` | `ON` / `OFF` / `TOGGLE` |
| `home/<id>/relay/<n>/state` | `ON` / `OFF` (retained) |
| `home/<id>/status` | `online` / `offline` (retained, LWT) |
| `home/<id>/info` | JSON (retained, ใช้ค้นหาบอร์ด) |
| `home/<id>/telemetry` | JSON ทุก 30 วินาที |
| `home/<id>/cmd` | `reboot` / `ping` / `all_off` |
| `home/<id>/schedule/set` | JSON ตารางเวลา เช่น `[{"ch":1,"t":"18:30","a":"ON","d":127,"en":true}]` |
| `home/<id>/schedule` | ตารางเวลาที่ใช้งานอยู่ + เวลาบนบอร์ด (retained) |

**ตั้งเวลาเปิด-ปิด:** แท็บแดชบอร์ด → การ์ด “ตั้งเวลาเปิด-ปิดอัตโนมัติ” — ตารางเวลาทำงานบนบอร์ดเอง ปิดเว็บก็ยังทำงาน
**เลือกขารีเลย์เอง:** แท็บตั้งค่าบอร์ด (USB) → คลิกขาสีเขียวบนรูป ESP32 (1–15 ขา) → บันทึกลงบอร์ด
**ผังการต่อวงจร:** แท็บภาพรวมระบบ (และใต้ตัวเลือกขา) วาดวงจร ESP32 → โมดูลรีเลย์ → ไฟบ้าน L/N ใหม่ทุกครั้งที่เปลี่ยนขา พร้อมตารางต่อสาย

ทดสอบจาก command line:
```bash
mosquitto_pub -h <broker> -u webadmin -P <pass> -t home/esp32-a1b2c3/relay/1/set -m TOGGLE
```
