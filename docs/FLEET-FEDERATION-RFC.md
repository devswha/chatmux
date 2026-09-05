# Fleet federation RFC

`shared/fleet.ts` is the normative wire-contract source. This RFC fixes its product
and security semantics. Later work MUST NOT widen the surfaces below without a new
RFC revision.

Revision 2 (2026-09-02): adds the catalog bound and the `omitted` snapshot marker
under "Closed protocol". Everything else is unchanged from revision 1.

Revision 3 (2026-09-02): fixes how a peer answers a request whose handler fails
unexpectedly (under "Side-effect safety") and clarifies that request, response, and
event bodies are opaque JSON: only descriptor fields named by this RFC are parsed
as fleet enums. Everything else is unchanged from revision 2.

Revision 4 (2026-09-03): permits hub-managed SSH local forwards for enrollment, allowing the hub to create and supervise the tunnel while securely handling host keys and prohibiting password retention. Everything else is unchanged from revision 3.

Revision 5 (2026-09-04): adds bounded full-tool-output reads under the existing
`session.read` operation/capability. Other operations and descriptor fields are unchanged.

Revision 6 (2026-09-05): permits explicit, owner-requested bootstrap of a missing
remote ChatMux installation during SSH enrollment and bounded, owner-only
Tailscale candidate suggestions. These are hub-local setup surfaces, not new fleet
wire operations or remote administration capabilities.

### Full tool output

- The owner-only host-qualified tool-result endpoint MUST resolve the addressed
  installation and session; it MUST NOT fall back to the hub's matching local ID.
- `session.read` MAY use `{ read: "tool_result", toolId, offset, revision,
  deadlineAtMs }`. `toolId` is 1–500 characters without NUL, `offset` is a
  non-negative byte offset, and `revision` is null for the first read or the
  returned SHA-256 revision for subsequent reads.
- Responses carry `toolId`, `revision`, `content`, `isError`, `offset`,
  `nextOffset` and `totalBytes`. Each content chunk contains at most 8 KiB of
  complete UTF-8 characters, leaving JSON escaping/envelope headroom within the
  unchanged 64 KiB frame limit. `nextOffset: null` marks completion.
- A content revision is a read consistency marker, never action authority.
  A changed revision or invalid byte boundary MUST fail the read. The browser
  MUST verify the target, revision and offsets, and cancel/ignore responses
  after switching host/session/tool. It MUST NOT combine different revisions.
- Earlier peers may reject the new read selector using their existing closed
  error response. This is surfaced as unavailable full output, never a local
  fallback, protocol downgrade, or a reason to replay a mutation.

## Topology and authority

- A fleet MUST contain one designated hub and at most nine enrolled full peers (ten
  installations total). Every installation MUST retain its own tmux, provider,
  SQLite, PTY, updater, and direct recovery UI.
- Browsers MUST use the hub's same-origin surface only. The hub MUST dial peers
  directly. ChatMux MUST NOT operate a relay, signaling service, mesh, replicated
  database, consensus system, automatic failover, or second agent artifact.
- Discovery is display and routing data only. The owning peer MUST re-run its local
  lineage, protection, pane, and process-generation checks before every action.
  `VerifiedTmuxActionTarget` MUST NOT cross the protocol.
- Remote file/editor/Git/project mutation, peer administration, fleet updates,
  arbitrary command/argv/path RPC, remote plain-shell creation, and per-frame
  signatures are out of scope.

## Reachability and trust

- Direct peers MUST use HTTPS/WSS; Tailscale Serve is the default documented path.
  Plain `ws://` is valid only for a saved `ssh-loopback` peer targeting immediate
  `127.0.0.1` or `[::1]` through an owner-managed or hub-managed SSH local forward. No automatic
  downgrade is permitted.
- Each installation MUST own a durable random UUID and Ed25519 key pair. Hostname,
  URL, IP, label, tmux socket, and provider ID MUST NOT identify an installation.
