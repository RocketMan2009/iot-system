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
