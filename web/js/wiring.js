// Dynamic wiring diagram: ESP32-DevKitC -> N-channel relay module -> AC loads.
// Redrawn from the current relay pin list (CH1 = pins[0] ...), so it always matches the firmware's pin map.
import { el } from './util.js';
import { J2, J3, ALIAS, kindOf } from './pin-picker.js';

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...children) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  for (const c of children) if (c != null) n.append(c);
  return n;
}

// Distinct, readable on light and dark backgrounds.
const WIRE_COLORS = ['#eab308', '#f97316', '#22c55e', '#06b6d4', '#a855f7', '#ec4899', '#84cc16', '#14b8a6',
  '#f43f5e', '#8b5cf6', '#0ea5e9', '#d946ef', '#facc15', '#10b981', '#fb923c'];
// With the SHT31 drawn, yellow and purple belong to its SDA/SCL wires, so relays skip them.
const NO_SENSOR_HUES = new Set(['#eab308', '#facc15', '#a855f7', '#8b5cf6', '#d946ef']);
const RELAY_COLORS_WITH_SENSOR = WIRE_COLORS.filter(c => !NO_SENSOR_HUES.has(c));
export const wireColor = (i, sensor = false) => {
  const list = sensor ? RELAY_COLORS_WITH_SENSOR : WIRE_COLORS;
  return list[i % list.length];
};
const RED = '#dc2626', BLACK = 'var(--wire-gnd)', BLUE = '#2563eb';

// ---- layout constants ----
const W = 1110;
const LX = 204, RX = 340, PITCH = 22;          // DevKitC header pin x positions / pitch
const BOARD_TOP = 40, PIN0 = BOARD_TOP + 78;    // first header pin (antenna end)
const BOARD_BOTTOM = PIN0 + 18 * PITCH + 62;
const TAG_W = 74;
const MOD_X = 640, MOD_W = 236;                 // relay module
const ROW = 56;                                 // height of one relay channel
const LOAD_X = MOD_X + MOD_W + 74;              // load icons
const L_BUS = LOAD_X + 74, N_BUS = L_BUS + 44;  // mains buses

const pinY = i => PIN0 + i * PITCH;
const tagText = p => (typeof p === 'number' ? (ALIAS[p] ? `${ALIAS[p]}·${p}` : `GPIO${p}`) : p === '5V' ? '5V0' : p);

function tagFill(p) {
  if (p === '3V3' || p === '5V') return '#c62828';
  if (p === 'GND') return '#1f2328';
  if (p === 'EN') return '#a3a33a';
  const k = kindOf(p);
  if (k === 'input') return '#1f5f3a';
  return '#3f8f45';
}

function fanIcon(x, y) {
  const g = s('g', { class: 'load-icon', transform: `translate(${x} ${y})` });
  g.append(s('circle', { r: 15 }));
  for (const a of [0, 120, 240]) g.append(s('ellipse', { cx: 0, cy: -7, rx: 3.6, ry: 7, transform: `rotate(${a})` }));
  g.append(s('circle', { r: 2.5, class: 'hub' }));
  return g;
}

/**
 * Renders the wiring for `pins` into `container` (replacing its content).
 * opts.names: { [ch]: "ชื่อโหลด" } optional labels for loads.
 * opts.sensor: also draw the SHT31 module (I2C: SDA GPIO21, SCL GPIO22) above the board.
 */