- Enrollment MUST be owner-only. A peer token MUST be 32 random bytes, hash-only at
  rest, single-use, atomically consumed, and expire in ten minutes. Both sides MUST
  pin the other installation key; a peer MAY have only one active hub grant.
- `/fleet-ws` MUST reject browser origin headers, cookies, JWTs, and query
  credentials. After transport setup, peers MUST finish a five-second mutual-key
  challenge, negotiate a protocol/capability intersection, and supersede stale
  connection generations. TLS or the explicit SSH tunnel protects transport.

### Hub-managed SSH forwarding

- The hub MAY create, own, and supervise an SSH local forward when the owner explicitly supplies an SSH target (`user@host[:port]`) and a one-time password through the fleet settings UI. The forward targets the remote installation's loopback fleet listener (default `127.0.0.1:3001`). Plain `ws://` remains valid ONLY for the resulting `127.0.0.1` or `[::1]` loopback URL.
- The password is handshake-only transient input. It MUST NOT be persisted, logged, or retained beyond the SSH authentication attempt. Enrollment metadata stores only the SSH target, the stable local port, and host-key material, never credentials.
- On first enrollment the hub installs a dedicated fleet-tunnel Ed25519 public key into the remote account's `authorized_keys` (idempotently, over the same owner-initiated SSH session), with explicit UI disclosure. Subsequent tunnel re-establishment authenticates with that key. The private key is stored only in the hub's private data directory like the installation key pair.
- Host keys use trust-on-first-use recorded in a hub-owned `known_hosts` file dedicated to fleet tunnels. A changed host key MUST fail the tunnel. Silent acceptance is forbidden.
- Removing the peer tears the tunnel down and best-effort removes the installed public key from the remote `authorized_keys`.

### Optional SSH bootstrap and candidate suggestions

- SSH reachability and the remote account MUST already be configured by the owner.
  The hub MAY bootstrap a missing ChatMux installation only when that enrollment
  request explicitly sets `installCli: true`. The UI MUST default this option off
  and disclose installation of a user service before submission.
- Bootstrap MUST use the canonical published installer and archive for the hub's
  exact stable version, over HTTPS, and request loopback port 3001 explicitly.
  It MUST NOT silently select another port or accept a browser-supplied version,
  installer URL, path, command, environment, or argument list. The canonical
  installer retains its platform, checksum, root-ownership, and service checks.
- A working remote CLI MUST be reused. A broken existing wrapper or managed root,
  including a symlink, MUST require manual recovery rather than bootstrap. Only a
  missing installation on Linux x86_64 is eligible. Recheck that absence immediately
  before installation and atomically claim the absent managed root with mode 0700;
  a competing claim MUST fail without running the installer. Bootstrap MUST NOT
  become an updater or repair operation.
- Authentication material MUST be removed after SSH authentication, before a long
  installation starts. The dedicated reconnect key MUST retain its command
  restriction. Installation has a 15-minute bound and MUST NOT retry automatically.
  A timeout or disconnect can leave a partial or completed installation: report a
  closed error and require owner inspection. Enrollment failure or peer removal
  MUST NOT uninstall ChatMux, remove its data, or terminate its tmux work.
- `GET /api/fleet/ssh-candidates` MAY return up to 128 sanitized, deduplicated
  Tailscale peer suggestions and an editable suggested SSH username to an
  authenticated owner only, with `Cache-Control: no-store`. It MUST reuse the
  bounded read-only local Tailscale status probe and degrade to manual SSH entry
  when unavailable. Candidates MUST NOT include keys, raw status, diagnostics,
  paths, or credentials, and MUST NOT become public fleet descriptors.
- A candidate's hostname, IP, online flag, or OS hint grants no authority and proves
  neither SSH reachability nor CPU compatibility. Enrollment MUST retain host-key
  checking, owner intent, installation-key pinning, and the normal peer checks.

## Identity, descriptors, and keys

- Session and project references MUST be `{ hostId, localId }`. Pane references MUST
  add lane and exact `TmuxPaneIdentity`; generation references MUST also add
  `{ pid, startedAtMs }`. `shared/tmux.ts` preserves the canonical local identity
  and adds host-only wrappers.
