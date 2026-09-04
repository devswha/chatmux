# 저장소 작업 점검 — 2026-09-04 (UTC)

이 문서는 이번 점검의 근거와 후속 작업을 기록한 시점별 보고서다.
제품 범위와 우선순위의 기준은 계속 [ROADMAP](../docs/ROADMAP.md)이다.

## 점검 범위

- 시작 기준: 원격 `main`의 `7a59d94549f09ad3579a1d274d2abc83b43c7e3f` (v1.8.18).
  원격을 fetch하고 GitHub의 열린 이슈 2개, 열린 PR 3개, 최근 CI와 릴리스를 확인했다.
- 추적 중인 문서 29개를 목록화하고 상대 파일 링크 및 `npm run` 명령 참조를 검사했다.
  제품·Fleet·discovery·승인·설치·업데이트·upstream 계약과 기여·provider 안내를
  구현에 대조했다. 모든 문장과 외부 링크, 모든 소스 파일을 수동 검토한 것은 아니다.
- `server`, `src`, `shared`, `scripts`의 TODO/FIXME/TBD 및 강제 선택·미완료 테스트
  표식을 검색했다. `toolConfigs.ts`의 `TODO TOOLS`는 할 일 도구의 분류 제목이며
  개발 미완료 표식이 아니다.
- 원래 worktree의 기존 미커밋 SSH 등록·DB 작업은 이번 변경에 포함하지 않았다.
  수정과 검증은 `main`에서 분리한 전용 worktree와 PR에서 수행했다.

## 확인한 문제와 처리

| 항목 | 근거 | 처리 |
|---|---|---|
| Codex 구조화 도구 결과가 내부 content-block JSON으로 노출 | #102, `codex-sessions.provider.ts` | 검토 및 최신 main 기준 필수 CI 통과 후 병합 (`1517ec3`) |
| 대용량 도구 출력에서 모바일 렌더링 지연 | #105, `sessions.service.ts`, `MessageComponent.tsx`, `Collapsible.tsx` | 최신 main으로 갱신하고 필수 CI 통과 후 병합 (`cdd5bdb`) |
| 입력창 높이 조절 PR의 Node 22 CI 실패 | #104, run `33860646370`, npm audit HTTP 503 | 감사 서비스를 우회하지 않고 재실행; 최신 main 기준 필수 CI 통과 후 병합 (`2a44ae3`) |
| 종료한 pane을 살아 있다고 판단하는 테스트 정리 경계 | `tests/support/tmux-owned-server.ts`, #107 | 기존 process-state parser로 zombie를 제외하고 실제 fork/waitid 회귀 테스트 추가 |
| npm 취약점 7개 (low 1, moderate 6) | v1.8.18 기준 `npm audit`, #108 | qs 6.16.0, React Router 7.18.3, humanfs/node 0.16.8, selector-parser 6.1.4로 보완; 수정본 감사 0개 |
| SSH 간편 등록 출시 후에도 수동 터널만 허용한다고 설명 | Fleet RFC revision 4 및 #101 대 README·ROADMAP·설치·운영 안내 | #106에서 기존 계약과 일치시킴; 원격 사전 설치·3001 포트·키 설치·비밀번호 미보관·호스트 키 검증 명시 |
| 기여 가이드의 존재하지 않는 backend 디렉터리 | `CONTRIBUTING.md` 대 `server/modules`, `server/shared` | 현재 디렉터리로 정정 |
| provider 목록에서 이미 지원하는 omo 누락 | `process-classification.ts:36`, `list/omo/` 대 ROADMAP·provider README | Oh My OpenAgent를 기존 지원 목록에 추가 |
| upstream 반영 후 수동 changelog 추가를 요구 | `docs/UPSTREAM.md` 대 CONTRIBUTING의 GitHub 생성 릴리스 노트 계약 | PR 및 유일한 release workflow 경로로 정정; 역사 기록은 보존 |

#105의 이전 CI는 sibling rollback에서 `AggregateError`를 기록했다. 그 간헐적
실패는 로컬 350회 반복에서는 재현되지 않았으므로 zombie 결함이 그 실패의
유일한 원인이라고 단정하지 않는다. 별도 실제 프로세스 회귀 테스트에서는
기존 구현의 zombie 오판을 재현하고 수정 후 통과하는 것을 확인했다.

## 남은 제품 개발: P3 세 항목

아래 항목은 미구현 상태를 유지한다. 안전성·기존 버그·검증 복구 다음의 개발
작업이며, 이번 점검으로 완료 처리하지 않는다.

