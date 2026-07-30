<p align="center">
  <img src="docs/assets/readme-hero.svg" alt="ChatMux — every coding agent, one command deck: Codex, Claude, Gajae Code, Cursor, and OpenCode sessions multiplexed into one self-hosted interface" width="900">
</p>

<h3 align="center">every coding agent, one command deck</h3>
<p align="center"><b>ChatMux</b> is a self-hosted web interface for discovering, reading, and controlling coding-agent sessions running in tmux.</p>

<p align="center">
  <a href="https://github.com/devswha/chatmux/releases"><img src="https://img.shields.io/github/v/release/devswha/chatmux?display_name=tag&label=release" alt="GitHub release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-6366f1" alt="AGPL-3.0 license"></a>
  <img src="https://img.shields.io/badge/node-22.22.2%2B%20%7C%2024.15.0%2B-22d3c5" alt="Supported Node versions">
  <img src="https://img.shields.io/badge/runtime-tmux-ff6b4a" alt="tmux runtime">
</p>

<p align="center">
  <a href="#install"><b>Install</b></a> ·
  <a href="#browser">Browser</a> ·
  <a href="#mobile">Mobile</a> ·
  <a href="#agent-support">Agent support</a> ·
  <a href="#remote-access">Remote access</a> ·
  <a href="docs/INSTALL.md">Installation guide</a> ·
  <a href="docs/SELF-HOST.md">Operations guide</a>
</p>

You run coding agents — Gajae Code, Claude Code, Codex, Cursor CLI, OpenCode,
Oh My Pi — inside tmux, like always. ChatMux finds them by itself and shows
every session in one browser page, on your desktop or your phone:

- **No registration.** Agents already running in tmux just appear in the sidebar.
- **One ordered sidebar.** GJC, Claude, Codex, Cursor, OpenCode, Oh My Pi,
  SSH, and plain shell sessions share one list; drag any row across providers
  and ChatMux remembers the order in that browser.
- **See live state.** `RUN`, `READY`, and `ERROR` badges distinguish active
  turns, reply-ready sessions, and provider failures such as an overloaded API.
- **Read as chat.** Sessions with a recognized transcript open as a
  conversation view; everything else opens as a real terminal.
- **Type back.** Send prompts, answer menu prompts in the built-in terminal,
  interrupt a running turn, resume old sessions, or start new agents — input
  only ever reaches a pane whose identity ChatMux has verified.
- **tmux stays the boss.** Restart or remove ChatMux any time; your tmux
  sessions keep running untouched.

ChatMux does not bundle any AI subscription. Install and log in to each agent
CLI as the same OS user that runs ChatMux.

<a id="install"></a>
## Install

Linux x86_64 (glibc 2.35+) with tmux, user-level systemd, and
`curl`/`tar`/`sha256sum`:

```bash
curl -fsSL https://github.com/devswha/chatmux/releases/latest/download/install.sh | bash
```

<p align="center">
  <img src="docs/assets/install.png" alt="install.sh output: download and verification, the local and Tailscale phone addresses, and a QR code to open ChatMux on the phone" width="760">
</p>

