<p align="center">
  <img src="docs/assets/readme-hero.svg" alt="ChatMux — every coding agent, one command deck: Oh My OpenAgent, Codex, Claude, Gajae Code, Cursor, OpenCode, and Oh My Pi sessions multiplexed into one self-hosted interface" width="900">
</p>

<p align="center"><sub><b>English</b> · <a href="docs/readme/README.ko.md">한국어</a> · <a href="docs/readme/README.ja.md">日本語</a> · <a href="docs/readme/README.zh-CN.md">简体中文</a></sub></p>

<p align="center">One interface for Claude Code, Codex, OpenCode, and more —<br>already running in your tmux.</p>

<p align="center">
  <a href="https://github.com/devswha/chatmux/releases"><img src="https://img.shields.io/github/v/release/devswha/chatmux?display_name=tag&label=release&style=flat-square&color=6366f1" alt="GitHub release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-0c1324?style=flat-square" alt="AGPL-3.0 license"></a>
  <img src="https://img.shields.io/badge/node-22.22.2%2B%20%7C%2024.15.0%2B-22d3c5?style=flat-square" alt="Supported Node versions">
  <img src="https://img.shields.io/badge/runtime-tmux-ff6b4a?style=flat-square" alt="tmux runtime">
</p>

You run coding agents — Oh My OpenAgent, Gajae Code, Claude Code, Codex, Cursor CLI, OpenCode, Oh My Pi — inside tmux, like always. ChatMux finds them by itself and shows every session in one browser page, from your desktop or your phone.

- **Zero registration:** Agents already running in tmux just appear in the sidebar. Nothing to wrap, wire, or restart.
- **Multi-provider:** Every provider in a single drag-sortable list, with `RUN`, `READY`, and `ERROR` badges for live state.
- **Chat or terminal:** Recognized transcripts read as conversations; everything else is a real attached terminal. Input only ever reaches a pane whose identity ChatMux has verified.
- **Phone-ready:** Installable PWA over Tailscale or a LAN password — the full roster, conversations, and the real TUI with a key bar.
- **tmux stays the boss:** Restart or remove ChatMux any time; your tmux sessions keep running untouched.

ChatMux does not bundle any AI subscription. Install and log in to each agent CLI as the same OS user that runs ChatMux.

## Getting started

```bash
curl -fsSL https://github.com/devswha/chatmux/releases/latest/download/install.sh | bash
```

Requires Linux x86_64 (glibc 2.35+) with tmux, user-level systemd, and `curl`/`tar`/`sha256sum`.

The installer downloads the canonical release archive, verifies its SHA-256, starts a user-level service, and prints your addresses — plus a QR code for the phone. `chatmux status` shows them again any time.

<p align="center">
  <img src="docs/assets/install.png" alt="install.sh output: download and verification, the local and Tailscale phone addresses, and a QR code to open ChatMux on the phone" width="760">
</p>

Pinned versions, access modes, updates, rollback, and recovery are covered in the [installation guide](docs/INSTALL.md).

## In the browser

Open the printed `Local` address — running tmux agents appear in the sidebar by themselves. Sessions with a recognized transcript render as a structured conversation with a composer:

<p align="center">
  <img src="docs/assets/desktop-chat-live.png" alt="ChatMux on desktop: the sidebar shows seven live coding agents, with Oh My OpenAgent first, followed by GJC, Codex, Claude, Cursor, OpenCode, and Oh My Pi, each with RUN or READY status" width="900">
</p>

The `CLI output` tab of the same session is the real TUI running inside tmux, rendered in the browser — answer menu prompts, watch raw output, or take over with real keystrokes:

<p align="center">
  <img src="docs/assets/browser-cli.png" alt="The CLI output tab of the same session: the real Codex TUI running inside tmux, rendered in the browser" width="900">
</p>

## On the phone

Turn on Tailscale on the phone, scan the QR code from the install output, and use the in-app **Install app** button to keep ChatMux as a PWA:

For link discovery, browser-only use, Android/iOS installation, notifications, and troubleshooting, see the [mobile usage guide](docs/mobile_eng.md) ([한국어](docs/mobile_kr.md)).

<table align="center">
  <tr>
    <td align="center">
      <img src="docs/assets/mobile-sidebar-live.png" width="250" alt="Mobile sidebar showing seven live coding agents, with OMO first, activity badges, and drag handles"><br>
      <sub>The full session roster</sub>
    </td>
    <td align="center">
      <img src="docs/assets/mobile-chat-live.png" width="250" alt="Mobile conversation view showing a real prompt and response from a Codex session"><br>
      <sub>Conversation view</sub>
    </td>
    <td align="center">
      <img src="docs/assets/mobile-cli-live.png" width="250" alt="Mobile CLI output view showing the same real conversation in the Codex TUI with the terminal key bar"><br>
      <sub>Real TUI with a key bar</sub>
    </td>
  </tr>
