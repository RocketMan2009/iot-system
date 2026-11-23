import { initDashboard } from './mqtt-dashboard.js';
import { initProvision } from './provision.js';
import { initFlasher } from './flasher.js';
import { onPins } from './pins-state.js';
import { renderWiring, wiringTable } from './wiring.js';

// ---------- tabs ----------
const tabs = document.querySelectorAll('.tab');
function showTab(name) {
  tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  try { localStorage.setItem('hub.tab', name); } catch {}
}
tabs.forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
try { const saved = localStorage.getItem('hub.tab'); if (saved) showTab(saved); } catch {}

// ---------- feature detection ----------
if (!('serial' in navigator)) document.getElementById('serial-warning').hidden = false;

initDashboard();
initProvision();
initFlasher();

// ---------- overview: wiring follows the relay pin selection ----------
const $ = id => document.getElementById(id);
onPins(pins => {
  renderWiring($('ov-wiring'), pins);
  $('ov-wiring-table').replaceChildren(wiringTable(pins));
  $('ov-wiring-count').textContent = `รีเลย์ ${pins.length} ช่อง`;
});
$('ov-edit-pins').addEventListener('click', () => {
  showTab('provision');
  $('pin-picker').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
