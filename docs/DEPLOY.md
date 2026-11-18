# นำขึ้นเว็บให้ทุกคนใช้ได้ — ไม่ต้องติดตั้งอะไรบนเครื่อง

ระบบจะใช้บริการฟรี 2 อย่าง ทุกขั้นตอนทำผ่านเบราว์เซอร์:

| ส่วน | บริการ | หน้าที่ |
|---|---|---|
| เว็บแอป + เฟิร์มแวร์ | **GitHub Pages** + **GitHub Actions** | โฮสต์เว็บบน `https://` และ build เฟิร์มแวร์ให้อัตโนมัติ (ไม่ต้องลง PlatformIO) |
| MQTT broker | **HiveMQ Cloud** (Serverless, ฟรี) — หรือ EMQX Cloud | ตัวกลางรับส่งคำสั่งระหว่างเว็บกับบอร์ด เข้าถึงได้จากทุกที่ |

```
 ผู้ใช้ (Chrome/Edge ที่ไหนก็ได้)
   │  https://<user>.github.io/<repo>/
   ▼
 GitHub Pages ── เว็บ + esp32dev-merged.bin (build โดย GitHub Actions)
   │
   │ wss://<cluster>.hivemq.cloud:8884/mqtt        mqtts://<cluster>.hivemq.cloud:8883
   └──────────────────────────► HiveMQ Cloud ◄────────────────────────── ESP32 (Wi-Fi บ้าน)
```

> ทำไมไม่ใช้ broker ในบ้าน: เว็บที่อยู่บน `https://` เชื่อมต่อได้เฉพาะ `wss://` (WebSocket ที่มี TLS) และ broker ต้องเข้าถึงได้จากอินเทอร์เน็ต — cloud broker ให้ทั้งสองอย่างโดยไม่ต้องเปิด port ที่เราเตอร์

---

## ขั้นที่ 1 — สร้าง MQTT broker (HiveMQ Cloud)

1. สมัครที่ https://console.hivemq.cloud → สร้าง cluster แบบ **Serverless (Free)**
2. จดค่าจากหน้า **Overview** ของ cluster:
   - **Host** เช่น `abc123.s1.eu.hivemq.cloud`
   - **Port 8883** = MQTT over TLS (สำหรับ ESP32)
   - **Port 8884** = WebSocket over TLS, path `/mqtt` (สำหรับเว็บ)
3. ไปที่ **Access Management → Credentials** สร้างบัญชี:
   - `webadmin` — ใช้ในหน้าแดชบอร์ด
   - บัญชีแยกต่อบอร์ด เช่น `esp32-a1b2c3` (แนะนำ — ถ้าบอร์ดหาย/ถูกขโมย เพิกถอนได้ทีละตัว)

## ขั้นที่ 2 — นำโค้ดขึ้น GitHub (ไม่ต้องใช้ git)

1. สมัคร/ล็อกอิน https://github.com → **New repository** → ตั้งชื่อ เช่น `esp32-control-hub` → เลือก **Public** (GitHub Pages ฟรีต้องเป็น public) → Create
2. ในหน้า repo กด **uploading an existing file** → ลากไฟล์และโฟลเดอร์ทั้งหมดในโปรเจกต์นี้ลงไป
   (`web/`, `firmware/`, `docs/`, `broker/`, `.github/`, `README.md`, `.gitignore`)
   - ⚠ Windows Explorer อาจซ่อนโฟลเดอร์ `.github` — เปิด *View → Hidden items* ก่อนลาก
   - ห้ามอัปโหลดไฟล์ `broker/passwd` (ถ้ามี) — มีรหัสผ่าน
3. **Settings → Pages → Build and deployment → Source: GitHub Actions**
4. ไปแท็บ **Actions** → workflow *Build firmware & deploy web* จะรันเอง (~3–5 นาที ครั้งแรก)
   ถ้ายังไม่รัน กด **Run workflow**
5. เสร็จแล้วได้ URL: `https://<username>.github.io/esp32-control-hub/`

ทุกครั้งที่แก้โค้ดใน repo (แก้ผ่านหน้าเว็บ GitHub ได้เลย) ระบบจะ build เฟิร์มแวร์เวอร์ชันใหม่ (`1.0.<เลขรอบ>`) และอัปเดตเว็บให้อัตโนมัติ

## ขั้นที่ 3 — ใช้งาน (ใครก็ได้ ที่ไหนก็ได้)

เปิด URL ด้วย **Chrome หรือ Edge** บนคอมพิวเตอร์

