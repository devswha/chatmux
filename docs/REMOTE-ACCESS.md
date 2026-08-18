# 원격 접근 설계 결정

기준일: 2026-07-27

이 문서는 "폰에서 에이전트를 보려면 무엇이 필요한가"에 대한 조사 결과와
ChatMux가 내린 결정을 기록한다. 결론은 한 줄로 요약된다.

> **앱 설치 없이, 준비물 없이, 어디서나 접속하는 방법은 존재하지 않는다.**
> 누군가는 공인 IP를 가진 장비를 운영해야 하고, 그 비용은 사용자·우리·제3자
> 중 하나가 낸다. ChatMux는 제3자(사용자가 고른 터널/VPN)에 얹고, 우리는
> 아무것도 호스팅하지 않는다.

## 1. 물리적 제약

### 1.1 브라우저는 VPN이 될 수 없다

Tailscale·WireGuard·ZeroTier 같은 메시 VPN은 기기 안에 **가상 네트워크
인터페이스**를 만들어야 동작한다. 인터페이스 생성은 OS 권한이고 브라우저는
이를 수행할 수 없다. 따라서 VPN 계열 경로는 **폰 앱이 필수**이며 우회 방법이
없다. 이것은 Tailscale의 제약이 아니라 VPN이라는 방식 자체의 조건이다.

### 1.2 앱을 피하면 서버가 인터넷에 노출된다

폰에 아무것도 설치하지 않으려면 서버가 공개 주소를 가져야 한다. 즉 선택지는
두 개뿐이고 어느 쪽이든 비용을 지불한다.

| 방식 | 폰 | 서버 |
|---|---|---|
| VPN (Tailscale/WireGuard 등) | 앱 필요 | 인터넷에 보이지 않음 |
| 공개 (터널/포트포워딩) | 브라우저만 | 인터넷에 노출, 로그인이 유일한 방어선 |

### 1.3 password 모드와 tailscale 모드는 배타적이다

`server/tailscale-auth.ts`는 loopback이 아닌 출처의 요청을 무조건 거부한다.

```js
const remoteAddress = request.socket?.remoteAddress;
if (!isLoopbackAddress(remoteAddress)) return null;
```

따라서 "LAN에는 비밀번호, tailnet에는 신원"을 동시에 제공할 수 없다.
`CHATMUX_AUTH`가 프로세스 전역 단일 값인 것과 합쳐져, 모드 전환 명령
(`chatmux access enable ...`)은 제거할 수 없는 단계다.

## 2. 무계정 터널을 채택하지 않는 이유

Cloudflare Quick Tunnel(TryCloudflare)은 계정·도메인 없이 공개 HTTPS 주소를
주지만 상시 사용에는 부적합하다. 실측과 공식 문서로 확인한 사유는 다음과 같다.

- **주소가 프로세스 재시작마다 바뀐다.** 동일 호스트에서 재현한 결과
  `ought-examine-ringtones-smoking.trycloudflare.com` → 재시작 후
  `gives-female-seem-enjoyed.trycloudflare.com`으로 변경되고 이전 주소는
  HTTP 530으로 죽었다. 서버 재부팅·크래시·서비스 재시작이 모두 트리거다.
- **주소가 바뀌면 세션·PWA·푸시가 함께 죽는다.** 인증 쿠키는 host 전용이고,
  홈화면 설치와 푸시 구독은 origin 단위다. 즉 재부팅 한 번에 모든 기기가
  재로그인 대상이 되고 설치된 PWA는 죽은 링크가 된다.
- **SSE를 지원하지 않는다.** Cloudflare 문서는 Quick Tunnel 한정으로 SSE
  미지원과 동시 요청 200개 제한을 명시한다. ChatMux는 대화 검색, 커맨드
  팔레트 검색, 프로젝트 clone 진행률에서 SSE를 사용하므로 조용히 고장난다.

