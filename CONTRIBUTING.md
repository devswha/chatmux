# Contributing to ChatMux

Thanks for your interest in contributing to ChatMux! Before you start, please take a moment to read through this guide.

## Before You Start

- **Search first.** Check [existing issues](https://github.com/devswha/chatmux/issues) and [pull requests](https://github.com/devswha/chatmux/pulls) to avoid duplicating work.
- **Discuss first** for new features. Open an [issue](https://github.com/devswha/chatmux/issues/new) to discuss your idea before investing time in implementation. We may already have plans or opinions on how it should work.
- **Bug fixes are always welcome.** If you spot a bug, feel free to open a PR directly.

## Prerequisites

- [Node.js](https://nodejs.org/) `22.22.2+` on the 22.x line or `24.15.0+` on the 24.x line
- npm
- Git
- tmux
- Rust `1.85+`
- At least one supported coding-agent CLI installed and configured

## Getting Started

1. Fork the [repository](https://github.com/devswha/chatmux).
2. Clone your fork:
   ```bash
   git clone https://github.com/<your-username>/chatmux.git
   cd chatmux
   ```
3. Install dependencies:
   ```bash
   npm ci
   ```
4. Start the development server:
   ```bash
   npm run dev
   ```
5. Create a branch for your changes:
   ```bash
   git checkout -b feat/your-feature-name
   ```

## Project Structure

```
chatmux/
├── src/              # React frontend (Vite + Tailwind)
│   ├── components/   # UI components
│   ├── contexts/     # React context providers
│   ├── hooks/        # Custom React hooks
│   ├── i18n/         # Internationalization and translations
│   ├── lib/          # Shared frontend libraries
│   ├── types/        # TypeScript type definitions
│   └── utils/        # Frontend utilities
├── server/           # Express backend
│   ├── routes/       # API route handlers
│   ├── middleware/   # Express middleware
│   ├── database/     # SQLite database layer
│   └── tools/        # CLI tool integrations
├── shared/           # Code shared between client and server
└── public/           # Static assets, icons, PWA manifest
```

## Development Workflow

- `npm run dev` — Start both the frontend and backend in development mode
- `npm run build` — Create a production build
- `npm run server` — Start only the backend server
- `npm run client` — Start only the Vite dev server

## Making Changes

### Bug Fixes

- Reference the issue number in your PR if one exists
- Describe how to reproduce the bug in your PR description
- Add a screenshot or recording for visual bugs

### New Features

- Keep the scope focused — one feature per PR
- Include screenshots or recordings for UI changes

### Documentation

- Documentation improvements are always welcome
- Keep language clear and concise
- Keep installation and self-hosting instructions aligned with [the self-hosting guide](docs/SELF-HOST.md)
- Multi-PC documentation must preserve the shipped contract in [REMOTE-ACCESS.md §8](docs/REMOTE-ACCESS.md#8-multi-pc-fleet-one-hub-and-full-peers): one hub plus at most nine full peers, owner-only enrollment, Tailscale HTTPS/WSS by default, and only literal loopback `ws://` behind an owner-created SSH forward. Do not describe a relay, downgrade, automatic failover, fleet updater, cloud sync, remote desktop/IDE, arbitrary commands, or zero-configuration reachability.

## Commit Convention

We follow [Conventional Commits](https://conventionalcommits.org/) to generate release notes automatically. Every commit message should follow this format:

```
<type>(optional scope): <description>
```

Use imperative, present tense: "add feature" not "added feature" or "adds feature".

### Types

| Type | Description |
|------|-------------|
| `feat` | A new feature |
| `fix` | A bug fix |
| `perf` | A performance improvement |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `docs` | Documentation only |
| `style` | CSS, formatting, visual changes |
| `chore` | Maintenance, dependencies, config |
| `ci` | CI/CD pipeline changes |
| `test` | Adding or updating tests |
| `build` | Build system changes |

### Examples

```bash
feat: add conversation search
feat(i18n): add Japanese language support
fix: redirect unauthenticated users to login
fix(editor): syntax highlighting for .env files
perf: lazy load code editor component
refactor(chat): extract message list component
docs: update self-hosting guide
```

### Breaking Changes

Add `!` after the type or include `BREAKING CHANGE:` in the commit footer:

```bash
feat!: redesign settings page layout
```

## Pull Requests

- Give your PR a clear, descriptive title following the commit convention above
- Fill in the PR description with what changed and why
- Link any related issues
- Include screenshots for UI changes
- Make sure the build passes (`npm run build`)
- Keep PRs focused — avoid unrelated changes

## Branching & Release Policy (Maintainers)

ChatMux uses trunk-based development: `main` plus short-lived branches. There is no long-lived `dev` branch — `main` must stay releasable at all times, and releases are cut from it by explicit workflow dispatch.

1. **Every feature and bug fix goes through a PR**, even from maintainers. Create a short-lived branch (`fix/...`, `feat/...`), open a PR, let CI pass, then squash-merge and delete the branch. PR titles follow the commit convention above — release notes are generated from merged PR titles.
2. **Group related small fixes into one PR**; keep unrelated changes out.
3. **Only release bookkeeping commits go directly to `main`**: the `chore(release): declare X database rollback compatibility` and `chore(release): vX` commits, plus trivial typo/doc-only fixes.
4. **Never batch-merge a long-lived integration branch into `main`.** If a change is too big for one PR, land it as a series of PRs that each keep `main` green.
5. **Branch protection enforces the gate**: `main` requires the `Verify Node 22` / `Verify Node 24` checks to pass before a PR can merge, and force-pushes/deletions are blocked. Admins may bypass only for the release bookkeeping commits above or to unblock a proven CI-infrastructure flake (prefer re-running the failed job).

## Releases

Fleet-capable releases are rolled out **hub first**, then one full peer at a time.
Verify the hub's direct UI and peer inventory after the hub update. After each peer
update, wait for it to leave **Syncing** and return **Online** before continuing.
**Incompatible** is a hard stop: use a supported version pairing or the documented
manual recovery; never downgrade the transport or bulk-update the remaining peers.
There is no fleet-wide update command, and every peer retains its own updater and
direct recovery UI.

Cutting a release (maintainers):

1. On up-to-date `main`, add the compatibility declaration for the new version to `packaging/release/update-compatibility.json` and commit it as `chore(release): declare X.Y.Z database rollback compatibility`. When the database schema is unchanged, carry forward **every** prior version sharing that schema in `rollbackCompatibleFrom` (the release workflow proves each declared entry); reset the list to only the immediately preceding version when a release actually migrates the schema. A single-entry declaration on an unchanged schema strands any install more than one release behind in `manual_required` (#49).
2. Bump the version (`npm version X.Y.Z --no-git-tag-version`), prepend the `CHANGELOG.md` section, and commit as `chore(release): vX.Y.Z`.
3. Push `main` and dispatch the **Release ChatMux Server** workflow (`gh workflow run "Release ChatMux Server" --ref main`). The workflow verifies, builds, proves rollback compatibility, and publishes the GitHub Release with the tag.

Maintainers publish approved repository revisions through the repository-owned self-hosting lifecycle. Use an immutable commit SHA for installations and updates; do not rely on a global package or a moving branch.

```bash
./scripts/chatmux.sh status
./scripts/chatmux.sh update --ref <approved-full-commit-sha>
```

See the [self-hosting guide](docs/SELF-HOST.md) for installation, updates, rollback, and service operations.

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0-or-later License](LICENSE), including the additional terms specified in Section 7 of the LICENSE file.
