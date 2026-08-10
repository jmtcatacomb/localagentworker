#!/usr/bin/env node
/** Launch one explicit Windows Server Hyper-V Host Worker E2E instance. */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.AGENTWORKS_E2E_APPROVE !== 'launch-windows') throw new Error('Set AGENTWORKS_E2E_APPROVE=launch-windows to create a Windows E2E host.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const stateDir = path.resolve(process.env.AGENTWORKS_STATE_DIR || path.join(root, '.agentworks'));
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const instanceType = process.env.AGENTWORKS_E2E_INSTANCE_TYPE || 'c7i.2xlarge';
const sourceCidr = process.env.AGENTWORKS_E2E_SOURCE_CIDR;
if (!sourceCidr || !/^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(sourceCidr)) throw new Error('Set AGENTWORKS_E2E_SOURCE_CIDR to the approved operator CIDR.');
const runId = `agentworks-windows-e2e-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
function aws(args) {
  const output = execFileSync('aws', [...args, '--region', region, '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AWS_PAGER: '' }, timeout: 90_000 }).trim();
  return output ? JSON.parse(output) : {};
}
function tags(type) { return `ResourceType=${type},Tags=[{Key=Name,Value=${runId}},{Key=agentworks:e2e,Value=true},{Key=agentworks:os,Value=windows},{Key=agentworks:run-id,Value=${runId}},{Key=agentworks:cleanup,Value=stop-not-terminate}]`; }
const vpc = aws(['ec2', 'describe-vpcs', '--filters', 'Name=is-default,Values=true']).Vpcs?.[0]; if (!vpc) throw new Error('Default VPC is required.');
const zones = new Set((aws(['ec2', 'describe-instance-type-offerings', '--location-type', 'availability-zone', '--filters', `Name=instance-type,Values=${instanceType}`]).InstanceTypeOfferings || []).map(row => row.Location));
const subnet = (aws(['ec2', 'describe-subnets', '--filters', `Name=vpc-id,Values=${vpc.VpcId}`]).Subnets || []).filter(row => row.MapPublicIpOnLaunch && zones.has(row.AvailabilityZone)).sort((a,b) => a.AvailabilityZone.localeCompare(b.AvailabilityZone))[0];
if (!subnet) throw new Error(`${instanceType} is unavailable in a public default-VPC subnet.`);
const imageId = aws(['ssm', 'get-parameter', '--name', '/aws/service/ami-windows-latest/Windows_Server-2025-English-Full-Base']).Parameter?.Value; if (!imageId) throw new Error('Windows Server public SSM AMI parameter did not resolve.');
const group = aws(['ec2', 'create-security-group', '--group-name', runId, '--description', 'Temporary Agentworks Windows Hyper-V E2E', '--vpc-id', vpc.VpcId, '--tag-specifications', tags('security-group')]);
const groupId = group.GroupId;
try {
  aws(['ec2', 'authorize-security-group-ingress', '--group-id', groupId, '--ip-permissions', JSON.stringify([
    { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: sourceCidr, Description: 'temporary OpenSSH bootstrap' }] },
    { IpProtocol: 'tcp', FromPort: 3389, ToPort: 3389, IpRanges: [{ CidrIp: sourceCidr, Description: 'temporary RDP recovery' }] },
    { IpProtocol: 'tcp', FromPort: 20000, ToPort: 20020, IpRanges: [{ CidrIp: sourceCidr, Description: 'temporary tenant HTTP E2E probe' }] },
  ])]);
  // EC2 Windows AMIs reject ED25519 key pairs even though Linux hosts accept
  // them. RSA remains compatible with both EC2 password encryption and the
  // OpenSSH bootstrap public key recovered through IMDSv2.
  const key = aws(['ec2', 'create-key-pair', '--key-name', runId, '--key-type', 'rsa', '--key-format', 'pem', '--tag-specifications', tags('key-pair')]);
  const runDir = path.join(stateDir, 'e2e', runId); fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(runDir, 'host.pem'); fs.writeFileSync(keyPath, key.KeyMaterial, { mode: 0o600 }); fs.chmodSync(keyPath, 0o600);
  // The only bootstrap access is the EC2 key pair's public key from IMDSv2.
  // No password, OAuth credential, or repository token is in user-data.
  const userData = `<powershell>\n$ErrorActionPreference='Stop'\n$token=Invoke-RestMethod -Method PUT -Headers @{'X-aws-ec2-metadata-token-ttl-seconds'='21600'} -Uri 'http://169.254.169.254/latest/api/token'\n$pub=Invoke-RestMethod -Headers @{'X-aws-ec2-metadata-token'=$token} -Uri 'http://169.254.169.254/latest/meta-data/public-keys/0/openssh-key'\nAdd-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0\nNew-Item -ItemType Directory -Force \"$env:ProgramData\\ssh\" | Out-Null\n$authorized=\"$env:ProgramData\\ssh\\administrators_authorized_keys\"\nSet-Content -NoNewline -Encoding ascii $authorized $pub\nicacls $authorized /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null\nSet-Service sshd -StartupType Automatic\nStart-Service sshd\nNew-NetFirewallRule -Name AgentworksOpenSSH -DisplayName 'Agentworks OpenSSH bootstrap' -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow | Out-Null\nInstall-WindowsFeature -Name Hyper-V -IncludeManagementTools -Restart\n</powershell>\n`;
  const userDataPath = path.join(runDir, 'user-data.ps1'); fs.writeFileSync(userDataPath, userData, { mode: 0o600 });
  const launched = aws(['ec2', 'run-instances', '--image-id', imageId, '--instance-type', instanceType, '--key-name', runId, '--security-group-ids', groupId, '--subnet-id', subnet.SubnetId, '--count', '1', '--cpu-options', 'NestedVirtualization=enabled', '--metadata-options', 'HttpTokens=required,HttpEndpoint=enabled', '--user-data', `fileb://${userDataPath}`, '--block-device-mappings', 'DeviceName=/dev/sda1,Ebs={VolumeSize=80,VolumeType=gp3,DeleteOnTermination=false}', '--tag-specifications', tags('instance'), tags('volume')]);
  const instance = launched.Instances?.[0]; if (!instance?.InstanceId) throw new Error('AWS did not return an instance ID.');
  aws(['ec2', 'modify-instance-attribute', '--instance-id', instance.InstanceId, '--no-source-dest-check']);
  const record = { runId, region, instanceId: instance.InstanceId, instanceType, imageId, vpcId: vpc.VpcId, subnetId: subnet.SubnetId, availabilityZone: subnet.AvailabilityZone, securityGroupId: groupId, keyName: runId, keyPath, sourceCidr, cleanup: 'stop-not-terminate' };
  fs.writeFileSync(path.join(runDir, 'launch.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ...record, keyPath: '[protected state file]' }, null, 2));
} catch (error) { console.error(`Launch ${runId} failed after security-group creation ${groupId}; resources are intentionally preserved for review.`); throw error; }
