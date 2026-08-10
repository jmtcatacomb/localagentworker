import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ID_PATTERN = /^[A-Za-z0-9._-]{2,120}$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

function catalogFile(stateDir) { return path.join(stateDir, 'agentslack', 'infrastructures.json'); }
function bindingFile(stateDir) { return path.join(stateDir, 'agentslack', 'bindings.json'); }

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function writePrivate(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
  if (process.platform !== 'win32') await fs.chmod(file, 0o600);
}

function validateUrl(value) {
  const parsed = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('AgentSlack serverUrl must use http or https');
  return parsed.toString().replace(/\/$/, '');
}

function validateCatalog(value) {
  if (value?.version !== 1 || !Array.isArray(value.infrastructures)) throw new Error('AgentSlack infrastructure catalog requires version=1');
  const ids = new Set();
  for (const item of value.infrastructures) {
    if (!ID_PATTERN.test(item?.id || '') || ids.has(item.id)) throw new Error('AgentSlack infrastructure id is invalid or duplicated');
    ids.add(item.id);
    item.serverUrl = validateUrl(item.serverUrl);
    if (!SLUG_PATTERN.test(item.controlServerSlug || '') || typeof item.controlToken !== 'string' || item.controlToken.length < 20) {
      throw new Error(`AgentSlack infrastructure ${item.id} has invalid control-plane credentials`);
    }
    if (!Array.isArray(item.servers)) item.servers = [];
  }
  return value;
}

async function readCatalog(stateDir) {
  return validateCatalog(await readJson(catalogFile(stateDir), { version: 1, infrastructures: [] }));
}

function publicInfrastructure(item) {
  return {
    id: item.id, name: item.name || item.id, serverUrl: item.serverUrl,
    controlServerSlug: item.controlServerSlug,
    managedServers: (item.servers || []).map(server => ({ slug: server.slug, createdAt: server.createdAt || null })),
  };
}

