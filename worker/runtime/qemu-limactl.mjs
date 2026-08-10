#!/usr/bin/env node
/**
 * QEMU/KVM adapter for the Worker VM command contract.
 *
 * Amazon Linux 2 does not ship a supported Incus/LXD package, but EC2
 * instances with nested virtualization expose /dev/kvm.  This adapter keeps
 * the same create/start/stop/edit/shell/copy/list surface as the Lima and
 * Incus adapters while creating durable Ubuntu cloud-image VMs directly.
 * It is intentionally a host-worker program; neither the QEMU socket nor its
 * SSH key is mounted in the Master container.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const root = path.resolve(process.env.LIMA_HOME || path.join(process.cwd(), '.agentworks', 'runtime'), 'qemu');
const guestUser = process.env.AGENTWORKS_GUEST_USER || 'ubuntu';
const imageUrl = process.env.AGENTWORKS_QEMU_IMAGE_URL || 'https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-amd64.img';
const ovmfCode = process.env.AGENTWORKS_QEMU_OVMF_CODE || '/usr/share/edk2/ovmf/OVMF_CODE.fd';
const ovmfVars = process.env.AGENTWORKS_QEMU_OVMF_VARS || '/usr/share/edk2/ovmf/OVMF_VARS.fd';

function fail(message) { process.stderr.write(`agentworks QEMU adapter: ${message}\n`); process.exit(2); }
function option(name) { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : null; }
function validName(name) { return /^[a-z][a-z0-9-]{0,62}$/.test(name || ''); }
function instanceDir(name) { return path.join(root, 'instances', name); }
function metaPath(name) { return path.join(instanceDir(name), 'meta.json'); }
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: options.stdio || ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = ''; let stderr = '';
    if (child.stdout) child.stdout.on('data', chunk => { stdout += chunk; });
    if (child.stderr) child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} exited ${code}: ${stderr.trim() || stdout.trim()}`)));
  });
}
async function readMeta(name) {
  try { return JSON.parse(await fs.readFile(metaPath(name), 'utf8')); }
  catch { return null; }
}
async function writeMeta(name, value) { await fs.writeFile(metaPath(name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function state(meta) {
  if (!meta) return 'missing';
  try { return alive(Number((await fs.readFile(meta.pidPath, 'utf8')).trim())) ? 'running' : 'stopped'; }
  catch { return 'stopped'; }
}
async function chooseSshPort(name) {
  const digest = crypto.createHash('sha256').update(name).digest().readUInt16BE(0);
  for (let offset = 0; offset < 1000; offset += 1) {
    const port = 22000 + ((digest + offset) % 10000);
    const free = await new Promise(resolve => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error('could not allocate a local SSH forwarding port');
}
async function ensureBaseImage() {
  const baseDir = path.join(root, 'base');
  const target = path.join(baseDir, 'ubuntu-24.04-server-cloudimg-amd64.img');
  await fs.mkdir(baseDir, { recursive: true, mode: 0o700 });
  try { await fs.access(target); return target; } catch {}
  const temp = `${target}.${process.pid}.partial`;
  await run('curl', ['--fail', '--location', '--proto', '=https', '--tlsv1.2', '--retry', '3', '--output', temp, imageUrl]);
  await fs.rename(temp, target);
  return target;
}
async function create(name) {
  if (!validName(name)) fail('create requires a lowercase runtime name');
  if (await readMeta(name)) return;
  const cpus = Math.max(1, Number(option('--cpus') || 2));
  const memoryGiB = Math.max(1, Number(option('--memory') || 4));
  const diskGiB = Math.max(8, Number(option('--disk') || 40));
  const dir = instanceDir(name);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const key = path.join(dir, 'id_ed25519');
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const publicKey = (await fs.readFile(`${key}.pub`, 'utf8')).trim();
  const userData = `#cloud-config\nusers:\n  - name: ${guestUser}\n    groups: [sudo]\n    sudo: ALL=(ALL) NOPASSWD:ALL\n    shell: /bin/bash\n    ssh_authorized_keys:\n      - ${publicKey}\nssh_pwauth: false\npackage_update: false\n`;
  await fs.writeFile(path.join(dir, 'user-data'), userData, { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'meta-data'), `instance-id: ${name}\nlocal-hostname: ${name}\n`, { mode: 0o600 });
  await run('genisoimage', ['-output', path.join(dir, 'seed.iso'), '-volid', 'cidata', '-joliet', '-rock', path.join(dir, 'user-data'), path.join(dir, 'meta-data')]);
  const base = await ensureBaseImage();
  await run('qemu-img', ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', base, path.join(dir, 'disk.qcow2'), `${diskGiB}G`]);
  await fs.copyFile(ovmfVars, path.join(dir, 'OVMF_VARS.fd'));
  const meta = { name, cpus, memoryMiB: Math.round(memoryGiB * 1024), diskGiB, sshPort: await chooseSshPort(name), keyPath: key, pidPath: path.join(dir, 'qemu.pid'), createdAt: new Date().toISOString() };
  await writeMeta(name, meta);
}
async function sshReady(meta) {
  const until = Date.now() + 8 * 60 * 1000;
  while (Date.now() < until) {
    const probe = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=5', '-i', meta.keyPath, '-p', String(meta.sshPort), `${guestUser}@127.0.0.1`, 'true'], { stdio: 'ignore' });
    if (probe.status === 0) return;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`guest ${meta.name} did not become reachable over SSH`);
}
async function start(name) {
  const meta = await readMeta(name); if (!meta) fail(`unknown instance ${name}`);
  if (await state(meta) === 'running') return;
  const dir = instanceDir(name);
  const args = ['-enable-kvm', '-cpu', 'host', '-machine', 'q35,accel=kvm', '-smp', String(meta.cpus), '-m', String(meta.memoryMiB), '-display', 'none', '-serial', `file:${path.join(dir, 'console.log')}`, '-daemonize', '-pidfile', meta.pidPath, '-drive', `if=pflash,format=raw,readonly=on,file=${ovmfCode}`, '-drive', `if=pflash,format=raw,file=${path.join(dir, 'OVMF_VARS.fd')}`, '-drive', `if=virtio,format=qcow2,file=${path.join(dir, 'disk.qcow2')}`, '-drive', `media=cdrom,readonly=on,file=${path.join(dir, 'seed.iso')}`, '-netdev', `user,id=net0,hostfwd=tcp:127.0.0.1:${meta.sshPort}-:22`, '-device', 'virtio-net-pci,netdev=net0'];
  await run('qemu-system-x86_64', args);
  await sshReady(meta);
}
async function stop(name) {
  const meta = await readMeta(name); if (!meta) return;
  if (await state(meta) !== 'running') return;
  await run('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-i', meta.keyPath, '-p', String(meta.sshPort), `${guestUser}@127.0.0.1`, 'sudo', 'poweroff']).catch(() => {});
  const pid = Number((await fs.readFile(meta.pidPath, 'utf8')).trim());
  for (let wait = 0; wait < 30 && alive(pid); wait += 1) await new Promise(resolve => setTimeout(resolve, 1000));
  if (alive(pid)) process.kill(pid, 'SIGTERM');
}
async function shell(name, rest) {
  const meta = await readMeta(name); if (!meta || await state(meta) !== 'running') fail(`${name} is not running`);
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-i', meta.keyPath, '-p', String(meta.sshPort), `${guestUser}@127.0.0.1`, ...rest];
  const child = spawn('ssh', args, { stdio: 'inherit', env: process.env });
  child.on('error', error => fail(error.message)); child.on('close', code => process.exit(code || 0));
}
async function copy(source, destination) {
  const split = destination.indexOf(':'); if (split <= 0) fail('copy destination must be instance:/absolute/path');
  const name = destination.slice(0, split); const target = destination.slice(split + 1);
  const meta = await readMeta(name); if (!meta || await state(meta) !== 'running') fail(`${name} is not running`);
  await run('scp', ['-q', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-i', meta.keyPath, '-P', String(meta.sshPort), source, `${guestUser}@127.0.0.1:${target}`]);
}
async function main() {
  const command = argv[0]; if (!command) fail('missing command');
  if (command === 'list') {
    const directory = path.join(root, 'instances');
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    const items = [];
    for (const entry of entries.filter(item => item.isDirectory())) { const meta = await readMeta(entry.name); if (meta) items.push({ name: meta.name, status: await state(meta) }); }
    process.stdout.write(`${JSON.stringify(items)}\n`); return;
  }
  if (command === 'create') return create(option('--name'));
  if (command === 'copy') return copy(argv[1], argv[2]);
  const rest = argv.slice(1).filter(value => value !== '-y');
  const name = command === 'edit' ? rest.at(-1) : rest.shift();
  if (!validName(name)) fail(`${command} requires an instance name`);
  if (command === 'start') return start(name);
  if (command === 'stop') return stop(name);
  if (command === 'shell') return shell(name, rest);
  if (command === 'edit') { const meta = await readMeta(name); if (!meta) fail(`unknown instance ${name}`); meta.cpus = Math.max(1, Number(option('--cpus') || meta.cpus)); meta.memoryMiB = Math.max(1024, Number(String(option('--memory') || `${meta.memoryMiB}MiB`).replace(/MiB$/i, ''))); return writeMeta(name, meta); }
  fail(`unsupported QEMU compatibility command: ${command}`);
}
main().catch(error => fail(error.message));
