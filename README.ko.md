<div align="center">
  <img src="public/logo.png" alt="Gajae App" width="96" height="96">
  <h1>Gajae App</h1>
  <p>하나의 자체 호스팅 웹 및 데스크톱 작업 공간에서 Gajae Code(GJC), Claude Code, Cursor, Codex, OpenCode를 실행하세요.</p>
</div>

<p align="center">
  <a href="#quick-start">빠른 시작</a> ·
  <a href="#first-run">첫 실행</a> ·
  <a href="#daily-workflow">일상 워크플로</a> ·
  <a href="docs/INSTALL.md">프로덕션 설치</a> ·
  <a href="https://github.com/devswha/gajae-app/issues">이슈</a>
</p>

<div align="right"><i><a href="./README.md">English</a> · <b>한국어</b> · <a href="./README.ja.md">日本語</a> · <a href="./README.de.md">Deutsch</a> · <a href="./README.ru.md">Русский</a> · <a href="./README.tr.md">Türkçe</a> · <a href="./README.zh-CN.md">简体中文</a> · <a href="./README.zh-TW.md">繁體中文</a></i></div>

## Gajae App의 기능

Gajae App은 자체 머신 또는 서버에서 실행되는 코딩 에이전트를 위한 단일 사용자 제어 화면입니다. 프로젝트 및 세션 탐색, 스트리밍 채팅, 승인 처리, 파일 브라우저와 편집기, 실시간 CLI 표시, 알림, 스킬, MCP 구성, 원격 데스크톱 대상을 결합합니다.

앱에는 모델 구독이 포함되지 않습니다. 사용하려는 모든 에이전트 CLI를 Gajae App을 실행하는 동일한 호스트 및 동일한 운영체제 사용자 아래에 설치하고 인증하세요.

### 지원 에이전트

- **Gajae Code (GJC)**
- **Claude Code**
- **Cursor**
- **Codex**
- **OpenCode**

공급자별 모델, 노력 제어, 권한 모드, 세션 기록, 스킬 및 MCP 기능은 해당 공급자가 지원할 때만 표시됩니다.

<a id="quick-start"></a>
## 빠른 시작

### 요구 사항

- Node.js 22.22.2 이상(22.x) 또는 24.15.0 이상(24.x)
- 소스 개발용 rustup 및 Rust 1.85.1(릴리스 아티팩트에는 네이티브 코어 포함)
- npm 및 Git
- 이미 설치하고 인증한 지원 에이전트 CLI 최소 하나

### 소스에서 웹 앱 시작

```bash
git clone https://github.com/devswha/gajae-app.git
cd gajae-app
npm ci
npm run dev
```

<http://127.0.0.1:5173>을 여세요. 개발 백엔드는 `127.0.0.1:3001`에서 수신합니다.

### 개발 환경에서 데스크톱 앱 시작

웹 스택을 계속 실행한 채 두 번째 터미널에서 Electron을 시작하세요.

터미널 1:

```bash
npm run dev
```

터미널 2:

```bash
npm run desktop:dev
```

<a id="first-run"></a>
## 첫 실행

1. **소유자 계정을 만드세요.** Gajae App을 열고 유일한 로컬 애플리케이션 계정을 만드세요. 사용자 이름은 3자 이상, 비밀번호는 6자 이상이어야 합니다.
2. **Git ID를 설정하세요.** 이 호스트에서 만드는 커밋에 사용할 이름과 이메일을 입력하세요. 이는 전역 Git `user.name` 및 `user.email`을 기록하며 GitHub 로그인은 필요하지 않습니다.
3. **코딩 에이전트를 연결하세요.** 온보딩 중 사용 가능한 공급자 로그인 흐름을 완료하거나 건너뛰고 나중에 **Settings → Agents**를 사용하세요. 호스트 수준 CLI 인증이 신뢰의 원천으로 유지됩니다.
4. **프로젝트를 추가하세요.** 사이드바의 프로젝트 작업을 사용하여 기존 디렉터리를 선택하거나 작업 공간을 생성/복제하세요. 경로는 브라우저를 표시하는 장치가 아니라 서버를 실행하는 머신을 가리킵니다.
5. **세션을 시작하세요.** 프로젝트를 선택하고 사용 가능한 공급자를 고른 다음, 공급자가 지원하는 모델과 권한 제어를 조정하고 첫 프롬프트를 보내세요.

<a id="daily-workflow"></a>
## 일상 워크플로

