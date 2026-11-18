// Interactive ESP32-DevKitC V4 (WROOM-32D) pinout: click safe GPIOs to assign relay channels.
// Header order is top (antenna end) -> bottom (USB end), pin 1 first.
import { el } from './util.js';

// Must match SAFE_PINS in firmware/src/main.cpp — the firmware re-validates anyway.
export const SAFE_PINS = [4, 13, 14, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33];
export const DEFAULT_PINS = [16, 17, 18, 19, 23, 25, 26, 27];

const J2 = ['3V3', 'EN', 36, 39, 34, 35, 32, 33, 25, 26, 27, 14, 12, 'GND', 13, 9, 10, 11, '5V'];   // left
const J3 = ['GND', 23, 22, 1, 3, 21, 'GND', 19, 18, 5, 17, 16, 4, 0, 2, 15, 8, 7, 6];             // right
const ALIAS = { 36: 'VP', 39: 'VN', 1: 'TX', 3: 'RX', 9: 'D2', 10: 'D3', 11: 'CMD', 8: 'D1', 7: 'D0', 6: 'CLK' };

// kind -> [css class, Thai reason shown in tooltip / legend]
const KINDS = {
  safe:    ['safe', 'ใช้ต่อรีเลย์ได้'],
  caution: ['caution', 'ใช้ได้ แต่มีข้อควรระวัง'],
  strap:   ['strap', 'strapping pin — มีผลตอนบูต ห้ามต่อรีเลย์'],
  flash:   ['flash', 'ต่อกับ SPI flash — ห้ามใช้เด็ดขาด'],
  input:   ['input', 'input only — ขับรีเลย์ไม่ได้'],
  uart:    ['uart', 'UART0 ใช้คุยกับคอมผ่าน USB'],
  power:   ['power', 'ขาไฟเลี้ยง / ควบคุม'],
};
const CAUTION_NOTE = {
  14: 'GPIO14 มีสัญญาณ PWM สั้น ๆ ตอนบูต รีเลย์อาจกระตุกครั้งเดียว',
  21: 'GPIO21 เป็น SDA ของ I²C โดยปกติ — เลือกได้ถ้าไม่ใช้เซนเซอร์ I²C',
  22: 'GPIO22 เป็น SCL ของ I²C โดยปกติ — เลือกได้ถ้าไม่ใช้เซนเซอร์ I²C',
};

function kindOf(p) {
  if (typeof p === 'string') return 'power';
  if ([6, 7, 8, 9, 10, 11].includes(p)) return 'flash';
  if ([0, 2, 5, 12, 15].includes(p)) return 'strap';
  if ([34, 35, 36, 39].includes(p)) return 'input';
  if ([1, 3].includes(p)) return 'uart';
  if (CAUTION_NOTE[p]) return 'caution';
  return 'safe';
}

const pinName = p => (typeof p === 'string' ? p : ALIAS[p] ? `${ALIAS[p]} (GPIO${p})` : `GPIO${p}`);

/** "J3 ขาที่ 12 (ขวา)" for a GPIO, or "" if it isn't on a header. */
export function headerPosition(gpio) {
  let i = J2.indexOf(gpio);
  if (i >= 0) return `J2 ขาที่ ${i + 1} (ซ้าย)`;
  i = J3.indexOf(gpio);
  return i >= 0 ? `J3 ขาที่ ${i + 1} (ขวา)` : '';
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...children) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const c of children) n.append(c);
  return n;
}

/**
 * Renders the board into `container`. Returns { getPins, setPins }.
 * opts.onChange(pins) fires after every user change.
 */
