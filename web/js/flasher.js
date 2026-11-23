// Browser flasher using esptool-js (ROM bootloader protocol over Web Serial).
import { toast, setPill, appendLog, serialLock, USB_SERIAL_FILTERS, portErrorHint } from './util.js';

const ESPTOOL_URL = 'https://unpkg.com/esptool-js@0.4.5/bundle.js';
const LOCK = 'แฟลชเฟิร์มแวร์';
const IMAGE_MAGIC = 0xE9;
const $ = id => document.getElementById(id);

let busy = false;
let esptool = null;   // lazily imported module
let manifest = null;  // firmware/manifest.json produced by CI (absent when running locally)

export function initFlasher() {
  document.querySelectorAll('input[name="flash-mode"]').forEach(r =>
    r.addEventListener('change', () => {
      const split = document.querySelector('input[name="flash-mode"]:checked').value === 'split';
      $('flash-split').hidden = !split;
      $('flash-merged').hidden = split;
    }));
  $('flash-clear').addEventListener('click', () => $('flash-log').replaceChildren());
  if (!('serial' in navigator)) {
    $('flash-start').disabled = $('flash-erase-only').disabled = true;
    return;
  }
  $('flash-start').addEventListener('click', () => run('flash'));
  $('fw-flash-latest').addEventListener('click', () => run('latest'));
  loadManifest();
  $('flash-erase-only').addEventListener('click', () => run('erase'));
}

const log = (msg, cls) => appendLog($('flash-log'), msg, cls);
const terminal = { clean() {}, writeLine: d => log(d), write: d => log(d) };

function setProgress(pct, text) {
  $('flash-bar').style.width = `${pct}%`;
  $('flash-progress-text').textContent = text || '';
  emit({ type: 'progress', pct, text });
}

// ---------- API for the setup wizard ----------
const flashListeners = new Set();
const emit = e => flashListeners.forEach(fn => fn(e));
/** fn({type:'progress'|'done'|'error'|'cancel', pct?, text?, message?}) */
export const onFlash = fn => flashListeners.add(fn);
/** Must be called from a click handler (opens the USB port picker). */
export const flashLatest = () => run('latest');
export const hasHostedFirmware = () => !!manifest;

// ArrayBuffer -> "binary string" (format esptool-js 0.4 expects)
function toBinaryString(buf) {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return out;
}

async function loadManifest() {
  try {
    const res = await fetch('firmware/manifest.json', { cache: 'no-cache' });
    if (!res.ok) return;
    manifest = await res.json();
    $('fw-version').textContent = `v${manifest.version}`;
    $('fw-meta').textContent = `${manifest.chip} · ${(manifest.size / 1024).toFixed(0)} KB · build ${new Date(manifest.built).toLocaleString()}`;
    $('fw-latest').hidden = false;
  } catch { /* no hosted firmware: manual file upload only */ }
}

