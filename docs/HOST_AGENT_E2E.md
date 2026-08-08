# Host Agent cloud E2E contract

This is the acceptance contract for a **future** Host Agent. It is deliberately
not a “run arbitrary commands as root until it works” prompt. The Host Agent must
first probe the host, create a reviewable plan, obtain the approvals listed below,
apply typed adapters, and preserve redacted evidence.

Run the read-only gate first:

```sh
node scripts/e2e/host-agent-preflight.mjs
npm run e2e:aws-plan
npm run e2e:release-gate
```

`AGENTSLACK_ROOT` may point to a local AgentSlack clone. The script never reads
`authinfo.md`, writes cloud state, logs credentials, installs packages, or creates
an EC2 instance. A non-zero exit means the host must not be provisioned.

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

The current Agentworks codebase supports the reference environment only:

| Host | Master web console | Host Worker / tenant runtime | Cloud E2E status |
| --- | --- | --- | --- |
| macOS | Docker Compose | Lima VZ | reference implementation |
| Ubuntu 24.04+ | Docker Compose | Incus VM adapter + systemd service | implementation ready; cloud E2E pending |
| Amazon Linux 2 | Docker Compose may work | Incus/LXD-compatible runtime must be probed/installed first | blocked until host probe passes |
| Windows | Docker Desktop may work | Hyper-V/WSL2 adapter | probe/adapter pending |

Thus a three-OS E2E must not claim success today. Ubuntu has a concrete VM adapter,
but it still requires an actual clean-host cloud run. A Linux Docker-only install
without Incus/LXD and `/dev/kvm` is rejected rather than silently degrading tenant
VMs into containers.

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
7. AgentSlack scope. `toomuch` is an existing private deployment and explicitly
   forbids deployment changes. `agentworktest` is a logical Server within that
   existing deployment: create it with a `toomuch` Server admin identity, then
   give Agentworks its own identities and per-session registries.

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

## Current implementation gaps that must close before this matrix runs

- Ubuntu clean-host cloud E2E for the Incus Worker, systemd installation, VM
  lifecycle, bridge injection, resource updates and port relay.
- Amazon Linux 2 runtime adapter selection after a real host probe. Upstream Incus
  does not list Amazon Linux 2 as a packaged server target, so the Host Agent must
  only choose an initialized compatible runtime that passes the VM/KVM probe.
- Windows Hyper-V/WSL2 adapter with a documented isolation contract and service
  installation path.
- An AgentSlack adapter for Agentworks’ session wake layer. AgentSlack’s Claude
  Channel can provide native delivery only when its channel options and the exact
  native session-resume path are verified.
- An E2E runner that provisions AWS resources with a strict allowlist and cleanup
  tags. It must be implemented only after the preceding adapters pass local tests.

## Acceptance evidence

Each OS emits a redacted run report containing host probe, install version hashes,
Master/Worker health, tenant and session IDs, AgentSlack object IDs, delivery IDs
for both live and recovery wake, port-route ID and independent HTTP assertion,
plus cleanup state. Secrets, raw auth headers, OAuth tokens, private keys and
message bodies are never evidence.
