# P2 Discovery Stream RFC (M4a) — rev.2

상태: **승인 대기(approval gate)** — 본 문서는 구현이 아니라 승인 게이트다. 승인 전 B12~B15 제품 소스 착수 금지(승인 계획 §5 B14 «승인 게이트», §9.2 BLOCK).

대상 백로그: B12(단일 수집기/권위 스냅샷), B13(epoch + reconnect snapshot→delta), B14(unavailable vs 종료 구분 + 응답 계약 신설), B15(폴링 제거 + 상수 비용 측정).

근거 계획: `.gjc/…/plans/ralplan/…/pending-approval.md` §2′ 원칙 6, §3.6 불변식, §5 B12~B15, §6 P2 진입 조건, §10 Q7·Q11.

기준 레포: `~/workspace/chatmux`. 본 문서의 모든 현행 사실 주장은 파일:라인으로 인용하며 grep 재현 가능해야 한다.

---

## 개정 이력 (Revision History)

| rev | 사유 | 반영 내용 | 추적 |
|---|---|---|---|
| rev.1 | 최초 작성 | §1~§10 + 부록 A/B | — |
| **rev.2** | critic **ITERATE** 판정, required_changes 6건 | 아래 6행 | 부록 B |
| rev.2 / RC1 | 4번째 폴링(live roster 5s) 누락 | §2.1에 **C0** 행 신설(절 제목 «폴링 4종(타이머 5개)»), §2.4 유일 호출부 명시, §2.6 `R_live` 재계산, §6.2 grace 근거 재산정(2초→5초, lane별 분리), §7.1 제거 대상 추가, §7.3 assert A/B/G 재작성 + U16, §8 B15-3 확장, §8.1 잔상 상한표, 부록 A #3·#7, 부록 B |
| rev.2 / RC2 | `pane.*` 범위 미확정 | **D2 = 포함으로 확정**. §5.7 신설(메시지 스키마·kind 등록·`C_CAPTURE_MS`/`PANE_REMINT_MS` 정의·process generation 재검증 규칙 P1~P6·무효화). 테스트 U12~U15 / I8~I10 / E10~E12. §1.3 재작성 |
| rev.2 / RC3 | §8 B14의 이중 유예 자기모순 | §6.4 규칙3(REST grace)을 **B15-3까지 보류** + §8.1에 단계별 실효 잔상 상한 `T_residue` 수치 고정 + E9·I11로 잠금 |
| rev.2 / RC4 | §6.4 규칙3이 MAY | **MUST로 확정**, `ok=false` 응답 행의 `presence` 표기 MUST, 스냅샷 출처 = 수집기 권위 스냅샷 → **B12 선행 의존** 명시, I2′ 추가 |
| rev.2 / RC5 | `K_MAX` 단일 상한 | §7.3을 **키별 상한표 9종** + 총합 `K_TOTAL_PER_S`로 확장 |
| rev.2 / RC6 | U6 오표기 + 인용 드리프트 | U6를 **기존 경계 테스트(`tmux-fresh-verifier.service.test.ts:84`,`:91-95`,`:107-113`,`:116`)의 allowlist 확장**으로 재정의. 부록 B 인용 정정 8건. `assertFreshExternalTmuxTarget`의 «신규» 표기 삭제(HEAD 존재: `tmux-fresh-verifier.service.ts:55-79`) |

**rev.2에서 critic 제시 라인을 실측 재확인한 결과 다른 값이 나온 2건**(본문은 실측값을 사용한다):

1. `retainTransientlyMissingLiveRows` 호출부 — critic 표기 `useProjectsState.ts:178`, 실측 **`:179`**. 재현: `search 'retainTransientlyMissingLiveRows' paths=src` → 정의 `src/utils/liveSessions.ts:92`, 호출 `src/hooks/useProjectsState.ts:179`, 테스트 `src/utils/liveSessions.test.ts:66`·`:71`·`:77`·`:85`·`:90`. **제품 코드 호출부는 `:179` 단 1곳**(critic의 «유일한 호출부» 주장은 확인됨).
2. activity 사유코드 — critic 표기 `external-session-activity.service.ts:19-27`, 실측 **union 선언 `:17`, 코드 9종 `:18-26`**. 재현: `search 'unsupported_session_kind|opencode_database_unavailable|ExternalSessionActivityUnavailableReasonCode ='` → `:17` 선언, `:18` 첫 코드, `:26` 마지막 코드.

---

## 1. 목적과 범위

### 1.1 P2가 해결하는 것

1. **스케일**: discovery 비용이 열린 브라우저 수 N에 비례하는 구조를 상수로 바꾼다(§2.6 비용 수식, §7).
2. **재접속 일관성**: 소켓이 끊겼다 붙어도 클라이언트가 "놓친 변화"를 알 수 있게 한다 — full snapshot 후 strictly ordered delta, gap 감지 시 resync(§5).
3. **가용성 구분**: "스캔 실패(unavailable)"와 "정말 아무것도 없음(empty)", "pane이 종료됨(removed)"을 클라이언트가 구분 가능하게 한다. 현재는 서버가 이미 계산한 `ok`를 라우트가 버려서 클라이언트에 **도달조차 하지 않는다**(`server/modules/providers/provider.routes.ts:652`).
4. **표시 지연**: 최대 5초(roster) / 2초(promotion) 지연을 이벤트 기반으로 단축.

### 1.2 P2가 해결하지 않는 것 (명시적 non-goal)

1. **제어 권한(authorization)**. P2 스트림은 authorization 근거가 아니다. injective/destructive action의 권한 판정은 요청 시점 uncached host inspection(`assertFreshExternalTmuxTarget`, `tmux-fresh-verifier.service.ts:55-79`)만 담당한다. §3 참조.
2. **1초 캐시 제거**. 그것은 M1(B0)의 일이며 이미 별도로 진행된다(`external-cli-sessions.service.ts:1138-1143`의 기본 TTL `1_000`ms).
3. **transcript 인덱싱 / 세션 CRUD 실시간화**. 기존 `session_upserted`(`sessions-watcher.service.ts:149-183`)의 관심사이며 P2는 이를 대체하지 않고 **네임스페이스를 분리**한다(§5.3).
4. **pane 내용의 의미 해석**(승인 대기 판정 등). `resolveExternalSessionActivity`는 그대로 두고 스트림은 그 결과를 실어 나르기만 한다.
5. **provider별 기능 패리티**(interrupt/승인). M5a/M5b 소관.
6. **인증 모델 변경**. 스트림은 기존 `/ws` 게이트웨이의 `verifyClient` 뒤에 붙는다(`websocket-server.service.ts:28-30`).
7. **pane 출력의 의미 파싱·증분 diff 알고리즘**. §5.7의 `pane.*`는 캡처 결과의 **해시 기반 변경 감지**만 하며 텍스트 diff를 계산하지 않는다.

### 1.3 성공 판정 (rev.2 재작성 — RC2 반영)

> **(a)** 브라우저 1개일 때와 10개, 50개일 때 단위시간당 `tmux`/`ps`/`lsof` 프로세스 기동 횟수가 **키별 상한표(§7.3)** 안에서 통계적으로 같다. 여기서 «키별»은 `tmux list-panes`, `tmux capture-pane`, `tmux display-message`, `ps -eo`, `ps -p`, `lsof`, `read transcript`, `read runtime-receipt`, `read /proc` 9종 전부를 뜻한다.
>
> **(b)** 위 (a)는 **`pane.*` 구독(§5.7)이 pane output 폴링을 대체한 뒤**에 성립한다. `pane.*`가 없으면 `capture-pane` 항이 N에 선형이므로 (a)는 원리적으로 불가능하다(§2.6 결론 1).
>
> **(c)** 어떤 P2 이벤트(`discovery.*` / `pane.*`)도 tmux에 바이트를 쓰는 결정의 근거로 쓰이지 않는다. `pane.*` 구독조차 캡처 직전 `assertTmuxPaneIdentity`와 `PANE_REMINT_MS` 주기 fresh 재mint에 종속된다(§5.7 P1~P6).
>
> **(d)** 제거 대상 클라이언트 타이머 **5개**(§7.1)가 소스에서 0건이 되고, 그 사실이 소스 수준 테스트(U16)로 잠긴다.

---

## 2. 현행 상태 (실측)

### 2.1 클라이언트 폴링 **4종(타이머 5개)** — rev.2 정정(RC1)

rev.1은 이 절을 «폴링 3종»이라 적었고 표에서 **live roster 폴(C0)을 누락**했다. C0은 `retainTransientlyMissingLiveRows`의 **유일한 제품 호출부**이므로 §6.2·§6.3·§7·§8 전체의 근거값이 여기에 걸려 있다.

| # | 위치 | 주기 | 호출 | 서버측 비용 |
|---|---|---|---|---|
| **C0 live roster** | `src/hooks/useProjectsState.ts:147`(effect), `:156`(`await api.liveSessions()`), `:179`(`retainTransientlyMissingLiveRows(...)`), `:230`(`setInterval(poll, 5000)`) | **5s** | `GET /sessions/live` | live lane 스캔 — **TTL 캐시 없음**(`live-sessions.service.ts:885-889`, `:891-900`). in-flight 공유만 존재 |
| C1 roster(external) | `src/components/sidebar/hooks/useExternalCliSessions.ts:25`(`POLL_INTERVAL_MS = 5000`), `:66`(`setInterval(poll, POLL_INTERVAL_MS)`) | 5s | `GET /sessions/external` | discovery(TTL 1s 캐시) + 세션마다 activity 해석 |
| C2 promotion(external) | `src/components/app/AppContent.tsx:186-187`(`void poll(); window.setInterval(() => void poll(), 2000)`) | 2s | `GET /sessions/external` | 동일 |
| C2′ promotion(live) | `src/components/app/AppContent.tsx:253-254` | 2s | `GET /sessions/live` | live lane 스캔(TTL 캐시 없음) |
| C3 pane output | `src/components/main-content/view/MainContent.tsx:263-264`(`window.setInterval(() => void loadOutput(), 1_000)`) | 1s | `POST …/sessions/{external,live}/output` | **캐시 없음** — 매 요청이 ① fresh authorization 스캔(`provider.routes.ts:702` / `:808`) ② `assertTmuxPaneIdentity`(display-message) ③ `capture-pane`(`:703` / `:809`) |
| (C4) running sessions | `src/components/app/AppContent.tsx:357-360` | 5s | DB 조회(`provider.routes.ts:623-624`) | tmux/ps 미사용 — **제거 대상 아님** |

**폴 종류 4종의 정의(문서 전체 일관 표기)**: ① external roster(C1) ② promotion(C2 + C2′) ③ pane output(C3) ④ **live roster(C0)**. 타이머 개수로는 5개이며, 제거 대상은 이 5개 전부(C4 제외).

주 1: 승인 계획이 인용한 `AppContent.tsx:162,229` / `MainContent.tsx:276`은 현재 HEAD에서 각각 **`:186-187`, `:253-254`, `:263-264`**로 드리프트했다. 본 RFC는 실측값을 사용한다.

주 2: C0과 C2′는 **같은 lane을 서로 다른 주기로 두 번 폴한다**. `live-sessions.service.ts:881-883` 주석이 «several browser clients poll every 5s, and overlapping tmux/lsof/ps storms were themselves causing the transient misses this lane exists to avoid»라고 기록한 바로 그 구조다. 즉 live lane의 transient miss는 **폴 자체가 만든 문제**이고, `retainTransientlyMissingLiveRows`는 그 증상 완화 장치다. P2가 폴을 없애면 원인이 사라진다.

### 2.2 서버 tick

- external turn monitor: `server/modules/notifications/services/external-turn-monitor.service.ts:15`(`DEFAULT_INTERVAL_MS = 5000`) — 브라우저 수와 무관한 상수 부하이나 **discovery 캐시를 공유**하므로 측정에 반드시 포함해야 한다(`:5-11`에서 `getExternalCliSessionsDetailed`/`resolveExternalSessionActivity` import).
- 진단 레이트리밋: `:34`(`PRODUCTION_DIAGNOSTIC_INTERVAL_MS = 60_000`), 코드 집합 `:20-32`(11종), 페이로드 타입 `:44-49`(`tmuxName?` 포함 — B17a에서 신규 진단은 이를 제외).

### 2.3 discovery / live lane