### 프로젝트 및 세션

- 절대 경로로 로컬 작업 공간을 추가하거나 프로젝트 마법사를 통해 Git 저장소를 복제하세요.
- HTTPS 복제에 필요한 경우에만 **Settings → API & Credentials**에 GitHub 토큰을 저장하세요. SSH URL은 서버 사용자의 SSH 구성을 사용합니다.
- 사이드바에서 프로젝트를 펼쳐 색인된 세션을 재개하세요. Gajae App은 지원 공급자의 세션 저장소를 읽고 공급자 ID를 분리해 유지합니다.
- 선택한 프로젝트에서 새 채팅을 시작하세요. 실행을 중지하면 활성 에이전트 프로세스만 중지되며 프로젝트나 기록은 삭제되지 않습니다.

### 채팅 및 승인

- 텍스트, 이미지 첨부 파일, 파일 멘션 및 공급자가 지원하는 슬래시 명령을 보내세요.
- 무제한 실행을 무조건 활성화하는 대신 채팅에서 도구 호출을 검토하고 권한 요청에 응답하세요.
- 모델, 노력, 사고 및 권한 제어는 선택한 공급자가 제공하는 경우에만 사용하세요.
- 사이드바에서 이전 세션을 재개하세요. 세션 이름은 공급자 고유 세션 식별자를 변경하지 않고 편집할 수 있습니다.

### 파일

Files 패널을 열어 구성된 작업 공간 루트를 탐색하고, 이미지와 Markdown을 미리 보고, 텍스트 파일을 편집하고, 폴더를 만들고, 파일을 업로드하세요. 파일 접근은 검증된 프로젝트 경로로 제한되며 심볼릭 링크 및 경로 순회 이탈은 거부됩니다.

### 실시간 CLI 세션

Gajae App은 이미 `tmux` 아래에서 실행 중인 지원 에이전트 세션을 표시할 수 있습니다. 실시간 행은 tmux 세션 이름을 사용하고 터미널 기반 보기로 열리며, 웹 서버가 아닌 tmux가 소유권을 유지합니다. 서버를 재시작해도 이러한 외부 세션은 종료되지 않아야 합니다.

### 알림

**Settings → Notifications**에서 브라우저 또는 데스크톱 알림을 활성화하세요. 실행 완료, 오류, 권한 필요 및 지원되는 실시간 턴 이벤트에는 각각 별도 제어가 있어 시끄러운 항목을 독립적으로 비활성화할 수 있습니다.

## 원격 사용

서버는 기본적으로 루프백에 바인딩됩니다. 다른 장치에서는 이 바인딩을 유지하고 신뢰할 수 있는 VPN 또는 SSH 터널을 사용하세요.

```bash
ssh -N -L 3001:127.0.0.1:3001 user@server
```

그런 다음 로컬에서 <http://127.0.0.1:3001>을 여세요. 포트 3001을 공용 인터넷에 직접 노출하지 마세요.

Electron 앱은 원격 Gajae App 서버를 등록할 수 있습니다. 원격 대상에는 HTTPS가 필요하며 일반 HTTP는 정확한 루프백 오리진에만 허용됩니다. 각 로컬 또는 원격 대상은 쿠키와 저장소를 공유하지 않도록 격리된 Electron 세션 파티션을 사용합니다.

## 프로덕션 설치

프로덕션은 glibc 2.35 이상, Node.js 22.22.2 이상(22.x) 및 사용자 수준 systemd 서비스를 사용하는 Linux x86_64에서 지원됩니다.

