# Preserved Fleet/session work review — issue #131

Review date: 2026-09-06. Starting main:
`1c933a39e452b3936afc605173f8c384a565c2c0`.
Preserved branch tip: `103e70bb49aebd422107f0c0183af55768807ce4`
(`fix/chat-scroll-follow-tail`). This is a behavior review of its thirteen commits;
the branch is not an integration batch or a list of thirteen current defects.

## Dispositions

| Preserved commit | Current finding and disposition |
| --- | --- |
| `2084ad0` — follow tail | Already adopted and extended by #99. The current mounted `useChatSessionState.test.ts` covers delayed layout, manual detachment, and live-refresh reattachment. No second scroll implementation. |
| `53cf0dc` — only tmux rows / remove host filter | Not carried forward. Fleet RFC revision 2 retains a bounded recent-session catalog, including history, and explicit host filtering remains useful. Hiding all non-live history would change the shipped catalog behavior. |
| `5fa379b` — mapped pane transcripts | Keep verified terminal fallback. The public pane's provider-native ID is not proof of a unique app-session binding across providers. Do not infer a writable transcript from ID equality. Catalogued app-session rows continue to open their own host-qualified transcripts. |
| `c5b2636` — clear terminal before navigation | Reproduced and corrected in #135. Remote row activation now clears terminal/transcript takeover through the app-shell controller, including selection of an already-active route. |
| `b2e3fdc` — retain idle/uncatalogued transcripts | Do not synthesize missing catalog rows. The RFC explicitly limits omitted rows to the peer's direct UI. #135 additionally removes the fallback from a missing peer selection to the last local project/session. |
| `e957f21` — extra remote row controls | Not carried forward. Keep sidebar rows as target selectors and use the existing verified transcript/terminal control surfaces. No current defect requires the additional mutation entry points in that historical UI proposal. |
| `1d2fbf8` — transient GJC probes | Reproduced and corrected in #134. Both discovery classifiers exclude the exact `gjc skills` utility subcommand; native and Bun/Node interactive/resume forms remain supported. |
| `06875a1` — unchanged heartbeat | Reproduced and corrected in #134 for host-state frames. Identical descriptors preserve catalog identity; label, state, capabilities, and protocol changes still propagate. Full snapshots retain their existing replacement/resync semantics. |
| `b02502c` — catalog/watcher bounds | Session reads are already capped at 512, wire catalogs apply the RFC's priority/omission bounds, and #128 supplies bounded/fair indexing admission and recovery. Do not import a hard 100-project limit, blanket temporary-directory exclusion, or native-watcher rewrite limited to the current Codex year; those changes can omit legitimate data. Preserve the current historical-record coverage and recorded omitted-row policy. |
| `031b2c4` — remote project names | The current browser reads `projects[].displayName` from the owning catalog. `remoteRouteSelection.test.ts` verifies that name on the selected peer. A duplicate `projectName` metadata field has no required consumer; it is not added. |
| `da740ce` — OpenCode database watch | Recursive cache watching was reproduced. The direct-file-only historical approach also missed deletion/replacement events for an initially existing database. The correction keeps the parent directory, uses depth zero, and accepts only that root and its `opencode.db`. Real filesystem tests cover present/missing databases, change, removal, recreation, and excluded cache subtrees. |
| `7c9cf15` — long-lived reads | Superseded by #77. The current `FleetRequestLedger` evicts completed reads and terminal streaming operations immediately while retaining mutation results. Existing mutation-ledger tests cover in-flight coalescing and sustained traffic; do not reintroduce a read-result retention/eviction scheme. |
| `103e70b` — local-only API guards | Reproduced and corrected in #133 for ordinary file mentions, token usage, file links/editor, palette reads and Git actions, including stale callbacks/responses. The relay-file guard already exists through #111. The proposed extra identity route is unnecessary for this correction: the existing authoritative roster adopts the installation ID through `adoptLocalHostIdentity`. |

All six review groups in #131 have a disposition. Retained fixes are separate
changes based on main; the rejected UI/catalog proposals are not silently marked
as implemented. The preserved branch remains available for historical recovery.

## Verification evidence

- #133: two mounted regressions failed on the baseline; corrected full
  `npm run verify` passed 2,382 repository tests plus audit, type checks, Rust
  checks/tests, lint, identity, and build. See [local API evidence](README.md).
- #134: the probe and heartbeat regressions failed before correction; the
  125-test provider group and 13-test catalog group pass, with type checks/lint.
- #135: production sidebar/controller clicks reproduced retained terminal state;
  the 15-test navigation/sidebar group passes, with type checks/lint. See
  [navigation evidence](navigation.md).
- OpenCode: recursive-cache and direct-file replacement failures were observed;
  the corrected filesystem/watcher/indexing group passes 20 tests, with type
  checks/lint. No synchronizer cursor, provider scope, or tmux authority changes.

The browser evidence uses production components with synthetic data and no real
peer connections. It does not claim release-grade CUA, SSH installation, physical
phone validation, a new public release, or a running-service deployment. Every
retained change still goes through the required latest-main Node 22/24 and
canonical-bundle PR checks before squash merge.
