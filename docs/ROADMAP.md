# ChatMux 제품 범위와 로드맵

기준일: 2026-07-23

이 문서는 ChatMux의 제품 범위와 작업 우선순위에 대한 단일 기준이다.
ChatMux는 tmux에서 이미 실행 중인 코딩 에이전트를 발견하고, 읽고, 제어하는
셀프호스트 웹 관제면이다.

## 제품 정의

> **tmux가 주인이고 ChatMux는 창문이다.**

사용자는 Gajae Code, Claude Code, Codex, Cursor, OpenCode, Oh My Pi 같은
에이전트를 평소처럼 tmux에서 실행한다. ChatMux는 그 프로세스를 소유권
이관이나 별도 등록 없이 찾아 브라우저와 모바일 웹에 표시한다.

ChatMux가 제공하는 핵심 가치는 다음과 같다.

1. ChatMux 밖에서 시작한 tmux 에이전트를 자동으로 발견한다.
2. 검증된 native transcript가 있으면 구조화된 대화로, 없으면 terminal로 연다.
3. 입력, 재개, 중단, 종료를 정확한 tmux 대상과 프로세스 혈통에만 전달한다.
4. ChatMux가 재시작되거나 종료돼도 tmux 세션은 계속 실행된다.
5. 같은 호스트의 여러 에이전트를 하나의 웹 관제면에서 확인한다.

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

## 현재 기준선

- Gajae Code, Claude Code, Codex, Cursor, OpenCode, Oh My Pi와 SSH tmux
  세션을 자동 발견한다.
- provider-native session store를 인덱싱하고, 연결 가능한 외부 세션을
  구조화된 transcript와 composer로 연다.
- transcript가 없거나 검증되지 않은 세션과 SSH 세션은 terminal로 연다.
- 내장 relay 또는 선택적 control tower를 통해 tmux 입력과 생명주기 작업을
  수행한다.
- Tailscale Serve 또는 SSH tunnel을 통해 loopback 서버에 원격으로 접근한다.

## 범위 밖

다음 항목은 ChatMux의 제품 방향이 아니다.

- ChatMux가 에이전트 작업, durable job, worktree, checkpoint, commit을
  소유하는 실행 오케스트레이터
- 프로젝트 clone, 코드 리뷰, diff, 파일 편집을 중심으로 한 범용 IDE
- Electron 또는 Tauri 기반 데스크톱 앱 확장
- 네이티브 모바일 앱
- provider가 제공하는 CLI, 인증, sandbox, 모델 실행 기능의 재구현

Electron 셸, 데스크톱 패키징, 전용 알림 채널과 원격 target 확장 코드는
2026-07-23 제거를 확정했다. 웹/PWA 외의 전달 표면은 유지하지 않는다.

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

### P1 — pane 단위 identity

현재 session name 중심 모델을 tmux pane 중심 모델로 바꾼다.

- `socket + session_id + window_id + pane_id`를 정규 identity로 사용
- 한 tmux session 안의 여러 agent pane을 각각 표시
- 입력과 terminal attach는 정확한 pane을 대상으로 실행
- agent process 종료, `kill-pane`, `kill-session`을 서로 다른 작업으로 분리
- 기본 종료 작업이 tmux session 전체를 제거하지 않도록 변경
- pane 재사용 시 이전 프로세스 혈통과 generation을 무효화

### P2 — 단일 discovery stream

브라우저마다 `tmux list-panes`와 `ps`를 반복하지 않도록 서버가 하나의
권위 있는 discovery snapshot을 관리한다.

- 서버에서 한 번 수집하고 모든 브라우저에 WebSocket delta 배포
- 재접속 시 전체 snapshot 뒤 순서 있는 변경 이벤트 제공
- 일시적인 scan 실패와 실제 pane 종료를 구분
- 브라우저 수와 무관한 일정한 tmux/프로세스 조회 비용 보장

### P3 — tmux 확장성

- 설정으로 추가할 수 있는 custom agent command/argv 감지
- parser가 없는 agent의 terminal fallback
- `tmux -L`과 `tmux -S`로 실행한 여러 tmux 서버 지원
- socket, pane, 프로세스 혈통, transcript 연결 근거를 보여주는 진단 화면

### P4 — 모바일 웹 관제

- 질문, 완료, 실패 알림
- 짧은 답변과 승인
- interrupt와 안전한 종료
- 네트워크 재연결 후 같은 pane 복구
- 작은 화면의 terminal 입력과 읽기 개선

네이티브 앱을 만들지 않고 반응형 웹과 PWA 범위에서 구현한다.

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
