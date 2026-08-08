import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(process.env.AGENTWORKS_ROOT);
const stateDir = path.resolve(process.env.AGENTWORKS_STATE_DIR);
const env = Object.fromEntries(fs.readFileSync(path.join(stateDir, 'config/master.env'), 'utf8').split('\n').filter(Boolean).map(line => line.split(/=(.*)/s).slice(0, 2)));
const node = process.execPath;
const limactl = execFileSync('/usr/bin/which', ['limactl'], { encoding: 'utf8' }).trim();
const label = 'dev.agentworks.localagentworker';
const plistPath = path.join(stateDir, 'generated', `${label}.plist`);
const port = env.MASTER_PORT || '8080';
const environment = {
  PATH: `${path.dirname(node)}:${path.dirname(limactl)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
  HOME: os.homedir(),
  WORKER_ID: 'mac-local',
  WORKER_TOKEN: env.WORKER_TOKEN,
  MASTER_AGENT_TOKEN: env.MASTER_AGENT_TOKEN,
  MASTER_AGENT_URL: `http://127.0.0.1:${port}`,
  AGENTWORKS_ROOT: root,
  AGENTWORKS_STATE_DIR: stateDir,
  MASTER_WS_URL: `ws://127.0.0.1:${port}/ws/worker`,
  LIMA_HOME: path.join(stateDir, 'lima'),
  LIMACTL_BIN: limactl,
  AUTO_PROVISION: 'true',
  AUTO_CELLS: 'aw-a1,aw-b1',
};
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const envXml = Object.entries(environment).map(([key, value]) => `<key>${esc(key)}</key><string>${esc(value)}</string>`).join('');
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${esc(node)}</string><string>${esc(path.join(root, 'worker/src/worker.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${esc(root)}</string>
<key>EnvironmentVariables</key><dict>${envXml}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key><string>${esc(path.join(stateDir, 'logs/worker.log'))}</string>
<key>StandardErrorPath</key><string>${esc(path.join(stateDir, 'logs/worker.error.log'))}</string>
</dict></plist>`;
fs.mkdirSync(path.dirname(plistPath), { recursive: true });
fs.writeFileSync(plistPath, plist, { mode: 0o600 });

const domain = `gui/${process.getuid()}`;
try {
  execFileSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
  for (let index = 0; index < 30; index += 1) {
    try {
      execFileSync('launchctl', ['print', `${domain}/${label}`], { stdio: 'ignore' });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    } catch { break; }
  }
} catch {}
execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'inherit' });
console.log(`localagentworker installed: ${plistPath}`);
