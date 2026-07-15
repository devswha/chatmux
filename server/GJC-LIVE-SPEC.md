# gjc live provider — 구현 청사진 (Gajae App, 2026-07-09, 체크포인트1 통과 후)

read-only에 이어 **live**(새 채팅 → gjc headless spawn + 스트리밍 + abort). 원형 = **opencode-cli.js**(CLI spawn 계열).

## gjc headless 실측 (확정)
- 명령: `gjc -p --mode json --session-dir <dir> [-r <sessionId>] [--model <m>] <prompt>` (cwd = projectPath).
  - `-p/--print` 비대화형, `--mode json` = **NDJSON 스트림**(stdout 한 줄 = 한 이벤트).
  - `-r/--resume <sessionId>` 재개.
  - **`--session-dir <dir>` 로 세션 저장 격리** — `GJC_CODING_AGENT_DIR`는 쓰지 말 것(그건 auth/config까지 격리→기본 gemini-1.5-flash 404). auth/config는 실 `~/.gjc/agent`에서 읽고, **세션 쓰기만 `--session-dir`로 스크래치**에 둔다(실 홈 세션 무변경 규칙 충족).
  - `GJC_NOTIFICATIONS=0` 필수(ephemeral harness).
  - 모델 미지정이면 실 `~/.gjc` default(현재 anthropic/claude-fable-5)로 동작 — 실측 rc=0 "PONG".
- **NDJSON 이벤트 타입**(실측):
  - `{"type":"session","version":3,"id":"<uuid>","timestamp":..,"cwd":..}` — 세션 헤더(id = 세션 id, abort Map 키).
  - `{"type":"agent_start"}`, `{"type":"turn_start"}`
  - `{"type":"message_start","message":{role, content, ...}}` / `{"type":"message_end","message":{...}}`
    - `message.role` ∈ user/assistant/custom; `content` = 배열(text/thinking/toolCall/toolResult) — assistant는 스트리밍 중 `content:[{type:text,text:"P",index:0}]`처럼 증분, message_end/turn_end에서 완결.
    - custom(volatile-project-context 등 `display:false`)은 UI 표시 제외.
  - `{"type":"turn_end","message":{...},"toolResults":[]}` — assistant 최종.
  - `{"type":"agent_end","messages":[...]}` — 종료.
  - 에러: message의 `stopReason:"error"` + `errorStatus`/`errorMessage`.

## 파일

### `server/gjc-cli.js` (신규 — opencode-cli.js 원형 복제 → gjc)
- `const activeGjcProcesses = new Map();` (sessionId → child process).
- `export async function spawnGjc(message, options, writer)`:
  - options: `{ projectPath, cwd, sessionId, model, sessionDir, effort, permissionMode }`.
  - args = `['-p','--mode','json','--session-dir', sessionDir ?? <default scratch under os.tmpdir()/gjc-live-sessions>]`; `if (options.sessionId) args.push('-r', options.sessionId)`; `if (options.model) args.push('--model', options.model)`.
  - **prompt는 stdin으로** (argv injection 회피; `-`로 시작하는 프롬프트 안전). 또는 마지막 위치 인자. injection-safe.
  - `spawn('gjc', args, { cwd: options.cwd ?? options.projectPath, env: { ...process.env, GJC_NOTIFICATIONS: '0' } })` (cross-spawn).
  - stdout을 readline/split('\n')로 NDJSON 파싱:
    - `session` → sessionId 추출, `activeGjcProcesses.set(sessionId, child)`, writer로 session-created 이벤트(opencode가 session id를 UI에 알리는 방식 미러).
    - `message_start`/`message_end`/`turn_end` → `message.role` + `content[]` 파트 → `createNormalizedMessage(...)` → writer emit(opencode의 스트리밍 emit 형식 미러; assistant 증분 텍스트 스트림 표시).
    - `custom` `display:false` → 스킵.
    - error stopReason → writer로 에러 이벤트.
    - `agent_end` → 완료 이벤트 + Map 정리.
  - stderr → 로깅. close/exit → Map 삭제 + writer 종료 신호.
  - v0.11 SDK v3 discovery가 존재하면 loopback WebSocket sidechannel을 붙여 controlled ask, token usage, `turn.abort`를 사용한다. discovery/handshake 실패 시 기존 NDJSON 경로만 유지한다.
- `export async function abortGjcSession(sessionId)`: SDK sidechannel이 연결됐으면 `turn.abort`, 아니면 기존 detached process-group `SIGTERM`/`SIGKILL` fallback.
- `isGjcSessionActive`/`getActiveGjcSessions` (opencode 미러).

### `server/routes/agent.js` (배선)
- provider 검증 배열 2곳에 `'gjc'` 추가(`['claude','cursor','codex','opencode','gjc']`).
- provider 분기(≈L989 opencode 뒤)에 `else if (provider === 'gjc') { await spawnGjc(message.trim(), { projectPath, cwd, sessionId, model: model || undefined, effort, permissionMode:'bypassPermissions', sessionDir: process.env.GJC_LIVE_SESSION_DIR || undefined }, writer); }`.
  - `GJC_LIVE_SESSION_DIR` env로 검증 시 스크래치 세션 디렉토리 주입(실 홈 세션 무변경). 미설정이면 gjc-cli.js 기본 스크래치.

### `server/index.js` (배선)
- import `{ spawnGjc, abortGjcSession, isGjcSessionActive, getActiveGjcSessions }`.
- `abortFns` Record에 `gjc: abortGjcSession` 추가.

### capabilities
- `server/modules/providers/services/provider-capabilities.service.ts` gjc: abort, SDK ask permission request, token usage 지원. 이미지는 계속 미지원.

## 검증
- 별도 포트 dev(SERVER_PORT=3099) + `GJC_LIVE_SESSION_DIR=/tmp/gjc-live-scratch`(실 홈 세션 무변경) + client(별도 포트).
- 새 대화(provider gjc) → gjc 응답이 채팅 UI에 스트림 표시 → **스크린샷/gif**.
- abort 버튼 → 진행 중 세션 중단 확인.
- 기존 4 provider + read-only 테스트 무회귀.
- 프로덕션 인스턴스 무접촉. 업스트림 PR 금지.
