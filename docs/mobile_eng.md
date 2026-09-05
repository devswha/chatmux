# Using ChatMux on Mobile

<p align="center"><b>English</b> · <a href="mobile_kr.md">한국어</a></p>

ChatMux works directly in a mobile browser and does not require a separate mobile
application. If you use it frequently, install the same page as a Progressive Web
App (PWA) for a Home Screen icon, a standalone interface, and session notifications.

## Mobile browser or installed PWA

| Method | Advantages | Limitations |
|---|---|---|
| Mobile browser | Open the link and start immediately | Push notifications are unavailable in an iOS or iPadOS browser tab |
| Installed PWA | Home Screen launch, standalone UI, and session notifications | Must be installed separately for each HTTPS address and device |

Conversation and terminal controls work in both modes. On Android, a supported
browser can register notifications from the HTTPS page without installing the PWA,
although installation is recommended for a more reliable app-like experience. On
iPhone and iPad, push notifications require a Home Screen web app.

## 1. Find the connection link on the PC

Run this command on the PC where ChatMux is installed:

```bash
chatmux status
```

Find the `Open` address under `Access`:

```text
Access:
  Mode: tailscale — tailnet identity, no password
  Open: https://my-pc.example-tailnet.ts.net:8443
```

You can also scan the QR code shown during installation. An address containing
`localhost` or `127.0.0.1` works only on the PC running ChatMux and cannot be opened
from a phone.

Each PC runs its own ChatMux server. With a [multi-PC fleet](INSTALL.md#create-a-multi-pc-fleet),
the owner can open the hub's HTTPS address and install one PWA to use the hub and
up to nine enrolled peers. A separate PWA for every peer is optional. Keep each
PC's direct address from `chatmux status` for recovery when the hub or peer link
is unavailable; independent installations that are not enrolled remain separate.

## 2. Connect Tailscale on the mobile device

When ChatMux uses Tailscale mode:

1. Install Tailscale on the Android device, iPhone, or iPad.
2. Sign in to the same tailnet as the ChatMux PC.
3. Turn on the Tailscale connection.
4. Keep Tailscale connected while using ChatMux.

To give another person access, the ChatMux owner must allow that Tailscale account
from the PC:

```bash
chatmux access users
chatmux access allow user@example.com
```

Allowed users can use ChatMux, but owner-only operations such as server updates
remain unavailable to them.

## 3. Use ChatMux directly in a mobile browser

After connecting Tailscale, open the HTTPS address shown by `chatmux status` in
Chrome, Safari, or Samsung Internet. In Tailscale mode, ChatMux verifies the
Tailscale identity without requiring a separate ChatMux password.

The browser interface supports:

- Viewing running tmux and coding-agent sessions
- Reading transcript conversations and sending messages
- Opening the real CLI and using terminal keys
- Creating and terminating sessions

<table align="center">
  <tr>
    <td align="center">
      <img src="assets/mobile-sidebar-live.png" width="250" alt="ChatMux session list on mobile"><br>
      <sub>Session list</sub>
    </td>
    <td align="center">
      <img src="assets/mobile-chat-live.png" width="250" alt="ChatMux conversation view on mobile"><br>
      <sub>Conversation view</sub>
    </td>
    <td align="center">
      <img src="assets/mobile-cli-live.png" width="250" alt="ChatMux CLI view on mobile"><br>
      <sub>Real CLI</sub>
    </td>
  </tr>
</table>

## 4. Install the PWA on Android

1. Connect Tailscale.
2. Open the ChatMux HTTPS address in Chrome.
3. Select the **Install app** button in ChatMux.
4. Confirm **Install** in the browser prompt.
5. Launch ChatMux from its Home Screen icon.

If the button is unavailable, open the Chrome menu and select **Install app** or
**Add to Home screen**. The exact label can vary by browser and Android version.

In Samsung Internet, use the browser menu and choose **Add current page** or the
equivalent **Home screen** option. Android push can work in a supported HTTPS
browser without installation, but the installed PWA is recommended for regular use.

## 5. Install the PWA on iPhone and iPad

Web Push is supported on iOS and iPadOS 16.4 or newer for Home Screen web apps.

1. Connect Tailscale.
2. Open the ChatMux HTTPS address in Safari.
3. Select the Safari **Share** button.
4. Select **Add to Home Screen**.
5. Confirm the name and address, then select **Add**.
6. Launch ChatMux from its Home Screen icon.

A Safari tab and an installed Home Screen web app run in different environments.
To use push notifications on iPhone or iPad, launch the installed ChatMux web app
from the Home Screen.

## 6. Enable session notifications

Notifications require an HTTPS address. Android supports them in a compatible
browser or installed PWA. iPhone and iPad require the installed Home Screen web app.

1. On Android, open the ChatMux HTTPS page or installed PWA. On iPhone or iPad,
   launch ChatMux from the Home Screen.
2. Select the bell on the session you want to watch.
3. Allow the operating system notification permission request.

ChatMux sends a notification when a watched session becomes ready for user input.
If notifications stop after reinstalling, changing devices, or changing the HTTPS
address, use the repair control beside the bell to register the current device again.

## Without Tailscale

If Tailscale is not ready during installation, ChatMux provides a password-protected
LAN address. A phone on the same Wi-Fi network can open that address in a browser.

Plain HTTP LAN addresses cannot provide PWA installation or push notifications. For
access outside the local network or for notifications, use a stable HTTPS address
through one of these options:

- Tailscale Serve
- A TLS reverse proxy
- A named tunnel with a stable domain

Do not expose the ChatMux HTTP port directly to the public internet. See the
[remote access guide](REMOTE-ACCESS.md) for the available access modes.

## Troubleshooting

### The connection link does not open

- Confirm that Tailscale is connected on the mobile device.
- Confirm that the device uses an allowed Tailscale account.
- Run `chatmux status` again on the PC and use the current address.
- Run `systemctl --user status chatmux` on the PC to check the service.

### The PWA installation option is missing

- Confirm that the address begins with `https://`.
- Check whether ChatMux is already installed for the same address.
- On iPhone and iPad, use Safari's **Share → Add to Home Screen** action.

### Notifications do not arrive

- On iPhone and iPad, confirm that ChatMux was launched from the installed Home
  Screen icon.
- On Android, open the HTTPS address in a supported browser or installed PWA.
- Check the operating system and ChatMux site notification permissions.
- Confirm that the bell is enabled for the session.
- Use the repair control to register the current device again.

### The connection address changed

PWA installations and push subscriptions belong to the complete HTTPS origin. If
the PC name, domain, or port changes, remove the old PWA and install it again from
the new address.

For server installation, access-mode changes, and updates, see the
[installation guide](INSTALL.md).
