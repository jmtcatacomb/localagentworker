import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureFetch } from '../lib/node-fetch-compat.mjs';

ensureFetch(import.meta.url);

const stateDir = path.resolve(process.env.AGENTWORKS_STATE_DIR || '.agentworks');
const infrastructureId = process.env.AGENTSLACK_INFRASTRUCTURE_ID || 'portainer-main';
const serverSlug = process.env.AGENTSLACK_SERVER_SLUG || 'aw';
const catalog = JSON.parse(fs.readFileSync(path.join(stateDir, 'agentslack', 'infrastructures.json'), 'utf8'));
const infrastructure = catalog.infrastructures.find(item => item.id === infrastructureId);
const logical = infrastructure?.servers?.find(item => item.slug === serverSlug);
if (!infrastructure || !logical?.adminToken) throw new Error(`Managed AgentSlack target is missing: ${infrastructureId}/${serverSlug}`);
const bindingConfig = JSON.parse(fs.readFileSync(path.join(stateDir, 'agentslack', 'bindings.json'), 'utf8'));
const bindings = bindingConfig.bindings.filter(item => item.infrastructureId === infrastructureId && item.serverSlug === serverSlug && item.cellId);
if (!bindings.length) throw new Error(`No tenant VM sessions are enrolled in ${infrastructureId}/${serverSlug}`);

const masterEnv = Object.fromEntries(fs.readFileSync(path.join(stateDir, 'config', 'master.env'), 'utf8').split(/\r?\n/)
  .filter(line => line.includes('=')).map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
const masterBase = `http://127.0.0.1:${masterEnv.MASTER_PORT || 18080}`;
const masterHeaders = { 'content-type': 'application/json', 'x-agentworks-master-token': masterEnv.MASTER_AGENT_TOKEN };
const runId = crypto.randomUUID();

async function request(url, { method = 'GET', headers = {}, body, expected = [200], timeoutMs = 30_000 } = {}) {
  const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const value = await response.json().catch(() => ({}));
  if (!expected.includes(response.status)) throw new Error(`${method} ${url} failed (${response.status}): ${value.error || 'request_failed'}`);
  return value;
}

async function master(pathname, options = {}) {
  return request(`${masterBase}${pathname}`, { ...options, headers: { ...masterHeaders, ...(options.headers || {}) } });
}

const adminHeaders = {
  'content-type': 'application/json', authorization: `Bearer ${logical.adminToken}`,
  'x-agentslack-server': serverSlug, 'x-agentslack-client-session-id': `agentworks-e2e-${runId}`,
};
async function agentSlack(pathname, options = {}) {
  return request(new URL(pathname, infrastructure.serverUrl).toString(), { ...options, headers: { ...adminHeaders, ...(options.headers || {}) } });
}

async function waitFor(probe, description, timeoutMs = 40 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await probe(); if (value) return value; }
    catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

const cellIds = [...new Set(bindings.map(binding => binding.cellId))];
for (const cellId of cellIds) await master(`/api/cells/${cellId}/actions`, { method: 'POST', body: { action: 'stop' }, timeoutMs: 10 * 60_000 });
await waitFor(async () => {
  const cells = (await master('/api/admin/cells')).cells;
  return cellIds.every(cellId => cells.find(cell => cell.id === cellId)?.status === 'stopped');
}, `${cellIds.length} tenant VMs to stop`, 10 * 60_000);

const sent = [];
for (const [index, binding] of bindings.entries()) {
  const marker = `agentworks-connect-${runId}-${index}`;
  const result = await agentSlack('/api/v1/dm', {
    method: 'POST', expected: [201],
    body: {
      recipientHandles: [binding.handle], topicTitle: `Agentworks 연결 확인 ${runId.slice(0, 8)}-${index + 1}`,
      bodyMd: `연결해\n\n검증 표식: ${marker}\nAgentSlack에서 수신했음을 짧게 답해줘.`,
      mentions: [binding.handle], idempotencyKey: `agentworks-connect:${runId}:${index}`,
    },
  });
  sent.push({ binding, marker, messageId: result.message.id, topicId: result.message.topicId });
}

const acknowledgements = await waitFor(async () => {
  const messages = (await master('/api/inter-session/messages')).messages || [];
  const found = sent.map(item => messages.find(message => String(message.content || '').includes(item.marker)));
  if (found.some(message => ['failed', 'expired'].includes(message?.status))) {
    const failure = found.find(message => ['failed', 'expired'].includes(message?.status));
    throw new Error(`${failure.status}: ${failure.lastError || 'unknown delivery failure'}`);
  }
  if (!found.every(message => message?.status === 'acknowledged' && String(message.result?.answer || '').trim())) return false;
  return found;
}, `${bindings.length} exact sessions to wake, answer, and ACK`);

await waitFor(async () => {
  const cells = (await master('/api/admin/cells')).cells;
  return cellIds.every(cellId => { const cell = cells.find(item => item.id === cellId); return cell?.status === 'running' && cell?.agentsStatus === 'ready'; });
}, `${cellIds.length} tenant VMs to return ready`, 15 * 60_000);

const replies = [];
for (const [index, item] of sent.entries()) {
  const agentworksMessageId = acknowledgements[index].id;
  const thread = await waitFor(async () => {
    const value = await agentSlack(`/api/v1/topics/${item.topicId}?include_descendants=false`);
    return value.messages?.find(message => message.metadata?.agentworksMessageId === agentworksMessageId) ? value : false;
  }, `AgentSlack visible reply for ${item.binding.handle}`, 5 * 60_000);
  const reply = thread.messages.find(message => message.metadata?.agentworksMessageId === agentworksMessageId);
  replies.push({ handle: item.binding.handle, sessionUuid: item.binding.targetSessionUuid, topicId: item.topicId, replyMessageId: reply.id, answerLength: String(reply.bodyMd || '').length });
}

console.log(JSON.stringify({
  ok: true, runId, infrastructureId, serverSlug,
  sessions: bindings.length, stoppedAndWokenCells: cellIds.length,
  allAcknowledged: true, allRepliesVisibleInAgentSlack: true, replies,
}, null, 2));
