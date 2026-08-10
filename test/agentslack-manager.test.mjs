import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createAgentSlackServer,
  enrollAgentSlackSession,
  importAgentSlackInfrastructure,
  listAgentSlackInfrastructures,
} from '../worker/integrations/agentslack-manager.mjs';

test('AgentSlack manager keeps credentials private and enrolls one exact session in a selected physical/logical pair', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentworks-agentslack-manager-'));
  const originalFetch = global.fetch;
  const token = 'control-secret-which-must-stay-private';
  const sessionToken = 'session-secret-which-must-stay-private';
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ pathname: parsed.pathname, method: options.method || 'GET', server: options.headers?.['x-agentslack-server'] });
    let status = 200;
    let body = {};
    if (parsed.pathname === '/api/v1/me') body = { agent: { handle: 'root-admin', systemRole: 'admin' } };
    else if (parsed.pathname === '/api/v1/servers' && options.method === 'POST') {
      status = 201; body = { server: { slug: 'aw', name: 'AW' }, bootstrap: { token: 'logical-admin-token-kept-private', admin: { handle: 'agentworks-aw-admin' } } };
    } else if (parsed.pathname === '/api/v1/servers') body = { servers: [{ slug: 'toomuch' }, { slug: 'aw' }] };
    else if (parsed.pathname === '/api/v1/agents/register') {
      status = 201; body = { token: sessionToken, session: { id: 'as-session-id' } };
    }
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  try {
    const credentialFile = path.join(temporary, 'input.json');
    fs.writeFileSync(credentialFile, JSON.stringify({ serverUrl: 'https://agentslack.test', serverSlug: 'toomuch', token }), { mode: 0o600 });
    await importAgentSlackInfrastructure(temporary, { infrastructureId: 'portainer', name: 'Portainer AgentSlack', credentialFile });
    await createAgentSlackServer(temporary, 'portainer', { slug: 'aw', name: 'Agentworks' });
    const session = {
      sessionUuid: '11111111-1111-4111-8111-111111111111', tenantSlug: 'alpha', alias: 'builder',
      harness: 'claude', model: 'sonnet', cwd: '/workspace', cellId: 'cell-a', runtimeName: 'aw-a1',
    };
    const enrollment = await enrollAgentSlackSession(temporary, { infrastructureId: 'portainer', serverSlug: 'aw', session });
    assert.equal(enrollment.action, 'registered');
    const listed = JSON.stringify(await listAgentSlackInfrastructures(temporary));
    assert.doesNotMatch(listed, /control-secret|logical-admin-token/);
    const catalogFile = path.join(temporary, 'agentslack', 'infrastructures.json');
    const bindingsFile = path.join(temporary, 'agentslack', 'bindings.json');
    assert.equal(fs.statSync(catalogFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(bindingsFile).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(bindingsFile, 'utf8'), new RegExp(sessionToken));
    assert.ok(calls.some(call => call.pathname === '/api/v1/agents/register' && call.server === 'aw'));
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('AgentSlack manager recovers an older logical Server with a scoped sender identity', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentworks-agentslack-legacy-'));
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || 'GET';
    calls.push({ pathname: parsed.pathname, method, server: options.headers?.['x-agentslack-server'] });
    if (parsed.pathname === '/api/v1/me') return Response.json({ agent: { systemRole: 'admin' } });
    if (parsed.pathname === '/api/v1/servers' && method === 'POST') {
      return Response.json({ error: 'server_slug_exists' }, { status: 409 });
    }
    if (parsed.pathname === '/api/v1/agents/register') {
      return Response.json({ token: 'legacy-scoped-sender-token-private', agent: { handle: 'agentworks-aw-controller' } }, { status: 201 });
    }
    return Response.json({ servers: [{ slug: 'lifty' }, { slug: 'aw' }] });
  };
  try {
    const credentialFile = path.join(temporary, 'input.json');
    fs.writeFileSync(credentialFile, JSON.stringify({ serverUrl: 'https://legacy.agentslack.test', serverSlug: 'lifty', token: 'legacy-control-token-private' }), { mode: 0o600 });
    await importAgentSlackInfrastructure(temporary, { infrastructureId: 'lifty-main', credentialFile });
    const result = await createAgentSlackServer(temporary, 'lifty-main', { slug: 'aw', name: 'Agentworks' });
    assert.equal(result.created, false);
    assert.equal(result.credentialManaged, true);
    assert.ok(calls.some(call => call.pathname === '/api/v1/agents/register' && call.server === 'aw'));
    const publicCatalog = JSON.stringify(await listAgentSlackInfrastructures(temporary));
    assert.doesNotMatch(publicCatalog, /legacy-scoped-sender-token|legacy-control-token/);
    assert.match(fs.readFileSync(path.join(temporary, 'agentslack', 'infrastructures.json'), 'utf8'), /legacy-scoped-sender-token-private/);
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
