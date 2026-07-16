<div align="center">
  <img src="public/logo.png" alt="Gajae App" width="96" height="96">
  <h1>Gajae App</h1>
  <p>Run Gajae Code (GJC), Claude Code, Cursor, Codex, and OpenCode from one self-hosted web and desktop workspace.</p>
</div>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#first-run">First run</a> ·
  <a href="#daily-workflow">Daily workflow</a> ·
  <a href="docs/INSTALL.md">Production install</a> ·
  <a href="https://github.com/devswha/gajae-app/issues">Issues</a>
</p>

<div align="right"><i><b>English</b> · <a href="./README.ko.md">한국어</a> · <a href="./README.ja.md">日本語</a> · <a href="./README.de.md">Deutsch</a> · <a href="./README.ru.md">Русский</a> · <a href="./README.tr.md">Türkçe</a> · <a href="./README.zh-CN.md">简体中文</a> · <a href="./README.zh-TW.md">繁體中文</a></i></div>

## What Gajae App does

Gajae App is a single-user control surface for coding agents running on your own machine or server. It combines project and session discovery, streaming chat, approval handling, a file browser and editor, live CLI visibility, notifications, skills, MCP configuration, and remote desktop targets.

The app does not include a model subscription. Install and authenticate every agent CLI you intend to use on the same host and under the same operating-system user that runs Gajae App.

### Supported agents

- **Gajae Code (GJC)**
- **Claude Code**
- **Cursor**
- **Codex**
- **OpenCode**

Provider-specific models, effort controls, permission modes, session history, skills, and MCP features appear only when that provider supports them.

<a id="quick-start"></a>
## Quick start

### Requirements

- Node.js 22.22.2+ (22.x) or 24.15.0+ (24.x)
- Rust 1.85.1 via rustup for source development; release artifacts include the native core
- npm and Git
- At least one supported agent CLI, already installed and authenticated

### Start the web app from source

```bash
git clone https://github.com/devswha/gajae-app.git
cd gajae-app
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. The development backend listens on `127.0.0.1:3001`.

### Start the desktop app in development

Keep the web stack running and start Electron in a second terminal.

Terminal 1:

```bash
npm run dev
```

Terminal 2:

```bash
npm run desktop:dev
```

<a id="first-run"></a>
## First run

1. **Create the owner account.** Open Gajae App and create the only local application account. The username must contain at least 3 characters and the password at least 6.
2. **Set the Git identity.** Enter the name and email used for commits made on this host. This writes the global Git `user.name` and `user.email`; a GitHub sign-in is not required.
3. **Connect coding agents.** Complete available provider login flows during onboarding, or skip them and use **Settings → Agents** later. Host-level CLI authentication remains the source of truth.
4. **Add a project.** Use the sidebar project action to select an existing directory or create/clone a workspace. Paths refer to the machine running the server, not necessarily the device displaying the browser.
5. **Start a session.** Select the project, choose an available provider, adjust the provider-supported model and permission controls, then send the first prompt.

<a id="daily-workflow"></a>
## Daily workflow

### Projects and sessions

- Add a local workspace by absolute path, or clone a Git repository through the project wizard.
- Store a GitHub token under **Settings → API & Credentials** only when an HTTPS clone needs one; SSH URLs use the server user's SSH configuration.
- Expand a project in the sidebar to resume indexed sessions. Gajae App reads supported provider session stores and keeps provider identities separate.
- Start a new chat from the selected project. Stopping a run stops the active agent process; it does not delete the project or its history.

### Chat and approvals

- Send text, image attachments, file mentions, and provider-supported slash commands.
- Review tool calls and answer permission requests in the chat instead of blindly enabling unrestricted execution.
- Use model, effort, thinking, and permission controls only where the selected provider exposes them.
- Resume earlier sessions from the sidebar. Session names can be edited without changing provider-native session identifiers.

### Files

Open the Files panel to browse the configured workspace root, preview images and Markdown, edit text files, create folders, and upload files. File access is constrained to validated project paths; symlink and traversal escapes are rejected.

### Live CLI sessions

Gajae App can surface supported agent sessions that are already running under `tmux`. Live rows use the tmux session name, open as terminal-backed views, and remain owned by tmux rather than by the web server. A server restart must not terminate those external sessions.

### Notifications

Enable browser or desktop notifications in **Settings → Notifications**. Run-complete, error, permission-required, and supported live-turn events have separate controls so noisy lanes can be disabled independently.

## Remote use

The server binds to loopback by default. For another device, keep that binding and use a trusted VPN or an SSH tunnel:

```bash
ssh -N -L 3001:127.0.0.1:3001 user@server
```

Then open <http://127.0.0.1:3001> locally. Do not expose port 3001 directly to the public internet.

The Electron app can register remote Gajae App servers. Remote targets require HTTPS; plain HTTP is accepted only for exact loopback origins. Each local or remote target uses an isolated Electron session partition so cookies and storage are not shared.

## Production installation

Production is supported on Linux x86_64 with glibc 2.35 or newer, Node.js 22.22.2 or newer within the 22.x line, and a user-level systemd service.

Use an immutable `gajae-app-server-<version>-linux-x64-node22.tar.gz` artifact from [GitHub Releases](https://github.com/devswha/gajae-app/releases). A supported installation must:

1. download a pinned version and its matching `.sha256` file;
2. verify the checksum before extraction;
3. unpack it under `~/.gajae-app/releases/<version>`;
4. point `~/.gajae-app/current` at that release;
5. run `gajae-app.service` as a user service and verify `http://127.0.0.1:3001/health`.

