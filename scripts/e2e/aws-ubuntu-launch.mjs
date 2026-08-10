#!/usr/bin/env node
/**
 * Create one explicitly-approved Ubuntu Host Agent E2E instance.
 *
 * Credentials are supplied by the invoker's AWS profile/role/environment. This
 * script never reads authinfo.md and never places credentials or Claude OAuth in
 * EC2 user-data. It writes only the generated SSH key and a redacted run record
 * to the ignored Agentworks state directory.
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.AGENTWORKS_E2E_APPROVE !== 'launch-ubuntu') {
  throw new Error('Refusing AWS mutation. Set AGENTWORKS_E2E_APPROVE=launch-ubuntu for this one-time Ubuntu launch.');
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const stateDir = path.resolve(process.env.AGENTWORKS_STATE_DIR || path.join(root, '.agentworks'));
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const instanceType = process.env.AGENTWORKS_E2E_INSTANCE_TYPE || 'c7i.2xlarge';
const sourceCidr = process.env.AGENTWORKS_E2E_SOURCE_CIDR;
const runId = `agentworks-e2e-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
if (!sourceCidr || !/^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(sourceCidr)) throw new Error('Set AGENTWORKS_E2E_SOURCE_CIDR to the approved operator CIDR, for example 203.0.113.4/32.');

function aws(args) {
  return JSON.parse(execFileSync('aws', [...args, '--region', region, '--output', 'json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AWS_PAGER: '' }, timeout: 60_000,
  }));
}
function tagSpecifications(resourceType) {
  return `ResourceType=${resourceType},Tags=[{Key=Name,Value=${runId}},{Key=agentworks:e2e,Value=true},{Key=agentworks:run-id,Value=${runId}},{Key=agentworks:cleanup,Value=stop-not-terminate}]`;
}

const vpc = aws(['ec2', 'describe-vpcs', '--filters', 'Name=is-default,Values=true']).Vpcs?.[0];
if (!vpc) throw new Error('Default VPC is required by this initial E2E launcher.');
const offerings = aws(['ec2', 'describe-instance-type-offerings', '--location-type', 'availability-zone', '--filters', `Name=instance-type,Values=${instanceType}`]).InstanceTypeOfferings || [];
const offeredZones = new Set(offerings.map(item => item.Location));
const subnet = (aws(['ec2', 'describe-subnets', '--filters', `Name=vpc-id,Values=${vpc.VpcId}`]).Subnets || [])
  .filter(item => item.MapPublicIpOnLaunch && offeredZones.has(item.AvailabilityZone))
  .sort((a, b) => a.AvailabilityZone.localeCompare(b.AvailabilityZone))[0];
if (!subnet) throw new Error(`${instanceType} is not offered in a public default-VPC subnet.`);
const imageId = aws(['ssm', 'get-parameter', '--name', '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id']).Parameter?.Value;
if (!imageId) throw new Error('Ubuntu 24.04 public SSM AMI parameter did not resolve.');

const group = aws(['ec2', 'create-security-group', '--group-name', runId, '--description', 'Temporary Agentworks Ubuntu host E2E', '--vpc-id', vpc.VpcId, '--tag-specifications', tagSpecifications('security-group')]);
const groupId = group.GroupId;
try {
  aws(['ec2', 'authorize-security-group-ingress', '--group-id', groupId, '--ip-permissions', JSON.stringify([
    { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: sourceCidr, Description: 'temporary Host Agent SSH' }] },
    { IpProtocol: 'tcp', FromPort: 20000, ToPort: 20020, IpRanges: [{ CidrIp: sourceCidr, Description: 'temporary tenant HTTP E2E probe' }] },
  ])]);
  const key = aws(['ec2', 'create-key-pair', '--key-name', runId, '--key-type', 'ed25519', '--key-format', 'pem', '--tag-specifications', tagSpecifications('key-pair')]);
  const runDir = path.join(stateDir, 'e2e', runId);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(runDir, 'host.pem');
  fs.writeFileSync(keyPath, key.KeyMaterial, { mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);
  const launched = aws(['ec2', 'run-instances', '--image-id', imageId, '--instance-type', instanceType, '--key-name', runId, '--security-group-ids', groupId, '--subnet-id', subnet.SubnetId, '--count', '1', '--cpu-options', 'NestedVirtualization=enabled', '--metadata-options', 'HttpTokens=required,HttpEndpoint=enabled', '--block-device-mappings', 'DeviceName=/dev/sda1,Ebs={VolumeSize=40,VolumeType=gp3,DeleteOnTermination=false}', '--tag-specifications', tagSpecifications('instance'), tagSpecifications('volume')]);
  const instance = launched.Instances?.[0];
  if (!instance?.InstanceId) throw new Error('AWS did not return an instance id.');
  // Tenant VMs live behind the Host Agent's LXD NAT bridge. EC2 must allow this
  // host to forward packets whose source/destination is not the host itself.
  aws(['ec2', 'modify-instance-attribute', '--instance-id', instance.InstanceId, '--no-source-dest-check']);
  const record = { runId, region, instanceId: instance.InstanceId, instanceType, imageId, vpcId: vpc.VpcId, subnetId: subnet.SubnetId, availabilityZone: subnet.AvailabilityZone, securityGroupId: groupId, keyName: runId, keyPath, sourceCidr, cleanup: 'stop-not-terminate' };
  fs.writeFileSync(path.join(runDir, 'launch.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ...record, keyPath: '[protected state file]' }, null, 2));
} catch (error) {
  console.error(`Launch ${runId} failed after creating security group ${groupId}. Preserve this identifier for review; the script does not delete resources automatically.`);
  throw error;
}
