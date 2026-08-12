# Agentworks

Agentworks is a self-hosted control plane for isolated coding-agent environments.
The skeletal MVP runs a Dockerized Master on macOS, a host-native Worker, and two
Lima Linux VMs. Every VM contains Docker, Codex CLI, and Claude Code CLI.

## Quick start (macOS MVP)

Docker must already be running. The installer starts the Master first, then installs
Lima through Homebrew when available and registers the host Worker.

```bash
./agentworks install
./agentworks open
```

The superadmin email is `yuryueng@gmail.com`. Generated local passwords are stored
only under `.agentworks/`:

```bash
./agentworks credentials
```

Two demo accounts and VMs are provisioned automatically:

- `alpha@agentworks.local` → `aw-a1`
- `beta@agentworks.local` → `aw-b1`

VM provisioning downloads Ubuntu and installs the tools, so the first run can take
several minutes. Follow progress with:

```bash
./agentworks worker-logs
./agentworks doctor
```

## Logging into coding agents

After logging into the Master web console:

1. Open **CLI 로그인 터미널** in the Master Agent card and run `codex`, then follow the ChatGPT sign-in.
2. In the same console run `claude`, then follow the browser sign-in.
3. Open either tenant terminal and repeat those commands using that tenant owner's
   accounts.

After either CLI reports that it is signed in, open **Master Agent** or a tenant
**Workspace**. Master Agent uses the same session UI and behavior as tenant agents,
with an additional audited `agentworks-admin` MCP capability for cells, resources,
ports, session settings, and inter-session messages.
The workspace screen provides a VM-local folder browser, provider/model/effort picker,
stable session creation, resumable chat, and model/reasoning changes for existing
sessions. A session's provider stays fixed, while model and effort changes apply from
the next turn. Assistant output is rendered as sanitized GitHub-flavored Markdown,
including links, tables, and fenced code. Each turn also keeps a collapsible activity
timeline for commands, tool calls, file diffs, reasoning summaries, and subagents.

Every session also has a user-defined alias. Its canonical address is namespaced as
`tenant:harness:model:workspace-hash:alias`; the stable Master UUID remains valid even
when the alias or model changes. The **Messaging** console lists known addresses,
creates audited cross-tenant channels, and submits durable auto-wake messages.

The usage strip reads actual harness telemetry: current context consumption, Codex
account windows/reset times and daily token history, and per-model tokens observed by
this Agentworks installation. Claude stream-json reports context, per-model tokens,
cost, and rate-limit events. Claude's headless stream currently does not include the
subscriber seven-day percentage in every session, so Agentworks labels that field as
unavailable instead of estimating it.

Login state belongs to the VM user's home,
not the directory where login was performed, so every folder selected in the browser
uses the same tenant-owned CLI account.

Authentication is performed by the CLI itself. Master credentials persist in
`.agentworks/master-agent-home`; each tenant's credentials persist inside its own
Lima VM disk under `.agentworks/lima`.

For a controlled Claude-only bootstrap, a Host Agent may inject a Claude OAuth
credential through its secret channel and import it without placing it in Git or
console logs. The protected host-state file is copied only to the Master/tenant
homes while their CLI setup runs:

```bash
AGENTWORKS_CLAUDE_OAUTH_TOKEN='<runtime secret>' ./agentworks import-claude-oauth
```

Re-run **CLI 확인/설치** for an existing tenant after importing. The token is not
passed in EC2 user-data, launchd/systemd unit files, or the Master container.

Codex's current macOS/Linux installer and interactive ChatGPT sign-in are documented
in the [official OpenAI documentation](https://learn.chatgpt.com/docs/codex/cli).
Claude Code's native installer and browser authentication are documented in the
[official Claude Code documentation](https://code.claude.com/docs/en/installation).

## Operational commands

```text
./agentworks install       Build and start Master, then configure the Mac Worker
./agentworks setup-worker  Install/restart the host Worker only
./agentworks upgrade       Rebuild Master and refresh Worker without deleting state
./agentworks repair        Deterministic upgrade plus diagnostics
./agentworks doctor        Inspect Docker, Master, Worker, Lima and tenant cells
./agentworks smoke         Verify auth, isolation, Worker and all installed CLIs
./agentworks status        Show Master containers and Worker service
./agentworks logs          Follow Master/Postgres logs
./agentworks worker-logs   Follow host Worker and VM provisioning logs
./agentworks stop          Stop Master/Worker; tenant VM disks remain
```

No command above deletes `.agentworks/` or tenant VMs. Destructive purge is
intentionally absent from this MVP.

Host-specific Docker network attachments may be kept outside Git in
`.agentworks/config/compose.override.yaml`. The launcher automatically layers
that file over `compose.yaml`, so private-network bindings survive rebuilds and
upgrades without making one host's network names part of the portable source.

## Current scope

- Master login, superadmin and two tenant owners
- Dockerized Master and PostgreSQL
- Persistent Master Codex/Claude terminal
- Host Worker with outbound authenticated WebSocket
- Two isolated Lima VZ VMs, each with 2 vCPU and 4 GiB RAM
- Browser terminals relayed through Master → Worker → VM
- VM-local folder browser and per-folder agent sessions
- Codex app-server thread/model integration and Claude CLI resumable sessions
- Persistent Master-issued session UUIDs and chat history
- Actual context/account/model usage telemetry and per-turn token details
- Sanitized Markdown, links, collapsible command output, file diffs, and subagent activity
- Namespaced aliases, cross-tenant channel grants, durable message queue, and auto-wake
- Credentialless VM-local `agentworks-bridge` MCP/outbox with offline recovery delivery
- First-class `system` Master Agent sessions with the same agent rules and an audited admin MCP
- Live-revocable host TCP routes and per-VM resource changes within configured ceilings
- Docker, Codex CLI and Claude Code CLI inside each VM

Ubuntu hosts use the Incus/LXD compatibility adapter and a systemd Worker service
when the host has an initialized compatible runtime plus `/dev/kvm`; Amazon Linux 2
uses the direct QEMU/KVM adapter because its standard repositories do not provide a
supported Incus/LXD runtime. Both paths keep one persistent Ubuntu VM disk per
tenant; neither substitutes a container for tenant isolation.
and Windows are probe-gated until their runtime adapter is validated on the target
hardware. Tenant port approval UI, shared-hostname HTTP routing, and external
messenger adapters remain backlog items.

See [architecture](docs/ARCHITECTURE.md), [inter-session messaging](docs/INTER_SESSION.md),
[AgentSlack multi-infrastructure setup](docs/AGENTSLACK_SETUP.md),
[Master Agent instruction](docs/MASTER_AGENT.md), and [backlog](docs/BACKLOG.md).
