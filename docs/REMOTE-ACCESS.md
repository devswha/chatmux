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
| 아무것도 없음 / 같은 Wi-Fi면 충분 | 기본 password 모드 (LAN 주소 + QR) | 0개 |
| 없음 + 밖에서도 필요 | `access enable tailscale` | 1개 |
| 도메인 | named tunnel 또는 리버스 프록시 + `access enable password` | 0개 |
| 공유기 권한 + 공인 IP | 포트포워딩 + 무료 DDNS + 자동 HTTPS | 0개 |
| 이미 구축한 메시 VPN | `access enable vpn <address>` (Headscale·NetBird·ZeroTier·Nebula·WireGuard 모두 동일) | 1개 |

CGNAT 환경에서는 포트포워딩이 불가능하므로 Tailscale 또는 도메인 기반 터널만
남는다.

## 5. MVP 반영 항목

이 결론에서 곧바로 도출되는 제품 요구사항은 "단계를 줄이는 것"이 아니라
"단계를 알려주는 것"이다. 5단계 원격 설정은 물리적 하한이며, 사용자가 겪는
실제 마찰은 안내 부재다.

- [x] 설치 기본값을 password + 전체 인터페이스 바인딩으로 고정하고, LAN 주소와
      QR을 출력한다.
- [x] 설치 요약이 Wi-Fi 범위임을 명시하고 밖에서 쓰는 방법을 안내한다.
- [x] **A.** 설치 시 Tailscale이 이미 실행 중이면 `access enable tailscale`을
      안내한다. 탐지 결과는 안내 문구에만 반영하고 설치 결과는 바꾸지 않는다.
- [x] **B.** `access enable tailscale|vpn` 실행 시 설치 때 안내한 LAN 주소가 더
      이상 접속되지 않음을 알린다. (모드 전환으로 loopback 바인딩이 되어 첫 QR이 죽는다)
- [x] **C.** `chatmux status`가 현재 접근 모드와 유효한 접속 주소를 표시한다.
      tailscale 모드는 Serve 주소를, vpn 모드는 unit의 바인딩 주소를, password
      모드는 loopback과 LAN 주소를 보여준다.

## 참고

- 사용자용 설치·접근 안내: [INSTALL.md](INSTALL.md)
- 운영·모드 전환: [SELF-HOST.md](SELF-HOST.md)
- 제품 범위와 우선순위: [ROADMAP.md](ROADMAP.md)
