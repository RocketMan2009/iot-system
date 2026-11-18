import { initDashboard } from './mqtt-dashboard.js';
import { initProvision } from './provision.js';
import { initFlasher } from './flasher.js';

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
