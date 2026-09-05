# Custom terminal agents

The installation owner can opt in to detection of additional, already-running
CLI processes with `CHATMUX_CUSTOM_TERMINAL_AGENTS`. Set it in the ChatMux server's
environment (or its existing `.env` configuration), then restart ChatMux. Configure
each fleet installation locally; a hub does not send detection rules to peers.

```dotenv
CHATMUX_CUSTOM_TERMINAL_AGENTS='[{"command":"my-agent","argv":["chat"]},{"command":"node","argv":["/opt/my-agent/cli.js","chat"]}]'
```

This setting does not launch a command. Start the CLI yourself in tmux as usual.
Custom matches use the existing `shell` row and verified, attach-only terminal.
They do not acquire a provider name, custom display label, transcript mapping,
SDK integration, structured composer, native resume, or approval parser. Answer
prompts directly in the attached terminal. Existing built-in agent detection,
including GJC's separate lane and SSH, always takes precedence.

## Configuration contract

- An unset value or `[]` disables custom detection and preserves current behavior.
- The value must be a JSON array of at most 16 objects, totaling at most 8 KiB
  in UTF-8. Each object must contain exactly `command` and `argv`.
- `command` is a case-sensitive executable basename or absolute POSIX path,
  at most 256 ASCII characters. A basename matches only the complete basename
  of argv[0]; an absolute path must equal argv[0] exactly. Relative paths,
  empty path components, and `.`/`..` components are invalid.
- `argv` is the **complete** argument list after argv[0], containing zero to 16
  tokens of at most 256 ASCII characters each. Tokens match by exact value,
  position, and count. `[]` requires no arguments; it is not a wildcard.
  For example, `["chat"]` does not match `chatty`, `--mode=chat`, or `chat --quiet`.
- Command characters are letters, digits, `_`, `.`, `+`, `-`, and `/`.
  Argument tokens additionally allow `:`, `@`, `=`, `,`, and `%`. Whitespace,
  control characters, quotes, backslashes, globs, and shell substitutions are
  unsupported. There is no regex, glob, shell evaluation, or PATH lookup.
- Shells and launch wrappers such as `sh`, `env`, `sudo`, `npm`, and `npx` cannot
  be configured as agents. An interpreter such as Node or Bun must name an
  absolute script path as its first argument; code-evaluation flags are rejected.
- Malformed, oversized, duplicate, or unsupported entries disable the whole
  custom rule set. Built-in discovery continues. Configuration and process argv
  are never logged or added to public descriptors.

## Process evidence and terminal safety

Custom detection currently requires Linux procfs. The server reads only bounded
`cmdline` and `stat` records for candidate PIDs already present in its process
snapshot; it does not enumerate directories or search executables/transcripts.
At most 128 candidate PIDs are considered per scan. Records may contain at most
8 KiB; one extra byte is read to detect oversized records. Other platforms retain
the existing shell fallback.

Only the pane root or the sole direct child of its interactive shell can match.
Multiple shell children, including pipelines or unrelated background jobs, keep
the ordinary shell representation. Exact NUL-delimited argv must match a rule,
the process must own the terminal foreground group, and shell/child terminal and lineage evidence must
agree. Process identity is checked around the argv read. Background processes,
nested workers, ambiguous siblings, unavailable evidence, and changed generations
do not become custom matches. There is no automatic wrapper unwrapping.

A match may add the observed process PID/start time to the shell row, but it is
display evidence, never action authority. The existing fresh provider verifier
continues to reject shell rows for provider actions. Terminal attachment still
requires the server-issued capability bound to the authenticated principal,
exact socket/session/window/pane, and pane generation. Stale or altered targets,
protected `company*` panes, and ChatMux's own pane are rejected by the existing
attach checks. An attached shell terminal follows that pane's lifetime, including
jobs started or stopped inside it; custom detection does not turn the terminal
capability into a provider-session capability.

These rules implement the opt-in command/argv item in [ROADMAP.md](ROADMAP.md).
The existing [fleet contract](FLEET-FEDERATION-RFC.md),
[discovery contract](P2-DISCOVERY-STREAM-RFC.md), and
[approval fallback](M5B-APPROVAL-CONTRACT.md) remain authoritative for controls.