export function renderWiring(container, pins, opts = {}) {
  const n = pins.length;
  if (!n) {
    container.replaceChildren(el('div', { class: 'sched-empty' }, 'ยังไม่ได้เลือกขารีเลย์ — เลือกขาในแท็บ “ตั้งค่าบอร์ด (USB)”'));
    return;
  }

  const sensor = !!opts.sensor;
  const OFF = sensor ? SENSOR_SPACE : 0;            // everything below moves down to make room for the sensor
  const MOD_TOP = BOARD_TOP + 30;
  const vccY = MOD_TOP + 34, gndY = MOD_TOP + 60;
  const chY = k => MOD_TOP + 106 + k * ROW;          // IN pin / COM terminal of channel k
  const MOD_BOTTOM = chY(n - 1) + 40;

  // ---- wires: source header pin -> module header pin ----
  const wires = [
    // with the sensor, its GND takes the top-right GND pin and the relay module uses the one next to GPIO21
    { label: 'GND', side: 'R', idx: sensor ? 6 : 0, ty: gndY, color: BLACK, cls: 'gnd', title: 'GND (บอร์ด) → GND ของโมดูลรีเลย์' },
    { label: '5V', side: 'L', idx: 18, ty: vccY, color: RED, cls: 'vcc', title: '5V (บอร์ด) → VCC ของโมดูลรีเลย์' },
    ...pins.map((g, k) => {
      const l = J2.indexOf(g), r = J3.indexOf(g);
      return {
        label: `GPIO${g}`, side: l >= 0 ? 'L' : 'R', idx: l >= 0 ? l : r, ty: chY(k), color: wireColor(k, sensor), ch: k + 1, gpio: g,
        title: `GPIO${g} → IN${k + 1} (รีเลย์ช่อง ${k + 1})`,
      };
    }),
  ];
  // lanes: wires to higher targets use lanes closer to the module (fewer crossings)
  const byTarget = [...wires].sort((a, b) => a.ty - b.ty);
  byTarget.forEach((w, rank) => { w.lane = MOD_X - 26 - rank * 11; });
  const leftWires = wires.filter(w => w.side === 'L').sort((a, b) => b.idx - a.idx);
  leftWires.forEach((w, j) => { w.lx = LX - TAG_W - 30 - j * 9; w.by = BOARD_BOTTOM + 18 + j * 10; });

  const lowest = Math.max(BOARD_BOTTOM + 18 + leftWires.length * 10, MOD_BOTTOM);
  const H = lowest + 70 + OFF;

  const sensorWires = sensor ? SENSOR_WIRES : [];
  const root = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'wiring', role: 'img',
    'aria-label': `วงจรต่อ ESP32 กับโมดูลรีเลย์ ${n} ช่อง${sensor ? ' และเซ็นเซอร์ SHT31' : ''}` });
  const svg = s('g', { transform: `translate(0 ${OFF})` });
  root.append(svg);

  // ---- ESP32-DevKitC ----
  const board = s('g', { class: 'w-board' });
  board.append(
    s('rect', { class: 'pcb', x: LX - 16, y: BOARD_TOP, width: RX - LX + 32, height: BOARD_BOTTOM - BOARD_TOP, rx: 10 }),
    s('rect', { class: 'antenna-bg', x: LX + 14, y: BOARD_TOP - 26, width: RX - LX - 28, height: 34, rx: 3 }),
    s('path', { class: 'antenna', d: `M${LX + 26} ${BOARD_TOP - 14}h50v8h-50v8h50` }),
    s('rect', { class: 'module', x: LX + 32, y: BOARD_TOP + 10, width: RX - LX - 64, height: 190, rx: 4 }),
    s('rect', { class: 'shield', x: LX + 38, y: BOARD_TOP + 54, width: RX - LX - 76, height: 138, rx: 3 }),
    s('text', { class: 'chip', x: (LX + RX) / 2, y: BOARD_TOP + 112, 'text-anchor': 'middle' }, 'ESPRESSIF'),
    s('text', { class: 'chip-sub', x: (LX + RX) / 2, y: BOARD_TOP + 130, 'text-anchor': 'middle' }, 'ESP32-WROOM'),
    s('rect', { class: 'usb', x: (LX + RX) / 2 - 24, y: BOARD_BOTTOM - 30, width: 48, height: 40, rx: 4 }),
    s('rect', { class: 'btn-hw', x: LX + 8, y: BOARD_BOTTOM - 30, width: 20, height: 16, rx: 3 }),
    s('rect', { class: 'btn-hw', x: RX - 28, y: BOARD_BOTTOM - 30, width: 20, height: 16, rx: 3 }),
    s('text', { class: 'tiny', x: LX + 18, y: BOARD_BOTTOM - 36, 'text-anchor': 'middle' }, 'EN'),
    s('text', { class: 'tiny', x: RX - 18, y: BOARD_BOTTOM - 36, 'text-anchor': 'middle' }, 'BOOT'),
  );
  const used = new Map([...wires, ...sensorWires].map(w => [`${w.side}${w.idx}`, w]));
  const header = (list, side) => list.forEach((p, i) => {
    const y = pinY(i);
    const x = side === 'L' ? LX : RX;
    const tagX = side === 'L' ? LX - 20 - TAG_W : RX + 20;
    const w = used.get(`${side}${i}`);
    board.append(
      s('line', { class: 'stub', x1: x, y1: y, x2: side === 'L' ? tagX + TAG_W : tagX, y2: y }),
      s('circle', { class: 'pin', cx: x, cy: y, r: 6 }),
      s('rect', { class: `tag${w ? ' used' : ''}`, x: tagX, y: y - 8, width: TAG_W, height: 16, rx: 8,
        style: `fill:${w ? w.color : tagFill(p)}` }),
      s('text', { class: `tag-text${w && w.color === '#eab308' || w?.color === '#facc15' ? ' dark' : ''}`, x: tagX + TAG_W / 2, y: y + 4, 'text-anchor': 'middle' }, tagText(p)),
      s('text', { class: 'silk', x: side === 'L' ? x + 12 : x - 12, y: y + 3, 'text-anchor': side === 'L' ? 'start' : 'end' },
        typeof p === 'number' ? (ALIAS[p] || String(p)) : p === '5V' ? '5V' : p),
    );
  });
  header(J2, 'L');
  header(J3, 'R');
  svg.append(board);

  // ---- relay module ----
  const mod = s('g', { class: 'w-relay' });
  mod.append(
    s('rect', { class: 'rpcb', x: MOD_X, y: MOD_TOP, width: MOD_W, height: MOD_BOTTOM - MOD_TOP, rx: 10 }),
    s('text', { class: 'rtitle', x: MOD_X + MOD_W / 2, y: MOD_TOP - 10, 'text-anchor': 'middle' }, `โมดูลรีเลย์ ${n} ช่อง (5V)`),
  );
  const modPin = (y, label) => mod.append(
    s('circle', { class: 'rpin', cx: MOD_X + 14, cy: y, r: 5 }),
    s('text', { class: 'rpin-label', x: MOD_X + 26, y: y + 4 }, label));
  modPin(vccY, 'VCC');
  modPin(gndY, 'GND');
  for (let k = 0; k < n; k++) {
    const y = chY(k);
    modPin(y, `IN${k + 1}`);
    mod.append(
      s('rect', { class: 'relay-cube', x: MOD_X + 68, y: y - 22, width: 104, height: 44, rx: 3 }),
      s('text', { class: 'cube-text', x: MOD_X + 120, y: y - 3, 'text-anchor': 'middle' }, 'SRD-05VDC'),
      s('text', { class: 'cube-text', x: MOD_X + 120, y: y + 11, 'text-anchor': 'middle' }, `K${k + 1}`),
      s('rect', { class: 'terminal', x: MOD_X + 180, y: y - 26, width: 32, height: 52, rx: 3 }),
    );
    for (const [dy, t] of [[-16, 'NO'], [0, 'COM'], [16, 'NC']]) {
      mod.append(
        s('circle', { class: 'screw', cx: MOD_X + 196, cy: y + dy, r: 5.5 }),
        s('text', { class: 'term-label', x: MOD_X + 218, y: y + dy + 3 }, t));
    }
  }
  svg.append(mod);

  // ---- mains side: COM -> L, NO -> load -> N ----
  const mains = s('g', { class: 'w-mains' });
  const busTop = chY(0) - 34, busBottom = MOD_BOTTOM + 20;
  for (let k = 0; k < n; k++) {
    const y = chY(k);
    const comX = MOD_X + 196;
    const loadY = y - 16;
    const name = opts.names?.[k + 1];
    mains.append(
      s('polyline', { class: 'ac l', points: `${comX + 6},${y} ${L_BUS},${y}` }),
      s('polyline', { class: 'ac l', points: `${comX + 6},${loadY} ${LOAD_X - 15},${loadY}` }),
      // load -> N, hopping over the L bus
      s('path', { class: 'ac n', d: `M${LOAD_X + 15} ${loadY}H${L_BUS - 6}a6 6 0 0 1 12 0H${N_BUS}` }),
      fanIcon(LOAD_X, loadY),
      s('text', { class: 'load-label', x: LOAD_X, y: loadY - 21, 'text-anchor': 'middle' }, name ? `${name}` : `โหลด CH${k + 1}`),
      s('circle', { class: 'joint l', cx: L_BUS, cy: y, r: 3.5 }),
      s('circle', { class: 'joint n', cx: N_BUS, cy: loadY, r: 3.5 }),
    );
  }
  mains.append(
    s('line', { class: 'bus l', x1: L_BUS, y1: busTop, x2: L_BUS, y2: busBottom }),
    s('line', { class: 'bus n', x1: N_BUS, y1: busTop, x2: N_BUS, y2: busBottom }),
    s('text', { class: 'bus-label l', x: L_BUS, y: busBottom + 26, 'text-anchor': 'middle' }, 'L'),
    s('text', { class: 'bus-label n', x: N_BUS, y: busBottom + 26, 'text-anchor': 'middle' }, 'N'),
    s('text', { class: 'mains-note', x: (L_BUS + N_BUS) / 2, y: busTop - 12, 'text-anchor': 'middle' }, 'ไฟบ้าน 220V AC'),
  );
  svg.append(mains);

  // ---- low-voltage wires (drawn last so they sit on top) ----
  const wireLayer = s('g', { class: 'w-wires' });
  for (const w of wires) {
    const y = pinY(w.idx);
    let pts;
    if (w.side === 'R') {
      const start = RX + 20 + TAG_W;
      pts = [[start, y], [w.lane, y], [w.lane, w.ty], [MOD_X + 14, w.ty]];
    } else {
      const start = LX - 20 - TAG_W;
      pts = [[start, y], [w.lx, y], [w.lx, w.by], [w.lane, w.by], [w.lane, w.ty], [MOD_X + 14, w.ty]];
    }
    const points = pts.map(p => p.join(',')).join(' ');
    wireLayer.append(s('g', { class: `wire ${w.cls || ''}`, 'data-ch': w.ch ?? '' },
      s('title', {}, w.title),
      s('polyline', { class: 'halo', points }),
      s('polyline', { class: 'core', points, style: `stroke:${w.color}` }),
      s('circle', { class: 'end', cx: MOD_X + 14, cy: w.ty, r: 4, style: `fill:${w.color}` }),
    ));
  }
  svg.append(wireLayer);

  if (sensor) root.append(drawSensor(OFF));
  container.replaceChildren(root);
}

