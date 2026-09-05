# M5b — 승인 응답 계약 판정 (B7b)

기준일: 2026-07-25 · 승인 계획 §5 B7b · 선행 조건: "provider별 prompt identity 조사 승인"
개정: rev.2 — critic 반증을 반영해 §2를 "식별자 부재"에서 "해석기가 식별자를 소비하지 않음"으로 정정하고, 강등 논거를 §3 단독으로 재구성했다.
개정: rev.3 (2026-09-02) — rev.2 이후 codex·omp에 화면 파싱 기반 in-app 승인이 구현되었다(`server/modules/providers/services/tmux-approval.service.ts`, 7691544, 2026-07-31). 계약이 구현을 판정하지 않는 상태를 끝내기 위해 §1을 "조건부 허용"으로 개정하고, 허용 조건으로 §6의 1c(응답 직전 라이브 재확인)와 새 1d(결합 등급)를 규정한다. 2026-09 코드리뷰 S12·S17.
개정: rev.4 (2026-09-05) — Claude live-tmux 질문·명령 승인·계획 승인 경로를 반영하고, 전사/세션 기반 쓰기의 `tagged`/`observed` 양성 근거 검증을 강제한다. 기존 codex·omp 승인 API, pane 기반 interactive API, 전사 기반 질문, L1 SDK capability를 구분한다. native one-shot 승인 채널을 새로 허용하는 개정은 아니다.

## 1. 판정 요약

**tmux relay(L2) provider의 기본값은 여전히 대안 D(verified terminal attach)다.**
다만 아래 화면·라이브 재확인 조건과 해당 작업의 대상 결합 조건을 만족하는
provider·pane에 한해 제한된 in-app 질문·승인 응답을 허용한다.

1. **화면 근거** — 서버가 pane을 직접 capture해 *현재 표시 중인* 승인 메뉴를 파싱할 수
   있어야 한다. 기존 `tmux-approval.service.ts`는 codex·omp 전용이다. 별도의
   `tmux-interactive-prompt.service.ts`는 Claude의 질문·명령 승인·계획 승인도
   처리한다. 파싱에 실패하면 구조화된 응답을 제공하지 않는다. 이것은 B7b가
   상정했던 native one-shot 승인 응답이 아니다.
2. **응답 직전 라이브 재확인(§6 1c)** — 키를 보내기 직전에 pane을 다시 capture해
   스크롤백이 아닌 화면 꼬리에 승인 메뉴가 *아직* 떠 있음을 확인한다
   (`approvalTailIsActive`, interactive 경로는 `promptTailIsActive`). Interactive
   응답은 재캡처한 질문·본문·선택지 등의 화면 기반 prompt ID도 요청과 대조하고
   표시된 선택지만 허용한다. 이 확인과 `send-keys` 사이의 창은 기존 키 전송과
   동일한 수용된 TOCTOU다. 원자성은 tmux가 제공하지 않으며, 계약은
   "재확인 뒤 즉시 전송"을 원자적 재확인의 대체로 인정한다.
3. **대상과 결합 등급(§6 1d)** — 모든 경로는 정확한 pane identity와 프로세스
   혈통/generation을 다시 검증한다. 전사(session row)를 기준으로 한 요청은
   provider session identity를 대조하고 pane과의 결합이
   `tagged`(ChatMux가 spawn 시 pane에 기록) 또는 `observed`(프로세스 자체가 세션을
   지목: argv resume id, per-pid 런타임 영수증, /proc으로 확인한 열린 전사)여야 한다.
   `inferred`(cwd + 시간 창 추론)는 같은 폴더의 다른 TUI를 가리킬 수 있으므로 승인
   응답과 세션 기준 키 전송을 거부하고 attach로 폴백한다
   (`TMUX_SESSION_BINDING_INFERRED`, 플릿 경로는 `FLEET_CAPABILITY_UNAVAILABLE`).
   `null`, 미지정, 알 수 없거나 잘못된 등급도 같은 코드로 거부한다. GJC의 pane별
   영수증·정확한 프로세스 resume ID·프로세스가 연 전사는 `observed` 근거로 전달하되,
   cwd/시간만 맞춘 영수증은 `inferred`로 유지한다. Pane의 `lineage` 증명만으로
   전사 결합을 `observed`로 올리지 않는다. Fleet는 fresh verifier가 반환한 provider,
   native session ID와 결합 등급을 확인하며 discovery 행의 등급만으로 승인하지 않는다.
   Pane 기반 `/api/providers/sessions/external/interactive/respond`는 전사 ID 대신 정확한
   pane·process와 현재 화면의 prompt ID를 대상으로 한다. 이 경로를 전사 결합의
   증명으로 사용하거나 같은 cwd의 다른 세션으로 대체하지 않는다.

