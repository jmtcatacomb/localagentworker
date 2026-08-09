import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'linux') throw new Error('install-systemd.mjs only supports Linux');
const root = path.resolve(process.env.AGENTWORKS_ROOT);
const stateDir = path.resolve(process.env.AGENTWORKS_STATE_DIR);
const env = Object.fromEntries(fs.readFileSync(path.join(stateDir, 'config/master.env'), 'utf8').split('\n').filter(Boolean).map(line => line.split(/=(.*)/s).slice(0, 2)));
const runtime = process.env.AGENTWORKS_LINUX_RUNTIME || (commandExists('incus') ? 'incus' : commandExists('lxc') ? 'lxd' : '');
if (!runtime) throw new Error('Incus/LXD runtime is unavailable; install and initialize it before installing the Worker service');
const node = process.execPath;
const port = env.MASTER_PORT || '8080';
const adapter = path.join(root, 'worker/runtime/incus-limactl');
const lxdForwardingSource = path.join(root, 'worker/runtime/lxd-docker-forwarding.sh');
const user = process.env.SUDO_USER || process.env.USER || os.userInfo().username;
const home = os.homedir();
const unitName = 'agentworks-localagentworker.service';
const unitPath = path.join(stateDir, 'generated', unitName);
const environment = {
  HOME: home,
  PATH: `${path.dirname(node)}:/snap/bin:/usr/local/bin:/usr/bin:/bin`,
  WORKER_ID: process.env.WORKER_ID || 'linux-local',
  WORKER_TOKEN: env.WORKER_TOKEN,
  MASTER_AGENT_TOKEN: env.MASTER_AGENT_TOKEN,
  MASTER_AGENT_URL: `http://127.0.0.1:${port}`,
  AGENTWORKS_ROOT: root,
  AGENTWORKS_STATE_DIR: stateDir,
  MASTER_WS_URL: `ws://127.0.0.1:${port}/ws/worker`,
  HOST_RUNTIME: runtime,
  AGENTWORKS_LINUX_RUNTIME: runtime,
  AGENTWORKS_INCUS_BIN: runtime === 'lxd' ? 'lxc' : 'incus',
  LIMACTL_BIN: adapter,
  LIMA_HOME: path.join(stateDir, 'runtime'),
  AUTO_PROVISION: 'true',
  AUTO_CELLS: 'aw-a1,aw-b1',
  // Ubuntu cloud VM images reserve uid/gid 1000 for their non-root `ubuntu`
  // account.  The compatibility adapter applies this identity to every guest
  // command, keeping CLI logins, workspaces and bridge files tenant-owned.
  AGENTWORKS_GUEST_USER: process.env.AGENTWORKS_GUEST_USER || 'ubuntu',
  AGENTWORKS_GUEST_UID: process.env.AGENTWORKS_GUEST_UID || '1000',
  AGENTWORKS_GUEST_GID: process.env.AGENTWORKS_GUEST_GID || '1000',
  AGENTWORKS_GUEST_HOME: process.env.AGENTWORKS_GUEST_HOME || '/home/ubuntu',
};
const quoted = value => String(value).replaceAll('"', '\\"');
const envLines = Object.entries(environment).map(([key, value]) => `Environment="${key}=${quoted(value)}"`).join('\n');
const runtimeGroup = runtime === 'incus' ? 'incus-admin' : 'lxd';
let runtimePreStart = '';
if (runtime === 'lxd') {
  const forwardingTarget = '/usr/local/lib/agentworks/lxd-docker-forwarding';
  execFileSync('sudo', ['install', '-D', '-m', '0755', lxdForwardingSource, forwardingTarget], { stdio: 'inherit' });
  // Docker can report active before it has created the DOCKER-USER chain on a
  // cold boot. Retry the scoped LXD forwarding rule until that chain exists;
  // without it Docker's FORWARD=DROP black-holes every tenant VM's IPv4 egress.
  runtimePreStart = `ExecStartPre=+/bin/sh -c 'for n in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do ${forwardingTarget} lxdbr0; iptables -C DOCKER-USER -i lxdbr0 -j ACCEPT 2>/dev/null && exit 0; sleep 1; done; exit 1'\n`;
}
const noNewPrivileges = runtime === 'lxd' ? 'false' : 'true';
const unit = `[Unit]\nDescription=Agentworks local host worker\nAfter=network-online.target docker.service ${runtime === 'incus' ? 'incus.service' : 'snap.lxd.daemon.service'}\nWants=network-online.target\n\n[Service]\nType=simple\nUser=${user}\nSupplementaryGroups=${runtimeGroup}\nWorkingDirectory=${root}\n${envLines}\n${runtimePreStart}ExecStart=${node} ${path.join(root, 'worker/src/worker.mjs')}\nRestart=always\nRestartSec=5\nTimeoutStopSec=30\n# Snap-packaged LXD requires its confined client to acquire capabilities; Incus remains hardened.\nNoNewPrivileges=${noNewPrivileges}\n\n[Install]\nWantedBy=multi-user.target\n`;
fs.mkdirSync(path.dirname(unitPath), { recursive: true });
fs.writeFileSync(unitPath, unit, { mode: 0o600 });
execFileSync('sudo', ['install', '-m', '0644', unitPath, `/etc/systemd/system/${unitName}`], { stdio: 'inherit' });
execFileSync('sudo', ['systemctl', 'daemon-reload'], { stdio: 'inherit' });
execFileSync('sudo', ['systemctl', 'enable', '--now', unitName], { stdio: 'inherit' });
execFileSync('sudo', ['systemctl', 'restart', unitName], { stdio: 'inherit' });
console.log(`localagentworker installed: /etc/systemd/system/${unitName}`);

function commandExists(command) {
  try { execFileSync('which', [command], { stdio: 'ignore' }); return true; } catch { return false; }
}
