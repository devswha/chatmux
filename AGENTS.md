# Repository Guidelines

## Project overview

ChatMux is a self-hosted web interface for coding-agent sessions that continue to run in tmux. The browser is a control and observation surface; tmux and provider-native session stores remain authoritative.

## Read before changing behavior

Use this file as a pointer layer. Keep detailed contracts in their existing documents rather than duplicating them here.

- Product scope and safety invariants: `docs/ROADMAP.md`
- Fleet wire and security contract: `docs/FLEET-FEDERATION-RFC.md`
- Discovery stream contract: `docs/P2-DISCOVERY-STREAM-RFC.md`
- Approval/terminal fallback decision: `docs/M5B-APPROVAL-CONTRACT.md`
- Release and updater contract: `docs/INSTALL.md`, `docs/SELF-HOST.md`
- Historical upstream intake: `docs/UPSTREAM.md`
- Contributor setup and repository layout: `CONTRIBUTING.md`

When a document calls itself normative or approval-gated, do not widen its contract through an implementation-only change. Revise the contract first when the requested work explicitly changes it.

## Safety invariants

- A matching working directory never authorizes input, termination, or another destructive action.
- Revalidate exact tmux pane identity, process lineage/generation, and provider session identity at the action boundary. Fail closed when identity is stale or uncertain.
- Fall back to verified terminal attach when a structured transcript or provider-native control path cannot be verified. Do not infer an unsafe mapping.
- ChatMux failure, restart, removal, or upgrade must not terminate the underlying tmux work.
- Do not expose or persist credentials, license/token material, private keys, transcript paths, sockets, or unredacted private diagnostics in public descriptors, logs, receipts, or release assets.
- Preserve `LICENSE`, `NOTICE`, required attribution, and the active ChatMux product/release identity. `npm run check:identity` enforces these boundaries.

## Architecture map

- `src/` — React/Vite client, stores, hooks, and browser-side fleet state.
- `server/` — Express/WebSocket backend, provider integrations, tmux verification, persistence, CLI, installer, and updater behavior.
- `shared/` — client/server contracts. `shared/fleet.ts` and `shared/tmux.ts` are load-bearing identity and wire surfaces.
- `native/chatmux-core/` — Rust core built for development and release verification.
- `scripts/` — test orchestration, release tooling, identity checks, CUA evidence, and serialized verification ownership.
- `packaging/release/update-compatibility.json` — exact per-version rollback compatibility declaration.

Prefer existing modules and contracts. Do not create a parallel browser/server model for a shared concept.

## Runtime and conventions

- Use npm and the committed `package-lock.json`.
- Supported Node versions are the exact ranges in `package.json` (`22.22.2+` on Node 22 or `24.15.0+` on Node 24).
- The repository is ESM. Follow the existing TypeScript/JavaScript split and local naming/import conventions.
- Do not add a dependency when an existing dependency or platform API already provides the required behavior.
- Keep tests beside the behavior or in the established server/shared test locations; reuse the existing test runner and fixtures.

## Working safely

- Treat unexpected changes as another contributor or session's work. Never reset, stash, rewrite, or delete them.
- Use one worktree and one branch per parallel editing session. Never run two editing sessions on the same branch/worktree.
- Base work on the repository's current `main` model; do not introduce a `dev` integration branch without an explicit repository-wide decision.
- Use focused `feat/*`, `fix/*`, or `docs/*` branches. Delete merged local/remote branches and prune stale tracking refs when cleanup is part of the task.
- Submit every change, including documentation and release bookkeeping, through a pull request. Human approvals are not required, but all required checks must rerun against the latest `main` before squash merge.
- Before pushing a shared branch, fetch and prove the remote tip is an ancestor of the proposed tip. Never force-push shared history.

## Verification

Run the smallest test that directly covers the changed behavior first. Significant behavior changes require observable branch, edge, error, and stale-identity coverage where applicable.

`npm run verify` is the canonical full gate. It serializes ownership through `scripts/verify-owner.mjs` and runs audit, type checks, Rust checks, tests, lint, identity checks, and the production build. Do not bypass the ownership wrapper or run competing full gates in the same worktree.

Useful focused commands:

- `npm test` — repository test orchestrator (builds the development Rust core first).
- `npm run typecheck` — client and server TypeScript checks.
- `npm run check:core` — Rust format, clippy, and tests.
- `npm run lint` — source lint.
- `npm run check:identity` — product, provenance, legal-file, and retired upstream identity gate.
- `npm run server:bundle` — canonical server bundle build.
- `npm run cua:release` — release-grade browser/desktop evidence; requires the documented local environment.

Do not claim release-grade CUA verification when only unit tests or CI-safe checks ran.

## Release changes

- Releases are built from `main` by `.github/workflows/release.yml` and published as the canonical server archive, checksum, and root `install.sh`.
- `.github/workflows/release.yml` is the sole public release path. Do not add local tag/release automation or another publisher.
- A version change must keep `package.json`, both version fields in `package-lock.json`, and the exact entry in `packaging/release/update-compatibility.json` aligned.
- Release changes must preserve the canonical artifact name and must pass archive layout, checksum, extracted-runtime smoke, Ubuntu compatibility, and declared rollback-compatibility gates.
- Never treat a source checkout, npm registry package, container image, or historical upstream as the canonical ChatMux release payload.
