# ChatMux 제품 범위와 로드맵

기준일: 2026-09-05

이 문서는 ChatMux의 제품 범위와 작업 우선순위에 대한 단일 기준이다.
ChatMux는 tmux에서 이미 실행 중인 코딩 에이전트를 발견하고, 읽고, 제어하는
셀프호스트 웹 관제면이다.

## 제품 정의

> **tmux가 주인이고 ChatMux는 창문이다.**

사용자는 Gajae Code, Claude Code, Codex, Cursor, OpenCode, Oh My Pi, Oh My OpenAgent 같은
에이전트를 평소처럼 tmux에서 실행한다. ChatMux는 그 프로세스를 소유권
이관이나 별도 등록 없이 찾아 브라우저와 모바일 웹에 표시한다.

ChatMux가 제공하는 핵심 가치는 다음과 같다.

1. ChatMux 밖에서 시작한 tmux 에이전트를 자동으로 발견한다.
2. 검증된 native transcript가 있으면 구조화된 대화로, 없으면 terminal로 연다.
3. 입력, 재개, 중단, 종료를 정확한 tmux 대상과 프로세스 혈통에만 전달한다.
4. ChatMux가 재시작되거나 종료돼도 tmux 세션은 계속 실행된다.
5. 같은 호스트의 여러 에이전트를 하나의 웹 관제면에서 확인한다.
6. 한 hub에서 최대 아홉 개의 독립된 full peer 설치를 직접 연결해 표시한다
   (총 열 대). 각 peer의 tmux, 데이터, 키, updater, 직접 UI는 peer가 계속 소유한다.

## 제품 불변식

- tmux와 provider-native session store가 원본이다. ChatMux 데이터베이스는
  검색과 표시를 위한 인덱스이지 실행 상태의 단일 권위자가 아니다.
- 작업 디렉터리가 같다는 사실만으로 입력이나 종료 권한을 부여하지 않는다.
- 모든 제어 작업은 tmux identity, 프로세스 혈통, provider session identity를
  가능한 범위에서 교차 검증하고 불확실하면 거부한다.
- 구조화된 transcript를 검증할 수 없으면 terminal attach로 강등한다. 추측으로
  다른 대화를 연결하지 않는다.
- ChatMux 프로세스나 브라우저 연결의 수명은 tmux 세션 수명과 분리한다.
- 새 기능보다 기존 tmux 세션을 잘못 표시하거나 잘못 제어하지 않는 것이 우선이다.
- fleet browser 작업은 owner-only다. hub는 peer를 직접 연결하고, peer는 모든 작업을
  실행하기 전에 로컬 identity·lineage·generation을 다시 검증한다.
- remote host가 `syncing`이면 fresh snapshot 전까지 쓰기를 중단하고, `offline`이면
  다른 host로 우회하거나 mutation을 재생하지 않는다.

## 현재 기준선

- Gajae Code, Claude Code, Codex, Cursor, OpenCode, Oh My Pi, Oh My OpenAgent와 SSH tmux
  세션을 자동 발견한다.
- provider-native session store를 인덱싱하고, 연결 가능한 외부 세션을
  구조화된 transcript와 composer로 연다.
- transcript가 없거나 검증되지 않은 세션과 SSH 세션은 terminal로 연다.
- 내장 relay 또는 선택적 control tower를 통해 tmux 입력과 생명주기 작업을
  수행한다.
- 설치 시 로그인된 Tailscale이 있으면 loopback backend + Tailscale Serve HTTPS를
  선택하고, 없으면 password/LAN으로 폴백한다. 현재 유효 주소는 `chatmux status`가
  표시한다.
- owner는 한 hub에 최대 아홉 full peer를 등록해 host별 session, transcript, verified
  terminal/control surface를 사용할 수 있다. 기본 peer transport는 Tailscale
  HTTPS/WSS다. 예외는 owner가 직접 만들거나 **Easy SSH setup**으로 hub에
  생성을 요청한 loopback SSH local forward다.