// Download the CI-built merged image and check its SHA-256 before it goes anywhere near the chip.
async function fetchLatestImage() {
  setProgress(0, 'กำลังดาวน์โหลดเฟิร์มแวร์…');
  const res = await fetch(`firmware/${manifest.file}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`ดาวน์โหลดไม่สำเร็จ (HTTP ${res.status})`);
  const buf = await res.arrayBuffer();
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  if (digest !== manifest.sha256) throw new Error('SHA-256 ของไฟล์ไม่ตรงกับ manifest — ยกเลิกการแฟลช');
  if (new Uint8Array(buf)[0x1000] !== IMAGE_MAGIC) throw new Error('ไฟล์เฟิร์มแวร์บนเว็บไม่ใช่ merged image ที่ถูกต้อง');
  log(`# downloaded ${manifest.file} v${manifest.version} (${buf.byteLength} bytes, sha256 ok)`);
  return [{ data: toBinaryString(buf), address: manifest.address ?? 0, name: manifest.file, size: buf.byteLength }];
}

async function collectImages() {
  const mode = document.querySelector('input[name="flash-mode"]:checked').value;
  const inputs = [...document.querySelectorAll(`#flash-${mode} input[type=file]`)];
  const images = [];
  for (const input of inputs) {
    const file = input.files[0];
    if (!file) continue;
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const address = parseInt(input.dataset.addr, 16);

    // Sanity checks: catch the classic "app image flashed at 0x0" mistake.
    if (mode === 'merged') {
      if (bytes[0] === IMAGE_MAGIC)
        throw new Error(`${file.name} เป็นไฟล์ image เดี่ยว (ไม่ใช่ merged.bin) — ใช้โหมด "แยกไฟล์" แล้ววางที่ 0x10000`);
      if (bytes.length > 0x1000 && bytes[0x1000] !== IMAGE_MAGIC)
        log(`! คำเตือน: ${file.name} ไม่มี bootloader ที่ 0x1000 — อาจไม่ใช่ merged.bin ของ ESP32`, 'err');
    } else if ((address === 0x1000 || address === 0x10000) && bytes[0] !== IMAGE_MAGIC) {
      throw new Error(`${file.name} ไม่ใช่ ESP image (magic byte ไม่ใช่ 0xE9) — ตรวจว่าวางไฟล์ถูกช่อง`);
    }
    if (address + bytes.length > 4 * 1024 * 1024) throw new Error(`${file.name} ใหญ่เกิน flash 4 MB`);
    images.push({ data: toBinaryString(buf), address, name: file.name, size: bytes.length });
  }
  if (mode === 'split' && images.length && !images.some(i => i.address === 0x10000))
    log('! คำเตือน: ไม่ได้เลือก firmware.bin (0x10000)', 'err');
  return images;
}

async function run(action) {
  if (busy) return;
  let images = [];
  if (action === 'flash') {
    try { images = await collectImages(); }
    catch (err) { toast(err.message, 6000); log(`! ${err.message}`, 'err'); return; }
    if (!images.length) return toast('เลือกไฟล์ .bin ก่อน');
  } else if (action === 'latest') {
    if (!manifest) return emit({ type: 'error', message: 'ยังไม่มีเฟิร์มแวร์บนเว็บนี้ (manifest.json ไม่พบ)' });
  } else if (!confirm('ลบข้อมูลทั้งหมดในแฟลช (เฟิร์มแวร์ + config)?')) {
    return;
  }
  if (!serialLock.acquire(LOCK)) return;

  busy = true;
  $('flash-start').disabled = $('flash-erase-only').disabled = $('fw-flash-latest').disabled = true;
  let transport = null;
  try {
    let port;
    try { port = await navigator.serial.requestPort({ filters: USB_SERIAL_FILTERS }); }
    catch { emit({ type: 'cancel' }); return; }   // user cancelled the picker (picker must open first, while the click still counts)
    if (action === 'latest') images = await fetchLatestImage();

    setPill($('flash-status'), 'Loading…', 'busy');
    esptool ??= await import(ESPTOOL_URL);
    transport = new esptool.Transport(port, true);
    const loader = new esptool.ESPLoader({
      transport,
      baudrate: Number($('flash-baud').value),
      romBaudrate: 115200,
      terminal,
    });

    setPill($('flash-status'), 'Connecting…', 'busy');
    setProgress(0, 'กำลังเข้าสู่ bootloader…');
    const chip = await loader.main();   // auto-reset into ROM bootloader + sync + stub
    log(`# chip: ${chip}`);
    if (!/ESP32(?!-(?:[SCH]\d|P4))/.test(chip)) log(`! คำเตือน: บอร์ดนี้คือ ${chip} แต่เฟิร์มแวร์ build สำหรับ ESP32 (esp32dev)`, 'err');

    if (action === 'erase' || $('flash-erase').checked) {
      setPill($('flash-status'), 'Erasing…', 'busy');
      setProgress(0, 'กำลังลบแฟลช (ประมาณ 10–20 วินาที)…');
      await loader.eraseFlash();
      log('# flash erased');
    }

    if (images.length) {
      setPill($('flash-status'), 'Flashing…', 'busy');
      const total = images.reduce((s, i) => s + i.size, 0);
      const done = new Array(images.length).fill(0);
      const t0 = performance.now();
      await loader.writeFlash({
        fileArray: images.map(({ data, address }) => ({ data, address })),
        flashSize: 'keep',
        flashMode: 'keep',
        flashFreq: 'keep',
        eraseAll: false,
        compress: true,
        reportProgress: (idx, written, size) => {
          done[idx] = (written / size) * images[idx].size;
          const pct = Math.min(100, (done.reduce((a, b) => a + b, 0) / total) * 100);
          setProgress(pct, `${images[idx].name} @ 0x${images[idx].address.toString(16)} — ${pct.toFixed(0)}%`);
        },
      });
      log(`# done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    }

    await loader.hardReset();
    setProgress(100, images.length ? 'แฟลชสำเร็จ — บอร์ดรีบูตแล้ว ไปแท็บ “ตั้งค่าบอร์ด” ต่อได้เลย' : 'ลบแฟลชเรียบร้อย');
    setPill($('flash-status'), 'Done', 'on');
    toast(images.length ? 'แฟลชสำเร็จ ✔' : 'ลบแฟลชเรียบร้อย ✔');
    emit({ type: 'done' });
  } catch (err) {
    console.error(err);
    setPill($('flash-status'), 'Failed', 'err');
    log(`! ${err.message || err}`, 'err');
    const hint = /open/i.test(err.message || '') || err.name === 'NetworkError' || err.name === 'InvalidStateError'
      ? portErrorHint(err)
      : 'ไม่สำเร็จ — ลองกดปุ่ม BOOT ค้างไว้ตอนเริ่มเชื่อมต่อ หรือลด baud rate';
    log(`! ${hint}`, 'err');
    toast(hint, 9000);
    emit({ type: 'error', message: hint });
  } finally {
    try { await transport?.disconnect(); } catch {}
    serialLock.release(LOCK);
    busy = false;
    $('flash-start').disabled = $('flash-erase-only').disabled = $('fw-flash-latest').disabled = false;
  }
}