| 다음 작업 | 현재 구현 근거 | 착수 시 필요한 계약과 완료 기준 |
|---|---|---|
| 설정 가능한 custom agent command/argv 감지 | `external-cli-sessions/process-classification.ts`의 `processCliKind`는 고정된 provider 집합을 판별 | 설정 형식·입력 제한·중복 우선순위를 정의. 알려지지 않은 parser는 terminal fallback을 사용하고, command/cwd 일치만으로 session 제어 권한을 만들지 않음. wrapper·모호한 argv·동일 cwd·stale generation을 검증 |
| 여러 tmux 서버 (`-L`, `-S`) discovery | `host-discovery-snapshot.service.ts:223`은 단일 `tmux list-panes`; `shared/tmux.ts`의 identity에는 이미 socket이 있음 | 설정된 socket의 소유권·중복 제거·개별 unavailable/grace 정책을 먼저 정의. 동일 pane ID를 서로 다른 socket에서 구분하고 모든 action boundary에서 해당 socket과 generation 재검증. 한 socket 장애가 다른 서버를 지우지 않음. 브라우저 수와 무관한 수집 비용 유지 |
| identity·lineage·transcript 결합 진단 화면 | ROADMAP P3; 기존 fresh verifier 및 binding grade는 있으나 전용 진단 UI는 없음 | owner 권한과 민감 정보 삭제 계약을 먼저 정의. 결합 등급과 거절 이유를 기존 모델에서 표시하고, 공개 descriptor에 socket·전사 경로·자격 증명을 넣지 않음. 읽기 전용 결과를 제어 자격으로 재사용하지 않음 |

P3 구현에 앞서 관련 [discovery RFC](../docs/P2-DISCOVERY-STREAM-RFC.md)와
[Fleet RFC](../docs/FLEET-FEDERATION-RFC.md)의 범위가 바뀌는 부분은 계약부터
개정한다. 브라우저/서버에 별개의 identity 모델을 추가하지 않는다.

## 열린 이슈의 선행 조건

- **#31 E2E relay:** 현재 ROADMAP과 Fleet RFC는 ChatMux가 운영하는 relay와
  zero-configuration reachability를 범위 밖으로 둔다. 이슈의 릴레이 운영 주체,
  키 수명, replay 방어, 메타데이터 노출, 기존 access 모드와의 결합 결정이 먼저다.
  현 계약 아래에서 구현하거나 완료로 닫지 않는다.
- **#58 Herdr:** #57은 현재 **closed**이며, 그 head
  `98dbba28a2e50efe71d0562be4629c0ae5a23c9a`의 `docs/HERDR-PHASE0.md:3`은
  `CANDIDATE GO pending independent Architect/Critic approval`로 명시한다.
  당시 측정한 v0.7.5/protocol 17은 지금의 호환성 증거를 대신하지 않는다.
  재개 시 최신 대상의 Phase 0 probe, 독립 아키텍처·보안 검토, fingerprint 및
  adversarial evidence 갱신, 전체 검증을 선행해야 한다. 삭제된 로컬/원격
  branch가 보존돼 있다고 가정하지 않고 PR의 정확한 head를 참조한다.

## 검증과 한계

- Zombie 수정: `npm run verify` 통과. 서버 1,448, 실제 tmux/PTY 49,
  클라이언트 521, Rust 29 테스트가 모두 통과했고 skip은 없었다.
  실제 자식 프로세스의 running, stale-generation, zombie, reaped 상태를
  회귀 테스트로 구분했다.
- 의존성 수정: 기존 Express가 해석하는 qs의 실제 parse/stringify 경로에서
  공개 advisory의 `constructor.isBuffer` 입력이 수정 전 TypeError를 만들고
  수정 후 처리되는 것을 확인했다. 라우팅 집중 테스트 43개가 통과했다.
  React Router의 공식 v6→v7 안내와 advisory를 확인했으며, 현재 앱은
  React 18의 선언형 BrowserRouter와 절대 경로를 사용한다. `npm run verify`에서
  서버 1,449, 실제 tmux/PTY 48, 클라이언트 525, Rust 29 테스트 및 감사·타입·lint·
  identity·프로덕션 빌드가 통과했다. 이 검증은 #107이 합쳐지기 전의 독립 브랜치
  결과이며, PR 병합에는 최신 main 기준 CI를 별도로 요구한다.
- `qs` override는 Express 4 및 body-parser의 `~6.15.1` 범위가 수정 버전을
  선택하지 못해 필요하다. 해당 의존성이 비취약 버전을 직접 허용하면 override
  제거 후 감사·라우팅·서버 검증을 다시 수행한다.
- `npm run release:check-metadata`의 로컬 검사는 v1.8.18/schema generation 20에서
  통과했다. 로컬 경고대로 canonical predecessor 파일을 제공한 릴리스 검증을
  대신하지 않는다.
- 첫 격리 worktree의 `npm ci`는 ripgrep binary 다운로드의 HTTP 403으로 실패했다.
  기존 worktree와 lockfile blob이 같음을 확인해 설치된 의존성을 복사하고
  검증했다. 의존성 수정 worktree는 변경된 lockfile에 맞춰 설치했다.
  GitHub CI는 별도로 깨끗한 `npm ci`와 Node 22/24 검증을 실행한다.
- 릴리스급 CUA, 실제 iPhone 실기기, 운영 SSH 계정에 대한 등록/복구,
  릴리스 발행 및 운영 서비스 재시작은 이 점검에서 수행하지 않았다.
  Browser runtime 연결도 시도했으나 사용 가능한 브라우저 목록이 비어 있어
  추가 실브라우저 검증은 수행하지 못했다.
  배포 전 필요한 수동 증거와 남은 P3 기능을 CI 통과로 완료 처리하지 않는다.
