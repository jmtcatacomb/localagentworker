import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function ensureFetch(moduleUrl) {
  if (typeof globalThis.fetch === 'function') return;
  if (process.env.AGENTWORKS_FETCH_REEXEC === '1') {
    throw new Error('This Node.js runtime does not provide fetch, even with --experimental-fetch');
  }
  const result = spawnSync(process.execPath, [
    '--experimental-fetch', fileURLToPath(moduleUrl), ...process.argv.slice(2),
  ], {
    stdio: 'inherit',
    env: { ...process.env, AGENTWORKS_FETCH_REEXEC: '1' },
  });
  process.exit(result.status ?? 1);
}