- external: `createExternalCliSessionDiscovery`(`external-cli-sessions.service.ts:1133-1176`) — TTL 기본 `1_000`ms(`:1138-1143`), single-flight(`:1148-1149`, `:1160-1163`), 실패 시 `{ok:false,sessions:[]}`(`:1091`, `:1154`), 성공 시 `{ok:true,…}`(`:1112`). 기본 인스턴스 `:1177`, 공개 래퍼 `:1180-1192`.
- 스캔 1회의 프로세스 기동: `tmux list-panes -a -F …`(`:1085-1088`) + `ps -eo pid,ppid,comm,args`(`:1089`) = **2회**, 추가로 세션별 `ps -p <pid> -o lstart=`(`:574-576`)가 최대 S회. 실행 헬퍼는 `runCommand`(`:534`).
- 세션 타입: `ExternalCliSession`(`:36-44`) — `agentPid?`/`startedAtMs?`가 **optional**(`:42-43`). 반환 타입: `ExternalCliSessionsDetailedResult = { ok: boolean; sessions: ExternalCliSession[] }`(`:45-48`).
- fresh 우회(authorization 전용): `getExternalCliSessionsFresh`(`:1171-1173`, `:1190-1192`) — **캐시를 타지 않는다**.
- live(GJC): `LiveGjcScanResult = { sessions, transcriptPaths }`(`live-sessions.service.ts:885-889`, `transcriptPaths`는 `:887` 주석에 **"server-internal; NOT for API responses"** 명시), `scanShared()`는 **in-flight 공유만 하고 TTL 캐시가 없다**(`:891-900`).
- live 스캔 1회의 기동: `tmux list-panes -a -F …`(`:945`) + `lsof`(`:939`, 호출 `:964`) + `ps -eo pid,ppid,args`(`:1004`) + pane별 `/proc` 읽기(`:483`, `:606`, `:914`, `:631-633`) + runtime receipt 읽기(`:581`, `:615`; 상한 상수 `:559-560` `RUNTIME_RECEIPT_DIR_LIMIT=512`, `RUNTIME_RECEIPT_READ_CONCURRENCY=32`). tmux 부재 판정은 `tmuxHasPanes`(`:227-229`, 사용 `:949`).

### 2.4 `ok`가 버려지는 지점

```
server/modules/providers/provider.routes.ts:652
  const { sessions } = await getExternalCliSessionsDetailed();
…
server/modules/providers/provider.routes.ts:694
  res.json(createApiSuccessResponse({ externalSessions }));
```

`ok`는 구조분해에서 **폐기**되고 응답 스키마에 존재하지 않는다. live 라우트도 대칭적으로 신호가 없다(`:641-642`: `const liveSessions = await getLiveGjcSessions(); res.json(...)` — `LiveGjcScanResult`에는 `ok` 개념 자체가 없다, `:885-889`).

따라서 오늘 클라이언트는 "tmux가 죽어서 빈 배열"과 "정말 pane이 없어서 빈 배열"을 **원리적으로 구분할 수 없다**. 클라이언트는 이를 `src/utils/liveSessions.ts:92-127`의 `retainTransientlyMissingLiveRows`(한 번의 누락 poll만 행 유지)로 **추측 보정**하고 있으며, 그 **유일한 제품 호출부는 C0 폴 안의 `src/hooks/useProjectsState.ts:179`**다(§2.1 주 1, 개정 이력 실측 재확인 1). 즉:

- 이 보정은 **live lane에만**, 그리고 **5초 주기 폴에만** 적용된다(`:230`).
- external roster(C1)와 promotion 폴(C2/C2′)에는 보정이 **없다**.
- 따라서 현행 실효 유예는 lane별로 다르다: **live 5초, external 0초**(§6.2에서 이 값을 grace 설계의 기준선으로 사용한다).

### 2.5 기존 WS 인프라

- 게이트웨이: `websocket-server.service.ts:28-30`(공통 `verifyClient`), `:38-47`(30초 ping 하트비트: 상수 `:38`, `setInterval` `:39-47`), `:56-70`(`/shell`·`/ws`·`/plugin-ws/` 경로 라우팅).
- 봉투 규약: 모든 서버→클라이언트 프레임이 `kind`를 갖는 단일 프로토콜(`server/modules/websocket/README.md:141`), 게이트웨이 kind 목록은 `server/shared/types.ts:197-200`.
- 재생 선례: per-run `seq` + `chat.subscribe {sessions:[{sessionId,lastSeq}]}` + 버퍼 미커버 시 REST 새로고침(`server/modules/websocket/README.md:143`). **P2는 이 패턴의 확장이지 신규 발명이 아니다.**
- 팬아웃 현행: `sessions-watcher.service.ts:228-232`가 `readyState === WS_OPEN_STATE`(`websocket-state.service.ts:9`)인 클라이언트에 그대로 `send`. 쓰기 헬퍼도 열려 있으면 보내고 아니면 버린다(`websocket-writer.service.ts:21-25`). → **backpressure/큐 상한 개념이 레포에 존재하지 않는다.** P2가 신설해야 한다.

### 2.6 비용 수식 (rev.2 재계산 — RC1/RC2)

기호: 브라우저 N개, 활성 pane 선택 M개(그중 서로 다른 pane 수 `M_active`), 발견 external 세션 S개, live pane P개.

단위시간당 tmux/ps/lsof **프로세스 기동 수** R(N):

```
R(N) = R_disc + R_live + R_out + R_monitor

R_disc  = (2 + S) · min( N·(1/5 + 1/2) , 1/T_cache )        # C1 + C2, T_cache = 1.0s (:1138-1143)
        ; N ≥ 2 에서 이미 포화(0.7N ≥ 1) → 프로세스 기동은 사실상 상수,
          단 HTTP·activity 해석(transcript read)은 N에 비례

# rev.2 정정(RC1): live lane 을 폴하는 타이머는 C2′(2s) 하나가 아니라 C0(5s) + C2′(2s) 둘이다.
R_live  = c_live · min( N·(1/2 + 1/5) , 1/d_live )          # = c_live · min(0.7N, 1/d_live)
        ; c_live = 1(tmux list-panes, :945) + 1(lsof, :939) + 1(ps -eo, :1004)
                 + (receipt/proc 읽기: 프로세스 기동 아님, 별도 카운터)
        ; TTL 캐시가 없으므로(:891-900) 상한은 스캔 소요 d_live 뿐이다.
          in-flight 공유는 동시성만 막고 주파수는 막지 못한다.

# rev.2 정정(RC2): rev.1 의 R_out = 1·N 은 심각한 과소계상이었다.
#   /sessions/external/output 1회 = assertFreshExternalTmuxTarget(:702)
#        → getExternalCliSessionsFresh (uncached, :1190-1192)
#          = tmux list-panes(:1085-1088) + ps -eo(:1089) + 최대 S회 ps -p(:574-576)
#        → assertTmuxPaneIdentity = tmux display-message(tmux-pane-actions.service.ts:94-110, 실행 :98-102)
#        → capture-pane(:703, tmux-pane-actions.service.ts:136-144)
R_out(external) = (2 + S + 1 + 1) · (N_selected / 1s) = (4 + S) · N_selected
R_out(live)     = (c_live + 1 + 1) · (N_selected / 1s)  # assertLineageTmuxTarget(:808)
                                                        #  → getLiveGjcSessions = scanShared(캐시 없음)

R_monitor = (2 + S) / 5                                     # external-turn-monitor.service.ts:15
```

**핵심 결론 4가지(rev.2):**

1. tmux/ps 기동의 **지배적 선형 항은 `R_out`**이며, 그 크기는 rev.1이 적은 `N`이 아니라 **`(4+S)·N`(external) / `(c_live+2)·N`(live)**이다. S=3, N=10이면 external 경로만 초당 70회 기동이다. pane output 경로는 캐시·single-flight·공유가 전무하고, 게다가 **매 요청 fresh authorization 스캔**을 동반한다.
2. `R_disc`는 1초 TTL 덕에 프로세스 기동은 포화되지만, **요청당 비용은 선형**이다 — `/sessions/external` 핸들러가 매 요청마다 세션 S개에 대해 `resolveExternalSessionActivity`를 수행한다(`provider.routes.ts:653-693`, 특히 `:669`). 즉 transcript 파일 읽기·해석이 O(N·S)다. "tmux 호출만 상수"는 불충분하며 §7의 counter는 **transcript read도 계측**해야 한다.
3. `R_live`는 TTL이 없고 **폴 타이머가 2개(C0 5s + C2′ 2s)**여서 rev.1이 적은 `N·(1/2)`보다 **1.4배** 자주 돈다. 그리고 live 스캔은 external보다 무겁다(lsof + /proc + receipt).
4. **`pane.*`를 P2에서 제외하면 §1.3 (a)는 달성 불가**다. 결론 1의 계수가 다른 모든 항을 합친 것보다 크기 때문이다. 이것이 §5.7에서 D2를 «포함»으로 확정한 1차 근거다.

목표 상태:

```
R'(N) = (2 + S)/C_SCAN + c_live/C_SCAN                        # 수집기 1개, N 비의존
      + M_active/C_CAPTURE_MS                                  # capture-pane
      + M_active/C_CAPTURE_MS                                  # display-message 재확인(§5.7 P3)
      + M_active·(2 + S + 1)/PANE_REMINT_MS                     # fresh 재mint(§5.7 P2)
```

`C_SCAN`은 수집기 cadence(기본 1s, §10 D1), `M_active`는 **실제 구독된 서로 다른 pane 수**(브라우저 수가 아니라 pane 수 — 같은 pane을 3명이 보면 capture는 1회).

---

## 3. 불변식 (규범)

### 3.1 세 generation 분리 재진술 (승인 계획 §2′ 원칙 6)

| generation | 의미 | 권위 | 허용 용도 | 금지 용도 |
|---|---|---|---|---|
| **discovery revision** | "서버가 마지막으로 본 세계의 판번호" (P2 신설, §4.3) | 수집기 스냅샷 | 표시, 정렬, 캐시 무효화, 동기화, **구독 무효화(revoke)** | authorization, **구독 연장(grant)** |
| **process generation** | `{pid, startedAtMs}`(`shared/tmux.ts:8-11`) + pane 4-튜플(`:1-6`) | 요청 시점 host inspection | action 권한 판정, `pane.*` 구독 바인딩 | 표시 최적화의 근거로만 쓰기 |
| **interaction generation** | prompt-bound one-shot(B7b) | provider native store | 승인 응답 1회 | 재사용/재생 |

**어떤 계층도 상위 계층의 자격 증명으로 승격되지 않는다.**

### 3.2 규범적 서술 (MUST/MUST NOT)

- **N1.** P2 stream(`discovery.*`, `pane.*`)은 **display source**다. 스트림 이벤트는 UI 렌더링, 목록 정렬, 배지 표시, 낙관적 갱신에만 쓰인다.
- **N2.** 모든 injective/destructive tmux action(`send`/`kill`/`attach`/`actions`)의 authorization은 **요청 시점의 uncached host inspection**으로만 수행된다. 근거 API는 `getExternalCliSessionsFresh`(`external-cli-sessions.service.ts:1171-1173`, `:1190-1192`)를 쓰는 `assertFreshExternalTmuxTarget`(`tmux-fresh-verifier.service.ts:55-79`, **HEAD에 이미 존재**, 호출부 `provider.routes.ts:702`)이며, live lane은 `assertLineageTmuxTarget`(`tmux-target-guard.service.ts:23-63`, 호출부 `:808`)이다.
- **N3 (금지 규칙).** **P2 event(또는 그 안의 revision/epoch/스냅샷 필드)를 action credential로 사용하는 것을 금지한다.** 구체적으로:
  - a. 서버 라우트/서비스는 스냅샷 캐시에서 읽은 `{tmux, process}`로 tmux 쓰기 경로를 승인해서는 안 된다(MUST NOT).
  - b. 클라이언트가 보낸 `revision`/`epoch`/`snapshotId`를 권한 판정 입력으로 받는 API를 신설해서는 안 된다(MUST NOT). 이는 M2의 opaque attach capability와 다르다 — capability는 **서버가 발급하고 사용 시 fresh recheck**를 강제하지만, revision은 순수한 표시용 판번호다.
  - c. 위 규칙은 **타입 수준**으로 강제한다: 스냅샷 행 타입은 브랜드 타입 `VerifiedTmuxActionTarget`(`tmux-fresh-verifier.service.ts:17-25`, 생성자 `:36-48`)으로 **변환 불가**여야 하며, 스냅샷 타입에서 verified 타입으로 가는 캐스트/헬퍼가 레포에 0건이어야 한다(§9.1 U6 = 기존 경계 테스트 allowlist 확장).
  - d. **(rev.2 신설, RC2)** `pane.*` 구독에서 수집기 스냅샷은 **revoke-only**다. 스냅샷 상태는 구독을 **무효화**할 수만 있고, 구독의 유효기간을 **연장하거나 캡처를 승인**할 수는 없다(MUST NOT). 승인은 §5.7 P1/P2의 fresh 재mint만이 한다.
- **N4.** 스트림 payload에는 서버 내부 자산을 싣지 않는다 — 특히 `transcriptPaths`(`live-sessions.service.ts:887` 주석의 명시적 금지), socket path의 전송은 **기존 REST 응답이 이미 노출하는 범위**를 넘지 않는다(신규 노출 0건). 진단 이벤트는 B17a 규칙(코드/provider/count만, 사용자 라벨 제외)을 따른다.
- **N5.** 스트림 정지·지연·유실은 **표시 열화**로만 나타나야 하며, 어떤 경우에도 action 안전성을 낮추지 않는다. 스트림이 완전히 죽어도 REST 경로로 제품이 동작해야 한다(§8 롤백 전제).

### 3.3 대안과 선택 근거

