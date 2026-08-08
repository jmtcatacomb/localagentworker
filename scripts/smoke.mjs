const base = `http://127.0.0.1:${process.env.MASTER_PORT}`;

async function login(email, password) {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`login failed: ${response.status}`);
  return response.headers.get('set-cookie').split(';')[0];
}

const health = await fetch(`${base}/healthz`).then(response => response.json());
if (!health.ok || health.workers < 1) throw new Error('Master or Worker is not healthy');

const adminCookie = await login(process.env.MASTER_EMAIL, process.env.MASTER_PASSWORD);
const admin = await fetch(`${base}/api/overview`, { headers: { cookie: adminCookie } }).then(response => response.json());
if (admin.user.role !== 'superadmin' || admin.cells.length !== 2) throw new Error('superadmin scope mismatch');

const tenantCookie = await login(process.env.TENANT_ALPHA_EMAIL, process.env.TENANT_ALPHA_PASSWORD);
const tenant = await fetch(`${base}/api/overview`, { headers: { cookie: tenantCookie } }).then(response => response.json());
if (tenant.user.role !== 'tenant' || tenant.cells.length !== 1 || tenant.cells[0].tenant_slug !== 'alpha') throw new Error('tenant scope mismatch');

const denied = await fetch(`${base}/api/cells/cell-beta/actions`, {
  method: 'POST', headers: { cookie: tenantCookie, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'start' }),
});
if (denied.status !== 404) throw new Error(`cross-tenant action was not denied: ${denied.status}`);

const workspace = await fetch(`${base}/api/cells/cell-alpha/workspace`, { headers: { cookie: tenantCookie } }).then(response => response.json());
if (!workspace.defaultPath || !Array.isArray(workspace.models?.codex) || !Array.isArray(workspace.models?.claude)) throw new Error('workspace description mismatch');

const directory = await fetch(`${base}/api/cells/cell-alpha/files?path=${encodeURIComponent(workspace.defaultPath)}`, { headers: { cookie: tenantCookie } }).then(response => response.json());
if (directory.path !== workspace.defaultPath || !Array.isArray(directory.items)) throw new Error('workspace browser mismatch');

for (const target of [
  `${base}/api/cells/cell-beta/files?path=/`,
  `${base}/api/cells/cell-beta/sessions`,
  `${base}/api/cells/cell-beta/usage`,
]) {
  const response = await fetch(target, { headers: { cookie: tenantCookie } });
  if (response.status !== 404) throw new Error(`cross-tenant workspace access was not denied: ${response.status}`);
}

const usageResponse = await fetch(`${base}/api/cells/cell-alpha/usage`, { headers: { cookie: tenantCookie } });
const usage = await usageResponse.json();
if (!usageResponse.ok || !usage.providers?.codex || !Array.isArray(usage.sessions) || !Array.isArray(usage.models)) {
  throw new Error('usage telemetry mismatch');
}

const messagingStatus = await fetch(`${base}/api/inter-session/status`, { headers: { cookie: tenantCookie } }).then(response => response.json());
const messagingDirectory = await fetch(`${base}/api/inter-session/directory`, { headers: { cookie: tenantCookie } }).then(response => response.json());
if (!messagingStatus.enabled || messagingStatus.bridge !== 'vm-mcp-outbox' || !Array.isArray(messagingDirectory.sessions)) {
  throw new Error('inter-session messaging mismatch');
}

console.log('Master auth: ok');
console.log('Tenant isolation: ok');
console.log('Worker connection: ok');
console.log('Workspace browser: ok');
console.log('Usage telemetry: ok');
console.log('Inter-session messaging: ok');
