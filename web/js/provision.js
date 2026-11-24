// USB provisioning over Web Serial. Protocol: docs/DESIGN.md §3.2 (newline-delimited JSON @115200)
import { toast, setPill, el, appendLog, serialLock, USB_SERIAL_FILTERS, portErrorHint, store } from './util.js';
import { createPinPicker, headerPosition, DEFAULT_PINS } from './pin-picker.js';
import { getPins, setPins, onPins } from './pins-state.js';
import { renderWiring } from './wiring.js';

const $ = id => document.getElementById(id);
const LOCK = 'ตั้งค่าบอร์ด';

let port = null;
let reader = null;
let readLoopDone = null;
const waiters = new Map();   // response type -> {resolve, reject, timer}
let lastInfo = null;

export function initProvision() {
  initPicker();   // usable without a board, for planning the wiring
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
    syncPresetToHost();
  });
  initHostPresets();
  $('prov-send').addEventListener('submit', e => {
    e.preventDefault();
    const line = e.target.elements.line.value.trim();
    if (line) writeLine(line).catch(err => toast(err.message));
  });
  navigator.serial.addEventListener('disconnect', e => { if (e.target === port) cleanup('อุปกรณ์ถูกถอดออก'); });
}

// ---------- port lifecycle ----------
// opts.reuse: use a port this site was already allowed to open (no picker) — the wizard
// uses it right after flashing. A click event passed by the button is ignored.
async function connect(opts) {
  if (port) return true;
  if (!serialLock.acquire(LOCK)) return false;
  try {
    const granted = opts?.reuse === true ? await navigator.serial.getPorts() : [];
    port = granted.length === 1 ? granted[0] : await navigator.serial.requestPort({ filters: USB_SERIAL_FILTERS });
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
    return false;
  }
  setPill($('prov-status'), 'Connected', 'on');
  $('prov-connect').disabled = true;
  $('prov-disconnect').disabled = false;
  $('prov-reset').disabled = false;
  readLoopDone = readLoop();
  return refreshInfo(3);
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
  renderPickList();
  boardListeners.forEach(fn => fn(null));
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
  if ((m = line.match(/^# mqtt sub (\S+) (ok|FAILED)$/)))
    return [`◀ subscribe  ${m[1]}  ${m[2] === 'ok' ? '✔ (บอร์ดรอรับคำสั่งที่ topic นี้)' : '✘ FAILED — ตรวจสิทธิ์ (permission) ของบัญชีบอร์ดใน broker'}`, m[2] === 'ok' ? 'mqtt-rx' : 'err'];
  if (line.startsWith('# mqtt connected')) return [line, 'mqtt-tx'];
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
  boardListeners.forEach(fn => fn(info));
  const rows = [
    ['Chip', `${info.chip} rev ${info.rev} · ${info.flash_mb} MB`],
    ['Firmware', info.fw],
    ['MAC', info.mac],
    ['Device ID', info.device_id],
    ['Wi-Fi', `${WIFI_STATE[info.wifi] || info.wifi}${info.wifi === 'connected' && info.wifi_ssid ? ` “${info.wifi_ssid}”` : ''}${info.ip ? ` · ${info.ip} · ${info.rssi} dBm` : ''}`],
    ...(info.ap_ssid ? [['ตั้งค่าผ่านมือถือ', `Wi-Fi “${info.ap_ssid}” · รหัส ${info.ap_pass}${info.portal ? ' · เปิดอยู่' : ''}`]] : []),
    ['MQTT', info.mqtt_host ? `${info.mqtt_host}:${info.mqtt_port} · ${info.mqtt ? 'connected' : 'not connected'}` : 'ยังไม่ตั้งค่า'],
  ];
  $('prov-info').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', { 'data-k': k }, String(v))]));
  checkFirmwareVersion(info);

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
  f.tz.value = info.tz || 'ICT-7';
  f.active_low.checked = !!info.active_low;
  f.restore_state.checked = info.restore_state !== false;
  $('prov-fields').disabled = false;
  buildHostPresets();

  renderPinMap(info);
  syncPicker(info);
  renderSavedNets(info);
}

const WIFI_STATE = {
  connected: 'connected',
  portal: 'โหมดตั้งค่าผ่านมือถือ',
  unconfigured: 'ยังไม่ได้ตั้งค่า',
  auth_failed: 'รหัสผ่านผิด',
  ssid_not_found: 'หา Wi-Fi ไม่เจอ',
  connect_failed: 'ต่อไม่สำเร็จ',
  connecting: 'กำลังเชื่อมต่อ…',
};

// ---------- saved Wi-Fi networks (firmware with multi-network support) ----------
function renderSavedNets(info) {
  const box = $('prov-nets');
  const list = info.wifi_networks;
  box.hidden = !Array.isArray(list);
  if (box.hidden) return;
  const inUse = info.wifi === 'connected' ? info.wifi_ssid : null;
  const wifiCmd = async (obj, logAs, okMsg) => {
    try {
      const res = await request(obj, 3000, logAs);
      if (!res.ok) throw new Error(res.error || 'error');
      toast(okMsg);
      await refreshInfo(1);
    } catch (err) { toast(`ไม่สำเร็จ: ${err.message}`, 5000); }
  };
  const forget = ssid => () => {
    if (!confirm(`ลบ “${ssid}” ออกจากบอร์ด?${ssid === inUse ? '\n(กำลังใช้อยู่ — บอร์ดจะยังต่ออยู่จนกว่าจะหลุด)' : ''}`)) return;
    wifiCmd({ cmd: 'wifi_forget', ssid }, undefined, `ลบ “${ssid}” แล้ว`);
  };
  const addBackup = () => {
    const f = $('prov-form').elements;
    const ssid = f.wifi_ssid.value.trim();
    if (!ssid) return toast('พิมพ์หรือเลือกชื่อ Wi-Fi ในช่อง SSID ก่อน');
    if (f.wifi_pass.value && f.wifi_pass.value.length < 8) return toast('รหัส Wi-Fi ต้องยาว 8 ตัวขึ้นไป (หรือเว้นว่างถ้าไม่มีรหัส)');
    const obj = { cmd: 'wifi_add', ssid };
    if (f.wifi_pass.value || !list.includes(ssid)) obj.pass = f.wifi_pass.value;
    wifiCmd(obj, { ...obj, ...(obj.pass ? { pass: '***' } : {}) }, `เพิ่ม “${ssid}” แล้ว — บอร์ดจะใช้เมื่ออยู่ในที่ที่มี Wi-Fi นี้`);
  };
  const portal = () => wifiCmd({ cmd: 'portal' }, undefined,`เปิด Wi-Fi “${info.ap_ssid}” แล้ว — ใช้มือถือเชื่อมต่อ (รหัส ${info.ap_pass})`);

  box.replaceChildren(
    el('div', { class: 'saved-nets-head' }, `Wi-Fi ที่บอร์ดจำไว้ (${list.length}/${info.wifi_max || 5})`),
    list.length
      ? el('ul', {}, ...list.map(s => el('li', {},
          el('span', {}, s, s === inUse ? el('span', { class: 'pill on' }, 'กำลังใช้') : null),
          el('button', { type: 'button', class: 'btn small', title: 'ลบออกจากบอร์ด', onclick: forget(s) }, 'ลบ'))))
      : el('p', { class: 'muted' }, 'ยังไม่มี'),
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'btn small', onclick: addBackup }, '＋ เพิ่ม SSID ด้านบนเป็น Wi-Fi สำรอง'),
      info.ap_ssid ? el('button', { type: 'button', class: 'btn small', onclick: portal, disabled: !!info.portal }, '📱 เปิดตั้งค่าผ่านมือถือ') : null),
    el('p', { class: 'field-note' },
      'บอร์ดจะต่อ Wi-Fi ที่รู้จักและสัญญาณแรงที่สุดให้เอง — เพิ่ม Wi-Fi ของบ้าน ออฟฟิศ หรือ Hotspot มือถือไว้ล่วงหน้าได้ (ไม่รีบูต) · ',
      'ไปที่ใหม่ที่ไม่รู้จัก: รอ 1 นาทีหรือกดปุ่ม BOOT สั้นๆ แล้วใช้มือถือต่อ Wi-Fi ',
      el('b', {}, info.ap_ssid || 'PlugPilot-xxxxxx'), info.ap_pass ? ` (รหัส ${info.ap_pass})` : ''),
  );
}

