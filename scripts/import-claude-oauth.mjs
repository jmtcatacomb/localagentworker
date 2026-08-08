import fs from 'node:fs';
import path from 'node:path';

const token = String(process.env.AGENTWORKS_CLAUDE_OAUTH_TOKEN || '').trim();
if (!token || token.length < 20) throw new Error('AGENTWORKS_CLAUDE_OAUTH_TOKEN must be supplied through the invoking secret channel');
const stateDir = path.resolve(process.env.AGENTWORKS_STATE_DIR || '.agentworks');
const secretDir = path.join(stateDir, 'secrets');
const destination = path.join(secretDir, 'claude-oauth-token');
fs.mkdirSync(secretDir, { recursive: true, mode: 0o700 });
const temporary = `${destination}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${token}\n`, { mode: 0o600 });
fs.renameSync(temporary, destination);
fs.chmodSync(destination, 0o600);
console.log(`Claude OAuth credential imported to protected Host state: ${destination}`);
