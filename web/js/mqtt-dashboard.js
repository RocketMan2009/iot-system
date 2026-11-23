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
  $('mon-form').addEventListener('submit', e => { e.preventDefault(); subscribeMonitor($('mon-filter').value.trim() || '#'); });
  $('mon-clear').addEventListener('click', () => $('mon-log').replaceChildren());
  initSchedule();
  setInterval(() => devices.size && render(), 15000);   // refresh "last seen" texts

  // Reconnect automatically with the saved settings, so the page is live right after a reload.
  // A username without a remembered password can't connect: point the user at the password box.
  renderScheduleRows();
  if (saved.url && (saved.password || !saved.username)) connect(form);
  else if (saved.url) setPill($('mqtt-status'), 'ใส่รหัสผ่านแล้วกดเชื่อมต่อ', 'busy');
}

// HiveMQ's copy buttons give "xxxx.hivemq.cloud:8884/mqtt" without a scheme, and people paste the
// MQTT URL / host instead of the WebSocket one. Turn all of those into a working wss:// URL.
export function normalizeWsUrl(value) {
  let s = (value || '').trim();
  if (!s) return s;
  s = s.replace(/^mqtts?:\/\//i, 'wss://');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = (location.protocol === 'https:' || /hivemq\.cloud/i.test(s) ? 'wss://' : 'ws://') + s;
  try {
    const u = new URL(s);
    if (/hivemq\.cloud$/i.test(u.hostname)) {
      return `wss://${u.hostname}:8884/mqtt`;   // the only WebSocket endpoint HiveMQ Cloud offers
    }
    return s;
  } catch {
    return s;
  }
}

function connect(form) {
  if (typeof mqtt === 'undefined') { toast('โหลดไลบรารี mqtt.js ไม่สำเร็จ (ตรวจอินเทอร์เน็ต)'); return; }
  const fixed = normalizeWsUrl(form.elements.url.value);
  if (fixed && fixed !== form.elements.url.value.trim()) {
    form.elements.url.value = fixed;
    toast(`ปรับ WebSocket URL ให้ถูกรูปแบบแล้ว: ${fixed}`, 5000);
  }
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
  notify('connecting');
  conn = { url: f.url, username: f.username, attempts: 0, error: '', authFailed: false };
  const c = mqtt.connect(f.url, {
    username: f.username || undefined,
    password: f.password || undefined,
    clientId: `web-${Math.random().toString(16).slice(2, 10)}`,
    clean: true,
    reconnectPeriod: 3000,
    connectTimeout: 8000,
    keepalive: 30,
  });
  client = c;

  // Events from a previous (replaced) client must not touch the UI: check `client === c`.
  const current = fn => (...args) => { if (client === c) fn(...args); };
  c.on('connect', current(() => {
    setPill($('mqtt-status'), 'Connected', 'on');
    notify('connected');
    $('mqtt-connect').disabled = true;
    $('mqtt-disconnect').disabled = false;
    c.subscribe([`${base}/+/info`, `${base}/+/status`, `${base}/+/relay/+/state`, `${base}/+/telemetry`, `${base}/+/schedule`], { qos: 1 });
    monitorFilter = null;
    subscribeMonitor($('mon-filter').value.trim() || '#');
    render();
    // retained info arrives within a moment; if nothing came, say so instead of waiting silently
    setTimeout(current(() => { if (!devices.size) render(); }), 3000);
  }));
  c.on('reconnect', current(() => {
    conn.attempts++;
    setPill($('mqtt-status'), `Reconnecting… (${conn.attempts})`, 'busy');
    render();
  }));
  c.on('offline', current(() => setPill($('mqtt-status'), 'Offline', 'err')));
  c.on('error', current(err => {
    conn.error = err.message || String(err);
    // CONNACK 4 = bad username/password, 5 = not authorized: retrying can't fix it, so stop
    if (err.code === 4 || err.code === 5 || /not authori[sz]ed|bad user ?name or password/i.test(conn.error)) {
      conn.authFailed = true;
      c.end(true);
      setPill($('mqtt-status'), 'Username / Password ผิด', 'err');
    } else {
      setPill($('mqtt-status'), 'Error', 'err');
    }
    toast(`MQTT: ${explainError(conn)}`, 7000);
    notify('error', { error: conn.error });
    render();
  }));
  c.on('close', current(() => {
    if (!conn.authFailed) setPill($('mqtt-status'), conn.attempts ? `ติดต่อไม่ได้ — ลองใหม่ (${conn.attempts})` : 'Disconnected', 'off');
    render();
    notify('closed');
  }));
  c.on('message', current(onMessage));
}

// ---------- connection diagnostics ----------
let conn = { url: '', username: '', attempts: 0, error: '', authFailed: false };

/** Things in the settings that are certainly wrong, in plain Thai. */
function settingProblems({ url, username }) {
  const out = [];
  let u = null;
  try { u = new URL(url); } catch { out.push('WebSocket URL ไม่ถูกรูปแบบ — ตัวอย่างที่ถูก: wss://abc123.s1.eu.hivemq.cloud:8884/mqtt'); return out; }
  if (location.protocol === 'https:' && u.protocol !== 'wss:') out.push('ต้องขึ้นต้นด้วย wss:// (มี s)');
  if (/hivemq\.cloud$/i.test(u.hostname)) {
    if (u.port && u.port !== '8884') out.push(`พอร์ตต้องเป็น 8884 (ตอนนี้ ${u.port}) — 8883 เป็นของบอร์ด ไม่ใช่ของหน้าเว็บ`);
    if (!u.port) out.push('ต้องมี :8884 ต่อท้ายชื่อ cluster');
    if (u.pathname !== '/mqtt') out.push('ต้องลงท้ายด้วย /mqtt');
  }
  if (/@/.test(username || '')) out.push('Username เป็นอีเมล — ต้องใช้บัญชีที่สร้างใน HiveMQ → Access Management → Credentials ไม่ใช่ Gmail');
  if (!username) out.push('ยังไม่ได้ใส่ Username (HiveMQ Cloud ต้องมีบัญชีเสมอ)');
  return out;
}

/** Diagnosis box for a connection that is failing (null while it simply hasn't finished yet). */
function connectionDiag() {
  if (!client || client.connected) return null;
  const problems = settingProblems(conn);
  if (!conn.authFailed && !conn.error && !conn.attempts && !problems.length) return null;
  return el('div', { class: 'diag' },
    el('b', {}, conn.authFailed ? '✘ Username หรือ Password ไม่ถูกต้อง' : '✘ เชื่อมต่อ broker ไม่สำเร็จ'),
    el('p', { class: 'small-note' }, explainError(conn) || 'กำลังลองใหม่…'),
    problems.length ? el('ul', { class: 'diag-list' }, problems.map(p => el('li', {}, p))) : null,
    el('p', { class: 'small-note muted' }, 'URL ที่ใช้อยู่: ', el('code', {}, conn.url || '—'), ' · Username: ', el('code', {}, conn.username || '—')),
    el('p', { class: 'small-note muted' }, 'ตรวจได้ที่ console.hivemq.cloud → Manage Cluster: Overview (ชื่อ cluster) และ Access Management → Credentials (บัญชี)'),
  );
}

function explainError(c) {
  if (c.authFailed) return 'Username หรือ Password ไม่ถูกต้อง — ใช้บัญชีที่สร้างใน HiveMQ → Access Management → Credentials (ไม่ใช่อีเมล/รหัส Gmail)';
  if (c.error) return `${c.error}`;
  if (c.attempts) return 'ติดต่อ broker ไม่ได้ — ตรวจ WebSocket URL และอินเทอร์เน็ต';
  return '';
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

function onMessage(topic, payload, packet) {
  const text = payload.toString();
  logMonitor(topic, text, packet?.retain);

  // Everything below is device discovery/state, which only looks at our own base topic.
  if (!topic.startsWith(`${base}/`)) return;
  const rest = topic.slice(base.length + 1).split('/');   // [id, kind, ...]
  const [id, kind] = rest;
  if (!['info', 'status', 'telemetry', 'relay', 'schedule'].includes(kind)) return;
  if ((kind === 'relay' && rest[3] !== 'state') || (kind === 'schedule' && rest.length !== 2)) return;   // commands, not state

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
    if (id === schedId) renderClock();
  } else if (kind === 'schedule') {
    try { d.schedule = JSON.parse(text); } catch { return; }
    onScheduleMessage(id, d.schedule);
    return render();
  } else if (kind === 'relay' && rest[3] === 'state') {
    const ch = Number(rest[2]);
    d.states[ch] = text === 'ON';
    if (d.pending[ch]) { clearTimeout(d.pending[ch]); delete d.pending[ch]; }
  }
  render();
}

// ---------- MQTT monitor ----------
// Shows all traffic and checks command topics against discovered boards, so a command
// from an external app that the board never receives (wrong case, extra "/", other id) is obvious.
let monitorFilter = null;
const awaiting = new Map();   // "<prefix>/relay/<ch>" -> { note, t0, timer }
const lastState = new Map();  // "<prefix>/relay/<ch>" -> { text, t }
const VALID_CMD = /^(on|off|toggle|1|0|true|false)$/i;
let lastMsg = { key: '', t: 0 };

function subscribeMonitor(filter) {
  if (!client?.connected) return toast('ยังไม่ได้เชื่อมต่อ broker');
  if (monitorFilter && monitorFilter !== filter) client.unsubscribe(monitorFilter);
  monitorFilter = filter;
  client.subscribe(filter, { qos: 0 }, (err, granted) => {
    const denied = err || granted?.some(g => g.qos === 128);
    monitorNote(denied
      ? `✘ subscribe "${filter}" ไม่สำเร็จ — บัญชีนี้อาจไม่มีสิทธิ์ (permission) ลองใช้ "${base}/#"`
      : `✔ กำลังดูข้อความใน "${filter}"`, denied ? 'bad' : 'ok');
  });
}

function monitorNote(text, cls) {
  const log = $('mon-log');
  if (log.firstElementChild?.classList.contains('muted')) log.replaceChildren();
  log.append(el('div', { class: `mon-row` }, el('span', { class: 't' }, time()), el('span'), el('span', { class: `note ${cls}` }, text)));
  log.scrollTop = log.scrollHeight;
}

const time = () => new Date().toLocaleTimeString([], { hour12: false });

function logMonitor(topic, text, retained) {
  // overlapping subscriptions can deliver the same message twice
  const key = `${topic}\u0000${text}`;
  if (key === lastMsg.key && Date.now() - lastMsg.t < 50) return;
  lastMsg = { key, t: Date.now() };

  const isCmd = /\/relay\/[^/]*\/set\s*$/i.test(topic) || /\/(cmd|schedule\/set)\s*$/i.test(topic);
  const isState = /\/relay\/[^/]+\/state$/.test(topic);
  const note = isCmd ? checkCommand(topic, text) : null;
  if (isState && !retained) resolveAwaiting(topic, text);   // retained = old value, not a reply
  if ($('mon-pause').checked) return;

  const log = $('mon-log');
  if (log.firstElementChild?.classList.contains('muted')) log.replaceChildren();
  const row = el('div', { class: `mon-row ${isCmd ? 'cmd' : isState ? 'st' : ''}` },
    el('span', { class: 't' }, time()),
    el('span', { class: 'd' }, isCmd ? '◀' : isState ? '▶' : '·'),
    el('span', { class: 'msg' },
      el('span', { class: 'tp' }, topic), '  =  ',
      el('span', { class: 'p' }, text.length > 160 ? text.slice(0, 160) + '…' : text || '(ว่าง)'),
      retained ? el('span', { class: 'r' }, '  retained') : null),
    note?.el,
  );
  log.append(row);
  while (log.childElementCount > 400) log.firstElementChild.remove();
  const nearBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 80;
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

// Returns { el } with a verdict on whether a board will act on this command topic.
function checkCommand(topic, text) {
  const verdict = (msg, cls) => ({ el: el('span', { class: `note ${cls}` }, msg) });
  const known = [...devices.keys()].map(id => `${base}/${id}`);

  if (topic !== topic.trim()) return verdict('✘ topic มีช่องว่างหัว/ท้าย — บอร์ดจะไม่รับ', 'bad');
  if (topic.startsWith('/')) return verdict(`✘ ขึ้นต้นด้วย "/" เกินมา — ควรเป็น "${topic.slice(1)}"`, 'bad');
  if (/\/cmd$/i.test(topic)) return null;

  const m = topic.match(/^(.*)\/(relay)\/([^/]*)\/(set)$/i);
  if (!m) return null;
  const [, prefix, relayWord, ch, setWord] = m;
  if (relayWord !== 'relay' || setWord !== 'set') return verdict(`✘ ต้องเป็นตัวพิมพ์เล็ก "…/relay/${ch}/set"`, 'bad');

  if (!known.includes(prefix)) {
    const ci = known.find(k => k.toLowerCase() === prefix.toLowerCase());
    if (ci) return verdict(`✘ ตัวพิมพ์เล็ก/ใหญ่ไม่ตรง — ควรเป็น "${ci}/relay/${ch}/set"`, 'bad');
    if (!known.length) return verdict(`? ยังไม่พบบอร์ดใน "${base}/+/info" — ตรวจ Base topic ด้านบน`, 'wait');
    return verdict(`✘ ไม่มีบอร์ดที่ใช้ "${prefix}" — บอร์ดที่พบ: ${known.join(', ')}`, 'bad');
  }
  const d = devices.get(prefix.slice(base.length + 1));
  const count = d.info?.relays?.length || 8;
  if (!/^\d+$/.test(ch) || +ch < 1 || +ch > count) return verdict(`✘ ช่องรีเลย์ "${ch}" ไม่มี — ใช้ 1–${count}`, 'bad');
  if (!VALID_CMD.test(text.trim())) return verdict(`✘ payload "${text}" ไม่ถูกต้อง — ใช้ ON / OFF / TOGGLE`, 'bad');
  if (d.status !== 'online') return verdict('✘ topic ถูกต้อง แต่บอร์ดออฟไลน์อยู่', 'bad');

  const k = `${prefix}/relay/${ch}`;
  // the board's reply can beat the broker's echo of the command back to us
  const recent = lastState.get(k);
  if (recent && performance.now() - recent.t < 1500) return verdict(`✔ บอร์ดรับคำสั่งแล้ว → state = ${recent.text}`, 'ok');

  const v = verdict('… topic ถูกต้อง รอบอร์ดตอบ /state', 'wait');
  clearTimeout(awaiting.get(k)?.timer);
  awaiting.set(k, {
    note: v.el,
    t0: performance.now(),
    timer: setTimeout(() => {
      awaiting.delete(k);
      v.el.textContent = '✘ บอร์ดไม่ตอบใน 3 วินาที — บอร์ดอาจหลุด หรือใช้ firmware เก่า (ดู Serial Console)';
      v.el.className = 'note bad';
    }, PENDING_TIMEOUT_MS),
  });
  return v;
}

function resolveAwaiting(topic, text) {
  const k = topic.replace(/\/state$/, '');
  lastState.set(k, { text, t: performance.now() });
  const a = awaiting.get(k);
  if (!a) return;
  clearTimeout(a.timer);
  awaiting.delete(k);
  a.note.textContent = `✔ บอร์ดรับคำสั่งแล้ว → state = ${text} (${Math.round(performance.now() - a.t0)} ms)`;
  a.note.className = 'note ok';
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
  $('mqtt-diag')?.replaceChildren(...[connectionDiag()].filter(Boolean));
  syncScheduleDevices();
  if (client?.connected) notify('connected');
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
      el('span', {}, `เวลาบอร์ด ${t?.time ? t.time.slice(11, 16) : '—'}`),
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

// ---------- schedules (stored and executed on the board) ----------
// The board stores single actions: { ch, t: "HH:MM", a: "ON"|"OFF", d: weekday bitmask (bit0 = Sunday), en }.
// The editor shows *periods* instead — "turn CH1 on at 18:30 and off at 23:00 on these days" — and
// converts each period into (up to) two board rules. Overnight periods (off <= on) put the OFF rule
// on the following day, so "Mon 22:00 -> 06:00" switches off on Tuesday morning.
const DAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
const DAY_PRESETS = [[127, 'ทุกวัน'], [62, 'จ–ศ'], [65, 'ส–อา']];
const MAX_RULES = 20;
let schedId = '';
let draft = [];          // periods: { ch, on: "HH:MM"|"", off: "HH:MM"|"", d, en }
let dirty = false;
let saveTimer = null;

const nextDay = d => ((d << 1) | (d >> 6)) & 127;          // shift weekday mask by +1 day
const toMin = t => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
const overnight = p => p.on && p.off && toMin(p.off) <= toMin(p.on);

function periodsToRules(periods) {
  const rules = [];
  for (const p of periods) {
    const en = p.en !== false;
    if (p.on) rules.push({ ch: p.ch, t: p.on, a: 'ON', d: p.d, en });
    if (p.off) rules.push({ ch: p.ch, t: p.off, a: 'OFF', d: overnight(p) ? nextDay(p.d) : p.d, en });
  }
  return rules;
}

// Pair each ON rule with the OFF rule that ends the same period; anything left stays a one-sided period.
function rulesToPeriods(rules) {
  const used = new Set();
  const periods = [];
  rules.forEach((r, i) => {
    if (r.a !== 'ON') return;
    const on = toMin(r.t);
    let best = -1, bestGap = Infinity;
    rules.forEach((o, j) => {
      if (used.has(j) || o.a !== 'OFF' || o.ch !== r.ch || (o.en !== false) !== (r.en !== false)) return;
      const off = toMin(o.t);
      const sameDay = off > on && o.d === r.d;
      const nextDayOff = off <= on && o.d === nextDay(r.d);
      if (!sameDay && !nextDayOff) return;
      const gap = (off - on + 1440) % 1440 || 1440;
      if (gap < bestGap) { best = j; bestGap = gap; }
    });
    used.add(i);
    if (best >= 0) used.add(best);
    periods.push({ ch: r.ch, on: r.t, off: best >= 0 ? rules[best].t : '', d: r.d, en: r.en !== false });
  });
  rules.forEach((r, i) => {
    if (!used.has(i)) periods.push({ ch: r.ch, on: '', off: r.t, d: r.d, en: r.en !== false });
  });
  return periods.sort((a, b) => a.ch - b.ch || toMin(a.on || a.off) - toMin(b.on || b.off));
}

function daysText(d) {
  const preset = DAY_PRESETS.find(([m]) => m === d);
  if (preset) return preset[1];
  return DAYS.filter((_, i) => d & (1 << i)).join(', ');
}

function durationText(p) {
  const mins = (toMin(p.off) - toMin(p.on) + 1440) % 1440 || 1440;
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${h ? `${h} ชม.` : ''}${h && m ? ' ' : ''}${m ? `${m} นาที` : ''}`;
}

function chLabel(ch) {
  const n = names[`${schedId}/${ch}`];
  const gpio = devices.get(schedId)?.info?.relays?.find(r => r.ch === ch)?.gpio;
  return `CH${ch}${n ? ` “${n}”` : ''}${gpio != null ? ` (GPIO${gpio})` : ''}`;
}

function sentence(p) {
  const who = chLabel(p.ch);
  if (!p.on && !p.off) return 'ใส่เวลาเปิด หรือเวลาปิด อย่างน้อย 1 ช่อง';
  const when = daysText(p.d);
  if (p.on && p.off)
    return `${when}: เปิด ${who} เวลา ${p.on} แล้วปิดเวลา ${p.off}${overnight(p) ? ' ของวันถัดไป' : ''} — เปิดนาน ${durationText(p)}`;
  return p.on ? `${when}: เปิด ${who} เวลา ${p.on} (ไม่ปิดอัตโนมัติ)` : `${when}: ปิด ${who} เวลา ${p.off}`;
}

// 24-hour bar showing when the relay is on (two segments for overnight periods).
function timeBar(p) {
  const bar = el('div', { class: 'tbar', 'aria-hidden': 'true' },
    ...[0, 6, 12, 18].map(h => el('span', { class: 'tick', style: `left:${(h / 24) * 100}%` }, String(h).padStart(2, '0'))));
  const seg = (a, b) => bar.append(el('i', { style: `left:${(a / 1440) * 100}%;width:${((b - a) / 1440) * 100}%` }));
  const on = toMin(p.on), off = toMin(p.off);
  if (on != null && off != null) {
    if (off > on) seg(on, off); else { seg(on, 1440); seg(0, off); }
  } else if (on != null) {
    seg(on, 1440);
  }
  if (on != null) bar.append(el('b', { class: 'mark on', style: `left:${(on / 1440) * 100}%`, title: `เปิด ${p.on}` }));
  if (off != null) bar.append(el('b', { class: 'mark off', style: `left:${(off / 1440) * 100}%`, title: `ปิด ${p.off}` }));
  return bar;
}

function initSchedule() {
  $('sched-device').addEventListener('change', e => {
    if (dirty && !confirm('ยังไม่ได้บันทึกการแก้ไข — ทิ้งการแก้ไขแล้วเปลี่ยนบอร์ด?')) { e.target.value = schedId; return; }
    selectScheduleDevice(e.target.value);
  });
  $('sched-add').addEventListener('click', () => {
    const last = draft[draft.length - 1];
    draft.push({ ch: last ? Math.min(last.ch + 1, devices.get(schedId)?.info?.relays?.length || 1) : 1, on: '18:00', off: '22:00', d: 127, en: true });
    markDirty();
    renderScheduleRows();
    $('sched-rows').lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  $('sched-save').addEventListener('click', saveSchedule);
  $('sched-revert').addEventListener('click', () => selectScheduleDevice(schedId));
  window.addEventListener('beforeunload', e => { if (dirty) e.preventDefault(); });
}

const scheduleSupported = d => !!d?.info?.tz;   // firmware >= 1.0.6 reports its timezone

function syncScheduleDevices() {
  const sel = $('sched-device');
  const ids = [...devices.keys()].sort();
  const current = [...sel.options].map(o => o.value).filter(Boolean);
  if (ids.join() !== current.join()) {
    sel.replaceChildren(...(ids.length
      ? ids.map(id => el('option', { value: id }, id))
      : [el('option', { value: '' }, '— ยังไม่พบบอร์ด —')]));
    if (!ids.includes(schedId)) { dirty = false; schedId = ''; }
    sel.value = schedId || ids[0] || '';
    if (!schedId && ids[0]) selectScheduleDevice(ids[0]);
  }
  // info may arrive after the first render (the support check depends on it)
  const d = devices.get(schedId);
  if (!d) renderScheduleRows();   // keep the "why no board" help current with the connection state
  else if (!dirty && $('sched-rows').dataset.supported !== String(scheduleSupported(d))) renderScheduleRows();
  updateScheduleButtons();
}

function selectScheduleDevice(id) {
  schedId = id;
  dirty = false;
  draft = rulesToPeriods(devices.get(id)?.schedule?.rules || []);
  renderScheduleRows();
  renderClock();
}

function onScheduleMessage(id, sch) {
  if (id !== schedId) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (sch.error) {
      toast(`บอร์ดไม่รับตารางเวลา: ${sch.error}`, 6000);
      updateScheduleButtons();
      return;
    }
    toast('บันทึกตารางเวลาลงบอร์ดแล้ว ✔');
    dirty = false;
  }
  if (sch.error) return;                  // someone else's rejected attempt
  if (!dirty) {
    draft = rulesToPeriods(sch.rules || []);
    renderScheduleRows();
  }
  renderClock();
}

function markDirty() {
  dirty = true;
  updateScheduleButtons();
}

function updateScheduleButtons() {
  const d = devices.get(schedId);
  const ok = !!client?.connected && scheduleSupported(d);
  const ruleCount = periodsToRules(draft).length;
  $('sched-add').disabled = !ok || ruleCount > MAX_RULES - 2;
  $('sched-save').disabled = !ok || !dirty || !!saveTimer;
  $('sched-revert').disabled = !dirty;
  $('sched-status').replaceChildren(dirty ? el('span', { class: 'dirty-dot' }, '● ยังไม่ได้บันทึก — กด “บันทึกลงบอร์ด”') : '');
}

function renderClock() {
  const d = devices.get(schedId);
  const time = d?.telemetry?.time || d?.schedule?.time;
  const tz = d?.schedule?.tz || d?.info?.tz;
  $('sched-clock').textContent = !d || !scheduleSupported(d) ? ''
    : time ? `🕒 เวลาบนบอร์ด ${time.slice(11, 16)} (${tz})` : `บอร์ดยังไม่ได้ซิงก์เวลา (${tz || '—'})`;
}

function renderScheduleRows() {
  const list = $('sched-rows');
  const d = devices.get(schedId);
  list.dataset.supported = String(scheduleSupported(d));
  updateScheduleButtons();
  const message = text => list.replaceChildren(el('div', { class: 'sched-empty' }, text));
  if (!d) return list.replaceChildren(noBoardHelp());
  if (!scheduleSupported(d))
    return message(`เฟิร์มแวร์บนบอร์ดนี้ (v${d.info?.fw || '?'}) ยังไม่รองรับการตั้งเวลา — ไปแท็บ “แฟลชเฟิร์มแวร์” แล้วกด “แฟลชเลย”`);
  if (!draft.length) return message('ยังไม่มีการตั้งเวลา — กด “+ เพิ่มช่วงเวลา” เพื่อเริ่ม');

  const relays = d.info?.relays?.length ? d.info.relays : [{ ch: 1 }];
  list.replaceChildren(...draft.map((p, i) => {
    const text = el('p', { class: 'sched-sentence' }, sentence(p));
    const barWrap = el('div', {}, timeBar(p));
    const refresh = () => { text.textContent = sentence(p); barWrap.replaceChildren(timeBar(p)); };
    const update = patch => { Object.assign(p, patch); markDirty(); refresh(); };

    const chSel = el('select', { 'aria-label': 'ช่องรีเลย์', onchange: e => update({ ch: Number(e.target.value) }) },
      relays.map(x => el('option', { value: x.ch }, chLabel(x.ch))));
    chSel.value = p.ch;

    const timeField = (key, label, cls) => {
      const input = el('input', { type: 'time', value: p[key], 'aria-label': label, onchange: e => update({ [key]: e.target.value }) });
      const clear = el('button', {
        type: 'button', class: 'copy', title: `ไม่ใช้เวลา${label}`,
        onclick: () => { input.value = ''; update({ [key]: '' }); },
      }, 'ไม่ใช้');
      return el('label', { class: `tfield ${cls}` }, el('span', {}, label), el('div', { class: 'row' }, input, clear));
    };

    const dayBtns = el('div', { class: 'days' }, DAYS.map((label, bit) => el('button', {
      type: 'button', 'aria-pressed': String(!!(p.d & (1 << bit))), title: label,
      onclick: e => {
        const next = p.d ^ (1 << bit);
        if (!next) return toast('ต้องเลือกอย่างน้อย 1 วัน');
        update({ d: next });
        e.currentTarget.setAttribute('aria-pressed', String(!!(next & (1 << bit))));
      },
    }, label)));
    const presets = el('div', { class: 'row presets' }, DAY_PRESETS.map(([mask, label]) => el('button', {
      type: 'button', class: 'copy',
      onclick: () => {
        update({ d: mask });
        [...dayBtns.children].forEach((b, bit) => b.setAttribute('aria-pressed', String(!!(mask & (1 << bit)))));
      },
    }, label)));

    const en = el('input', { type: 'checkbox', onchange: e => { update({ en: e.target.checked }); item.classList.toggle('disabled', !e.target.checked); } });
    en.checked = p.en !== false;

    const item = el('div', { class: `sched-item${p.en === false ? ' disabled' : ''}` },
      el('div', { class: 'sched-top' },
        el('label', { class: 'check' }, en, 'ใช้งาน'),
        chSel,
        el('button', {
          type: 'button', class: 'btn small danger', title: 'ลบช่วงเวลานี้',
          onclick: () => { draft.splice(i, 1); markDirty(); renderScheduleRows(); },
        }, '✕ ลบ')),
      el('div', { class: 'sched-times' },
        timeField('on', 'เปิด', 'on'),
        el('span', { class: 'arrow' }, '→'),
        timeField('off', 'ปิด', 'off'),
        el('div', { class: 'sched-days' }, el('span', { class: 'muted' }, 'วัน'), dayBtns, presets)),
      barWrap,
      text,
    );
    return item;
  }));
}

// Explains exactly why no board is listed, with a jump to the broker settings.
function noBoardHelp() {
  const jump = el('button', {
    type: 'button', class: 'btn small',
    onclick: () => { $('mqtt-form').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('mqtt-form').elements.password.focus(); },
  }, '↑ ไปที่การตั้งค่า MQTT Broker');
  let title, detail;
  if (!client) {
    title = 'ยังไม่ได้เชื่อมต่อ broker';
    detail = 'กรอก WebSocket URL, Username, Password และ Base topic ในการ์ด “MQTT Broker” ด้านบน แล้วกด “เชื่อมต่อ” (ติ๊ก “จำรหัสผ่าน” เพื่อให้เชื่อมต่อเองครั้งหน้า)';
  } else if (!client.connected) {
    const box = connectionDiag();
    if (box) return el('div', { class: 'sched-empty' }, box, jump);
    title = 'กำลังเชื่อมต่อ broker…';
    detail = 'รอสักครู่…';
  } else {
    title = `เชื่อมต่อแล้ว แต่ไม่พบบอร์ดใน “${base}/+/info”`;
    detail = `ตรวจว่า Base topic ด้านบนตรงกับที่ตั้งในบอร์ดทุกตัวอักษร (ตัวพิมพ์ใหญ่-เล็กต่างกัน) — ดูค่าจริงได้ในแท็บ “ตั้งค่าบอร์ด (USB)” · ` +
      'และบอร์ดต้องต่อ broker ตัวเดียวกันอย่างน้อยหนึ่งครั้ง';
  }
  return el('div', { class: 'sched-empty' }, el('b', {}, title), el('p', { class: 'small-note' }, detail), jump);
}

function saveSchedule() {
  if (!client?.connected) return toast('ยังไม่ได้เชื่อมต่อ broker');
  const empty = draft.findIndex(p => !p.on && !p.off);
  if (empty >= 0) return toast(`ช่วงเวลาที่ ${empty + 1}: ใส่เวลาเปิด หรือเวลาปิด อย่างน้อย 1 ช่อง`);
  const rules = periodsToRules(draft);
  if (rules.length > MAX_RULES) return toast(`ตั้งได้สูงสุด ${MAX_RULES} คำสั่ง (ตอนนี้ ${rules.length})`);
  client.publish(`${base}/${schedId}/schedule/set`, JSON.stringify(rules), { qos: 1 });
  saveTimer = setTimeout(() => {
    saveTimer = null;
    toast('บอร์ดไม่ตอบภายใน 5 วินาที — ตรวจว่าบอร์ดออนไลน์และใช้เฟิร์มแวร์ล่าสุด', 6000);
    updateScheduleButtons();
  }, 5000);
  updateScheduleButtons();
}

// ---------- API for the setup wizard ----------
const watchers = new Set();
/** fn({ state: 'connecting'|'connected'|'error'|'closed', error?, devices }) on broker / device changes. */
export const onBrokerChange = fn => watchers.add(fn);
const notify = (state, extra = {}) => watchers.forEach(fn => fn({ state, devices, ...extra }));
export const getDevice = id => devices.get(id);
export const brokerConnected = () => !!client?.connected;
export const sendRelay = (id, ch, cmd) => send(id, ch, cmd);
/** Fills the broker form with these values and connects (same path as pressing "เชื่อมต่อ"). */
export function connectBroker({ url, username, password, base: b, remember = true }) {
  const f = $('mqtt-form').elements;
  f.url.value = url;
  f.username.value = username || '';
  f.password.value = password || '';
  f.base.value = b || 'home';
  f.remember.checked = remember;
  connect($('mqtt-form'));
}
