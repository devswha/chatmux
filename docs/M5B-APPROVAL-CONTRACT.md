# M5b — 승인 응답 계약 판정 (B7b)

기준일: 2026-07-25 · 승인 계획 §5 B7b · 선행 조건: "provider별 prompt identity 조사 승인"
개정: rev.2 — critic 반증을 반영해 §2를 "식별자 부재"에서 "해석기가 식별자를 소비하지 않음"으로 정정하고, 강등 논거를 §3 단독으로 재구성했다.

## 1. 판정 요약

**모든 tmux relay(L2) provider를 대안 D(verified terminal attach)로 강등한다.**
in-app 승인 응답(B7b의 one-shot `interactionGeneration`)은 구현하지 않는다.

강등의 결정적 근거는 **§3(승인 응답을 실행 중인 TUI에 전달할 out-of-band 채널이
없음)** 하나다. §2의 식별자 논의는 이 결론의 전제가 아니라 배경이다 — 식별자가
있더라도 전달할 방법이 없으면 승인 UI를 만들 수 없다.

이는 계획이 규정한 정상 경로다: §5 B7b는 "provider별 opt-in이며 evidence 미확보
provider는 대안 D로 강등"을 명시하고, §4.4는 evidence 없는 승인 채널을 금지한다.
강등은 범위 축소가 아니라 **계약이 지정한 결론**이며, 강등 경로가 실제로
동작하도록 구현하는 것까지가 M5b의 의무다.

## 2. 배경 — 식별자는 전사에 있으나 해석기가 읽지 않는다

### 2.1 승인 감지는 도구 이름 휴리스틱이다

`server/modules/providers/services/external-session-activity.service.ts`:

- `isAskingToolName`(:140-147)이 정규화된 도구 이름을 5개 리터럴
  (`ask`, `askuserquestion`, `requestuserinput`, `question`, `permissionrequest`)과
  비교한다.
- `collectToolNames`(:149-162)는 레코드를 깊이 6까지 걸어다니며 `name`/`tool`/
  `toolName` 키의 문자열을 **전부 수집**한다. 어떤 구조적 위치도 요구하지 않는다.
- `containsAskingTool`(:164-168)은 그 수집물에 위 이름이 하나라도 있으면 참이다.

즉 판정 입력은 **이름 문자열 하나**이고, 프롬프트를 지목하는 식별자는 읽지 않는다.

### 2.2 해석 결과에 식별자가 없다

`ExternalSessionActivity`(:17)는 `'running' | 'waiting_user' | 'asking_user' |
'unknown'` 4값 유니온이다. 해석 결과(`ExternalSessionActivityResolutionResult`)는
`activity`, `reasonCode`, `appSession`, `transcriptEnded`만 담는다. prompt id,
revision, nonce, sequence 중 무엇도 없다.

### 2.3 그러나 원본 전사에는 식별자가 실재한다

로컬 디스크 실측(2026-07-25):

| provider | 식별자 | 실측 |
|---|---|---|
| claude | `tool_use.id` = `toolu_*`, 대응 `tool_result.tool_use_id` | `~/.claude/projects` 613개 전사 중 표본 120개에서 매치 확인 (예: `toolu_01UEuTAetjc84ucr1BBkDb2M`) |
| codex | `function_call.call_id`, 대응 `function_call_output.call_id` | `~/.codex/sessions` 608개 rollout 중 표본 120개에서 45건 매치 (예: `call_pG7Lhu0FlCagrFcOx6kFXYvz`) |
| omp | `tool_use.id` 계열 | claude와 동형 스키마 |

따라서 정확한 서술은 "식별자가 없다"가 아니라 **"식별자는 있으나 ChatMux의
활동 해석기가 소비하지 않는다"**이다. 이 격차는 파서를 확장하면 메울 수 있다.
메울 수 없는 것은 §3이다.

### 2.4 provider별 감지 분기

| provider | 감지 분기 | 식별자 소비 | 판정 |
|---|---|---|---|
| omp | `parseOmpActivity` :182-196 | 미소비 | degrade |
| claude | `parseClaudeActivity` :198-213 | 미소비 | degrade |
| codex | `parseCodexActivity` :216-244 (판정 :228·:235) | 미소비 | degrade |
| cursor | `parseCursorActivity` :246-257 | 미소비 | degrade |
| opencode | :272-276 | `state.status` pending/running만 확인 | degrade |

L1 SDK 레인은 이 문제의 대상이 아니다: gjc와 claude 모두
`supportsPermissionRequests: true`(`provider-capabilities.service.ts`, gjc :86,
claude :41)로 권한 요청이 이미 UI에 도달한다. B7b가 메우려는 것은 **L2 tmux
relay**의 공백뿐이다.