## 범위 밖

다음 항목은 ChatMux의 제품 방향이 아니다.

- ChatMux가 에이전트 작업, durable job, worktree, checkpoint, commit을
  소유하는 실행 오케스트레이터
- 프로젝트 clone, 코드 리뷰, diff, 파일 편집을 중심으로 한 범용 또는 remote IDE
- remote desktop, cloud/database sync, fleet-wide updater, arbitrary remote command,
  remote plain-shell 생성, 자동 failover·hub 승격
- Electron 또는 Tauri 기반 데스크톱 앱 확장
- 네이티브 모바일 앱
- ChatMux가 운영하는 릴레이·터널·시그널링 서버 (원격 도달성은 사용자가
  선택한 VPN·터널·포트포워딩에 위임한다)
- Live Activity, Apple Watch 같은 네이티브 알림 표면
- provider가 제공하는 CLI, 인증, sandbox, 모델 실행 기능의 재구현
- zero-config 원격 도달성, ChatMux가 관리하는 Tailscale 또는 범용 SSH 설정·키
  (Fleet RFC revision 6의 owner 요청 기반 전용 SSH 터널·키와 선택적 최초 설치는 지원)

Electron 셸, 데스크톱 패키징, 전용 알림 채널과 원격 target 확장 코드는
2026-07-23 제거를 확정했다. 웹/PWA 외의 전달 표면은 유지하지 않는다.

원격 도달성을 우리가 호스팅하지 않는 결정과 그 근거는
[REMOTE-ACCESS.md](REMOTE-ACCESS.md)에 기록했다. 요약하면 앱 설치 없이
준비물 없이 어디서나 접속하는 방법은 존재하지 않으며, 경쟁 제품(Orca, Moshi,
mosh, et.rs)도 모두 Tailscale 또는 포트 개방으로 수렴한다.

## 로드맵

### P0 — 실제 tmux 계약 검증

실제 tmux 서버와 제어 가능한 fake agent CLI를 사용한 end-to-end 검증을 만든다.

- [x] ChatMux보다 먼저 실행된 에이전트 자동 발견
- [x] 첫 transcript 기록 전 idle pane 표시
- [x] 동일 cwd의 여러 에이전트 분리
- [x] Node wrapper 프로세스 혈통 판별
- [x] Bun과 npm shim wrapper 프로세스 혈통 판별
- [x] transcript 생성 후 terminal에서 구조화 대화로 안전하게 승격
- [x] ChatMux discovery 프로세스 재시작 후 동일 tmux 대상 재연결
- [x] 존재하지 않는 identity의 입력을 거부하고 기존 세션을 보존
- [x] 이전 generation 토큰을 사용한 입력·종료 거부
- [x] 정확한 tmux 대상에만 입력하고 동일 cwd의 다른 세션에는 전달하지 않음
- [x] ChatMux discovery 프로세스 종료 후 tmux 세션 생존

완료 항목은 격리된 실제 tmux socket과 Node/Bun 런타임 및 npm bin shim으로
실행되는 fake Codex/GJC CLI를 사용한 end-to-end 테스트로 검증한다. CI와
릴리스 검증 환경은 tmux와 Bun을 명시적으로 설치하고 같은 계약을 실행한다.

### P1 — pane 단위 identity (shipped)

현재 session name 중심 모델을 tmux pane 중심 모델로 바꾼다.

- [x] `socket + session_id + window_id + pane_id`를 정규 identity로 사용
- [x] 한 tmux session 안의 여러 agent pane을 각각 표시
- [x] 입력과 terminal attach는 정확한 pane을 대상으로 실행
- [x] agent process 종료, `kill-pane`, `kill-session`을 서로 다른 작업으로 분리
- [x] 기본 종료 작업이 tmux session 전체를 제거하지 않도록 변경
- [x] pane 재사용 시 이전 프로세스 혈통과 generation을 무효화

### P2 — 단일 discovery stream (shipped)

