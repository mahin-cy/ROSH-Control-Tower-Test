// One-off diagnostic (not part of the tool suite): logs in as the seeded
// admin, connects a socket.io client exactly like the browser does, and
// prints the vehicle-list-snapshot the UI would render. Usage:
//   node tools/check-vehicle-snapshot.mjs [backendUrl]
import { io } from 'socket.io-client';
import { readFileSync } from 'node:fs';

const backendUrl = process.argv[2] ?? 'http://localhost:3000';

// Pull the seeded admin creds straight from docker/.env (gitignored) so
// nothing secret is hardcoded here.
const envFile = readFileSync(new URL('../docker/.env', import.meta.url), 'utf8');
const env = Object.fromEntries(
  envFile
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);
const email = env.SEED_ADMIN_EMAIL;
const password = env.SEED_ADMIN_PASSWORD;
if (!email || !password) {
  console.error('SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not found in docker/.env');
  process.exit(1);
}

const loginRes = await fetch(`${backendUrl}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password })
});
if (!loginRes.ok) {
  console.error(`login failed: HTTP ${loginRes.status}`, await loginRes.text());
  process.exit(1);
}
const cookie = loginRes.headers.get('set-cookie')?.split(';')[0];
if (!cookie) {
  console.error('no session cookie in login response');
  process.exit(1);
}
console.log('logged in as', email);

const socket = io(backendUrl, {
  path: '/socket.io',
  extraHeaders: { cookie },
  transports: ['websocket'],
  reconnection: false
});

socket.on('connect', () => console.log('socket connected'));
socket.on('connect_error', (err) => {
  console.error('socket auth failed:', err.message);
  process.exit(1);
});
socket.on('vehicle-list-snapshot', (sessions) => {
  console.log(`\nvehicle-list-snapshot: ${sessions.length} session(s)`);
  for (const s of sessions) {
    console.log(` - ${s.vin} | mac=${s.macId} | session=${s.sessionId} | status=${s.status}`);
  }
  socket.disconnect();
  process.exit(0);
});
socket.on('vehicle-update', (s) =>
  console.log(`vehicle-update: ${s.vin} | mac=${s.macId} | session=${s.sessionId} | status=${s.status}`)
);

setTimeout(() => {
  console.error('timed out waiting for snapshot');
  process.exit(1);
}, 10_000);
