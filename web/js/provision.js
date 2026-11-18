// USB provisioning over Web Serial. Protocol: docs/DESIGN.md §3.2 (newline-delimited JSON @115200)
import { toast, setPill, el, appendLog, serialLock, USB_SERIAL_FILTERS, portErrorHint } from './util.js';

const $ = id => document.getElementById(id);
const LOCK = 'ตั้งค่าบอร์ด';

let port = null;
let reader = null;
let readLoopDone = null;
const waiters = new Map();   // response type -> {resolve, reject, timer}
let lastInfo = null;

export function initProvision() {
  if (!('serial' in navigator)) {
    $('prov-connect').disabled = true;
    return;
  }
  $('prov-connect').addEventListener('click', connect);
  $('prov-disconnect').addEventListener('click', disconnect);
  $('prov-reset').addEventListener('click', resetBoard);
  $('prov-scan').addEventListener('click', scan);
  $('prov-factory').addEventListener('click', factoryReset);
  $('prov-clear').addEventListener('click', () => $('prov-log').replaceChildren());
  $('prov-filter-mqtt').addEventListener('change', e => $('prov-log').classList.toggle('only-mqtt', e.target.checked));
  $('prov-form').addEventListener('submit', e => { e.preventDefault(); saveConfig(); });
  // 8883 = MQTTS by convention: tick TLS automatically, 1883 = plain
  const pf = $('prov-form').elements;
  pf.mqtt_port.addEventListener('change', () => {
    if (pf.mqtt_port.value === '8883') pf.mqtt_tls.checked = true;
    if (pf.mqtt_port.value === '1883') pf.mqtt_tls.checked = false;
  });
  $('prov-send').addEventListener('submit', e => {
    e.preventDefault();
    const line = e.target.elements.line.value.trim();
    if (line) writeLine(line).catch(err => toast(err.message));
  });
  navigator.serial.addEventListener('disconnect', e => { if (e.target === port) cleanup('อุปกรณ์ถูกถอดออก'); });
}

// ---------- port lifecycle ----------
async function connect() {
  if (!serialLock.acquire(LOCK)) return;
  try {
    port = await navigator.serial.requestPort({ filters: USB_SERIAL_FILTERS });
    await port.open({ baudRate: 115200, bufferSize: 8192 });
    // DTR=RTS=false => EN high, IO0 high on DevKitC auto-reset circuit (normal run mode)
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  } catch (err) {
    serialLock.release(LOCK);
    port = null;
    if (err.name !== 'NotFoundError') {
      const hint = portErrorHint(err);
      toast(`เปิดพอร์ตไม่ได้: ${hint}`, 9000);
      appendLog($('prov-log'), `! ${err.message}\n! ${hint}`, 'err');
    }
    return;
  }
  setPill($('prov-status'), 'Connected', 'on');
  $('prov-connect').disabled = true;
  $('prov-disconnect').disabled = false;
  $('prov-reset').disabled = false;
  readLoopDone = readLoop();
  await refreshInfo(3);
}

async function disconnect() {
  if (!port) return;
  try { await reader?.cancel(); } catch {}
  await readLoopDone?.catch(() => {});
  try { await port.close(); } catch {}
  cleanup();
}

function cleanup(msg) {
  port = null;
  reader = null;
  serialLock.release(LOCK);
  for (const [, w] of waiters) { clearTimeout(w.timer); w.reject(new Error('port closed')); }
  waiters.clear();
  setPill($('prov-status'), 'Not connected', 'off');
  $('prov-connect').disabled = false;
  $('prov-disconnect').disabled = true;
  $('prov-reset').disabled = true;
  $('prov-fields').disabled = true;
  $('prov-relays').replaceChildren(el('tr', {},
    el('td', { colspan: 7, class: 'muted' }, 'เชื่อมต่อบอร์ดผ่าน USB เพื่อดูผังขาและทดสอบรีเลย์')));
  if (msg) toast(msg);
}