</table>

## Agent support

All listed agents are discovered automatically, accept direct input, and can be launched from ChatMux. Indexed histories render as conversations; live CLI output is always available.

| Agent | Chat view |
|---|---|
| **Claude Code** | After history is indexed |
| **Codex CLI** | After history is indexed |
| **Cursor CLI** | After history is indexed |
| **OpenCode** | After history is indexed |
| **Oh My OpenAgent** (`omo`) | After history is indexed |
| **Oh My Pi** | After history is indexed |
| **Gajae Code (GJC)** | Native |

SSH tmux and local shells are also supported as terminal-only connections.

<sub>Cursor sessions use the documented <code>agent</code> command; the legacy <code>cursor-agent</code> alias remains supported for older installations.</sub>

## Remote access

With Tailscale logged in, the installer configures Tailscale Serve automatically: approved tailnet accounts use the private HTTPS address with no separate password, and everyone else is denied. Without Tailscale, installation enables password access on the LAN with a one-time owner password:

```bash
chatmux access password             # rotate/recover (signs out all sessions)
chatmux access enable tailscale     # switch modes after Tailscale is available
```

User allowlists, longer sessions, VPN mode, SSH tunnels, and public TLS options are covered in the [remote access guide](docs/REMOTE-ACCESS.md).

## Multiple PCs

One ChatMux installation can be the **hub** for as many as nine other **full ChatMux installations** (ten PCs total). Open the hub in your browser to see the hub and enrolled peers together; each peer still owns its tmux sessions, database, keys, updater, and direct browser UI.

Enrollment is owner-only in **Settings → Hosts**. Generate a single-use, 10-minute pairing code on the peer, then add it from the hub. Use the peer's Tailscale Serve endpoint as `wss://<peer-host>.ts.net:<serve-port>/fleet-ws` by default. **Easy SSH setup** can instead obtain the pairing code and manage a dedicated SSH tunnel to an already-installed peer; its one-time password is never saved. ChatMux has no cloud relay and never automatically downgrades transport. The only supported plaintext exception is an owner-managed or hub-managed SSH local forward using `ws://127.0.0.1:<local-port>/fleet-ws` or `ws://[::1]:<local-port>/fleet-ws`. See the [SSH prerequisites and recovery rules](docs/REMOTE-ACCESS.md#82-default-transport-tailscale-httpswss).

Remote hosts can show **Offline** or **Syncing**. Syncing suspends remote writes until a fresh snapshot completes; Offline never redirects an action to the hub or another peer. Open that PC's own ChatMux address for direct recovery. See [multi-PC setup and recovery](docs/REMOTE-ACCESS.md#8-multi-pc-fleet-one-hub-and-full-peers).

## CLI

The `chatmux` command manages the installed service:

```bash
chatmux status                  # version, addresses, data locations
chatmux access users            # allowed Tailscale accounts
chatmux access allow user@example.com
chatmux sandbox ~/my-project    # run inside a Docker sandbox
chatmux fleet identity          # public installation ID and fingerprint
chatmux fleet diagnose          # redacted peer reachability
```

## Security and data boundaries

- ChatMux links tmux process ancestry to native transcript identifiers. A matching working directory alone is never enough to authorize a destructive action, and the tmux session identifier is rechecked before relay or termination.
- The backend binds to loopback. Tailscale mode trusts Serve identity headers only from loopback on the expected HTTPS origin; the installer never enables Funnel or a public listener, and unapproved users fail closed.
- Password mode uses `HttpOnly`, `SameSite=Strict` cookies with persistent logout revocation.
- State and indexes live below `~/.chatmux`. Back up `~/.chatmux/data` before migration or upgrade. Multi-PC federation does not replicate or cloud-sync that data.

## Development

```bash
git clone https://github.com/devswha/chatmux.git
cd chatmux
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. Development requires Node.js `22.22.2+` on the 22.x line or `24.15.0+` on the 24.x line, npm, Git, tmux, and Rust `1.85+`. `npm run verify` runs the full release gate: audit, typecheck, Rust checks, tests, lint, identity checks, and a production build.

## Documentation

- [Production installation](docs/INSTALL.md)
- [Mobile usage](docs/mobile_eng.md) ([한국어](docs/mobile_kr.md))
- [Remote access](docs/REMOTE-ACCESS.md)
- [Self-hosted operations](docs/SELF-HOST.md)
- [Product scope and roadmap](docs/ROADMAP.md)
- [Upstream provenance](docs/UPSTREAM.md)
- [Contributing](CONTRIBUTING.md)
- [Issue tracker](https://github.com/devswha/chatmux/issues)

## License

[AGPL-3.0](LICENSE) · built for people who live in tmux