The installer downloads the canonical release archive, verifies its SHA-256,
starts a user-level service, and prints your addresses. `chatmux status` shows
them again any time. Pinned versions, access modes, updates, rollback, and
recovery are covered in the [installation guide](docs/INSTALL.md); source
development is covered in [Development](#development).

<a id="browser"></a>
## Browser

Open the printed `Local` address — running tmux agents appear in the sidebar
by themselves. Sessions with a recognized transcript render as a structured
conversation with a composer:

<p align="center">
  <img src="docs/assets/browser-chat.png" alt="ChatMux on desktop: the sidebar lists live tmux agent sessions across providers with RUN and READY badges, and the selected Codex session renders as a structured conversation with a composer" width="900">
</p>

The `CLI output` tab of the same session is the real TUI running inside tmux,
rendered in the browser — answer menu prompts, watch raw output, or take over
with real keystrokes:

<p align="center">
  <img src="docs/assets/browser-cli.png" alt="The CLI output tab of the same session: the real Codex TUI running inside tmux, rendered in the browser" width="900">
</p>

<a id="mobile"></a>
## Mobile

Turn on Tailscale on the phone, scan the QR code from the install output, and
use the in-app **Install app** button to keep ChatMux as a PWA.

The full roster, the conversation view, and the real TUI with a terminal key
bar all work from the phone:

<p align="center">
  <img src="docs/assets/mobile-tab.jpeg" width="255" alt="Mobile sidebar: the full cross-provider session roster with activity badges and drag handles">
  <img src="docs/assets/mobile-chat.jpeg" width="255" alt="Mobile conversation view of a Codex session with the chat composer">
  <img src="docs/assets/mobile-cli.jpeg" width="255" alt="Mobile CLI output view typing into the real Codex TUI with the terminal key bar">
</p>

<a id="agent-support"></a>
## Agent support

"Chat view" below means the session renders as a readable conversation with a
composer; otherwise ChatMux gives you an attached terminal. Both views can
type into the real pane.

Every live row uses the same reorderable sidebar regardless of provider. Dragging
a row across provider boundaries persists the resulting order in that browser.
Transcript-aware activity badges surface running turns and terminal provider
errors without replacing the underlying conversation or terminal view.

| Agent | Found automatically | Chat view | Send input | Start new session |
|---|---|---|---|---|
| **Gajae Code (GJC)** | Yes | Yes | Prompts and `/` commands | Yes |
| **Codex CLI** | Yes | After its history is indexed | Prompts and `$` skills | Yes |
| **Claude Code** | Yes | After its history is indexed | Prompts and `/` skills | Yes |
| **Cursor CLI** | Yes | After its history is indexed | Prompts and `/` skills | Yes |
| **OpenCode** | Yes | After its history is indexed | Prompts and `/` skills | Yes |
| **Oh My Pi** | Yes | After its history is indexed | Prompts and `/skill:` skills | Yes |
| **SSH tmux** | Yes | No — terminal only | Terminal keystrokes | No |
| **Local shell** | Yes | No — terminal only | Terminal keystrokes | No |

Cursor sessions use the documented `agent` command. The legacy `cursor-agent`
alias remains supported for older installations.

<p align="center">
  <img src="docs/assets/browser-cli.png" alt="The CLI output tab of the same session: the real Codex TUI running inside tmux, rendered in the browser" width="900">
</p>

<a id="remote-access"></a>
## Remote access

When Tailscale is running and logged in, the installer configures Tailscale
Serve automatically. Approved tailnet accounts use the private HTTPS address
without a separate ChatMux password; unapproved accounts are denied. Turn on
Tailscale on the phone before scanning the install QR and keep it connected
while using ChatMux.

Without Tailscale, installation enables password access on the LAN. Sign in
once from any browser and the session renews on use. Rotate or recover the
password, or change the mode, at any time:

```bash
chatmux access password                            # rotate/recover (signs out all sessions)
chatmux access enable password --session-days 90   # longer idle window
chatmux access enable tailscale                    # switch after Tailscale is available
```

Password-mode devices on the same Wi-Fi connect immediately; for the public
internet, forward the TCP port and put a TLS proxy in front (see
[docs/INSTALL.md](docs/INSTALL.md)).

```bash
chatmux access users
chatmux access allow family@example.com
chatmux access revoke family@example.com
chatmux access owner new-owner@example.com
```

It reuses an existing ChatMux Serve front or selects an unused port from
`8443` through `8499`. It does not enable Funnel or reset unrelated Serve
configuration.

Without Tailscale, a WireGuard-style VPN gives login-free access with no
session expiry (see [docs/INSTALL.md](docs/INSTALL.md)):

```bash
chatmux access enable vpn 10.0.0.1
```

An SSH tunnel remains the simplest fallback:

```bash
ssh -N -L 3001:127.0.0.1:3001 user@server
```

Then open <http://127.0.0.1:3001> locally. Replace `3001` with the backend
port reported by `chatmux status` when the installer selected a different one.

## How it works

```mermaid
flowchart LR
  subgraph Host[Self-hosted machine]
    TMUX[tmux sessions]
    AGENTS[GJC · Claude · Codex · Cursor · OpenCode · Oh My Pi]
    SSH[Remote SSH panes]
    INDEX[Session discovery + transcript index]
    API[ChatMux API]

    TMUX --> AGENTS
    TMUX --> SSH
    AGENTS --> INDEX
    INDEX --> API
  end

  API --> WEB[Web / PWA]
  WEB -->|spawn · relay · resume · kill| API
```

ChatMux links tmux process ancestry to native transcript identifiers. A matching
working directory alone is never enough to authorize a destructive action, and
the tmux session identifier is rechecked before relay or termination.

## Daily workflow

- Live agent rows open as conversation views before the first native transcript
  is written, then switch to indexed titles, models, and message history.
- Drag handles reorder the complete live roster across providers. `RUN`,
  `READY`, and `ERROR` badges keep active, completed, and failed turns visible
  on both desktop and the installed PWA.
- Remote SSH rows remain attached terminals because no local transcript can be
  verified.
- Native provider stores are indexed automatically. Select a project to search
  and resume prior sessions.
- The file panel browses, previews, edits, and uploads only within a validated
  project root.

### Settings

| Tab | Controls |
|---|---|
| **Agents** | CLI installation and authentication, and provider permissions |
| **Appearance** | Theme, language, thinking/raw parameters, send key, project order, and editor behavior |
| **Access** | Tailscale HTTPS address, current identity, owner, and allowed accounts |

<a id="development"></a>
## Development and verification

```bash
git clone https://github.com/devswha/chatmux.git
cd chatmux
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. Development requires Node.js `22.22.2+` on the
22.x line or `24.15.0+` on the 24.x line, npm, Git, tmux, and Rust `1.85.1`.

| Command | Purpose |
|---|---|
| `npm run dev` | Vite client and development backend |
| `npm run typecheck` | Client and server TypeScript checks |
| `npm test` | Server and client tests |
| `npm run lint` | ESLint for product and tooling code |
| `npm run check:identity` | Product name, storage path, and repository identity checks |
| `npm run build` | Production client, server, and Rust core build |
| `npm run verify` | Audit, types, Rust, tests, lint, identity, and production build |

```bash
npm run verify
```

## Security and data boundaries

- The backend binds to loopback. Tailscale mode trusts Serve identity headers
  only from loopback on the expected HTTPS origin and applies one allowlist to
  HTTP and WebSocket requests.
- The installer does not enable Tailscale Funnel or a public listener. Tagged
  devices and unapproved tailnet users fail closed.
- Password mode uses `HttpOnly`, `SameSite=Strict` cookies and persistent logout
  revocation.
- Project file access normalizes paths, checks symlinks, and rejects project-root
  escapes.
- State and indexes live below `~/.chatmux`. Back up `~/.chatmux/data` before
  migration or upgrade.

## Documentation

- [Production installation](docs/INSTALL.md)
- [Self-hosted operations](docs/SELF-HOST.md)
- [Product scope and roadmap](docs/ROADMAP.md)
- [Upstream provenance](docs/UPSTREAM.md)
- [Contributing](CONTRIBUTING.md)
- [Issue tracker](https://github.com/devswha/chatmux/issues)

## License

[GNU AGPL v3](LICENSE)