// ---------- outdated firmware warning ----------
let latestManifest;   // promise, fetched once
const verNum = v => String(v).split(/[.-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
const isOlder = (a, b) => { const x = verNum(a), y = verNum(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]; return false; };

async function checkFirmwareVersion(info) {
  latestManifest ??= fetch('firmware/manifest.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  const latest = await latestManifest;
  // relay_pins arrived in 1.0.4 together with the MQTT rx/tx log — its absence means old firmware.
  const noMqttLog = !info.relay_pins;
  const behind = latest && !String(info.fw).includes('local') && isOlder(info.fw, latest.version);
  if (!noMqttLog && !behind) return;

  const msg = noMqttLog
    ? `เฟิร์มแวร์บนบอร์ด (v${info.fw}) เป็นรุ่นเก่า ยังไม่แสดง log MQTT ที่รับ/ส่ง ใน Serial Console`
    : `เฟิร์มแวร์บนบอร์ด v${info.fw} — มีรุ่นใหม่ v${latest.version}`;
  const dd = $('prov-info').querySelector('dd[data-k="Firmware"]');
  if (dd) dd.replaceChildren(`${info.fw} `, el('span', { class: 'warn-ink' }, `⚠ ${latest ? `มี v${latest.version} — ไปแท็บ “แฟลชเฟิร์มแวร์”` : 'รุ่นเก่า'}`));
  appendLog($('prov-log'), `! ${msg} → ไปแท็บ “แฟลชเฟิร์มแวร์” แล้วกด “แฟลชเลย” (ค่า Wi-Fi/MQTT ยังอยู่)`, 'err');
  toast(msg, 8000);
}

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
      el('td', {}, `ขา “${gpio}” · ${headerPosition(gpio) || '—'}`),
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
    $('ssid-list').replaceChildren(...nets.map(n => el('option', { value: n.ssid }, `${n.rssi} dBm${n.secure ? ' 🔒' : ''}${n.saved ? ' · จำไว้แล้ว' : ''}`)));
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
    tz: f.tz.value.trim() || 'ICT-7',
    active_low: f.active_low.checked,
    restore_state: f.restore_state.checked,
  };
  // empty password fields = keep the value already stored on the board
  if (f.wifi_pass.value) payload.wifi_pass = f.wifi_pass.value;
  if (f.mqtt_pass.value) payload.mqtt_pass = f.mqtt_pass.value;
  if (!payload.device_id) delete payload.device_id;
  if (lastInfo?.safe_pins) payload.relay_pins = picker.getPins();   // firmware >= 1.0.6
  if (payload.relay_pins && !payload.relay_pins.length) return toast('เลือกขารีเลย์อย่างน้อย 1 ขา');

  // never echo passwords into the console log
  const shown = { ...payload };
  if (shown.wifi_pass) shown.wifi_pass = '***';
  if (shown.mqtt_pass) shown.mqtt_pass = '***';

  $('prov-fields').disabled = true;
  try {
    const res = await request(payload, 3000, shown);
    if (!res.ok) throw new Error(res.error || 'board rejected config');
    if (payload.mqtt_host) rememberBroker({ host: payload.mqtt_host, port: payload.mqtt_port, tls: payload.mqtt_tls });
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

// ---------- relay pin picker ----------
let picker;

function initPicker() {
  picker = createPinPicker($('pin-picker'), { onChange: renderPickList });
  picker.setPins(getPins());                       // last selection in this browser
  onPins(pins => renderWiring($('pick-wiring'), pins));
  $('pick-default').addEventListener('click', () => { picker.setPins(DEFAULT_PINS); renderPickList(); });
  $('pick-clear').addEventListener('click', () => { picker.setPins([]); renderPickList(); });
  $('pick-save').addEventListener('click', savePins);
  renderPickList();
}

function renderPickList() {
  const pins = picker.getPins();
  setPins(pins);   // wiring diagrams (this tab + overview) follow the picker
  $('pick-count').textContent = `${pins.length} ช่อง`;
  $('pick-list').replaceChildren(...(pins.length
    ? pins.map((g, i) => el('li', {}, el('b', {}, `CH${i + 1}`), ` → GPIO${g}`, el('span', { class: 'muted' }, ` · ${headerPosition(g)}`)))
    : [el('li', { class: 'muted' }, 'ยังไม่ได้เลือก — คลิกขาสีเขียวบนรูป')]));
  const changed = lastInfo?.relay_pins && pins.join() !== lastInfo.relay_pins.join();
  $('pick-save').disabled = !port || !lastInfo?.safe_pins || !pins.length || !changed;
}

function syncPicker(info) {
  picker.setPins(info.relay_pins || DEFAULT_PINS.slice(0, info.relay_count || 8));
  $('pick-note').textContent = info.safe_pins
    ? 'เปลี่ยนขาแล้วบอร์ดจะรีบูต และรีเลย์ทุกช่องเริ่มที่ OFF'
    : `เฟิร์มแวร์บนบอร์ด (v${info.fw}) ยังเลือกขาเองไม่ได้ — แฟลชเฟิร์มแวร์ล่าสุดก่อน`;
  renderPickList();
}

async function savePins() {
  const pins = picker.getPins();
  if (!confirm(`บันทึกขารีเลย์ใหม่ ${pins.length} ช่อง (${pins.map((g, i) => `CH${i + 1}=GPIO${g}`).join(', ')}) แล้วรีบูตบอร์ด?`)) return;
  $('pick-save').disabled = true;
  try {
    const res = await request({ cmd: 'set_config', relay_pins: pins }, 3000);
    if (!res.ok) throw new Error(res.error || 'board rejected pins');
    toast('บันทึกขาแล้ว — บอร์ดกำลังรีบูต…');
    await sleep(4000);
    await refreshInfo(4);
  } catch (err) {
    toast(`บันทึกไม่สำเร็จ: ${err.message}`, 6000);
    renderPickList();
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

// ---------- MQTT host dropdown ----------
// One pick fills Host + Port + TLS. Sources: the broker the dashboard uses, the board's current
// broker, brokers saved recently from this browser, and a few public test brokers.
const RECENT_KEY = 'hub.recentBrokers';
const PUBLIC_NOTE = 'broker สาธารณะ: ใครก็อ่าน/สั่ง topic ได้ — ตั้ง Base topic ให้ไม่ซ้ำใคร และใช้ทดสอบเท่านั้น';
const PUBLIC_BROKERS = [
  { host: 'broker.hivemq.com', port: 1883, tls: false, label: 'HiveMQ Public — broker.hivemq.com' },
  { host: 'broker.emqx.io', port: 1883, tls: false, label: 'EMQX Public — broker.emqx.io' },
  { host: 'test.mosquitto.org', port: 1883, tls: false, label: 'Mosquitto Test — test.mosquitto.org' },
];
let presetOptions = [];

const isLocalHost = h => /^(localhost|127\.|0\.0\.0\.0$|::1$)/i.test(h);

// The dashboard talks WebSocket (8884 / 9001); the board talks plain MQTT on the same host.
function dashboardBroker() {
  const url = store('hub.mqtt')?.url;
  if (!url) return null;
  try {
    const u = new URL(url);
    const tls = u.protocol === 'wss:';
    return {
      host: u.hostname, port: tls ? 8883 : 1883, tls,
      label: `ใช้ร่วมกับแดชบอร์ด — ${u.hostname}`,
      note: tls ? 'บอร์ดใช้ MQTT over TLS พอร์ต 8883 (แดชบอร์ดใช้ WSS พอร์ต 8884 — broker เดียวกัน)'
                : 'บอร์ดใช้ MQTT พอร์ต 1883 (แดชบอร์ดใช้ WebSocket — broker เดียวกัน)',
    };
  } catch { return null; }
}

function rememberBroker(b) {
  const list = (store(RECENT_KEY) || []).filter(x => !(x.host === b.host && x.port === b.port));
  store(RECENT_KEY, [b, ...list].slice(0, 5));
}

function initHostPresets() {
  $('mqtt-preset').addEventListener('change', e => {
    const v = e.target.value;
    const f = $('prov-form').elements;
    if (v === 'custom') { f.mqtt_host.focus(); f.mqtt_host.select(); return syncPresetToHost(); }
    const o = presetOptions[Number(v)];
    if (!o) return;
    f.mqtt_host.value = o.host;
    f.mqtt_port.value = o.port;
    f.mqtt_tls.checked = !!o.tls;
    syncPresetToHost();
    if (o.public) f.base.focus();          // public broker: pick a unique base topic next
  });
  $('prov-form').elements.mqtt_host.addEventListener('input', syncPresetToHost);
  // A pasted URL ("…hivemq.cloud:8883", "wss://…:8884/mqtt") becomes host + port.
  // 8884 is HiveMQ's WebSocket port (for the dashboard); the board needs 8883.
  $('prov-form').elements.mqtt_host.addEventListener('change', () => {
    const f = $('prov-form').elements;
    const m = f.mqtt_host.value.trim().match(/^(?:([a-z]+):\/\/)?([^/:\s]+)(?::(\d+))?/i);
    if (!m) return;
    const [, scheme, host, port] = m;
    const changed = host !== f.mqtt_host.value.trim();
    f.mqtt_host.value = host;
    let p = port ? Number(port) : null;
    if (/^wss?$/i.test(scheme || '') || p === 8884) p = 8883;
    if (!p && /hivemq\.cloud$/i.test(host)) p = 8883;
    if (p) { f.mqtt_port.value = p; f.mqtt_tls.checked = p === 8883; }
    if (changed) toast(`ใช้ Host = ${host}${p ? `, Port = ${p}` : ''} ให้แล้ว`, 4000);
    syncPresetToHost();
  });
  // dashboard settings may change while the page is open
  document.querySelector('[data-tab="provision"]')?.addEventListener('click', buildHostPresets);
  buildHostPresets();
}

function buildHostPresets() {
  presetOptions = [];
  const add = (group, b) => {
    if (!b?.host || presetOptions.some(o => o.host === b.host && o.port === b.port)) return;
    presetOptions.push({ ...b, group });
  };
  add('แนะนำ', dashboardBroker());
  if (lastInfo?.mqtt_host)
    add('แนะนำ', { host: lastInfo.mqtt_host, port: lastInfo.mqtt_port || 1883, tls: !!lastInfo.mqtt_tls,
      label: `ค่าปัจจุบันในบอร์ด — ${lastInfo.mqtt_host}:${lastInfo.mqtt_port}`, note: 'ค่าที่บันทึกอยู่ในบอร์ดตอนนี้' });
  for (const b of store(RECENT_KEY) || [])
    add('ใช้ล่าสุด', { ...b, label: `${b.host} : ${b.port}${b.tls ? ' (TLS)' : ''}` });
  for (const b of PUBLIC_BROKERS) add('Broker สาธารณะ (ทดสอบเท่านั้น)', { ...b, public: true, note: PUBLIC_NOTE });

  const groups = new Map();
  presetOptions.forEach((o, i) => {
    if (!groups.has(o.group)) groups.set(o.group, []);
    groups.get(o.group).push(el('option', { value: String(i) }, o.label));
  });
  $('mqtt-preset').replaceChildren(
    el('option', { value: '' }, '— เลือก broker —'),
    ...[...groups].map(([label, opts]) => el('optgroup', { label }, opts)),
    el('option', { value: 'custom' }, '✎ กรอกเอง'),
  );
  $('mqtt-host-list').replaceChildren(...[...new Set(presetOptions.map(o => o.host))].map(h => el('option', { value: h })));
  syncPresetToHost();
}

// Keep the dropdown and the hint in step with whatever is typed in Host / Port.
function syncPresetToHost() {
  const f = $('prov-form').elements;
  const host = f.mqtt_host.value.trim();
  const port = Number(f.mqtt_port.value) || 1883;
  const idx = presetOptions.findIndex(o => o.host === host && Number(o.port) === port);
  $('mqtt-preset').value = idx >= 0 ? String(idx) : host ? 'custom' : '';
  const note = $('mqtt-preset-note');
  if (isLocalHost(host)) {
    note.textContent = '⚠ บอร์ดเชื่อมต่อ “localhost” ไม่ได้ — ใส่ IP ของเครื่องที่รัน broker เช่น 192.168.1.10';
    note.className = 'field-note warn';
  } else {
    const o = presetOptions[idx];
    note.textContent = o?.note || (host ? 'กรอกเอง — ตรวจ Port และช่อง TLS ให้ตรงกับ broker' : 'เลือกจากรายการ หรือพิมพ์ชื่อโฮสต์ / IP ของ broker');
    note.className = `field-note${o?.public ? ' warn' : ''}`;
  }
}

// ---------- API for the setup wizard ----------
const boardListeners = new Set();
/** fn(info) after every info refresh; fn(null) when the USB port closes. */
export const onBoard = fn => boardListeners.add(fn);
export const getBoardInfo = () => (port ? lastInfo : null);
/** Must be called from a click handler. Reuses an already-allowed port when possible. */
export const connectBoard = () => connect({ reuse: true });
export async function scanWifi() {
  const res = await request({ cmd: 'scan' }, 15000);
  return (res.networks || []).filter(n => n.ssid).sort((a, b) => b.rssi - a.rssi)
    .filter((n, i, arr) => arr.findIndex(x => x.ssid === n.ssid) === i);
}
/**
 * Sends a config to the board, waits for the reboot, then polls until Wi-Fi and MQTT are up
 * (or timeoutMs passes / Wi-Fi clearly failed). Resolves with the last info; onTick(info) gets every refresh.
 */
export async function applyBoardConfig(cfg, { timeoutMs = 40000, onTick } = {}) {
  const payload = { cmd: 'set_config', ...cfg };
  const shown = { ...payload };
  if (shown.wifi_pass) shown.wifi_pass = '***';
  if (shown.mqtt_pass) shown.mqtt_pass = '***';
  const res = await request(payload, 3000, shown);
  if (!res.ok) throw new Error(res.error || 'บอร์ดไม่รับค่าที่ส่งไป');
  if (cfg.mqtt_host) rememberBroker({ host: cfg.mqtt_host, port: cfg.mqtt_port, tls: cfg.mqtt_tls });
  await sleep(4000);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await request({ cmd: 'info' }, 2000);
      if (r.ok) {
        showInfo(r.info);
        onTick?.(r.info);
        if (r.info.wifi === 'connected' && r.info.mqtt) return r.info;
        if (r.info.wifi === 'auth_failed' || r.info.wifi === 'ssid_not_found') return r.info;
      }
    } catch { /* still booting */ }
    await sleep(2000);
  }
  return lastInfo;
}
