# Fleet federation RFC

`shared/fleet.ts` is the normative wire-contract source. This RFC fixes its product
and security semantics. Later work MUST NOT widen the surfaces below without a new
RFC revision.

Revision 2 (2026-09-02): adds the catalog bound and the `omitted` snapshot marker
under "Closed protocol". Everything else is unchanged from revision 1.

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
  `127.0.0.1` or `[::1]` through an owner-managed SSH local forward. No automatic
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
