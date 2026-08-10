import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const stateDir = path.resolve(process.env.AGENTWORKS_STATE_DIR || '.agentworks');
const envFile = path.join(stateDir, 'config', 'master.env');
const values = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/).filter(line => line.includes('=')).map(line => {
  const index = line.indexOf('=');
  return [line.slice(0, index), line.slice(index + 1)];
}));
const base = `http://127.0.0.1:${values.MASTER_PORT || '18080'}`;
const startedAt = Date.now();

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function request(route, { cookie, method = 'GET', body, expected = [200] } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value = null;
  if (text) {
    try { value = JSON.parse(text); }
    catch { value = { text }; }
  }
  if (!expected.includes(response.status)) throw new Error(`${method} ${route} failed (${response.status}): ${value?.error || text.slice(0, 300)}`);
  return { response, value };
}

async function login(email, password) {
  const { response } = await request('/api/login', { method: 'POST', body: { email, password } });
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error(`login for ${email} did not return a session cookie`);
  return cookie;
}

async function waitFor(description, probe, { timeoutMs = 40 * 60_000, intervalMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      last = result;
      if (result) return result;
    } catch (error) { last = error; }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${description}${last instanceof Error ? `: ${last.message}` : ''}`);
}

async function adminCells(cookie) {
  return (await request('/api/admin/cells', { cookie })).value.cells;
}

async function waitCellReady(cookie, cellId) {
  return waitFor(`${cellId} to become ready`, async () => {
    const cell = (await adminCells(cookie)).find(item => item.id === cellId);
    return cell?.status === 'running' && cell?.agentsStatus === 'ready' ? cell : false;
  });
}

async function ensureSession(cookie, cell, alias) {
  const workspace = (await request(`/api/cells/${cell.id}/workspace`, { cookie })).value;
  const cwd = workspace.defaultPath;
  const model = workspace.models?.claude?.find(item => item.id === 'haiku')?.id || workspace.models?.claude?.[0]?.id;
  if (!cwd || !model) throw new Error(`${cell.id} does not expose a Claude workspace/model`);
  const sessions = (await request(`/api/cells/${cell.id}/sessions`, { cookie })).value.sessions;
  const existing = sessions.find(item => item.alias === alias && item.harness === 'claude' && item.cwd === cwd && item.model === model);
  if (existing) return existing;
  return (await request(`/api/cells/${cell.id}/sessions`, {
    cookie,
    method: 'POST',
    expected: [201],
    body: { title: alias, alias, harness: 'claude', cwd, model, effort: 'low' },
  })).value.session;
}

async function waitSessionReady(cookie, sessionUuid) {
  return waitFor(`${sessionUuid} to become ready`, async () => {
    const value = (await request(`/api/sessions/${sessionUuid}/messages`, { cookie })).value;
    return value.session.status === 'ready' ? value : false;
  });
}

async function directTurn(cookie, session, label) {
  const before = await waitSessionReady(cookie, session.session_uuid);
  const priorAssistantIds = new Set(before.messages.filter(message => message.role === 'assistant').map(message => message.id));
  const expected = `${label.toLowerCase().replaceAll('_', ' ')} check passed`;
  await request(`/api/sessions/${session.session_uuid}/messages`, {
    cookie,
    method: 'POST',
    expected: [202],
    body: { content: `This is an authorized Agentworks E2E health check. Confirm success using the sentence: ${expected}.` },
  });
  await waitFor(`${label} direct Claude reply`, async () => {
    const value = (await request(`/api/sessions/${session.session_uuid}/messages`, { cookie })).value;
    const reply = value.messages.find(message => message.role === 'assistant'
      && !priorAssistantIds.has(message.id)
      && message.content.toLowerCase().includes(expected));
    if (reply) return reply;
    if (value.session.status === 'error') throw new Error(`${label} session entered error state`);
    return false;
  });
  return expected;
}

async function interSessionWake(cookie, source, target, label) {
  const expected = `${label.toLowerCase().replaceAll('_', ' ')} check passed`;
  const message = (await request('/api/inter-session/messages', {
    cookie,
    method: 'POST',
    expected: [202],
    body: {
      source: source.session_uuid,
      target: target.session_uuid,
      content: `This is an authorized Agentworks E2E health check. Confirm success using the sentence: ${expected}.`,
      expectReply: false,
      idempotencyKey: `e2e:${label}:${crypto.randomUUID()}`,
    },
  })).value.message;
  await waitFor(`${label} durable acknowledgement`, async () => {
    const messages = (await request('/api/inter-session/messages', { cookie })).value.messages;
    const current = messages.find(item => item.id === message.id);
    if (current?.status === 'failed' || current?.status === 'expired') throw new Error(`${label} delivery ${current.status}: ${current.lastError || 'unknown error'}`);
    return current?.status === 'acknowledged'
      && String(current.result?.answer || '').toLowerCase().includes(expected) ? current : false;
  }, { timeoutMs: 50 * 60_000 });
  return expected;
}

const health = (await request('/healthz')).value;
if (!health.ok || health.workers !== 1) throw new Error(`expected one healthy Worker, got ${JSON.stringify(health)}`);

const adminCookie = await login(values.MASTER_EMAIL, values.MASTER_PASSWORD);
const alphaCookie = await login(values.TENANT_ALPHA_EMAIL, values.TENANT_ALPHA_PASSWORD);
const overview = (await request('/api/overview', { cookie: adminCookie })).value;
if (overview.user.role !== 'superadmin' || overview.workers.length !== 1) throw new Error('superadmin/Worker scope mismatch');

const crossTenantDenied = await request('/api/cells/cell-beta/sessions', { cookie: alphaCookie, expected: [404] });
if (crossTenantDenied.response.status !== 404) throw new Error('cross-tenant isolation was not enforced');

let cells = await adminCells(adminCookie);
for (const id of ['cell-alpha', 'cell-beta']) await waitCellReady(adminCookie, id);

const tenantList = (await request('/api/admin/tenants', { cookie: adminCookie })).value.tenants;
if (!tenantList.some(item => item.slug === 'win-e2e')) {
  await request('/api/admin/tenants', {
    cookie: adminCookie,
    method: 'POST',
    expected: [201],
    body: {
      slug: 'win-e2e', displayName: 'Windows E2E tenant', email: 'win-e2e@agentworks.local',
      password: crypto.randomBytes(24).toString('base64url'),
      desiredVcpus: 1, maxVcpus: 2, desiredMemoryMib: 2048, maxMemoryMib: 4096,
    },
  });
}
const gammaCell = await waitCellReady(adminCookie, 'cell-win-e2e');
cells = await adminCells(adminCookie);
const alphaCell = cells.find(item => item.id === 'cell-alpha');
const betaCell = cells.find(item => item.id === 'cell-beta');
const masterCell = cells.find(item => item.kind === 'master');
if (!alphaCell || !betaCell || !gammaCell || !masterCell) throw new Error('required E2E cells are missing');

const alphaSession = await ensureSession(adminCookie, alphaCell, 'win-alpha-claude');
const betaSession = await ensureSession(adminCookie, betaCell, 'win-beta-claude');
const gammaSession = await ensureSession(adminCookie, gammaCell, 'win-gamma-claude');
const masterSession = await ensureSession(adminCookie, masterCell, 'win-master-claude');

for (const [session, label] of [
  [alphaSession, 'WINDOWS_ALPHA_DIRECT'],
  [betaSession, 'WINDOWS_BETA_DIRECT'],
  [gammaSession, 'WINDOWS_GAMMA_DIRECT'],
  [masterSession, 'WINDOWS_MASTER_DIRECT'],
]) await directTurn(adminCookie, session, label);

await request(`/api/cells/${betaCell.id}/actions`, {
  cookie: adminCookie,
  method: 'POST',
  body: { action: 'stop' },
});
await waitFor('beta VM to stop', async () => {
  const cell = (await adminCells(adminCookie)).find(item => item.id === betaCell.id);
  return cell?.status === 'stopped' ? cell : false;
});
await interSessionWake(adminCookie, alphaSession, betaSession, 'WINDOWS_OFFLINE_VM_WAKE');
await waitCellReady(adminCookie, betaCell.id);
await interSessionWake(adminCookie, betaSession, masterSession, 'WINDOWS_TENANT_TO_MASTER');
await interSessionWake(adminCookie, masterSession, gammaSession, 'WINDOWS_MASTER_TO_TENANT');

const directory = (await request('/api/inter-session/directory', { cookie: adminCookie })).value.sessions;
for (const session of [alphaSession, betaSession, gammaSession, masterSession]) {
  if (!directory.some(item => item.sessionUuid === session.session_uuid || item.session_uuid === session.session_uuid)) {
    throw new Error(`session ${session.alias} is absent from the authoritative directory`);
  }
}

console.log('Windows Master API: ok');
console.log('Existing tenant isolation: ok');
console.log('New tenant + Hyper-V VM: ok');
console.log('Alpha/Beta/Gamma Claude sessions: ok');
console.log('Master Claude session: ok');
console.log('Stopped VM auto-wake: ok');
console.log('Tenant -> Master messaging: ok');
console.log('Master -> Tenant messaging: ok');
console.log(`Elapsed seconds: ${Math.round((Date.now() - startedAt) / 1000)}`);
