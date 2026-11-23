// Relay pin selection shared by the pin picker (USB tab) and the wiring diagrams (USB + overview tabs).
// Remembered per browser so the overview shows the last wiring you planned or read from a board.
import { store } from './util.js';
import { DEFAULT_PINS } from './pin-picker.js';

const KEY = 'hub.relayPins';
let pins = (store(KEY) || DEFAULT_PINS).slice();
const listeners = new Set();

export const getPins = () => pins.slice();

export function setPins(next) {
  if (next.join() === pins.join()) return;
  pins = next.slice();
  store(KEY, pins);
  for (const fn of listeners) fn(getPins());
}

/** Calls fn now and on every change. */
export function onPins(fn) {
  listeners.add(fn);
  fn(getPins());
}