| 대안 | 판정 | 사유 |
|---|---|---|
| 스트림 스냅샷을 authorization에 재사용(추가 검증 생략) | **기각** | D3(캐시 기반 authorization)의 재발. 1초 캐시를 스트림으로 바꾸면 **오히려 창이 넓어진다**(스냅샷은 구독 기간 내내 유효한 것처럼 보임). |
| 스냅샷에 짧은 TTL capability를 동봉해 action에 사용 | **기각(P2 범위 밖)** | M2의 attach capability는 발급·바인딩·fresh recheck 5항이 확정된 별도 계약이다. discovery 브로드캐스트에 capability를 태우면 **모든 구독자가 모든 pane의 capability를 상시 보유**하게 되어 최소권한 위반. |
| `pane.*` 구독을 최초 1회 검증만으로 무기한 유지 | **기각(rev.2)** | pane 재사용(respawn) 후 **다른 프로세스의 화면 내용**을 계속 스트리밍하게 된다. 읽기라도 정보 노출이다. → §5.7 P2~P4. |
| display/authorization 분리(채택) | **채택** | 원칙 6과 정합. 스트림 설계가 authorization 계약을 전혀 건드리지 않으므로 M1/M2와 병렬 진행 가능. |

---

## 4. 수집기 설계 (B12)

### 4.1 단일 권위 수집기

신설: `server/modules/providers/services/discovery-collector.service.ts` (모듈 배치는 B16 분해와 충돌하지 않게 `providers` 하위 유지).

책임:
1. cadence 타이머 1개를 소유한다(서버 전체에서 유일). 구독자 수와 무관하게 **동일 주기**로 돈다.
2. lane 스캐너들을 호출해 **하나의 권위 스냅샷**을 만든다.
3. 이전 스냅샷과 diff해 delta를 만들고 revision을 증가시킨다.
4. 구독자 0명일 때는 **idle 모드**로 내려간다(§4.5).
5. **(rev.2)** `pane.*` 구독 레지스트리에 **무효화 신호만** 공급한다(N3-d, §5.7 P4).

비책임: HTTP 응답 조립, authorization, tmux 쓰기, pane 캡처.

### 4.2 스냅샷 구조체

```ts
/** 서버 기동당 1회 생성. 재시작을 클라이언트가 무조건 감지하게 만드는 값. */
export type DiscoveryEpoch = string; // randomUUID(), 프로세스 수명 동안 불변

export type DiscoveryLane = 'external' | 'live';

/** 행 키: lane + tmux 4-튜플 (shared/tmux.ts:18-20 의 tmuxPaneIdentityKey 재사용) */
export type DiscoveryRowKey = string; // `${lane}\u0000${tmuxPaneIdentityKey(tmux)}`

export type DiscoveryRow = Readonly<{
  key: DiscoveryRowKey;
  lane: DiscoveryLane;
  tmuxName: string;
  tmux: TmuxPaneIdentity;                // shared/tmux.ts:1-6
  process: TmuxProcessGeneration | null;  // shared/tmux.ts:8-11 (external optional 근거: 서비스 :42-43)
  kind: string;                           // ExternalCliKind(:35) | 'gjc'
  providerSessionId: string | null;
  activity: 'running' | 'waiting_user' | 'asking_user' | 'unknown';  // external-session-activity.service.ts:16
  cwd: string | null;
  /** 이 행이 마지막으로 host evidence 로 확인된 revision */
  lastSeenRevision: number;
  /** grace 중인 행 표시 (§6.2) */
  presence: 'present' | 'stale';
  /** stale 진입 revision (present 면 null) */
  staleSinceRevision: number | null;
}>;

export type DiscoveryLaneHealth = Readonly<{
  ok: boolean;                       // external: ExternalCliSessionsDetailedResult.ok (:45-48)
  lastOkRevision: number | null;
  consecutiveFailures: number;
}>;

export type DiscoverySnapshot = Readonly<{
  epoch: DiscoveryEpoch;
  revision: number;                  // 단조 증가 정수, 스냅샷 변경 시에만 +1
  takenAtMs: number;
  rows: readonly DiscoveryRow[];     // key 오름차순 정렬 (결정적 직렬화)
  health: Readonly<Record<DiscoveryLane, DiscoveryLaneHealth>>;
}>;
```

**설계 선택과 대안:**

| 항목 | 선택 | 대안 | 근거 |
|---|---|---|---|
| 행 키 | `lane + tmuxPaneIdentityKey` | `providerSessionId` | 세션 id는 늦게 바인딩되거나 null일 수 있다(`external-cli-sessions.service.ts:39` optional `providerSessionId?`, live는 `GJC_IDLE_SESSION_PREFIX` 합성 id 사용 — `src/utils/liveSessions.ts:100`). pane 4-튜플은 항상 존재한다(`:37` `tmux: TmuxPaneIdentity` non-optional). |
| `process`가 키에 미포함 | 미포함 | pid 포함 | same-pane respawn을 **removed+added가 아니라 update(process 변경)** 로 표현해야 클라이언트가 "같은 자리의 새 프로세스"를 정확히 렌더한다. 그리고 pid를 키에 넣으면 키가 authorization처럼 보이는 오용을 유도한다(N3). **단 `pane.*` 구독 키는 process를 포함한다**(§5.7) — 그쪽은 «같은 자리의 새 프로세스»를 반드시 다른 것으로 취급해야 하기 때문이다. |
| 정렬 | key 오름차순 고정 | 삽입 순서 | 스냅샷 해시 비교와 delta 결정성 확보(테스트 안정성). |

### 4.3 process epoch + monotonic revision

- **epoch**: 서버 기동 시 `randomUUID()` 1회 생성, 프로세스 수명 동안 불변. **영속화하지 않는다**(§10 D3). 재시작하면 새 epoch → 클라이언트는 epoch 불일치를 보는 즉시 **로컬 상태 전량 폐기 후 full snapshot 재수신**. 이는 M2 opaque capability의 "서버 재시작 시 전부 무효" 규칙(계획 §5 B1)과 같은 fail-closed 방향이다.
- **revision**: `number`, 0에서 시작, **스냅샷이 실제로 변한 경우에만** +1. 변화 없는 tick은 revision을 올리지 않는다(하트비트만 전송, §5.6). `Number.MAX_SAFE_INTEGER` 도달은 초당 1 증가 기준 2.8억 년이므로 랩어라운드 처리를 두지 않는다(대안: 64비트 문자열 — 불필요한 복잡도로 기각).
- **정렬 보장**: revision은 수집기 단일 스레드(Node 이벤트 루프 단일 소유)에서만 증가하며, 발행은 증가와 같은 동기 블록에서 수행한다 → **strictly increasing, gap 없음**(서버 측). 클라이언트가 보는 gap은 전송 손실이며 §5.5로 처리한다.

### 4.4 스캔 트리거와 cadence

상수는 `discovery-collector.service.ts` 상단에 정의한다.

| 상태 | 상수 | cadence | 근거 |
|---|---|---|---|
| 구독자 ≥ 1 | `C_SCAN_MS` | **1000ms** | 현행 discovery TTL과 동일(`:1138-1143`) → P2가 스캔 부하를 **늘리지 않음**을 보장하는 가장 방어적인 값. |
| 구독자 0 | `C_SCAN_IDLE_MS` | **8000ms** | turn monitor(5000ms, `external-turn-monitor.service.ts:15`)가 어차피 discovery를 태우므로 완전 정지는 이득이 없다. idle에서도 monitor가 캐시를 재사용하도록 수집기 결과를 discovery 캐시로 **공급**한다. |
| 강제 refresh | `FORCE_REFRESH_DEBOUNCE_MS` | 이벤트 기반 즉시 1회(디바운스 **250ms**) | spawn/kill 직후 사용자 체감 지연 제거. 디바운스로 폭주 차단. |

**대안 검토:** (a) inotify/tmux control-mode 구독 — tmux `control mode`는 pane 목록 변화를 push해 줄 수 있으나 socket별 세션 연결을 상시 유지해야 하고 SSH/멀티 socket 환경에서 실패 모드가 늘어난다. **P2에서는 기각**하고 §10 D6로 후속 검토. (b) 요청 시 lazy 스캔 — 현행과 동일해 N 비의존성을 얻지 못함. **기각**.

### 4.5 lifecycle / shutdown

1. **기동**: 수집기는 서버 부팅 시 생성되지만 타이머는 **첫 구독 또는 첫 turn monitor tick**에서 시작(테스트에서 유령 타이머 방지).
2. **정지 조건**: `SIGINT`/`SIGTERM` 및 명시적 `dispose()`에서 (a) 타이머 clear, (b) 진행 중 스캔은 취소하지 않고 **결과를 버림**, (c) 모든 구독자에게 `discovery.closing`이 아니라 **`discovery.resync_required{server_restarted}`를 보내지 않고** 소켓 종료를 게이트웨이에 위임한다(재시작 감지는 epoch로 충분, §4.3). (d) 모든 `pane.*` 구독을 `pane.invalidated{server_closing}`으로 종료한다.
3. **재진입 금지**: 스캔은 single-flight. tick이 이전 스캔 종료 전에 도달하면 **스킵**(큐잉하지 않음) — 큐잉은 느린 호스트에서 무한 누적을 만든다.
4. **테스트 seam**: `createDiscoveryCollector({ now, setTimer, scanExternal, scanLive })` 형태의 DI. 프로덕션 기본 인스턴스는 파일 하단 1개(현행 `defaultExternalCliSessionDiscovery`(`:1177`) 패턴과 동일).
5. **누수 방지 AC**: `dispose()` 후 타이머 0개, 구독자 0명, 이후 스캐너 호출 0회(카운터로 증명).

### 4.6 **Q7 결정 — external / GJC lane 통합 여부**

**결정: 두 lane의 *스캐너*는 분리 유지, *스냅샷·revision·발행*은 단일 통합.** ("one publisher, two collectors")

실제 코드 차이에 근거한다:

| 축 | external lane | live(GJC) lane | 통합 시 문제 |
|---|---|---|---|
| 캐시 | TTL 1000ms + single-flight (`external-cli-sessions.service.ts:1138-1163`) | **TTL 없음**, in-flight 공유만 (`live-sessions.service.ts:891-900`) | 한쪽 정책으로 합치면 다른 쪽의 latency/부하 특성이 바뀐다(회귀 위험). |
| 반환 타입 | `{ ok, sessions }` (`:45-48`) | `{ sessions, transcriptPaths }` (`:885-889`) — `transcriptPaths`는 **API 응답 금지**(`:887` 주석) | 타입을 합치면 서버 전용 필드가 발행 경로에 노출될 위험이 생긴다(N4 위반 유도). |
| 가용성 신호 | boolean `ok` 존재 | **`ok` 개념 자체가 없음** | 통합 타입은 live에 대해 `ok`를 위조하게 된다. §6.1에서 live의 `ok`는 **별도 정의**가 필요. |
| 증거 수집 | `tmux list-panes -a`(`:1085-1088`) + `ps -eo`(`:1089`) + `ps -p`(`:574-576`) | `tmux list-panes`(`:945`) + `lsof`(`:939`,`:964`) + `ps -eo`(`:1004`) + `/proc` 읽기(`:483`,`:606`,`:914`) + runtime receipt 읽기(`:581`,`:615`) | 스캔 비용·실패 모드가 다르므로 cadence를 따로 낮출 여지를 남겨야 한다. |
| 검증 경로 | `assertFreshExternalTmuxTarget`(`tmux-fresh-verifier.service.ts:55-79`, HEAD 존재) | `assertLineageTmuxTarget`(`tmux-target-guard.service.ts:23-63`, `claim === 'lineage'`만 인정 `:34`) | authorization 경로가 다르다. 수집기 통합이 **검증기 통합으로 오해되면 원칙 1 위반**. |
| 세션 id | 없을 수 있음(`:39` optional) | 없으면 `GJC_IDLE_SESSION_PREFIX` 합성 id(`src/utils/liveSessions.ts:100`) | 키 전략이 다르다 → §4.2에서 lane을 키에 포함해 해결. |

**분리 사유(기록용, 승인 계획 §5 B12 AC 요구사항):**

> external과 live는 (1) 캐시 정책, (2) 반환 타입과 서버 전용 필드, (3) 가용성 신호의 유무, (4) 증거 수집 수단과 실패 모드, (5) authorization 검증기가 모두 다르다. 이 다섯 축을 하나의 스캐너로 합치면 통합 이득(코드 공유)보다 회귀 위험과 계약 오염 위험이 크다. 따라서 **수집 로직은 분리하고, 스냅샷 봉투·revision·구독자 관리·backpressure만 통합**한다. 통합 계층은 lane-agnostic이며 `DiscoveryLane`으로만 구분한다.

**공유되는 것:** cadence 타이머 1개, revision 1개, 스냅샷 1개, 구독자 레지스트리 1개, counter seam 1개.
**공유되지 않는 것:** 스캔 구현, 캐시 정책, 검증기, lane별 health 계산, **lane별 `GRACE_TICKS`**(§6.2, rev.2).

대안 A(완전 통합 스캐너)는 위 표로 기각. 대안 C(lane별 독립 스트림 2개)는 클라이언트가 두 revision을 조인해야 해서 재접속 정합성이 두 배로 복잡해지므로 기각.

---

## 5. 스트림 프로토콜 (B13)

### 5.1 전송 채널

**결정: 기존 `/ws` 게이트웨이 재사용**(`websocket-server.service.ts:62-65`), 신규 WS 경로를 만들지 않는다.

근거: 인증(`:28-30`), 하트비트(`:38-47`), 단일 `kind` 봉투 규약(`README.md:141`), 기존 재생 패턴(`README.md:143`)이 이미 존재한다. 신규 경로(`/discovery`)는 이 네 가지를 전부 복제해야 하고 클라이언트 소켓 수를 2배로 만든다.