1. **แฟลชเฟิร์มแวร์** → เสียบ ESP32 → กด **แฟลชเลย (1 คลิก)** → เลือกพอร์ต COM
   (Windows ต้องมีไดรเวอร์ USB-UART: CP210x หรือ CH340 ตามชิปบนบอร์ด — Windows 11 มักลงให้เอง)
2. **ตั้งค่าบอร์ด (USB)** → เลือกพอร์ต → สแกน Wi-Fi แล้วกรอก:
   | ช่อง | ค่า |
   |---|---|
   | MQTT Host | `abc123.s1.eu.hivemq.cloud` |
   | MQTT Port | `8883` (ช่อง TLS จะติ๊กให้เอง) |
   | MQTT Username / Password | บัญชีของบอร์ดจากขั้นที่ 1 |
   → **บันทึกลงบอร์ด & รีบูต** → ข้อมูล MQTT ควรขึ้น `connected` ภายใน ~10 วินาที
3. **แดชบอร์ด** → WebSocket URL: `wss://abc123.s1.eu.hivemq.cloud:8884/mqtt` + บัญชี `webadmin` → เชื่อมต่อ

แดชบอร์ดใช้จากมือถือได้ด้วย (ส่วน USB ต้องใช้คอมพิวเตอร์ เพราะมือถือไม่รองรับ Web Serial)

---

## ความปลอดภัยเมื่อเปิดให้ทุกคนใช้

- หน้าเว็บ **ไม่มีรหัสผ่านหรือข้อมูลลับฝังอยู่** — ใครเปิดเว็บก็ควบคุมอะไรไม่ได้ จนกว่าจะมีบัญชี MQTT
- แต่ละคน/แต่ละบ้านควรมี **broker หรือบัญชีของตัวเอง** — คนที่ใช้ broker เดียวกันและสิทธิ์ครอบ `home/#` จะสั่งบอร์ดของกันและกันได้
  - ถ้าต้องใช้ cluster ร่วมกัน: ให้แต่ละคนใช้ **Base topic** ต่างกัน (เช่น `home-somchai`) และตั้ง permission ให้แต่ละบัญชีเข้าถึงได้เฉพาะ `<base>/#` ของตัวเอง (หน้า Access Management → Permissions ของ HiveMQ)
- “จำรหัสผ่านในเบราว์เซอร์นี้” เก็บใน localStorage ของเครื่องนั้น — อย่าติ๊กบนเครื่องสาธารณะ
- บอร์ดตรวจใบรับรอง TLS ของ broker ด้วย root CA ที่ฝังในเฟิร์มแวร์ (`firmware/src/ca_bundle.h`: Let's Encrypt ISRG X1/X2, DigiCert Global Root G2/CA) — ถ้าใช้ broker ที่ใช้ CA อื่น ต้องเพิ่ม root CA ในไฟล์นั้น

## แก้ปัญหา

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| แท็บ USB ขึ้นแถบเหลือง “ไม่รองรับ Web Serial” | ใช้ Chrome/Edge บนคอมพิวเตอร์ (Firefox/Safari/มือถือ ไม่รองรับ) |
| `Failed to open serial port` | พอร์ตถูกโปรแกรมอื่นจับไว้ — ปิด **Serial Monitor ของ Arduino IDE** (หรือปิด IDE), PlatformIO monitor, PuTTY หรือแท็บเบราว์เซอร์อื่นที่เปิดเว็บนี้ แล้วถอด-เสียบ USB |
| ไม่เห็นพอร์ต COM | สาย USB เป็นแบบชาร์จอย่างเดียว หรือยังไม่มีไดรเวอร์ CP210x/CH340 |
| แฟลชค้างที่ “Connecting” | กดปุ่ม BOOT ค้างตอนเริ่ม หรือลด baud rate เป็น 115200 |
| Serial log: `tls error ...` | ตรวจ host/port 8883 และว่าติ๊ก TLS; ถ้า broker ใช้ CA อื่นให้เพิ่มใน `ca_bundle.h` |
| `mqtt failed, rc=5` | username/password ของบอร์ดผิด |
| แดชบอร์ด Error ทันที | URL ต้องเป็น `wss://...:8884/mqtt` (มี `/mqtt` ท้าย) |
| ไม่มีกล่อง “เฟิร์มแวร์ล่าสุด” | workflow ใน Actions ยังไม่เสร็จหรือ build ล้มเหลว — ดู log ในแท็บ Actions |
