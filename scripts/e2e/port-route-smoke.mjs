import fs from 'node:fs';
import path from 'node:path';

const action = process.argv[2];
if (!['open', 'close'].includes(action)) throw new Error('usage: port-route-smoke.mjs open|close');
const stateDir = path.resolve(process.env.AGENTWORKS_STATE_DIR || '.agentworks');
const recordFile = path.join(stateDir, 'e2e', 'windows-port-route.json');
const values = Object.fromEntries(fs.readFileSync(path.join(stateDir, 'config', 'master.env'), 'utf8')
  .split(/\r?\n/).filter(line => line.includes('=')).map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
const base = `http://127.0.0.1:${values.MASTER_PORT || '18080'}`;
const login = await fetch(`${base}/api/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: values.MASTER_EMAIL, password: values.MASTER_PASSWORD }),
});
if (!login.ok) throw new Error(`Master login failed (${login.status})`);
const cookie = login.headers.get('set-cookie')?.split(';')[0];
async function request(route, { method = 'GET', body, expected = [200] } = {}) {
  const response = await fetch(`${base}${route}`, {
    method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) : null;
  if (!expected.includes(response.status)) throw new Error(`${method} ${route} failed (${response.status}): ${value?.error || text}`);
  return value;
}

if (action === 'open') {
  await request('/api/admin/cells/cell-win-e2e/exec', {
    method: 'POST',
    body: {
      command: 'docker rm -f agentworks-e2e-http >/dev/null 2>&1 || true; docker run -d --name agentworks-e2e-http -p 18081:80 nginx:alpine; for n in 1 2 3 4 5 6 7 8 9 10; do curl -fsS http://127.0.0.1:18081/ >/dev/null && exit 0; sleep 1; done; exit 1',
      timeoutSeconds: 120,
    },
  });
  const value = await request('/api/admin/ports', {
    method: 'POST', expected: [201],
    body: { cellId: 'cell-win-e2e', guestPort: 18081, hostPort: 20000, bindAddress: '0.0.0.0' },
  });
  fs.mkdirSync(path.dirname(recordFile), { recursive: true });
  fs.writeFileSync(recordFile, `${JSON.stringify({ routeId: value.route.id, hostPort: 20000 })}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, action, routeId: value.route.id, hostPort: 20000 }));
} else {
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  await request(`/api/admin/ports/${record.routeId}`, { method: 'DELETE', expected: [200] });
  await request('/api/admin/cells/cell-win-e2e/exec', {
    method: 'POST', body: { command: 'docker rm -f agentworks-e2e-http >/dev/null 2>&1 || true', timeoutSeconds: 30 },
  });
  fs.rmSync(recordFile, { force: true });
  console.log(JSON.stringify({ ok: true, action, routeId: record.routeId, revoked: true }));
}