고정 주소가 필요하면 계정과 도메인을 가진 named tunnel을 쓴다. 이 경우 위
제약은 모두 사라진다.

## 3. 경쟁 제품은 모두 같은 결론에 도달했다

| 제품 | 원격 도달성 해법 (출처: 각 제품 공식 문서) |
|---|---|
| **Orca** (30k★, YC) | "Easiest setup: install Orca and **Tailscale** on both computers." 모바일은 전용 앱, "there is **no cloud relay**", "Orca does **not** sell managed VPS hosting" |
| **Moshi** (iOS/Android) | 전용 문서 페이지 **Tailscale**: "Reach Macs and Linux hosts with **no public IP** through your tailnet" |
| **mosh** | "Mosh doesn't listen on network ports... The mosh client logs in to the server **via SSH**" — SSH 도달성이 전제 |
| **et.rs** (EternalTerminal) | `sudo systemctl enable --now et` — "**and open 2022/tcp in your firewall**" |

즉 **터미널·에이전트 앱은 원격 도달성을 제공하지 않는다.** 전부 사용자에게
넘기고 Tailscale 또는 포트 개방을 안내한다. 이 병목은 ChatMux의 설계 결함이
아니라 카테고리 전체의 조건이다.

특히 Moshi 사용자는 앱을 **두 개**(Moshi + Tailscale) 설치해야 한다. ChatMux는
최대 한 개(Tailscale)이고, LAN이나 도메인 경로에서는 **0개**다.

## 4. ChatMux의 결정

### 4.1 하지 않는 것

- **릴레이 서버를 운영하지 않는다.** 서버비·운영·남용 대응이 영구 비용으로
  발생하고, TLS를 우리 엣지에서 종료해야 하므로 원리상 트래픽을 볼 수 있게
  된다. 셸 접근 도구에서 이는 받아들일 수 없는 신뢰 요구이며 "self-hosted,
  no cloud relay" 약속과 충돌한다.
- **자체 모바일 앱을 만들지 않는다.** 병목이 "Tailscale 앱"에서 "ChatMux 앱"으로
  옮겨갈 뿐이고, 앱스토어 심사·계정 시스템·시그널링 인프라가 함께 딸려온다.
- **네이티브 알림 경쟁을 하지 않는다.** Live Activity·Apple Watch 승인은 웹으로
  따라갈 수 없다. 그 축은 네이티브 앱 제품의 영역이다.
- **설치 시 자동으로 원격 모드를 켜지 않는다.** 머신 상태에 따라 설치 결과가
  달라지면 예측 가능성이 사라지고, 다른 용도로 Tailscale을 쓰던 사용자가
  갑자기 LAN 접근을 잃는다.

### 4.2 우리의 축

> **설치는 서버에 한 번, 접속은 아무 기기 브라우저로.
> 그리고 화면이 터미널이 아니라 에이전트를 이해한다.**

- 폰에 설치할 것이 없다 (경쟁 제품 대비 앱 1개 적음)
- 폰·태블릿·데스크톱·회사 PC 등 기기를 가리지 않는다
- transcript를 직접 읽으므로 에이전트마다 hook을 심을 필요가 없다

### 4.3 사용자가 가진 것에 따른 경로

| 사용자가 이미 가진 것 | 권장 경로 | 폰 앱 |
|---|---|---|
| Tailscale 실행·로그인됨 | 자동 Tailscale Serve (HTTPS 주소 + QR, 앱 비밀번호 없음) | 1개; QR 스캔 전 켜고 사용 중 연결 유지 |
| 아무것도 없음 / 같은 Wi-Fi면 충분 | 자동 password 모드 (LAN 주소 + QR) | 0개 |
| 도메인 | named tunnel 또는 리버스 프록시 + `access enable password` | 0개 |
| 공유기 권한 + 공인 IP | 포트포워딩 + 무료 DDNS + 자동 HTTPS | 0개 |
| 이미 구축한 다른 메시 VPN | `access enable vpn <address>` (Headscale·NetBird·ZeroTier·Nebula·WireGuard 모두 동일) | 1개 |

