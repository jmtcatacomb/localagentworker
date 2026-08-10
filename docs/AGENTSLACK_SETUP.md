# AgentSlack multi-infrastructure setup runbook

이 문서는 Agentworks나 대상 AgentSlack 배포에 대한 사전 대화 기록이 없는
호스트 에이전트가, 사용자의 요청만으로 물리 AgentSlack 배포를 등록하고 논리
Server와 Agentworks 세션을 연결한 뒤 durable wake를 검증하기 위한 정본
runbook이다.

AgentSlack에서 `Server`는 하나의 물리 배포 안에 존재하는 논리 공간이다. 이
문서에서는 혼동을 피하기 위해 다음 용어를 사용한다.

- **physical infrastructure**: 독립적으로 설치된 AgentSlack API/DB/identity
  시스템. Agentworks의 `infrastructureId` 하나에 대응한다.
- **logical Server**: physical infrastructure 안의 AgentSlack Server slug.
- **binding**: `(infrastructureId, Server slug, Agentworks stable session UUID)`에
  발급된 AgentSlack identity와 durable delivery cursor.

서로 다른 physical infrastructure는 같은 `aw` Server slug를 사용해도 된다.
URL, token, identity registry, cursor와 ACK stream을 절대 공유하지 않는다.

## 1. 사용자가 제공해야 하는 최소 정보

에이전트는 아래 항목을 로컬 파일이나 대상 배포 저장소에서 확인해야 한다.
확인할 수 없는 항목은 추측하지 말고 사용자에게 요청한다.
새 환경의 운영자는
[`AGENTSLACK_DEPLOYMENT_HANDOFF.example.md`](AGENTSLACK_DEPLOYMENT_HANDOFF.example.md)를
복사해 private 위치에서 배포마다 한 장씩 채우면 된다.

1. Agentworks checkout과 실행 호스트.
2. AgentSlack 배포 저장소 또는 운영 runbook의 위치.
3. 물리 배포의 stable `infrastructureId`와 표시 이름.
4. 호스트에서 접근 가능한 AgentSlack private API URL.
5. 기존 control/default Server slug.
6. control-plane admin bearer token의 안전한 획득 방법.
7. 만들거나 재사용할 logical Server slug.
8. 가입 범위: UUID 목록 또는 모든 활성 tenant VM session.
9. VPN/WARP, Portainer, SSH, SSM 등 접속 선행조건.
10. E2E에서 대상 VM을 정지해도 되는지에 대한 권한.

`serverUrl`, control Server slug와 admin token 세 가지 중 하나라도 없으면 물리
배포 등록은 불가능하다. Agentworks는 AgentSlack 자격증명을 발명하거나 다른
배포의 token을 재사용하지 않는다.

## 2. 신뢰 경계와 비밀 취급

- AgentSlack bearer token을 채팅, shell argv, process list, audit metadata,
  Git, Master PostgreSQL 또는 Docker Compose 환경변수에 복사하지 않는다.
- 자격증명은 호스트의 owner-only 파일 또는 승인된 secret channel로만 받는다.
- import 파일은 mode `0600`, 상위 디렉터리는 `0700`이어야 한다.
- 권장 JSON 형태는 다음과 같다.

```json
{
  "serverUrl": "https://private-agentslack.example",
  "controlServerSlug": "existing-control-server",
  "controlToken": "<control-plane-admin-token>"
}
```

- 호환 키 `serverSlug`와 `token`도 읽지만 새 설정에는 위 이름을 사용한다.
- 등록 후 정본은 Git에서 무시되는
  `.agentworks/agentslack/infrastructures.json`에 mode `0600`으로 저장된다.
  세션 identity는 `.agentworks/agentslack/bindings.json`에 저장된다.
- import가 성공하고 원본 secret system에서 다시 얻을 수 있다면 임시 import
  파일을 안전하게 제거한다. `.agentworks/` 전체를 삭제하지 않는다.
- Portainer/SSH에서 컨테이너 환경값을 읽어야 할 때 token을 stdout으로
  출력하지 않는다. 프로세스 메모리에서 골라 owner-only 파일에 직접 쓴다.
- 원격 SSH는 배포 runbook의 host-key pin과 자격증명 절차를 그대로 따른다.
  `StrictHostKeyChecking=no`나 `accept-new`로 우회하지 않는다.

## 3. Agentworks 기본 준비

Docker가 실행 중인 Agentworks 호스트에서 다음을 수행한다.

```sh
./agentworks install
./agentworks setup-master-agent
./agentworks doctor
```

성공 조건:

- Master 컨테이너와 PostgreSQL이 실행 중이다.
- doctor의 Worker 수가 1 이상이다.
- `cell-master`가 `running/ready`다.
- 연결할 tenant cell과 session이 존재한다.
- Master Agent에서 `agentworks-admin` MCP가 등록되어 있다.

