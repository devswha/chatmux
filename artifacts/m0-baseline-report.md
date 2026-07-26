# M0 — verify baseline + failure-domain 인벤토리 (G001) — rev2

기준일: 2026-07-25 · 계획: pending-approval.md §8 M0 (B2 측정 파트) · rev2: architect 리뷰 findings 4건 반영

## 1. 환경 지문

| 항목 | 값 |
|---|---|
| node | v24.18.0 (engines: >=22.22.2 <23 \|\| >=24.15.0 <25 충족) |
| npm | 11.16.0 |
| tmux | 3.2a (설치됨 → tmux e2e 실행됨, skip 아님) |
| bun | 1.3.14 (설치됨) |
| rustc / cargo | 1.85.1 / 1.85.1 |
| OS | Linux 6.8.0-124-generic x86_64 |
| pretest | `build:core:dev` 실행됨 (cargo dev build, 캐시 히트) |
| e2e skip 여부 | 미스킵 — tmux/Bun 존재로 전체 수집 실행 |

## 2. verify 7스텝 상태표

| # | 스텝 | 최초 상태 | 조치 | 최종 상태 |
|---|---|---|---|---|
| 1 | `npm run audit` (--audit-level=high) | **RED** — high 9건(brace-expansion ≤5.0.7 체인: eslint/@eslint/config-array/@eslint/eslintrc/eslint-plugin-react/minimatch 경유 6 지점 + tar/glob 체인) | ① `npm audit fix`(non-breaking: tar, glob/sucrase 체인 해소, 15→11) ② package.json `overrides`: `brace-expansion ^5.0.8`(유일한 비취약 버전) + `minimatch ^10.2.5`(brace-expansion 5.x named-export API 대응 라인; @eslint/config-array@latest도 ^10.2.4 채택). 억제(audit-level 완화/ignore) 0건 | **GREEN** (exit 0; moderate 5건 잔존 — §4) |
| 2 | `tsc --noEmit` ×2 (tsconfig 2개) | GREEN | — | GREEN |
| 3 | `check:core` (cargo fmt --check / clippy -D warnings / test) | GREEN — 14 tests pass | — | GREEN |
| 4 | `npm test` (run-tests.mjs 전량 수집) | GREEN — server 62 files + client 71 tests, fail 0 | — | GREEN (overrides 적용 후 실행) |
| 5 | `npm run lint` | 1차: brace-expansion ^5.0.8 단독 override 시 **CRASH**(minimatch 구버전이 default import 사용) | minimatch ^10.2.5 동반 override로 해소 — minimatch 10 CJS는 named export(`{minimatch,...}`)이며 eslint 스택과 호환 실측 | **GREEN** |
| 6 | `check:identity` | GREEN — 2031 source, 685 generated, 7 archive | — | GREEN |
| 7 | `npm run build` (client+server+core release) | GREEN — vite 3286 modules, tsc+tsc-alias, cargo release | — | GREEN |

주의: 스텝 1·5의 레드는 코드 결함이 아니라 의존성 취약점/override 상호작용이며, 수정은 package.json(+lock)에 국한된다. 소스 변경 0건.

### 2.1 overrides 제거 기준 (exit criterion) [rev2: architect finding 3]

- 두 override는 **임시 dev-toolchain 경계**다. 소유: MS 레인 의존성 갱신 루틴.
- 제거 트리거: 의존성 갱신 주기마다 두 override를 제거한 상태로 `npm install && npm run audit && npm run lint && npm ls --all`을 시험하고, 모든 minimatch 소비자(@eslint/eslintrc, eslint-plugin-react, typescript-eslint 등)가 자력으로 비취약 라인을 해소하면 override를 삭제한다.
- 스테일 방지: override 잔존 상태로 minimatch/brace-expansion의 메이저 의도 차폐가 의심되면 B18/MS 체크포인트에서 재평가.

### 2.2 lockfile 부수 이동 기록 [rev2: architect finding 4]

- `npm audit fix`/`npm install` 재해석 과정에서 무관한 런타임 패키지 `@anthropic-ai/claude-agent-sdk`가 0.3.217 → 0.3.220으로 이동했다(semver 범위 ^0.3.165 내, lockfile만 변경).
- 분리 대신 **문서화 + 별도 검증** 경로 채택: SDK provider 경로는 verify 스텝 4의 서버 테스트로 직접 검증됨 — GjcSdkBridge 계열 11건, connectGjcSdkSession 계열 13건, worker protocol/entrypoint 계열 20+건 전부 그린(0.3.220 기준 실행). 원복(lock 수기 편집)은 lockfile 무결성 리스크가 더 크다고 판단.
- 향후 규칙: 보안 baseline 커밋에서 무관 런타임 이동이 감지되면 커밋 메시지·리포트에 명시한다.

## 3. 그린 baseline 커밋 [rev2: 해시 명시]

- **baseline 커밋: `8699afc9e4317a0ade1587162767a37cf81960a1`** (main, "fix(deps): resolve high-severity audit findings without suppression")
- parent: `b320c7d49ba553752029c524a5d719ebb4557c9a`
- 커밋 내용: `package.json`(overrides 4줄), `package-lock.json`(재해석). 본 리포트는 커밋 외부의 M0 산출물(artifacts/)이다.
- baseline 재현 조건: §1 환경 지문(특히 tmux+Bun 설치, node 24 라인).

## 4. 잔존 취약점 (moderate 5건 — high 게이트 비차단, 인벤토리 기록)