대안: SSE — 기존 인증/재접속 인프라와 별개 경로가 되고 브라우저 연결 수 제한 이슈가 있어 기각. 롱폴링 — 현행 폴링과 비용이 같아 목적에 반함, 기각.

### 5.2 메시지 스키마 (`discovery.*`)

클라이언트→서버:

```jsonc
// 구독 (재접속 포함)
{
  "type": "discovery.subscribe",
  "protocolVersion": 1,
  "lanes": ["external", "live"],       // 생략 시 전체
  "known": { "epoch": "…uuid…", "revision": 42 } // 최초 구독 시 null
}

// 명시적 재동기화 요청
{ "type": "discovery.resync", "reason": "gap" | "epoch_mismatch" | "client_error" }

// 구독 해제
{ "type": "discovery.unsubscribe" }
```

서버→클라이언트(전부 `kind` 봉투, kind 등록은 §5.3 규칙 4):

```jsonc
// 1) 구독 확인 + full snapshot (항상 delta보다 먼저)
{
  "kind": "discovery.snapshot",
  "epoch": "3f2b…",
  "revision": 42,
  "takenAtMs": 1785000000000,
  "health": {
    "external": { "ok": true,  "consecutiveFailures": 0 },
    "live":     { "ok": true,  "consecutiveFailures": 0 }
  },
  "rows": [
    {
      "key": "external\u0000/tmp/tmux-1000/default\u0000$3\u0000@7\u0000%12",
      "lane": "external",
      "tmuxName": "codex-api",
      "tmux": { "socketPath": "/tmp/tmux-1000/default", "sessionId": "$3", "windowId": "@7", "paneId": "%12" },
      "process": { "pid": 51234, "startedAtMs": 1784999000000 },
      "kind": "codex",
      "providerSessionId": "0f1e…",
      "activity": "running",
      "cwd": "/home/u/workspace/chatmux",
      "presence": "present",
      "staleSinceRevision": null,
      "lastSeenRevision": 42
    }
  ]
}

// 2) delta — revision 은 항상 직전 발행 +1
{
  "kind": "discovery.delta",
  "epoch": "3f2b…",
  "revision": 43,
  "prevRevision": 42,
  "changes": [
    { "op": "added",   "row": { /* DiscoveryRow */ } },
    { "op": "updated", "key": "external\u0000…%12", "patch": { "activity": "asking_user" } },
    { "op": "stale",   "key": "live\u0000…%4", "since": 41 },   // grace 진입 (§6.2)
    { "op": "removed", "key": "live\u0000…%4", "reason": "confirmed_gone" }
  ],
  "health": { "external": { "ok": true, "consecutiveFailures": 0 },
              "live": { "ok": false, "consecutiveFailures": 2 } }
}

// 3) 재동기화 지시 (서버 주도)
{ "kind": "discovery.resync_required", "epoch": "3f2b…", "reason": "queue_overflow" | "epoch_changed" | "server_restarted" }

// 4) 하트비트 (변화 없음 확인 — 스트림 생존 신호)
{ "kind": "discovery.heartbeat", "epoch": "3f2b…", "revision": 43, "takenAtMs": 1785000005000 }
```

**`patch` 대신 전체 행을 보내는 대안**: `updated`에서 전체 행 재전송이 더 단순하지만 activity만 바뀌는 tick이 대부분이라 payload가 커진다. 다만 `patch` 병합 버그는 조용한 UI 불일치를 만든다. **절충 채택**: `patch`는 **평면 필드만** 허용(중첩 객체 `tmux`/`process`는 통째로 교체), 그리고 §9.1 U3에서 "snapshot+delta 적용 결과 == 서버의 다음 snapshot"을 property test로 잠근다.

### 5.3 event namespace 분리

| 스트림 | kind | 소유 | 관심사 |
|---|---|---|---|
| provider transcript index | `session_upserted` (`sessions-watcher.service.ts:173-174`, README `:234`) | sessions-watcher / run registry | **DB에 인덱싱된 세션 행**의 변화 |
| P2 discovery | `discovery.*` (4종) | discovery-collector | **호스트에 실재하는 tmux pane**의 변화 |
| P2 pane output | `pane.*` (3종, §5.7) | pane-output-stream | **구독된 pane의 화면 내용** |

규칙:
1. P2 kind는 **전부 `discovery.` 또는 `pane.` 접두사**를 갖는다. 접두사 없는 kind 신설 금지.
2. `session_upserted`의 스키마·발행 시점·소비자(`src/hooks/useProjectsState.ts:486-531`, 필터 `:520`·`:529-531`)를 **변경하지 않는다**(P2 변경분 diff에 해당 파일의 `session_upserted` 처리 로직 변경 0줄. 단 같은 파일의 C0 폴 제거는 별개 변경이며 §8 B15-3에서 수행한다).
3. 두 스트림은 **서로의 revision을 공유하지 않는다**. discovery revision은 `session_upserted`에 나타나지 않으며 그 역도 같다.
4. `server/shared/types.ts:197-200`의 게이트웨이 kind 유니온에 **7종**을 추가한다 — `discovery.snapshot`, `discovery.delta`, `discovery.resync_required`, `discovery.heartbeat`, `pane.attached`, `pane.output`, `pane.invalidated`. 잘못된 클라이언트 프레임은 기존 `protocol_error`(`:200`, README `:129`·`:136`·`:261`)를 재사용하고 신규 오류 kind를 만들지 않는다.
5. 기존 라우팅 스위치(`src/components/chat/hooks/useChatRealtimeHandlers.ts:162-165`가 사이드바 이벤트를 무시하는 패턴)와 동일하게 chat 훅은 `discovery.*`·`pane.*`를 **무시**한다.

### 5.4 구독/재접속 핸드셰이크와 **race 처리**

소켓 재접속은 이미 클라이언트에서 감지된다(`WebSocketContext.tsx`의 합성 `websocket_reconnected` kind). 절차:

```
C → S : discovery.subscribe { known: {epoch, revision} | null }

S 내부 (동일 동기 블록, 이벤트 루프 양보 없음):
  1. subscriber 를 레지스트리에 등록          ← 이 시점부터 delta 는 subscriber 큐로 버퍼링됨
  2. cur = collector.currentSnapshot()        ← revision = R
  3. if (known && known.epoch === epoch && known.revision === R) → heartbeat 만 전송하고 종료
     else → discovery.snapshot(cur) 를 큐 맨 앞에 enqueue
  4. subscriber.baselineRevision = R
  5. 큐 flush 시작: revision <= R 인 버퍼된 delta 는 **폐기**, revision > R 만 전송
```

**핵심(race 해결)**: 등록(1)이 스냅샷 획득(2)보다 **먼저** 일어나고, 그 사이는 동기 블록이라 delta가 끼어들 수 없다. 그럼에도 다른 tick이 큐에 이미 넣은 오래된 delta가 있을 수 있으므로 **`baselineRevision` 기준 필터링**(5)으로 중복을 제거한다. 결과적으로 클라이언트는 **항상 snapshot@R 다음에 R+1, R+2… 만** 본다.

대안(스냅샷 먼저 뜨고 나서 등록) — 스냅샷 직렬화 중 발생한 delta가 유실되어 **조용한 영구 불일치**를 만든다. 기각.
대안(등록 후 다음 tick의 스냅샷을 기다림) — 최대 1 cadence 지연이 구독마다 발생. 기각.

**증분 재접속**: `known.epoch`가 일치하고 `known.revision`이 서버의 **delta 링버퍼 범위 안**(기본 256 revision 보관, §10 D8)이면 snapshot 없이 delta만 재생한다. 범위 밖이면 full snapshot. 이는 `chat.subscribe`의 `lastSeq` 재생 패턴(`README.md:143`)과 동일한 설계다.

### 5.5 gap 감지 → resync

클라이언트 규칙(MUST):

```
on discovery.delta(e):
  if (e.epoch !== local.epoch)              → drop all; send discovery.resync{epoch_mismatch}
  else if (e.prevRevision !== local.revision) → drop all; send discovery.resync{gap}   // 단절 감지
  else                                       → apply; local.revision = e.revision
```

서버는 `discovery.resync`를 받으면 §5.4의 3~5를 재실행한다(full snapshot 재전송). resync 요청은 **소켓당 10초에 최대 3회**로 레이트리밋하고 초과 시 소켓을 닫는다(무한 resync 루프가 서버를 태우는 것을 방지).

서버 주도 resync는 `discovery.resync_required`로 통지하며 사유는 `queue_overflow` / `epoch_changed` / `server_restarted` 3종.

### 5.6 bounded queue / backpressure / slow-client disconnect

현행 팬아웃에는 큐도 상한도 없다(`sessions-watcher.service.ts:228-232`, `websocket-writer.service.ts:21-25`). 신설:

| 파라미터 | 기본값 | 근거 |
|---|---|---|
| `MAX_QUEUED_MESSAGES` | **64** | cadence 1s 기준 64초치 지연. 이보다 뒤처진 클라이언트는 delta 재생보다 snapshot 1회가 싸다. |
| `MAX_QUEUED_BYTES` | **1 MiB** | 세션 100개 스냅샷(≈40 KiB) 대비 25배 여유. |
| overflow 동작 | **큐 비우고 `discovery.resync_required{queue_overflow}` 1건만 남김** | 연결을 끊지 않고 자기치유. 상태 폭발 대신 상태 리셋. |
| `MAX_BUFFERED_AMOUNT` | **4 MiB** (`ws.bufferedAmount`) | 소켓 자체가 드레인되지 않는 진짜 slow client. |
| slow-client 판정 | `bufferedAmount > 4 MiB` 가 **연속 10초** 유지 | 순간 스파이크로 끊지 않기 위함. |
| disconnect | `ws.close(1013, 'discovery_slow_client')` 후 진단 1건 | 1013 = Try Again Later(표준). |
| `PANE_OUTPUT_MAX_QUEUED` | **8** (pane 구독별, §5.7) | 화면 내용은 최신값만 의미가 있다 — 초과 시 **가장 오래된 것부터 버리고 최신 1건만 유지**(coalesce). |

하트비트는 **cadence 5회마다 1회**(기본 5초) 전송하며, 큐가 비어 있을 때만 보낸다(뒤처진 클라이언트에 추가 부하 금지). 소켓 레벨 ping은 기존 30초 하트비트(`websocket-server.service.ts:38-47`)가 그대로 담당한다.

**진단(B17 규칙 준수)**: `discovery_stream_overflow`, `discovery_stream_slow_disconnect`, `discovery_resync_served`, `discovery_lane_unavailable`, `pane_stream_invalidated`, `pane_stream_remint_failed` — payload는 `{code, lane?, count}`만. **`tmuxName`·pane identity·socket path·transcript 금지**(계획 §5 B17a AC(b); 현행 `external-turn-monitor.service.ts:44-49`가 `tmuxName?`을 포함하는 것과 달리 신규 진단은 이를 제외).

### 5.7 **`pane.*` 스트림 계약 (D2 = 포함으로 확정)** — rev.2 신설 (RC2)

#### 5.7.0 결정과 근거

**결정: pane output 스트림을 P2 범위에 포함한다.** 대안(D2 제외)을 기각한 근거:

1. §2.6 결론 1·4 — pane output 경로가 **유일한 선형 항이며 계수가 가장 크다**(`(4+S)·N`). 제외하면 §1.3(a)와 계획 §5 B15 AC가 **원리적으로** 달성 불가다.
2. 제외 시 §7.3 assert C(`tmux capture-pane` 상한)와 assert B(N 무관)는 서로 모순되는 문장이 되어 테스트로 표현할 수 없다.
3. 포함의 위험(구독 수명 중 pane 재사용)은 아래 P1~P6로 **닫을 수 있는 형태의 위험**이며, 현행 write 경로가 이미 같은 종류의 TOCTOU를 명시적으로 수용하고 있다(`tmux-pane-actions.service.ts:119-120` 주석: «tmux cannot make load/paste/Enter atomic, so replacement after this point is accepted TOCTOU»). pane output은 read이므로 위험 등급이 그보다 낮다.

신설 모듈: `server/modules/providers/services/pane-output-stream.service.ts`.

#### 5.7.1 상수 정의 (구현자가 추측할 여지 없음)

```ts
// server/modules/providers/services/pane-output-stream.service.ts (파일 상단)

/** 구독된 pane 을 캡처하는 주기. 현행 클라이언트 폴 주기(1_000ms,
 *  src/components/main-content/view/MainContent.tsx:264)를 그대로 보존해
 *  체감 지연 회귀를 만들지 않는다. */
export const C_CAPTURE_MS = 1_000;

/** mint 된 VerifiedTmuxActionTarget 의 최대 재사용 기간. 만료 시 캡처를 멈추고
 *  lane 별 fresh 검증기로 재mint 한다(P2). */
export const PANE_REMINT_MS = 10_000;

/** pane 구독별 큐 상한 — 초과 시 최신 1건만 남긴다(coalesce, §5.6). */
export const PANE_OUTPUT_MAX_QUEUED = 8;

/** 캡처 결과 비교용 해시 알고리즘. 동일 해시면 프레임을 보내지 않는다. */
export const PANE_OUTPUT_HASH = 'sha256';

/** lane.ok === false 가 이 시간 이상 지속되면 구독을 무효화한다(P4-c). */
export const PANE_UNAVAILABLE_TIMEOUT_MS = 30_000;
```

