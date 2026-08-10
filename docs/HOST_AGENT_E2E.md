# Host Agent cloud E2E contract

This is the acceptance contract and executed reference run for the Host Agent. It is deliberately
not a “run arbitrary commands as root until it works” prompt. The Host Agent must
first probe the host, create a reviewable plan, obtain the approvals listed below,
apply typed adapters, and preserve redacted evidence.

Run the read-only gate through the canonical secret bootstrap first:

```sh
npm run e2e:host-preflight:ssm
npm run e2e:aws-plan:ssm
npm run e2e:release-gate
```

`AGENTSLACK_ROOT` may point to a local AgentSlack clone. The wrapper discovers
`FORAGENTS_README`, uses its fixed SSM reader only to resolve the catalogued
operational AWS credential, and passes it in child-process environment variables.
It never uses macOS Keychain, writes `~/.aws`, reads `authinfo.md`, logs
credentials, installs packages, or creates an EC2 instance. A non-zero exit means
the host must not be provisioned.

`e2e:aws-plan` is also read-only. It discovers the default VPC/subnet, official
public AMI parameters, a nested-virtualization capable instance offering, and the
current public `/32` for a least-privilege temporary tenant-port probe. It does not
create an EC2 instance, security group, IAM role, key pair, or AgentSlack object.

`e2e:release-gate` is read-only too. It refuses cloud execution until this source
is represented by an immutable, clean Git commit and a reachable `origin`; a host
must clone that exact commit rather than receiving a mutable developer directory.

After the release gate passes and an operator has explicitly approved the current
CIDR and cost envelope, the initial Ubuntu launcher is deliberately opt-in:

```sh
AGENTWORKS_E2E_APPROVE=launch-ubuntu \
AGENTWORKS_E2E_SOURCE_CIDR=x.x.x.x/32 \
npm run e2e:aws-ubuntu-launch
```

It creates one 40 GiB `c7i.2xlarge` Ubuntu 24.04 host with nested virtualization,
a source-CIDR-only SSH/temporary HTTP security group, and a generated SSH key under
ignored `.agentworks/e2e/`. It never uses EC2 user-data for Git, CLI credentials,
or Claude OAuth; the key and the subsequent runtime secret delivery stay in
protected local state. It only tags resources for later **stop**, never termination.
Because tenant VMs use the host’s LXD NAT bridge, the launcher also disables EC2
source/destination checking on that tagged test instance; without it, tenant outbound
traffic and the host-to-VM port relay cannot work.

The repository assumes Docker for normal user installs. For the clean Ubuntu cloud
test only, the Host Agent may use the narrowly scoped, explicit prerequisite step:

```sh
AGENTWORKS_HOST_BOOTSTRAP=ubuntu ./scripts/e2e/bootstrap-host-ubuntu.sh
```

It installs Docker/Compose, Node.js 24, and the Worker-native-module build tools
only when missing, verifies `/dev/kvm`, and requires an SSH reconnect after adding
the host user to the `docker` group.

Ubuntu's Snap-packaged LXD client requires capability acquisition, so its generated
Worker systemd unit uses `NoNewPrivileges=false` only for the `lxd` runtime. The
native Incus path retains `NoNewPrivileges=true`; the Host Agent records this runtime
choice in its evidence.

The LXD adapter also initializes the minimal storage pool only when no storage pool
exists. A responding LXD daemon alone is not enough: its default profile must have a
root disk device before Agentworks can launch tenant VMs.

The portable default guest reference is `ubuntu:24.04`; LXD/Incus select the
virtual-machine variant through the Worker’s `--vm` launch flag. Hosts may override
it with `AGENTWORKS_GUEST_IMAGE` only after their runtime probe verifies that image.

When Docker and Snap LXD share a host, Docker’s `FORWARD=DROP` policy otherwise
blocks LXD NAT. The generated LXD Worker unit installs an idempotent root-owned
`DOCKER-USER` bridge rule before Worker start; it permits outbound traffic from
`lxdbr0` and only established return traffic back to it.

## Current result

The 2026-08-10 clean-host AWS matrix completed on all three target operating systems:

