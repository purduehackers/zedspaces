# Multiplayer: reuse Zed, keep the sandbox as host

Investigation, 2026-09-06. **Not implemented.** This proposes a new lane; the
single-client safety rules remain in effect until the replacement is tested.

Zed already supplies the hard editing machinery: replica-tagged operations in
`zed/crates/text`, `BufferStore::handle_update_buffer` and per-peer buffer
snapshots in `project/src/buffer_store.rs`, and the `JoinProject`,
`AddProjectCollaborator`, `UpdateBuffer` and worktree protocols. Its collaboration
join path assigns a unique replica and tracks collaborators. Reuse these, not a
second CRDT or filesystem-watcher-based synchronization scheme.

Why takeover cannot just be deleted:

- `apps/web/lib/connect.ts` arbitrates one holder; `schema.ts` enforces one open
  session per workspace with `sessions_open_idx`.
- `remote_server/src/serve/session.rs::SessionBroker` owns one connection, epoch,
  replay queue and watermark.
- `HeadlessProject` uses one RPC session and `REMOTE_SERVER_PEER_ID`.
  `reset_for_new_client` discards buffers/worktrees; a participant joining must
  not reset the project. Its buffer-event forwarding sends only locally
  generated operations, not edits received from another browser.
- `Project::replica_id` gives every remote-development client the same
  `ReplicaId::REMOTE_SERVER`; concurrent editors need distinct IDs.
- `remote_server/src/client_state.rs` stores one layout database per workspace.
  `title_bar/src/collab_web.rs` currently omits collaborator UI entirely.

Recommended implementation order:

1. Build a sandbox-owned project hub with per-peer RPC routing, replica IDs,
   snapshots and operation broadcasts, reusing Zed's existing protocol and merge
   code. The VM is the host, so closing the first tab cannot end collaboration.
2. Add anonymous participant identity (stable browser ID, display name/color),
   separate connection IDs and reconnect queues. Scope saved layouts to each
   participant. Keep internal signed tokens, origin checks and rate limits.
3. Change the Drizzle/Turso session index and arbitration to permit participants;
   retain same-tab reconnection and expire only the connection that leaves.
   Any active participant keeps the VM alive. Restore Zed's cursor/selection
   presence and a small participant list, without calls or screen sharing.
4. Keep repository, buffers and language servers shared. Default to separately
   owned terminals/layouts; terminal sharing can be a later explicit action.
   All participants still have the existing shared workspace's permissions.

First acceptance gate: two browsers concurrently edit the same buffer, observe
each other's edits/cursors, save identical expected text, and independently
reload/reconnect without takeover or losing dirty edits. Then cover a slow peer,
duplicate/replayed operations, joins during edits, terminal ownership and
stop/resume persistence. Do not ship by weakening the current singleton check.

The complete upstream `collab` service is not a drop-in fit: its production
dependencies include SeaORM/SQLx Postgres and LiveKit. The
[hosted collaboration UI also requires sign-in](https://zed.dev/docs/collaboration/overview).
Keep the existing Vercel Sandbox + Drizzle/Turso architecture; adapt the useful
project protocol instead of adding that account/channel/call stack.

## WebRTC / P2P option

WebRTC data channels can carry the same Zed operations; the CRDT does not require
WebSockets. However, P2P still needs
[signaling and ICE/STUN/TURN connectivity](https://webrtc.org/getting-started/peer-connections),
plus participant IDs, initial snapshots, replay and recovery. It does not fix
the single-replica and single-session assumptions above. A browser-hosted star
also needs host transfer when that tab closes; a mesh adds per-peer connections.

For the first version, relay operations over each browser's existing WebSocket
to the sandbox. Files, Git, language servers and terminals already live there,
so the VM must receive edits anyway. This recommendation is an architectural
tradeoff, not a claim that WebRTC cannot work. Consider P2P later if measured
edit latency warrants a direct fast path, or for optional voice/video; keep the
sandbox authoritative for project services and persistence in either design.
