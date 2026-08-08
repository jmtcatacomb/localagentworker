# Backlog and compatibility contracts

## P1: Host bootstrap and self-recovery

- Replace the Node-based host Worker with signed, self-contained binaries produced in
  Docker for supported host OS/architecture pairs.
- Split installation into `bootstrap-master`, `probe-host`, `plan`, `apply`, and
  `verify`, with an immutable JSON plan that the Master Agent can inspect.
- Add Incus adapter and systemd unit for Ubuntu.
- Probe Windows Hyper-V/WSL2/runtime candidates instead of assuming one.
- Add signed Worker upgrades, rollback, last-known-good configuration, and heartbeat
  health remediation.

## Delivered MVP / P1 hardening: Port request and gateway

- Tenant route request, superadmin approve/modify/revoke state machine.
- HTTP/WebSocket reverse proxy through hostname routes on `:443`.
- Delivered: admin-defined raw TCP pool, audited open/revoke API, and Worker-owned
  live relay to a VM loopback port.
- Add route expiry, tenant request/approval UI, and UDP only after policy hardening.

## Delivered MVP: Known Session UUID wake/push

The live workspace UI creates Master-issued `agent_sessions`, persists chat turns,
records native resume IDs, and runs the durable mailbox/wake coordinator described
below. The VM bridge exposes the four MCP tools through a credentialless local outbox.

Implemented flow:

```text
source agent MCP
  → Master sessions.send(target_session_uuid, message, idempotency_key)
  → ACL and tenant-sharing policy
  → start target VM if stopped
  → wait for tenant agentd readiness
  → resume the addressed Codex/Claude native session
  → inject message
  → persist delivery/result event
  → optionally wake the source session with a reply
```

Required invariants:

- Session UUID is Master-issued and stable; native harness IDs are private mappings.
- Knowing a UUID alone is insufficient: sender ACL is checked on every message.
- Cross-tenant messaging is denied unless both owners or superadmin create an explicit
  channel/grant.
- `idempotency_key` prevents duplicate wake or delivery after retries.
- A per-session mailbox preserves order and status: queued, waking, delivered,
  acknowledged, failed, expired.
- MCP initially exposes `sessions.list_known`, `sessions.send`, `sessions.status`, and
  `sessions.reply`; it never exposes other tenants' credentials or filesystem.
- Codex and Claude adapters own their resume/injection semantics and capability probe.

Remaining hardening: mTLS Worker identity, channel-management UI beyond two-member
grants, queue retention administration, dead-letter replay, and external adapter SDKs.

## P2: AWS and OS E2E matrix

- Test clean clone with only Docker assumed.
- Ubuntu EC2: Master + Incus Worker + two tenant VMs.
- Windows EC2: Master plus selected Hyper-V/WSL2 Worker adapter.
- macOS: local Lima VZ reference environment.
- Inject temporary test credentials only through runtime secrets, never repository
  files or CI logs; revoke them after E2E.
- Verify fresh install, agent CLI login, session persistence, update, Worker restart,
  VM stop/start, backup/restore, port route, and recovery from a killed component.
