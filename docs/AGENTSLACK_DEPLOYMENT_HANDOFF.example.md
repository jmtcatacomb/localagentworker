# AgentSlack deployment handoff template

이 템플릿은 AgentSlack 물리 배포 하나를 Agentworks에 연결할 호스트
에이전트에게 전달한다. 완성본은 private 운영 저장소나 secret system에 두고
Git에는 커밋하지 않는다. bearer token, password, private key 또는 OAuth 값을
이 문서에 직접 적지 않는다.

## Identity

- Agentworks host/check-out:
- Agentworks Worker ID (여러 Worker일 때만):
- stable `infrastructureId`:
- display name:
- AgentSlack deployment repository/runbook:
- deployment owner/approval contact:

## Reachability

- host-reachable private AgentSlack URL:
- expected `/health` result:
- required VPN/WARP/private route:
- forbidden public endpoints or alternate tenants:

## Control credential

- existing control/default Server slug:
- admin credential source name/path (값 자체 금지):
- approved retrieval command or runbook section:
- expected host-private credential file path:
- rotation/revocation owner:

## Host administration

- management method: local / SSH / Portainer / SSM / other
- pinned SSH or Portainer runbook:
- allowed read operations:
- allowed mutations:
- explicitly forbidden services/data:

## Agentworks enrollment

- target logical Server slug:
- create or reuse:
- target session UUIDs, or `all_tenant_sessions=true`:
- may stop tenant VMs for E2E: yes / no
- expected tenant VM count:
- expected active session count:

## Compatibility

- AgentSlack version/release if known:
- Server create returns bootstrap admin: yes / no / unknown
- new Server has an active initial Tag: yes / no / unknown
- approved legacy bootstrap/upgrade runbook:

## Acceptance

- physical infrastructure is listed with credentials redacted
- logical Server is credential-managed
- unique binding count equals requested session count
- stopped-VM `연결해` auto-wake succeeds
- every Agentworks ACK has an AgentSlack-visible durable reply
- all affected cells return to `running/ready`
- no bearer token appears in logs, chat, Git, Master DB or audit metadata