- IDs MUST be nonempty scalar strings of at most 256 characters; host IDs MUST be
  canonical UUIDs. Equal local IDs from distinct hosts MUST remain distinct.
- Browser/store/dedupe digests MUST SHA-256 UTF-8 fields prefixed by four-byte
  big-endian byte lengths. Delimiter concatenation is forbidden.
- Installation descriptors MAY expose only installation ID, public-key fingerprint,
  protocol versions, and capabilities. Peer descriptors MAY expose only host ID,
  display label, state, selected protocol version, and capabilities. Tokens, keys,
  URLs, paths, sockets, transcripts, and credentials MUST NOT be descriptor fields.

## Closed protocol

- The initial protocol version is `fleet/1`. Capabilities are `catalog.read`,
  `session.read`, `chat.control`, `prompt.respond`, `pane.read`, `terminal.attach`,
  `terminal.input`, `session.spawn`, `session.terminate`, and `completion.event`.
- Peer states are `connecting`, `syncing`, `online`, `degraded`, `offline`,
  `revoked`, and `incompatible`. Reconnect MUST start with a full snapshot; a gap or
  epoch change MUST enter `syncing`, suspend writes, and require resnapshot.
- Every frame MUST carry protocol version and positive connection generation.
  Requests MUST carry a unique request ID, allowlisted operation, exact target, and
  JSON body. Responses MUST bind the request and target and state `success` or
  `failure` plus side effect `none`, `applied`, or `possible`. Events MUST carry an
  event ID, allowlisted event, source host, and JSON body. Unknown fields and
  discriminants MUST fail closed.
- Operations are limited to catalog snapshot; session read/history/search; chat
  send/abort; prompt/approval read/respond; pane capture/attach/input/resize/
  interrupt/escape/terminate; process termination; and session spawn/termination.
  Events are limited to catalog snapshot/delta, host state, chat delta,
  prompt/approval change, pane output, and completion ready.
- Catalog frames MUST fit the frame bound like every other frame. A peer MUST
  publish a bounded catalog rather than its whole session table. Priority, highest
  first: present panes; the most recently active sessions with the projects they
  belong to; starred projects. Rows MUST leave in this order until the snapshot
  fits: projects no session references and nobody starred, stale panes, the least
  recently active sessions (a project whose last kept session leaves goes with it
  unless starred), starred projects without sessions, and present panes only as a
  last resort. When any row was dropped the snapshot MUST carry
  `omitted` with per-entity counts; when nothing was dropped the field MUST be
  absent so `fleet/1` hubs that predate it stay compatible. Omitted rows are
  reachable only through the owning peer's own UI; the hub MUST NOT infer, page, or
  request them. A delta that would exceed the bound MUST be replaced by a full
  snapshot at the same epoch and the next revision, which the hub MUST apply as a
  replacement of its current view.
- Errors are closed values for malformed frames, protocol/capability/identifier
  failures, unknown operation/event/error, host availability, uncertain command
  outcome, stale/altered/cache-full requests, deadline/frame bounds, and denial.

## Side-effect safety

Mutations MUST be at-most-once within one accepted connection generation. A peer
MUST retain at most 4,096 canonical mutation results and reject new mutations once
full. Mutations MUST NOT replay after disconnect; uncertainty is
`HOST_COMMAND_OUTCOME_UNKNOWN` until reconciliation and fresh user intent. A read
MAY retry once only after a newly authenticated, synchronized connection.

A handler failure the peer cannot map to a closed error is a per-request outcome,
not a connection outcome. The peer MUST answer that request with a failure and keep
the connection: `HOST_COMMAND_OUTCOME_UNKNOWN` with `sideEffect: "possible"` for a
mutation, `FLEET_UNKNOWN_ERROR` with `sideEffect: "none"` for a read. The failure is
the request's canonical result for duplicate detection. Closing the connection
remains reserved for protocol violations, where nothing about the peer's state can
be trusted.
