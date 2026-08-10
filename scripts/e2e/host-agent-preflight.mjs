#!/usr/bin/env node
/**
 * Read-only host capability report for the Agentworks cloud E2E harness.
 *
 * It never reads authinfo.md, creates cloud resources, installs packages, or
 * modifies the host. The normal invoker is with-foragents-ssm.sh, which resolves
 * process-scoped credentials from the canonical FORAGENTS README -> SSM entry.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const agentSlackRoot = process.env.AGENTSLACK_ROOT || '/Users/zo/Projects/expsite/agentslack';
const stateDir = path.resolve(process.env.AGENTWORKS_STATE_DIR || path.join(root, '.agentworks'));
const protectedClaudeToken = path.join(stateDir, 'secrets', 'claude-oauth-token');

function probe(command, args = []) {
  try {
    const stdout = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return { available: true, value: stdout.split(/\r?\n/, 1)[0] || true };
  } catch (error) {
    return { available: false, detail: error.code === 'ENOENT' ? 'not found' : `exit ${error.status ?? 'unknown'}` };
  }
}

function commandExists(command) {
  return probe(process.platform === 'win32' ? 'where.exe' : 'which', [command]).available;
}

function state(status, detail) { return { status, detail }; }

const osFamily = process.platform === 'darwin' ? 'macos'
  : process.platform === 'linux' ? 'linux'
    : process.platform === 'win32' ? 'windows' : process.platform;
const docker = probe('docker', ['version', '--format', '{{.Server.Version}}']);
const compose = probe('docker', ['compose', 'version', '--short']);
const node = probe(process.execPath, ['--version']);
const claude = probe(process.platform === 'win32' ? 'claude.cmd' : 'claude', ['--version']);
const aws = probe(process.platform === 'win32' ? 'aws.exe' : 'aws', ['--version']);
const incus = probe('incus', ['version']);
const lxd = probe('lxc', ['version']);
const qemu = probe('qemu-system-x86_64', ['--version']);
const hyperv = process.platform === 'win32'
  ? probe('powershell.exe', ['-NoProfile', '-Command', 'if (Get-Command Get-VM -ErrorAction SilentlyContinue) { exit 0 }; exit 1'])
  : { available: false, detail: 'not a Windows host' };
const kvm = process.platform === 'linux' ? fs.existsSync('/dev/kvm') : false;

const runtime = osFamily === 'macos'
  ? state(commandExists('limactl') ? 'supported' : 'blocked', commandExists('limactl') ? 'Lima detected' : 'Lima is required by the current macOS Worker')
  : osFamily === 'linux'
    ? state((incus.available || lxd.available || qemu.available) && kvm ? 'supported' : 'blocked', (incus.available || lxd.available || qemu.available) && kvm
      ? `${incus.available ? 'Incus' : lxd.available ? 'LXD' : 'QEMU/KVM'} and /dev/kvm detected`
      : `${!kvm ? '/dev/kvm is unavailable; VM isolation requires nested virtualization or bare metal' : 'Install and initialize Incus, LXD, or QEMU/KVM before provisioning tenants'}`)
    : osFamily === 'windows'
      ? state(hyperv.available ? 'supported' : 'blocked', hyperv.available ? 'Hyper-V PowerShell module detected' : 'Enable the Hyper-V role and restart Windows before provisioning tenant VMs')
      : state('blocked', `${osFamily} Worker adapter is not implemented`);

const checks = [
  { id: 'docker', required: true, ...state(docker.available && compose.available ? 'pass' : 'blocked', docker.available && compose.available ? `Docker ${docker.value}; Compose ${compose.value}` : 'Docker Engine and Docker Compose v2 are required') },
  { id: 'node', required: true, ...state(node.available ? 'pass' : 'blocked', node.available ? node.value : 'Node.js is required for the current Host Worker') },
  { id: 'claude-cli', required: true, ...state(claude.available ? 'pass' : 'blocked', claude.available ? claude.value : 'Claude Code CLI must be available for the Claude-only test lane') },
  { id: 'aws-cli', required: true, ...state(aws.available ? 'pass' : 'blocked', aws.available ? aws.value : 'AWS CLI v2 is required by the cloud harness') },
  { id: 'runtime-adapter', required: true, ...runtime },
  ...(osFamily === 'linux' ? [{ id: 'kvm', required: true, ...state(kvm ? 'pass' : 'blocked', kvm ? '/dev/kvm is available for tenant VMs' : 'Enable nested virtualization or use a bare-metal host before creating tenant VMs') }] : []),
  { id: 'agentslack-source', required: true, ...state(fs.existsSync(agentSlackRoot) ? 'pass' : 'blocked', fs.existsSync(agentSlackRoot) ? agentSlackRoot : `Set AGENTSLACK_ROOT to a local AgentSlack clone; looked for ${agentSlackRoot}`) },
  { id: 'aws-credentials', required: true, ...state(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_WEB_IDENTITY_TOKEN_FILE ? 'present-unverified' : 'action-required', process.env.AGENTWORKS_CREDENTIAL_SOURCE === 'foragents-ssm' ? 'FORAGENTS README -> SSM process credential is present; no profile or Keychain was written.' : 'Run npm run e2e:host-preflight:ssm or inject a workload identity at runtime.') },
  { id: 'claude-auth', required: true, ...state(process.env.AGENTWORKS_CLAUDE_OAUTH_TOKEN || fs.existsSync(protectedClaudeToken) ? 'present-unverified' : 'action-required', fs.existsSync(protectedClaudeToken) ? 'Protected Agentworks host-state credential is present; its value was not read or rendered.' : 'Inject a Claude OAuth credential into the protected host-agent secret channel at runtime; do not use EC2 user-data, Keychain, or Git.') },
];

const report = {
  generatedAt: new Date().toISOString(),
  mode: 'read-only-preflight',
  repository: root,
  host: { os: os.type(), release: os.release(), platform: process.platform, arch: process.arch, cpus: os.cpus().length, memoryMib: Math.floor(os.totalmem() / 1024 / 1024) },
  currentSupport: runtime,
  checks,
  requiredDecisions: [
    'AWS region, VPC/subnet policy, and an explicit per-instance cost ceiling.',
    'Whether AM2 means Amazon Linux 2, and the Windows instance/runtime choice.',
    'A scoped security-group source CIDR for the public tenant-port probe.',
    'Whether the three stopped instances are retained (EBS cost continues) or terminated after evidence capture.',
    'Use the existing AgentSlack deployment and its agentworktest logical Server; do not create another stack.',
  ],
  nextStep: runtime.status === 'supported'
    ? 'A macOS reference run can be attempted after the required decisions and runtime credentials are supplied.'
    : 'Do not provision this host yet. Implement and verify the OS Worker adapter first.',
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(checks.some(check => check.status === 'blocked') ? 2 : 0);
