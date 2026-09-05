# 모바일에서 ChatMux 사용하기

<p align="center"><a href="mobile_eng.md">English</a> · <b>한국어</b></p>

ChatMux는 별도의 모바일 앱 없이 브라우저에서 바로 사용할 수 있습니다. 자주 사용할
경우에는 같은 페이지를 PWA로 설치하면 홈 화면 아이콘, 전체 화면 UI, 세션 알림을
사용할 수 있습니다.

## 브라우저와 설치형 PWA 비교

| 방식 | 장점 | 제한 |
|---|---|---|
| 모바일 브라우저 | 링크만 열면 바로 사용 가능 | iOS/iPadOS에서는 푸시 알림을 사용할 수 없음 |
| 설치형 PWA | 홈 화면 실행, 전체 화면 UI, 세션별 푸시 알림 지원 | HTTPS 주소에서 기기별로 한 번 설치해야 함 |

대화와 터미널 제어 기능은 두 방식에서 동일합니다. Android의 지원 브라우저에서는
설치하지 않아도 HTTPS 페이지에서 알림을 설정할 수 있지만, 안정적인 앱 형태로
사용하려면 PWA 설치를 권장합니다. iPhone과 iPad의 푸시 알림은 홈 화면에 설치한
PWA에서만 사용할 수 있습니다.

## 1. PC에서 접속 링크 확인

ChatMux가 설치된 PC에서 다음 명령을 실행합니다.

```bash
chatmux status
```

출력의 `Access` 항목에서 `Open` 주소를 확인합니다.

```text
Access:
  Mode: tailscale — tailnet identity, no password
  Open: https://my-pc.example-tailnet.ts.net:8443
```

설치할 때 표시된 QR 코드를 스캔해도 됩니다. `localhost` 또는 `127.0.0.1` 주소는
ChatMux가 설치된 PC에서만 열리므로 휴대폰에서는 사용할 수 없습니다.

