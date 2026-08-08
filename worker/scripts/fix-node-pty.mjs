import fs from 'node:fs';
import path from 'node:path';

// node-pty 1.1.0 ships the macOS spawn-helper without its executable bit in
// some npm extraction paths. The native module then reports only
// `posix_spawnp failed`. Repairing the packaged helper is deterministic.
const helper = path.resolve('node_modules/node-pty/prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
if (process.platform === 'darwin' && fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
