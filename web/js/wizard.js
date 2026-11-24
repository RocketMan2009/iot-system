// "เริ่มต้นใช้งาน" — a step-by-step setup for people who have never done this before.
// Each step has one main action and says plainly what to do; it reuses the same flasher,
// USB provisioning and MQTT code as the advanced tabs.
import { el, toast, store } from './util.js';
import { flashLatest, onFlash, hasHostedFirmware } from './flasher.js';
import { connectBoard, onBoard, getBoardInfo, scanWifi, applyBoardConfig } from './provision.js';
import { connectBroker, onBrokerChange, brokerConnected, getDevice, sendRelay } from './mqtt-dashboard.js';
import { getPins, setPins } from './pins-state.js';
import { DEFAULT_PINS } from './pin-picker.js';
import { renderWiring } from './wiring.js';

const KEY = 'hub.wizard';
const STEPS = [
  { id: 'prep', title: 'เตรียมของ' },
  { id: 'broker', title: 'สมัครบริการ MQTT' },
  { id: 'wire', title: 'ต่อสาย' },
  { id: 'flash', title: 'ลงโปรแกรมบอร์ด' },
  { id: 'wifi', title: 'ตั้งค่า Wi-Fi' },
  { id: 'test', title: 'ทดลองเปิด-ปิด' },
];

let st = { step: 0, done: {}, host: '', webUser: '', boardUser: '', base: 'home', ...(store(KEY) || {}) };
let webPass = '';
let boardPass = '';
let root, showTab;
let ui = {};               // live elements of the step on screen (updated by events)
const save = () => store(KEY, st);
const isDone = id => !!st.done[id];
function markDone(id, value = true) { st.done[id] = value; save(); renderStepper(); }