| 패키지 | 심각도 | 경로 | 비차단 사유 / 처분 |
|---|---|---|---|
| @hono/node-server <2.0.5 | moderate | @anthropic-ai/claude-agent-sdk → @modelcontextprotocol/sdk 경유 | 유일 해법이 claude-agent-sdk 0.2.85 다운그레이드(파괴적). Windows 전용 path traversal — 본 제품은 Linux systemd 배포. upstream sdk 갱신 대기, 재검토: 다음 의존성 갱신 주기 |
| react-router 6.x | moderate ×2 | react-router-dom ^6.8.1 | 수정판은 7.17.1+(메이저 점프, M0 범위 밖). M3b 이후 별도 항목으로 승격 검토 |
| (기타 moderate 2건) | moderate | 상동 체인 내 | 상동 |

## 5. Legacy DB fixture 인벤토리 (B18/MS 입력) [rev2: FX-3b/FX-4b/FX-8 추가]

`runMigrations`(server/modules/database/migrations.ts:423-478) 시퀀스가 커버해야 하는 legacy 스키마 세대. **schema version journal 부재 확인**(`schema_version`/`user_version` 검색 0건) — 시퀀스 전체의 atomic boundary 없음, 실패 시 partial upgrade 가능(catch는 re-throw만, :474-476).

| Fixture | 세대 | 검증 대상 마이그레이션 |
|---|---|---|
| FX-1 | users에 git_name/git_email/has_completed_onboarding 부재 | addColumnToTableIfNotExists ×3 (:428-436, ALTER 비트랜잭션) |
| FX-2 | legacy `workspaces`/`workspace_original_paths` 시대 DB | migrateLegacyWorkspaceTableIntoProjects(:83-109) + DROP TABLE workspace_original_paths(:467-470) |
| FX-3 | projects 구 스키마(PK rebuild 이전) | rebuildProjectsTableWithPrimaryKeySchema(:111-236) 전체 rebuild 분기(BEGIN/COMMIT + DROP @227) |
| FX-3b | projects가 **이미 PK 스키마이나 후행 컬럼 부재**(custom_project_name/isStarred/isArchived 결측, project_id NULL/공백 행 존재) | additive 분기(:124-134): ALTER ×3 + project_id UUID 백필(:128-132). rebuild를 타지 않아야 함 |
| FX-4 | sessions 구 스키마(project 스키마 rebuild 이전, legacy session_names) | rebuildSessionsTableWithProjectSchema(:238-383, DROP @374) + migrateLegacySessionNames(:49-81) |
| FX-4b | sessions가 **이미 PK/provider 스키마이나 후행 컬럼 부재**(jsonl_path/isArchived/created_at/updated_at 결측) | additive 분기(:258-267): ALTER ×4 + COALESCE 백필(:263-265). rebuild를 타지 않아야 함 |
| FX-5 | provider_session_id 컬럼 부재 | addProviderSessionIdMapping(:392-402) |
| FX-6 | 현행 스키마 | 재실행 idempotence + 인덱스 생성/드롭(:453-465) 무해성 |
| FX-7 | 각 destructive 단계(DROP @75·227·374·469) 직전 상태 | failure injection 후 재시작 복구 (B18 게이트 3) |
| FX-8 | sessions에 project_path는 있으나 대응 projects 행 부재 | ensureProjectsForSessionPaths(:404-421, 호출 :451): 프로젝트 행 합성 INSERT + ON CONFLICT DO NOTHING — 데이터 보존 assert(중복 생성 0, 기존 행 불변) |

## 6. F1~F5 failure-domain 분류 (전 항목 분류·소유 지정 — 미분류/미지정 0)

| 도메인 | 분류 | 소유 백로그 | 마일스톤 | 근거 |
|---|---|---|---|---|
| F1 DB migration 무결성 | **fix** | **B18** | MS | 본 문서 §5, journal/backup 부재 |
| F2 auth/exposure/WS upgrade | **accept + fix(신규 경로만)** | **B2(M1 파트)** | M1 | 기존 테스트 존재(auth.test.js, exposure-guard.test.js); 신규 typed /shell·/actions에 auth matrix 필수 |
| F3 self-update/deploy | **freeze + smoke** | **B1 부수** | M2 | deploy.sh --dry-run + 재시작 후 tmux 생존; CI는 dry-run만, 전체 경로는 수동 리허설 |
| F4 plugin loader | **freeze + trusted-only 문서화** (Q5 기본값, 사용자 동결 수용 확인) | **B19** | MS | permissions는 metadata일 뿐 enforcement 아님; install/update/start smoke 3종 |
| F5 voice proxy | **freeze + smoke** (Q6 기본값, 사용자 동결 수용 확인) | **B20** | MS | smoke 5종 + secret 미노출 테스트 |

## 7. M0 게이트 자기판정

- [x] verify 7스텝 상태표 + 환경 지문
- [x] 그린 baseline 커밋 지정 (8699afc9e4317a0ade1587162767a37cf81960a1)
- [x] legacy DB fixture 인벤토리 (FX-1~FX-8, additive 분기 포함)
- [x] F1~F5 분류 + 소유 백로그 지정 (미분류·미지정 0)
- [x] 억제 0건 (audit-level 유지, lint/test skip 0, clippy -D warnings 유지)
- [x] 실행(fixture/smoke 구현) 미포함 — inventory-only 준수
- [x] rev2: architect findings 4건 반영 (§2.1 overrides exit criterion, §2.2 lockfile 부수 이동, §3 해시 명시, §5 FX-3b/4b/8)
