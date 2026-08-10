import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureFetch } from '../lib/node-fetch-compat.mjs';

ensureFetch(import.meta.url);

const stateDir = path.resolve(process.env.AGENTWORKS_STATE_DIR || '.agentworks');
const bindings = JSON.parse(fs.readFileSync(path.join(stateDir, 'agentslack', 'bindings.json'), 'utf8')).bindings;
const source = bindings.find(item => item.handle?.includes('alpha'));
const target = bindings.find(item => item.handle?.includes('beta'));
if (!source || !target) throw new Error('AgentSlack smoke requires alpha and beta session bindings');
if (!target.cellId) throw new Error('AgentSlack smoke requires a target cell binding; run ./agentworks sync-agentslack');

const runId = crypto.randomUUID();
const marker = `AgentSlack live delivery ${runId}`;
const headers = binding => ({
  'content-type': 'application/json',
  authorization: `Bearer ${binding.token}`,
  'x-agentslack-server': binding.serverSlug,
  'x-agentslack-client-session-id': binding.clientSessionId,
  ...(binding.agentSlackSessionId ? { 'x-agentslack-session-id': binding.agentSlackSessionId } : {}),
});

async function agentSlackRequest(binding, pathname, { method = 'GET', body, expected = [200] } = {}) {
  const response = await fetch(new URL(pathname, binding.serverUrl), {
    method,
    headers: headers(binding),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const value = await response.json().catch(() => ({}));
  if (!expected.includes(response.status)) {
    throw new Error(`AgentSlack ${method} ${pathname} failed (${response.status}): ${value.error || 'request_failed'}`);
  }
  return value;
}

const liveDm = await agentSlackRequest(source, '/api/v1/dm', {
  method: 'POST', expected: [201],
  body: {
    recipientHandles: [target.handle],
    topicTitle: `Agentworks live exact-session wake ${runId.slice(0, 8)}`,
    bodyMd: `${marker}. Briefly acknowledge receipt.`,
    mentions: [target.handle],
    idempotencyKey: `agentworks-live:${runId}`,
  },
});

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

async function masterRequest(pathname, { method = 'GET', body, expected = [200] } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!expected.includes(response.status)) {
    throw new Error(`${method} ${pathname} failed (${response.status}): ${value.error || 'request_failed'}`);
  }
  return value;
}

async function waitFor(probe, description, timeoutMs = 15 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitAgentworksDelivery(contentMarker) {
  return waitFor(async () => {
    const body = await masterRequest('/api/inter-session/messages');
    const delivery = body.messages?.find(item => item.content.includes(contentMarker));
    if (delivery?.status === 'failed' || delivery?.status === 'expired') {
      throw new Error(`AgentSlack delivery ${delivery.status}: ${delivery.lastError || 'unknown error'}`);
    }
    return delivery?.status === 'acknowledged' && String(delivery.result?.answer || '').trim() ? delivery : false;
  }, `Agentworks acknowledgement for ${contentMarker}`);
}

const liveDelivery = await waitAgentworksDelivery(marker);

await masterRequest(`/api/cells/${target.cellId}/actions`, { method: 'POST', body: { action: 'stop' } });
await waitFor(async () => {
  const cells = (await masterRequest('/api/admin/cells')).cells;
  return cells.find(cell => cell.id === target.cellId)?.status === 'stopped';
}, 'target VM to stop');

const tagCatalog = await agentSlackRequest(source, '/api/v1/tags');
const tag = tagCatalog.tags?.find(item => item.slug === 'agentslack')?.slug || tagCatalog.tags?.[0]?.slug;
if (!tag) throw new Error('AgentSlack logical Server has no active Tag for Topic/Wiki smoke');

const recoveryMarker = `AgentSlack stopped-VM topic mention ${runId}`;
const topicResult = await agentSlackRequest(source, '/api/v1/topics', {
  method: 'POST', expected: [201],
  body: {
    title: `Agentworks recovery E2E ${runId.slice(0, 8)}`,
    summary: 'Stopped tenant VM wake, mention, reply, ACK and Wiki flow.',
    tags: [tag],
    message: {
      kind: 'status', title: 'Wake target tenant', bodyMd: recoveryMarker,
      mentions: [target.handle], idempotencyKey: `agentworks-recovery:${runId}`,
    },
  },
});
const recoveryDelivery = await waitAgentworksDelivery(recoveryMarker);
await waitFor(async () => {
  const cells = (await masterRequest('/api/admin/cells')).cells;
  const cell = cells.find(item => item.id === target.cellId);
  return cell?.status === 'running' && cell?.agentsStatus === 'ready';
}, 'target VM to wake and become ready');

const replyMarker = `AgentSlack topic reply ${runId}`;
const replyResult = await agentSlackRequest(target, `/api/v1/topics/${topicResult.topic.id}/messages`, {
  method: 'POST', expected: [201],
  body: {
    kind: 'status', title: 'Recovery acknowledged', bodyMd: replyMarker,
    mentions: [source.handle], idempotencyKey: `agentworks-reply:${runId}`,
  },
});
const replyDelivery = await waitAgentworksDelivery(replyMarker);

const wikiCreated = await agentSlackRequest(source, '/api/v1/wiki', {
  method: 'POST', expected: [201],
  body: {
    title: `Agentworks E2E evidence ${runId.slice(0, 8)}`,
    summary: 'Agentworks stopped-VM recovery and AgentSlack collaboration evidence.',
    tags: [tag], createdFromTopicId: topicResult.topic.id,
    bodyMd: `# Agentworks recovery E2E\n\nSource topic: topic:${topicResult.topic.id}\n\nSource message: message:${topicResult.message.id}`,
    editSummary: 'Create E2E evidence', changeKind: 'decision',
    sourceMessageIds: [topicResult.message.id],
  },
});
await agentSlackRequest(source, `/api/v1/topics/${topicResult.topic.id}/wiki-links`, {
  method: 'POST', expected: [201],
  body: { wikiId: wikiCreated.document.id, label: 'Agentworks E2E evidence' },
});
const wikiUpdated = await agentSlackRequest(source, `/api/v1/wiki/${wikiCreated.document.id}`, {
  method: 'PUT',
  body: {
    expectedRevision: 1,
    bodyMd: `# Agentworks recovery E2E\n\nRecovered and acknowledged via topic:${topicResult.topic.id}.`,
    editSummary: 'Record successful recovery', changeKind: 'correction',
    sourceMessageIds: [replyResult.message.id], addTags: [],
  },
});
const reference = encodeURIComponent(`wiki:${wikiCreated.document.id}@2`);
const resolved = await agentSlackRequest(source, `/api/v1/references/resolve?ref=${reference}`);
if (wikiUpdated.revision?.revision !== 2 || resolved.revision?.revision !== 2) {
  throw new Error('AgentSlack Wiki update/reference resolution mismatch');
}

console.log(JSON.stringify({
  ok: true,
  source: source.handle,
  target: target.handle,
  live: {
    agentSlackMessageId: liveDm.message?.id || null,
    agentworksMessageId: liveDelivery.id,
    status: liveDelivery.status,
  },
  stoppedVmWake: {
    topicId: topicResult.topic.id,
    agentworksMessageId: recoveryDelivery.id,
    status: recoveryDelivery.status,
  },
  topicReply: {
    messageId: replyResult.message.id,
    agentworksMessageId: replyDelivery.id,
    status: replyDelivery.status,
  },
  wiki: {
    documentId: wikiCreated.document.id,
    revision: wikiUpdated.revision.revision,
    resolved: true,
  },
}, null, 2));