// "abc.s1.eu.hivemq.cloud", "https://…/", "wss://…:8884/mqtt" -> "abc.s1.eu.hivemq.cloud"
const cleanHost = v => v.trim().replace(/^[a-z]+:\/\//i, '').replace(/[/:].*$/, '').toLowerCase();

export function initWizard(container, show) {
  root = container;
  showTab = show;
  // prefill from the dashboard if the user already connected once
  const saved = store('hub.mqtt') || {};
  if (!st.host && saved.url) { try { st.host = new URL(saved.url).hostname; } catch {} }
  if (!st.webUser && saved.username) st.webUser = saved.username;
  if (saved.base && st.base === 'home') st.base = saved.base;
  webPass = saved.password || '';

  onFlash(e => ui.flash?.(e));
  onBoard(info => ui.board?.(info));
  onBrokerChange(e => ui.broker?.(e));
  render();
}

// ---------- layout ----------
function render() {
  ui = {};
  const step = STEPS[st.step];
  root.replaceChildren(
    el('div', { class: 'wz-head' },
      el('div', {},
        el('h2', {}, 'เริ่มต้นใช้งาน PlugPilot'),
        el('p', { class: 'muted' }, 'ทำตามทีละขั้น ไม่ต้องมีความรู้มาก่อน — ใช้เวลาประมาณ 20–30 นาที')),
      el('button', { class: 'btn small', type: 'button', onclick: () => showTab('dashboard') }, 'ข้าม ไปหน้าควบคุม →')),
    el('ol', { class: 'wz-steps', id: 'wz-stepper' }),
    el('div', { class: 'card wz-card' },
      el('div', { class: 'wz-step-title' },
        el('span', { class: 'wz-num' }, String(st.step + 1)),
        el('h3', {}, step.title),
        el('span', { class: 'muted' }, `ขั้นที่ ${st.step + 1} จาก ${STEPS.length}`)),
      BODY[step.id]()),
    el('div', { class: 'wz-nav' },
      el('button', { class: 'btn', type: 'button', disabled: st.step === 0, onclick: () => go(st.step - 1) }, '← ย้อนกลับ'),
      st.step < STEPS.length - 1
        ? el('button', { class: 'btn primary big', type: 'button', onclick: () => go(st.step + 1) },
          isDone(step.id) || step.id === 'prep' ? 'ไปขั้นต่อไป →' : 'ข้ามขั้นนี้ →')
        : el('button', { class: 'btn primary big', type: 'button', onclick: finish }, 'เสร็จแล้ว ไปหน้าควบคุม →')),
  );
  renderStepper();
}

function renderStepper() {
  const list = document.getElementById('wz-stepper');
  if (!list) return;
  list.replaceChildren(...STEPS.map((s, i) => el('li', {
    class: `${i === st.step ? 'current' : ''} ${isDone(s.id) ? 'done' : ''}`,
  }, el('button', { type: 'button', onclick: () => go(i), 'aria-current': i === st.step ? 'step' : null },
    el('span', { class: 'dot' }, isDone(s.id) ? '✓' : String(i + 1)),
    el('span', { class: 'lbl' }, s.title)))));
}

function go(i) {
  st.step = Math.max(0, Math.min(STEPS.length - 1, i));
  save();
  render();
  root.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function finish() {
  store('hub.wizardDone', true);
  showTab('dashboard');
}

// small building blocks
const tip = (...c) => el('div', { class: 'wz-tip' }, ...c);
const warn = (...c) => el('div', { class: 'wz-tip warn' }, ...c);
const status = () => el('div', { class: 'wz-status', role: 'status' });
function setStatus(node, kind, text) { node.className = `wz-status ${kind}`; node.textContent = text; }
const field = (label, input, hint) => el('label', { class: 'wz-field' }, el('span', {}, label), input, hint ? el('small', { class: 'muted' }, hint) : null);
const ext = (href, text) => el('a', { class: 'btn', href, target: '_blank', rel: 'noopener' }, text, ' ↗');
// How to move the board to another place later (firmware with phone setup only).
const apCard = info => (info?.ap_ssid
  ? tip(el('b', {}, '📱 ย้ายบอร์ดไปใช้ที่อื่น ไม่ต้องใช้สาย USB: '),
      'บอร์ดจำ Wi-Fi ได้ 5 แห่งและเลือกต่อเอง ถ้าไปที่ที่ไม่รู้จัก รอ 1 นาที (หรือกดปุ่ม BOOT สั้นๆ) ',
      'แล้วใช้มือถือต่อ Wi-Fi ', el('b', {}, info.ap_ssid), ' รหัส ', el('b', {}, info.ap_pass),
      ' — หน้าตั้งค่าจะเด้งขึ้นมาให้เลือก Wi-Fi ใหม่ · แนะนำให้เขียนชื่อและรหัสนี้ติดไว้ที่กล่อง')
  : null);

// ---------- steps ----------
const BODY = {
  prep() {
    const serialOk = 'serial' in navigator;
    const items = [
      ['บอร์ด ESP32-DevKitC', 'รุ่น ESP32-WROOM-32 / 32D'],
      ['สาย USB ที่ส่งข้อมูลได้', 'สายชาร์จอย่างเดียวจะใช้ไม่ได้ — ถ้าคอมไม่เจอบอร์ด ให้ลองเปลี่ยนสาย'],
      ['โมดูลรีเลย์ 5V', '1, 2, 4 หรือ 8 ช่อง แบบมีขา VCC / GND / IN'],
      ['สายจัมเปอร์ (ตัวเมีย–ตัวเมีย)', 'อย่างน้อย 3 เส้น + 1 เส้นต่อรีเลย์ 1 ช่อง'],
      ['Wi-Fi บ้านแบบ 2.4 GHz', 'ESP32 ใช้ Wi-Fi 5 GHz ไม่ได้ — ชื่อ Wi-Fi ที่ลงท้าย “5G” มักใช้ไม่ได้'],
      ['คอมพิวเตอร์ + Chrome หรือ Edge', 'มือถือใช้ขั้นตอนลงโปรแกรมไม่ได้ (ใช้ได้เฉพาะหน้าควบคุม)'],
    ];
    return el('div', {},
      el('p', { class: 'wz-lead' }, 'เราจะทำให้บอร์ด ESP32 เปิด-ปิดเครื่องใช้ไฟฟ้าได้จากเว็บนี้ ผ่านอินเทอร์เน็ต เริ่มจากเตรียมของตามรายการนี้:'),
      el('ul', { class: 'wz-checklist' }, items.map(([t, d]) => el('li', {}, el('b', {}, t), el('span', { class: 'muted' }, d)))),
      serialOk
        ? tip('✔ เบราว์เซอร์นี้ใช้ลงโปรแกรมบอร์ดได้')
        : warn('✘ เบราว์เซอร์นี้ลงโปรแกรมบอร์ดไม่ได้ — กรุณาเปิดเว็บนี้ด้วย Google Chrome หรือ Microsoft Edge บนคอมพิวเตอร์'),
    );
  },

  broker() {
    const host = el('input', { value: st.host, placeholder: 'เช่น abc123.s1.eu.hivemq.cloud', autocomplete: 'off', spellcheck: 'false' });
    const wu = el('input', { value: st.webUser, placeholder: 'เช่น webadmin', autocomplete: 'off' });
    const wp = el('input', { type: 'password', value: webPass, autocomplete: 'off' });
    const bu = el('input', { value: st.boardUser, placeholder: 'เช่น board1', autocomplete: 'off' });
    const bp = el('input', { type: 'password', value: boardPass, autocomplete: 'off' });
    const base = el('input', { value: st.base, pattern: '[A-Za-z0-9_\\-]{1,32}', autocomplete: 'off' });
    const out = status();
    const persist = () => {
      st.host = cleanHost(host.value); st.webUser = wu.value.trim(); st.boardUser = bu.value.trim();
      st.base = base.value.trim() || 'home'; webPass = wp.value; boardPass = bp.value; save();
    };
    [host, wu, wp, bu, bp, base].forEach(i => i.addEventListener('change', persist));

    let waiting = null;
    ui.broker = e => {
      if (!waiting) return;
      if (e.state === 'connected') {
        clearTimeout(waiting); waiting = null;
        setStatus(out, 'ok', '✔ เชื่อมต่อสำเร็จ! บัญชีหน้าเว็บใช้งานได้');
        markDone('broker');
        render();
      } else if (e.state === 'error') {
        setStatus(out, 'bad', `✘ เชื่อมต่อไม่ได้: ${e.error || ''} — ตรวจ Username / Password ของ “บัญชีหน้าเว็บ”`);
      }
    };
    const test = () => {
      persist();
      if (!st.host || !st.webUser || !webPass) return setStatus(out, 'bad', 'กรอก Cluster URL และบัญชีหน้าเว็บให้ครบก่อน');
      if (!st.boardUser || !boardPass) return setStatus(out, 'bad', 'กรอกบัญชีบอร์ดด้วย (ใช้ในขั้นที่ 5)');
      setStatus(out, 'wait', 'กำลังเชื่อมต่อ…');
      waiting = setTimeout(() => { waiting = null; setStatus(out, 'bad', '✘ ไม่ตอบภายใน 12 วินาที — ตรวจ Cluster URL'); }, 12000);
      connectBroker({ url: `wss://${st.host}:8884/mqtt`, username: st.webUser, password: webPass, base: st.base, remember: true });
    };

    return el('div', {},
      el('p', { class: 'wz-lead' }, 'MQTT คือ “ตัวกลาง” บนอินเทอร์เน็ตที่ส่งคำสั่งจากเว็บไปถึงบอร์ด เราจะใช้บริการฟรีของ HiveMQ Cloud'),
      el('ol', { class: 'wz-howto' },
        el('li', {}, 'กดปุ่มนี้เพื่อเปิดเว็บ HiveMQ แล้ว ', el('b', {}, 'สมัคร / เข้าสู่ระบบด้วย Gmail'), ' ได้เลย  ', ext('https://console.hivemq.cloud', 'เปิด HiveMQ Cloud')),
        el('li', {}, 'กด ', el('b', {}, 'Create Cluster'), ' → เลือกแบบ ', el('b', {}, 'Serverless (Free)')),
        el('li', {}, 'กด ', el('b', {}, 'Manage Cluster'), ' → คัดลอก ', el('b', {}, 'Cluster URL'), ' มาวางในช่องด้านล่าง'),
        el('li', {}, 'ไปที่ ', el('b', {}, 'Access Management → Credentials'), ' สร้างบัญชี ', el('b', {}, '2 บัญชี'),
          ' (บัญชีหน้าเว็บ + บัญชีบอร์ด) เลือก Permission เป็น ', el('b', {}, 'Publish and Subscribe')),
      ),
      warn('Username / Password ตรงนี้คือบัญชีที่ ', el('b', {}, 'สร้างใน Credentials'), ' — ไม่ใช่อีเมลหรือรหัสผ่าน Gmail'),
      el('div', { class: 'wz-form' },
        field('Cluster URL', host, 'วางได้ทั้งลิงก์ ระบบจะตัดเหลือแค่ชื่อให้เอง'),
        el('fieldset', { class: 'wz-group' }, el('legend', {}, '① บัญชีหน้าเว็บ'), field('Username', wu), field('Password', wp)),
        el('fieldset', { class: 'wz-group' }, el('legend', {}, '② บัญชีบอร์ด'), field('Username', bu), field('Password', bp,
          'จำไว้ในหน้านี้เท่านั้น จนกว่าจะส่งให้บอร์ดในขั้นที่ 5')),
        el('details', { class: 'wz-more' }, el('summary', {}, 'ตั้งค่าเพิ่มเติม (ไม่ต้องแก้ก็ได้)'),
          field('ชื่อกลุ่มอุปกรณ์ (Base topic)', base, 'ภาษาอังกฤษ ไม่มีเว้นวรรค — หน้าเว็บกับบอร์ดต้องใช้ชื่อเดียวกัน')),
      ),
      el('div', { class: 'wz-actions' }, el('button', { class: 'btn primary big', type: 'button', onclick: test }, 'ทดสอบการเชื่อมต่อ')),
      out,
      isDone('broker') && brokerConnected() ? tip('✔ ขั้นนี้เสร็จแล้ว — กด “ไปขั้นต่อไป”') : null,
    );
  },

  wire() {
    const counts = [1, 2, 4, 8];
    if (st.pins) setPins(st.pins);
    const pins = getPins();
    const isDefault = n => pins.length === n && pins.join() === DEFAULT_PINS.slice(0, n).join();
    const diagram = el('div', { class: 'wiring-wrap' });
    // remember the choice in the wizard itself: connecting a board later re-syncs the shared pins
    const pick = n => { st.pins = DEFAULT_PINS.slice(0, n); save(); setPins(st.pins); render(); };
    const done = el('input', { type: 'checkbox', onchange: e => { st.pins = getPins(); markDone('wire', e.target.checked); render(); } });
    done.checked = isDone('wire');
    queueMicrotask(() => renderWiring(diagram, getPins()));
    return el('div', {},
      el('p', { class: 'wz-lead' }, 'โมดูลรีเลย์ของคุณมีกี่ช่อง?'),
      el('div', { class: 'wz-choice' }, counts.map(n => el('button', {
        type: 'button', class: `btn${isDefault(n) ? ' primary' : ''}`, onclick: () => pick(n),
      }, `${n} ช่อง`)),
        !counts.some(isDefault) ? el('span', { class: 'pill on' }, `ใช้ขาที่เลือกเอง ${pins.length} ช่อง`) : null),
      el('p', { class: 'wz-lead' }, 'ต่อสายตามรูป (ถอดสาย USB ออกก่อนต่อ):'),
      el('ul', { class: 'wz-legend' },
        el('li', {}, el('i', { style: 'background:#dc2626' }), el('b', {}, 'สายแดง'), ' ขา 5V ของบอร์ด → VCC ของรีเลย์'),
        el('li', {}, el('i', { style: 'background:#1f2328' }), el('b', {}, 'สายดำ'), ' ขา GND ของบอร์ด → GND ของรีเลย์'),
        el('li', {}, el('i', { style: 'background:linear-gradient(90deg,#eab308,#22c55e,#06b6d4)' }), el('b', {}, 'สายสี'), ' ขา GPIO ของบอร์ด → IN1, IN2, … ตามลำดับ'),
      ),
      diagram,
      warn('⚠ ', el('b', {}, 'ยังไม่ต้องต่อไฟบ้าน 220V'), ' — ทดสอบด้วยไฟ LED และเสียง “คลิก” บนโมดูลก่อน เมื่อทุกอย่างทำงานแล้วค่อยให้ช่างไฟต่อเครื่องใช้ไฟฟ้า'),
      el('label', { class: 'wz-confirm' }, done, ' ต่อสายเรียบร้อยแล้ว'),
      el('p', { class: 'muted small-note' }, 'อยากเลือกขาเอง? ไปที่แท็บ “ตั้งค่าบอร์ด (USB)” → เลือกขา GPIO (สำหรับผู้มีประสบการณ์)'),
    );
  },

  flash() {
    const bar = el('div', { class: 'bar' });
    const text = el('p', { class: 'muted mono' });
    const out = status();
    const btn = el('button', { class: 'btn primary big', type: 'button' }, 'ลงโปรแกรมให้บอร์ด');
    ui.flash = e => {
      if (e.type === 'progress') { bar.style.width = `${e.pct}%`; text.textContent = e.text || ''; setStatus(out, 'wait', 'กำลังลงโปรแกรม… ห้ามถอดสาย USB'); }
      if (e.type === 'done') { setStatus(out, 'ok', '✔ ลงโปรแกรมเสร็จแล้ว! บอร์ดรีสตาร์ตเรียบร้อย'); markDone('flash'); btn.disabled = false; render(); }
      if (e.type === 'error') { setStatus(out, 'bad', `✘ ${e.message}`); btn.disabled = false; }
      if (e.type === 'cancel') { setStatus(out, '', 'ยังไม่ได้เลือกพอร์ต — กดปุ่มอีกครั้ง แล้วเลือกรายการที่มีคำว่า CP210x / USB Serial'); btn.disabled = false; }
    };
    btn.addEventListener('click', () => {
      if (!('serial' in navigator)) return setStatus(out, 'bad', 'ต้องใช้ Chrome หรือ Edge บนคอมพิวเตอร์');
      if (!hasHostedFirmware()) return setStatus(out, 'bad', 'ยังไม่มีไฟล์โปรแกรมบนเว็บนี้ — ลองรีเฟรชหน้า');
      btn.disabled = true;
      setStatus(out, 'wait', 'เลือกพอร์ตในหน้าต่างที่เด้งขึ้น…');
      flashLatest();
    });
    return el('div', {},
      el('ol', { class: 'wz-howto' },
        el('li', {}, el('b', {}, 'เสียบสาย USB'), ' จากบอร์ดเข้าคอมพิวเตอร์'),
        el('li', {}, el('b', {}, 'ปิดโปรแกรมอื่นที่ใช้บอร์ดอยู่'), ' เช่น Arduino IDE (Serial Monitor)'),
        el('li', {}, 'กดปุ่มด้านล่าง → หน้าต่างเลือกพอร์ตจะเด้งขึ้น → เลือกรายการที่มีคำว่า ', el('b', {}, 'CP210x'), ' หรือ ', el('b', {}, 'USB Serial'), ' → กด ', el('b', {}, 'Connect')),
        el('li', {}, 'รอประมาณ 1 นาทีจนแถบเต็ม'),
      ),
      el('div', { class: 'wz-actions' }, btn),
      el('div', { class: 'progress' }, bar), text, out,
      isDone('flash') ? tip('✔ ขั้นนี้เสร็จแล้ว — กด “ไปขั้นต่อไป”') : null,
      el('details', { class: 'wz-more' }, el('summary', {}, 'ถ้าไม่สำเร็จ'),
        el('ul', {},
          el('li', {}, 'ไม่มีพอร์ตให้เลือก → เปลี่ยนสาย USB (ต้องเป็นสายที่ส่งข้อมูลได้) หรือติดตั้งไดรเวอร์ CP210x'),
          el('li', {}, '“Failed to open serial port” → ปิด Arduino IDE หรือแท็บอื่นที่เปิดเว็บนี้อยู่'),
          el('li', {}, 'ค้างที่ “Connecting” → กดปุ่ม BOOT บนบอร์ดค้างไว้ แล้วกดลงโปรแกรมอีกครั้ง'))),
    );
  },

  wifi() {
    const out = status();
    const boardLine = el('div', { class: 'wz-board' });
    const ssid = el('select', {}, el('option', { value: '' }, '— กด “ค้นหา Wi-Fi” —'));
    const ssidManual = el('input', { placeholder: 'หรือพิมพ์ชื่อ Wi-Fi เอง', autocomplete: 'off' });
    const pass = el('input', { type: 'password', autocomplete: 'off', placeholder: 'รหัสผ่าน Wi-Fi' });
    const show = el('input', { type: 'checkbox', onchange: e => { pass.type = e.target.checked ? 'text' : 'password'; } });
    const scanBtn = el('button', { class: 'btn', type: 'button', disabled: true }, 'ค้นหา Wi-Fi');
    const sendBtn = el('button', { class: 'btn primary big', type: 'button', disabled: true }, 'ส่งค่าให้บอร์ด');
    const connectBtn = el('button', { class: 'btn primary big', type: 'button' }, 'เชื่อมต่อบอร์ด');
    const checks = el('ul', { class: 'wz-progress-list' });

    const paintBoard = info => {
      const ok = !!info;
      connectBtn.hidden = ok;
      scanBtn.disabled = sendBtn.disabled = !ok;
      boardLine.replaceChildren(ok
        ? el('span', {}, '✔ เชื่อมต่อบอร์ดแล้ว: ', el('b', {}, info.device_id), ` (โปรแกรม v${info.fw})`)
        : el('span', { class: 'muted' }, 'ยังไม่ได้เชื่อมต่อบอร์ด'));
      if (ok && !info.safe_pins) setStatus(out, 'bad', 'โปรแกรมในบอร์ดเป็นรุ่นเก่า — กลับไปขั้นที่ 4 แล้วลงโปรแกรมใหม่');
    };
    ui.board = paintBoard;
    paintBoard(getBoardInfo());

    connectBtn.addEventListener('click', async () => {
      setStatus(out, 'wait', 'กำลังเชื่อมต่อบอร์ด… (ถ้ามีหน้าต่างเด้งขึ้น ให้เลือก CP210x / USB Serial)');
      const ok = await connectBoard();
      setStatus(out, ok ? 'ok' : 'bad', ok ? 'เชื่อมต่อบอร์ดแล้ว — ต่อไปเลือก Wi-Fi' : 'เชื่อมต่อไม่ได้ — ตรวจสาย USB และปิดโปรแกรมอื่นที่ใช้พอร์ต');
    });
    scanBtn.addEventListener('click', async () => {
      scanBtn.disabled = true; scanBtn.textContent = 'กำลังค้นหา…';
      try {
        const nets = await scanWifi();
        ssid.replaceChildren(el('option', { value: '' }, `— พบ ${nets.length} เครือข่าย เลือกของบ้านคุณ —`),
          ...nets.map(n => el('option', { value: n.ssid }, `${n.ssid}   ${n.rssi > -60 ? '▂▄▆█' : n.rssi > -75 ? '▂▄▆' : '▂▄'}${n.secure ? ' 🔒' : ''}${/5\s?g(hz)?/i.test(n.ssid) ? '  (อาจเป็น 5 GHz — ใช้ไม่ได้)' : ''}`)));
      } catch (err) { toast(`ค้นหาไม่สำเร็จ: ${err.message}`); }
      scanBtn.disabled = false; scanBtn.textContent = 'ค้นหา Wi-Fi อีกครั้ง';
    });

    const step = (label, state) => el('li', { class: state }, el('span', { class: 'ic' }, state === 'ok' ? '✔' : state === 'bad' ? '✘' : state === 'wait' ? '…' : '○'), label);
    sendBtn.addEventListener('click', async () => {
      const name = ssidManual.value.trim() || ssid.value;
      if (!name) return setStatus(out, 'bad', 'เลือกหรือพิมพ์ชื่อ Wi-Fi ก่อน');
      if (!st.host || !st.boardUser || !boardPass) {
        return setStatus(out, 'bad', 'ยังไม่มีข้อมูลบัญชีบอร์ด — กลับไปขั้นที่ 2 กรอก “บัญชีบอร์ด” ให้ครบ');
      }
      const info = getBoardInfo();
      const cfg = {
        wifi_ssid: name, mqtt_host: st.host, mqtt_port: 8883, mqtt_tls: true,
        mqtt_user: st.boardUser, mqtt_pass: boardPass, base: st.base,
      };
      if (pass.value && pass.value.length < 8) return setStatus(out, 'bad', 'รหัส Wi-Fi ต้องยาว 8 ตัวขึ้นไป (หรือเว้นว่างถ้าไม่มีรหัส)');
      if (pass.value) cfg.wifi_pass = pass.value;
      else if (!info?.wifi_networks && !(info?.has_wifi_pass && info.wifi_ssid === name)) cfg.wifi_pass = '';   // open network
      // (multi-network firmware: no wifi_pass = keep the password saved for this name, or none for a new one)
      if (info?.safe_pins) cfg.relay_pins = st.pins || getPins();
      sendBtn.disabled = true;
      setStatus(out, 'wait', 'กำลังส่งค่า… บอร์ดจะรีสตาร์ต (ประมาณ 10–30 วินาที)');
      checks.replaceChildren(step('บอร์ดรับค่าและรีสตาร์ต', 'wait'), step('เชื่อมต่อ Wi-Fi', ''), step('เชื่อมต่อ MQTT', ''));
      try {
        const res = await applyBoardConfig(cfg, {
          onTick: i => checks.replaceChildren(
            step('บอร์ดรับค่าและรีสตาร์ต', 'ok'),
            step(`เชื่อมต่อ Wi-Fi “${name}”`, i.wifi === 'connected' ? 'ok' : /failed|not_found/.test(i.wifi) ? 'bad' : 'wait'),
            step('เชื่อมต่อ MQTT', i.mqtt ? 'ok' : i.wifi === 'connected' ? 'wait' : '')),
        });
        if (res?.wifi === 'connected' && res.mqtt) {
          setStatus(out, 'ok', '✔ บอร์ดออนไลน์แล้ว!');
          markDone('wifi');
          render();
        } else if (res?.wifi === 'auth_failed') setStatus(out, 'bad', '✘ รหัสผ่าน Wi-Fi ไม่ถูกต้อง — พิมพ์ใหม่แล้วกดส่งอีกครั้ง');
        else if (res?.wifi === 'ssid_not_found') setStatus(out, 'bad', '✘ บอร์ดหา Wi-Fi นี้ไม่เจอ — ต้องเป็น Wi-Fi 2.4 GHz และอยู่ใกล้เราเตอร์');
        else if (res?.wifi === 'connected') setStatus(out, 'bad', '✘ ต่อ Wi-Fi ได้ แต่ต่อ MQTT ไม่ได้ — ตรวจ Username / Password ของ “บัญชีบอร์ด” ในขั้นที่ 2');
        else setStatus(out, 'bad', '✘ บอร์ดยังต่อ Wi-Fi ไม่ได้ — ตรวจชื่อและรหัสผ่าน Wi-Fi');
      } catch (err) { setStatus(out, 'bad', `✘ ${err.message}`); }
      sendBtn.disabled = false;
    });

    return el('div', {},
      el('p', { class: 'wz-lead' }, 'บอกบอร์ดว่าจะต่อ Wi-Fi ไหน และให้ต่อกับ MQTT ที่สมัครไว้ (ยังเสียบสาย USB ไว้)'),
      el('div', { class: 'wz-actions' }, connectBtn), boardLine,
      el('div', { class: 'wz-form' },
        field('ชื่อ Wi-Fi', el('div', { class: 'row' }, ssid, scanBtn), 'ต้องเป็น Wi-Fi 2.4 GHz'),
        field('', ssidManual),
        field('รหัสผ่าน Wi-Fi', pass),
        el('label', { class: 'check' }, show, ' แสดงรหัสผ่าน'),
        tip('บอร์ดจะต่อ MQTT ที่ ', el('b', {}, st.host || '(ยังไม่ได้กรอกในขั้นที่ 2)'), ' ด้วยบัญชี ', el('b', {}, st.boardUser || '—')),
      ),
      el('div', { class: 'wz-actions' }, sendBtn),
      checks, out,
      isDone('wifi') ? tip('✔ ขั้นนี้เสร็จแล้ว — กด “ไปขั้นต่อไป” แล้วถอดสาย USB ออกได้เลย') : null,
      apCard(getBoardInfo()),
    );
  },

  test() {
    const out = status();
    const stateLine = el('div', { class: 'wz-big-state' }, '—');
    const chSel = el('select', {});
    const onBtn = el('button', { class: 'btn primary big', type: 'button' }, 'เปิด (ON)');
    const offBtn = el('button', { class: 'btn big', type: 'button' }, 'ปิด (OFF)');
    const boardId = () => getBoardInfo()?.device_id || st.deviceId || '';

    const paint = () => {
      const id = boardId();
      const d = getDevice(id);
      if (!brokerConnected()) {
        setStatus(out, 'wait', 'กำลังเชื่อมต่อ MQTT…');
      } else if (!d) {
        setStatus(out, 'wait', id ? `กำลังรอบอร์ด ${id} ออนไลน์… (เสียบไฟเลี้ยงบอร์ดไว้)` : 'ยังไม่พบบอร์ด — ทำขั้นที่ 5 ให้เสร็จก่อน');
      } else if (d.status !== 'online') {
        setStatus(out, 'bad', `บอร์ด ${id} ออฟไลน์ — ตรวจไฟเลี้ยงบอร์ดและ Wi-Fi`);
      } else {
        setStatus(out, 'ok', `✔ บอร์ด ${id} ออนไลน์`);
      }
      const relays = d?.info?.relays || [];
      if (chSel.options.length !== relays.length) {
        chSel.replaceChildren(...relays.map(r => el('option', { value: r.ch }, `ช่อง ${r.ch} (GPIO${r.gpio})`)));
      }
      const ch = Number(chSel.value) || 1;
      const on = d?.states?.[ch];
      stateLine.textContent = on == null ? '—' : on ? '💡 เปิดอยู่' : '⚫ ปิดอยู่';
      stateLine.className = `wz-big-state ${on ? 'on' : ''}`;
      onBtn.disabled = offBtn.disabled = !d || d.status !== 'online';
    };
    ui.broker = paint;
    chSel.addEventListener('change', paint);
    const cmd = c => () => {
      const id = boardId();
      if (!id) return;
      st.deviceId = id; save();
      sendRelay(id, Number(chSel.value) || 1, c);
      setTimeout(() => {
        const d = getDevice(id);
        if (d?.states?.[Number(chSel.value) || 1] === (c === 'ON')) {
          const first = !isDone('test');
          markDone('test');
          toast('🎉 สำเร็จ! บอร์ดทำงานตามคำสั่ง');
          if (first) render();   // show the "finished" panel
        }
      }, 1500);
    };
    onBtn.addEventListener('click', cmd('ON'));
    offBtn.addEventListener('click', cmd('OFF'));

    if (getBoardInfo()?.device_id) { st.deviceId = getBoardInfo().device_id; save(); }
    if (!brokerConnected() && st.host && st.webUser && webPass) {
      connectBroker({ url: `wss://${st.host}:8884/mqtt`, username: st.webUser, password: webPass, base: st.base, remember: true });
    }
    queueMicrotask(paint);

    return el('div', {},
      el('p', { class: 'wz-lead' }, 'ลองสั่งรีเลย์ผ่านอินเทอร์เน็ต — ถ้าได้ยินเสียง “คลิก” และไฟบนโมดูลติด แปลว่าใช้งานได้แล้ว'),
      out,
      el('div', { class: 'wz-test' }, field('เลือกช่องรีเลย์', chSel), stateLine, el('div', { class: 'wz-actions' }, onBtn, offBtn)),
      !brokerConnected() && !webPass ? warn('ยังไม่ได้เชื่อมต่อ MQTT — กลับไปขั้นที่ 2 กด “ทดสอบการเชื่อมต่อ”') : null,
      isDone('test') ? el('div', { class: 'wz-finish' },
        el('h3', {}, '🎉 เยี่ยม! ระบบพร้อมใช้งานแล้ว'),
        el('p', {}, 'ต่อจากนี้ใช้หน้า “แดชบอร์ด” เพื่อเปิด-ปิด และตั้งเวลาอัตโนมัติ — เปิดจากมือถือก็ได้'),
        el('p', { class: 'muted' }, 'เมื่อจะต่อเครื่องใช้ไฟฟ้า 220V ให้ตัดไฟก่อน และควรให้ช่างไฟฟ้าช่วยต่อ (ดูรูปวงจรในแท็บ “ภาพรวมระบบ”)'))
        : null,
    );
  },
};
