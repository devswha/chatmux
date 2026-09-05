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

Focused checks use the existing test runner's `runTests` with
`server/tsconfig.json` for this module's tests and
`providers/tests/discovery-collector.service.test.ts`, and `tsconfig.json` for
`DiagnosticsSettingsTab.test.tsx` and `DiagnosticsSettingsTab.mounted.test.tsx`.
Parent coordination owns full verification,
desktop/mobile browser evidence, and release/PR lifecycle.