브라우저마다 `tmux list-panes`와 `ps`를 반복하지 않도록 서버가 하나의
권위 있는 discovery snapshot을 관리한다.

- [x] 서버에서 한 번 수집하고 모든 브라우저에 WebSocket delta 배포
- [x] 재접속 시 전체 snapshot 뒤 순서 있는 변경 이벤트 제공
- [x] 일시적인 scan 실패와 실제 pane 종료를 구분
- [x] 브라우저 수와 무관한 일정한 tmux/프로세스 조회 비용 보장

### P3 — tmux 확장성

- [x] owner 환경 설정으로 custom terminal agent command/argv 감지 — Linux의 검증된 foreground 프로세스를 기존 terminal-only 경로로 연다 ([설정과 제한](CUSTOM-AGENTS.md))
- [x] parser가 없는 agent의 terminal fallback
- [x] owner가 명시한 `tmux -L`·`tmux -S` 서버 목록 지원 — 소켓 identity와 교체 여부를 검증한다 ([설정과 부분 실패 정책](TMUX-DISCOVERY.md))
- [x] 관리자용 집계 진단 — 탐색 시각·실패 사유·감시기 신호·인덱싱 대기열과 복구 안내
- [ ] pane별 socket·프로세스 혈통·transcript 연결 근거의 상세 진단 화면

### P4 — 모바일 웹 관제 (shipped)

- [x] 질문, 완료, 실패 알림
- [x] 짧은 답변과 승인
- [x] interrupt와 안전한 종료
- [x] 네트워크 재연결 후 같은 pane 복구
- [x] 작은 화면의 terminal 입력과 읽기 개선
- [x] 원격 접근 안내: 설치 시 Tailscale 감지 힌트, 모드 전환 시 이전 주소 무효 고지,
      `chatmux status`의 현재 모드·유효 주소 표시 ([REMOTE-ACCESS.md](REMOTE-ACCESS.md) 5절)

네이티브 앱을 만들지 않고 반응형 웹과 PWA 범위에서 구현한다.

추가된 웹 관제 기능:

- 로컬 목록에서 응답 필요·실패·연결 문제를 구분하고 다음 대상에 이동한다.
  원격 호스트의 마지막 보고 상태를 로컬의 현재 상태 집계에 섞지 않는다.
- 헤더 검색 버튼 또는 Ctrl/Cmd+K에서 최대 12개 세션을 브라우저에 고정한다.
  host·project·session 식별자만 저장하며, 현재 허용된 목록에 없는 대상은 열지 않는다.
- 대화에 표시된 사용자·어시스턴트 메시지를 선택하고, 내용을 확인·수정한 뒤
  발췌를 복사한다. 기록 전체나 숨겨진 도구 출력은 자동으로 포함하지 않는다.
- 로컬 탐색의 재연결·갱신·최신 여부를 구분하고, 화면 복귀와 누락 감지 시
  제한된 읽기로 복구한다. 전송이나 승인을 자동 재실행하지 않는다.