async function readLoop() {
  const decoder = new TextDecoder();
  let buf = '';
  while (port?.readable) {
    reader = port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          onLine(line);
        }
        if (buf.length > 16384) buf = '';   // garbage (e.g. wrong baud rate / boot ROM output)
      }
    } catch (err) {
      appendLog($('prov-log'), `! read error: ${err.message}`, 'err');   // e.g. framing error: keep reading
    } finally {
      reader.releaseLock();
    }
  }
}

function onLine(line) {
  if (line.startsWith('{')) {
    let msg;
    try { msg = JSON.parse(line); } catch { appendLog($('prov-log'), line); return; }
    appendLog($('prov-log'), line, 'rx-json');
    const w = waiters.get(msg.type);
    if (w) { clearTimeout(w.timer); waiters.delete(msg.type); w.resolve(msg); }
    else if (msg.type === 'parse' || msg.type === 'unknown') {
      for (const [, w2] of waiters) { clearTimeout(w2.timer); w2.resolve(msg); }
      waiters.clear();
    }
  } else if (line.trim()) {
    appendLog($('prov-log'), ...describeLogLine(line));
  }
}

// Firmware log lines (see main.cpp):
//   "# mqtt rx home/esp32-x/relay/3/set = ON"      command received from the broker
//   "# relay CH3 GPIO18 -> ON (pin LOW, ...) [mqtt]" relay switched
//   "# mqtt tx home/esp32-x/relay/3/state = ON"    state published back
function describeLogLine(line) {
  let m;
  if ((m = line.match(/^# mqtt rx (\S+) = (.*)$/))) return [`◀ รับ  ${m[1]}  =  ${m[2]}`, 'mqtt-rx'];
  if ((m = line.match(/^# mqtt tx (\S+) = (.*)$/))) return [`▶ ส่ง  ${m[1]}  =  ${m[2]}`, 'mqtt-tx'];
  if ((m = line.match(/^# relay CH(\d+) GPIO(\d+) -> (ON|OFF)(.*)$/))) {
    setRowState(Number(m[1]), m[3] === 'ON');
    return [`● รีเลย์ CH${m[1]} → GPIO${m[2]}  ${m[3]}${m[4]}`, 'relay-ev'];
  }
  if ((m = line.match(/^# pinmap CH(\d+) -> GPIO(\d+) \((ON|OFF)\)$/))) {
    setRowState(Number(m[1]), m[3] === 'ON', false);
    return [`● ผังขา CH${m[1]} → GPIO${m[2]} (${m[3]})`, 'relay-ev'];
  }
  if (line.startsWith('# topics:')) return [line, 'mqtt-rx'];
  if (line.startsWith('# bad relay cmd')) return [line, 'err'];
  return [line];
}

async function writeLine(line, logAs = line) {
  if (!port?.writable) throw new Error('ยังไม่ได้เปิดพอร์ต');
  const writer = port.writable.getWriter();
  try {
    await writer.write(new TextEncoder().encode(line + '\n'));
    appendLog($('prov-log'), `> ${logAs}`, 'tx');
  } finally {
    writer.releaseLock();
  }
}

// Send a JSON command and resolve with the reply of the same "type". `logAs` = redacted copy for the console.
function request(obj, timeoutMs = 2500, logAs) {
  const type = obj.cmd;
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(type); reject(new Error(`timeout waiting for "${type}"`)); }, timeoutMs);
    waiters.set(type, { resolve, reject, timer });
    try { await writeLine(JSON.stringify(obj), logAs && JSON.stringify(logAs)); }
    catch (err) { clearTimeout(timer); waiters.delete(type); reject(err); }
  });
}

// ---------- features ----------
async function refreshInfo(retries = 1) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await request({ cmd: 'info' }, 2000);
      if (res.ok) { showInfo(res.info); return true; }
    } catch { /* board may still be booting */ }
    await sleep(800);
  }
  toast('บอร์ดไม่ตอบคำสั่ง info — ตรวจว่าแฟลชเฟิร์มแวร์ของโปรเจกต์นี้แล้ว');
  return false;
}

function showInfo(info) {
  lastInfo = info;
  const rows = [
    ['Chip', `${info.chip} rev ${info.rev} · ${info.flash_mb} MB`],
    ['Firmware', info.fw],
    ['MAC', info.mac],
    ['Device ID', info.device_id],
    ['Wi-Fi', `${info.wifi}${info.ip ? ` · ${info.ip} · ${info.rssi} dBm` : ''}`],
    ['MQTT', info.mqtt_host ? `${info.mqtt_host}:${info.mqtt_port} · ${info.mqtt ? 'connected' : 'not connected'}` : 'ยังไม่ตั้งค่า'],
  ];
  $('prov-info').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, String(v))]));

  const f = $('prov-form').elements;
  f.wifi_ssid.value = info.wifi_ssid || '';
  f.wifi_pass.value = '';
  f.wifi_pass.placeholder = info.has_wifi_pass ? '(เว้นว่าง = ใช้ค่าเดิม)' : '';
  f.mqtt_host.value = info.mqtt_host || '';
  f.mqtt_port.value = info.mqtt_port || 1883;
  f.mqtt_tls.checked = !!info.mqtt_tls;
  f.mqtt_user.value = info.mqtt_user || '';
  f.mqtt_pass.value = '';
  f.mqtt_pass.placeholder = info.has_mqtt_pass ? '(เว้นว่าง = ใช้ค่าเดิม)' : '';
  f.device_id.value = info.device_id || '';
  f.base.value = info.base || 'home';
  f.relay_count.value = info.relay_count || 8;
  f.active_low.checked = !!info.active_low;
  f.restore_state.checked = info.restore_state !== false;
  $('prov-fields').disabled = false;

  renderPinMap(info);
}