// ---- SHT31 module (drawn in un-shifted coordinates above the board) ----
const SENSOR_SPACE = 170;
const S_X = 432, S_W = 168, S_PIN_Y = SENSOR_SPACE - 40;
const SCL_COLOR = '#a855f7', SDA_COLOR = '#eab308';
// Lanes go right-to-left from the lowest header pin, so the three right-side wires never cross each other.
const SENSOR_WIRES = [
  { pin: 'VIN', label: '3V3', side: 'L', idx: 0, x: S_X + 24, color: RED, title: '3V3 (บอร์ด) → VIN ของ SHT31 (ห้ามต่อ 5V)' },
  { pin: 'GND', label: 'GND', side: 'R', idx: 0, x: S_X + 60, color: BLACK, cls: 'gnd', title: 'GND (บอร์ด) → GND ของ SHT31' },
  { pin: 'SCL', label: 'GPIO22', side: 'R', idx: 2, x: S_X + 96, color: SCL_COLOR, title: 'GPIO22 → SCL ของ SHT31 (I²C clock)' },
  { pin: 'SDA', label: 'GPIO21', side: 'R', idx: 5, x: S_X + 132, color: SDA_COLOR, title: 'GPIO21 → SDA ของ SHT31 (I²C data)' },
];

function drawSensor(off) {
  const g = s('g', { class: 'w-sensor' });
  const top = 22;
  g.append(
    s('rect', { class: 'spcb', x: S_X, y: top, width: S_W, height: S_PIN_Y - top + 14, rx: 8 }),
    s('circle', { class: 'shole', cx: S_X + 24, cy: top + 26, r: 13 }),
    s('text', { class: 'stitle', x: S_X + 48, y: top + 31 }, 'SHT31'),
    s('rect', { class: 'schip', x: S_X + 128, y: top + 14, width: 24, height: 24, rx: 3 }),
    s('text', { class: 'ssub', x: S_X + S_W / 2, y: top + 56, 'text-anchor': 'middle' }, 'อุณหภูมิ / ความชื้น · I²C'),
    s('text', { class: 'rtitle', x: S_X + S_W + 12, y: top + 30 }, 'เซ็นเซอร์ SHT31 (3.3V)'),
  );
  const layer = s('g', { class: 'w-wires' });
  for (const w of SENSOR_WIRES) {
    g.append(
      s('circle', { class: 'rpin', cx: w.x, cy: S_PIN_Y, r: 5 }),
      s('text', { class: 'rpin-label', x: w.x, y: S_PIN_Y - 10, 'text-anchor': 'middle' }, w.pin));
    const y = off + pinY(w.idx);
    let pts;
    if (w.side === 'L') {
      const start = LX - 20 - TAG_W, laneX = start - 14, overY = off - 10;
      pts = [[start, y], [laneX, y], [laneX, overY], [w.x, overY], [w.x, S_PIN_Y]];
    } else {
      pts = [[RX + 20 + TAG_W, y], [w.x, y], [w.x, S_PIN_Y]];
    }
    const points = pts.map(p => p.join(',')).join(' ');
    layer.append(s('g', { class: `wire ${w.cls || ''}` },
      s('title', {}, w.title),
      s('polyline', { class: 'halo', points }),
      s('polyline', { class: 'core', points, style: `stroke:${w.color}` }),
      s('circle', { class: 'end', cx: w.x, cy: S_PIN_Y, r: 4, style: `fill:${w.color}` })));
  }
  g.append(layer);
  return g;
}

