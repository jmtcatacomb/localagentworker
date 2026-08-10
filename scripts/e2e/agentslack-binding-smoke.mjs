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

const marker = `AgentSlack Windows delivery ${crypto.randomUUID()}`;
const headers = binding => ({
  'content-type': 'application/json',
  authorization: `Bearer ${binding.token}`,
  'x-agentslack-server': binding.serverSlug,
  'x-agentslack-client-session-id': binding.clientSessionId,
  ...(binding.agentSlackSessionId ? { 'x-agentslack-session-id': binding.agentSlackSessionId } : {}),
});
const sent = await fetch(new URL('/api/v1/dm', source.serverUrl), {
  method: 'POST',
  headers: headers(source),
  body: JSON.stringify({
    recipientHandles: [target.handle],
    topicTitle: 'Agentworks Windows exact-session wake E2E',
    bodyMd: `${marker}. Briefly acknowledge receipt.`,
    mentions: [target.handle],
    idempotencyKey: `agentworks-windows:${marker}`,
  }),
  signal: AbortSignal.timeout(30_000),
});
const sentBody = await sent.json().catch(() => ({}));
if (!sent.ok) throw new Error(`AgentSlack DM failed (${sent.status}): ${sentBody.error || 'request_failed'}`);

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
const deadline = Date.now() + 15 * 60_000;
let delivery;
while (Date.now() < deadline) {
  const response = await fetch(`${base}/api/inter-session/messages`, { headers: { cookie } });
  const body = await response.json();
  delivery = body.messages?.find(item => item.content.includes(marker));
  if (delivery?.status === 'acknowledged' && String(delivery.result?.answer || '').trim()) break;
  if (delivery?.status === 'failed' || delivery?.status === 'expired') {
    throw new Error(`AgentSlack delivery ${delivery.status}: ${delivery.lastError || 'unknown error'}`);
  }
  await new Promise(resolve => setTimeout(resolve, 2_000));
}
if (delivery?.status !== 'acknowledged') throw new Error('AgentSlack exact-session delivery did not ACK before timeout');

console.log(JSON.stringify({
  ok: true,
  source: source.handle,
  target: target.handle,
  agentSlackMessageId: sentBody.message?.id || null,
  agentworksMessageId: delivery.id,
  status: delivery.status,
}, null, 2));
