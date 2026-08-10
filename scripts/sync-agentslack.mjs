#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const stateDir = path.resolve(process.env.AGENTWORKS_STATE_DIR || path.join(root, '.agentworks'));
const envFile = path.join(stateDir, 'config', 'master.env');
const controlFile = path.join(stateDir, 'secrets', 'agentslack-agentworktest-admin.json');
const bindingFile = path.join(stateDir, 'agentslack', 'bindings.json');

if (!fs.existsSync(controlFile)) {
  throw new Error(`AgentSlack logical Server credential is missing: ${controlFile}`);
}
const control = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
if (!/^https?:\/\//.test(control.serverUrl || '') || !control.serverSlug) {
  throw new Error('AgentSlack logical Server credential has invalid connection metadata');
}

function compose(args) {
  let executable = 'docker';
  let prefix = [];
  let composeRoot = root;
  let composeEnvFile = envFile;
  if (process.platform === 'win32') {
    const wslPath = target => execFileSync('wsl.exe', [
      '-d', 'Ubuntu', '-u', 'root', '--', 'wslpath', '-a', target,
    ], { encoding: 'utf8' }).trim();
    executable = 'wsl.exe';
    prefix = ['-d', 'Ubuntu', '-u', 'root', '--', 'docker'];
    composeRoot = wslPath(root);
    composeEnvFile = wslPath(envFile);
  }
  return execFileSync(executable, [...prefix,
    'compose', '--project-directory', composeRoot, '--env-file', composeEnvFile,
    '-f', `${composeRoot}/compose.yaml`, ...args,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function sessions() {
  const sql = `SELECT json_build_object(
    'sessionUuid',s.session_uuid,'alias',s.alias,'harness',s.harness,
    'model',s.model,'cwd',s.cwd,'runtimeName',c.runtime_name,'tenantSlug',t.slug
  ) FROM agent_sessions s JOIN cells c ON c.id=s.cell_id
  JOIN tenants t ON t.id=s.tenant_id
  WHERE s.archived_at IS NULL ORDER BY t.slug,s.created_at`;
  return compose(['exec', '-T', 'postgres', 'psql', '-U', 'agentworks', '-d', 'agentworks',
    '-At', '-c', sql]).split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function normalizedHandle(session) {
  const raw = `aw-${session.tenantSlug}-${session.alias}`.toLowerCase()
    .replace(/[^a-z0-9가-힣._-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  if (raw.length <= 64) return raw;
  const suffix = crypto.createHash('sha256').update(session.sessionUuid).digest('hex').slice(0, 8);
  return `${raw.slice(0, 55).replace(/-+$/g, '')}-${suffix}`;
}

function readBindings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(bindingFile, 'utf8'));
    if (parsed.version !== 1 || !Array.isArray(parsed.bindings)) throw new Error('invalid binding schema');
    return parsed.bindings;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function request(pathname, options = {}) {
  const response = await fetch(new URL(pathname, control.serverUrl), {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-agentslack-server': control.serverSlug,
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function bindingValid(binding) {
  if (!binding?.token) return false;
  const { response } = await request('/api/v1/me', {
    headers: {
      authorization: `Bearer ${binding.token}`,
      'x-agentslack-client-session-id': binding.clientSessionId,
      ...(binding.agentSlackSessionId ? { 'x-agentslack-session-id': binding.agentSlackSessionId } : {}),
    },
  });
  return response.ok;
}

async function register(session, handle) {
  const { response, body } = await request('/api/v1/agents/register', {
    method: 'POST',
    body: JSON.stringify({
      handle,
      displayName: `${session.tenantSlug} · ${session.alias}`,
      bio: `Agentworks ${session.tenantSlug} cell의 ${session.harness} coding session이며 durable inter-session wake와 AgentSlack 협업을 수행합니다.`,
      capabilities: [
        `${session.harness} coding agent`,
        'Agentworks durable session wake',
        'AgentSlack Topic, DM, Wiki collaboration',
      ],
      tags: ['agentworks'],
      session: {
        clientSessionId: session.sessionUuid,
        identityMode: 'host_verified',
        clientKind: 'agentworks',
        model: session.model,
        machine: session.runtimeName,
        repo: session.cwd,
        role: `${session.tenantSlug} ${session.harness} coding agent`,
        statusText: 'Agentworks exact-session delivery binding',
      },
    }),
  });
  if (!response.ok) throw new Error(`AgentSlack register ${handle}: ${response.status} ${body.error || 'request_failed'}`);
  return {
    id: handle,
    handle,
    targetSessionUuid: session.sessionUuid,
    serverUrl: control.serverUrl,
    serverSlug: control.serverSlug,
    token: body.token,
    clientSessionId: session.sessionUuid,
    agentSlackSessionId: body.session?.id || null,
  };
}

const existing = readBindings();
const byTarget = new Map(existing.map(binding => [binding.targetSessionUuid, binding]));
const next = [];
const results = [];
for (const session of sessions()) {
  const current = byTarget.get(session.sessionUuid);
  if (current && await bindingValid(current)) {
    next.push(current);
    results.push({ sessionUuid: session.sessionUuid, handle: current.handle || current.id, action: 'preserved' });
    continue;
  }
  let handle = normalizedHandle(session);
  if (current) handle = `${handle.slice(0, 54)}-${crypto.randomBytes(4).toString('hex')}`;
  const binding = await register(session, handle);
  next.push(binding);
  results.push({ sessionUuid: session.sessionUuid, handle, action: current ? 'replaced' : 'registered' });
}

fs.mkdirSync(path.dirname(bindingFile), { recursive: true, mode: 0o700 });
const temporary = `${bindingFile}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, bindings: next }, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, bindingFile);
fs.chmodSync(bindingFile, 0o600);
console.log(JSON.stringify({
  ok: true,
  server: control.serverSlug,
  bindings: results,
  bindingFile,
  mode: (fs.statSync(bindingFile).mode & 0o777).toString(8),
}, null, 2));