async function api(item, serverSlug, pathname, { method = 'GET', body, token = item.controlToken, expected = [200] } = {}) {
  const response = await fetch(new URL(pathname, item.serverUrl), {
    method,
    headers: {
      accept: 'application/json', 'content-type': 'application/json',
      'x-agentslack-server': serverSlug,
      'x-agentslack-client-session-id': `agentworks-host-${item.id}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const value = await response.json().catch(() => ({}));
  if (!expected.includes(response.status)) throw new Error(`AgentSlack ${method} ${pathname} failed (${response.status}): ${value.error || 'request_failed'}`);
  return value;
}

export async function registerAgentSlackInfrastructure(stateDir, { infrastructureId, name, credential }) {
  if (!ID_PATTERN.test(infrastructureId || '')) throw new Error('infrastructureId must contain 2-120 letters, digits, dot, underscore, or hyphen');
  const source = credential || {};
  const serverUrl = validateUrl(source.serverUrl);
  const controlServerSlug = String(source.controlServerSlug || source.serverSlug || '').trim().toLowerCase();
  const controlToken = String(source.controlToken || source.token || '').trim();
  if (!SLUG_PATTERN.test(controlServerSlug) || controlToken.length < 20) throw new Error('credential file requires serverUrl, serverSlug/controlServerSlug, and token/controlToken');
  const candidate = { id: infrastructureId, name: String(name || infrastructureId).slice(0, 120), serverUrl, controlServerSlug, controlToken, servers: [] };
  const me = await api(candidate, controlServerSlug, '/api/v1/me');
  if (me.agent?.systemRole !== 'admin') throw new Error('AgentSlack control-plane credential is not an admin identity');
  const catalog = await readCatalog(stateDir);
  const current = catalog.infrastructures.find(item => item.id === infrastructureId);
  candidate.servers = current?.servers || [];
  catalog.infrastructures = [...catalog.infrastructures.filter(item => item.id !== infrastructureId), candidate];
  await writePrivate(catalogFile(stateDir), catalog);
  return publicInfrastructure(candidate);
}

export async function importAgentSlackInfrastructure(stateDir, { infrastructureId, name, credentialFile }) {
  const sourcePath = path.resolve(String(credentialFile || ''));
  const credential = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
  return registerAgentSlackInfrastructure(stateDir, { infrastructureId, name, credential });
}

export async function listAgentSlackInfrastructures(stateDir) {
  const catalog = await readCatalog(stateDir);
  return { infrastructures: catalog.infrastructures.map(publicInfrastructure) };
}

export async function listAgentSlackServers(stateDir, infrastructureId) {
  const catalog = await readCatalog(stateDir);
  const item = catalog.infrastructures.find(entry => entry.id === infrastructureId);
  if (!item) throw new Error(`Unknown AgentSlack infrastructure: ${infrastructureId}`);
  const result = await api(item, item.controlServerSlug, '/api/v1/servers', { token: null });
  const managed = new Set((item.servers || []).map(server => server.slug));
  return { infrastructure: publicInfrastructure(item), servers: (result.servers || []).map(server => ({ ...server, credentialManaged: managed.has(server.slug) })) };
}

export async function createAgentSlackServer(stateDir, infrastructureId, input) {
  const catalog = await readCatalog(stateDir);
  const item = catalog.infrastructures.find(entry => entry.id === infrastructureId);
  if (!item) throw new Error(`Unknown AgentSlack infrastructure: ${infrastructureId}`);
  const slug = String(input.slug || '').trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) throw new Error('AgentSlack logical Server slug is invalid');
  const existing = (item.servers || []).find(server => server.slug === slug);
  if (existing) return { server: { slug }, credentialManaged: true, created: false };
  const result = await api(item, item.controlServerSlug, '/api/v1/servers', {
    method: 'POST', expected: [201, 409],
    body: {
      slug, name: String(input.name || slug).slice(0, 120),
      description: String(input.description || `Agentworks managed collaboration Server for ${slug}.`).slice(0, 4000),
      iconText: String(input.iconText || 'AW').slice(0, 4),
      initialTags: [{
        slug: 'agentworks', displayName: 'Agentworks',
        description: 'Agentworks sessions, durable wake delivery, and multi-agent collaboration.',
      }],
      adminHandle: String(input.adminHandle || `agentworks-${slug}-admin`).slice(0, 64),
    },
  });
  const created = result.error !== 'server_slug_exists';
  let adminToken = String(result.bootstrap?.token || '');
  let adminHandle = result.bootstrap?.admin?.handle || null;
  // Older AgentSlack deployments create logical Servers without returning a
  // scoped bootstrap admin. A regular scoped sender identity is sufficient for
  // the Agentworks control-plane smoke/wake DMs; session identities themselves
  // are still independently registered below. This also recovers a Server
  // created by a previous interrupted import without deleting it.
  if (adminToken.length < 20) {
    const preferred = String(input.adminHandle || `agentworks-${slug}-controller`).slice(0, 55);
    const register = candidate => api(item, slug, '/api/v1/agents/register', {
      method: 'POST', expected: [201], token: null,
      body: {
        handle: candidate, displayName: `Agentworks ${slug} controller`,
        bio: `Agentworks managed sender for logical Server ${slug}, durable wake tests, and exact-session collaboration.`,
        capabilities: ['Agentworks enrollment control', 'durable wake test sender'], tags: ['agentworks'],
      },
    });
    try {
      const registered = await register(preferred);
      adminToken = String(registered.token || '');
      adminHandle = registered.agent?.handle || preferred;
    } catch (error) {
      if (!String(error.message).includes('(409)')) throw error;
      const fallback = `${preferred.slice(0, 55)}-${crypto.randomBytes(4).toString('hex')}`;
      const registered = await register(fallback);
      adminToken = String(registered.token || '');
      adminHandle = registered.agent?.handle || fallback;
    }
  }
  if (adminToken.length < 20) throw new Error('AgentSlack did not return a logical Server sender credential');
  item.servers.push({ slug, adminToken, adminHandle, createdAt: new Date().toISOString() });
  await writePrivate(catalogFile(stateDir), catalog);
  return { server: result.server || { slug, name: String(input.name || slug) }, credentialManaged: true, created };
}

function normalizedHandle(stateDir, infrastructureId, serverSlug, session) {
  const namespace = crypto.createHash('sha256').update(path.resolve(stateDir)).digest('hex').slice(0, 8);
  const raw = `aw-${namespace}-${session.tenantSlug}-${session.alias}`.toLowerCase()
    .replace(/[^a-z0-9가-힣._-]+/gu, '-').replace(/^-+|-+$/g, '');
  if (raw.length <= 64) return raw;
  return `${raw.slice(0, 55).replace(/-+$/g, '')}-${crypto.createHash('sha256').update(`${infrastructureId}:${serverSlug}:${session.sessionUuid}`).digest('hex').slice(0, 8)}`;
}

async function bindingValid(item, binding) {
  try {
    await api(item, binding.serverSlug, '/api/v1/me', { token: binding.token });
    return true;
  } catch { return false; }
}

export async function enrollAgentSlackSession(stateDir, { infrastructureId, serverSlug, session }) {
  const catalog = await readCatalog(stateDir);
  const item = catalog.infrastructures.find(entry => entry.id === infrastructureId);
  if (!item) throw new Error(`Unknown AgentSlack infrastructure: ${infrastructureId}`);
  const slug = String(serverSlug || '').trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) throw new Error('AgentSlack logical Server slug is invalid');
  const servers = await api(item, item.controlServerSlug, '/api/v1/servers', { token: null });
  if (!(servers.servers || []).some(server => server.slug === slug)) throw new Error(`AgentSlack logical Server does not exist: ${slug}`);
  if (!/^[0-9a-f-]{36}$/i.test(session?.sessionUuid || '')) throw new Error('A valid Agentworks session is required');
  const file = bindingFile(stateDir);
  const config = await readJson(file, { version: 1, bindings: [] });
  if (config.version !== 1 || !Array.isArray(config.bindings)) throw new Error('AgentSlack binding file is invalid');
  const id = `${infrastructureId}--${slug}--${session.sessionUuid}`;
  const current = config.bindings.find(binding => binding.id === id);
  if (current && await bindingValid(item, current)) return { binding: { id, handle: current.handle, infrastructureId, serverSlug: slug, targetSessionUuid: session.sessionUuid }, action: 'preserved' };
  let handle = normalizedHandle(stateDir, infrastructureId, slug, session);
  const register = async candidate => api(item, slug, '/api/v1/agents/register', {
    method: 'POST', expected: [201], token: null,
    body: {
      handle: candidate, displayName: `${session.tenantSlug} · ${session.alias}`,
      bio: `Agentworks ${session.tenantSlug} cell의 ${session.harness} coding session이며 durable wake와 AgentSlack 협업을 수행합니다.`,
      capabilities: [`${session.harness} coding agent`, 'Agentworks durable session wake', 'AgentSlack collaboration'],
      tags: ['agentworks'],
      session: { clientSessionId: session.sessionUuid, identityMode: 'host_verified', clientKind: 'agentworks', model: session.model, machine: session.runtimeName, repo: session.cwd, role: `${session.tenantSlug} ${session.harness} coding agent`, statusText: 'Agentworks exact-session delivery binding' },
    },
  });
  let registered;
  try { registered = await register(handle); }
  catch (error) {
    if (!String(error.message).includes('(409)')) throw error;
    handle = `${handle.slice(0, 54)}-${crypto.randomBytes(4).toString('hex')}`;
    registered = await register(handle);
  }
  const binding = {
    id, infrastructureId, handle, targetSessionUuid: session.sessionUuid, cellId: session.cellId,
    runtimeName: session.runtimeName, serverUrl: item.serverUrl, serverSlug: slug,
    token: registered.token, clientSessionId: session.sessionUuid, agentSlackSessionId: registered.session?.id || null,
  };
  config.bindings = [...config.bindings.filter(entry => entry.id !== id), binding];
  await writePrivate(file, config);
  return { binding: { id, handle, infrastructureId, serverSlug: slug, targetSessionUuid: session.sessionUuid }, action: current ? 'replaced' : 'registered' };
}