export function createPinPicker(container, opts = {}) {
  let pins = [...DEFAULT_PINS];
  const W = 540, H = 640, PITCH = 28, TOP = 64;
  const LX = 196, RX = 344;                       // header pin x positions

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'board', role: 'group', 'aria-label': 'ESP32-DevKitC pinout' });
  // board body, module, antenna, USB, buttons
  svg.append(
    s('rect', { class: 'pcb', x: 172, y: 16, width: 196, height: 604, rx: 10 }),
    s('rect', { class: 'module', x: 206, y: 26, width: 128, height: 168, rx: 4 }),
    s('path', { class: 'antenna', d: 'M220 40h100v10h-90v10h90v10h-90v10h90' }),
    s('rect', { class: 'shield', x: 214, y: 92, width: 112, height: 94, rx: 3 }),
    s('text', { x: 270, y: 132, class: 'chip-label', 'text-anchor': 'middle' }, 'ESP32'),
    s('text', { x: 270, y: 150, class: 'chip-sub', 'text-anchor': 'middle' }, 'WROOM-32D'),
    s('rect', { class: 'usb', x: 246, y: 600, width: 48, height: 32, rx: 3 }),
    s('text', { x: 270, y: 592, class: 'chip-sub', 'text-anchor': 'middle' }, 'micro-USB'),
    s('rect', { class: 'btn-hw', x: 214, y: 560, width: 22, height: 16, rx: 3 }),
    s('text', { x: 225, y: 554, class: 'tiny', 'text-anchor': 'middle' }, 'EN'),
    s('rect', { class: 'btn-hw', x: 304, y: 560, width: 22, height: 16, rx: 3 }),
    s('text', { x: 315, y: 554, class: 'tiny', 'text-anchor': 'middle' }, 'BOOT'),
    s('text', { x: LX, y: TOP - 22, class: 'tiny', 'text-anchor': 'middle' }, 'J2'),
    s('text', { x: RX, y: TOP - 22, class: 'tiny', 'text-anchor': 'middle' }, 'J3'),
  );

  const pinEls = new Map();   // gpio -> { g, badge, badgeText }
  const addPin = (p, i, side) => {
    const x = side === 'L' ? LX : RX;
    const y = TOP + i * PITCH;
    const kind = kindOf(p);
    const [cls, reason] = KINDS[kind];
    const clickable = kind === 'safe' || kind === 'caution';
    const tip = `${pinName(p)} — ${CAUTION_NOTE[p] || reason}`;
    const labelX = side === 'L' ? 162 : 378;        // just outside the PCB outline
    const anchor = side === 'L' ? 'end' : 'start';
    const badgeX = side === 'L' ? 14 : W - 62;

    const g = s('g', { class: `pin ${cls}${clickable ? ' clickable' : ''}`, 'data-gpio': typeof p === 'number' ? p : '' });
    g.append(
      s('title', {}, tip),
      s('rect', { class: 'hit', x: side === 'L' ? 70 : x - 12, y: y - 13, width: side === 'L' ? x + 12 - 70 : W - 70 - (x - 12), height: 26, rx: 6 }),
      s('circle', { class: 'pad', cx: x, cy: y, r: 8 }),
      s('text', { class: 'pin-label', x: labelX, y: y + 4, 'text-anchor': anchor }, typeof p === 'number' ? (ALIAS[p] ? `${ALIAS[p]}·${p}` : `${p}`) : p),
    );
    let badge = null, badgeText = null;
    if (clickable) {
      badge = s('rect', { class: 'badge', x: badgeX, y: y - 11, width: 48, height: 22, rx: 11 });
      badgeText = s('text', { class: 'badge-text', x: badgeX + 24, y: y + 4, 'text-anchor': 'middle' });
      g.append(badge, badgeText);
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', tip);
      const toggle = () => {
        pins = pins.includes(p) ? pins.filter(x => x !== p) : pins.length < SAFE_PINS.length ? [...pins, p] : pins;
        paint();
        opts.onChange?.(pins);
      };
      g.addEventListener('click', toggle);
      g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      pinEls.set(p, { g, badge, badgeText });
    }
    svg.append(g);
  };
  J2.forEach((p, i) => addPin(p, i, 'L'));
  J3.forEach((p, i) => addPin(p, i, 'R'));

  function paint() {
    for (const [gpio, { g, badgeText }] of pinEls) {
      const idx = pins.indexOf(gpio);
      g.classList.toggle('selected', idx >= 0);
      badgeText.textContent = idx >= 0 ? `CH${idx + 1}` : '';
    }
  }

  const legend = el('div', { class: 'pin-legend' },
    ...[['safe', 'เลือกได้'], ['caution', 'เลือกได้ (ระวัง)'], ['strap', 'strapping'], ['flash', 'flash ห้ามใช้'], ['input', 'input only'], ['uart', 'USB serial'], ['power', 'ไฟเลี้ยง']]
      .map(([k, t]) => el('span', { class: `lg ${k}` }, el('i'), t)));

  container.replaceChildren(svg, legend);
  paint();

  return {
    getPins: () => [...pins],
    setPins(list) {
      pins = (list || []).filter(p => SAFE_PINS.includes(p));
      paint();
    },
  };
}
