<h3 align="center">every coding agent, one command deck</h3>
<p align="center"><b>ChatMux</b> is a self-hosted web interface for discovering, reading, and controlling coding-agent sessions running in tmux.</p>

<p align="center">
  <a href="https://github.com/devswha/chatmux/releases"><img src="https://img.shields.io/github/v/release/devswha/chatmux?display_name=tag&label=release" alt="GitHub release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-6366f1" alt="AGPL-3.0 license"></a>
  <img src="https://img.shields.io/badge/node-22.22.2%2B%20%7C%2024.15.0%2B-22d3c5" alt="Supported Node versions">
  <img src="https://img.shields.io/badge/runtime-tmux-ff6b4a" alt="tmux runtime">
</p>

<p align="center">
  <img src="public/brand/readme-screenshot.png" alt="ChatMux on desktop and phone: the sidebar lists live tmux agent sessions across providers, and the selected session renders as a structured English conversation with tool activity and a composer" width="900">
</p>

<p align="center">
  <a href="#install"><b>Install</b></a> ·
  <a href="#agent-support">Agent support</a> ·
  <a href="#remote-access">Remote access</a> ·
  <a href="docs/INSTALL.md">Installation guide</a> ·
  <a href="docs/SELF-HOST.md">Operations guide</a>
</p>

You run coding agents — Gajae Code, Claude Code, Codex, Cursor, OpenCode,
Oh My Pi — inside tmux, like always. ChatMux finds them by itself and shows
every session in one browser page, on your desktop or your phone:

- **No registration.** Agents already running in tmux just appear in the sidebar.
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

One command on a Linux x86_64 server:

```bash
curl -fsSL https://github.com/devswha/chatmux/releases/latest/download/install.sh | bash
```

It downloads the latest release, verifies its checksum, installs a private
Node.js 22 runtime only if the machine needs one, and starts a user-level
service bound to `127.0.0.1`. When Tailscale is already logged in it also
configures a private HTTPS address for your other devices; otherwise ChatMux
stays local-only. A successful install ends with:

```text
ChatMux installation complete
  Local:  http://127.0.0.1:3001
  Remote: https://<your-machine>.ts.net:8443        (Tailscale only)
  Access: Tailscale (you@example.com)
  Next:   open the address above in a browser — running tmux agents appear automatically
  Manage: chatmux status | chatmux access users | journalctl --user -u chatmux.service
```

Then:

1. Open the `Local` address in a browser (or the `Remote` address from your
   phone). Running tmux agents appear in the sidebar automatically.
2. On a phone, use the in-app **Install app** button to keep ChatMux as a PWA.
3. Check `chatmux status` any time to see the configured addresses.

Before you start, the machine needs: Linux x86_64 with glibc 2.35+, tmux,
user-level systemd, and `curl`, `tar`, `sha256sum`. See the
[installation guide](docs/INSTALL.md) for pinned installs, explicit access
choices, managed paths, rollback, and recovery.

For source development:

```bash
git clone https://github.com/devswha/chatmux.git
cd chatmux
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. Development requires Node.js `22.22.2+` on the
22.x line or `24.15.0+` on the 24.x line, npm, Git, tmux, and Rust `1.85.1`.

<a id="agent-support"></a>
## Agent support

"Chat view" below means the session renders as a readable conversation with a
composer; otherwise ChatMux gives you an attached terminal. Both views can
type into the real pane.

| Agent | Found automatically | Chat view | Send input | Start new session |
|---|---|---|---|---|
| **Gajae Code (GJC)** | Yes | Yes | Prompts and `/` commands | Yes |
| **Codex CLI** | Yes | After its history is indexed | Prompts and `$` skills | Yes |
| **Claude Code** | Yes | After its history is indexed | Prompts and `/` skills | Yes |
| **Cursor** | Yes | After its history is indexed | Prompts and `/` skills | Yes |
| **OpenCode** | Yes | After its history is indexed | Prompts and `/` skills | Yes |
| **Oh My Pi** | Yes | After its history is indexed | Prompts and `/skill:` skills | Yes |
| **SSH tmux** | Yes | No — terminal only | Terminal keystrokes | No |

Model pickers, reasoning levels, permissions, skills, and MCP controls appear
only when the agent's CLI actually exposes them.

<a id="remote-access"></a>
## Remote access

The production installer can configure Tailscale Serve without exposing the
backend beyond `127.0.0.1`. Approved tailnet accounts use the private HTTPS
address without a separate ChatMux password; unapproved accounts are denied.

```bash
chatmux access users
chatmux access allow family@example.com
chatmux access revoke family@example.com
chatmux access owner new-owner@example.com
```

The installer reuses an existing ChatMux Serve front or selects an unused port
from `8443` through `8499`. It does not enable Funnel or reset unrelated Serve
configuration. Without Tailscale, use an SSH tunnel:

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
- Remote SSH rows remain attached terminals because no local transcript can be
  verified.
- Native provider stores are indexed automatically. Select a project to search
  and resume prior sessions.
- The file panel browses, previews, edits, and uploads only within a validated
  project root.

### Settings

| Tab | Controls |
|---|---|
| **Agents** | CLI installation and authentication, provider permissions, MCP, and skills |
| **Appearance** | Theme, language, thinking/raw parameters, send key, voice input, project order, and editor behavior |
| **API & Tokens** | ChatMux API keys and GitHub credentials |
| **Access** | Tailscale HTTPS address, current identity, owner, and allowed accounts |

## Development and verification

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
- Credentials are not accepted in URL query parameters. External-agent APIs use
  the `X-API-Key` header.
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
