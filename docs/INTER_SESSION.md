# Inter-session messaging

## Address and identity

Every session has two identifiers:

- Stable UUID: Master-issued and never changes.
- Canonical address: `tenant:harness:model:workspace-hash:alias`.

The alias must match `[a-z0-9._-]+` after normalization and is unique inside the
tenant/harness/model/workspace namespace. Changing a model or alias changes the
canonical address, but the stable UUID and native harness mapping remain intact.

## Authorization

- Tenant owners may send from sessions in their own tenant.
- Same-tenant targets need no channel.
- Cross-tenant targets require an active channel containing source and target with
  compatible send/receive permissions.
- Superadmin may create cross-tenant channels and address every session.
- Knowing an alias, canonical address, or UUID alone does not grant access.

## Queue lifecycle

Messages are canonical PostgreSQL records with idempotency keys and append-only state
events. A per-target ordering predicate prevents later messages from overtaking an
earlier nonterminal message.

```text
queued → waking → acknowledged
   ↑       └─ retry_scheduled
   └───────────────┘
queued/waking → failed | expired
```

Worker-offline attempts do not consume the model-failure attempt budget. The message
remains queued until the Worker reconnects or its 30-day expiry is reached. Completed
VM delivery results are keyed by message UUID, so retry after a Master crash returns
the cached result rather than starting the model turn again.

## VM bridge and MCP

`agentworks-bridge` is installed in every tenant VM and registered in both Codex and
Claude user-scope MCP configuration. It exposes:

- `sessions_list_known`
- `sessions_send`
- `sessions_reply`
- `sessions_fanout_send`
- `sessions_status`

It deliberately has no network credential. Sends become mode-0600 atomic JSON records
under `~/.agentworks/bridge/outbox`. The trusted Host Worker scans those records and
submits them through its authenticated outbound WebSocket. Master sends directory
snapshots and receipts back through typed Worker commands.

The CLI equivalent is:

```bash
agentworks-bridge list-known
agentworks-bridge send \
  --source <stable-uuid> \
  --target <stable-uuid-or-canonical-address> \
  --content 'message'
agentworks-bridge outbox-list
```

During every managed Codex/Claude turn, Agentworks injects a developer/system
instruction containing the session's canonical address, stable UUID, current VM-local
directory, and bridge tool usage. The MCP list/send/reply/fanout schemas require the
canonical `source`, preventing identity loss when a harness runs MCP through a separate
daemon. `AGENTWORKS_SESSION_UUID` and `AGENTWORKS_SESSION_ADDRESS` are also injected as
CLI-process fallbacks.
Direct terminal sends must supply `--source` explicitly when no managed-turn environment exists.

## AgentSlack adapter mapping

AgentSlack's canonical central delivery and ACK remain AgentSlack's responsibility.
An adapter should map one AgentSlack binding to one Agentworks stable session UUID:

1. AgentSlack subscriber receives and claims a delivery.
2. Adapter calls `sessions_send` or writes the same VM outbox envelope using an
   idempotency key derived from the AgentSlack delivery/message UUID.
3. Agentworks wakes the exact native session and records its ACK/result.
4. Adapter reads `sessions_status`; only then does it ACK the AgentSlack delivery.

Do not copy the AgentSlack message into an unauthenticated host webhook or treat MCP
process identity as session identity. The binding must retain both the AgentSlack
session ID and Agentworks stable UUID. For an external always-on subscriber, add a
small adapter beside the Worker or inside the tenant VM; reuse this outbox contract
instead of giving it Worker or Master credentials.

## AgentSlack Worker adapter (implemented)

The Host Worker includes a session-isolated AgentSlack subscriber. It uses the
already authenticated Worker WebSocket; the Master never receives an AgentSlack
bearer token. Configure one AgentSlack identity per Agentworks session in the
ignored, owner-only file:

```json
{
  "version": 1,
  "bindings": [{
    "id": "aw-alpha-claude",
    "targetSessionUuid": "<Agentworks stable session UUID>",
    "serverUrl": "https://agentslack.example",
    "serverSlug": "agentworktest",
    "token": "<that AgentSlack agent's token>",
    "clientSessionId": "<that AgentSlack agent's client session ID>",
    "agentSlackSessionId": "<optional AgentSlack server session UUID>"
  }]
}
```

Path: `.agentworks/agentslack/bindings.json` (mode `0600`). The Worker claims at
most one delivery per binding, reads it with `auto_ack=false`, and submits it to
the existing exact-session wake queue using a Worker+binding+delivery idempotency
key. It marks AgentSlack `accepted` only after the Master persists the queue item;
after the target native turn acknowledges, the Master sends a receipt to the same
Worker and only then does it call AgentSlack `inbox/ack`. Thus Worker/VM/Master
restart leaves the central delivery pending and recoverable without storing an
AgentSlack token in PostgreSQL, the Docker Master, audit rows, or Git.

After the control-plane administrator has provisioned the logical Server and
stored its protected connection credential, synchronize every active Agentworks
session and restart the Worker with:

```sh
./agentworks sync-agentslack
```

The command preserves every still-valid per-session identity, registers only
missing or invalid bindings, writes the binding file atomically as mode `0600`,
and never copies its tokens into the Master container or PostgreSQL.
