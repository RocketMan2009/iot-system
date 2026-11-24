// Relay pin selection shared by the pin picker (USB tab) and the wiring diagrams (USB + overview tabs).
// Remembered per browser so the overview shows the last wiring you planned or read from a board.
// Also whether the optional SHT31 sensor (I2C on GPIO21/22) is drawn in the wiring diagrams.
import { store } from './util.js';
import { DEFAULT_PINS } from './pin-picker.js';

const KEY = 'hub.relayPins';
const SENSOR_KEY = 'hub.sensorWiring';
export const SENSOR_PINS = [21, 22];   // SDA, SCL
let pins = (store(KEY) || DEFAULT_PINS).slice();
let sensor = store(SENSOR_KEY) ?? true;
const listeners = new Set();
const notify = () => { for (const fn of listeners) fn(getPins()); };

export const getPins = () => pins.slice();
/** true when the SHT31 is wanted AND its pins are free (not used by a relay). */
export const sensorWired = () => sensor && !pins.some(p => SENSOR_PINS.includes(p));
export const getSensorWanted = () => sensor;

export function setPins(next) {
  if (next.join() === pins.join()) return;
  pins = next.slice();
  store(KEY, pins);
  notify();
}

export function setSensorWanted(on) {
  if (on === sensor) return;
  sensor = on;
  store(SENSOR_KEY, on);
  notify();
}

/** Calls fn now and on every change (pins or sensor). */
export function onPins(fn) {
  listeners.add(fn);
  fn(getPins());
}