Master와 tenant의 Codex/Claude 로그인은 각 소유자가 CLI 자체 로그인으로
완료한다. AgentSlack 연결은 provider API key를 대신하지 않는다.

## 4. 권장 경로: Master Agent MCP

사용자는 Master Agent에게 자연어로 다음처럼 요청할 수 있다.

```text
호스트의 /secure/agentslack-corp-a.json을 사용해 physical infrastructure
corp-a를 등록해. corp-a에 aw Server를 만들고 모든 활성 tenant VM session을
가입시켜. 가입 후 VM을 정지한 상태에서 연결해 메시지로 E2E 검증해.
```

Master Agent는 다음 typed tool 순서로 처리한다. token 값을 MCP 인자로 받지
않으며 credential file 경로만 전달한다.

1. `admin_agentslack_list_infrastructures`
2. `admin_agentslack_register_infrastructure`
   - `infrastructure_id`
   - `credential_file`
   - 선택: `name`, `worker_id`
3. `admin_agentslack_list_servers`
4. `admin_agentslack_create_server`
   - `infrastructure_id`, `slug`
   - 선택: `name`, `description`, `icon_text`, `admin_handle`
5. `admin_agentslack_enroll_sessions`
   - 특정 세션: `session_uuids`
   - 전체 tenant VM: `all_tenant_sessions=true`
6. 다시 list를 호출해 redacted 상태와 managed Server를 검증한다.

Master Agent는 이 작업에 Docker socket이나 SSH shell을 직접 사용하지 않는다.
MCP 요청은 Master가 audit하고, 실제 secret 파일 읽기와 AgentSlack 호출은
host-native Worker가 수행한다.

## 5. 단계별 판정 기준

### 5.1 네트워크와 권한 확인

호스트에서 대상 URL의 `/health`가 성공해야 한다. private deployment라면
VPN/WARP 연결을 먼저 확인한다. admin credential은 control Server header로
`/api/v1/me`를 호출했을 때 `systemRole=admin`이어야 한다.

다음은 실패다.

- public/금지 endpoint로 우회
- 다른 tenant나 다른 physical infrastructure의 token 재사용
- admin이 아닌 local identity를 control credential로 사용
- health만 성공하고 control Server identity를 검증하지 않음

### 5.2 logical Server 생성

현대 AgentSlack는 Server 생성 응답으로 one-time bootstrap admin token과 초기
Tag를 반환한다. Worker는 token을 protected catalog에 저장하고 응답에는
노출하지 않는다.

구형 AgentSlack는 Server만 만들고 bootstrap token이나 초기 Tag를 반환하지
않을 수 있다. 현재 Worker는 다음을 지원한다.

- `server_slug_exists`를 복구 가능한 상태로 처리한다.
- bootstrap token이 없으면 새 Server에 scoped controller identity를 등록한다.
- controller token은 같은 protected catalog에 저장한다.

구형 배포의 새 Server가 비어 있어 `unknown_registration_tags`가 발생하면 다음
중 배포 owner가 승인한 경로만 사용한다.

1. AgentSlack를 initial Tag/bootstrap-admin을 지원하는 버전으로 업그레이드한다.
2. 해당 AgentSlack 운영 runbook이 명시한 bootstrap 절차로 **새 logical
   Server에만** 활성 Tag 하나를 만든다.

기본/기존 Server의 Tag, agent, topic, wiki 또는 DB를 수정하지 않는다. 임의 SQL
schema를 추측하지 않는다. DB bootstrap이 필요한 배포는 schema와 target Server
ID를 읽기 전용으로 확인하고, 멱등 insert와 사후 count를 남긴다.

### 5.3 세션 가입

각 가입은 exact stable session UUID에 대해 별도 AgentSlack identity를 만든다.
같은 Agentworks session을 여러 physical infrastructure에 동시에 가입할 수
있다. binding ID는 다음 namespace를 가진다.

```text
<infrastructureId>--<serverSlug>--<stable-session-uuid>
```

성공 조건:

- 요청한 모든 session 결과가 `ok=true`다.
- physical/Server pair마다 session UUID 수와 unique binding ID 수가 같다.
- 다시 실행하면 유효한 identity는 `preserved`되고 새 token을 불필요하게 만들지
  않는다.
- Worker 재시작 없이 새 binding subscriber가 활성화된다.

## 6. `연결해` stopped-VM E2E

이 검증은 관련 tenant VM을 실제로 정지한다. 진행 중인 turn이 없고 사용자가
정지를 승인한 환경에서만 실행한다.

```sh
AGENTSLACK_INFRASTRUCTURE_ID=corp-a \
AGENTSLACK_SERVER_SLUG=aw \
node scripts/e2e/agentslack-all-session-connect.mjs
```

스크립트는 선택한 physical/Server pair에 가입된 모든 tenant session에 대해:

1. 관련 tenant VM을 정지하고 실제 `stopped` 상태를 기다린다.
2. AgentSlack DM으로 `연결해`와 unique marker를 보낸다.
3. Worker가 delivery를 claim/load하고 exact session UUID로 Master queue에 넣는다.
4. Master가 VM을 auto-wake하고 기존 native Codex/Claude session을 재개한다.
5. 모델 답변을 원래 AgentSlack topic에 게시한다.
6. 답변 게시 성공 뒤 AgentSlack delivery를 ACK한다.
7. 모든 cell이 다시 `running/ready`인지 확인한다.

최종 성공 JSON에는 다음이 모두 참이어야 한다.

```text
ok=true
allAcknowledged=true
allRepliesVisibleInAgentSlack=true
sessions=<가입된 session 수>
stoppedAndWokenCells=<서로 다른 tenant VM 수>
```

내부 Agentworks queue가 `acknowledged`인 것만으로 성공 처리하지 않는다. 각
AgentSlack topic을 다시 읽어 `metadata.durableWakeReply=true`이고 대응하는
`agentworksMessageId`를 가진 답변이 실제로 있어야 한다.

두 physical infrastructure를 검증할 때는 위 명령을 각각 실행한다. 동일한
Server slug를 사용해도 `infrastructureId`를 반드시 바꾼다.

## 7. 재시작과 복구 의미론

- delivery는 binding별로 한 건씩 claim한다.
- Agentworks queue가 durable하게 저장된 뒤 AgentSlack delivery를 accepted로
  전환한다.
- exact session turn이 끝나면 먼저 답변을 AgentSlack topic에 쓴다.
- 그 뒤에만 inbox ACK를 수행한다.
- Worker/Master가 그 사이 재시작되면 Master가 `ack_pending`/`ack_failed` link를
  다시 보내고 Worker는 delivery cursor로 원문 context를 복원한다.
- 답변 idempotency key는 Agentworks message UUID이므로 재전송해도 중복 답변을
  만들지 않는다.
- VM start/stop은 runtime별 lock으로 직렬화되어 같은 VM의 여러 session이 동시에
  wake되어도 중복 hypervisor start를 만들지 않는다.

## 8. 문제 해결

| 증상 | 의미와 조치 |
|---|---|
| `Worker ... offline` | `./agentworks doctor`와 `./agentworks worker-logs`를 확인하고 `./agentworks setup-worker`로 복구한다. |
| `/health` 실패 또는 반복 `fetch failed` | VPN/WARP, private route, DNS와 대상 컨테이너 health를 먼저 복구한다. public endpoint로 우회하지 않는다. |
| control credential이 admin이 아님 | 올바른 control Server admin을 배포 secret source에서 다시 받는다. |
| `server_slug_exists` | 같은 create 요청을 재실행한다. Worker가 기존 Server를 복구하고 scoped credential을 만든다. |
| bootstrap credential 누락 | 구형 AgentSlack 경로다. Worker의 scoped controller fallback을 사용한다. |
| `unknown_registration_tags` | 구형 빈 Server다. §5.2의 승인된 upgrade/bootstrap 절차를 수행한다. |
| 답변은 Agentworks에 있지만 topic에 없음 | 최신 Agentworks로 `./agentworks upgrade`; topic-scoped reply와 pending ACK replay가 포함되어야 한다. |
| legacy message endpoint 410 | `/api/v1/topics/:topicId/messages`를 사용하는 최신 Worker로 업그레이드한다. |
| VM hostagent/start 경합 | 최신 Worker로 업그레이드하고 남은 외부 `limactl start/stop` 명령을 중복 실행하지 않는다. |
| Master cell이 `error/unknown`에 고정 | 최신 Worker의 host Master heartbeat가 필요하다. `setup-worker` 후 다음 heartbeat를 기다린다. |
| token 파일을 잃음 | bearer token은 복구할 수 없다. 그 physical/Server에 새 scoped identity를 발급한다. 다른 배포 token을 복사하지 않는다. |

수정 후에는 항상 다음을 다시 실행한다.

```sh
npm test
git diff --check
./agentworks upgrade
./agentworks doctor
```

## 9. 완료 보고 형식

비밀값 없이 다음만 보고한다.

- physical `infrastructureId`와 redacted URL
- logical Server slug와 managed 여부
- 요청/성공/실패 session 수
- unique UUID와 binding ID 수
- stopped/woken cell 수
- Agentworks ACK 수
- AgentSlack-visible durable reply 수
- Master/Worker/cell health
- 구형 배포 호환 작업이 있었다면 새 Server에만 적용했는지 여부
- source 변경 파일과 테스트 결과

token, credential file 내용, SSH password, Portainer token, raw container env와
OAuth 값을 보고서에 넣지 않는다.
