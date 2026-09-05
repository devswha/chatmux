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
│   ├── modules/      # Domain routes, database, providers, fleet, and WebSocket
│   └── shared/       # Backend contracts and utilities
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
- Multi-PC documentation must preserve the shipped contract in [REMOTE-ACCESS.md §8](docs/REMOTE-ACCESS.md#8-multi-pc-fleet-one-hub-and-full-peers) and [Fleet RFC revision 6](docs/FLEET-FEDERATION-RFC.md#optional-ssh-bootstrap-and-candidate-suggestions): one hub plus at most nine full peers, owner-only enrollment, Tailscale HTTPS/WSS by default, and only literal loopback `ws://` behind an owner-managed or explicitly requested hub-managed SSH forward. Optional SSH bootstrap requires owner opt-in and a missing installation; it never updates or repairs an existing peer. Do not describe a relay, downgrade, automatic failover, fleet updater, cloud sync, remote desktop/IDE, arbitrary commands, or zero-configuration reachability.

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

1. **Every change goes through a PR**, including documentation and release bookkeeping, even from maintainers. Create a short-lived branch (`fix/...`, `feat/...`), open a PR, let CI pass, then squash-merge and delete the branch. PR titles follow the commit convention above — release notes are generated from merged PR titles.
2. **Group related small fixes into one PR**; keep unrelated changes out.
3. **Never batch-merge a long-lived integration branch into `main`.** If a change is too big for one PR, land it as a series of PRs that each keep `main` green.
4. **Branch protection enforces the gate**: `main` requires the `PR policy`, `Verify Node 22`, `Verify Node 24`, and `Canonical server bundle` checks to pass before a PR can merge. These checks must be from the latest `main`, force-pushes/deletions are blocked, and zero human approvals are required.
5. **Do not use routine administrative bypasses.** Re-run a proven CI-infrastructure flake or fix the source condition instead.

## Releases

Fleet-capable releases are rolled out **hub first**, then one full peer at a time.
Verify the hub's direct UI and peer inventory after the hub update. After each peer
update, wait for it to leave **Syncing** and return **Online** before continuing.
**Incompatible** is a hard stop: use a supported version pairing or the documented
manual recovery; never downgrade the transport or bulk-update the remaining peers.
There is no fleet-wide update command, and every peer retains its own updater and
direct recovery UI.

Cutting a release (maintainers):

1. Open one atomic release-prep PR containing the compatibility declaration in `packaging/release/update-compatibility.json` and the version and lockfile update (`npm version X.Y.Z --no-git-tag-version`). Record `database.schemaGeneration` from the registered migration count reported by `npm run release:check-metadata`. When the database schema is unchanged, carry forward **every** prior version sharing that schema in `rollbackCompatibleFrom` (the release workflow proves each declared entry); reset the list to only the immediately preceding version only when the registered schema generation actually increases. A single-entry declaration on an unchanged schema strands any install more than one release behind in `manual_required` (#49). Never edit the entries of already-published releases: their metadata is anchored to the immutable predecessor tag, and preflight rejects any divergence. GitHub-generated release notes are canonical; do not maintain a second hand-written release-note source.
2. Merge the release-prep PR only after the required checks run on latest `main`.
3. Dispatch the **Release ChatMux Server** workflow from `main` (`gh workflow run "Release ChatMux Server" --ref main`). The workflow rejects duplicate, stale, and non-increasing stable versions before it verifies, builds, proves rollback compatibility, and publishes the GitHub Release with the tag. `npm run cua:release` is manual release evidence and recommended before dispatch; it does not gate publication.

The `release-preflight` job enforces compatibility-declaration completeness before anything is built: `npm run release:check-metadata` (`scripts/release/check-release-metadata.mjs`) checks that `package.json` and both `package-lock.json` version fields agree, derives the schema generation from the ordered migration registry, requires that exact generation in the target compatibility entry, and anchors the predecessor and its rollback window to metadata published at the predecessor tag. The predecessor's schema generation is derived from the migration registry source at the predecessor tag rather than trusted from mutable metadata, which also bootstraps releases whose predecessor predates `schemaGeneration` (v1.8.14 and earlier record none). A singleton predecessor is accepted only when the schema generation increases; otherwise every version declared by the predecessor plus the predecessor itself must be carried forward. Local runs use the in-repository history and the recorded predecessor generation with a warning because no canonical predecessor files are available.

The `scripts/chatmux.sh` commands below are for the retained source-deployment
lifecycle, not the canonical release publication or installation path. When
maintaining such a deployment, pin an approved immutable commit SHA. Canonical
server releases are published only by the workflow above and installed from the
GitHub Release artifacts described in [INSTALL.md](docs/INSTALL.md).

```bash
./scripts/chatmux.sh status
./scripts/chatmux.sh update --ref <approved-full-commit-sha>
```

See the [self-hosting guide](docs/SELF-HOST.md) for installation, updates, rollback, and service operations.

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0-or-later License](LICENSE), including the additional terms specified in Section 7 of the LICENSE file.
