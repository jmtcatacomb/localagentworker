#!/usr/bin/env node
/**
 * Read-only AWS discovery for the Agentworks OS E2E harness.
 *
 * Credentials normally come from `with-foragents-ssm.sh` as process-scoped
 * environment variables. This command never reads authinfo.md, Keychain, or a
 * local AWS profile and never mutates AWS.
 */
import { execFileSync } from 'node:child_process';
import { ensureFetch } from '../lib/node-fetch-compat.mjs';

ensureFetch(import.meta.url);

const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const instanceType = process.env.AGENTWORKS_E2E_INSTANCE_TYPE || 'c7i.2xlarge';

function aws(args) {
  try {
    return { ok: true, data: JSON.parse(execFileSync('aws', [...args, '--region', region, '--output', 'json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AWS_PAGER: '' }, timeout: 25_000,
    })) };
  } catch (error) {
    const detail = String(error.stderr || error.message || '').replace(/(AKIA|ASIA)[A-Z0-9]+/g, '[redacted]').slice(0, 500);
    return { ok: false, detail };
  }
}

const vpcs = aws(['ec2', 'describe-vpcs', '--filters', 'Name=is-default,Values=true']);
const vpc = vpcs.ok ? vpcs.data.Vpcs?.[0] : null;
const subnets = vpc ? aws(['ec2', 'describe-subnets', '--filters', `Name=vpc-id,Values=${vpc.VpcId}`]) : { ok: false, detail: 'default VPC not found' };
const offerings = aws(['ec2', 'describe-instance-type-offerings', '--location-type', 'availability-zone', '--filters', `Name=instance-type,Values=${instanceType}`]);
const publicParameters = {
  ubuntu: '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id',
  amazonLinux2: '/aws/service/ami-amazon-linux-latest/amzn2-ami-hvm-x86_64-gp2',
  windows: '/aws/service/ami-windows-latest/Windows_Server-2025-English-Full-Base',
};
const images = Object.fromEntries(Object.entries(publicParameters).map(([name, parameter]) => {
  const response = aws(['ssm', 'get-parameter', '--name', parameter]);
  return [name, response.ok ? { parameter, imageId: response.data.Parameter?.Value || null } : { parameter, error: response.detail }];
}));

let sourceCidr = process.env.AGENTWORKS_E2E_SOURCE_CIDR || null;
if (!sourceCidr) {
  try {
    const response = await fetch('https://checkip.amazonaws.com', { signal: AbortSignal.timeout(5000) });
    const ip = (await response.text()).trim();
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) sourceCidr = `${ip}/32`;
  } catch {}
}

const selectedSubnet = subnets.ok
  ? [...subnets.data.Subnets].sort((a, b) => Number(Boolean(b.MapPublicIpOnLaunch)) - Number(Boolean(a.MapPublicIpOnLaunch)) || a.AvailabilityZone.localeCompare(b.AvailabilityZone))[0]
  : null;
const offeredZones = offerings.ok ? offerings.data.InstanceTypeOfferings.map(item => item.Location) : [];
const plan = {
  generatedAt: new Date().toISOString(),
  mode: 'read-only-aws-plan',
  region,
  instanceType,
  nestedVirtualization: { requested: true, availableZones: offeredZones, supported: offeredZones.length > 0 },
  network: vpc && selectedSubnet ? {
    vpcId: vpc.VpcId, subnetId: selectedSubnet.SubnetId, availabilityZone: selectedSubnet.AvailabilityZone,
    autoPublicIp: Boolean(selectedSubnet.MapPublicIpOnLaunch), sourceCidr,
    proposedInbound: sourceCidr ? [{ protocol: 'tcp', ports: '20000-20020', source: sourceCidr, purpose: 'temporary Agentworks tenant HTTP E2E probe' }] : [],
  } : { error: subnets.detail || 'no default VPC/subnet available' },
  images,
  executionGates: [
    'Apply must tag every resource with a unique run ID and use stop, not terminate, during the requested test phase.',
    'Ubuntu Host Worker requires Incus plus /dev/kvm. Amazon Linux 2 requires a compatible runtime selected by its host probe.',
    'Windows is not provisionable until its Hyper-V/WSL2 adapter probe passes.',
    'The source repository must be committed and reachable at AGENTWORKS_GIT_URL before a remote host can clone it.',
    'Claude OAuth is injected at runtime through the Host Agent secret channel, never user-data or a repository file.',
  ],
};
console.log(JSON.stringify(plan, null, 2));
process.exit(vpc && selectedSubnet && offeredZones.length && Object.values(images).every(image => image.imageId) ? 0 : 2);
