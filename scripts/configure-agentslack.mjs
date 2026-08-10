#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactAgentSlackConfig, validateAgentSlackConfig } from '../worker/integrations/agentslack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = path.resolve(process.env.AGENTWORKS_STATE_DIR || path.join(root, '.agentworks'));
const target = path.join(stateDir, 'agentslack', 'bindings.json');
const action = process.argv[2];

if (action === 'import') {
  const source = process.argv[3];
  if (!source) throw new Error('Usage: configure-agentslack.mjs import <private-bindings.json>');
  const config = validateAgentSlackConfig(JSON.parse(await fs.readFile(path.resolve(source), 'utf8')));
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, target);
  process.stdout.write(`${JSON.stringify({ imported: config.bindings.length, target, bindings: redactAgentSlackConfig(config).bindings }, null, 2)}\n`);
} else if (action === 'status') {
  try {
    const config = validateAgentSlackConfig(JSON.parse(await fs.readFile(target, 'utf8')));
    process.stdout.write(`${JSON.stringify({ configured: true, target, ...redactAgentSlackConfig(config) }, null, 2)}\n`);
  } catch (error) {
    if (error.code === 'ENOENT') process.stdout.write(`${JSON.stringify({ configured: false, target, bindings: [] }, null, 2)}\n`);
    else throw error;
  }
} else {
  throw new Error('Usage: configure-agentslack.mjs {import <private-bindings.json>|status}');
}
