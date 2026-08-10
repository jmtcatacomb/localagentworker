import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('runtime state is ignored', () => {
  const ignore = fs.readFileSync('.gitignore', 'utf8');
  assert.match(ignore, /^\.agentworks\/$/m);
});

test('inter-session delivery has stable identity, channels, and durable queue state', () => {
  const schema = fs.readFileSync('master/src/schema.sql', 'utf8');
  const server = fs.readFileSync('master/src/server.mjs', 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS agent_sessions/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS session_messages/);
  assert.match(schema, /idempotency_key text UNIQUE NOT NULL/);
  assert.match(schema, /agent_sessions_namespaced_alias_idx/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS session_channels/);
  assert.match(schema, /session_message_events/);
  assert.match(server, /deliveryEnabled: true/);
  assert.match(server, /drainInterSessionQueue/);
  assert.match(server, /target\.archived_at IS NULL/);
});

test('workspace chat sessions use stable UUIDs and resumable native mappings', () => {
  const schema = fs.readFileSync('master/src/schema.sql', 'utf8');
  const server = fs.readFileSync('master/src/server.mjs', 'utf8');
  const worker = fs.readFileSync('worker/src/worker.mjs', 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS chat_messages/);
  assert.match(schema, /native_session_id text/);
  assert.match(server, /workspace\.describe/);
  assert.match(server, /session\.turn/);
  assert.match(server, /app\.patch\('\/api\/sessions\/:sessionUuid'/);
  assert.match(server, /providerLocked: true/);
  assert.match(worker, /codex app-server/);
  assert.match(worker, /--resume/);
  assert.match(worker, /session\.wake/);
  assert.match(worker, /bridge\.outbox/);
});

test('VM bridge exposes deterministic MCP tools and a credentialless durable outbox', () => {
  const bridge = fs.readFileSync('worker/bridge/agentworks_bridge.py', 'utf8');
  assert.match(bridge, /sessions_list_known/);
  assert.match(bridge, /sessions_send/);
  assert.match(bridge, /sessions_reply/);
  assert.match(bridge, /sessions_fanout_send/);
  assert.match(bridge, /sessions_status/);
  assert.doesNotMatch(bridge, /WORKER_TOKEN|DATABASE_URL|JWT_SECRET/);
});

test('workspace model discovery does not depend on session turn state', () => {
  const worker = fs.readFileSync('worker/src/worker.mjs', 'utf8');
  assert.match(worker, /async function codexModels\(cell\) \{\s+const client = await openCodexAppServer\(cell\);/);
});

test('managed turns inject identity, directory, and visible reasoning summaries', () => {
  const worker = fs.readFileSync('worker/src/worker.mjs', 'utf8');
  const ui = fs.readFileSync('master/public/app.js', 'utf8');
  assert.match(worker, /sessionRuntimeInstructions/);
  assert.match(worker, /developerInstructions: payload\.runtimeInstructions/);
  assert.match(worker, /item\/reasoning\/summaryTextDelta/);
  assert.match(worker, /summary: 'detailed'/);
  assert.match(worker, /Reasoning \/ progress/);
  assert.match(ui, /class="activity-group" \$\{streaming \? 'open' : ''\}/);
  assert.match(ui, /LIVE ACTIVITY/);
  assert.match(ui, /\/ws\/session/);
  assert.match(ui, /session-stop/);
  assert.match(ui, /스티어링/);
});

test('master has no host runtime socket mount', () => {
  const compose = fs.readFileSync('compose.yaml', 'utf8');
  assert.doesNotMatch(compose, /docker\.sock|incus\/unix\.socket/);
});

test('Master Agent is a first-class system session with audited admin capabilities', () => {
  const schema = fs.readFileSync('master/src/schema.sql', 'utf8');
  const server = fs.readFileSync('master/src/server.mjs', 'utf8');
  const worker = fs.readFileSync('worker/src/worker.mjs', 'utf8');
  const bridge = fs.readFileSync('worker/bridge/agentworks_admin_bridge.py', 'utf8');
  const ui = fs.readFileSync('master/public/app.js', 'utf8');
  assert.match(schema, /kind IN \('tenant','master'\)/);
  assert.match(server, /cell-master/);
  assert.match(worker, /same session identity, messaging, goal, streaming, stop, and steering rules/);
  assert.match(bridge, /admin_list_cells/);
  assert.match(bridge, /admin_create_tenant/);
  assert.match(bridge, /admin_set_cell_resources/);
  assert.match(bridge, /admin_open_port/);
  assert.match(bridge, /admin_vm_exec/);
  assert.match(bridge, /admin_vm_diagnostics/);
  assert.match(bridge, /admin_vm_repair_bridge/);
  assert.match(server, /vm\.exec\.requested/);
  assert.match(worker, /async function executeVmCommand/);
  assert.match(ui, /data-workspace="cell-master"/);
  assert.match(server, /master\.worker_id='mac-local'/);
  assert.match(server, /master\.kind='master'/);
});

test('superadmin can create a tenant cell without exposing its initial password to audit data', () => {
  const server = fs.readFileSync('master/src/server.mjs', 'utf8');
  const ui = fs.readFileSync('master/public/app.js', 'utf8');
  assert.match(server, /app\.post\('\/api\/admin\/tenants'/);
  assert.match(server, /tenant\.create/);
  assert.match(server, /bcrypt\.hash\(password/);
  assert.doesNotMatch(server, /ownerEmail: email, password/);
  assert.match(ui, /id="tenant-create"/);
});

test('Linux host adapter preserves the Worker command boundary and requires VM hardware support', () => {
  const installer = fs.readFileSync('agentworks', 'utf8');
  const systemd = fs.readFileSync('scripts/install-systemd.mjs', 'utf8');
  const adapter = fs.readFileSync('worker/runtime/incus_lima_compat.mjs', 'utf8');
  const qemuAdapter = fs.readFileSync('worker/runtime/qemu-limactl.mjs', 'utf8');
  const hypervAdapter = fs.readFileSync('worker/runtime/hyperv-limactl.ps1', 'utf8');
  const windowsInstaller = fs.readFileSync('agentworks.ps1', 'utf8');
  const windowsWorkerInstaller = fs.readFileSync('scripts/install-windows-worker.ps1', 'utf8');
  const preflight = fs.readFileSync('scripts/e2e/host-agent-preflight.mjs', 'utf8');
  const foragents = fs.readFileSync('scripts/e2e/with-foragents-ssm.sh', 'utf8');
  const awsPlan = fs.readFileSync('scripts/e2e/aws-plan.mjs', 'utf8');
  const releaseGate = fs.readFileSync('scripts/e2e/release-gate.mjs', 'utf8');
  const ubuntuLaunch = fs.readFileSync('scripts/e2e/aws-ubuntu-launch.mjs', 'utf8');
  const windowsLaunch = fs.readFileSync('scripts/e2e/aws-windows-launch.mjs', 'utf8');
  const ubuntuBootstrap = fs.readFileSync('scripts/e2e/bootstrap-host-ubuntu.sh', 'utf8');
  const amazonLinuxBootstrap = fs.readFileSync('scripts/e2e/bootstrap-host-amazonlinux2.sh', 'utf8');
  const lxdForwarding = fs.readFileSync('worker/runtime/lxd-docker-forwarding.sh', 'utf8');
  assert.match(installer, /setup_worker_linux/);
  assert.match(foragents, /FORAGENTS_SSM_READER_CREDENTIALS_BEGIN/);
  assert.match(foragents, /choewz-programming\/access-key-id/);
  assert.doesNotMatch(foragents, /security find|docker login|authinfo\.md/);
  assert.match(foragents, /unset AWS_SESSION_TOKEN AWS_PROFILE AWS_DEFAULT_PROFILE/);
  assert.match(systemd, /SupplementaryGroups=\$\{runtimeGroup\}/);
  assert.match(adapter, /\['launch', image, name, '--vm'/);
  assert.match(adapter, /ubuntu:24\.04/);
  assert.match(adapter, /\['exec', name, \.\.\.identity, '--'/);
  assert.match(preflight, /\/dev\/kvm/);
  assert.match(awsPlan, /read-only-aws-plan/);
  assert.match(awsPlan, /nestedVirtualization/);
  assert.match(releaseGate, /read-only-release-gate/);
  assert.match(releaseGate, /immutable commit/);
  assert.match(ubuntuLaunch, /AGENTWORKS_E2E_APPROVE/);
  assert.match(ubuntuLaunch, /NestedVirtualization=enabled/);
  assert.match(ubuntuLaunch, /no-source-dest-check/);
  assert.match(ubuntuLaunch, /stop-not-terminate/);
  assert.match(windowsLaunch, /AGENTWORKS_E2E_APPROVE.*launch-windows/);
  assert.match(windowsLaunch, /OpenSSH.Server/);
  assert.match(windowsLaunch, /Install-WindowsFeature -Name Hyper-V/);
  assert.match(ubuntuBootstrap, /AGENTWORKS_HOST_BOOTSTRAP/);
  assert.match(ubuntuBootstrap, /\/dev\/kvm/);
  assert.match(ubuntuBootstrap, /docker-compose-v2/);
  assert.match(ubuntuBootstrap, /build-essential/);
  assert.match(amazonLinuxBootstrap, /AGENTWORKS_HOST_BOOTSTRAP=amazonlinux2/);
  assert.match(amazonLinuxBootstrap, /docker compose version/);
  assert.match(amazonLinuxBootstrap, /amazon-linux-extras install -y docker/);
  assert.match(amazonLinuxBootstrap, /docker-compose-linux-/);
  assert.match(amazonLinuxBootstrap, /docker buildx version/);
  assert.match(amazonLinuxBootstrap, /docker\/buildx\/releases/);
  assert.match(amazonLinuxBootstrap, /nodejs\.org\/dist/);
  assert.match(amazonLinuxBootstrap, /Node 16\.20\.2/);
  assert.match(amazonLinuxBootstrap, /--experimental-fetch/);
  assert.match(amazonLinuxBootstrap, /qemu-kvm/);
  assert.match(amazonLinuxBootstrap, /genisoimage/);
  assert.match(amazonLinuxBootstrap, /\/dev\/kvm/);
  assert.match(installer, /lxc storage list --format csv/);
  assert.match(installer, /lxd init --minimal/);
  assert.match(installer, /AGENTWORKS_GUEST_HOME/);
  assert.match(systemd, /\/snap\/bin/);
  assert.match(systemd, /systemctl', 'restart'/);
  assert.match(systemd, /runtime === 'lxd' \? 'false' : 'true'/);
  assert.match(systemd, /lxd-docker-forwarding/);
  assert.match(systemd, /iptables -C DOCKER-USER/);
  assert.match(lxdForwarding, /DOCKER-USER/);
  assert.match(lxdForwarding, /RELATED,ESTABLISHED/);
  assert.match(systemd, /AGENTWORKS_GUEST_UID/);
  assert.match(adapter, /AGENTWORKS_GUEST_HOME/);
  assert.match(adapter, /guestPath/);
  assert.match(adapter, /--user/);
  assert.match(qemuAdapter, /qemu-system-x86_64/);
  assert.match(qemuAdapter, /hostfwd=tcp:127\.0\.0\.1/);
  assert.match(qemuAdapter, /sshReady/);
  assert.match(hypervAdapter, /New-VM/);
  assert.match(hypervAdapter, /New-VHD/);
  assert.match(hypervAdapter, /Default Switch/);
  assert.match(hypervAdapter, /cidata/);
  assert.match(hypervAdapter, /vmId=\$vm\.Id\.ToString\(\)/);
  assert.match(hypervAdapter, /function Resolve-VM/);
  assert.doesNotMatch(hypervAdapter, /Start-VM -Name \(Vm-Name/);
  assert.match(windowsInstaller, /Install-WindowsFeature -Name Hyper-V/);
  assert.match(windowsWorkerInstaller, /HOST_RUNTIME = 'hyperv'/);
});

test('Claude-only bootstrap uses protected host state rather than Git or service environment', () => {
  const worker = fs.readFileSync('worker/src/worker.mjs', 'utf8');
  const importer = fs.readFileSync('scripts/import-claude-oauth.mjs', 'utf8');
  const installer = fs.readFileSync('agentworks', 'utf8');
  assert.match(worker, /syncClaudeOauthToCell/);
  assert.match(worker, /syncClaudeOauthToMasterHome/);
  assert.match(worker, /install -m 600/);
  assert.match(worker, /crypto\.randomUUID\(\)/);
  assert.match(worker, /bridge_command/);
  assert.match(worker, /durable all-or-nothing readiness marker/);
  assert.match(importer, /mode: 0o600/);
  assert.match(installer, /import-claude-oauth/);
});

test('host-to-VM ports are centrally allocated, live-revocable, and audited', () => {
  const schema = fs.readFileSync('master/src/schema.sql', 'utf8');
  const server = fs.readFileSync('master/src/server.mjs', 'utf8');
  const worker = fs.readFileSync('worker/src/worker.mjs', 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS port_routes/);
  assert.match(server, /port\.open/);
  assert.match(server, /port\.revoke/);
  assert.match(worker, /net\.createServer/);
  assert.match(worker, /async function revokePortRoute/);
  assert.match(worker, /async function applyResources/);
});

test('agent activity, usage telemetry, and safe markdown are persisted', () => {
  const schema = fs.readFileSync('master/src/schema.sql', 'utf8');
  const server = fs.readFileSync('master/src/server.mjs', 'utf8');
  const worker = fs.readFileSync('worker/src/worker.mjs', 'utf8');
  const ui = fs.readFileSync('master/public/app.js', 'utf8');
  assert.match(schema, /provider_usage_snapshots/);
  assert.match(schema, /telemetry jsonb/);
  assert.match(server, /sanitizeHtml/);
  assert.match(server, /account\/rateLimits\/read|usageOverview/);
  assert.match(worker, /thread\/tokenUsage\/updated/);
  assert.match(worker, /Codex app-server .*timed out/);
  assert.match(worker, /rate_limit_event/);
  assert.match(worker, /type: 'file_change'/);
  assert.match(worker, /type: 'subagent'/);
  assert.match(ui, /activity-timeline/);
  assert.match(ui, /markdown-body/);
  assert.match(server, /gif\|png\|jpe\?g\|webp\|svg/);
  assert.match(server, /'table', 'thead', 'tbody'/);
});

test('AgentSlack wake bindings keep tokens in Worker state and ACK only after exact-session completion', () => {
  const schema = fs.readFileSync('master/src/schema.sql', 'utf8');
  const server = fs.readFileSync('master/src/server.mjs', 'utf8');
  const worker = fs.readFileSync('worker/src/worker.mjs', 'utf8');
  const adapter = fs.readFileSync('worker/integrations/agentslack.mjs', 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS agentslack_delivery_links/);
  assert.match(server, /ingestAgentSlackDelivery/);
  assert.match(server, /notifyAgentSlackAcknowledged/);
  assert.match(server, /target\.worker_id !== workerId/);
  assert.match(worker, /AgentSlackDeliveryAdapter/);
  assert.match(worker, /guestBridgeArgs/);
  assert.doesNotMatch(worker, /AGENTWORKS_GUEST_HOME|\/home\/ubuntu\/\.local\/bin\/agentworks-bridge/);
  assert.match(worker, /agentslack\.delivery\.rejected/);
  assert.match(adapter, /cursor=\$\{cursor\}&auto_ack=false&limit=1/);
  assert.match(adapter, /await wait\(3_000\)/);
  assert.doesNotMatch(adapter, /\/inbox\/stream/);
  assert.match(worker, /masterRegistered/);
  assert.match(adapter, /agentworks_worker_not_registered/);
  assert.match(adapter, /'agentslack', 'bindings\.json'/);
  const sync = fs.readFileSync('scripts/sync-agentslack.mjs', 'utf8');
  assert.match(sync, /archived_at IS NULL/);
  assert.match(sync, /identityMode: 'host_verified'/);
  assert.match(sync, /mode: 0o600/);
  assert.match(sync, /AgentSlack register/);
  assert.match(adapter, /auto_ack=false/);
  assert.match(adapter, /inbox\/ack/);
  assert.doesNotMatch(server, /AGENTSLACK_(?:TOKEN|BEARER|SECRET)/);
});
