// MQTT dashboard: discovery + relay control. Topic contract: docs/DESIGN.md §3.1
import { toast, setPill, store, el, fmtUptime } from './util.js';

const PENDING_TIMEOUT_MS = 3000;

let client = null;
let base = 'home';
const devices = new Map();          // id -> { info, status, states:{}, telemetry, pending:{} }
const names = store('hub.names') || {};

const $ = id => document.getElementById(id);

export function initDashboard() {
  const form = $('mqtt-form');
  const saved = store('hub.mqtt') || {};
  for (const k of ['url', 'username', 'password', 'base']) if (saved[k]) form.elements[k].value = saved[k];
  form.elements.remember.checked = !!saved.password;
  // https pages can only reach brokers over wss:// (e.g. HiveMQ Cloud: wss://<cluster>:8884/mqtt)
  form.elements.url.placeholder = location.protocol === 'https:'
    ? 'wss://xxxx.s1.eu.hivemq.cloud:8884/mqtt'
    : 'ws://192.168.1.10:9001';
  if (!saved.url && location.protocol !== 'https:') form.elements.url.value = `ws://${location.hostname || 'localhost'}:9001`;

  form.addEventListener('submit', e => { e.preventDefault(); connect(form); });
  $('mqtt-disconnect').addEventListener('click', disconnect);
  setInterval(() => devices.size && render(), 15000);   // refresh "last seen" texts
}

function connect(form) {
  if (typeof mqtt === 'undefined') { toast('โหลดไลบรารี mqtt.js ไม่สำเร็จ (ตรวจอินเทอร์เน็ต)'); return; }
  const f = Object.fromEntries(new FormData(form));
  base = f.base.replace(/\/+$/, '');
  store('hub.mqtt', { url: f.url, username: f.username, base, password: f.remember ? f.password : '' });

  if (location.protocol === 'https:' && f.url.startsWith('ws://')) {
    toast('หน้าเว็บเป็น https:// ต้องใช้ wss:// (เบราว์เซอร์บล็อก ws://)', 5000);
    return;
  }
  disconnect();
  devices.clear();
  render();

  setPill($('mqtt-status'), 'Connecting…', 'busy');
  client = mqtt.connect(f.url, {
    username: f.username || undefined,
    password: f.password || undefined,
    clientId: `web-${Math.random().toString(16).slice(2, 10)}`,
    clean: true,
    reconnectPeriod: 3000,
    connectTimeout: 8000,
    keepalive: 30,
  });

  client.on('connect', () => {
    setPill($('mqtt-status'), 'Connected', 'on');
    $('mqtt-connect').disabled = true;
    $('mqtt-disconnect').disabled = false;
    client.subscribe([`${base}/+/info`, `${base}/+/status`, `${base}/+/relay/+/state`, `${base}/+/telemetry`], { qos: 1 });
  });
  client.on('reconnect', () => setPill($('mqtt-status'), 'Reconnecting…', 'busy'));
  client.on('offline', () => setPill($('mqtt-status'), 'Offline', 'err'));
  client.on('error', err => { setPill($('mqtt-status'), 'Error', 'err'); toast(`MQTT: ${err.message}`, 5000); });
  client.on('close', () => { if (client) setPill($('mqtt-status'), 'Disconnected', 'off'); });
  client.on('message', onMessage);
}

function disconnect() {
  if (client) { const c = client; client = null; c.end(true); }
  setPill($('mqtt-status'), 'Disconnected', 'off');
  $('mqtt-connect').disabled = false;
  $('mqtt-disconnect').disabled = true;
}

function dev(id) {
  if (!devices.has(id)) devices.set(id, { info: null, status: 'unknown', states: {}, telemetry: null, pending: {}, seen: 0 });
  return devices.get(id);
}

function onMessage(topic, payload) {
  const rest = topic.slice(base.length + 1).split('/');   // [id, kind, ...]
  const [id, kind] = rest;
  const text = payload.toString();

  // empty retained payload = device was "forgotten"
  if (text === '' && (kind === 'info' || kind === 'status')) {
    devices.delete(id);
    return render();
  }
  if (text === '') return;

  const d = dev(id);
  d.seen = Date.now();
  if (kind === 'info') {
    const firstSeen = !d.info;
    try { d.info = JSON.parse(text); } catch { return; }
    // telemetry isn't retained: ask a newly discovered board for a fresh sample
    if (firstSeen) client?.publish(`${base}/${id}/cmd`, 'ping', { qos: 0 });
  } else if (kind === 'status') {
    d.status = text;
  } else if (kind === 'telemetry') {
    try { d.telemetry = JSON.parse(text); } catch { return; }
  } else if (kind === 'relay' && rest[3] === 'state') {
    const ch = Number(rest[2]);
    d.states[ch] = text === 'ON';
    if (d.pending[ch]) { clearTimeout(d.pending[ch]); delete d.pending[ch]; }
  }
  render();
}