`C_SCAN_MS`/`C_SCAN_IDLE_MS`/`FORCE_REFRESH_DEBOUNCE_MS`/`GRACE_TICKS_*`/`UNAVAILABLE_DEGRADE_TICKS`는 `discovery-collector.service.ts`에 정의한다(§4.4, §6.2). **두 파일이 상수를 중복 정의하지 않는다.**

#### 5.7.2 구독 키

```ts
/** pane 구독 키는 discovery 행 키와 달리 process generation 을 포함한다.
 *  같은 자리의 다른 프로세스는 반드시 다른 구독이어야 한다(§4.2 표 각주). */
export type PaneSubscriptionKey = string;
// `${lane}\u0000${tmuxPaneIdentityKey(tmux)}\u0000${process.pid}\u0000${process.startedAtMs}`
// tmuxPaneIdentityKey: shared/tmux.ts:18-20
```

캡처는 **키 단위로 1회**만 수행하고 그 키를 구독한 모든 소켓에 팬아웃한다 → `M_active`는 구독자 수가 아니라 **서로 다른 키 수**다.

#### 5.7.3 메시지 스키마

클라이언트→서버:

```jsonc
{
  "type": "pane.subscribe",
  "protocolVersion": 1,
  "lane": "external",                 // 'external' | 'live' — 검증기 선택에 사용(P1)
  "tmux": { "socketPath": "…", "sessionId": "$3", "windowId": "@7", "paneId": "%12" },
  "process": { "pid": 51234, "startedAtMs": 1784999000000 },
  "knownOutputHash": "9c1f…"          // 선택: 같으면 pane.attached 에 output 을 생략
}

{ "type": "pane.unsubscribe", "subscriptionId": "s-7" }
```

`tmux`/`process`는 기존 REST 경로와 **동일한 리더**로 파싱한다 — `readTmuxPaneIdentity`/`readTmuxProcessGeneration`(`tmux-pane-actions.service.ts`, 사용 예 `provider.routes.ts:806-807`). 파싱 실패는 `protocol_error`.

서버→클라이언트:

```jsonc
// 1) 구독 성립 + 최초 프레임 (P1 성공 후에만 전송)
{
  "kind": "pane.attached",
  "subscriptionId": "s-7",
  "key": "external\u0000/tmp/tmux-1000/default\u0000$3\u0000@7\u0000%12\u000051234\u00001784999000000",
  "lane": "external",
  "capturedAtMs": 1785000000123,
  "outputHash": "9c1f…",
  "output": "…normalizeExternalPaneOutput 결과…",   // knownOutputHash 일치 시 생략
  "verifiedUntilMs": 1785000010123                  // = capturedAtMs + PANE_REMINT_MS (표시 전용)
}

// 2) 변경 시에만 전송 (해시 동일하면 프레임 없음)
{
  "kind": "pane.output",
  "subscriptionId": "s-7",
  "key": "external\u0000…",
  "capturedAtMs": 1785000001125,
  "outputHash": "a3d0…",
  "output": "…"
}

// 3) 무효화 — 이 프레임 이후 이 subscriptionId 로는 어떤 캡처도 오지 않는다
{
  "kind": "pane.invalidated",
  "subscriptionId": "s-7",
  "key": "external\u0000…",
  "reason": "process_generation_changed" | "pane_identity_changed" | "row_removed"
          | "remint_failed" | "unauthorized" | "lane_unavailable_timeout"
          | "superseded" | "server_closing"
}
```

출력 정규화는 기존 REST와 동일 함수(`normalizeExternalPaneOutput`, 사용 `provider.routes.ts:703`·`:809`)를 재사용한다 → 스트림/REST 폴백 간 화면 차이 0.

**payload 금지 목록(N4)**: `transcriptPaths`, transcript 경로, receipt 경로. `socketPath`는 클라이언트가 **방금 보낸 값의 반향**이며 신규 노출이 아니다(현행 `/sessions/live`·`/sessions/external` 응답이 이미 `tmux`를 반환한다 — `provider.routes.ts:642`, `:656`).

#### 5.7.4 **process generation 재검증 규칙 (P1~P6, 전부 MUST)**

> 배경: `captureTmuxPane`은 `VerifiedTmuxActionTarget`만 받는다(`tmux-pane-actions.service.ts:136-138`). 이 브랜드는 두 검증기만 생성할 수 있고(`tmux-fresh-verifier.service.ts:36-48`, 경계 테스트 `tmux-fresh-verifier.service.test.ts:84`) 현행 REST는 **캡처마다** 검증한다(`provider.routes.ts:702`·`:808`). 구독은 그 검증을 «한 번»으로 줄이는 것이 아니라 **주기적으로 갱신**하는 것이다.

- **P1 (구독 시 mint).** `pane.subscribe` 수신 시 lane별 fresh 검증기를 호출한다 — external: `assertFreshExternalTmuxTarget(tmux, process)`(`tmux-fresh-verifier.service.ts:55-79`; 내부에서 uncached 스캔 `getExternalCliSessionsFresh` + `assertTmuxPaneIdentity` `:77` + mint `:78`), live: `assertLineageTmuxTarget(tmux, process)`(`tmux-target-guard.service.ts:23-63`). 실패(`TMUX_PROCESS_GENERATION_MISMATCH` / `TMUX_ACTION_NOT_LINEAGE`)면 **구독을 만들지 않고** `pane.invalidated{unauthorized}` 1건만 보낸다. 즉 «검증 없는 구독»은 존재할 수 없다.
- **P2 (재mint 강제).** mint 시각 + `PANE_REMINT_MS`가 지나면 캡처를 **중단**하고 P1을 재실행한다. 성공하면 캡처 재개(새 `verifiedUntilMs`), 실패하면 `pane.invalidated{remint_failed}` + 구독 폐기. **만료된 target으로 단 1회의 캡처도 수행하지 않는다.**
- **P3 (매 cycle 좌표 재확인).** 모든 캡처 직전에 `assertTmuxPaneIdentity(tmux)`(`tmux-pane-actions.service.ts:94-110`, `tmux display-message -p -t <paneId>` 실행 `:98-102` 1회)를 실행한다. 실패(`TMUX_PANE_GENERATION_MISMATCH`) → `pane.invalidated{pane_identity_changed}` + 구독 폐기. 이는 현행 write 경로가 첫 쓰기 전에 하는 것과 **같은 recheck**(`:121`)이다.
- **P4 (스냅샷은 revoke-only, N3-d).** 수집기가 새 스냅샷을 발행할 때마다 pane 구독 레지스트리를 순회해 다음이면 **즉시 무효화**한다:
  - a. 구독 키의 discovery 행이 `removed`이거나 스냅샷에 없다 → `row_removed`
  - b. 같은 pane 4-튜플의 행이 있으나 `process.pid`/`startedAtMs`가 구독 바인딩과 다르다 → `process_generation_changed`
  - c. 해당 lane의 `health.ok === false`가 `PANE_UNAVAILABLE_TIMEOUT_MS` 이상 지속 → `lane_unavailable_timeout`
  - d. 행이 `presence: 'stale'`이면 **무효화하지 않는다**(grace 중). 단 캡처는 계속 시도하며 P3 실패로 자연 종료되게 둔다.
  
  **반대 방향은 금지**: 스냅샷에 행이 «present»라는 사실은 P2의 재mint를 **면제하지 못하고**, `verifiedUntilMs`를 연장하지 못한다(MUST NOT). 스냅샷은 구독을 죽일 수만 있다.
- **P5 (자동 재바인딩 금지).** 무효화 후 서버는 같은 pane의 새 generation으로 **자동 재구독하지 않는다.** 클라이언트가 새 `process`를 명시해 다시 `pane.subscribe`해야 한다(fail-closed). 클라이언트는 보통 `discovery.delta`의 `updated`(process 변경)를 보고 재구독한다.
- **P6 (중복 구독 합치기).** 같은 소켓이 같은 키를 다시 구독하면 기존 구독을 `superseded`로 무효화하고 새 것으로 대체한다(구독 누수 방지). 서로 다른 소켓의 같은 키는 **1개의 캡처 루프를 공유**하며, mint는 **키당 1개**를 공유한다(구독자 수와 무관 — §1.3(a)).

#### 5.7.5 비용

키 1개당: `C_CAPTURE_MS`마다 `capture-pane` 1회 + `display-message` 1회, `PANE_REMINT_MS`마다 lane별 fresh 스캔 1회. **구독자 수 N에 무의존.** 현행(브라우저당 초당 `4+S`회)과 비교해 N=10, S=3에서 약 70/s → 약 2.4/s.

---

## 6. 가용성 의미론 (B14)

### 6.1 세 상태의 정의

| 상태 | 정의 | 관측 근거 | 클라이언트 표시 |
|---|---|---|---|
| **unavailable** | 스캔 자체가 증거를 얻지 못함 | external: `ok === false`(`external-cli-sessions.service.ts:1091`, `:1154`) — `tmux list-panes`(`:1085`) 또는 `ps`(`:1089`)가 throw. live: `scanLiveGjcSessions`의 tmux 실패 조기반환(`live-sessions.service.ts:946-948`) 또는 `tmuxHasPanes(tmuxOutput) === false`(`:949-951`)인데 이전 revision에 행이 있었던 경우 | **기존 행 유지 + "확인 불가" 표시**, 제거 금지 |
| **empty** | 스캔 성공했고 결과가 0행 | `ok === true && sessions.length === 0`(`:1112`) | 빈 목록 |
| **removed** | 스캔 성공했고 특정 행이 grace 소진 후에도 부재 | 아래 §6.2 | 목록에서 제거 |

**live lane의 `ok` 정의(신설)**: live는 `ok` 개념이 없으므로(§4.6) 수집기가 정의한다 — `scanShared()`(`:893-900`)가 예외 없이 완료했고 `tmuxHasPanes`가 true(`:949`)면 `ok: true`. 예외 또는 tmux 부재면 `ok: false`. **`lsof` 실패는 `ok: false`가 아니다** — `:877-879` 주석이 «lsof failure no longer empties the list — the ps-subtree idle lane is independent evidence»라고 명시하고 `:962-967`이 실패를 빈 문자열로 흡수하기 때문이다. 이 정의는 **수집기 계층에만 존재**하며 `live-sessions.service.ts`의 반환 타입을 바꾸지 않는다(회귀 표면 최소화).

### 6.2 grace policy — **lane별 수치 (rev.2 재산정, RC1)**

rev.1은 «폴링 주기가 2초였으므로 실효 유예 ≈2초»라 적었다. 이는 **틀렸다**. `retainTransientlyMissingLiveRows`의 유일한 제품 호출부는 **5초 폴**(`src/hooks/useProjectsState.ts:179`, 타이머 `:230`)이고, 2초 promotion 폴(`AppContent.tsx:187`, `:254`)에는 이 보정이 **없다**. 그리고 external roster 폴(`useExternalCliSessions.ts:66`)에도 없다. 따라서 현행 기준선은:

| lane | 현행 실효 유예 | 근거 |
|---|---|---|
| live | **≈5초** (1 miss × 5s 폴) | `useProjectsState.ts:179`(1회 유예 `src/utils/liveSessions.ts:121-124`), 폴 주기 `:230` |
| external | **0초** (유예 없음) | `useExternalCliSessions.ts:66`에 보정 없음 |

결정:

```
// discovery-collector.service.ts 상단
export const GRACE_TICKS_LIVE = 2;          // 실제 GJC 프로세스 소멸은 2 tick 후 제거
export const GJC_BINDING_GRACE_TICKS = 5;   // 실행 중 receipt 교체는 기존 대화 연결을 잠시 보존
export const GRACE_TICKS_EXTERNAL = 2;      // 2 tick × 1000 = 2s — 신규 유예(D12)
export const UNAVAILABLE_DEGRADE_TICKS = 30; // 30s
```

```
행이 스캔 결과에서 사라졌을 때:

  lane.ok === false (unavailable)
    → 행을 전혀 건드리지 않는다. presence 유지, revision 증가 없음(변화 아님).
    → 단, consecutiveFailures 가 UNAVAILABLE_DEGRADE_TICKS(30) 를 넘으면
      health.ok=false 를 delta 로 알리고 UI 는 전역 "discovery 확인 불가" 배너.
      (30 tick × 1s = 30초 — 사용자가 "멈춘 것 같다"고 느끼기 직전 구간)

  lane.ok === true 인데 행이 없음
    → 1차: presence='stale' 로 전이 (op:'stale'), staleSinceRevision 기록
    → GRACE_TICKS_<LANE> 연속으로 계속 없으면 op:removed, reason=confirmed

  예외 — 승격된 idle 행 (live lane 전용)
    → idle GJC 행이 구조화 세션으로 승격되면 대체 행이 같은 pane을 차지하므로
      grace 없이 즉시 제거한다. 근거: src/utils/liveSessions.ts:107-118 의
      승격 후보 판정 / 승격 id 치환 규칙을 서버로 이관한 것.
```

### 6.3 `retainTransientlyMissingLiveRows` 이관 (폐기 아님을 증명하는 절차)

요구: 승인 계획 §5 B14 AC(3) "폐기가 아니라 **이관**임을 diff로 증명".

절차(순서 강제):

