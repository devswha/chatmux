# Explicit local tmux sockets

ChatMux can discover coding-agent panes across a small, owner-configured set of
local tmux servers. With `CHATMUX_TMUX_SOCKETS` unset or empty, it keeps the existing
unqualified `tmux list-panes` selection, including inherited tmux environment
behavior. It does not search socket directories or create tmux servers or agents.

## Configuration

Set `CHATMUX_TMUX_SOCKETS` in the existing server environment: the checkout's `.env`
for development, or the managed installation's `chatmux.env` selected by
`CHATMUX_ENV_FILE`. Restart ChatMux to load an edited environment file. Existing
tmux sessions continue running independently.

```dotenv
CHATMUX_TMUX_SOCKETS=[{"name":"default"},{"name":"work"},{"path":"/run/user/1000/agents.sock"}]
```

The example is an environment-file line with an unquoted JSON value, accepted by
both the managed runtime and Node’s development environment-file loader. For a
shell `export`, quote the whole JSON value with single quotes.

The value is one JSON array. Every entry has exactly one field:

| Entry | Selection | Requirements |
|---|---|---|
| `{"name":"work"}` | `tmux -L work` | 1–64 ASCII letters, digits, `_`, `.`, `-`; first character must be a letter, digit or `_` |
| `{"path":"/absolute/agents.sock"}` | `tmux -S /absolute/agents.sock` | Absolute, normalized path, at most 4,096 UTF-8 bytes; no control characters |

An explicit list **replaces** the implicit selection. Include `{"name":"default"}`
if that server should remain visible. There must be 1–8 entries and at most 32 KiB
of encoded configuration. Empty arrays, malformed JSON, extra fields, duplicate
entries and names resolving to the same path as another entry are rejected as a
whole. Invalid configuration does not fall back to another server.

Named sockets use the service account's UID and `TMUX_TMPDIR`, or `/tmp` when that
variable is unset. `TMUX_TMPDIR` must identify an existing absolute directory;
path lists, tilde expansion and custom compiled socket-directory layouts are not
inferred. Use an exact `path` entry for those layouts. Explicit selection ignores
inherited `TMUX` for choosing a server.

The existing Unix socket must belong to the account running ChatMux. Socket files
and their paths must be canonical: symlink socket leaves or symlink path aliases
are refused. A missing socket, permissions failure, unexpected reported socket
path, or socket replacement during inspection makes that entry unavailable.
Nothing creates or repairs sockets automatically.

## Identity and failures

The existing `socketPath + sessionId + windowId + paneId` identity is preserved.
Two servers can both have `$0/@0/%0` and a session named `work`; those are different
panes. Synthetic idle GJC row IDs use a SHA-256 digest of length-prefixed UTF-8
fields from that complete identity and retain
the `idle-gjc:` prefix, so equal labels and pane IDs cannot overwrite each other.
This changes temporary idle row IDs once on upgrade; provider transcript IDs do
not change. Working-directory matches never authorize actions.

Each capture records separate, server-private outcomes for the configured sockets.
A failed socket contributes no fresh panes. If any socket fails, aggregate
freshness is unavailable. The current external/live adapters conservatively
retain the previous display rows for the entire lane; the existing lane health
policy reports sustained failure after 30 failed ticks. Healthy-socket display
updates and fresh agent actions can therefore be delayed until every configured
socket is readable again. Missing sockets are not reported as confirmed session
termination. A successful empty capture is different: normal missing-row grace
can remove old rows.

Retained rows cannot authorize fresh actions or mint new shell/SSH attach
capabilities. Actions recheck exact inventory membership and current socket
ownership/filesystem generation along with the existing pane, process and provider
checks. Socket evidence follows verified targets, attach capabilities and cached
terminal leases only in server memory. Reconnecting a leased terminal rechecks its
original pane generation, socket ownership and inventory membership before replay
or PTY adoption. A matching lease can outlive the initial capability's expiry;
missing or changed proof refuses the reconnect without stopping the tmux jobs.
Replacing a socket at the same path, even with matching pane IDs, invalidates old
targets and leases. Existing tmux multi-command operations still have their
documented race between the final check and command execution; this feature does
not make those operations atomic.

## Cost, privacy and verification

A shared full host capture starts at most K `tmux list-panes` commands and one
`ps` command, where K is the configured socket count. A lightweight presence
capture starts at most K tmux commands and no `ps`. The existing collector and
in-flight sharing keep discovery cost independent of browser count. Each
observation child has a four-second timeout and an 8 MiB output bound. Cancellation
terminates only those observation children. Filesystem waits also have a four-second
logical deadline and support cancellation. At most 16 filesystem operations may
remain outstanding; timed-out syscalls retain their slots until they actually
finish. Captures from a changed configuration drain before another generation
starts, so configuration churn cannot multiply concurrent capture commands.

Configuration, raw selector values, socket outcomes and filesystem evidence are
server-private. Public diagnostics retain closed codes and counts; command
metrics count `tmux list-panes` without storing `-L`/`-S` values. Fleet descriptors
and host routing follow the existing Fleet contract.

The normative contract is [P2 RFC §4.1.1](P2-DISCOVERY-STREAM-RFC.md#411-explicit-local-tmux-socket-inventory-rev3-normative).
Selector behavior was checked against upstream tmux 3.5a's `tmux(1)` options and
`tmux.c:make_label`, then exercised with isolated real tmux 3.5a servers. Focused
regressions live in `host-discovery-snapshot.service.test.ts`,
`local-tmux-discovery.service.test.ts`, and `explicit-tmux-sockets.test.ts` under
`server/modules/providers/tests/`. They cover duplicate IDs, partial failure and
retention, configuration rejection/change, unavailable ownership evidence,
replacement, fresh-action/capability refusal, bounded output, and cancellation.