/** Connection table rows matching the diagram. */
export function wiringTable(pins, sensor = false) {
  const row = (color, from, to, note) => el('tr', {},
    el('td', {}, el('span', { class: 'swatch', style: `background:${color}` })),
    el('td', { class: 'mono' }, from), el('td', {}, '→'), el('td', { class: 'mono' }, to), el('td', { class: 'muted' }, note));
  return el('table', { class: 'pinmap wiring-table' },
    el('thead', {}, el('tr', {}, el('th', {}), el('th', {}, 'ESP32-DevKitC'), el('th', {}), el('th', {}, 'ต่อไปที่'), el('th', {}, 'หมายเหตุ'))),
    el('tbody', {},
      row(RED, '5V (J2 ขาที่ 19)', 'รีเลย์ VCC / DC+', 'ไฟเลี้ยงคอยล์รีเลย์'),
      row('#1f2328', sensor ? 'GND (J3 ขาที่ 7)' : 'GND (J3 ขาที่ 1)', 'รีเลย์ GND / DC-', 'กราวด์ร่วม'),
      ...pins.map((g, k) => row(wireColor(k, sensor),`GPIO${g} (${J2.includes(g) ? `J2 ขาที่ ${J2.indexOf(g) + 1}` : `J3 ขาที่ ${J3.indexOf(g) + 1}`})`, `รีเลย์ IN${k + 1}`, `สั่งรีเลย์ช่อง ${k + 1}`)),
      ...(sensor ? [
        row(RED, '3V3 (J2 ขาที่ 1)', 'SHT31 VIN', 'ไฟเลี้ยงเซ็นเซอร์ 3.3V (ห้ามใช้ 5V)'),
        row('#1f2328', 'GND (J3 ขาที่ 1)', 'SHT31 GND', 'กราวด์'),
        row(SCL_COLOR, 'GPIO22 (J3 ขาที่ 3)', 'SHT31 SCL', 'I²C clock'),
        row(SDA_COLOR, 'GPIO21 (J3 ขาที่ 6)', 'SHT31 SDA', 'I²C data'),
      ] : []),
    ));
}