| Host | Master web console | Host Worker / tenant runtime | Cloud E2E status |
| --- | --- | --- | --- |
| macOS | Docker Compose | Lima VZ | reference implementation |
| Ubuntu 24.04+ | Docker Compose | LXD VM adapter + systemd service | completed: 3 tenant VMs, native CLIs/MCP, Claude + Master sessions, stopped-VM wake, AgentSlack collaboration/Wiki, external HTTP route/revoke |
| Amazon Linux 2 | Docker Compose | direct QEMU/KVM VM adapter + systemd service | completed: 3 tenant VMs, native CLIs/MCP, Claude + Master sessions, stopped-VM wake, AgentSlack collaboration/Wiki, external HTTP route/revoke |
| Windows Server 2025 | WSL2 Docker Compose | Hyper-V VM adapter + SYSTEM scheduled Worker | completed: 3 tenant VMs, native CLIs/MCP, Claude + Master sessions, stopped-VM wake, AgentSlack collaboration/Wiki, external HTTP route/revoke |

Each host proved seeded-tenant isolation, a newly created third tenant, live Claude
turns in Alpha/Beta/Gamma and the Master Agent, tenant→Master and Master→tenant
messaging, and stopped-VM wake-on-message. The AgentSlack `agentworktest` logical
Server test included live DM, an existing active Tag attached to a Topic, a mention
that woke a stopped target VM, the reverse Topic reply, explicit delivery ACKs,
Wiki create/update to revision 2, Topic link, and canonical reference resolution.
The test reused the existing private AgentSlack deployment and did not create a
duplicate Portainer stack or redundant Tag.

All three approved public-port tests independently returned the nginx welcome page
through EC2 host port `20000`, then revoked the route and removed the guest container.
The three EC2 instances were stopped rather than terminated after evidence capture.
Windows used a WSL2 Master plus a host-native SYSTEM Worker and Hyper-V Generation-2
tenant VMs. A Linux Docker-only install without a VM runtime and `/dev/kvm` remains
rejected rather than silently degrading tenant VMs into containers.

## Required user approvals before any AWS mutation

The following cannot safely be inferred by the agent:

1. AWS Region, VPC/subnet selection (or permission to create an isolated test VPC),
   an instance-type/cost ceiling, and a maximum test duration.
2. Confirmation that `AM2` means **Amazon Linux 2**.
3. Windows runtime choice. Hyper-V tenant VMs can require a nested-virtualization
   capable EC2 family; WSL2 is not the same isolation contract. The adapter and
   instance selection must be decided together.
4. A scoped inbound source CIDR and a temporary port range for the public web
   probe. The Agentworks Master console remains loopback-only by default.
5. Cleanup policy: `stop` retains EBS volumes and still costs money; `terminate`
   destroys the test hosts. Tag every resource with a run ID either way.
6. Claude OAuth delivery mechanism. It must be supplied only to the target host at
   runtime (for example a short-lived, scoped secret reference), never via Git,
   launch arguments, EC2 user-data, or captured test logs.
7. AgentSlack scope is fixed: use the existing private deployment and its
   `agentworktest` logical Server. Do not create a second stack. The control-plane
   admin repairs/bootstrap this logical Server and Agentworks keeps isolated
   per-session identities in ignored mode-0600 Worker state.

## Target architecture after adapters exist

```text
Host Agent (host process, Claude-only during this test)
  ├─ typed host adapter (Incus/systemd, Hyper-V/WSL2, or Lima)
  ├─ Agentworks Master (Docker Compose, loopback console)
  ├─ localagentworker (host service)
  └─ tenant VM A / tenant VM B
       ├─ persistent workspace + CLI auth state volume
       ├─ Claude Code + Agentworks bridge MCP
       └─ approved host-port relay
```

The Host Agent owns installation and evidence collection. The Master Agent may
operate cells through the Worker’s typed command protocol, but does not receive an
unrestricted Docker socket or cloud credentials.

## Per-host execution sequence

1. **Probe** — run the preflight; discover OS, architecture, Docker,
   virtualization capability, host service manager, and local firewall without
   changing state.