// Firmware default pin map (used when talking to firmware older than 1.0.3, which doesn't report it).
const DEFAULT_PINS = [16, 17, 18, 19, 23, 25, 26, 27];

// Where each GPIO sits on the ESP32-DevKitC V4 headers (pin 1 = end next to the 3V3 / GND corner,
// counted toward the USB connector). The number is also printed next to the pin on the board.
const DEVKITC_HEADER = {
  16: 'J3 ขาที่ 12 (ขวา)', 17: 'J3 ขาที่ 11 (ขวา)', 18: 'J3 ขาที่ 9 (ขวา)', 19: 'J3 ขาที่ 8 (ขวา)',
  23: 'J3 ขาที่ 2 (ขวา)', 25: 'J2 ขาที่ 9 (ซ้าย)', 26: 'J2 ขาที่ 10 (ซ้าย)', 27: 'J2 ขาที่ 11 (ซ้าย)',
};

function renderPinMap(info) {
  const count = info.relay_count || 8;
  const pins = info.relay_pins || DEFAULT_PINS.slice(0, count);
  const prefix = info.topic_prefix || `${info.base || 'home'}/${info.device_id}/`;
  const mask = info.relay_mask || 0;

  $('prov-relays').replaceChildren(...pins.map((gpio, i) => {
    const ch = i + 1;
    const topic = `${prefix}relay/${ch}/set`;
    const send = state => async () => {
      try {
        const res = await request({ cmd: 'relay', ch, state });
        if (!res.ok) toast(res.error || 'error');
        else setRowState(ch, res.state === 'ON');
      } catch (err) { toast(err.message); }
    };
    return el('tr', { 'data-ch': ch },
      el('td', {}, el('b', {}, `CH${ch}`)),
      el('td', { class: 'gpio' }, `GPIO${gpio}`),
      el('td', {}, `ขา “${gpio}” · ${DEVKITC_HEADER[gpio] || '—'}`),
      el('td', {}, `IN${ch} ของโมดูลรีเลย์`),
      el('td', { class: 'topic' }, topic,
        el('button', { class: 'copy', title: 'คัดลอก topic', onclick: () => navigator.clipboard?.writeText(topic).then(() => toast(`คัดลอก ${topic}`)) }, '⧉')),
      el('td', { class: 'state' }),
      el('td', {},
        el('div', { class: 'row' },
          el('button', { class: 'btn small', onclick: send('ON') }, 'ON'),
          el('button', { class: 'btn small', onclick: send('OFF') }, 'OFF'))),
    );
  }));
  pins.forEach((_, i) => setRowState(i + 1, !!(mask & (1 << i)), false));
}