function send(id, ch, cmd) {
  if (!client?.connected) return toast('ยังไม่ได้เชื่อมต่อ broker');
  const d = dev(id);
  client.publish(`${base}/${id}/relay/${ch}/set`, cmd, { qos: 1, retain: false });
  clearTimeout(d.pending[ch]);
  d.pending[ch] = setTimeout(() => {
    delete d.pending[ch];
    toast(`${id} รีเลย์ ${ch}: บอร์ดไม่ตอบกลับภายใน ${PENDING_TIMEOUT_MS / 1000}s`);
    render();
  }, PENDING_TIMEOUT_MS);
  render();
}

function deviceCmd(id, cmd) {
  if (!client?.connected) return toast('ยังไม่ได้เชื่อมต่อ broker');
  client.publish(`${base}/${id}/cmd`, cmd, { qos: 1 });
  toast(`ส่ง "${cmd}" ไปยัง ${id}`);
}

function forget(id) {
  if (!confirm(`ลบ ${id} ออกจากระบบ? (ล้าง retained messages ของบอร์ดนี้)\nถ้าบอร์ดยังออนไลน์ จะกลับมาเองเมื่อเชื่อมต่อใหม่`)) return;
  const d = dev(id);
  const topics = ['info', 'status', ...Object.keys(d.states).map(ch => `relay/${ch}/state`)];
  for (const t of topics) client.publish(`${base}/${id}/${t}`, '', { qos: 1, retain: true });
  devices.delete(id);
  render();
}

function rename(id, ch) {
  const key = `${id}/${ch}`;
  const v = prompt(`ตั้งชื่อรีเลย์ ${ch} ของ ${id}`, names[key] || '');
  if (v === null) return;
  if (v.trim()) names[key] = v.trim(); else delete names[key];
  store('hub.names', names);
  render();
}

function ago(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

function render() {
  const wrap = $('devices');
  $('device-count').textContent = `${devices.size} บอร์ด`;
  wrap.replaceChildren();
  if (!devices.size) {
    wrap.append(el('div', { class: 'empty' }, client?.connected
      ? `ยังไม่พบบอร์ดใน "${base}/+/info" — ตรวจว่าบอร์ดตั้งค่า broker และ base topic ตรงกัน`
      : 'เชื่อมต่อ broker เพื่อค้นหาบอร์ดอัตโนมัติ'));
    return;
  }
  const ids = [...devices.keys()].sort();
  for (const id of ids) wrap.append(renderDevice(id, devices.get(id)));
}

function renderDevice(id, d) {
  const online = d.status === 'online';
  const relays = d.info?.relays?.length
    ? d.info.relays
    : Object.keys(d.states).map(ch => ({ ch: Number(ch) }));
  const t = d.telemetry;

  return el('div', { class: `card device ${online ? '' : 'offline'}` },
    el('div', { class: 'card-head' },
      el('h2', {}, id),
      el('span', { class: `pill ${online ? 'on' : d.status === 'offline' ? 'err' : 'off'}` }, online ? 'Online' : d.status === 'offline' ? 'Offline' : 'Unknown'),
    ),
    el('div', { class: 'meta' },
      el('span', {}, `IP ${t?.ip || d.info?.ip || '—'}`),
      el('span', {}, `RSSI ${t?.rssi ?? '—'} dBm`),
      el('span', {}, `Uptime ${t ? fmtUptime(t.uptime) : '—'}`),
      el('span', {}, `Heap ${t ? Math.round(t.heap / 1024) + ' KB' : '—'}`),
      el('span', {}, `FW ${d.info?.fw || '—'}`),
      el('span', {}, `Seen ${ago(d.seen)}`),
    ),
    el('div', { class: 'relays' }, relays.map(r => {
      const on = !!d.states[r.ch];
      const pending = !!d.pending[r.ch];
      const label = names[`${id}/${r.ch}`] || `รีเลย์ ${r.ch}`;
      return el('div', { class: 'relay' },
        el('div', { style: 'min-width:0' },
          el('span', { class: 'name', title: 'ดับเบิลคลิกเพื่อตั้งชื่อ', ondblclick: () => rename(id, r.ch) }, label),
          el('span', { class: 'gpio mono' }, r.gpio != null ? `CH${r.ch} · GPIO${r.gpio}` : `CH${r.ch}`),
        ),
        el('button', {
          class: `switch ${pending ? 'pending' : ''}`,
          role: 'switch',
          'aria-checked': String(on),
          'aria-label': label,
          disabled: !online || !client?.connected,
          onclick: () => send(id, r.ch, on ? 'OFF' : 'ON'),
        }),
      );
    })),
    el('div', { class: 'device-foot' },
      el('button', { class: 'btn small', disabled: !online, onclick: () => deviceCmd(id, 'all_off') }, 'ปิดทั้งหมด'),
      el('button', { class: 'btn small', disabled: !online, onclick: () => deviceCmd(id, 'ping') }, 'Refresh'),
      el('button', { class: 'btn small', disabled: !online, onclick: () => confirm(`รีบูต ${id}?`) && deviceCmd(id, 'reboot') }, 'รีบูต'),
      el('button', { class: 'btn small danger', onclick: () => forget(id) }, 'Forget'),
    ),
  );
}