해당 조건을 만족하지 못하는 경우(cursor·opencode 등 지원 파서가 없는 provider,
전사 기반 작업의 `inferred` 결합, 사라지거나 변경된 메뉴)는 강등 경로(§4)를 따른다.
화면 기반 prompt ID는 동일한 내용이 다시 나타나는 것을 구분하는 native nonce가
아니며, B7b의 one-shot `interactionGeneration`은 여전히 구현하지 않는다.

§2~3은 2026-07-25 조사 당시의 배경과 native 승인 채널 강등 근거다. 전사 식별자가
있다는 사실만으로 실행 중인 TUI에 out-of-band 승인 응답을 보낼 수는 없다.
현재의 제한된 화면·키 응답은 §1의 별도 조건을 따른다.

이는 계획이 규정한 정상 경로다: §5 B7b는 "provider별 opt-in이며 evidence 미확보
provider는 대안 D로 강등"을 명시하고, §4.4는 evidence 없는 승인 채널을 금지한다.
강등은 범위 축소가 아니라 **계약이 지정한 결론**이며, 강등 경로가 실제로
동작하도록 구현하는 것까지가 M5b의 의무다.

## 2. 배경 — 식별자는 전사에 있으나 해석기가 읽지 않는다

이 절의 표와 줄 번호는 당시의 **활동 감지기** 조사 기록이다. 현재의 전체 질문·승인
지원표가 아니다. 전사 기반 질문의 `tmux-ask-selection.service.ts`는 미응답 tool ID를
확인하고 라이브 화면과 대조하며, pane 기반 interactive 경로는 화면 prompt ID를 쓴다.

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

L1 SDK 레인은 이 문제의 대상이 아니다. `provider-capabilities.service.ts`의
`supportsPermissionRequests`는 gjc·claude에서 true인 일반 runtime capability다.
이 표나 프런트엔드의 permission-mode fallback을 live-tmux 질문·승인 지원표로
해석하지 않는다. SDK capability는 실행 중인 pane에 대한 제어 권한이나 응답 경로를
증명하지 않는다. B7b가 다루는 것은 **L2 tmux relay**다.

## 3. Native 승인 채널 강등 근거 — 당시 조사 범위

조사 당시 L2는 **키 입력만** 가능한 채널이었다. M5a에서 만든 채널도 `interrupt`/`escape`
두 개의 고정 argv뿐이다. 승인을 전달하려면 TUI의 현재 프롬프트 상태를 알고 그에
맞는 키(`y`/`n`, 방향키+Enter, 번호 선택 …)를 보내야 한다.

