import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { redactAgentSlackConfig, validateAgentSlackConfig } from '../worker/integrations/agentslack.mjs';

const session = '11111111-1111-4111-8111-111111111111';
const binding = (id, infrastructureId, serverUrl, token) => ({
  id, infrastructureId, targetSessionUuid: session, serverUrl, serverSlug: 'shared-slug', token,
  clientSessionId: `client-${id}`,
});

test('multiple AgentSlack infrastructures stay isolated even when Server slugs match', () => {
  const config = validateAgentSlackConfig({ version: 1, bindings: [
    binding('primary-agent', 'primary', 'https://primary.internal', 'p'.repeat(24)),
    binding('research-agent', 'research', 'https://research.internal', 'r'.repeat(24)),
  ] });
  assert.equal(config.bindings.length, 2);
  assert.notEqual(config.bindings[0].serverUrl, config.bindings[1].serverUrl);
  const redacted = JSON.stringify(redactAgentSlackConfig(config));
  assert.doesNotMatch(redacted, /p{20}|r{20}/);
  assert.match(redacted, /primary\.internal/);
  assert.match(redacted, /research\.internal/);
});

test('duplicate AgentSlack binding IDs fail closed', () => {
  assert.throws(() => validateAgentSlackConfig({ version: 1, bindings: [
    binding('duplicate', 'one', 'https://one.internal', 'a'.repeat(24)),
    binding('duplicate', 'two', 'https://two.internal', 'b'.repeat(24)),
  ] }), /duplicated/);
});

test('AgentSlack import writes owner-only state and never prints bearer tokens', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentworks-agentslack-'));
  try {
    const input = path.join(temporary, 'private.json');
    const state = path.join(temporary, 'state');
    const token = 'secret-token-that-must-not-print';
    fs.writeFileSync(input, JSON.stringify({ version: 1, bindings: [binding('safe-import', 'primary', 'https://primary.internal', token)] }), { mode: 0o600 });
    const result = spawnSync(process.execPath, ['scripts/configure-agentslack.mjs', 'import', input], {
      cwd: path.resolve('.'), env: { ...process.env, AGENTWORKS_STATE_DIR: state }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, new RegExp(token));
    const target = path.join(state, 'agentslack', 'bindings.json');
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).bindings.length, 1);
    if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