집계 진단은 **설정 → 진단**에서 소유자가 확인한다. 인덱싱 수치는 대기열의
입장·처리 상태이며 에이전트의 생존이나 제어 권한을 증명하지 않는다. 전체
기록을 처음 읽는 작업은 대기열 제한 밖에 있다. 백업과 데이터 복구는
[소유자 운영 절차](SELF-HOST.md#owner-managed-backup-and-recovery)를 따른다.

### P5 — Multi-PC fleet (shipped)

- [x] one hub + 최대 nine full peers (총 ten PCs), owner-only enrollment
- [x] single-use 10-minute pairing code와 양방향 installation-key pinning
- [x] Tailscale Serve HTTPS/WSS 기본 경로, plaintext downgrade 없음
- [x] owner가 수동 생성하거나 hub에 명시적으로 생성을 요청한 SSH local forward에 한해 literal
      `ws://127.0.0.1` 또는 `ws://[::1]` 허용
- [x] **Easy SSH setup**으로 전용 키 설치·터널 관리·페어링 자동 수행
      (SSH 도달성은 사전 준비, 비밀번호는 미보관)
- [x] owner가 명시적으로 선택한 경우에만 Linux x86_64 원격 PC에 허브와 같은
      릴리스 최초 설치. 기존 설치 복구·업데이트는 수행하지 않음
- [x] owner-only Tailscale PC 후보 목록으로 SSH 주소 입력 보조
- [x] host-qualified catalog/session/chat/verified terminal/completion routing
- [x] `offline`·`syncing`·`revoked`·`incompatible` fail-closed 상태와 명시적 reconnect
- [x] local-first revoke, peer 직접 UI 복구, installation-key loss revoke/re-pair
- [x] hub-first, peer-by-peer update 운영 계약

상세 설치·복구·범위 계약은
[REMOTE-ACCESS.md §8](REMOTE-ACCESS.md#8-multi-pc-fleet-one-hub-and-full-peers)에 있다.
Fleet는 remote desktop/IDE, cloud sync, relay, 자동 failover, fleet updater가 아니다.

## 우선순위 규칙

새 작업은 아래 질문을 순서대로 통과해야 한다.

1. 이미 tmux에서 실행 중인 에이전트를 더 정확하게 발견하거나 제어하는가?
2. 잘못된 pane, process, transcript를 선택할 가능성을 줄이는가?
3. ChatMux 장애가 tmux 작업에 영향을 주지 않는가?
4. provider별 특별 처리 없이 terminal fallback이 가능한가?

모두 아니라면 이 로드맵의 작업이 아니다.

## 성공 기준

- 외부에서 시작한 지원 agent가 별도 등록 없이 나타난다.
- 한 tmux session의 여러 pane이 서로 섞이지 않는다.
- 올바른 transcript가 연결되고, 검증할 수 없으면 terminal로 열린다.
- 입력과 종료가 다른 pane이나 재사용된 process에 전달되지 않는다.
- 서버·브라우저 재시작이 tmux 작업을 종료하지 않는다.
- 같은 동작을 브라우저와 모바일 웹에서 재현할 수 있다.

## 결정 이력

| 날짜 | 결정 |
|---|---|
| 2026-07-16 | tmux 관제창을 ChatMux의 핵심으로 확정 |
| 2026-07-22 | 제품명을 ChatMux로 통일하고 멀티에이전트 채팅 웹터미널로 포지셔닝 |
| 2026-07-23 | 앱 소유 실행기와 데스크톱 앱 로드맵을 폐기하고 tmux 전용 제품 범위로 재확정 |
| 2026-07-23 | Electron 셸과 데스크톱 전용 확장 코드 제거 확정 |
| 2026-07-27 | 설치를 단일 형태(password + 전체 인터페이스)로 고정하고 원격 모드는 명시적 명령으로 분리 |
| 2026-07-27 | 릴레이 서버 운영과 자체 모바일 앱을 범위 밖으로 확정. 원격 도달성은 사용자 선택에 위임 ([REMOTE-ACCESS.md](REMOTE-ACCESS.md)) |
| 2026-08-27 | one hub + nine full peers fleet를 현재 기능으로 기록. Tailscale WSS 기본, literal loopback SSH 예외, owner-only enrollment, direct-peer recovery와 hub-first update를 계약으로 확정 |
| 2026-08-29 | P1·P2·P4를 현재 기능으로 기록. P3은 terminal fallback만 현재 기능이고 custom agent 감지, 여러 tmux 서버 discovery, 진단 화면은 열어 둔다 |
| 2026-09-03 | Fleet RFC revision 4와 #101에서 owner 요청 기반 SSH 간편 등록·전용 터널 관리를 추가. 기존 수동 loopback forward 경로도 유지 |
| 2026-09-05 | Fleet RFC revision 6: owner의 명시적 선택에 따른 원격 최초 설치와 Tailscale PC 후보 목록을 추가. 기존 설치 복구·업데이트는 제외 |