- 그 매핑은 provider마다 다르고 버전마다 바뀐다.
- 화면 근거 없이 provider 내부 상태를 추측해 범용 승인 매핑을 내장하는 것은
  `docs/ROADMAP.md`의 범위 밖 조항("provider가 제공하는 CLI, 인증, sandbox,
  모델 실행 기능의 재구현")과 계획 §4.4가 금지한다. 현재 화면의 명시적 선택지만
  해석하는 §1의 제한된 경로와 구분한다.
- 매핑 없이 일반 키 allowlist로 처리하는 안은 계획 §4.4가 명시적으로 기각했다:
  "같은 process의 다른 prompt를 조작 가능. stale UI가 같은 process의 다음
  prompt에 응답 가능."

2026-07-25에 조사한 실행 중 tmux CLI 경로에서는 **키 시뮬레이션이 아닌 승인
응답 전달 경로**(파일 드롭, 소켓, CLI 서브커맨드)를 확인하지 못했다. 이는 모든
provider SDK나 이후 버전의 기능 부재를 뜻하지 않는다. 새로운 native 채널 도입은
별도의 계약·대상 식별 검증이 필요하며, 현재 화면 파서만으로 그 채널을 주장하지 않는다.

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
| B7b in-app 승인 | **Native one-shot 승인 응답은 구현하지 않음**. 기존 승인 API는 codex·omp, interactive API는 Claude 질문·명령 승인·계획 승인도 지원. §1의 화면·라이브 재확인·정확한 대상 조건 및 전사 기반 작업의 결합 조건을 충족하지 못하면 강등 |
| B8 승인 action | 구현 — 아래 AC 참조 |
| B10 relay 이미지 | 구현 — asset store 저장 후 **경로 문자열만** 붙여넣기, 프로젝트/HOME 밖 거절, B0 경유 |
| 문서화 | 본 문서 + 사용자 대면 안내(지원 화면은 제한된 질문·승인 UI, 검증 불가 시 해당 pane의 터미널에서 응답) |

### B8 action AC

1. `asking_user` 배지에 **클릭 가능한 진입점**이 있고, 클릭하면 transcript 뷰가
   아니라 **해당 pane의 terminal attach**로 진입한다.
2. attach 대상은 배지가 가리키는 것과 정확히 같은 pane 4-튜플이다.
3. `attachCapability`가 없는 행(SSH/shell인데 토큰 미발급)은 attach를 시도하지
   않고 재조회 안내를 표시한다(기존 `shell.attachCapabilityUnavailable` 경로 재사용).
4. **M5b 종료 게이트**: 이 경로의 e2e 1종 — 승인 대기 상태의 pane에서 배지 진입이
   그 pane의 attach로 이어지고, 잘못된 pane으로 가지 않음을 검증한다.

## 6. 재검토 조건

Native one-shot 승인 채널 강등은 아래 **두 조건이 모두** 성립할 때 재검토한다.
§1의 제한된 화면 응답과는 별개의 조건이다.

| # | 조건 | 현재 상태 |
|---|---|---|
| 1a | 승인 프롬프트에 안정적인 native 식별자가 전사에 존재 | **충족** — claude `toolu_*`, codex `call_id`, omp 동형(§2.3) |
| 1b | ChatMux 해석기가 그 식별자를 읽어 활동 결과에 실어 보냄 | 활동 결과에 native 승인 식별자를 싣는 계약은 미충족. 전사 질문의 tool ID 소비와 화면 기반 prompt ID는 별도 경로다 |
| 1c | 응답 직전 "이 프롬프트가 아직 미응답"임을 재확인할 수단 | **조건부 충족(rev.3~4)** — pane capture의 화면 꼬리 검사와 interactive prompt ID 대조로 확인하고 즉시 전송한다. 남는 창은 수용된 TOCTOU이며 native one-shot 보장은 아니다 |
| 1d | 승인 요청의 전사와 pane의 결합이 프로세스 근거를 가질 것 (`tagged` 또는 `observed`) | **충족(rev.4)** — `isProvenSessionBinding`/`assertProvenSessionBinding`은 두 등급만 허용한다. `inferred`, `null`, 미지정·잘못된 등급은 로컬 전사 쓰기와 fleet 세션 쓰기에서 부작용 전에 거부한다. GJC도 실제 영수증/프로세스 근거를 전달하며, 독립적으로 검증된 pane terminal 경로에는 전사 결합을 요구하지 않는다 |
| 2 | 키 시뮬레이션이 아닌 **응답 전달 경로**(파일·소켓·CLI 서브커맨드) | 해당 live-tmux 승인 계약에 도입되지 않음. 과거 조사 범위는 §3 참조 |

조건 2는 provider 쪽 변화다. rev.3의 화면 파싱 경로는 조건 2를 대체하지 않는다: 그것은
"현재 화면에 보이는 메뉴에, 방금 확인한 그대로, 방향키와 Enter를 보낸다"는 제한된
키 시뮬레이션이며, §3이 기각한 "TUI 내부 상태의 재구현"과는 파서가 화면의 명시적
텍스트만 읽는다는 점에서 구분된다. 파서가 깨지면 승인 UI가 사라질 뿐 잘못된 키가 나가지
않아야 하며, 그 성질은 provider별 파서 테스트로 유지한다.

rev.4의 결합 검증은 `tmux-session-binding.service.test.ts`,
`tmux-fresh-verifier.service.test.ts`, `session-binding-routes.test.ts`,
`session-binding-mutations.test.ts`로 확인한다. 로컬 HTTP와 fleet dispatcher 테스트는
미지정·잘못된 등급의 입력 부작용이 0임을 검증하며, `tagged`/`observed` GJC·Codex의
양성 경로와 pane 기반 제어의 독립적인 stale-generation 거부를 함께 확인한다.
