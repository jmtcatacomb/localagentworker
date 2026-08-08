#!/usr/bin/env node
/**
 * Incus/LXD adapter for the legacy Worker command surface.
 *
 * The Worker deliberately uses a tiny command contract (create/start/stop/edit,
 * shell, copy and JSON list).  This adapter translates that contract to an Incus
 * compatible CLI so the control-plane code does not need a privileged runtime
 * socket.  It is a host-worker executable, never mounted in the Master container.
 */
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const cli = process.env.AGENTWORKS_INCUS_BIN || (process.env.AGENTWORKS_LINUX_RUNTIME === 'lxd' ? 'lxc' : 'incus');

function fail(message) { process.stderr.write(`agentworks Incus adapter: ${message}\n`); process.exit(2); }
function option(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}
function invoke(args, transform = null) {
  const child = spawn(cli, args, { stdio: ['inherit', 'pipe', 'inherit'], env: process.env });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.on('error', error => fail(`${cli} unavailable: ${error.message}`));
  child.on('close', code => {
    if (code !== 0) process.exit(code || 1);
    try { process.stdout.write(transform ? transform(stdout) : stdout); }
    catch (error) { fail(error.message); }
  });
}

if (!argv.length) fail('missing command');
const command = argv[0];
if (command === 'list') {
  invoke(['list', '--format', 'json'], output => {
    const instances = JSON.parse(output || '[]');
    return `${JSON.stringify(instances.map(instance => ({ name: instance.name, status: String(instance.status || '').toLowerCase() })))}\n`;
  });
} else if (command === 'create') {
  const name = option('--name');
  const cpus = option('--cpus') || '2';
  const memory = option('--memory') || '4';
  const disk = option('--disk') || '40';
  if (!name) fail('create requires --name');
  const image = process.env.AGENTWORKS_GUEST_IMAGE || 'images:ubuntu/24.04/cloud';
  invoke(['launch', image, name, '--vm', '-c', `limits.cpu=${cpus}`, '-c', `limits.memory=${memory}GiB`, '-d', `root,size=${disk}GiB`]);
} else if (command === 'start' || command === 'stop') {
  const name = argv.filter(value => value !== command && value !== '-y').at(-1);
  if (!name) fail(`${command} requires an instance name`);
  invoke([command, name]);
} else if (command === 'edit') {
  const name = argv.at(-1);
  const cpus = option('--cpus');
  const memory = option('--memory');
  if (!name || !cpus || !memory) fail('edit requires --cpus, --memory and name');
  invoke(['config', 'set', name, `limits.cpu=${cpus}`, `limits.memory=${memory}`]);
} else if (command === 'shell') {
  const rest = argv.slice(1).filter(value => value !== '-y');
  const name = rest.shift();
  if (!name || !rest.length) fail('shell requires an instance name and command');
  invoke(['exec', name, '--', ...rest]);
} else if (command === 'copy') {
  const rest = argv.slice(1);
  if (rest.length !== 2) fail('copy requires source and destination');
  const [source, destination] = rest;
  const separator = destination.indexOf(':');
  if (separator <= 0) fail('copy destination must be instance:/absolute/path');
  const instance = destination.slice(0, separator);
  const target = destination.slice(separator + 1);
  invoke(['file', 'push', source, `${instance}${target}`]);
} else {
  fail(`unsupported limactl compatibility command: ${command}`);
}