2. **Plan** — emit a redacted JSON plan with AMI, instance type, disk size,
   resource ceilings, ports, secret *references* and rollback/cleanup commands.
   Abort if a required approval is missing.
3. **Provision** — create one tagged test instance per approved OS. Wait for a
   host-agent channel (SSM or the approved SSH/RDP alternative) before installing.
4. **Install** — clone the immutable release, run the platform-specific host
   prerequisite script only when its preflight requires it, start the Master, install the Worker
   adapter, and inject only the Claude credential through the approved runtime
   secret path. Verify with `agentworks doctor` and a platform-specific smoke test.
5. **Functional matrix** — create the two seeded tenants plus one new tenant;
   create Claude sessions in every cell and the Master; verify durable
   Master↔tenant messaging, an interrupted target turn, Worker restart, VM stop,
   and wake-on-message recovery.
6. **AgentSlack matrix** — use the logical private `agentworktest` Server inside
   the existing `toomuch` deployment, register the Master and tenant sessions with isolated
   identities, then verify Tag fan-out, Topic reply/mention, live wake, stopped
   session recovery wake, explicit ACK, Wiki create/update/link/resolve, and Watch.
7. **Port matrix** — have a tenant serve an HTTP response on a VM loopback port;
   request a route from the Master; approve it; assert the tenant receives the
   approved port metadata; curl the public EC2 address from an independent probe;
   revoke the route and verify failure.
8. **Evidence and cleanup** — retain only redacted JSON/JUnit-style evidence and
   resource IDs. Stop or terminate instances according to the pre-approved policy.

## Follow-up hardening

There are no open acceptance gaps in the executed three-OS matrix. Future work is
operational hardening: emit one machine-readable report artifact automatically,
replace Amazon Linux 2's compatibility Node 16 lane when the OS reaches retirement,
and add routine CI lanes where nested virtualization is available. These are not
fallbacks from the VM isolation, durable wake, AgentSlack, or central-port contracts
proved above.

## Acceptance evidence

Each OS emits a redacted run report containing host probe, install version hashes,
Master/Worker health, tenant and session IDs, AgentSlack object IDs, delivery IDs
for both live and recovery wake, port-route ID and independent HTTP assertion,
plus cleanup state. Secrets, raw auth headers, OAuth tokens, private keys and
message bodies are never evidence.

### 2026-08-10 redacted evidence

| OS | EC2 instance | AgentSlack live / stopped wake / reply | Wiki revision | Approved port route | Cleanup |
| --- | --- | --- | --- | --- | --- |
| Ubuntu 24.04 | `i-0a35714460f5f7325` | `186af52a-714e-4614-a137-592c5471fb1a` / `9979aa2c-729b-41fa-ae31-c40ed42707c3` / `a4f3ccfe-4dc0-4202-84cd-3854ae964299` | `62935a1d-9203-42e7-819f-a3984a05c118` @ 2 | `e9d4646a-a9c7-4222-b38b-68213b056af7`, externally asserted then revoked | stopped |
| Amazon Linux 2 | `i-082546e47ef8507e8` | `da856aca-6a48-4be3-ad22-13cdbfde6acf` / `07022067-e9ec-4203-88e5-83c1717d07b3` / `60b92800-e67b-45ca-9051-b5ca82acb395` | `3971c471-27b1-48cf-8173-8d3b1a9c630d` @ 2 | `a6e57b8c-135b-44c8-ba34-fcbdc50e8a0f`, externally asserted then revoked | stopped |
| Windows Server 2025 | `i-0ca4931bba3a15a10` | `bc40d6d4-ea54-4168-8476-4779dcf81c43` / `09d3f1ff-6c02-4e08-a5b3-3d87d7120806` / `327e8463-8886-4739-b712-5e10abdb2393` | `a6cd9b07-b6db-4f38-ab7a-338c258b7bc2` @ 2 | `4278fc6b-c9db-4915-a36e-167830ca71e5`, externally asserted then revoked | stopped |

The UUIDs above are object identifiers only. OAuth credentials, AgentSlack bearer
tokens, SSH private keys, AWS credentials, and message bodies are excluded.