1. **동작 명세 추출**: 현행 함수의 3가지 규칙을 표로 문서화한다 — (a) 미승격 행은 1회 유예(`:120-124`), (b) 승격된 idle 행은 즉시 제거(`:107-118`), (c) `nextMissed` 반환으로 유예 소진 추적.
2. **테스트 이식 우선(TDD)**: 현행 함수의 기존 단위 테스트 케이스를 **이름을 유지한 채** 서버 grace 테스트로 복제한다. 커밋 1개에 "client test → server test 복제"만 담아 **케이스 수가 줄지 않았음**을 diff로 보인다.
3. **서버 구현**: grace 상태기를 수집기에 구현하고 2의 테스트를 통과시킨다. 이 시점에 클라이언트는 **아직 그대로**다(동작 중복이지만 결과 동일).
4. **클라이언트 제거**: `retainTransientlyMissingLiveRows`의 유일한 제품 호출부(`src/hooks/useProjectsState.ts:179`)와 그 **live roster 5초 타이머**(`:147-156`, `:230`)를 함께 제거하고 함수를 삭제한다. 이 커밋의 diff는 반드시 `-` 라인(클라이언트)과 `+` 라인(서버, 3에서 이미 존재)을 **동일 PR에서 참조**해야 한다.
5. **증명 산출물**: PR 본문에 매핑표 — `src/utils/liveSessions.ts:92-127` 규칙 (a)(b)(c) → 서버 파일:라인 3곳 + 테스트 이름 3개. C0 호출/타이머 삭제와 스트림 구독 대체도 같은 표에 넣는다. **매핑되지 않은 규칙 또는 C0 제거 증거가 하나라도 있으면 머지 금지.**

대안(클라이언트 유지 + 서버도 grace) — 이중 유예로 실효 유예가 늘어난다. 기각. 대안(그냥 삭제) — 회귀 증명 불가. 기각.

### 6.4 `/sessions/external` 응답 계약 신설안 (**Q11**)

현행:

```ts
// server/modules/providers/provider.routes.ts:652
const { sessions } = await getExternalCliSessionsDetailed();   // ok 폐기
// :694
res.json(createApiSuccessResponse({ externalSessions }));
```

**신설안(Q11 기본값 채택):**

```jsonc
{
  "success": true,
  "data": {
    "externalSessions": [ /* 기존과 동일, 순서·필드 불변 */ ],
    "discovery": { "ok": true }        // 신설
  }
}
```

규칙:

1. `externalSessions`의 **기존 필드·타입·순서는 변경하지 않는다**(추가만 허용). 이는 관측 가능한 API 변경이지만 **호환 변경**이다.
2. **구버전 클라이언트 호환**: 필드 부재 시 `ok: true`로 간주한다. 즉 신규 클라이언트는 `response.discovery?.ok ?? true`로 읽는다. 구버전 클라이언트는 새 필드를 무시하므로 무해하다.
3. `discovery.ok === false`일 때 서버는 **수집기 권위 스냅샷의 마지막 roster를 MUST 반환**하고, 각 반환 행의 `presence`를 **MUST** 포함한다(`'present'` 또는 `'stale'`; §4.2). 빈 배열로 바꾸지 않는다. REST grace 적용은 **B12 수집기 스냅샷이 먼저 존재해야 하며**, 클라이언트 C0 grace가 제거되는 **B15-3까지 보류**한다(§8.1). 따라서 B14 계약 파트는 `ok`/`presence` 형식만 additive로 제공하고, B15-3 전에는 새 REST grace를 활성화하지 않는다.
4. live 대응 라우트(`provider.routes.ts:641-643`)에도 동형으로 `{ liveSessions, discovery: { ok } }`를 추가한다. `ok:false`이면 동일하게 권위 스냅샷 roster와 행별 `presence`를 MUST 반환한다. 비대칭을 남기면 클라이언트가 lane마다 다른 코드를 갖게 된다.
5. `activity` 사유코드 9종(`external-session-activity.service.ts:17-26`)의 응답 노출은 **이번에 하지 않는다** — B8(a)가 이미 `activity === 'unknown'`을 "확인 불가"로 표기하기로 결정했고(계획 §5 B8), 사유코드는 사용자에게 행동 가능한 정보를 주지 않는다. 미노출 사유를 여기에 기록함으로써 계획 §5 B14 AC(4)를 충족한다.

**대안 검토:**

| 대안 | 판정 | 사유 |
|---|---|---|
| `{ externalSessions, discovery: { ok } }` (Q11 기본값) | **채택** | 확장 가능(향후 `lastOkAtMs`, `consecutiveFailures` 추가 여지), 중첩 1단계로 네임스페이스 확보. |
| 최상위 `{ externalSessions, ok }` | 기각 | `ok`가 이미 `createApiSuccessResponse`의 `success`와 의미 충돌로 읽힌다. |
| HTTP 503 + 빈 바디 | 기각 | 클라이언트가 "목록 유지"를 못 하고 에러 UI로 튄다. unavailable은 에러가 아니라 **상태**다. |
| 응답 무변경 + 스트림에만 노출 | 기각 | REST 폴백 경로(§8 롤백)에서 의미론이 사라져 두 경로가 다르게 동작한다. |

---

## 7. 폴링 제거와 측정 (B15)

### 7.1 제거 대상과 대체 경로

| 제거 | 위치 | 대체 |
|---|---|---|
| live roster 5s (C0) | `src/hooks/useProjectsState.ts:147-156`, `:179`, `:230` | `discovery.snapshot`/`discovery.delta`의 live 행으로 `useProjectsState` 상태를 갱신. 이 호출부는 `retainTransientlyMissingLiveRows`의 유일한 제품 호출부이므로 §6.3과 같은 PR에서 제거한다. |
| roster 5s | `useExternalCliSessions.ts:25`, `:66` | `discovery.snapshot`/`discovery.delta` 구독. 훅의 공개 시그니처(`{sessions, loading, refresh}`)는 유지하고 내부만 교체 → 소비자 변경 0. `refresh()`는 `discovery.resync` 전송으로 매핑. |
| promotion 2s ×2 | `AppContent.tsx:186-187`, `:253-254` | delta의 `updated`(process/providerSessionId 변경)로 승격 판정. `findGjcPromotionCandidate`(`src/utils/liveSessions.ts:58-85`)는 **순수 함수라 그대로 재사용**하고 입력만 스트림 행으로 바꾼다. |
| pane output 1s | `MainContent.tsx:263-264` | 서버측 **pane 구독**(`pane.subscribe {tmux}`) → 서버가 활성 pane당 1회 `capture-pane`하고 변경 시에만 push. 같은 pane을 N명이 보면 capture는 1회. |

**pane output을 P2 범위에 포함하는 이유**: §2.6에서 유일한 **진짜 선형 항**이 `R_out`이다. 이를 남기면 "N에 무관한 상수"라는 B15의 AC를 달성할 수 없다. 다만 네임스페이스는 `pane.*`로 분리한다(discovery의 관심사는 "어떤 pane이 있는가", pane output은 "그 pane이 무엇을 그리는가"). §10 D2에서 재확인.

### 7.2 counter seam 설계

계측 대상은 **프로세스 기동**이다. 두 lane 모두 `runCommand`라는 동일 형태의 지역 헬퍼를 갖는다:
- `external-cli-sessions.service.ts:534` `function runCommand(command, cmdArgs, timeoutMs = 4000)`
- `live-sessions.service.ts`의 동명 헬퍼(모듈-지역)

설계:

1. 신규 모듈 `server/modules/providers/services/host-command-metrics.service.ts`:
   ```ts
   export type HostCommandCounters = Readonly<Record<string, number>>; // key = `${command} ${subcommand}`
   export function recordHostCommand(command: string, argv: readonly string[]): void;
   export function snapshotHostCommandCounters(): HostCommandCounters;
   export function resetHostCommandCounters(): void;   // 테스트 전용
   ```
2. 두 `runCommand`의 **첫 줄**에 `recordHostCommand(command, cmdArgs)` 삽입. 키는 `tmux list-panes`, `tmux capture-pane`, `ps -eo`, `ps -p`, `lsof` 형태로 정규화(첫 서브커맨드/플래그까지만; 인자 값은 키에 넣지 않는다 — 카디널리티 폭발과 경로 유출 방지).
3. 추가 계측: transcript read(§2.6 결론 2), runtime receipt read, `/proc` read — 각각 파일을 읽는 지점에 `recordHostCommand('read', ['transcript' | 'runtime-receipt' | 'proc'])` 동형 카운터. transcript tail read seam은 `external-session-activity.service.ts:297`, `:310-315`이고, receipt/`/proc` seam은 `live-sessions.service.ts:483`, `:581`, `:606`, `:615`다. "tmux 호출만 상수"로는 불충분하기 때문이다.
4. **주입 방식**: 전역 모듈 카운터 + `reset` 시드(DI 컨테이너 도입 없음). 이유 — 두 `runCommand`는 모듈-지역 함수라 인자 주입을 하려면 호출부 전체 시그니처를 바꿔야 하고, 그건 behavior-neutral을 넘는 변경이다. 카운터는 부작용 없는 순수 증가이며 프로덕션 오버헤드는 Map 증가 1회.
5. 노출: 테스트 전용 export만. **HTTP 라우트로 노출하지 않는다**(신규 관측 API 표면 0건 — 계획의 "대시보드 삭제" 방침과 정합).

### 7.3 1/10/N 브라우저 시나리오와 구체적 assert

하네스: 실 브라우저 대신 **N개의 WS 클라이언트 + REST 클라이언트**를 프로세스 내에서 생성한다(브라우저 자동화 불필요, 결정적).

```
고정 조건:
  T          = 20초 (측정 창)
  c_scan     = 1000ms
  S          = 3 (fake tmux 세션 3개, 하네스 startFakeCodex/startFakeGjc 로 생성)
  monitor    = external turn monitor 활성 (DEFAULT_INTERVAL_MS = 5000)
  M_active   = 1 (모든 클라이언트가 같은 pane 을 본다)

측정: resetHostCommandCounters() → N개 클라이언트 구독 → T 대기 → snapshotHostCommandCounters()
```

assert 문장(문자 그대로 테스트에 들어갈 형태; 아래 상한은 고정 조건 `S=3`, `M_ACTIVE=1`, 각 pane당 receipt fixture 1개에만 적용):
    
| 키 | `K_KEY_PER_S` | 근거 |
|---|---:|---|
| `tmux list-panes` | 4 | external/live collector의 각 1/s 스캔(`external-cli-sessions.service.ts:1085-1088`, `live-sessions.service.ts:945`) + P2 fresh remint 경계 |
| `tmux display-message` | 2 | P3의 capture 직전 1/s 좌표 재확인(`tmux-pane-actions.service.ts:98-102`) + 경계 여유 |
| `tmux capture-pane` | 2 | `C_CAPTURE_MS=1000`ms의 활성 pane 1개 + 경계 여유(`tmux-pane-actions.service.ts:141-144`) |
| `ps -eo` | 4 | external scan(`external-cli-sessions.service.ts:1089`)과 live idle scan(`live-sessions.service.ts:1004`) 각 1/s + remint 경계 |
| `ps -p` | 8 | external 세션별 start-time fallback(`external-cli-sessions.service.ts:574-576`)은 S=3이므로 scan당 최대 3 + 경계/remint 여유 |
| `lsof` | 2 | live scan당 1회(`live-sessions.service.ts:936-939`, 호출 `:964`) + 경계 여유 |
| `read /proc` | 8 | parent-pid/read 환경 읽기(`live-sessions.service.ts:483`, `:606`)의 S=3 fixture + 경계 여유 |
| `read runtime-receipt` | 4 | runtime receipt read(`live-sessions.service.ts:581`, `:615`); fixture의 pane당 1 receipt + 경계 여유 |
| `read transcript` | 4 | transcript tail read(`external-session-activity.service.ts:297`, `:310-315`)의 fixture S=3 + 경계 여유 |

`K_TOTAL_PER_S = Σ K_KEY_PER_S = 38`으로 정의한다. 이 값은 모든 키의 **독립 상한 합**이며, 실제 합계가 아니라 테스트가 허용하는 보수적 총 상한이다. receipt 디렉터리의 512개 상한(`live-sessions.service.ts:557-581`)을 가진 일반 제품 입력에 이 표를 적용하는 것은 금지한다. 그런 입력은 fixture를 늘린 별도 상한표/테스트를 추가해야 한다.

```ts
// A. 스캔 호출은 cadence 로만 결정된다 — N 과 무관
const maxScans = Math.ceil(T_MS / C_SCAN_MS) + 2; // 구독 트리거 + 경계
for (const [key, limit] of Object.entries(K_KEY_PER_S)) {
  assert.ok(c[key] / (T_MS / 1000) <= limit,
    `${key} ${c[key]} exceeded ${limit}/s (N=${N})`);
}
assert.ok(c['tmux list-panes'] <= maxScans * 2 + 2,
  `tmux list-panes ${c['tmux list-panes']} exceeded collector bound (N=${N})`);

// B. N=1 과 N=10/50의 키별 호출 수가 같은 범위 — "N 무관"의 직접 진술
for (const key of Object.keys(K_KEY_PER_S)) {
  assert.ok(countersN[key] <= counters1[key] + 2,
    `${key} grew with browser count (N=${N})`);
}

// C. pane output은 활성 pane 수에만 비례
assert.ok(c['tmux capture-pane'] <= Math.ceil(T_MS / C_CAPTURE_MS) * M_ACTIVE + 2);
assert.ok(counters10['tmux capture-pane'] <= counters1['tmux capture-pane'] + 2);

// D. 키별 합계와 correctness
const perSecond = total(c) / (T_MS / 1000);
assert.ok(perSecond <= K_TOTAL_PER_S,
  `host invocations/sec ${perSecond} exceeded ${K_TOTAL_PER_S} at N=${N}`);
for (const client of clients) {
  assert.deepEqual(normalize(client.rows), normalize(expectedRows));
}
// G. B15-3 뒤 제거 대상 5 타이머의 제품 호출은 0; stream 대체 경로는 1
assert.deepEqual(findLegacyDiscoveryPollSites(), []);
assert.equal(findDiscoveryStreamApplySites(), 1);
```

