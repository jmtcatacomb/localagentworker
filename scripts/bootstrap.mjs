import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const stateDir = path.resolve(process.env.AGENTWORKS_STATE_DIR || '.agentworks');
const configDir = path.join(stateDir, 'config');
const envPath = path.join(configDir, 'master.env');
fs.mkdirSync(configDir, { recursive: true });
for (const name of ['postgres', 'logs', 'generated', 'master-agent-home', 'lima']) fs.mkdirSync(path.join(stateDir, name), { recursive: true });

const secret = bytes => crypto.randomBytes(bytes).toString('base64url');
if (!fs.existsSync(envPath)) {
  const lines = [
    'MASTER_PORT=18080',
    'MASTER_EMAIL=yuryueng@gmail.com',
    `MASTER_PASSWORD=${secret(15)}`,
    'TENANT_ALPHA_EMAIL=alpha@agentworks.local',
    `TENANT_ALPHA_PASSWORD=${secret(15)}`,
    'TENANT_BETA_EMAIL=beta@agentworks.local',
    `TENANT_BETA_PASSWORD=${secret(15)}`,
    `POSTGRES_PASSWORD=${secret(24)}`,
    `JWT_SECRET=${secret(48)}`,
    `WORKER_TOKEN=${secret(48)}`,
    `MASTER_AGENT_TOKEN=${secret(48)}`,
    'PORT_POOL_START=20000',
    'PORT_POOL_END=29999',
    'COOKIE_SECURE=false',
    '',
  ];
  fs.writeFileSync(envPath, lines.join('\n'), { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
} else {
  const source = fs.readFileSync(envPath, 'utf8');
  const additions = [];
  if (!/^MASTER_AGENT_TOKEN=/m.test(source)) additions.push(`MASTER_AGENT_TOKEN=${secret(48)}`);
  if (!/^PORT_POOL_START=/m.test(source)) additions.push('PORT_POOL_START=20000');
  if (!/^PORT_POOL_END=/m.test(source)) additions.push('PORT_POOL_END=29999');
  if (additions.length) fs.appendFileSync(envPath, `${source.endsWith('\n') ? '' : '\n'}${additions.join('\n')}\n`);
  fs.chmodSync(envPath, 0o600);
}