CGNAT 환경에서는 포트포워딩이 불가능하므로 Tailscale 또는 도메인 기반 터널만
남는다.

도메인 행의 named tunnel은 §2에서 탈락시킨 Quick Tunnel(TryCloudflare)과
다르다. 계정과 고정 도메인이 있으면 재시작에도 주소가 유지되고 SSE 제한도
없으므로, 폰에 앱을 설치할 수 없고 Tailscale도 쓸 수 없는 경우의 상시 원격
경로다. 대신 터널 업체 엣지에서 TLS가 종료되므로 그 업체를 신뢰해야 하고,
로그인 비밀번호는 반드시 그 HTTPS 위로만 보낸다.

## 5. MVP 반영 항목

이 결론에서 곧바로 도출되는 제품 요구사항은 "단계를 줄이는 것"이 아니라
"단계를 알려주는 것"이다. 5단계 원격 설정은 물리적 하한이며, 사용자가 겪는
실제 마찰은 안내 부재다.

- [x] 설치 시 Tailscale이 실행·로그인되어 있으면 Serve HTTPS를 자동 구성하고 해당
      주소와 QR을 출력한다. ChatMux 아이디·비밀번호는 만들지 않고 Tailscale identity와
      allowlist를 인증 경계로 사용한다.
- [x] Tailscale 설치 결과에 폰에서도 QR 스캔 전에 Tailscale을 켜고, ChatMux 사용 중
      연결을 유지해야 한다고 명시한다.
- [x] Tailscale이 준비되지 않은 경우 password + 전체 인터페이스 바인딩으로 폴백하고,
      LAN 주소·QR·일회용 비밀번호를 출력한다.
- [x] `access enable tailscale|vpn` 실행 시 기존 LAN 주소가 더 이상 접속되지 않음을
      알린다.
- [x] **C.** `chatmux status`가 현재 접근 모드와 유효한 접속 주소를 표시한다.
      tailscale 모드는 Serve 주소를, vpn 모드는 unit의 바인딩 주소를, password
      모드는 loopback과 LAN 주소를 보여준다.

## 6. 모바일 화면과 서버 업데이트는 별개다

**`새 화면 적용`**은 설치된 PWA의 화면 버전이 서버 `/health.version`보다 오래된
경우에만 서비스 워커를 활성화하고 한 번 새로고침한다. 서버 파일·서비스·릴리스에는
전혀 영향을 주지 않는다. 반대로 **`서버 업데이트`**는 서버가 확인한 업데이트를
배포하는 동작이며, Tailscale owner, password 모드의 설치 계정, 또는 즉시 loopback에서
검증된 로컬 owner만 실행할 수 있다. allowlist에 든 일반 Tailscale 사용자는 접속은
가능하지만 배포 권한은 없다.

Tailscale 경로에서는 폰에서 Tailscale을 켠 뒤 QR을 스캔하고 ChatMux를 사용하는 동안
계속 연결해야 한다. Tailscale이 없으면 password/LAN 또는 loopback+SSH 터널을
사용한다. SSH와 터미널의 `install.sh`은 최초 bootstrap·수동 복구용일 뿐, 일반적인
모바일 업데이트 경로가 아니다.

릴리스 설치에서 서버만 GitHub Release의
`chatmux-server-<version>-linux-x64-node22.tar.gz`, 같은 basename의 `.sha256`, 그리고
별도 root `install.sh`이라는 정본 계약을 해석한다. 업데이트 worker는 archive와
checksum만 받아 검증하며 `install.sh`을 내려받거나 실행하지 않는다. source 설치는
`origin/main`과 `deploy.sh`의 moving-main 의미를 유지하므로 정확한 release 버전을
주장하지 않는다.