N 값: **1, 10, 50**. 50은 상한 회귀(예: 구독자 루프 안의 스캔 호출) 탐지용. 제거 대상 타이머는 **5개**다: pane output 1s, external roster 5s, promotion 2s ×2, live roster(C0) 5s. 서버 turn-monitor tick은 브라우저 수와 무관하게 **유지**하는 별도 입력이며 제거 대상이 아니다.

**turn monitor 동시 실행 필수**: monitor를 끄고 측정하면 "수집기와 monitor가 각자 스캔"하는 이중 스캔 회귀를 놓친다. assert A의 collector 상한은 monitor를 포함한 값이므로, monitor가 수집기 스냅샷을 재사용하지 않으면 **A가 즉시 실패**한다. 이것이 monitor↔수집기 통합의 자동 검증이다.

### 7.4 실패 시 진단 가능성

각 assert 실패 메시지에 `N`, 카운터 키별 실측치, cadence를 포함한다. "어떤 호출이 늘었는가"가 메시지만으로 판별되어야 한다(키별 diff 출력).

---

## 8. 마이그레이션 계획

원칙: **REST 경로는 P2 전 기간 동안 제거하지 않는다.** 스트림은 항상 additive이며, 각 단계는 독립적으로 되돌릴 수 있어야 한다.

| 단계 | 내용 | 공존 방식 | 롤백 |
|---|---|---|---|
| **B12** | 수집기 + 스냅샷 + revision. 발행 없음. turn monitor와 REST 라우트가 수집기 스냅샷을 소비하도록 전환 | 클라이언트 무변경. 폴링 **4종/타이머 5개** 그대로. REST 응답도 그대로 | 커밋 되돌리기. 라우트가 다시 `getExternalCliSessionsDetailed()` 직접 호출 |
| **B14(계약 파트)** | `/sessions/external`·`/sessions/live`에 `discovery:{ok}`와 행별 `presence` 형식 추가 | 구버전 클라이언트는 필드 무시(§6.4 규칙 2). **서버 REST grace는 아직 활성화하지 않는다**: C0 client grace가 남아 있어 이중 유예를 만들기 때문이다. B12 권위 스냅샷은 계약 출처로만 사용한다. | 필드 제거(구버전 호환 규칙 덕에 무해) |
| **B13** | `discovery.*` 발행 + 구독. 클라이언트는 **구독하되 폴링도 유지** | §8.1의 `T_residue` 상한 안에서 두 경로가 공존한다. 스트림 수신 시 폴링 타이머를 5s→30s로 **연장**(제거 아님). 스트림이 죽으면 30s 폴링이 커버 | 클라이언트 구독 코드만 비활성화 → 폴링 주기 복원 |
| **B15-1** | pane output 폴링 제거(`MainContent.tsx:263-264`) → `pane.*` 구독 | 가장 큰 이득(§2.6 선형 항)이면서 가장 국소적. 실패 시 화면 한 곳만 영향 | 커밋 되돌리기 |
| **B15-2** | promotion 폴링 2종 제거(`AppContent.tsx:186-187`, `:253-254`) | `findGjcPromotionCandidate` 순수 함수 재사용으로 판정 로직 무변경 | 커밋 되돌리기 |
| **B15-3** | external roster 폴링(`useExternalCliSessions.ts:66`)과 **live roster C0 5초 폴**(`useProjectsState.ts:147-156`, `:230`) 제거, `retainTransientlyMissingLiveRows` 호출/함수 제거(§6.3), 서버 REST grace 활성화, counter 테스트 그린 | 마지막. C0 제거와 서버 grace 활성화는 같은 PR에서 원자적으로 수행한다. 여기까지 와야 §7.3 assert B가 의미를 갖고 §6.4 규칙 3의 마지막 roster가 단일 권위가 된다. | 커밋 되돌리기. §6.3 4단계와 같은 PR이므로 함께 되돌아간다. |
### 8.1 공존 구간 잔상 상한 (`T_residue`)

B13~B15-3에서 스트림과 C0 live roster 폴이 동시에 동작한다. C0는 5초 주기(`src/hooks/useProjectsState.ts:230`)이고 첫 missing snapshot을 1회 유예한다(`src/utils/liveSessions.ts:120-124`). 따라서 killed live 행의 화면 잔상 상한을 **`T_residue = 10_000ms`**로 고정한다: 제거 직후 다음 C0 관측까지 최대 5초 + 1회 유예가 끝나는 다음 관측까지 최대 5초. 이 수치는 server grace를 B15-3까지 보류하는 근거이며, 단계별 종료 게이트에서 I11(가짜 시계)과 E9(실 tmux)로 잠근다. B15-3 뒤에는 C0가 없고 수집기 grace만 권위이므로 이 공존 상한은 적용되지 않는다.

**중간 상태 안전 조건(각 단계 종료 게이트 공통):**
1. `npm run verify` 그린(억제 없이).
2. 해당 단계 후 **폴링과 스트림이 동시에 켜져도** UI에 중복 행·깜빡임이 없다(같은 키 기준 idempotent upsert이므로 구조적으로 보장; 렌더 테스트로 고정).
3. 스트림을 강제로 끊은 상태에서 제품이 REST만으로 동작(수동 시나리오 + 통합 테스트 1건).

**롤백 경로**: 기능 플래그를 두지 않고 **커밋 되돌리기**를 기본으로 한다(계획 §5 B1 AC(8)과 동일 방침). 플래그는 두 경로를 영속화해 죽은 코드를 남긴다. 예외적으로 B13 단계의 클라이언트 구독만 런타임 스위치를 둘 수 있다 — 서버 재배포 없이 폴링 폴백으로 되돌릴 수 있어야 하기 때문(§10 D7).

---

## 9. 테스트 계획

### 9.1 Unit

| # | 대상 | 잠그는 것 |
|---|---|---|
| U1 | revision 증가 규칙 | 변화 없는 tick은 revision 불변, 변화 있는 tick만 +1, strictly increasing |
| U2 | diff 생성기 | added/updated/stale/removed 4종 분류. **same-pane respawn은 removed+added가 아니라 updated(process 변경)** (§4.2) |
| U3 | snapshot + delta 적용 | property test: 임의의 스캔 시퀀스에서 `apply(snapshot@R, deltas R+1..R+k) === snapshot@R+k` |
| U4 | grace 상태기 | GRACE_TICKS_LIVE=2 / GRACE_TICKS_EXTERNAL=2, GJC receipt 바인딩 유예=5, unavailable 시 미제거, 승격 시 즉시 제거(§6.2 예외) — **`retainTransientlyMissingLiveRows` 테스트 케이스 이름 그대로 이식**(§6.3) |
| U5 | 구독 race | 등록↔스냅샷 사이 delta 주입 시 baselineRevision 필터가 중복/유실 0 (§5.4) |
| U6 | **기존 경계 테스트 allowlist 확장** | `server/modules/providers/tests/tmux-fresh-verifier.service.test.ts`의 기존 source-lock 테스트(`:84`, allowlist `:91-95`, 식별자 검사 `:107-113`, 완료 `:116`)가 `createVerifiedTmuxActionTarget` 언급을 server 전역에서 검사한다. P2 파일을 추가할 때 허용 파일은 두 verifier와 barrel뿐임을 유지/확장하여 N3을 잠근다. **신규 코드 검색 테스트를 만들지 않는다.** |
| U7 | bounded queue | 65번째 메시지에서 큐가 비워지고 `resync_required{queue_overflow}` 1건만 남음 |
| U8 | slow-client | `bufferedAmount` 스텁이 4 MiB 초과 10초 유지 → `close(1013)`; 9초에서는 미종료 |
| U9 | **B14 구버전 호환** | `discovery` 필드 부재 응답을 `ok:true`로 해석(§6.4 규칙 2) |
| U10 | 진단 payload | `discovery_*` 4종에 `tmuxName`·pane identity·socket path·transcript **미포함**(B17a AC(b) 규칙 재사용) |
| U11 | lifecycle | `dispose()` 후 타이머 0, 스캐너 호출 0 (§4.5) |
| U12 | P1 mint | subscribe 직후 lane별 fresh verifier, invalid target이면 구독/캡처 0 |
| U13 | P2 remint | 10초 만료 시 capture 중단→재mint; 성공 후에만 재개, 만료 target capture 0 |
| U14 | P3 recheck | 매 capture 직전 `assertTmuxPaneIdentity` 1회, mismatch면 invalidated 후 capture 0 |
| U15 | P4 revoke-only | removed/process 변경/unavailable 30초면 invalidated; `presence:'stale'` 및 present snapshot은 mint 연장 0 |
| U16 | C0 제거 회귀 | B15-3 diff/source-lock에서 `useProjectsState`의 `api.liveSessions()`/`setInterval(...,5000)` 및 `retainTransientlyMissingLiveRows` 제품 호출 0, stream 갱신 경로 1 |
| U17 | P5 자동 재바인딩 금지 | invalidated 뒤 새 generation capture 0; 클라이언트의 명시적 새 `pane.subscribe` 뒤에만 재개 |
| U18 | P6 중복 구독 합치기 | 같은 socket 재구독은 superseded, 여러 socket 동일 키는 loop/mint 1개 |

### 9.2 Integration (라우트 / WS, 실 tmux 없이 DI)

| # | 대상 | 잠그는 것 |
|---|---|---|
| I1 | `/sessions/external` 응답 | `{externalSessions, discovery:{ok}}` 형태, `externalSessions` 기존 필드 불변(스냅샷 비교) |
| I2 | `ok:false` 경로 | 스캔 실패 스텁에서 200 + `discovery.ok=false` + **직전 roster 유지**(빈 배열 아님) |
| I2′ | `ok:false` presence 계약 | external/live 모두 권위 스냅샷 행마다 `presence: 'present'|'stale'`가 반드시 있고, B12 없이 REST grace를 켤 수 없음 |
| I3 | 구독 핸드셰이크 | snapshot이 항상 첫 프레임, 이후 revision 연속 |
| I4 | 증분 재접속 | `known.revision`이 링버퍼 내 → delta만; 범위 밖 → snapshot |
| I5 | epoch 변경 | 수집기 재생성 후 구독 → `resync_required{epoch_changed}` 또는 새 epoch snapshot |
| I6 | 네임스페이스 분리 | 동일 소켓에서 `session_upserted`와 `discovery.*`가 서로를 오염시키지 않음. chat 핸들러가 `discovery.*`를 무시(`useChatRealtimeHandlers.ts:162-165` 패턴) |
| I7 | resync 레이트리밋 | 10초 3회 초과 시 종료 |
| I8 | pane subscribe P1/P2 | invalid target 거절, 10초 remint 성공/실패 및 만료 중 capture 0 |
| I9 | pane P3/P4 | identity mismatch/process 변경/removed/unavailable은 invalidated, stale은 revoke하지 않음 |
| I10 | pane P5/P6 | 명시적 새 generation 재구독만 허용, N socket 같은 key의 capture loop 1개 |
| I11 | B13 공존 잔상 | fake clock에서 C0의 제거 시점이 `T_residue=10_000ms`를 넘지 않고, B15-3 전 REST grace 미활성·후 활성 |

### 9.3 E2E (실 tmux, 하네스 확장)

기존 자산: `server/modules/providers/tests/support/tmux-e2e-harness.ts` — `TmuxE2EHarness` 타입 `:39-59`, `FakeAgentEvent` 3종 `:20-23`, `startFakeCodex`/`startFakeGjc`/`startFakeGjcWithTranscript`/`respawnFakeCodexPane`/`killSession`/`capturePane` 제공. 시나리오 8종은 `tmux-runtime.e2e.test.ts`.

**확장 지점(신규 3개):**

1. `createDiscoveryStreamClients(n)` — 프로세스 내 WS 클라이언트 N개 생성/구독/프레임 수집. 하네스에 추가.
2. `withHostCommandCounters(fn)` — reset → 실행 → snapshot 반환(§7.2).
3. `suspendTmuxServer()` / `resumeTmuxServer()` — unavailable을 **실제로** 재현(tmux 소켓 경로를 일시 변경해 `list-panes` 실패 유도). 기존 하네스는 `TMUX_TMPDIR`를 이미 제어하므로(`ENVIRONMENT_KEYS`) 저비용 확장.

**시나리오:**