각 PC는 별도의 ChatMux 서버입니다. [Multi-PC fleet](INSTALL.md#create-a-multi-pc-fleet)을
구성하면 소유자는 hub의 HTTPS 주소에서 PWA 하나를 설치해 hub와 등록된 최대
아홉 peer를 함께 사용할 수 있습니다. peer마다 PWA를 따로 설치하는 것은 선택입니다.
hub나 peer 연결에 문제가 생겼을 때 직접 복구할 수 있도록 각 PC의 `chatmux status`
주소를 보관하세요. fleet에 등록하지 않은 독립 설치는 각각의 주소로 사용합니다.

## 2. 모바일에서 Tailscale 연결

Tailscale 모드를 사용하는 경우 다음 순서로 연결합니다.

1. Android 또는 iPhone에 Tailscale을 설치합니다.
2. ChatMux PC와 같은 tailnet 계정으로 로그인합니다.
3. Tailscale 연결을 켭니다.
4. ChatMux를 사용하는 동안 Tailscale 연결을 유지합니다.

다른 사용자가 접속한다면 ChatMux 소유자가 PC에서 해당 계정을 허용해야 합니다.

```bash
chatmux access users
chatmux access allow user@example.com
```

허용된 사용자는 ChatMux를 사용할 수 있지만 서버 업데이트 같은 소유자 전용 작업은
실행할 수 없습니다.

## 3. 모바일 브라우저에서 바로 사용

Tailscale을 연결한 뒤 `chatmux status`에 표시된 HTTPS 주소를 Chrome, Safari 또는
Samsung Internet에서 엽니다. 별도의 ChatMux 로그인 없이 Tailscale 계정으로 접근이
확인됩니다.

브라우저에서도 다음 기능을 사용할 수 있습니다.

- 실행 중인 tmux 및 에이전트 세션 확인
- transcript 대화 읽기와 메시지 전송
- 실제 CLI 화면 열기와 터미널 키 입력
- 세션 생성 및 종료

<table align="center">
  <tr>
    <td align="center">
      <img src="assets/mobile-sidebar-live.png" width="250" alt="모바일 ChatMux 세션 목록"><br>
      <sub>세션 목록</sub>
    </td>
    <td align="center">
      <img src="assets/mobile-chat-live.png" width="250" alt="모바일 ChatMux 대화 화면"><br>
      <sub>대화 화면</sub>
    </td>
    <td align="center">
      <img src="assets/mobile-cli-live.png" width="250" alt="모바일 ChatMux CLI 화면"><br>
      <sub>실제 CLI 화면</sub>
    </td>
  </tr>
</table>

## 4. Android에 PWA 설치

1. Tailscale을 연결합니다.
2. Chrome에서 ChatMux HTTPS 주소를 엽니다.
3. ChatMux의 **앱 설치** 버튼을 누릅니다.
4. 설치 확인 창에서 **설치**를 선택합니다.
5. 홈 화면에 생성된 ChatMux 아이콘으로 실행합니다.

설치 버튼이 나타나지 않으면 Chrome 메뉴에서 **앱 설치** 또는 **홈 화면에 추가**를
선택합니다. 메뉴 이름은 브라우저와 Android 버전에 따라 조금 다를 수 있습니다.

Samsung Internet을 사용한다면 브라우저 메뉴의 **현재 페이지 추가** 또는
**홈 화면** 항목을 이용할 수 있습니다. 푸시 알림까지 사용할 경우 설치된 PWA로
실행하는 방식을 권장합니다.

## 5. iPhone 및 iPad에 PWA 설치

iOS 및 iPadOS의 푸시 알림은 16.4 이상에서 지원됩니다.

1. Tailscale을 연결합니다.
2. Safari에서 ChatMux HTTPS 주소를 엽니다.
3. Safari의 **공유** 버튼을 누릅니다.
4. **홈 화면에 추가**를 선택합니다.
5. 이름과 주소를 확인하고 **추가**를 누릅니다.
6. 홈 화면에 생성된 ChatMux 아이콘으로 실행합니다.

Safari 탭에서 사용하는 것과 홈 화면 아이콘으로 실행하는 PWA는 동작 환경이
다릅니다. iPhone과 iPad에서 푸시 알림을 사용하려면 반드시 홈 화면에 설치한
ChatMux를 실행해야 합니다.

## 6. 세션 알림 사용

알림은 HTTPS 주소에서 설정합니다. Android는 지원 브라우저 또는 설치한 PWA에서
사용할 수 있고, iPhone과 iPad는 홈 화면에 설치한 PWA가 필요합니다.

1. Android에서는 ChatMux HTTPS 페이지 또는 설치한 PWA를 엽니다. iPhone과
   iPad에서는 홈 화면의 ChatMux를 실행합니다.
2. 알림을 받을 세션 행의 종 아이콘을 누릅니다.
3. 운영체제의 알림 권한 요청을 허용합니다.

종을 켠 세션이 사용자 입력을 기다리는 상태가 되면 알림이 전송됩니다. 새 기기,
재설치 또는 HTTPS 주소 변경 후 알림이 오지 않는다면 종 옆의 복구 아이콘을 눌러
현재 기기의 푸시 등록을 다시 만듭니다.

## Tailscale을 사용하지 않는 경우

Tailscale이 준비되지 않은 상태에서 설치하면 ChatMux는 비밀번호가 적용된 LAN
주소를 안내합니다. 같은 Wi-Fi 안에서는 이 주소를 모바일 브라우저로 열 수 있습니다.

다만 평문 HTTP LAN 주소에서는 PWA 설치와 푸시 알림을 사용할 수 없습니다. 외부
네트워크 접속이나 알림이 필요하면 다음 중 하나의 고정 HTTPS 주소를 사용해야 합니다.

- Tailscale Serve
- TLS 리버스 프록시
- 고정 도메인을 사용하는 named tunnel

공개 인터넷에 ChatMux의 HTTP 포트를 직접 노출하지 마세요. 자세한 선택지는
[원격 접근 가이드](REMOTE-ACCESS.md)를 참고하세요.

## 문제 해결

### 접속 링크가 열리지 않음

- 휴대폰의 Tailscale 연결이 켜져 있는지 확인합니다.
- 허용된 Tailscale 계정으로 로그인했는지 확인합니다.
- PC에서 `chatmux status`를 다시 실행해 현재 주소를 확인합니다.
- PC에서 `systemctl --user status chatmux`로 서비스 상태를 확인합니다.

### PWA 설치 메뉴가 없음

- 주소가 `https://`로 시작하는지 확인합니다.
- 이미 같은 주소의 ChatMux가 설치되어 있는지 확인합니다.
- iPhone과 iPad에서는 Safari의 **공유 → 홈 화면에 추가**를 사용합니다.

### 알림이 오지 않음

- iPhone과 iPad에서는 홈 화면에 설치한 PWA를 실행했는지 확인합니다.
- Android에서는 HTTPS 주소를 지원 브라우저 또는 설치한 PWA로 열었는지 확인합니다.
- 운영체제와 ChatMux 사이트의 알림 권한을 확인합니다.
- 해당 세션의 종이 켜져 있는지 확인합니다.
- 복구 아이콘으로 현재 기기의 푸시 등록을 다시 만듭니다.

### 접속 주소가 변경됨

PWA와 푸시 등록은 전체 HTTPS 주소에 연결됩니다. PC 이름, 도메인 또는 포트가
바뀌었다면 기존 PWA를 삭제하고 새 주소에서 다시 설치합니다.

서버 설치, 접근 모드 변경과 업데이트에 관한 자세한 내용은
[설치 가이드](INSTALL.md)를 참고하세요.
