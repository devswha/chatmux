# Herdr Phase 0 compatibility gate

Status: **CANDIDATE GO pending independent Architect/Critic approval.** The hardened live cohort passed, but this document is a gate, not product authorization. ChatMux must not install, start, update, repair, or take over Herdr. tmux remains unchanged and independently authoritative.

## Pinned candidate

- Herdr `v0.7.5`, protocol `17`, Linux x86_64.
- Official release: <https://github.com/herdrdev/herdr/releases/tag/v0.7.5>.
- Official asset: `herdr-linux-x86_64`.
- Published SHA-256: `3dc83288073e4c2d3c679a30e7be97bcca9141c6fd17dbbb9219142e95c59253`.
- Published at: 2026-07-21T18:11:20Z; evidence checked: 2026-07-30.

The acceptable transport is the documented non-PTY subprocess `herdr terminal session control`. The public raw schema exposes no `terminal.*` live-control method. Private, inferred, raw-schema, shell, PTY, takeover, and default-session control are prohibited.

## Hardened reproduction

Run only as a non-root Linux x64 user, with an absolute, user-owned, regular, non-symlink source asset that is not group/world-writable and whose digest exactly equals the pinned digest. The previously installed user-local executable must already be absent. A mode-0600 retained asset is acceptable: the probe copies it into a new user-owned isolated run root, changes only the copy to mode 0755, and executes only that digest-identical copy. It does not install or retain an executable Herdr binary.

```sh
node scripts/herdr-phase0-probe.mjs \
  --binary /absolute/path/to/verified/herdr \
  --expected-sha256 3dc83288073e4c2d3c679a30e7be97bcca9141c6fd17dbbb9219142e95c59253 \
  --expected-absent-path /absolute/path/of/removed/user-local/herdr \
  --output /absolute/path/to/v0.7.5-phase0.json \
  --restricted-output /secure/absolute/path/to/v0.7.5-phase0-restricted.json
```

The probe sets `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, and `HERDR_CONFIG_PATH` beneath a short mode-0700 run root. This keeps Herdr's named-session directory and Unix socket inside the manifest while respecting the Unix socket path limit. The restricted mode-0600 artifact records actual paths, owners, modes, device/inode identities, PIDs, selectors, pane IDs, pre/post session inventories, signal state, deletion, socket absence, and source/run-root equality checks; it is never checked into the repository.

The sanitized live result is checked in at `server/modules/terminal-runtimes/tests/fixtures/herdr/v0.7.5-phase0.json`. It records only the successful isolated run and omits restricted selectors, paths, resource IDs, prompts, and frame payloads.

Reviewers bind a cohort to the three files below using SHA-256 over each UTF-8 path, one NUL byte, its raw bytes, and one NUL byte, in this exact order:

1. `docs/HERDR-PHASE0.md`
2. `scripts/herdr-phase0-probe.mjs`
3. `server/modules/terminal-runtimes/tests/fixtures/herdr/v0.7.5-phase0.json`

The review receipt records the resulting hash; the files do not embed it, avoiding a circular self-hash.

## Required report contract

The public report uses schema version 3 and separates `observed`, `inferred`, `unsupported`, and `failClosedLimitations`. It includes:

- a canonical full-schema SHA-256 plus required-semantic manifest/fingerprint version 3 derived from exact selected API request definitions, method-to-result-tag mappings, narrowed success/error envelopes, selected result variants, both asynchronous event and subscription-event envelopes/payload closures, recursively referenced definitions across schema namespaces, and the documented control argv, input/resize/scroll/release commands, frame/closed shapes, busy form, ordering, encoding, and named-source behavior; every retained schema reference must resolve inside the manifest before `go`;
- durable restricted provenance/preflight/install/runtime/cleanup facts; the public report excludes source/run paths, resource IDs, selectors, prompt data, and seeded secret/path markers;
- exact binary digest, source and copied-file owner/mode verification, and copied-executable execution;
- a manifest-scoped isolated named session and workspace with all supported XDG/HOME/config roots under the run root, and no shell, PTY, takeover, default session, service, profile, package, or ChatMux mutation;
- missing-selector snapshot, status, and control checks plus post-control status/session/socket checks proving no automatic start;
- bounded command capture and NDJSON line, record, encoded frame, decoded frame, and cumulative-decoded-frame limits;
- exact frame field/type validation, base64 validation before decoding/allocation, contiguous integer sequence facts, ANSI/UTF-8 evidence, resize/scroll, and exact input marker count;
- second-controller typed rejection, explicit release, post-release reacquisition without takeover, abrupt-EOF recovery, and malformed-command recovery;
- measured move, public pane split/close/recreate, foreground-process, and cold-restart identity observations. Pane revision is reported as measured data, never asserted as an occupant-generation proxy;
- bounded child cleanup, exact named-session deletion, recorded Unix-socket absence, run-root uninstall, source equality, and SIGINT/SIGTERM cancellation that prohibits new product-test child spawns while permitting only scoped finalizer cleanup;

`go` is true only when every implemented hard assertion, sanitization assertion, cleanup, and post-state check is true. Any failure writes a sanitized no-go report and exits nonzero.

## Product contract and fail-closed limits

The verified public CLI cohort does not safely expose local-agent replacement, live handoff, deterministic upstream slow-consumer pressure, or direct upstream sequence-gap injection. Product integration must fail closed: local-agent writable control stays disabled without fresh supported identity evidence; bridge/socket loss requires full reacquisition; queue overflow releases; and any observed sequence gap, hierarchy/terminal/process mismatch, source-health mismatch, or policy mismatch blocks writes and closes. These limitations are not substituted with synthetic evidence.

V1 remains limited to Linux x64 and the exact reviewed protocol plus semantic fingerprint. It excludes GJC recognition, completion notifications, and Herdr workspace/pane/agent creation. Read-only output never obtains controller ownership. A zero controller exit code is insufficient: typed closure, contiguous sequence, bounded valid frames, stderr, release, and fresh identity checks are authoritative.
