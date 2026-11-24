import { initDashboard } from './mqtt-dashboard.js';
import { initProvision } from './provision.js';
import { initFlasher } from './flasher.js';
import { onPins, sensorWired, getSensorWanted, setSensorWanted } from './pins-state.js';
import { renderWiring, wiringTable } from './wiring.js';
import { initWizard } from './wizard.js';
import { store } from './util.js';

// ---------- tabs ----------
const tabs = document.querySelectorAll('.tab');
function showTab(name) {
  tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  try { localStorage.setItem('hub.tab', name); } catch {}
}
tabs.forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
// first visit (never finished setup, never connected a broker): start with the guided setup
let savedTab = null;
try { savedTab = localStorage.getItem('hub.tab'); } catch {}
showTab(savedTab || (!store('hub.wizardDone') && !store('hub.mqtt') ? 'start' : 'dashboard'));

// ---------- feature detection ----------
if (!('serial' in navigator)) document.getElementById('serial-warning').hidden = false;

initDashboard();
initProvision();
initFlasher();
initWizard(document.getElementById('wizard'), showTab);

// ---------- overview: wiring follows the relay pin selection ----------
const $ = id => document.getElementById(id);
onPins(pins => {
  const sensor = sensorWired();
  renderWiring($('ov-wiring'), pins, { sensor });
  $('ov-wiring-table').replaceChildren(wiringTable(pins, sensor));
  $('ov-wiring-count').textContent = `รีเลย์ ${pins.length} ช่อง${sensor ? ' + SHT31' : ''}`;
  $('ov-sensor').checked = getSensorWanted();
  $('ov-sensor-note').hidden = !getSensorWanted() || sensor;
});
$('ov-sensor').addEventListener('change', e => setSensorWanted(e.target.checked));
$('ov-edit-pins').addEventListener('click', () => {
  showTab('provision');
  $('pin-picker').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
