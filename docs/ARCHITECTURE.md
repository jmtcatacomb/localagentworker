# Architecture

## Components

```text
Browser
  └─ Master container (web/API/auth/audit/session + terminal relay)
       ├─ PostgreSQL
       ├─ Master Agent PTY (Codex + Claude CLI)
       └─ authenticated Worker WebSocket
            └─ localagentworker (macOS launchd)
                 └─ Lima VZ
                      ├─ aw-a1 (Tenant Alpha)
                      └─ aw-b1 (Tenant Beta)
```

The Master never receives a Docker, Lima, Incus, or host root socket. It sends typed
commands to a trusted host Worker. The Worker owns the runtime adapter, VM-local file
browsing, Codex app-server bridge, Claude CLI bridge, and PTY streaming over the
already-established outbound connection.

## Workspace and session flow

```text
tenant browser
  → authorized cell API
  → host Worker command
  → selected VM + selected absolute cwd
  → Codex app-server thread OR Claude resumable CLI session
  → Master chat_messages + native session mapping
```

CLI credentials never pass through Master. Each command runs as the VM owner and reads
that user's home-level Codex/Claude credential store. Master-issued session UUIDs are
stable public handles; harness-native IDs stay as private adapter mappings.

The harness/provider is immutable after session creation. Model and reasoning/effort
are mutable session settings. An update made while a turn is already running does not
alter that in-flight command; the Worker receives the new settings with the next turn.

## Turn events and usage telemetry

The Codex adapter consumes App Server notifications for completed items, token usage,
turn diffs, and account rate limits. The Claude adapter normalizes stream-json tool
blocks, subagent parent IDs, result usage/model usage/cost, compaction, and rate-limit
events. Both emit a common activity record (`command`, `file_change`, `subagent`,
`tool`, `web`, `plan`, `reasoning`, or `compact`) stored with the assistant message.

Rendered Markdown is generated and sanitized by Master; the browser never renders raw
assistant HTML. Account snapshots and session context are scoped by tenant cell.
Model totals are local observed totals from turns executed through this installation,
not estimates of activity performed in another app. Claude's headless stream may omit
the subscriber seven-day utilization percentage; that absence is represented explicitly.

## Inter-session delivery

```text
Web console/API OR VM MCP outbox
  → Master ACL + channel grant + durable PostgreSQL queue
  → per-target ordered lease/retry coordinator
  → authenticated Worker WebSocket
  → start/recover target VM when possible
  → exact stable session → native Codex/Claude resume ID
  → result/ACK + optional reply message
```

Each VM has `agentworks-bridge`, registered as a user-scope stdio MCP in Codex and
Claude. It has no Worker token, database credential, or Master network credential.
It writes atomic outbox records to the VM disk; Worker drains them over its existing
authenticated channel. Directory snapshots and receipts flow in the reverse direction.
The VM also stores completed delivery results by canonical message UUID so a Master or
Worker crash cannot repeat an already-finished model turn.

Aliases are unique within `(tenant, harness, model, workspace, alias)`. Canonical
addresses include those namespace components, while the Master UUID remains the stable
identity. Same-tenant sends are allowed for owners. Cross-tenant sends require a shared
active channel with send/receive permission, except that superadmin can address all
sessions. See [INTER_SESSION.md](INTER_SESSION.md).

## Trust model

- Host owner and superadmin are trusted over every tenant.
- Master Agent is a superadmin environment but performs host work through Worker
  commands rather than a mounted host socket.
- Worker is trusted infrastructure and is authenticated with a generated secret.
- Tenant users can address only cells associated with their membership.
- Tenant agents are unrestricted inside their VM but have no host or peer-VM control.
- Runtime credentials, DB files, VM disks, and logs are kept under `.agentworks/`.

## Resource policy

The demo cells are configured at 2 vCPU and 4 GiB RAM. Their policy ceiling is
recorded as 4 vCPU and 16 GiB. Lima applies current resources when creating a VM.
The Master Agent can change the current allocation within that per-cell ceiling;
the Worker stops, edits, and restarts a running Lima VM. Cells may flexibly share
host capacity because there is no aggregate reservation in the MVP. A future
scheduler will enforce host reserve, CPU overcommit, and active-memory admission.

## Protocol boundary

Worker messages currently include:

- `register`, `heartbeat`, `cell.progress`
- `command` and `command.result`
- typed command actions `workspace.describe`, `usage.describe`, `fs.list`, `session.turn`,
  `session.wake`, `bridge.sync`, `bridge.receipt`, `resource.apply`, `port.apply`,
  and `port.revoke`
- `bridge.outbox` and `bridge.outbox.ack`
- audited `vm.exec`, `vm.diagnostics`, and `bridge.repair` host-Worker actions for
  Master Agent tenant-VM control
- `terminal.open`, `terminal.input`, `terminal.resize`, `terminal.close`
- `terminal.output`, `terminal.exit`

The MVP uses one authenticated WebSocket. Production will add mTLS, per-command
authorization envelopes, replay protection, and multiplexed flow control.

## Port routing boundary

Tenant application ports are not automatically forwarded by Lima. The VMs use Lima
plain mode and `vzNAT`. The Master stores audited `port_routes`, allocates from an
admin-controlled host pool, and asks the Worker to own a live-revocable TCP listener.
Each connection is bridged through `limactl shell` to the VM loopback port, so route
changes do not restart the VM. Loopback is the default; `0.0.0.0` requires an explicit
superadmin choice. HTTP hostname routing on shared `:443`, expiry, and UDP remain
future work.