[GitHub Releases](https://github.com/devswha/gajae-app/releases)의 불변 `gajae-app-server-<version>-linux-x64-node22.tar.gz` 아티팩트를 사용하세요. 지원되는 설치는 다음을 충족해야 합니다.

1. 고정된 버전과 일치하는 `.sha256` 파일을 다운로드합니다.
2. 압축을 풀기 전에 체크섬을 검증합니다.
3. `~/.gajae-app/releases/<version>` 아래에 압축을 풉니다.
4. `~/.gajae-app/current`이 해당 릴리스를 가리키게 합니다.
5. `gajae-app.service`를 사용자 서비스로 실행하고 `http://127.0.0.1:3001/health`를 검증합니다.

정확한 최초 설치 명령은 [docs/INSTALL.md](docs/INSTALL.md)를, 서비스 운영, 업그레이드, 원격 액세스, 롤백 및 제거는 [docs/SELF-HOST.md](docs/SELF-HOST.md)를 따르세요. 변경 가능한 `latest` URL, 패키지 레지스트리 사본, 컨테이너 이미지 또는 검증하지 않은 소스 빌드를 프로덕션 서버로 배포하지 마세요.

## 문제 해결

| 증상 | 확인 사항 |
|---|---|
| 공급자를 사용할 수 없음 | 해당 CLI가 설치 및 인증되어 있고 Gajae App을 실행하는 사용자의 `PATH`에서 보이는지 확인한 뒤 **Settings → Agents**를 다시 확인하세요. |
| 프로젝트 경로가 거부됨 | 서버 호스트에 존재하고 서버 사용자가 접근할 수 있는 절대 경로를 입력하세요. |
| Electron 개발 환경에서 빈 페이지 또는 실패 페이지가 열림 | `npm run desktop:dev`를 실행하기 전에 `npm run dev`를 계속 활성 상태로 두세요. |
| 서비스가 시작되지 않음 | `systemctl --user status gajae-app.service` 및 `journalctl --user -u gajae-app.service -f`를 실행하세요. |
| 원격 액세스 실패 | 먼저 로컬 `/health` 엔드포인트를 확인한 다음 SSH/VPN 경로 또는 등록된 HTTPS 오리진을 검증하세요. |
| 로그인 후에도 이전 자격 증명이 계속 유효하지 않음 | **Settings → Agents**에서 공급자를 다시 연결하고 서비스 사용자 아래에서 CLI를 직접 확인하세요. |

## 개발 명령

| 명령 | 용도 |
|---|---|
| `npm run dev` | Vite 클라이언트와 개발 백엔드 시작 |
| `npm run server:dev` | 개발 백엔드만 시작 |
| `npm run client` | Vite 클라이언트만 시작 |
| `npm run desktop:dev` | 개발 클라이언트에 연결된 Electron 시작 |
| `npm test` | 서버, 클라이언트 및 Electron 테스트 실행 |
| `npm run typecheck` | 클라이언트와 서버 타입 검사 |
| `npm run lint` | 제품 및 도구 코드 전체에서 ESLint 실행 |
| `npm run check:identity` | 제품, 법적 및 출처 ID 규칙 검증 |
| `npm run build` | 프로덕션 클라이언트와 서버 빌드 |
| `npm run verify` | 전체 릴리스 게이트 실행 |

Node.js 22.22.2 이상(22.x) 또는 24.15.0 이상(24.x)을 사용하고 변경 사항을 제출하기 전에 전체 게이트를 실행하세요.

```bash
npm run verify
```

이는 의존성 감사, 타입 검사, 모든 테스트 파티션, 린트, ID 검증 및 프로덕션 빌드를 실행합니다.

## 보안 및 데이터 경계

- 웹 인증은 영구 로그아웃 취소 기능이 있는 `HttpOnly`, `SameSite=Strict` 쿠키를 사용합니다.
- 자격 증명은 URL 쿼리 매개변수에서 받지 않습니다. 외부 에이전트 API 키는 `X-API-Key` 헤더를 사용합니다.
- 프로젝트 파일은 정규 경로 및 심볼릭 링크 검사를 통해 확인되며 쓰기는 동일 디렉터리의 원자적 교체를 사용합니다.
- 업로드는 완료 또는 실패 후 정리되는 요청별 비공개 임시 디렉터리를 사용합니다.
- Electron은 기본적으로 대상 권한을 거부하고 IPC를 등록된 런처 프레임으로 제한합니다.
- 업그레이드 또는 호스트 마이그레이션 전에 `~/.gajae-app/data`를 백업하세요. 릴리스 전환은 이 디렉터리를 보존해야 합니다.

## 프로젝트 정보

- [프로덕션 설치](docs/INSTALL.md)
- [자체 호스팅 및 롤백](docs/SELF-HOST.md)
- [업스트림 출처 및 선택적 도입](docs/UPSTREAM.md)
- [기여](CONTRIBUTING.md)
- [이슈 트래커](https://github.com/devswha/gajae-app/issues)

<!-- upstream-lineage:start -->
Upstream lineage: Gajae App is derived from [CloudCLI UI](https://github.com/siteboon/claudecodeui). Required attribution and license terms are preserved in [LICENSE](LICENSE) and [NOTICE](NOTICE).
<!-- upstream-lineage:end -->

## 라이선스

[GNU AGPL v3](LICENSE)
