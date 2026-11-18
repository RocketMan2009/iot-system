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
    $('mqtt-connect').disabled = true;
    $('mqtt-disconnect').disabled = false;
    c.subscribe([`${base}/+/info`, `${base}/+/status`, `${base}/+/relay/+/state`, `${base}/+/telemetry`, `${base}/+/schedule`], { qos: 1 });
    monitorFilter = null;
    subscribeMonitor($('mon-filter').value.trim() || '#');
    updateScheduleButtons();
  }));
  c.on('reconnect', current(() => setPill($('mqtt-status'), 'Reconnecting…', 'busy')));
  c.on('offline', current(() => setPill($('mqtt-status'), 'Offline', 'err')));
  c.on('error', current(err => { setPill($('mqtt-status'), 'Error', 'err'); toast(`MQTT: ${err.message}`, 5000); }));
  c.on('close', current(() => setPill($('mqtt-status'), 'Disconnected', 'off')));
  c.on('message', current(onMessage));
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
  syncScheduleDevices();
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
// Rule format shared with firmware: { ch, t: "HH:MM", a: "ON"|"OFF", d: weekday bitmask (bit0 = Sunday), en }
const DAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
let schedId = '';
let draft = [];
let dirty = false;
let saveTimer = null;

function initSchedule() {
  $('sched-device').addEventListener('change', e => {
    if (dirty && !confirm('ยังไม่ได้บันทึกการแก้ไข — ทิ้งการแก้ไขแล้วเปลี่ยนบอร์ด?')) { e.target.value = schedId; return; }
    selectScheduleDevice(e.target.value);
  });
  $('sched-add').addEventListener('click', () => {
    const last = draft[draft.length - 1];
    draft.push({ ch: last?.ch || 1, t: last ? last.t : '18:00', a: last?.a === 'ON' ? 'OFF' : 'ON', d: 127, en: true });
    markDirty();
    renderScheduleRows();
  });
  $('sched-save').addEventListener('click', saveSchedule);
  $('sched-revert').addEventListener('click', () => selectScheduleDevice(schedId));
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
  // info may arrive after the first schedule render (support check depends on it)
  const d = devices.get(schedId);
  if (d && !dirty && $('sched-rows').dataset.supported !== String(scheduleSupported(d))) renderScheduleRows();
  updateScheduleButtons();
}

function selectScheduleDevice(id) {
  schedId = id;
  dirty = false;
  draft = structuredClone(devices.get(id)?.schedule?.rules || []);
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
    toast(`บันทึกตารางเวลาแล้ว (${sch.rules.length} รายการ) ✔`);
    dirty = false;
  }
  if (sch.error) return;                  // someone else's rejected attempt
  if (!dirty) {
    draft = structuredClone(sch.rules || []);
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
  $('sched-add').disabled = !ok || draft.length >= 20;
  $('sched-save').disabled = !ok || !dirty || !!saveTimer;
  $('sched-revert').disabled = !dirty;
  $('sched-status').replaceChildren(dirty ? el('span', { class: 'dirty-dot' }, '● ยังไม่ได้บันทึก') : '');
}

function renderClock() {
  const d = devices.get(schedId);
  const time = d?.telemetry?.time || d?.schedule?.time;
  const tz = d?.schedule?.tz || d?.info?.tz;
  $('sched-clock').textContent = !d || !scheduleSupported(d) ? ''
    : time ? `เวลาบนบอร์ด ${time} (${tz})` : `บอร์ดยังไม่ได้ซิงก์เวลา (${tz || '—'})`;
}

