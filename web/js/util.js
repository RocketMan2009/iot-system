// Shared helpers

let toastTimer;
export function toast(msg, ms = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

export function setPill(el, text, cls) {
  el.textContent = text;
  el.className = `pill ${cls}`;
}

export function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) ?? 'null');
    localStorage.setItem(key, JSON.stringify(value));
  } catch { return null; }
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

export function appendLog(pre, text, cls) {
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  const line = document.createElement('span');
  if (cls) line.className = cls;
  line.textContent = text.endsWith('\n') ? text : text + '\n';
  pre.append(line);
  while (pre.childNodes.length > 1500) pre.firstChild.remove();
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

export function fmtUptime(s) {
  s = Number(s) || 0;
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

// USB-UART bridges used on ESP32 boards. Filtering the picker hides Bluetooth "COM" ports,
// which are easy to pick by mistake and can't talk to the board.
export const USB_SERIAL_FILTERS = [
  { usbVendorId: 0x10c4 },  // Silicon Labs CP210x (ESP32-DevKitC)
  { usbVendorId: 0x1a86 },  // WCH CH340 / CH9102
  { usbVendorId: 0x0403 },  // FTDI
  { usbVendorId: 0x067b },  // Prolific PL2303
  { usbVendorId: 0x303a },  // Espressif native USB (S2/S3/C3/C6)
];

// Turn a Web Serial open() failure into something the user can act on.
export function portErrorHint(err) {
  const msg = err?.message || String(err);
  if (err?.name === 'NetworkError' || /Failed to open serial port/i.test(msg))
    return 'พอร์ตถูกโปรแกรมอื่นใช้อยู่ — ปิด Serial Monitor ของ Arduino IDE / PlatformIO / PuTTY หรือแท็บเบราว์เซอร์อื่นที่เปิดหน้านี้ แล้วลองใหม่ (ถ้ายังไม่ได้ ให้ถอดสาย USB แล้วเสียบใหม่)';
  if (err?.name === 'InvalidStateError')
    return 'พอร์ตนี้เปิดอยู่แล้วในหน้านี้ — กด “ปิดพอร์ต” ก่อน หรือรีเฟรชหน้า';
  return msg;
}

// Only one feature may own the USB serial port at a time.
export const serialLock = {
  owner: null,
  acquire(name) {
    if (this.owner && this.owner !== name) {
      toast(`พอร์ต USB ถูกใช้งานโดยแท็บ "${this.owner}" อยู่ — ปิดพอร์ตก่อน`);
      return false;
    }
    this.owner = name;
    return true;
  },
  release(name) { if (this.owner === name) this.owner = null; },
};