worker는 user-systemd에서 분리되어 staged 검증 후 `current` 심볼릭 링크를 원자적으로
교체하고, HTTP 200·예상된 ChatMux product/status health field·새 boot ID·정확한 target version을 확인한다. DB
자동 백업/복원은 없다. target의 `database.rollbackCompatibleFrom`이 실행 중인 정확한
버전을 명시하고 CI가 호환성을 증명한 경우만 자동 rollback하며, 그 외는
`manual_required`다. 상태와 보존된 job은 owner의 status/job API 및
`journalctl --user -u chatmux.service`에서 확인한다. `failed_rolled_back`은 이전
릴리스 health까지 복구된 경우이고, `failed_rollback`은 수동 복구가 필요함을 뜻한다.

`~/.chatmux`는 owner 소유 mode `0700`의 실제 디렉터리여야 한다. symlink, 다른 owner,
비디렉터리, 경로 교체는 업데이트 전 hard stop이다. 운영자는 링크를 따라가거나 모바일
재시도를 하지 말고, 의도한 사용자로 경로와 소유권을 조사·복구한 뒤 수동 절차를
사용한다. 첫 updater-capable release는 이 수동 bootstrap이 필요하며 이후 호환
릴리스만 모바일에서 업데이트할 수 있다.
## 7. 세션 완료 벨 (per-session push)

세션 행의 벨은 tmux pane이나 에이전트 프로세스가 끝났다는 알림이 아니다. 감시를
켜 둔 세션에서 에이전트의 **응답/턴이 준비되어 다음 사용자 입력을 기다릴 때**만
`reply_ready` 알림을 보낸다. 도구 호출 중, 실패, pane 종료, 프로세스 종료는 완료
벨의 조건이 아니다.

### 7.1 먼저 필요한 접속 조건

Push와 Service Worker는 secure context에서만 동작한다. HTTP LAN 주소, IP 주소의
평문 HTTP, 그리고 HTTP 포트포워딩으로 연 화면에서는 벨을 설정할 수 없다. 다음 중
하나의 **HTTPS origin**으로 ChatMux를 열어야 한다.

- TLS를 종료하는 리버스 프록시 또는 named tunnel의 고정 HTTPS 주소
- tailnet에서 HTTPS를 제공하는 **Tailscale Serve** 주소