function renderScheduleRows() {
  const body = $('sched-rows');
  const d = devices.get(schedId);
  body.dataset.supported = String(scheduleSupported(d));
  updateScheduleButtons();
  const message = text => body.replaceChildren(el('tr', {}, el('td', { colspan: 6, class: 'sched-empty' }, text)));
  if (!d) return message('เชื่อมต่อ broker และเลือกบอร์ด');
  if (!scheduleSupported(d))
    return message(`เฟิร์มแวร์บนบอร์ดนี้ (v${d.info?.fw || '?'}) ยังไม่รองรับการตั้งเวลา — ไปแท็บ “แฟลชเฟิร์มแวร์” แล้วกด “แฟลชเลย”`);
  if (!draft.length) return message('ยังไม่มีตารางเวลา — กด “+ เพิ่มเวลา”');

  const relays = d.info?.relays?.length ? d.info.relays : [{ ch: 1 }];
  body.replaceChildren(...draft.map((r, i) => {
    const update = patch => { Object.assign(draft[i], patch); markDirty(); };
    const setDays = mask => { update({ d: mask }); renderScheduleRows(); };
    const dayBtns = DAYS.map((label, bit) => el('button', {
      type: 'button',
      'aria-pressed': String(!!(r.d & (1 << bit))),
      title: label,
      onclick: () => {
        const next = r.d ^ (1 << bit);
        if (!next) return toast('ต้องเลือกอย่างน้อย 1 วัน');
        setDays(next);
      },
    }, label));
    const label = x => {
      const n = names[`${schedId}/${x.ch}`];
      return `CH${x.ch}${x.gpio != null ? ` · GPIO${x.gpio}` : ''}${n ? ` · ${n}` : ''}`;
    };
    const chSel = el('select', { onchange: e => update({ ch: Number(e.target.value) }) },
      relays.map(x => el('option', { value: x.ch }, label(x))));
    chSel.value = r.ch;
    const actSel = el('select', { onchange: e => update({ a: e.target.value }) },
      el('option', { value: 'ON' }, 'เปิด (ON)'), el('option', { value: 'OFF' }, 'ปิด (OFF)'));
    actSel.value = r.a;
    const en = el('input', { type: 'checkbox', 'aria-label': 'ใช้งาน', onchange: e => update({ en: e.target.checked }) });
    en.checked = r.en !== false;
    return el('tr', {},
      el('td', {}, en),
      el('td', {}, chSel),
      el('td', {}, el('input', { type: 'time', value: r.t, required: true, onchange: e => update({ t: e.target.value }) })),
      el('td', {}, actSel),
      el('td', {}, el('div', { class: 'days' }, dayBtns),
        el('div', { class: 'row', style: 'margin-top:4px;gap:4px' },
          el('button', { type: 'button', class: 'copy', onclick: () => setDays(127) }, 'ทุกวัน'),
          el('button', { type: 'button', class: 'copy', onclick: () => setDays(62) }, 'จ–ศ'),
          el('button', { type: 'button', class: 'copy', onclick: () => setDays(65) }, 'ส–อา'))),
      el('td', {}, el('button', {
        type: 'button', class: 'btn small danger', title: 'ลบ',
        onclick: () => { draft.splice(i, 1); markDirty(); renderScheduleRows(); },
      }, '✕')),
    );
  }));
}

function saveSchedule() {
  if (!client?.connected) return toast('ยังไม่ได้เชื่อมต่อ broker');
  const bad = draft.findIndex(r => !/^\d{2}:\d{2}$/.test(r.t || ''));
  if (bad >= 0) return toast(`แถวที่ ${bad + 1}: ใส่เวลาให้ครบ (HH:MM)`);
  const rules = draft.map(r => ({ ch: r.ch, t: r.t, a: r.a, d: r.d, en: r.en !== false }));
  client.publish(`${base}/${schedId}/schedule/set`, JSON.stringify(rules), { qos: 1 });
  saveTimer = setTimeout(() => {
    saveTimer = null;
    toast('บอร์ดไม่ตอบภายใน 5 วินาที — ตรวจว่าบอร์ดออนไลน์และใช้เฟิร์มแวร์ล่าสุด', 6000);
    updateScheduleButtons();
  }, 5000);
  updateScheduleButtons();
}
