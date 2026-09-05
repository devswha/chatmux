# Owner diagnostics API

`GET /api/settings/diagnostics` is a local, display-only settings endpoint.
It runs the existing browser authentication middleware and fleet owner check:
password-authenticated owners, Tailscale `owner`/`local`, or an implicit owner
on a loopback connection in `none` mode. An absent principal returns 401;
an authenticated non-owner returns 403. No client-supplied role, address,
refresh flag, session identity, or revision grants access. Every response,
including authentication rejection and failures, has `Cache-Control: no-store`.
The route is mounted before generic `/api` middleware so rejection responses
also receive that header. `/health` is unchanged.

The schema is defined in `shared/diagnostics.ts`. One service instance caches
the projected summary for 2 seconds, across callers. Reading or refreshing it
never calls discovery `tick`, `ensureFresh`, `forceRefresh`, filesystem APIs,
tmux, provider processes, watcher lifecycle methods, or action verifiers. It
does not activate idle discovery. It owns no timers or listeners, and performs
no persistence or logging. Provider failures are converted to fixed unavailable
states; an unexpected route-level failure returns 503 `diagnostics_unavailable`.

Fields are explicitly constructed from existing cached metadata:

- Collector timer/active/in-flight/disposed state; cached observation age;
  age of the last full scan where both lanes succeeded; lane result and
  consecutive failure counts. Observation freshness uses 30 seconds; bootstrap
  with no observation is `waiting`, never healthy. An observation can be recent
  while a lane is failing. Cheap host observations do not reset full-scan age.
- First 1,000 retained discovery rows, counted by lane and stale presence, plus
  counts of the seven allowlisted `ProviderConnectionIssue` codes. Truncation is
  explicit. These counts describe retained rows, not lifetime failure events.
- Existing GJC watcher failure/degraded/watch-limit signals. The accessor does
  not establish watcher liveness, so zero failures is `no_failures_reported`.
- Optional downstream indexing counters from `getSessionIndexingDiagnostics()`:
  pending files, active operations, their configured limits, active reconciliation
  steps, providers awaiting or undergoing reconciliation, and cumulative overflow
  and failure totals. The service explicitly projects these numeric fields; it
  never enumerates queued paths or invokes a scheduler operation. Missing, failed,
  or invalid counters are `null`, not zero. Admission is `accepting`, `closed`, or
  `unavailable`; an accepting queue can be idle or paused during startup and does
  not establish watcher or agent liveness. Initial bulk synchronization is excluded.
- Node's platform `performance.eventLoopUtilization()` cumulative active share
  since process start, rounded to four decimals. This is not CPU load, event-loop
  delay, or a current latency measure. Sampling creates no histogram or timer.

Ages are capped at seven days; counters at 1,000,000. Invalid/future observation
times yield unknown age, not fresh health. Summaries include their capture time
and cache TTL. The browser loads once per tab mount and offers a manual refresh;
it does not poll, persist results, or send scans/restarts/agent inputs. Requests
are aborted on unmount or after 10 seconds. English and Korean strings are
provided; other locales use the existing English fallback.

Never add object spreads of provider objects, raw errors, paths, command argv,
transcripts, socket/pane/process/session identities, labels, credentials, or
tokens to this payload. These diagnostics cannot authorize or identify an action
target. Recovery guidance preserves exact-identity checks and points users to
verified terminal attach or their existing terminal when binding is uncertain.

## Indexing bounds and recovery I/O

The downstream scheduler retains at most **64 pending file entries per provider**
(**448** across seven providers), with at most **four active operations total**
and **one active operation per provider**. A single scheduling timer serves these
queues. Provider queues reserve their own capacity and receive turns in round
robin order; ready file events alternate with recovery steps within a provider.
Repeated events for one file coalesce, including one pending trailing update
while it is active. Debouncing uses 150 ms with a 1,000 ms maximum coalescing
window; waiting for capacity can delay actual execution beyond that window.
GJC's upstream client has its separate existing **4,096-path** queue.

Overflow retains a provider-level recovery obligation instead of another list of
paths. Recovery uses a cursor-independent streaming walk, yielding after each
indexed file. A gap arriving during a pass survives as a follow-up pass. Errors
retry no faster than 60 seconds between pass starts. This bounds admission and
concurrency, **not total I/O**: a gap or repeated recovery failure can reread
historical transcripts. Recovery neither reads nor advances the shared scan
cursor. GJC receipt roots are excluded and Pi subagent directories deeper than
`root/project` are pruned before opening; receipt events only invalidate discovery.

The 60-second periodic fallback is separate: **only OMP and OMO** retain their
existing provider reconciliation, with the shared cursor and pending-file rules.
Historical files before that cursor are filtered before parsing. Post-cursor or
pending files can still be read again as before. Claude, Codex, Cursor, OpenCode,
and GJC have **no periodic indexing pass**; their watcher events, reported gaps,
and applicable watcher restart recovery remain the triggers. Incremental errors
retry incrementally, never silently escalating to a full historical scan.

The API uses the same two-second cache for these counters. `overflowed` counts
rejected file events, not distinct lost files; `failures` counts failed file or
reconciliation callbacks, not consecutive failures. Totals reset when the
scheduler is recreated and are displayed capped at 1,000,000. `closed` can coexist
with active work draining, while `accepting` is not a progress or health guarantee.
Shutdown aborts pending/recovery work and drains active callbacks; provider code
without cancellable I/O must finish before draining completes. Initial bulk
synchronization and provider-internal work are outside the downstream limits.

Focused checks use the existing test runner's `runTests` with
`server/tsconfig.json` for this module's tests and
`providers/tests/discovery-collector.service.test.ts`, and `tsconfig.json` for
`DiagnosticsSettingsTab.test.tsx` and `DiagnosticsSettingsTab.mounted.test.tsx`.
Use `npm run verify` and the repository CUA harness for full repository and
desktop/mobile browser regression checks.