Tailscale 앱으로 네트워크에만 접속한 뒤 HTTP 주소를 여는 것은 충분하지 않다.
주소가 바뀌는 Quick Tunnel도 origin 단위인 PWA/Push 등록용으로 쓰지 않는다
([2절](#2-무계정-터널을-채택하지-않는-이유) 참조).
HTTPS origin(스킴·호스트·포트)이 바뀌면 이전 origin에 묶인 PWA, Service Worker,
Push 등록은 새 주소에서 유효하지 않다. 새 HTTPS origin에서 PWA를 다시 설치하고,
현재 기기의 등록이 없거나 폐기되었으면 렌치로 복구한다. 이 복구는 소유자의 감시
의도를 끄지 않는다.

지원되는 클라이언트는 Chromium 데스크톱과 Android의 **설치된 PWA**다. iPhone과
iPad는 iOS/iPadOS 16.4 이상에서만 지원하며, 역시 홈 화면에 설치한 PWA여야 한다.
iOS/iPadOS에서는 Safari 등의 일반 브라우저 탭에서 ChatMux HTTPS 주소를 연 뒤
공유 메뉴의 **홈 화면에 추가**로 설치하고, 이후 홈 화면 아이콘으로 열어 설정한다.
브라우저 탭만 열어 둔 상태를 설치된 PWA로 간주하지 않는다.

### 7.2 설정과 벨의 의미

1. 위 HTTPS 주소에서 설치된 PWA를 열고, 알림을 받을 **해당 세션 행의 벨을
   직접 클릭**한다.
2. 그 클릭이 브라우저 권한 요청과 이 기기의 Push 등록을 시작한다. 페이지 열기,
   로그인, 원격 접속, 세션 생성은 권한을 요청하거나 감시를 자동으로 켜지 않는다.
3. 벨이 켜진 세션만 그 소유자에게 `reply_ready`를 fanout한다. 같은 소유자가
   등록한 모든 기기로 전달되므로, 한 세션을 여러 기기에서 켜거나 끌 필요는 없다.
   다른 사용자에게는 전달되지 않는다.

감시(watch), 기기 등록, 전역 일시는 서로 다른 상태다.

- **소유자 감시**는 세션별 의도다. 이 소유자의 **벨만** 감시 의도를 바꾼다.
  꺼진 벨은 감시를 켜고, 켜진 벨은 감시를 끈다. 벨은 기기 복구 수단이 아니다.
- **기기 복구**(렌치)는 현재 기기의 권한/Service Worker/Push endpoint가 없거나
  폐기되었을 때 이를 다시 등록한다. 소유자가 이미 켜 둔 감시 의도는 바꾸지 않는다.
  새 기기나 HTTPS origin을 바꾼 뒤에는 새 origin의 PWA를 설치한 후 렌치로 이
  기기를 복구한다.
- **전역 일시**는 소유자 전체의 발송을 멈춘 상태다. 세션 벨을 끄는 동작도,
  기기 복구도 이를 해제하지 않는다. 전역 일시를 해제한 뒤 기존 감시는 그대로
  다시 전달 대상이 된다.

### 7.3 보이는 행과 범위

- 일반 대화 행은 OMP를 제외한 지원 provider에서 벨을 표시한다. **일반 OMP
  대화에는 벨이 없다.**
- 외부 tmux 행은 실행 중인 Claude Code, Codex, OpenCode, OMP generation에만
  표시한다. SSH/일반 shell 행과 **외부 Cursor 행에는 벨이 없다.**
- archived 목록과 restore 흐름은 완료 벨의 범위 밖이다. 아카이브/복원이 감시를
  만들거나 자동으로 켜지지 않으며, 복원한 활성 행에서 필요하면 다시 설정한다.

### 7.4 막힘과 복구

- **권한 거부**: 운영체제 또는 브라우저 사이트 설정에서 이 HTTPS origin의 알림
  권한을 허용한 뒤 PWA를 다시 연다. 감시가 꺼져 있으면 소유자 벨로 감시를 켜고,
  이미 켜져 있으면 렌치로 이 기기를 복구한다.
- **보안 연결 오류**: HTTPS origin으로 다시 열고, Tailscale 경로라면 Serve의 HTTPS
  주소인지 확인한다. HTTP 주소에서는 복구할 수 없다.
- **HTTPS origin 변경**: 이전 주소의 PWA, Service Worker, Push 등록은 새 주소에
  사용할 수 없다. 새 HTTPS origin에서 PWA를 다시 설치한 뒤, 현재 기기의 등록이
  없거나 폐기되었으면 렌치로 복구한다.
- **설치 필요(iOS/iPadOS)**: 브라우저 탭이 아니라 홈 화면 PWA로 열어 위 설치
  절차를 마친다.
- **등록/전송 오류, 폐기된 등록 또는 기기 변경**: 켜진 벨이 렌치로 보이면 렌치를
  클릭해 이 기기만 복구한다. 이 동작은 소유자 감시를 끄지 않는다. 계속 실패하면
  브라우저의 사이트 데이터·알림 차단, Service Worker, 네트워크를 확인한 뒤 PWA를
  다시 열어 재시도한다.

이 안내는 현재 제품 범위와 원격 origin 요구사항을 설명할 뿐, 릴레이·배포·릴리스가
수행되었음을 뜻하지 않는다.

## 참고

- 사용자용 설치·접근 안내: [INSTALL.md](INSTALL.md)
- 운영·모드 전환: [SELF-HOST.md](SELF-HOST.md)
- 제품 범위와 우선순위: [ROADMAP.md](ROADMAP.md)