| # | 시나리오 | 판정 |
|---|---|---|
| E1 | 세션 생성 → 모든 구독자가 동일 revision의 `added`를 받음 | 팬아웃 정확성 |
| E2 | `killSession` → grace 2 tick 후 `removed` | §6.2 |
| E3 | `suspendTmuxServer` 3초 → 행 유지 + `health.external.ok=false`, resume 후 복구 | unavailable ≠ removed |
| E4 | `respawnFakeCodexPane` → 같은 key의 `updated`(process 변경), added/removed 아님 | U2의 실환경 확인 |
| E5 | 소켓 강제 절단 후 재접속 → snapshot 또는 delta 재생으로 **서버와 동일 상태 수렴** | §5.4/§5.5 |
| E6 | delta 1건 인위 폐기 후 다음 delta 수신 → 클라이언트가 gap 감지 후 resync, 최종 상태 일치 | §5.5 |
| E7 | N=1/10/50 counter 측정(turn monitor 동시 실행) | §7.3 키별 `K_KEY_PER_S` 및 `K_TOTAL_PER_S` |
| E8 | 스트림 다운 상태에서 REST만으로 roster 표시 | §8 롤백 전제 |
| E9 | B13 공존 상태에서 live pane kill | 실 tmux에서 `T_residue ≤ 10_000ms`, 중복 행/깜빡임 0 |
| E10 | pane subscribe → 매 cycle recheck/capture | P1·P3, N client 공유 capture 1개 |
| E11 | pane process respawn | P4 invalidated 후 자동 재바인딩 0(P5) |
| E12 | pane remint 실패 / lane unavailable 30초 | P2/P4 invalidated, 만료 target capture 0 |

### 9.4 Benchmark

E7이 곧 benchmark다. 별도 벤치 인프라를 만들지 않는다(레포에 벤치 러너 없음). 회귀 상한은 §7.3의 키별 `K_KEY_PER_S`와 총합 `K_TOTAL_PER_S`로 테스트 상수에 고정하고, 초과 시 실패한다 — "측정만 하고 통과"는 금지.

### 9.5 검증 커맨드

```
npm run verify                # 7스텝 전체 (package.json:54)
npm test                      # pretest 가 build:core:dev 수행 (package.json:51)
```
e2e는 실 tmux 의존이므로 tmux 부재 환경에서는 skip되며, skip 여부를 M4b 종료 게이트 보고에 명시한다.

---

## 10. 미해결 결정 사항 (RFC 승인 시 함께 확정)

| # | 질문 | 제안 기본값 | 확정 시점 |
|---|---|---|---|
| **Q7** | external/GJC 수집기 통합 여부 | **분리 스캐너 + 단일 퍼블리셔**(§4.6, 사유 기록 완료) | 본 RFC 승인 |
| **Q11** | `/sessions/external` 가용성 응답 형태 | **`{ externalSessions, discovery: { ok } }` + 필드 부재 시 `ok:true`**(§6.4) | 본 RFC 승인 |
| **D1** | 수집 cadence | 구독 시 1000ms / idle 8000ms / 강제 refresh 디바운스 250ms | 본 RFC 승인 |
| **D2** | pane output(`capture-pane`)을 P2 범위에 포함? | **포함**하되 `pane.*` 별도 네임스페이스(§7.1). 제외하면 B15 AC 달성 불가 | 본 RFC 승인 |
| **D3** | epoch 영속화 | **하지 않음** — 재시작 시 새 UUID, 클라이언트 전량 재동기화(fail-closed) | 본 RFC 승인 |
| **D4** | slow-client 임계값 | 큐 64 msg / 1 MiB, `bufferedAmount` 4 MiB 연속 10초 → `close(1013)` | B13 착수 전 |
| **D5** | `activity`를 discovery 행에 포함? | **포함**(배지 표시 전용). 사유코드 9종은 미노출(§6.4 규칙 5) | 본 RFC 승인 |
| **D6** | tmux control-mode 구독 도입 | **P2에서는 미도입**, cadence 폴 유지. 재검토는 M4b 종료 후 | M4b 종료 |
| **D7** | B13 단계 클라이언트 구독의 런타임 스위치 | 허용(서버 재배포 없이 폴링 폴백). 그 외 단계는 커밋 되돌리기만 | B13 착수 전 |
| **D8** | delta 링버퍼 크기 | 256 revision(≈256초분). 초과 시 full snapshot | B13 착수 전 |
| **D9** | 구독 권한 범위 | 인증 principal은 **모든 lane·모든 pane**을 본다(현행 REST와 동일 범위). 축소는 별도 결정 | 본 RFC 승인 |
| **D10** | B16(라우트 분해)과의 순서 | 계획대로 B16은 M4b **이후**. 수집기 모듈은 `providers/services/` 신규 파일이라 분해와 충돌 없음 | 변경 없음 |

---

## 부록 A. §6 P2 진입 조건 ↔ 본 문서 매핑 (추적표)

| # | 승인 계획 §6 진입 조건 | 본 문서 위치 | 결정 요약 |
|---|---|---|---|
| 1 | process epoch + monotonic revision | **§4.2, §4.3** | 서버 기동당 UUID epoch(미영속) + 변화 시에만 +1 하는 단조 정수 revision |
| 2 | reconnect 시 full snapshot 후 strictly ordered delta | **§5.4**, 스키마 §5.2 | 등록→스냅샷 동기 블록 + `baselineRevision` 필터. 링버퍼 내면 delta 재생 |
| 3 | unavailable / empty / removed 구분 + grace policy | **§6.1, §6.2** | 3상태 정의 + 프로세스 제거 grace 2 tick, GJC receipt 바인딩 grace 5 tick, unavailable 시 미제거, 30 tick 후 degrade 배너 |
| 4 | gap 감지 시 resync, bounded queue/backpressure, slow-client disconnect | **§5.5, §5.6** | `prevRevision` 단절로 gap 감지 → resync(10s 3회 상한). 큐 64/1 MiB → resync_required. bufferedAmount 4 MiB·10초 → `close(1013)` |
| 5 | scanner cadence/lifecycle/shutdown 및 lane 통합 여부(Q7) | **§4.4, §4.5, §4.6** | cadence 1s/idle 8s, dispose 계약, **Q7=분리 스캐너+단일 퍼블리셔**(5축 코드 근거 기록) |
| 6 | `session_upserted`와 discovery stream namespace 분리 | **§5.3** | `discovery.` 접두사 강제, `session_upserted` 스키마·소비자 변경 0줄, revision 비공유 |
| 7 | 브라우저 1/10/N 상수 비용 instrumented test | **§7.2, §7.3**, E2E §9.3 E7 | 9개 `recordHostCommand` 키와 `K_KEY_PER_S`/`K_TOTAL_PER_S`, N=1/10/50, monitor 동시 실행; 제거 대상은 5 타이머(C0 포함) |
| 8 | "stream=display, action verifier=fresh inspection" 명문화 | **§3.2 N1~N5**, 금지 규칙 **N3**, U6 | P2 event를 action credential로 쓰는 것을 MUST NOT으로 규정 + 기존 verifier source-lock allowlist 확장 |
| 9 | B14 `/sessions/external` 응답 계약 신설안 승인(Q11) | **§6.4**, I1·I2·I2′ | `{ externalSessions, discovery:{ok} }`, `ok:false` 행의 `presence` MUST, B12 권위 스냅샷 선행 및 B15-3 grace 활성화 |
| 10 | pane stream generation 재검증(P1~P6) | **§5.7.4**, U12~U15·U17~U18/I8~I10/E10~E12 | P1~P6을 각각 독립 unit case로 잠그고, mint/remint·매 cycle recheck·revoke-only·자동 재바인딩 금지·키별 공유를 통합/E2E로 교차 검증 |
| 11 | B13 공존 잔상 상한 | **§8.1**, I11/E9 | C0 5초 + 1회 유예를 `T_residue=10_000ms`로 고정하고 B15-3까지 REST grace 보류 |

추가 요구(계획 §8 M4a 종료 게이트): "P2 event를 action credential로 쓰지 않는다" 명문화 → **§3.2 N3**.

---

## 부록 B. 인용 근거 색인 (grep 재현 가능)

| 주장 | 근거 |
|---|---|
| live roster C0 5초/유일 grace 호출 | `src/hooks/useProjectsState.ts:147-156`, `:179`, `:230` |
| promotion 폴링 2초 ×2 | `src/components/app/AppContent.tsx:186-187`, `:253-254` |
| running sessions 5초(DB 전용) | `src/components/app/AppContent.tsx:357-360`, `server/modules/providers/provider.routes.ts:623-624` |
| pane output 폴링 1초 | `src/components/main-content/view/MainContent.tsx:263-264` |
| pane output 라우트가 매번 capture | `server/modules/providers/provider.routes.ts:703-704`(external), `:809-810`(live) |
| turn monitor 5초 tick | `server/modules/notifications/services/external-turn-monitor.service.ts:15` |
| 진단 60초 레이트리밋 / 코드 집합 / payload | 같은 파일 `:34`, `:20-32`, `:44-49` |
| discovery 반환 타입 `{ok, sessions}` | `server/modules/providers/services/external-cli-sessions.service.ts:45-48` |
| discovery 캐시 TTL 기본 1000ms | 같은 파일 `:1138-1143` |
| single-flight | 같은 파일 `:1146`, `:1150`, `:1160-1162` |
| 스캔 1회 = `tmux list-panes -a` + `ps -eo` | 같은 파일 `:1085-1088`, `:1089` |
| 스캔 실패 → `{ok:false, sessions:[]}` | 같은 파일 `:1091`, `:1154` |
| 성공 → `{ok:true, …}` | 같은 파일 `:1112` |
| `getExternalCliSessionsFresh`가 캐시 우회 | 같은 파일 `:1171-1173`, `:1190-1192` |
| 세션별 `ps -p … lstart` | 같은 파일 `:574-576` |
| `runCommand` 헬퍼(counter seam 지점) | 같은 파일 `:534` |
| 라우트가 `ok`를 폐기 | `server/modules/providers/provider.routes.ts:652`, 응답 조립 `:653-693`, `:694` |
| live 반환 타입 + `transcriptPaths` 서버 전용 | `server/modules/providers/services/live-sessions.service.ts:885-889`(주석 `:887`) |
| live는 TTL 없이 in-flight 공유만 | 같은 파일 `:891-900` |
| `session_upserted` 빌더 | `server/modules/providers/services/sessions-watcher.service.ts:149-183` |
| `session_upserted` 팬아웃(큐/상한 없음) | 같은 파일 `:228-232`, `server/modules/websocket/services/websocket-state.service.ts:9` |
| 쓰기 헬퍼가 backpressure 미고려 | `server/modules/websocket/services/websocket-writer.service.ts:21-25` |
| 게이트웨이 인증/하트비트/경로 라우팅 | `server/modules/websocket/services/websocket-server.service.ts:26-31`, `:38-47`, `:56-71` |
| 단일 `kind` 봉투 규약 | `server/modules/websocket/README.md:141`; kind 유니온 `server/shared/types.ts:197-200` |
| `seq`/`lastSeq` 재생 선례 | `server/modules/websocket/README.md:143` |
| chat 훅이 사이드바 이벤트를 무시 | `src/components/chat/hooks/useChatRealtimeHandlers.ts:162-165` |
| `retainTransientlyMissingLiveRows` 규칙 | `src/utils/liveSessions.ts:92-127`(승격 즉시 제거 `:107-118`, 1회 유예 `:120-124`) |
| `findGjcPromotionCandidate` 순수 함수 | `src/utils/liveSessions.ts:58-85` |
| pane 4-튜플 / process generation 타입 | `shared/tmux.ts:1-6`, `:8-11`, 키 함수 `:18-20` |
| live lineage 검증기 | `server/modules/providers/services/tmux-target-guard.service.ts:10-49` |
| activity 사유코드 9종(미노출 대상) | `server/modules/providers/services/external-session-activity.service.ts:17-26` |
| e2e 하네스 API / FakeAgentEvent | `server/modules/providers/tests/support/tmux-e2e-harness.ts:39-59`, `:20-23` |
| verify/pretest 정의 | `package.json:54`, `:51` |
| `assertTmuxPaneIdentity` / display-message | `server/modules/providers/services/tmux-pane-actions.service.ts:94-110`(실행 `:98-102`) |
| write TOCTOU 주석 / P3 recheck | 같은 파일 `:119-120` / `:121` |
| verifier source-lock allowlist | `server/modules/providers/tests/tmux-fresh-verifier.service.test.ts:84`, `:91-95`, `:107-113`, `:116` |
| live command/receipt/`/proc` seams | `server/modules/providers/services/live-sessions.service.ts:483`, `:581`, `:606`, `:615`, `:939`, `:945`, `:964`, `:1004` |
| transcript read seam | `server/modules/providers/services/external-session-activity.service.ts:297`, `:310-315` |

---

## 승인 요청

본 RFC 승인은 다음을 함께 승인하는 것이다:

1. **Q7 = 분리 스캐너 + 단일 퍼블리셔**(§4.6).
2. **Q11 = `{ externalSessions, discovery: { ok } }` + 필드 부재 시 `ok:true`**, live 라우트 동형 확장 포함(§6.4).
3. **§3.2 N3 금지 규칙** — P2 event를 action credential로 사용 금지, 타입 수준 강제 + 코드 검색 AC.
4. **§7.1 pane output 폴링의 P2 편입**(D2).
5. §10의 D1·D3·D5·D9 기본값.

미승인 항목(D4·D6·D7·D8)은 B13 착수 전 또는 M4b 종료 후로 미룬다.