Follow [docs/INSTALL.md](docs/INSTALL.md) for the exact first-install commands and [docs/SELF-HOST.md](docs/SELF-HOST.md) for service operations, upgrades, remote access, rollback, and removal. Do not deploy a mutable `latest` URL, package-registry copy, container image, or unverified source build as the production server.

## Troubleshooting

| Symptom | Check |
|---|---|
| A provider is unavailable | Confirm its CLI is installed, authenticated, and visible in `PATH` for the user running Gajae App; then recheck **Settings → Agents**. |
| A project path is rejected | Enter an absolute path that exists on the server host and is accessible to the server user. |
| Electron development opens a blank or failed page | Keep `npm run dev` active before running `npm run desktop:dev`. |
| The service does not start | Run `systemctl --user status gajae-app.service` and `journalctl --user -u gajae-app.service -f`. |
| Remote access fails | Confirm the local `/health` endpoint first, then verify the SSH/VPN route or the registered HTTPS origin. |
| Old credentials still appear invalid after login | Reconnect the provider in **Settings → Agents** and verify the CLI directly under the service user. |

## Development commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start the Vite client and development backend |
| `npm run server:dev` | Start only the development backend |
| `npm run client` | Start only the Vite client |
| `npm run desktop:dev` | Start Electron against the development client |
| `npm test` | Run server, client, and Electron tests |
| `npm run typecheck` | Type-check the client and server |
| `npm run lint` | Run ESLint across product and tooling code |
| `npm run check:identity` | Verify product, legal, and provenance identity rules |
| `npm run build` | Build the production client and server |
| `npm run verify` | Run the complete release gate |

Use Node.js 22.22.2+ (22.x) or 24.15.0+ (24.x) and run the full gate before submitting changes:

```bash
npm run verify
```

This runs the dependency audit, type checks, all test partitions, lint, identity validation, and production builds.

## Security and data boundaries

- Web authentication uses an `HttpOnly`, `SameSite=Strict` cookie with persistent logout revocation.
- Credentials are not accepted from URL query parameters. External agent API keys use the `X-API-Key` header.
- Project files are resolved through canonical path and symlink checks; writes use same-directory atomic replacement.
- Uploads use private per-request temporary directories that are cleaned after completion or failure.
- Electron denies target permissions by default and limits IPC to registered launcher frames.
- Back up `~/.gajae-app/data` before upgrades or host migration. Release cutovers must preserve that directory.

## Project information

- [Production installation](docs/INSTALL.md)
- [Self-hosting and rollback](docs/SELF-HOST.md)
- [Upstream provenance and selective intake](docs/UPSTREAM.md)
- [Contributing](CONTRIBUTING.md)
- [Issue tracker](https://github.com/devswha/gajae-app/issues)

## License

[GNU AGPL v3](LICENSE)