## 3. 강등의 결정적 근거 — 응답 전달 채널이 없다

L2는 **키 입력만** 가능한 채널이다. M5a에서 만든 채널도 `interrupt`/`escape`
두 개의 고정 argv뿐이다. 승인을 전달하려면 TUI의 현재 프롬프트 상태를 알고 그에
맞는 키(`y`/`n`, 방향키+Enter, 번호 선택 …)를 보내야 한다.

- 그 매핑은 provider마다 다르고 버전마다 바뀐다.
- 매핑을 서버에 내장하는 것은 **provider TUI 내부 상태의 재구현**이며,
  `docs/ROADMAP.md:57`의 범위 밖 조항("provider가 제공하는 CLI, 인증, sandbox,
  모델 실행 기능의 재구현")과 계획 §4.4가 함께 금지한다.
- 매핑 없이 일반 키 allowlist로 처리하는 안은 계획 §4.4가 명시적으로 기각했다:
  "같은 process의 다른 prompt를 조작 가능. stale UI가 같은 process의 다음
  prompt에 응답 가능."

조사 결과 어떤 provider도 **키 시뮬레이션이 아닌 응답 전달 경로**(파일 드롭,
소켓, CLI 서브커맨드)를 노출하지 않는다. 따라서 식별자를 읽도록 파서를 고쳐도
안전하게 답할 방법이 없다. 이것이 근거 부족이 아니라 구조적 불가능이다.

## 4. 강등 경로 — 사용자는 무엇을 하는가

승인 대기를 발견한 사용자는 **검증된 terminal attach**로 직접 답한다. 이 경로는
M2에서 이미 구현·강화됐다:

- 서버가 attach argv를 조립하고(`shell-websocket.service.ts`), 클라이언트는
  좌표만 보낸다.
- local agent는 fresh verifier, SSH/shell은 principal+pane+generation에 바인딩된
  opaque capability로 검증한다.
- `company*`와 ChatMux 자기 pane은 attach에서도 거부된다.
- 거부는 `attach_refused_identity`/`attach_refused_protected`로 계측된다.

즉 사용자는 ChatMux 안에서 그 pane의 실제 TUI를 열어, CLI에서와 **똑같은 키로**
승인한다. ChatMux는 프롬프트 의미를 추측하지 않는다.

## 5. M5b 구현 범위

| 항목 | 결정 |
|---|---|
| B7b in-app 승인 | **구현하지 않음** — §3 근거로 전 L2 provider 강등 |
| B8 승인 action | 구현 — 아래 AC 참조 |
| B10 relay 이미지 | 구현 — asset store 저장 후 **경로 문자열만** 붙여넣기, 프로젝트/HOME 밖 거절, B0 경유 |
| 문서화 | 본 문서 + 사용자 대면 안내(승인은 터미널에서 답한다) |

### B8 action AC

1. `asking_user` 배지에 **클릭 가능한 진입점**이 있고, 클릭하면 transcript 뷰가
   아니라 **해당 pane의 terminal attach**로 진입한다.
2. attach 대상은 배지가 가리키는 것과 정확히 같은 pane 4-튜플이다.
3. `attachCapability`가 없는 행(SSH/shell인데 토큰 미발급)은 attach를 시도하지
   않고 재조회 안내를 표시한다(기존 `shell.attachCapabilityUnavailable` 경로 재사용).
4. **M5b 종료 게이트**: 이 경로의 e2e 1종 — 승인 대기 상태의 pane에서 배지 진입이
   그 pane의 attach로 이어지고, 잘못된 pane으로 가지 않음을 검증한다.

## 6. 재검토 조건

강등은 아래 **두 조건이 모두** 성립할 때 해제한다. 조건 1(식별자)은 이미 상당
부분 충족되어 있으므로, 실질적 관문은 조건 2다.

| # | 조건 | 현재 상태 |
|---|---|---|
| 1a | 승인 프롬프트에 안정적인 native 식별자가 전사에 존재 | **충족** — claude `toolu_*`, codex `call_id`, omp 동형(§2.3) |
| 1b | ChatMux 해석기가 그 식별자를 읽어 활동 결과에 실어 보냄 | 미충족 — 파서 확장으로 가능(§2.1~2.2) |
| 1c | 응답 직전 "이 프롬프트가 아직 미응답"임을 **원자적으로** 재확인할 수단 | 미충족 — 전사 재읽기는 TOCTOU를 남긴다 |
| 2 | 키 시뮬레이션이 아닌 **응답 전달 경로**(파일·소켓·CLI 서브커맨드) | 미충족 — 조사한 5개 provider 모두 없음(§3) |

조건 2는 provider 쪽 변화이므로, ChatMux는 그때까지 강등을 유지한다.