function setRowState(ch, on, flash = true) {
  const row = $('prov-relays').querySelector(`tr[data-ch="${ch}"]`);
  if (!row) return;
  const cell = row.querySelector('.state');
  cell.textContent = on ? '● ON' : '○ OFF';
  cell.className = `state ${on ? 'state-on' : 'state-off'}`;
  if (flash) { row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
}

async function scan() {
  const btn = $('prov-scan');
  btn.disabled = true;
  btn.textContent = 'กำลังสแกน…';
  try {
    const res = await request({ cmd: 'scan' }, 15000);
    const nets = (res.networks || [])
      .filter(n => n.ssid)
      .sort((a, b) => b.rssi - a.rssi)
      .filter((n, i, arr) => arr.findIndex(x => x.ssid === n.ssid) === i);
    $('ssid-list').replaceChildren(...nets.map(n => el('option', { value: n.ssid }, `${n.rssi} dBm${n.secure ? ' 🔒' : ''}`)));
    toast(`พบ ${nets.length} เครือข่าย — คลิกช่อง SSID เพื่อเลือก`);
    $('prov-form').elements.wifi_ssid.focus();
  } catch (err) {
    toast(`สแกนไม่สำเร็จ: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'สแกน';
  }
}

async function saveConfig() {
  const form = $('prov-form');
  if (!form.reportValidity()) return;
  const f = form.elements;
  const payload = {
    cmd: 'set_config',
    wifi_ssid: f.wifi_ssid.value.trim(),
    mqtt_host: f.mqtt_host.value.trim(),
    mqtt_port: Number(f.mqtt_port.value) || 1883,
    mqtt_tls: f.mqtt_tls.checked,
    mqtt_user: f.mqtt_user.value.trim(),
    device_id: f.device_id.value.trim(),
    base: f.base.value.trim().replace(/\/+$/, '') || 'home',
    relay_count: Number(f.relay_count.value) || 8,
    active_low: f.active_low.checked,
    restore_state: f.restore_state.checked,
  };
  // empty password fields = keep the value already stored on the board
  if (f.wifi_pass.value) payload.wifi_pass = f.wifi_pass.value;
  if (f.mqtt_pass.value) payload.mqtt_pass = f.mqtt_pass.value;
  if (!payload.device_id) delete payload.device_id;

  // never echo passwords into the console log
  const shown = { ...payload };
  if (shown.wifi_pass) shown.wifi_pass = '***';
  if (shown.mqtt_pass) shown.mqtt_pass = '***';

  $('prov-fields').disabled = true;
  try {
    const res = await request(payload, 3000, shown);
    if (!res.ok) throw new Error(res.error || 'board rejected config');
    toast('บันทึกแล้ว — บอร์ดกำลังรีบูต…');
    await sleep(4000);
    await refreshInfo(4);
    await sleep(6000);           // give Wi-Fi + MQTT time to come up, then show the result
    await refreshInfo(1);
  } catch (err) {
    toast(`บันทึกไม่สำเร็จ: ${err.message}`, 5000);
    $('prov-fields').disabled = false;
  }
}

async function factoryReset() {
  if (!confirm('ล้างค่าทั้งหมดในบอร์ด (Wi-Fi, MQTT, สถานะรีเลย์)?')) return;
  try {
    await request({ cmd: 'factory_reset' });
    toast('Factory reset แล้ว — บอร์ดกำลังรีบูต');
    await sleep(3000);
    await refreshInfo(4);
  } catch (err) { toast(err.message); }
}

async function resetBoard() {
  if (!port) return;
  // RTS asserted => EN low (reset); DTR deasserted => IO0 high (normal boot)
  await port.setSignals({ dataTerminalReady: false, requestToSend: true });
  await sleep(120);
  await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  appendLog($('prov-log'), '# reset pulse sent', 'tx');
  await sleep(1500);
  await refreshInfo(3);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
