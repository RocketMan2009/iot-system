// Known MQTT broker providers: how the browser (WebSocket) and the board (MQTT/TCP) reach each one.
// Used by the dashboard's broker form and the USB settings' host auto-fill.

export const PROVIDERS = [
  {
    id: 'hivemq', name: 'HiveMQ Cloud',
    match: /\.hivemq\.cloud$/i,
    ws: { port: 8884, path: '/mqtt' }, mqtt: { port: 8883, tls: true },
    example: 'abc123.s1.eu.hivemq.cloud',
    where: 'console.hivemq.cloud → เลือก cluster → Overview (ชื่อ cluster)',
    account: 'HiveMQ → Access Management → Credentials',
    needsAuth: true,
  },
  {
    id: 'emqx', name: 'EMQX Cloud (Serverless)',
    match: /\.emqxsl\.(com|cn)$/i,
    ws: { port: 8084, path: '/mqtt' }, mqtt: { port: 8883, tls: true },
    example: 'abc123.ala.asia-southeast1.emqxsl.com',
    where: 'cloud-intl.emqx.com → Deployment → Overview หรือ Connection Guide (Address)',
    account: 'EMQX → Access Control → Authentication',
    needsAuth: true,
  },
  {
    id: 'lan', name: 'Mosquitto / broker ในบ้าน (LAN)',
    match: /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/,
    ws: { port: 9001, path: '', plain: true }, mqtt: { port: 1883, tls: false },
    example: '192.168.1.10',
    where: 'IP ของเครื่องที่รัน broker (ใช้ได้เฉพาะเปิดเว็บแบบ http:// ในวง LAN เดียวกัน)',
    account: 'ไฟล์ passwd ของ Mosquitto',
  },
  {
    id: 'public-hivemq', name: 'ทดสอบ: broker.hivemq.com (สาธารณะ)', public: true,
    match: /^broker\.hivemq\.com$/i, fixedHost: 'broker.hivemq.com',
    ws: { port: 8884, path: '/mqtt' }, mqtt: { port: 1883, tls: false },
  },
  {
    id: 'public-emqx', name: 'ทดสอบ: broker.emqx.io (สาธารณะ)', public: true,
    match: /^broker\.emqx\.io$/i, fixedHost: 'broker.emqx.io',
    ws: { port: 8084, path: '/mqtt' }, mqtt: { port: 1883, tls: false },
  },
  {
    id: 'public-mosquitto', name: 'ทดสอบ: test.mosquitto.org (สาธารณะ)', public: true,
    match: /^test\.mosquitto\.org$/i, fixedHost: 'test.mosquitto.org',
    ws: { port: 8081, path: '' }, mqtt: { port: 1883, tls: false },
  },
];

export const CUSTOM = {
  id: 'custom', name: 'อื่นๆ (กรอก WebSocket URL เอง)',
  where: 'หน้า console ของผู้ให้บริการ — มองหา “WebSocket over TLS” / “WSS” (มักเป็นพอร์ต 8084, 8884, 443 หรือ 8081 และ path /mqtt)',
  account: 'หน้าจัดการผู้ใช้ (Users / Credentials / Authentication) ของผู้ให้บริการ',
};

export const providerById = id => PROVIDERS.find(p => p.id === id) || CUSTOM;
export const providerForHost = host => PROVIDERS.find(p => p.match.test(host || '')) || null;

export function wsUrlFor(p, host) {
  const scheme = p.ws.plain && location.protocol !== 'https:' ? 'ws' : 'wss';
  return `${scheme}://${host}:${p.ws.port}${p.ws.path}`;
}

/** Board-side (TCP) settings for a broker reached at this WebSocket URL. */
export function boardBrokerFor(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const p = providerForHost(u.hostname);
  if (p) return { host: u.hostname, ...p.mqtt, provider: p };
  const tls = u.protocol === 'wss:';
  return { host: u.hostname, port: tls ? 8883 : 1883, tls, provider: null };
}

/** Pasted host / MQTT URL / partial WebSocket URL -> a working WebSocket URL for this provider. */
export function normalizeWsUrl(value, providerId) {
  let s = (value || '').trim();
  if (!s) return s;
  s = s.replace(/^mqtts?:\/\//i, 'wss://').replace(/^https?:\/\//i, 'wss://');
  const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (!hadScheme) s = (location.protocol === 'https:' ? 'wss://' : 'ws://') + s;
  let u;
  try { u = new URL(s); } catch { return s; }
  const p = providerForHost(u.hostname) || (providerId && providerId !== 'custom' && providerId !== 'lan' ? providerById(providerId) : null);
  if (p && p.id !== 'lan') return wsUrlFor(p, u.hostname);   // cloud brokers have exactly one WebSocket endpoint
  if (p?.id === 'lan' && !u.port) return wsUrlFor(p, u.hostname);
  return s;
}
