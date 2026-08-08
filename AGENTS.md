# Agentworks repository guidance

For superadmin operation and recovery, follow `docs/MASTER_AGENT.md`.

Keep committed source/configuration in this repository and all generated runtime
state, VM disks, credentials, secrets, database files, and logs under `.agentworks/`.
Preserve the Master/Worker/Tenant trust boundaries documented in
`docs/ARCHITECTURE.md`.
