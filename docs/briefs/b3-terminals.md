# b3-terminals — Terminal protocol and remote PTYs

Plan of record: `BUILD-SPEC.md` §5.1 (lines 239-247) and Appendix A (lines 548-578). Zed fork at `zed/` (branch `zs`, upstream `c3cf80c`). All line numbers below were read from the files named; `zed-web` paths refer to the read-only community fork used only as evidence. Revision 2: incorporates the two adversarial reviews (§8). Revision 3: reconciled against the tech lead's binding decisions D1–D20 (`docs/briefs/DECISIONS.md`) and the sibling deltas addressed to this brief; every change is itemised in §9.

## 1. Goal

Make a terminal in a remote project run as a PTY inside `remote_server` and stream over Zed's existing remote protocol, instead of spawning a local `ssh -t` process (`crates/project/src/terminals.rs:608-642`). The server gets a process-level `PtyManager` (an `App` global that lives outside `HeadlessProject`, D3) that owns PTYs, keeps a 2 MiB scrollback ring per terminal, applies ack-based flow control, survives client disconnects **and fresh sessions**, and is torn down only on process shutdown or by an explicit `CloseTerminal`; the client gets a `TerminalType::Remote` whose bytes are parsed by the existing alacritty `Term` on the GPUI foreground executor (the new path spawns no OS thread and uses only foreground-executor primitives, which is what the browser build needs — crate-level wasm compilation of `terminal` is b6's job, see §7.2), while `terminal_view`, tasks and the agent panel keep using `Terminal` unchanged. SSH/WSL/Docker projects keep the current `build_command` path; only connections that report `supports_remote_pty()` (the WebSocket transport from W1, and — opt-in — the mock transport in tests) take the new path. Terminal restore is in scope (D4): the client persists remote terminal ids, titles and working directories in workspace persistence (`TerminalDb`, part of the D7 client-state image) and, on a fresh session, calls `ListTerminals`, reattaches the terminals the server still has with `AttachTerminal { from_offset: 0 }` into their restored panes, drops the rest and closes what nobody restored (§3.6a).

Ownership decision (D17; coordination with b6, §7.12): **b3 owns `crates/terminal/src/remote_pty.rs`, `TerminalType::Remote`, `PtyEvent`'s new variants, the `ExitStatus` type and the native import swaps to it (§3.5a)**; b6 keeps only the alacritty/libc/pty cfg gates, the wasm `TerminalBuilder::new` twin, the `SyncHandler` alias and `Terminal::expire_sync_update` (b6 §3.6), and has dropped its own remote-terminal surface (b6 rev. 2 records this in its §3.6, §4.2 and §8). Where the two briefs meet inside `terminal.rs`, b3 advances `Processor<SyncHandler>` in `process_remote_output` and calls `self.expire_sync_update(cx)` at its end (§3.5g).

## 2. Existing code that matters

Client: terminal creation in `project`
- `zed/crates/project/src/terminals.rs:2` — `use collections::HashMap` (= `FxHashMap`, a `std::collections::HashMap` with `FxBuildHasher`; it implements `Index` but not `IndexMut`, so `map[&k] = v` does not compile — use `get_mut`).
- `zed/crates/project/src/terminals.rs:27-29` — `Terminals { local_handles }`; gains the remote-terminal map.
- `zed/crates/project/src/terminals.rs:69` and `:319` — `is_via_remote` decides remote vs local; `:97`/`:332` drop the local cwd for remote terminals.
- `zed/crates/project/src/terminals.rs:99-105` and `:356-362` — remote shell comes from `RemoteClient::shell()`.
- `zed/crates/project/src/terminals.rs:110-111`, `:583-605` — directory env is already resolved on the server via `GetDirectoryEnvironment`; reused as-is. Note `environment.rs:259-261`: `remote_directory_environment` is short-circuited to an empty map under `cfg(any(test, feature = "test-support"))`, so no test exercises that round-trip.
- `zed/crates/project/src/terminals.rs:136` and `:378` — `env.extend(settings.env)` **moves `settings.env` out of `settings`** before the closure; `:406` moves `settings.shell` in the shell path. `settings` can therefore not be passed whole into a later call (E0382); only the remaining fields (`cursor_shape`, `alternate_scroll`, `max_scroll_history_lines`, `path_hyperlink_regexes`, `path_hyperlink_timeout_ms`) are, exactly as `TerminalBuilder::new` receives them at `:245-249` / `:414-418`.
- `zed/crates/project/src/terminals.rs:168-239` — the `(shell, env)` selection; `:172-205` is the remote branch that calls `create_remote_shell`; `:240-257` calls `TerminalBuilder::new(...)` and awaits the `Task<Result<TerminalBuilder>>`; `:258-280` subscribes, pushes the handle into `local_handles` (`:261-263`) and tracks the entity with `observe_release` (`:266-277`).
- `zed/crates/project/src/terminals.rs:284-312` — `create_terminal_shell` / `create_local_terminal` (`force_local = true`, "break out to a local shell"); `:312-451` `create_terminal_shell_internal` (same shape as tasks; `create_remote_shell(None, ...)` at `:404`).
- `zed/crates/project/src/terminals.rs:453-498` — `clone_terminal` uses `Terminal::clone_builder`, which would spawn locally; must divert for remote PTYs (`:461-463` already diverts tasks).
- `zed/crates/project/src/terminals.rs:517-577` — `exec_in_shell` still uses `build_command` (vim `:!`); returns `smol::process::Command`, which b5 lists as a wasm problem for this file (b5-wasm-build-env.md:58). See §3.6 and §7.7.
- `zed/crates/project/src/terminals.rs:608-642` — `create_remote_shell`: inserts Zed env (`:615`), calls `build_command(..., Interactive::Yes)` (`:622-629`), sets `title_override: "<host> — Terminal"` (`:632-638`). The new path reuses the env insertion and the title, not the command.
- `zed/crates/project/src/project.rs:230` (`remote_client`), `:245` (`terminals`), `:1413-1436` (`Project::remote`, reads `proto_client`/`path_style`/`connection_options`), `:1589` (subscribes to `RemoteClient` events), `:1394`, `:1638`, `:1929` (the three `Terminals { local_handles: Vec::new() }` literals), `:1654-1689` (server→client handler registration: `add_entity_message_handler(Self::handle_toast)` etc.), `:2315-2321` (`remote_id()` is `Some` for `Shared`/`Collab` — i.e. as soon as a remote project is shared into a room), `:3849-3870` (`on_remote_client_event`; `Reconnected` arm at `:3868` is empty — the reattach hook).
- Project id for requests to the remote server: every request sends `project_id: REMOTE_SERVER_PROJECT_ID` (43 sites, e.g. `environment.rs:271`, `worktree_store.rs:308`, `project.rs:4566`, `:4942`); `download_file` (`project.rs:3217`, `remote_id().unwrap_or(...)`) is the sole outlier. `HeadlessProject` subscribes only under id 0 (`headless_project.rs:280`), and `proto_client.rs:149-177` returns `None` (→ "no handler registered" error, `remote_client.rs:1863-1868`) when the `(type, id)` key is absent.
- `zed/crates/project/src/project.rs:5497-5510` — `handle_toast` is the model for an async entity message handler that does synchronous work inside `this.update`.
- `zed/crates/project/src/environment.rs:271-275` — precedent for polling an `AnyProtoClient::request` future on `cx.background_spawn` (the future is `Send`: `ProtoClient::request` returns `BoxFuture<'static, ..>`, `proto_client.rs:59-63`).

Client: `terminal` crate
- `zed/crates/terminal/src/terminal.rs:656-665` — `insert_zed_terminal_env` (TERM, COLORTERM, ZED_TERM...).
- `:669-679` — `Event` enum consumed by `terminal_view` (unchanged).
- `:724-738` — `TerminalBackendEvent` incl. `Title`, `Bell`, `Exit`, `ChildExit(ExitStatus)`; `:740-758` its hand-written `Debug` formats `ChildExit({status})` with **`Display`**, so any replacement `ExitStatus` type needs `impl Display`; `:760-762` — `enum PtyEvent { Event(TerminalBackendEvent) }` (the fork added `Bytes(Vec<u8>)` here: `zed-web/crates/terminal/src/terminal.rs:784`, handled at `:1725`).
- `:833-839` — `TerminalError { directory, program, args, title_override, source: std::io::Error }`, the error type `terminal_panel.rs:992` renders as `FailedToSpawnTerminal`.
- `:890-891` — scrollback constants; `:935-969` — `TerminalMode` (task/interactive, completion channel).
- `:971-974` — `TerminalBuilder { terminal, events_rx }`.
- `:996-1078` — `new_display_only_with_bounds` builds a `Terminal` with `TerminalType::DisplayOnly` and no PTY; template for `new_remote`.
- `:1080-1095` — `TerminalBuilder::new` signature; `:1110-1119` mode → `(task, completion_tx)`; `:1121-1134` env fix-ups (`SHLVL` removal at `:1124`, `LANG` fallback at `:1130-1133`, `insert_zed_terminal_env` at `:1135`); `:1196-1206` scrolling history choice; `:1210-1217` `new_term(...)` + events channel; `:1252-1298` PTY open + `spawn_event_loop`; `:1302-1371` `Terminal` literal (fields to replicate); `:1373-1392` activation-script writes via `write_to_pty`.
- `:1402-1465` — `subscribe`: the event loop is `cx.spawn` (foreground). **The first event is handled immediately and alone** (`:1405-1409`); then a batch loop collects up to 100 events / 4 ms (`:1417-1443`) with `Wakeup` coalesced into a flag (`:1428-1431`); if nothing else arrives, `events.is_empty() && !wakeup` breaks out (`:1445-1448`) — so a lone event handled by the immediate path never gets a batch-loop `Wakeup`. In the batch path the `Wakeup` is processed **before** the collected events (`:1450-1457`). The cap is an event count, not a byte count.
- `:1488-1499` — `PtyResources { Active(PtySender), Released }` and `enum TerminalType { Pty { resources, info }, DisplayOnly }` — the variant to add lives here.
- `:1501-1551` — `Terminal` fields: `term: Arc<AlacrittyTermLock>` (`:1507`), `output_processor: Processor<StdSyncHandler>` (`:1509`; b6 §3.6 changes the type parameter to its `SyncHandler` alias — `vte::ansi::StdSyncHandler` natively, `WebSyncHandler` on wasm — and adds `fn expire_sync_update(&mut self, cx: &mut Context<Self>)`, which this brief calls; D17), `is_remote_terminal` (`:1528`), `child_exited` (`:1536`, set only by `register_task_finished`), `event_loop_task` (`:1540`).
- `:1573-1605` — `TaskState`/`TaskStatus`.
- `:1617-1621` `process_pty_event`; `:1623-1700` `process_event` (`PtyWrite` → `write_to_pty` `:1658`; `Exit` `:1670`; `Wakeup` `:1674-1681` runs `detect_init_command_startup_marker` then emits `Event::Wakeup`, polls `PtyProcessInfo` only for `Pty`; `ChildExit` `:1696-1698` → `register_task_finished`).
- `:1706-1740` — `InternalEvent::Resize` resizes the PTY via `pty_tx.resize` (`:1722-1728`) then the grid (`:1730`).
- `:1961-1972` — `write_output`: feeds bytes straight into `output_processor.advance(&mut *term, ...)` on the caller's thread, then calls `detect_init_command_startup_marker()` and **emits `Event::Wakeup` itself** (`:1970-1971`); but first runs `convert_lf_to_crlf` (`:3254-3264`), which is wrong for PTY output (the line discipline already emits CRLF). `spawn_task_subprocess` (`:3333-3341`) likewise sends a `Wakeup` after every parsed chunk.
- `:2085-2106` `set_size` (dedups by cols/rows/cell size, `:2093-2100`); `:2110-2128` `write_to_pty` (matches `TerminalType::Pty`); `:2130-2134` `input` (sets `keyboard_input_sent`); `:2142-2169` init-command handshake — `start_init_command_startup_handshake` returns early unless `is_pty()` (`:2143`); `:2205-2207` `is_pty`; `:2209` `write_init_command_after_startup`; `:2236-2252` `write_input`.
- `:2411-2430` — `sync` locks the `FairMutex` on the render thread and drains `InternalEvent`s.
- `:2878-2887` — `working_directory()` is `None` when `is_remote_terminal`; `:2890-2899`, `:2907-2916`, `:2969-3019` (`title`), `:3021-3041` (`kill_active_task`), `:3044-3052`, `:3057-3077` (`release_pty_resources`: shutdown, SIGTERM, SIGKILL after 100 ms), `:3079-3091` (`pid`, `pid_getter`), and the exhaustive test-module match at `:5602-5610` — every `match &self.terminal_type` that needs a `Remote` arm.
- `:3093-3107` — `wait_for_completed_task` (used by `terminal_panel.rs:1389,1842`, `acp_thread/src/terminal.rs:441`, `debugger_ui/src/session/running.rs:1225-1229` (`.success()`), `agent_ui/src/conversation_view.rs:2171-2185` (`.success()`/`.code()`)).
- `:3109-3181` — `register_task_finished(Option<ExitStatus>)`: completion send, `child_exited`, task summary (`append_text_to_term`), `CloseTerminal` emission — for interactive shells it emits `CloseTerminal` **on every call** once `keyboard_input_sent` (`:3129-3136`), so a duplicate `ChildExit` must be filtered before reaching it.
- `:3187-3205` — `clone_builder` (must refuse for remote).
- `:3209-3246` — `task_summary` uses `ExitStatus::code()` and (`cfg(unix)`, `:3219-3222`) `signal()`; `(None, Some(signal))` prints "terminated by signal", `(Some(code), _)` prints the code — so a signalled child must be reported with `code: None`.
- `:3285-3382` — `spawn_task_subprocess`: precedent for driving `term` from a non-alacritty source with its own `Processor` and `Wakeup`/`ChildExit` events.
- `:3384-3391` — `Drop for Terminal` → `release_pty_resources`.
- `:3837-3877` — `init_terminal_test`: display-only terminal + `write_output`, the pattern for the client test; `:3888` `cx.executor().allow_parking()` is what tests driving real OS threads/PTYs need (the deterministic executor's `run_until_parked`/`advance_clock` never wait for real time; `scheduler/src/test_scheduler.rs:488-500` parks in real time only when parking is allowed).
- `zed/crates/terminal/src/alacritty.rs:49-52` — `AlacrittyTermLock = FairMutex<Term<ZedListener>>`; `:85-109` `PtySender` (notify/resize/shutdown via `Notifier`); `:120-131` `display_only_term_config` (`osc52: Osc52::Disabled`); `:133-143` `pty_term_config` (OSC 52 enabled); `:203-217` `spawn_event_loop` spawns alacritty's `EventLoop` thread (`:212`); `:302-330` maps `AlacTermEvent` → `TerminalBackendEvent` (title/bell/clipboard/etc. come from the `Term` parser, so they keep working for remote bytes); `:781-804` `clear_saved_screen`.
- `zed/crates/terminal/src/pty_info.rs:37` — `libc::tcgetpgrp` on the master fd (same trick the server uses for cwd/title); `:150-175` kill helpers; `:200-239` title polling — local only.
- `zed/crates/terminal/Cargo.toml` — no `target_family = "wasm"` cfg anywhere in the crate (grep: none); `alacritty_terminal`, `libc`, `sysinfo` are unconditional dependencies. The crate does not build for `wasm32-unknown-unknown` today; b6 gates it.
- `zed/crates/terminal_view/src/terminal_view.rs:1123` (`cx.observe(terminal, .. cx.notify())`) and `:1125-1235` — the only coupling to `Terminal` events (`Wakeup`, `Bell`, `BlinkChanged`, `TitleChanged`, `BreadcrumbsChanged`, `CloseTerminal`); the view repaints only on `Event::Wakeup` / entity notify; `:1129` `working_directory()`; `:1446-1447` `pid_getter()?` tolerates `None`; `:2268,2278,2310` and `terminal_element.rs:1361-1362` call `set_size`/`sync`. `:222-228` and `terminal_panel.rs:754`, `:948` call `create_local_terminal` ("new local terminal" actions). No change needed in `terminal_view`.
- `zed/crates/terminal_view/src/terminal_panel.rs:714-733`, `:889-896`, `:1112-1116` — tasks are spawned through `Project::create_terminal_task`; `:780` `terminals_for_task` finds task terminals via pane items; `:992`/`:1395` `FailedToSpawnTerminal`; `:1` and `:1825-1849` name `std::process::ExitStatus`.
- `zed/crates/terminal_view/src/persistence.rs` (544 lines) — the D4 restore hooks (§3.6a): `:60-85` `serialize_pane` skips task terminals (`:66-72`) and records item ids; `:87-171` `deserialize_terminal_panel(workspace, project, database_id, serialized_panel, terminal_panel, window, cx) -> Task<Result<usize>>`, whose `NoSplits` (`:96-107`) and `WithSplits` (`:108-170`) paths both end in `deserialize_terminal_views` (`:320-341`: `join_all` of `TerminalView::deserialize`, then `.filter_map(|item| item.log_err())` at `:338`); `:284-313` the blank-pane fallback (`create_terminal_shell(default_working_directory)` when a restored pane ends up empty); `:406-445` `TerminalDb::MIGRATIONS` (`terminals(workspace_id, item_id, working_directory BLOB, working_directory_path TEXT, custom_title TEXT)`, `STRICT`, `ON DELETE CASCADE` from `workspaces`); `:463-492` `save_working_directory`, `:494-500` `get_working_directory`, `:502-526` `save_custom_title` (the `INSERT .. ON CONFLICT (workspace_id, item_id) DO UPDATE` shape to copy), `:528-534` `get_custom_title`.
- `zed/crates/terminal_view/src/terminal_view.rs:233-241` `TerminalView::new(terminal, workspace, workspace_id, project, window, cx)`; `:299` `needs_serialize: false`; `:421-434` `set_custom_title`/`mark_needs_serialize` (the only setters besides the cwd-change trigger at `:1129-1133`, which never fires for remote terminals because `working_directory()` is `None`, `terminal.rs:2878-2887`); `:1849-1930` `impl SerializableItem for TerminalView` — `serialize` (`:1864-1895`) writes cwd and `custom_title` when `needs_serialize`, `deserialize` (`:1901+`) reads them and calls `create_terminal_shell(cwd)`. `workspace/src/item.rs:873` pushes an item into `Workspace::serialize_items` (`workspace.rs:7543-7572`) on any `ItemEvent` for which `should_serialize` is true; `workspace.rs:7280-7300` flushes every serializable item on workspace serialization/close.
- `zed/crates/terminal_view/src/terminal_panel.rs:300-345` `TerminalPanel::load` reads `TERMINAL_PANEL_KEY-<database_id>` from `KeyValueStore` and calls `deserialize_terminal_panel`; `:380-402` marks items that were not restored from the DB with `mark_needs_serialize`; `:1050-1078` `serialize` writes `SerializedItems::WithSplits`. `sqlez/src/bindable.rs:168-183`: `u64` binds as a bit-cast `i64` and reads back `as u64`, so uuid-derived ids above `i64::MAX` round-trip.
- `ExitStatus` consumers outside `terminal` (all use only `code()`/`success()`/`signal()`): `terminal_panel.rs:1`, `workspace/src/tasks.rs:1`, `workspace/src/workspace.rs:134,197` (`TerminalProvider::spawn` returns `Task<Option<Result<ExitStatus>>>`; `workspace` depends on `task` (`workspace/Cargo.toml:64`) but **not** on `terminal`), `acp_thread/src/terminal.rs:14,424,441,488,504-508,524,542`, `acp_thread/src/acp_thread.rs:36,2236`, `agent_servers/src/acp.rs:2109,2133`, `debugger_ui/src/session/running.rs:1229`, `agent_ui/src/conversation_view.rs:2171-2185`. The type must therefore live in a crate both `workspace` and `terminal` depend on: `task` (`crates/task/src/task.rs`).
- `zed/crates/agent/src/agent.rs:3924-3950` — tests asserting `has_active_pty_resources()`/`is_pty()` semantics for local terminals.
- `zed/crates/agent_ui/src/agent_panel.rs:2138-2160` — **production `is_pty()` consumer**: `write_terminal_init_command` writes the init command directly when `!is_pty()`, otherwise runs the marker handshake (`start_init_command_startup_handshake`) with a timeout fallback (`:2157-2160`).
- `std` wasm stub (`library/std/src/sys/process/unsupported.rs:201-216`): `pub struct ExitStatus();` whose `code()` is always `Some(0)`, with an `impl Display`.

Protocol
- `zed/crates/proto/proto/zed.proto:4-18` imports; `:20-27` `Envelope`/`payload`; `:514-519` last numbers (`GetOutgoingCallsResponse = 487; // current max`); `:522-547` reserved ranges. b4 (b4-proto-additions.md:120 and its §7 item 1) takes tags 500-514 (15 messages) and leaves 488-499 to this brief.
- `zed/crates/proto/proto/task.proto:18-31` — `Shell { System | program | WithArguments }`; `:44-50` `SpawnInTerminal`; `:52-60` `GetDirectoryEnvironment`.
- `zed/crates/proto/src/proto.rs:17` (generated include), `:22-411` `messages!` (remote-only messages are `Background`, e.g. `:376-377`, `:386`, `:406-410`), `:413-647` `request_messages!` (e.g. `:625`, `:644-646`), `:681-877` `entity_messages!({project_id, ShareProject}, ...)` — the last entry `GetRemoteProfilingData` at `:876` has **no trailing comma**.
- `zed/crates/proto/src/macros.rs:2-49` `messages!`, `:52-58` `request_messages!`, `:61-71` `entity_messages!` (reads `self.project_id`).
- `zed/crates/proto/build.rs` — compiles `proto/zed.proto` with include path `proto` through `prost_build` defaults, so a new file only needs an `import`; message-typed fields are generated as `Option<T>` whether or not they are marked `optional`.
- `zed/crates/rpc/src/proto_client.rs:58` `ProtoClient: Send + Sync` (so `AnyProtoClient` is `Send + Sync` already); `:117-147` handler-set registration (panics on duplicate), `:149-177` routing by `(entity TypeId, remote id)`, `:229-232` `AnyProtoClient::request`, `:450-484` `add_request_handler`, `:486-500` `add_entity_request_handler`, `:594-624` `add_entity_message_handler`, `:626-643` `subscribe_to_entity`.

Transport and server
- `zed/crates/remote/src/remote_client.rs:340-343` `RemoteClientEvent::{Disconnected, Reconnected}`; `:587` `reconnect`; `:714` `client.resync(..)` (sends `FlushBufferedMessages`, `:1910-1926`) runs inside the reconnect task **before** `Reconnected` is emitted at `:761` (`:726-762`), and `Reconnected` fires on every successful reconnect; `:946-948` `shell()`; `:964-977` `build_command`; `:1001-1007` `proto_client`/`connection_options`; `:1152-1177` `fake_server`/`fake_server_with_opts`; `:1185-1200` `connect_mock`; `:1329-1336` `RemoteConnectionOptions` (`Mock` under test-support); `:1619-1644` `RemoteConnection` trait (`build_command`, `shell`, `simulate_disconnect`).
- `zed/crates/remote/src/remote_client.rs:1683-1694` `ChannelClient` (unbounded `buffer` of unacked envelopes, `max_received: AtomicU32`); `:1745-1749` buffer pruned by `ack_id` on any incoming envelope (`while front.id <= ack_id`); `:1751-1769` `FlushBufferedMessages` re-sends the whole buffer; `:1780` `max_received.store(incoming.id)` — a last-write, not a max; `:1794-1799` a response is delivered through a barrier (`sender.send((incoming, tx)); rx.await`) that the requester releases when `request().await` returns the envelope (`:1971-1975`), so dispatch of the next incoming envelope waits for the requester to resume; `:1819-1859` each incoming message's handler future is spawned on the foreground executor in arrival order — handlers that do their work synchronously before the first `.await` therefore run in order (the test scheduler preserves per-session FIFO too: `scheduler/src/test_scheduler.rs:344-348`, `:606-617`); `:2031-2034` `send_dynamic` assigns the envelope id with `fetch_add` **outside** the `buffer`/`outgoing_tx` locks taken in `send_buffered` (`:2036-2043`), so two OS threads sending concurrently can enqueue out of id order — every existing store sends from GPUI foreground tasks, where this cannot interleave.
- `zed/crates/remote/src/transport/mock.rs:60-62` `MockConnectionOptions { id }` (constructed at 10 call sites across `sidebar`, `agent_ui`, `recent_projects`, `workspace`, `mock.rs:147`); `:141-181` `MockConnection::new`/`new_with_opts` build `MockRemoteConnection { options, server_channel, server_cx }` (`:162-166`) and register it; `:196-214` mock `build_command` returns a fake `"mock"` program; `:306-312` mock shell is `sh`. `fake_server` is also used by `zed/src/zed.rs:3049`, `collab` integration tests, `sidebar`, `extension_host`, `recent_projects`, `terminal_view.rs:2619-2627`.
- `zed/crates/remote/src/transport/ssh.rs:1909` (`exec env ...`) and `:1931-1933` — with no program the SSH path runs `{ssh_shell} -l` (login shell); the server replicates this for `Shell::System`.
- `zed/crates/remote_server/src/headless_project.rs:52-74` `HeadlessProject` fields (`session: AnyProtoClient` `:54`; `kernels: HashMap<String, Child>` `:73` is the precedent for server-owned processes); `:92-104` `new(HeadlessAppState, init_worktree_trust, cx: &mut Context<Self>)`; `:278-290` `subscribe_to_entity(REMOTE_SERVER_PROJECT_ID, ...)`; `:292-327` handler registration (`add_request_handler(cx.weak_entity(), ...)` and `add_entity_request_handler(...)`); `:921-1053` `handle_spawn_kernel`/`handle_kill_kernel` (spawn in handler, store child on `this`); `:1205-1221` `handle_shutdown_remote_server` calls `cx.shutdown(); cx.quit()`; `:1315-1333` `handle_get_directory_environment` uses `task::shell_from_proto`.
- `zed/crates/remote_server/src/server.rs:403-457` `start_server` (`cx.on_app_quit` at `:416-423`; idle exit `:443-452`); `:679-721` `HeadlessProject::new(...)`; `:731` `mem::forget(project)` — `Drop` never runs in production, so teardown must hook `on_app_quit`; no signal handler is installed anywhere in `server.rs` (a plain SIGTERM/SIGKILL of the server never reaches `on_app_quit`; the clean-quit path is b2's `request_quit`). `zed/crates/remote_server/Cargo.toml:78-80` has a `[target.'cfg(windows)'.dependencies]` block — the Windows build is real. `HeadlessAppState` (`headless_project.rs:76-84`) is constructed at 27 sites (`server.rs:709`, `remote_editing_tests.rs:228,4717`, `zed/src/zed.rs:3068`, `recent_projects/src/remote_connections.rs` ×5, `sidebar/src/sidebar_tests.rs` ×4, `collab/tests/integration/remote_editing_collaboration_tests.rs` ×9, plus the `transport/mock.rs:20` doc example), so the process-level manager D3 asks for cannot be a new `HeadlessAppState` field without touching every embedder; it is an `App` global instead (§3.8, §3.9). b2 already adds `on_shutdown_request` to that struct (b2 §3.10) and extracts the `cx.new` block of `:679-721` into a shared builder used by both `run` and `serve` (b2 §3.9, move-only), which is why this brief adds nothing to `server.rs` beyond `pub mod pty;`.
- `zed/crates/gpui/src/app.rs:78` `SHUTDOWN_TIMEOUT = 200 ms`; `:978-999` `shutdown` calls each quit observer synchronously and then `block_with_timeout(SHUTDOWN_TIMEOUT, join_all(futures))` natively; `:2352-2366` `on_app_quit(impl FnMut(&mut App) -> Fut + 'static)` — the closure receives only `&mut App`, so it must capture shared state itself.
- `zed/crates/gpui/src/app/entity_map.rs:818-825` `WeakEntity::new_invalid()` exists but is not used here (an `Option` is clearer).
- `zed/crates/remote_server/src/remote_editing_tests.rs:4695-4740` `init_test` (fake server + `HeadlessProject::new` + `connect_mock`; `:4732-4737` drops `headless` when the project is released — with the manager an `App` global (§3.8) that no longer drops the PTYs: `Drop for PtyManager` runs when the `TestAppContext` is torn down or when `PtyManager::install` replaces the global and the previous handles are gone), `:4746-4772` `build_project` (`Project::remote`), `:2780-2810` reconnect test pattern (`simulate_disconnect`, `fake_server_with_opts`, wait for `Reconnected`). `transport/mock.rs:158-181` `new_with_opts` registers a **new** server `ChannelClient` for every connect, so a second `connect_mock` can never reach the first `HeadlessProject`; fresh-session restore is therefore tested with the `test-support` hook `Terminal::forget_remote_transport` (§3.5g, §6) rather than with a second client.
- `zed/crates/task/src/task.rs:38` `TaskId(pub String)`; `:42-75` `SpawnInTerminal`; `:374-400` `shell_from_proto`/`shell_to_proto`. New home of `ExitStatus` (§3.5a).
- `zed/crates/scheduler/src/scheduler.rs:207-224` — `spawn_dedicated_os_thread` panics on wasm without `wasm-threads`; nothing in this workstream may spawn a thread on the client.
- Sibling briefs this one depends on (citations refreshed against their current revisions): b2-serve-mode.md `:374-382` (`ServeHooks { begin_fresh_session, session_attached, request_quit }` — D20 adds the session-detach hook this brief's `detach_all` hangs on), `:128` and `:955` (`begin_fresh_session` clears `buffer`/`max_received`/response channels, then `ChannelClient::reconnect` with a new channel pair; the former `reset_for_fresh_client` is gone), `:329,421,450` (`MAX_FRAME_BYTES` is imported from b1's `wire.rs`, b1:131, 16 MiB per D3), `:431` and `:746` (`is_input_envelope`: today excludes only `Ping`/`Ack`/`RemoteStarted`/`FlushBufferedMessages` and responses; D20 adds this brief's four exclusions, b4 §3.15 its three), `:350` and `:447-452` (`SessionKind { Fresh, Reconnect }` and the attach algorithm), `:456` (what persists across sessions: the process, the `App`, the server `ChannelClient`, `HeadlessProject` and its stores — reset via `reset_for_new_client`, b2:662-673, which must not touch the PTY manager), `:602-620` (`GpuiCommand { ResetForFreshSession, Quit }`, `GpuiHooks`); b1-ws-transport.md `:22` (`RemoteClientEvent::Reconnected` emitted at `remote_client.rs:761`), `:269` and `:598-599` (a stale epoch closes 4001; `reconnect && !HelloAck.resumed` — server restarted — is terminal, `Ok(90)`, never `Reconnected`; `reconnect:false` is a fresh session), `:199` (`impl RemoteConnection for WebSocketRemoteConnection`, which must override `supports_remote_pty` — §3.4, §7.18), `:452` (`display_name()`: URL host, else the D1 identity).

PTY layer comparison (server side)
- alacritty (read at the cargo git checkout `~/.cargo/git/checkouts/alacritty-20195d12a03fa0c5/4c12966/`; per D10 the crate the workspace builds is the vendored copy `zed/vendor/alacritty_terminal` — a path `[patch]` recorded in `zed/vendor/README.md`, owned by b6, not yet present in the tree — whose gate deltas do not move these lines): `alacritty_terminal/src/tty/unix.rs:144-159` `Pty` has private `child`, `file`, `signals` with only `&Child`/`&File` accessors; `:237-241` `new`; `:285-322` `pre_exec` (setsid, chdir, TIOCSCTTY, signal mask, SIG_DFL); `:334-343` master set non-blocking; `:355-367` `Drop` sends SIGHUP and waits; `:428-449` child exit detection needs the private SIGCHLD pipe polled; `event_loop.rs:46-55,205-206` the reader thread is welded to a `Term<T>` (parses into a grid — the server has no grid). Reusing it needs raw `waitpid` plus `polling`/`smol::Async` for the non-blocking fd.
- portable-pty 0.9.0 (`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/portable-pty-0.9.0/src/lib.rs:63` `PtySize`; `:88-107` `MasterPty::{resize, try_clone_reader, take_writer}` and `#[cfg(unix)] process_group_leader` (`:106-107` — the call itself must be cfg-gated); `:130-141` `Child::{try_wait, wait, process_id}`; `:150-157` `ChildKiller`; `:170-232` `ExitStatus { code: u32, signal: Option<String> }` — `signal()` is the `strsignal(3)` **description** (`:215-221`; on macOS `"Terminated: 15"`, on glibc `"Terminated"`, locale/libc dependent — verified with a C snippet on this machine) and `code` is forced to `1` for signalled children (`:223-226`); `:254` `PtyPair` "slave is listed first so that it is dropped first" — the parent must drop `slave` after spawning or the reader never sees EOF; `:271-285` `impl Child for std::process::Child` (`wait()` is std's `waitpid` made lossy); `unix.rs:250-271` pre_exec resets dispositions to SIG_DFL, clears the signal mask with `sigprocmask(SIG_SETMASK, empty)`, `setsid`, `TIOCSCTTY`; `cmdbuilder.rs:215-342` `CommandBuilder::{new, args, env, env_remove (:316), cwd}`). Blocking reader + wait threads, no `Term` coupling, already a workspace dependency (`zed/Cargo.toml:751`, used by `acp_thread`). The fork used exactly this (`zed-web/crates/zed_web_server/src/terminal_rpc.rs:102-107,179-224`). Decision: portable-pty on the server for the PTY/spawn; **exit status via `libc::waitpid` on unix** (§3.8); alacritty stays the client's grid/parser.

## 3. Change list (dependency order)

### 3.1 `zed/crates/proto/proto/terminal.proto` (new)
Full text in §4. Adds the 12 terminal messages and `TerminalExit`/`TerminalInfo`.

### 3.2 `zed/crates/proto/proto/zed.proto`
- After line 16 (`import "task.proto";`) add `import "terminal.proto";`.
- After line 519 add payload fields 488-499 and move the `// current max` comment (b4 takes 500-514; whichever lands second re-homes the comment — a collision fails at `protox::compile`):
  ```proto
  SpawnTerminal spawn_terminal = 488;
  SpawnTerminalResponse spawn_terminal_response = 489;
  TerminalInput terminal_input = 490;
  TerminalOutput terminal_output = 491;
  AckTerminalOutput ack_terminal_output = 492;
  ResizeTerminal resize_terminal = 493;
  CloseTerminal close_terminal = 494;
  TerminalExited terminal_exited = 495;
  ListTerminals list_terminals = 496;
  ListTerminalsResponse list_terminals_response = 497;
  AttachTerminal attach_terminal = 498;
  AttachTerminalResponse attach_terminal_response = 499; // current max
  ```
  and delete `// current max` from line 519.

### 3.3 `zed/crates/proto/src/proto.rs`
- In `messages!` (before the closing `);` at line 411) add, all `Background`: `SpawnTerminal, SpawnTerminalResponse, TerminalInput, TerminalOutput, AckTerminalOutput, ResizeTerminal, CloseTerminal, TerminalExited, ListTerminals, ListTerminalsResponse, AttachTerminal, AttachTerminalResponse`.
- In `request_messages!` (before line 647): `(SpawnTerminal, SpawnTerminalResponse)`, `(ListTerminals, ListTerminalsResponse)`, `(AttachTerminal, AttachTerminalResponse)`. `TerminalInput`, `AckTerminalOutput`, `ResizeTerminal`, `CloseTerminal`, `TerminalOutput`, `TerminalExited` are fire-and-forget messages (no response) so both sides can use `AnyProtoClient::send` from non-async code.
- In the `{project_id, ShareProject}` `entity_messages!`: add a trailing comma after `GetRemoteProfilingData` at line 876, then insert `SpawnTerminal, TerminalInput, TerminalOutput, AckTerminalOutput, ResizeTerminal, CloseTerminal, TerminalExited, ListTerminals, AttachTerminal` before the `);` at line 877.

### 3.4 `zed/crates/remote/src/remote_client.rs` and `transport/mock.rs`
- `RemoteConnection` trait (`:1619-1644`): add
  ```rust
  /// Whether the server hosts PTYs itself (terminal protocol messages) instead of
  /// needing a local `build_command` process. Defaults to false (ssh/wsl/docker).
  fn supports_remote_pty(&self) -> bool { false }
  ```
- `impl RemoteClient` next to `shell()` (`:946-948`):
  ```rust
  pub fn supports_remote_pty(&self) -> bool {
      self.remote_connection().is_some_and(|connection| connection.supports_remote_pty())
  }
  ```
- `transport/mock.rs`: the mock's default stays `false` (it is shared by `zed.rs`, `collab`, `sidebar`, `extension_host`, `recent_projects` tests, none of which register a `SpawnTerminal` handler). Add `remote_pty: bool` to `MockRemoteConnection` (`:162-166`, set `false` in `new_with_opts`), `fn supports_remote_pty(&self) -> bool { self.remote_pty }` in the `impl RemoteConnection` (near `:306`), and one new constructor `MockConnection::new_with_opts_and_remote_pty(opts, remote_pty: bool, client_cx, server_cx)` that `new_with_opts` delegates to. `MockConnectionOptions { id }` is unchanged (10 constructor sites). In `remote_client.rs` next to `fake_server`/`fake_server_with_opts` (`:1152-1177`) add the `cfg(any(test, feature = "test-support"))` twins `fake_server_with_remote_pty(client_cx, server_cx)` and `fake_server_with_opts_and_remote_pty(opts, client_cx, server_cx)`; only the new tests in §6 use them. b1's `impl RemoteConnection for WebSocketRemoteConnection` (b1-ws-transport.md:199) must override it to `true`; b1's current revision does not list the method, so this is a delta addressed to b1 (§7.18, §9) — without it every WebSocket project silently falls back to the `build_command` path and no terminal opens in the browser.

### 3.5 `zed/crates/terminal/src/terminal.rs` (client) and `zed/crates/task/src/task.rs`
Touched lines and new signatures:

a. Exit status type. Home: `zed/crates/task/src/task.rs` (both `workspace` and `terminal` depend on `task`; `workspace` cannot name `terminal::ExitStatus`):
```rust
#[cfg(not(target_family = "wasm"))]
pub type ExitStatus = std::process::ExitStatus;
/// `std::process::ExitStatus` is a unit stub on wasm32-unknown-unknown whose
/// `code()` is always `Some(0)`; this carries what the remote server reported.
#[cfg(target_family = "wasm")]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct ExitStatus { code: Option<i32>, signal: Option<i32> }
#[cfg(target_family = "wasm")]
impl ExitStatus {
    pub fn from_parts(code: Option<i32>, signal: Option<i32>) -> Self { Self { code, signal } }
    pub fn code(&self) -> Option<i32> { self.code }
    pub fn signal(&self) -> Option<i32> { self.signal }
    pub fn success(&self) -> bool { self.code == Some(0) }
}
#[cfg(target_family = "wasm")]
impl std::fmt::Display for ExitStatus { /* "exit code: {code}" | "signal: {signal}" | "unknown" */ }
```
`terminal.rs`: replace `process::ExitStatus` in the `use std::{...}` block (`:39-51`) with `pub use task::ExitStatus;`. In `remote_pty.rs`:
```rust
/// Builds the process-exit status reported by a remote PTY.
pub(crate) fn exit_status_from_remote(code: Option<i32>, signal: Option<i32>) -> ExitStatus
```
unix: `std::os::unix::process::ExitStatusExt::from_raw(signal.map(|s| s & 0x7f).unwrap_or_else(|| (code.unwrap_or(0) & 0xff) << 8))`; windows: `std::os::windows::process::ExitStatusExt::from_raw(code.map(|c| c as u32).or(signal.map(|s| 128 + s as u32)).unwrap_or(1))` (shell convention, so `task_summary` still reports failure); wasm: `ExitStatus::from_parts(code, signal)`. `task_summary` (`:3219-3222`): the `#[cfg(unix)] let signal = status.signal();` pair becomes `#[cfg(any(unix, target_family = "wasm"))]` so the wasm struct's signal is printed. Natively the alias is identical to today's type, so no consumer changes behaviour. b3 owns the one-line import swaps to it (b6 §7 item 5 leaves them to "the owning briefs" and b7 does not list them; sites verified with `grep -rn "process::ExitStatus" crates`): `workspace/src/tasks.rs:1` and `workspace/src/workspace.rs:134` → `use task::ExitStatus;`; `terminal_view/src/terminal_panel.rs:1` → `use terminal::ExitStatus;`; `acp_thread/src/acp_thread.rs:36` → `use task::ExitStatus;`; `agent_servers/src/acp.rs:2109,2133` (fully qualified `std::process::ExitStatus` and `::default()`) → `task::ExitStatus` (`agent_servers` already depends on `task`, `Cargo.toml:54`; the wasm struct derives `Default`). `acp_thread/src/terminal.rs:14,504,542` (its `use` plus the `portable_pty::ExitStatus::from` mapping) is b6 §3.7's. `debugger_ui/session/running.rs` and `agent_ui/conversation_view.rs` only call `.success()`/`.code()` on values and never name the type, so they need nothing. `util`, `cli`, `dev_container` and `git_ui_core` keep `std::process::ExitStatus` (they describe local processes and are outside the browser set). These swaps land with §3.5a in the same change so `cargo check --workspace` stays green natively and no browser-set crate is left importing the std type.

b. `PtyEvent` (`:760-762`):
```rust
enum PtyEvent {
    Event(TerminalBackendEvent),
    /// Raw bytes from a remote PTY. `offset` is the absolute position of `data[0]`
    /// in the terminal's output stream; `reset` means "clear the grid first".
    Output { offset: u64, data: Vec<u8>, reset: bool },
    /// The server no longer has this terminal (attach failed after a server
    /// restart). Detaches, prints a notice, completes the task with no status.
    RemoteLost,
}
```

c. New public transport contract and handle (new module `zed/crates/terminal/src/remote_pty.rs`, `mod remote_pty;` + `pub use remote_pty::{RemotePtyHandle, RemotePtyTransport, RemoteTerminalOptions};` next to `mod pty_info;` at `:4`):
```rust
/// Input side of a PTY hosted by the remote server. Only ever called on the
/// foreground thread, so no `Send`/`Sync` bound (the proto implementation is
/// `Send + Sync` anyway via `AnyProtoClient`).
pub trait RemotePtyTransport: 'static {
    fn terminal_id(&self) -> u64;
    fn input(&self, data: Cow<'static, [u8]>);
    fn resize(&self, cols: u16, rows: u16);
    /// Everything below `offset` has been parsed into the grid.
    fn ack(&self, offset: u64);
    /// Gap detected: ask the server to replay from `from_offset` (AttachTerminal).
    fn resync(&self, from_offset: u64, cols: u16, rows: u16);
    /// Kill the process group; the server keeps streaming until the child exits.
    fn close(&self);
}
#[derive(Clone)]
pub struct RemotePtyHandle { events_tx: UnboundedSender<PtyEvent> }
impl RemotePtyHandle {
    /// All return false once the terminal entity is gone.
    pub fn push_output(&self, offset: u64, data: Vec<u8>, reset: bool) -> bool;
    pub fn push_exit(&self, code: Option<i32>, signal: Option<i32>) -> bool;
    pub fn push_lost(&self) -> bool;
}
/// Everything `TerminalBuilder::new` derives from settings, minus the process
/// (same shape b6 §4.2 proposed; b3 owns it).
pub struct RemoteTerminalOptions {
    pub working_directory: Option<PathBuf>,        // spawn/restore cwd; kept in RemotePtyState for persistence (D4), not cwd_history (`:1351`)
    pub mode: TerminalMode,
    pub shell: Shell,                              // CopyTemplate only
    pub env: HashMap<String, String>,              // CopyTemplate only
    pub cursor_shape: SettingsCursorShape,
    pub alternate_scroll: AlternateScroll,
    pub max_scroll_history_lines: Option<usize>,
    pub path_hyperlink_regexes: Vec<String>,
    pub path_hyperlink_timeout: Duration,
    pub window_id: u64,
    pub path_style: PathStyle,
    pub title_override: Option<String>,
    pub activation_script: Vec<String>,
}
pub(crate) struct RemotePtyState {
    pub(crate) transport: Arc<dyn RemotePtyTransport>,
    pub(crate) working_directory: Option<PathBuf>, // persisted by terminal_view (§3.6a)
    pub(crate) next_offset: u64,     // next byte we expect / have fed
    pub(crate) acked_offset: u64,
    pub(crate) attached: bool,       // false after close()/exit/lost
    pub(crate) resync_pending: bool, // an AttachTerminal was requested for a gap
}
pub(crate) const REMOTE_ACK_THRESHOLD: u64 = 64 * 1024;
/// Max bytes of remote output parsed per foreground turn (subscribe's batch loop).
pub(crate) const REMOTE_PARSE_BUDGET: usize = 256 * 1024;
```

d. `TerminalType` (`:1493-1499`): add `Remote(RemotePtyState)`. Every exhaustive match listed in §2 (including the test module at `:5602-5610`, which gets `TerminalType::Remote(_) => "remote".to_string()`) gains an arm.

e. `TerminalBuilder::new_remote` (add after `new_display_only_with_bounds`, `:1078`), synchronous — no PTY to open:
```rust
pub fn new_remote(
    options: RemoteTerminalOptions,
    transport: Arc<dyn RemotePtyTransport>,
    background_executor: &BackgroundExecutor,
) -> (TerminalBuilder, RemotePtyHandle)
```
Body mirrors `:1110-1119` (mode → task/completion_tx), `:1196-1206` (history), `pty_term_config` (`alacritty.rs:133-143`, not the display-only config: OSC 52 must work), `new_term(&config, TerminalBounds::default(), events_tx.clone(), alternate_scroll)`, the `Terminal` literal at `:1302-1371` with `terminal_type: TerminalType::Remote(RemotePtyState { transport, working_directory: options.working_directory.clone(), next_offset: 0, acked_offset: 0, attached: true, resync_pending: false })`, `subprocess: None`, `is_remote_terminal: true`, `cwd_history: Vec::new()` (the `is_remote_terminal` branch at `:1351-1352`; the cwd is kept in `RemotePtyState` for persistence instead), then the activation-script writes exactly as `:1373-1392` (they go through `write_to_pty` → transport). The env fix-ups at `:1121-1134` are **not** replicated here: `SHLVL`/`LANG` are handled on the server (§3.8) and `insert_zed_terminal_env` by `project` (§3.6). Returns `(TerminalBuilder { terminal, events_rx }, RemotePtyHandle { events_tx })`.

f. `subscribe` (`:1402-1465`): in the batch loop (`:1426-1437`) add a byte counter: `PtyEvent::Output { data, .. }` → `parsed_bytes += data.len(); events.push(event); if parsed_bytes >= REMOTE_PARSE_BUDGET { break }` (chunks are ≤ 64 KiB, so at most ~320 KiB of VTE parsing per `terminal.update`; the outer loop continues after `yield_now`). After the `for event in events` at `:1455-1457` call `this.flush_remote_ack()`; in the immediate path (`:1406-1409`) call `flush_remote_ack()` after `process_pty_event`. No other change: `Output` events emit their own `Wakeup` (g).

g. `process_pty_event` (`:1617-1621`): add `PtyEvent::Output { offset, data, reset } => self.process_remote_output(offset, data, reset, cx)` and `PtyEvent::RemoteLost => self.process_remote_lost(cx)`, plus:
```rust
fn process_remote_output(&mut self, offset: u64, data: Vec<u8>, reset: bool, cx: &mut Context<Self>)
fn process_remote_lost(&mut self, cx: &mut Context<Self>)
fn flush_remote_ack(&mut self)
pub fn remote_terminal_id(&self) -> Option<u64>
pub fn remote_next_offset(&self) -> Option<u64>
pub fn is_remote_pty(&self) -> bool
pub fn remote_working_directory(&self) -> Option<&Path>   // RemotePtyState.working_directory; persisted by terminal_view (§3.6a)
pub fn title_override(&self) -> Option<&str>              // the `:1521` field; persisted as `remote_title` (§3.6a)
#[cfg(any(test, feature = "test-support"))]
pub fn forget_remote_transport(&mut self)                  // attached = false without close(): a client that vanished (fresh-session tests)
```
`process_remote_output` (no-op unless `TerminalType::Remote`): let `end = offset + len`. If `reset` → `clear_saved_screen(&mut self.term.lock())`, `reset_cwd_history()`, `next_offset = acked_offset = offset`, `resync_pending = false`. Else if `end <= next_offset` → return (duplicate replay). Else if `offset > next_offset` → **gap**: drop the chunk; if `!resync_pending` { `resync_pending = true; log::warn!(..); transport.resync(next_offset, cols, rows)` } (bounds from `last_content.terminal_bounds`); return — never clear the grid on a gap, only on a server `reset`. Otherwise `resync_pending = false`; feed `data[(next_offset - offset) as usize..]` with `self.output_processor.advance(&mut *self.term.lock(), ...)` (`output_processor: Processor<SyncHandler>` once b6 §3.6 lands; the call is identical natively) — no `convert_lf_to_crlf`; `next_offset = end`; if `next_offset - acked_offset >= REMOTE_ACK_THRESHOLD` → `transport.ack(end); acked_offset = end`. Then, exactly as `write_output` (`:1969-1971`): `self.detect_init_command_startup_marker(); cx.emit(Event::Wakeup);` — the immediate path in `subscribe` handles a lone chunk with no batch-loop `Wakeup`, and in the batch path the coalesced `Wakeup` runs before the events, so the marker scan must follow the parse here. Finally `self.expire_sync_update(cx)` (b6 §3.6; D17): a TUI that sent a synchronized-update begin (`CSI ?2026h`) whose end never arrives would otherwise leave the grid frozen until the next chunk (b6 §7 item 17); natively alacritty's event loop does this for PTY terminals, and nothing else does it for `output_processor`. `flush_remote_ack`: if `next_offset > acked_offset` → `transport.ack(next_offset); acked_offset = next_offset`. `process_remote_lost`: `attached = false`; `append_text_to_term("\r\n[remote terminal is no longer available]\r\n")`; `self.process_event(TerminalBackendEvent::Exit, cx)` (→ `register_task_finished(None)`: tasks finish with no status, `wait_for_completed_task` yields `None`, interactive tabs close only if input was sent — same as an ssh process dying today). `forget_remote_transport` (test-support only): sets `attached = false` on `TerminalType::Remote` **without** calling `transport.close()`, so a later drop sends no `CloseTerminal` — the server's view of a client that vanished without closing its tabs (page reload, crashed tab), which the fresh-session restore tests need (§6).

h. `process_event` (`:1623-1700`): `Title`, `Bell`, `ClipboardStore`, `PtyWrite` (DA/DSR responses) all originate in the shared `Term` parser (`alacritty.rs:302-330`) and are unchanged. The `ChildExit` arm (`:1696-1698`) becomes:
```rust
TerminalBackendEvent::ChildExit(exit_status) => {
    if let TerminalType::Remote(state) = &mut self.terminal_type {
        if self.child_exited.is_some() { return; }  // duplicate (attach replay after exit)
        state.attached = false;
    }
    self.register_task_finished(Some(exit_status), cx);
}
```
`RemotePtyHandle::push_exit` only owns `events_tx`, so this guard has to live here (`register_task_finished` re-emits `CloseTerminal` on every call for interactive shells, `:3129-3136`). The local PTY path is untouched.

i. `InternalEvent::Resize` (`:1714-1740`): after the `Pty` arm add `TerminalType::Remote(state) if state.attached => state.transport.resize(new_bounds.num_columns() as u16, new_bounds.num_lines() as u16)`.

j. `write_to_pty` (`:2110-2128`): add `TerminalType::Remote(state) if state.attached => state.transport.input(input)`.

k. `is_pty` (`:2205-2207`): `matches!(self.terminal_type, TerminalType::Pty { .. } | TerminalType::Remote(_))`. Consequence, stated explicitly: `start_init_command_startup_handshake` (`:2143`) no longer bails for remote terminals, so **remote task/agent terminals with an init command run the marker handshake over the wire** (`agent_panel.rs:2147-2160`) and `write_init_command_after_startup` (`:2209`) becomes reachable for `Remote`. That is the intended behaviour: the server PTY echoes the marker exactly like a local one, and the agent panel's timeout fallback (`:2157-2160`) covers a shell that does not. Integration test 13 pins it.

l. `foreground_process_command_name` (`:2890-2899`), `client_side_working_directory` (`:2907-2916`), `pid` (`:3079-3084`), `pid_getter` (`:3086-3091`): `TerminalType::Remote(_) => None`.

m. `title` (`:2969-3019`): `TerminalType::Remote(_) => "Terminal".to_string()` in the fallback match (the override set by `project` wins, as it does for ssh today).

n. `kill_active_task` (`:3021-3041`): `TerminalType::Remote(state) => state.transport.close()`. `attached` stays `true`: the server SIGTERMs the process group but keeps the entry and the stream open until the child exits, so post-SIGTERM output still arrives and `TerminalExited` completes the task (h flips `attached` then).

o. `has_active_pty_resources` (`:3044-3052`): true for `Remote(state)` when `state.attached`. `release_pty_resources` (`:3057-3077`): `TerminalType::Remote(state)` → if `attached` { `attached = false; transport.close()` }. `Drop` (`:3384-3391`) then closes the server PTY when the tab closes (a second `CloseTerminal` after exit is not sent because `attached` is already false); a disconnect never drops the entity, so the server terminal survives it. The grid is untouched by `release_pty_resources` (only `attached` flips and the transport is closed), so `acp_thread`'s read-after-release (`acp_thread/src/terminal.rs:476-489`, b6 §8 R2-12) keeps working for remote terminals; client test 10 asserts it.

p. `clone_builder` (`:3187-3205`): `if self.is_remote_pty() { return Task::ready(Err(anyhow!("remote terminals are cloned by Project::clone_terminal"))) }`.

### 3.6 `zed/crates/project/src/terminals.rs` (client)
- `Terminals` (`:27-29`):
  ```rust
  pub struct Terminals {
      /// Every terminal created by this project, including remote PTYs
      /// (`local_terminal_handles()` keeps its name; consumers only iterate it).
      pub(crate) local_handles: Vec<WeakEntity<terminal::Terminal>>,
      pub(crate) remote: HashMap<u64, RemoteTerminalEntry>,   // keyed by server terminal_id
      /// Fresh-session restore (D4, §3.6a): the server's `ListTerminals` inventory, fetched once by
      /// `TerminalPanel::load`; `restore_remote_terminal` takes entries out and
      /// `close_unrestored_remote_terminals` closes whatever is left.
      pub(crate) restorable: HashMap<u64, proto::TerminalInfo>,
  }
  pub(crate) struct RemoteTerminalEntry {
      /// `None` between SpawnTerminalResponse and `subscribe`; output queues in the handle meanwhile.
      pub(crate) terminal: Option<WeakEntity<Terminal>>,
      pub(crate) handle: RemotePtyHandle,
  }
  pub(crate) const INPUT_CHUNK: usize = 64 * 1024;
  /// Returned by `restore_remote_terminal` when the server no longer has (or has finished) the
  /// terminal; `terminal_view` maps it to "drop the restored item" (logged at info, §3.6a).
  #[derive(Debug)]
  pub struct RemoteTerminalGone(pub u64);   // `impl Display` + `impl std::error::Error` by hand: `project` has no `thiserror` dependency
  ```
- New transport impl (bottom of file):
  ```rust
  struct ProtoPtyTransport { client: AnyProtoClient, terminal_id: u64, executor: BackgroundExecutor }
  impl RemotePtyTransport for ProtoPtyTransport {
      // project_id is always REMOTE_SERVER_PROJECT_ID (HeadlessProject is subscribed
      // only under id 0; remote_id() becomes Some once the project is shared into a room).
      // input: for chunk in data.chunks(INPUT_CHUNK) { client.send(TerminalInput{..}).log_err() }
      //   — a bracketed paste of tens of MB would otherwise exceed b2's 16 MiB frame ceiling.
      // resize / ack / close: one fire-and-forget send each.
      // resync: executor.spawn(client.request(AttachTerminal{ terminal_id, from_offset, cols, rows }).map(|r| r.log_err())).detach()
      //   — the response is informational; the replayed TerminalOutput (and a re-sent
      //   TerminalExited) arrive through the ordinary handlers.
  }
  fn chunk_input(data: &[u8]) -> impl Iterator<Item = &[u8]>   // pure, unit-tested
  ```
- New `impl Project` method:
  ```rust
  fn spawn_remote_terminal(
      &mut self,
      remote_client: Entity<RemoteClient>,
      working_directory: Option<Arc<Path>>,
      task_id: Option<TaskId>,
      mut options: RemoteTerminalOptions,   // caller fills shell/env/mode/title_override and the settings fields
      cx: &mut Context<Self>,
  ) -> Task<Result<TerminalBuilder>>
  ```
  Reads `proto_client()`, `host = connection_options().display_name()` (for b1's WebSocket transport: the URL host, else the D1 identity `workspace_id` — b1 §4.1 `display_name()`), `insert_zed_terminal_env(&mut options.env, &AppVersion::global(cx))` (as `:615`), `cols/rows` from `TerminalBounds::default()` (the local path also opens at default bounds, `terminal.rs:1273`), `title = task label if task_id.is_some() else "<host> — Terminal"`. Spawned task:
  ```rust
  let response = client.request(proto::SpawnTerminal { project_id: REMOTE_SERVER_PROJECT_ID, working_directory, shell: Some(shell_to_proto(options.shell.clone())), env: options.env.clone(), cols, rows, task_id, title })
      .await
      .map_err(|e| terminal::TerminalError { directory, program, args, title_override, source: std::io::Error::other(e) })?;
  let id = response.terminal_id;
  // INVARIANT: the entry is inserted, and only then AttachTerminal is sent, inside
  // one synchronous update — no `.await` between the request returning and the
  // insert. The server spawns detached, so no TerminalOutput can precede the attach.
  let builder = project.update(cx, |this, cx| {
      let transport = Arc::new(ProtoPtyTransport { client: client.clone(), terminal_id: id, executor: cx.background_executor().clone() });
      let (builder, handle) = TerminalBuilder::new_remote(options, transport, cx.background_executor());
      this.terminals.remote.insert(id, RemoteTerminalEntry { terminal: None, handle });
      cx.background_spawn(client.request(proto::AttachTerminal { project_id: REMOTE_SERVER_PROJECT_ID, terminal_id: id, from_offset: 0, cols: cols as u32, rows: rows as u32 }).map(|r| r.log_err())).detach();
      builder
  })?;
  Ok(builder)
  ```
  Nonexistent cwd or program → the server's `spawn_command` error comes back as the request error and is wrapped in `TerminalError` so `terminal_panel.rs:992` renders the same `FailedToSpawnTerminal` as native. Trust: `working_directory` and `env` are client-controlled server paths/variables (path traversal, `LD_PRELOAD`); this matches `OpenBufferByPath` and BUILD-SPEC §10 (the token holder owns the sandbox) — no canonicalisation.
- Restore (D4; the `terminal_view` side is §3.6a). The subscribe/bookkeeping block at `:258-280` (and its twin at `:428-446`) is factored into `fn adopt_terminal_builder(&mut self, builder: TerminalBuilder, cx: &mut Context<Self>) -> Entity<Terminal>` — `cx.new(|cx| builder.subscribe(cx))`, the `remote.get_mut(&id).terminal = Some(..)` fill-in, the `local_handles` push and the `observe_release` that also removes the `remote` entry — so the three call sites share it. New `impl Project` methods:
  ```rust
  /// True when the remote connection hosts PTYs itself (§3.4); false for local/ssh/wsl/docker projects.
  pub fn supports_remote_pty(&self, cx: &App) -> bool
  /// One `ListTerminals`; stores the response in `terminals.restorable`. No-op (ready task) unless
  /// `supports_remote_pty`. A request error logs a warning and leaves `restorable` empty (nothing is
  /// restored and nothing is closed — the server keeps its terminals for the next open).
  pub fn fetch_remote_terminal_inventory(&mut self, cx: &mut Context<Self>) -> Task<()>
  /// Synchronous: takes `terminal_id` out of `restorable`; `Err(RemoteTerminalGone)` if absent, already
  /// attached, or `exit.is_some()` (an exited shell is closed on the spot with `CloseTerminal`). Otherwise
  /// builds `RemoteTerminalOptions { working_directory: working_directory.or(info.cwd), mode: interactive(),
  /// shell: Shell::System, env: default(), <settings fields as the shell path>, window_id, path_style,
  /// title_override: title.or(Some(info.title)), activation_script: vec![] /* never re-run on reattach */ }`,
  /// `TerminalBuilder::new_remote`, inserts the `remote` entry and sends
  /// `AttachTerminal { terminal_id, from_offset: 0, cols, rows }` in the same synchronous update (the spawn
  /// INVARIANT above), then `adopt_terminal_builder`. The replay carries the full ring (`reset: true` on the
  /// first chunk if the ring evicted) and, for a terminal that exited meanwhile, a `TerminalExited`.
  pub fn restore_remote_terminal(&mut self, terminal_id: u64, working_directory: Option<PathBuf>, title: Option<String>, cx: &mut Context<Self>) -> Result<Entity<Terminal>>
  /// `CloseTerminal` for every id still in `restorable` (exited shells, terminals whose tab was closed
  /// but never flushed to the image, terminals of a client that never came back), then clears it.
  pub fn close_unrestored_remote_terminals(&mut self, cx: &mut Context<Self>)
  ```
  `restorable` is filled only by `fetch_remote_terminal_inventory`, so a `Reconnected` (warm) never touches it and the reap can never close a terminal this client attached: `restore_remote_terminal` removes an entry before attaching, and `spawn_remote_terminal` ids are minted after the inventory was taken.
- `create_terminal_task` (`:64-282`): compute `let remote_pty = remote_client.as_ref().is_some_and(|c| c.read(cx).supports_remote_pty());` next to `:98`. In the closure at `:168-239`, before `match remote_client` at `:172`, add the arm `Some(remote_client) if remote_pty =>`: build `shell` exactly like `:173-194` (activation → `Shell::WithArguments { program: remote_shell, args: shell_kind.args_for_shell(true, arg), title_override: None }`; else `spawn_task.command` → `Shell::WithArguments { program, args }` or `Shell::System`), build `RemoteTerminalOptions { working_directory: None, mode: terminal_mode, shell, env, cursor_shape: settings.cursor_shape, alternate_scroll: settings.alternate_scroll, max_scroll_history_lines: settings.max_scroll_history_lines, path_hyperlink_regexes: settings.path_hyperlink_regexes, path_hyperlink_timeout: Duration::from_millis(settings.path_hyperlink_timeout_ms), window_id: cx.entity_id().as_u64(), path_style, title_override: None /* filled by spawn_remote_terminal */, activation_script }` (only the still-owned fields of `settings`; `settings.env` was moved at `:136`), then `return Ok(self.spawn_remote_terminal(remote_client, path, Some(spawn_task.id.clone()), options, cx))`. The closure's return type becomes `Result<Task<Result<TerminalBuilder>>>` for both arms (`TerminalBuilder::new` already returns a `Task`), so `:256-257` (`})??.await?`) is unchanged. After `cx.new(|cx| builder.subscribe(cx))` at `:259`: `if let Some(id) = terminal_handle.read(cx).remote_terminal_id() { if let Some(entry) = this.terminals.remote.get_mut(&id) { entry.terminal = Some(terminal_handle.downgrade()); } }`; the `local_handles` push at `:261-263` stays; in the `observe_release` closure at `:266-277` also `project.terminals.remote.remove(&remote_id)` (captured before the closure).
- `create_terminal_shell_internal` (`:312-451`): same arm at `:402-407` (before the `None => (settings.shell, env)` arm, which moves `settings.shell` — the new arm must not touch it) with `TerminalMode::interactive()` and `task_id: None`; same bookkeeping at `:428-446`. Under `#[cfg(target_family = "wasm")]`, when `force_local && remote_pty` return `Task::ready(Err(anyhow!("local terminals are not available in the browser")))` before spawning (b6's wasm `TerminalBuilder::new` twin also returns `Err`, but this makes the message explicit and keeps `terminal_panel.rs:992` rendering `FailedToSpawnTerminal`); native behaviour ("break out to a local shell") is unchanged.
- `exec_in_shell` (`:517-577`): under `#[cfg(target_family = "wasm")]` return `Task::ready(Err(anyhow!("shell commands are not available in the browser")))` when `remote_pty`; native unchanged. (b5-wasm-build-env.md:58 lists this function's `smol::process::Command` return type as a project-crate wasm item; the early return is compatible with whatever b5/W3 does to the signature.)
- `clone_terminal` (`:453-498`): extend `:461-463` to `if terminal.read(cx).task().is_some() || terminal.read(cx).is_remote_pty() { return self.create_terminal_shell(cwd, cx); }`.
- New handlers (registered in §3.7):
  ```rust
  pub(crate) async fn handle_terminal_output(this: Entity<Self>, envelope: TypedEnvelope<proto::TerminalOutput>, mut cx: AsyncApp) -> Result<()>
  pub(crate) async fn handle_terminal_exited(this: Entity<Self>, envelope: TypedEnvelope<proto::TerminalExited>, mut cx: AsyncApp) -> Result<()>
  pub(crate) fn reattach_remote_terminals(&mut self, cx: &mut Context<Self>)
  ```
  Both handlers do all work inside `this.update(&mut cx, ..)` with no prior `.await` (ordering guarantee, `remote_client.rs:1831`): look up `terminals.remote.get(&terminal_id)` and call `handle.push_output(offset, data, reset)` / `handle.push_exit(exit.code, exit.signal)` with `let exit = envelope.payload.exit.unwrap_or_default();` (prost generates `Option<TerminalExit>`); unknown ids are logged at debug and dropped with no other side effect (a terminal the previous client owned). `reattach_remote_terminals` (idempotent; two back-to-back `Reconnected` events produce two replays whose chunks dedup by offset): for each entry whose `terminal.as_ref().and_then(|t| t.upgrade())` is `Some`, read `remote_next_offset()` and the current bounds, then `cx.background_spawn(client.request(proto::AttachTerminal { project_id: REMOTE_SERVER_PROJECT_ID, terminal_id, from_offset: next_offset, cols, rows }))` and, on `Err` (unknown id: the server closed the terminal while this client was away, or — mock transport only — a replaced server; with b1's WebSocket transport a server restart never reaches `Reconnected`, because `reconnect && !HelloAck.resumed` is terminal (b1:269, `Ok(90)`) and the next open is a fresh session handled by §3.6a), `handle.push_lost()`. The response's `exit` is not acted on: the server re-sends `TerminalExited` after the replay for an exited terminal, in stream order, and §3.5h dedups it.

### 3.6a `zed/crates/terminal_view/src/{persistence.rs, terminal_view.rs, terminal_panel.rs}` (client-side restore, D4)

`TerminalDb` (`persistence.rs:406-445`) is part of the `AppDatabase` image (D7) that b7 loads over the session before `deserialize_remote_project` runs (D16, `open_remote_project_in_new_window_with_client`), so the rows written by the previous session are present when `TerminalPanel::load` runs. Every change below is a no-op for local, ssh, wsl and docker projects (`supports_remote_pty()` is false and no row ever carries a `remote_terminal_id`).

- `persistence.rs` `TerminalDb::MIGRATIONS` (`:410-445`): append one migration
  ```rust
  sql!(
      ALTER TABLE terminals ADD COLUMN remote_terminal_id INTEGER;
      ALTER TABLE terminals ADD COLUMN remote_title TEXT;
  ),
  ```
  (nullable columns on the `STRICT` table; `u64` binds as a bit-cast `i64` and reads back `as u64`, `sqlez/src/bindable.rs:168-183`, so uuid-derived ids above `i64::MAX` round-trip; b4's migration-skew rules (b4 §7 item 17) apply unchanged — an older build ignores the columns). New queries next to `save_custom_title` (`:502-534`), same `ON CONFLICT (workspace_id, item_id) DO UPDATE` shape:
  ```rust
  pub async fn save_remote_terminal(&self, item_id: ItemId, workspace_id: WorkspaceId, remote_terminal_id: Option<u64>, remote_title: Option<String>) -> Result<()>
  query! { pub fn get_remote_terminal(item_id: ItemId, workspace_id: WorkspaceId) -> Result<Option<(Option<u64>, Option<String>)>> {
      SELECT remote_terminal_id, remote_title FROM terminals WHERE item_id = ? AND workspace_id = ?
  } }
  ```
- `persistence.rs` `deserialize_terminal_views` (`:320-341`): replace `.filter_map(|item| item.log_err())` at `:338` with a match that logs `RemoteTerminalGone` at info (`e.downcast_ref::<project::terminals::RemoteTerminalGone>()`) and everything else at error, as before. A dropped terminal is the expected outcome after a sandbox stop/resume, not an error.
- `terminal_view.rs` `TerminalView::new` (`:233-241`): `needs_serialize: terminal.read(cx).is_remote_pty()` at `:299` (a remote terminal must be written once even though its cwd never changes). In `subscribe_for_terminal_events`, the `Event::Wakeup` arm (`:1135-1137`) gains `if terminal_view.needs_serialize && terminal.read(cx).is_remote_pty() { cx.emit(ItemEvent::UpdateTab); }` — the first output chunk (the prompt) then routes the item through `item.rs:873` into `Workspace::serialize_items`; `needs_serialize` flips back to `false` in `serialize`, so this emits at most once per pending write.
- `terminal_view.rs` `serialize` (`:1864-1895`): `let cwd = terminal.working_directory().or_else(|| terminal.remote_working_directory().map(Path::to_path_buf));` (a server path, only ever sent back to the server) and `let remote = (terminal.remote_terminal_id(), terminal.title_override().map(str::to_owned));`; after `save_custom_title`, `db.save_remote_terminal(item_id, workspace_id, remote.0, remote.1).await?`. Task terminals are still skipped (`:1870-1872`), so they are never restored — same as desktop.
- `terminal_view.rs` `deserialize` (`:1901+`): inside the existing `cx.update` that reads cwd and `custom_title`, also read `db.get_remote_terminal(item_id, workspace_id).log_err().flatten()`. If it yields `Some((Some(remote_id), remote_title))` **and** `project.read(cx).supports_remote_pty(cx)`: `let terminal = project.update(cx, |p, cx| p.restore_remote_terminal(remote_id, cwd.clone(), remote_title, cx))?;` (an `Err(RemoteTerminalGone)` propagates and the item is dropped), then the existing tail (`TerminalView::new(terminal, workspace, Some(workspace_id), project.downgrade(), window, cx)` + `set_custom_title`). Rows without a `remote_terminal_id` (pre-change rows, ssh projects, or a DB image opened by a non-PTY connection) take the unchanged `create_terminal_shell(cwd)` path.
- `terminal_panel.rs` `TerminalPanel::load` (`:300-345`): before the `if let Some(serialized_panel)` chain, `workspace.update(cx, |w, cx| w.project().update(cx, |p, cx| p.fetch_remote_terminal_inventory(cx)))?.await;` and after the chain — whether or not a serialized panel existed, and after `deserialize_terminal_panel(..).await` returned, i.e. after every `TerminalView::deserialize` and the pane-group recursion completed — `workspace.update(cx, |w, cx| w.project().update(cx, |p, cx| p.close_unrestored_remote_terminals(cx)))?;`. The reap therefore also runs when the image had no terminal panel at all (a server with terminals but a lost/empty image), which is what keeps the server free of ghosts. The blank-pane fallback (`persistence.rs:284-313`) is unchanged and still opens one fresh shell per pane whose every terminal was dropped.
- `terminal_panel.rs:380-402` (`mark_needs_serialize` for items not in `alive_item_ids`): unchanged; restored remote terminals are in `alive_item_ids` and their row already carries the id.

Sequence on a fresh session, for the record: `TerminalPanel::load` → `fetch_remote_terminal_inventory` (`ListTerminals`) → `deserialize_terminal_panel` → per item `TerminalView::deserialize` → `restore_remote_terminal` (`AttachTerminal { from_offset: 0 }`, replay ≤ 2 MiB, `TerminalExited` re-sent for an exited one) → `close_unrestored_remote_terminals` (`CloseTerminal` per leftover). Warm reconnects never touch this path (§3.7 `reattach_remote_terminals`).

### 3.7 `zed/crates/project/src/project.rs`
- After `:1679` add `remote_proto.add_entity_message_handler(Self::handle_terminal_output); remote_proto.add_entity_message_handler(Self::handle_terminal_exited);`.
- `:1394`, `:1638`, `:1929` (`Terminals { local_handles: Vec::new() }` literals): add `remote: HashMap::default()`.
- `:3868`: `&remote::RemoteClientEvent::Reconnected => self.reattach_remote_terminals(cx),`.

### 3.8 `zed/crates/remote_server/src/pty.rs` (new) — `PtyManager`
```rust
pub const SCROLLBACK_CAPACITY: usize = 2 * 1024 * 1024;
pub const OUTPUT_WINDOW: u64 = 512 * 1024;   // max unacked bytes before the reader stalls (attached only)
pub const OUTPUT_CHUNK: usize = 64 * 1024;
pub const EXIT_DRAIN_TIMEOUT: Duration = Duration::from_millis(500);
pub const KILL_ESCALATION_DELAY: Duration = Duration::from_millis(100);
pub const MAX_TERMINALS: usize = 64;          // 3 OS threads each; spawn returns Err beyond this

/// Everything the manager puts on the wire, in order. Drained by ONE foreground
/// task so that ChannelClient's id/ack bookkeeping (remote_client.rs:2031-2043,
/// single-producer by construction everywhere else) never sees interleaved
/// producers; OS threads only enqueue.
pub enum OutboundMessage { Output(proto::TerminalOutput), Exited(proto::TerminalExited) }

/// Where output goes. `AnyProtoClient` implements it; tests use a channel.
pub trait TerminalOutputSink: 'static {
    fn send(&self, message: OutboundMessage);
}
impl TerminalOutputSink for AnyProtoClient { /* self.send(message).log_err() */ }

pub struct SpawnOptions {
    pub shell: task::Shell,
    pub working_directory: Option<PathBuf>,
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
    pub task_id: Option<String>,
    pub title: Option<String>,
}

/// One per process (D3): installed as an `App` global by the first `HeadlessProject::new` (or
/// explicitly by tests simulating a server restart) and never reset with the project, so PTYs
/// outlive fresh sessions. `HeadlessProject` only holds an `Arc` handle to it.
pub struct PtyManager {
    state: Arc<PtyManagerState>,
    _drain_task: gpui::Task<()>,
    _quit_subscription: gpui::Subscription,
}
struct GlobalPtyManager(Arc<PtyManager>);
impl gpui::Global for GlobalPtyManager {}
/// Shared with the reader/wait threads (via `Weak`) and the `on_app_quit` closure.
struct PtyManagerState {
    project_id: u64,
    outbound_tx: UnboundedSender<OutboundMessage>,
    terminals: Mutex<HashMap<u64, Arc<TerminalEntry>>>,
}

impl PtyManager {
    /// Spawns the drain task (`cx.spawn`: outbound_rx → sink.send) and registers
    /// `cx.on_app_quit`, whose closure captures `Arc<PtyManagerState>`: it SIGTERMs
    /// every process group synchronously and returns a future that sleeps
    /// KILL_ESCALATION_DELAY then SIGKILLs — well inside gpui's 200 ms
    /// SHUTDOWN_TIMEOUT (app.rs:78, 978-999).
    pub fn new(project_id: u64, sink: Arc<dyn TerminalOutputSink>, cx: &mut App) -> Self;
    pub fn global(cx: &App) -> Option<Arc<PtyManager>>;                     // cx.try_global::<GlobalPtyManager>()
    /// `new` + `cx.set_global`, replacing any previous global (which drops — and SIGKILLs its
    /// children — once its last handle is gone). Production reaches it once, lazily, from
    /// `HeadlessProject::new` (§3.9); integration test 12 calls it to simulate a restarted server.
    pub fn install(project_id: u64, sink: Arc<dyn TerminalOutputSink>, cx: &mut App) -> Arc<PtyManager>;
    pub fn spawn(&self, options: SpawnOptions) -> Result<u64>;            // detached; the client attaches explicitly
    pub fn write(&self, terminal_id: u64, data: Vec<u8>) -> Result<()>;   // never blocks: input_tx.send
    pub fn resize(&self, terminal_id: u64, cols: u16, rows: u16) -> Result<()>;
    pub fn ack(&self, terminal_id: u64, offset: u64);                      // unknown id: no-op
    pub fn attach(&self, terminal_id: u64, from_offset: u64, cols: u16, rows: u16) -> Result<AttachOutcome>;
    pub fn detach(&self, terminal_id: u64);
    pub fn detach_all(&self);                                              // b2's session-detach hook (D20); never kills
    pub fn list(&self) -> Vec<proto::TerminalInfo>;
    pub fn close(&self, terminal_id: u64) -> Result<()>;                   // SIGTERM pgrp, SIGKILL after 100 ms; entry removed after exit
    pub fn kill_all(&self);                                                // on_app_quit only (D3): never from a fresh session
}
impl Drop for PtyManager { fn drop(&mut self) { /* SIGKILL all: last handle gone — TestAppContext teardown, or `install` replaced the global */ } }
pub struct AttachOutcome { pub replayed_from: u64, pub end_offset: u64, pub exit: Option<proto::TerminalExit> }

struct TerminalEntry {
    id: u64,
    task_id: Option<String>,
    title: String,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    child_pid: u32,
    #[cfg(not(unix))] killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    input_tx: std::sync::mpsc::Sender<Vec<u8>>,
    stream: Mutex<OutputStream>,
    credit: Condvar,
}

/// Pure, testable state shared by the reader thread and the handlers.
pub(crate) struct OutputStream {
    ring: VecDeque<u8>,       // last SCROLLBACK_CAPACITY bytes
    ring_start: u64,          // absolute offset of ring[0]
    end: u64,                 // absolute offset after the last byte produced
    sent: u64,                // absolute offset after the last byte handed to the sink
    acked: u64,
    attached: bool,           // false until the first AttachTerminal
    eof: bool,                // reader saw EOF
    exited: bool,             // waitpid returned
    close_requested: bool,
    exit: Option<proto::TerminalExit>,
}
impl OutputStream {
    pub(crate) fn push(&mut self, bytes: &[u8]);                       // evicts from the front
    pub(crate) fn window_open(&self) -> bool { self.exited || self.sent - self.acked < OUTPUT_WINDOW }
    pub(crate) fn replay_range(&self, from: u64) -> (u64 /*from*/, bool /*reset*/);
    pub(crate) fn slice(&self, from: u64, to: u64) -> Vec<u8>;
}
```
Every unknown `terminal_id` yields `Err(anyhow!("unknown terminal {id}"))` from `write`/`resize`/`attach`/`close`; `ack`/`detach` ignore it. All unix-only calls (`libc::killpg`, `libc::waitpid`, `process_group_leader`, `/proc`) sit under `cfg(unix)` arms; non-unix uses `killer.kill()` and `child.wait()` (§7.11).

Spawn: if `terminals.len() >= MAX_TERMINALS` → `Err`. `id = uuid::Uuid::new_v4().as_u128() as u64` (nonzero; `uuid` v4 is already a `remote_server` dependency, `Cargo.toml:76`) — random so that a client that reconnects to a **restarted server** cannot attach to a different terminal that reused a sequential id (with b1's WebSocket transport a restart is terminal for the client, b1:269/598, so this guards the mock transport and any future warm-reconnect path; D3's epoch is the first line of defence). `native_pty_system().openpty(PtySize { rows, cols, 0, 0 })`; `CommandBuilder` from `task::Shell`: `System` → `CommandBuilder::new(std::env::var("SHELL").unwrap_or("/bin/sh"))` + `arg("-l")` (parity with `ssh.rs:1932`); `Program(p)` → `new(p)`; `WithArguments { program, args }` → `new(program)` + `args`. `cwd(working_directory)` when set; `env(k, v)` for every pair (the client already merged the server-side directory env and `insert_zed_terminal_env`). Keep `env_clear()` off so `HOME`/`PATH`/`USER` from the server process are inherited, as the ssh path's `exec env K=V shell` does; then apply the fix-ups `TerminalBuilder::new` does locally (`terminal.rs:1122-1132`): `cmd.env_remove("SHLVL")` **after** the client map (the directory env captured by `GetDirectoryEnvironment` carries the server shell's `SHLVL`), and if neither the client map nor the server env has `LANG`, `cmd.env("LANG", "en_US.UTF-8")`. Contract: the child sees the server process env (including whatever the supervisor exported — b8's concern) overlaid by the client map, minus `SHLVL`. `pair.slave.spawn_command(cmd)`; **`drop(pair.slave)`** immediately (otherwise the server keeps the slave open and the reader never sees EOF, so every exit would wait the full `EXIT_DRAIN_TIMEOUT`); store `process_id()` (required; `Err` if `None`), `try_clone_reader()`, `take_writer()`. `title = options.title.unwrap_or(program name)`. The entry starts `attached: false`; the reader fills the ring until the client's `AttachTerminal { from_offset: 0 }`. Three named threads per terminal, each holding `Weak<PtyManagerState>` + `Arc<TerminalEntry>`:
- `pty-reader-{id}`: `read` into a 64 KiB buffer; on `Ok(0)`/`Err` lock `stream`, set `eof = true`, `credit.notify_all()`, exit. Otherwise lock `stream`, `push`, `end += n`, then `while attached && sent < end { if !window_open() { credit.wait(); continue } enqueue OutboundMessage::Output(TerminalOutput { offset: sent, data: slice(sent, min(end, sent + OUTPUT_CHUNK)), reset: false }); sent += len }`. The condvar wait releases the lock and wakes on ack/attach/detach/exit/close. While **detached** the reader does not wait: it keeps reading into the ring (evicting), so a detached child never blocks; while attached and unacked, the reader blocks and the kernel PTY buffer back-pressures the child. Enqueueing under the `stream` lock keeps per-terminal offsets monotonic in the channel.
- `pty-writer-{id}`: `for bytes in input_rx { writer.write_all(&bytes) }`; exits when the sender side is dropped (entry removed). May block if the child stops reading — that is the PTY's own input back-pressure, never the foreground's.
- `pty-wait-{id}` (unix): `libc::waitpid(pid, &mut status, 0)`; decode `WIFEXITED/WEXITSTATUS` → `TerminalExit { code: Some(c), signal: None }`, `WIFSIGNALED/WTERMSIG` → `TerminalExit { code: None, signal: Some(sig) }` (`code` must be `None` when signalled so `task_summary` prints "terminated by signal" rather than "exit code: 1"). portable-pty's `Child::wait()` is not used on unix (its `signal()` is a `strsignal` string and `exit_code()` is forced to 1). Then lock `stream`: `exited = true; exit = Some(..)`; `credit.notify_all()` (re-opens the window); wait on `credit` up to `EXIT_DRAIN_TIMEOUT` for `eof`; if `attached`, enqueue `[sent, end)` in `OUTPUT_CHUNK` pieces (window ignored) and `sent = end`; enqueue `Exited(TerminalExited { terminal_id, exit, end_offset: end })`. If `close_requested` → remove the entry from the map (drops master/input_tx/killer); otherwise the entry stays (scrollback replay for a finished task) until `close`. Non-unix: `child.wait()` → `code: Some(exit_code as i32), signal: None`.
Attach: lock `stream`; `(from, reset) = replay_range(from_offset)` where `from = clamp(from_offset, ring_start, end)` and `reset = from > from_offset`; enqueue `[from, end)` in `OUTPUT_CHUNK` pieces with `reset` on the first chunk (or one empty chunk with `reset: true` if `from == end && reset`); if `exited` also enqueue `Exited { .. }` again after the replay (stream-ordered; the client dedups); `sent = end; acked = from; attached = true`; `credit.notify_all()`; unlock; `master.resize(...)`; return `AttachOutcome { replayed_from: from, end_offset: end, exit }`. Replay ignores the window on purpose (≤ 2 MiB once); the live stream then waits for acks. Detach: `attached = false; notify`. Ack: `acked = max(acked, offset); notify`. Resize: `master.resize(PtySize{rows, cols, 0, 0})`. Close: lock `stream`; if `exited` → remove the entry now; else `close_requested = true`, `libc::killpg(pid, SIGTERM)`, spawn a thread that sleeps `KILL_ESCALATION_DELAY` and, if the entry is still not `exited`, `killpg(pid, SIGKILL)` (mirrors `terminal.rs:3067-3076`; the child is a session leader, so pgid == pid; the microsecond window between `waitpid` returning and `exited` being set, during which a recycled pid could be signalled, is accepted). Dropping the entry drops the master fd, which also HUPs the session. `kill_all`: SIGTERM every non-exited pgrp under the lock; the quit future SIGKILLs after `KILL_ESCALATION_DELAY`; `Drop` SIGKILLs immediately. `detach_all`: every stream `attached = false; notify` (readers stop enqueueing into a queue nobody drains). `list`: per entry `TerminalInfo { terminal_id, title, cwd, task_id, end_offset, scrollback_start: ring_start, exit, cols, rows }` where `cwd` is `#[cfg(target_os = "linux")] master.process_group_leader().and_then(|pid| fs::read_link(format!("/proc/{pid}/cwd")))`, best-effort and `None` elsewhere.

Idle accounting (D20; b2 `is_input_envelope`, b2-serve-mode.md:431): the terminal messages that count as user input are `SpawnTerminal`, `TerminalInput`, `CloseTerminal`; `AckTerminalOutput`, `ResizeTerminal`, `ListTerminals`, `AttachTerminal` must **not** count (D20 makes b2 exclude exactly these four, alongside b4's `SaveClientState`/`LoadClientState`/`ListExtensions`, b4 §3.15 item 6), otherwise any terminal that prints (`tail -f`, a long build) keeps the workspace "active" forever via the client's acks — and, since D4 reattaches terminals on every open, a forgotten `tail -f` would defeat idle stop across reloads. b2's `is_input_envelope_rules` test gains the four cases; the restore's `ListTerminals`/`AttachTerminal` burst on open therefore does not count as input either (the user's first keystroke does).

### 3.9 `zed/crates/remote_server/src/headless_project.rs`
- `:52-74`: add `pub pty_manager: Arc<pty::PtyManager>,` — a handle to the process-level manager, not an owner (D3) — and `pub mod pty;` in `zed/crates/remote_server/src/server.rs` next to `mod headless_project;` at `:1` (`pub` so `remote_editing_tests.rs` and b2's serve module can name `PtyManager`). No new `HeadlessAppState` field (27 construction sites, §2).
- In `new` (`:92-104`): `let pty_manager = pty::PtyManager::global(cx).unwrap_or_else(|| pty::PtyManager::install(REMOTE_SERVER_PROJECT_ID, Arc::new(session.clone()), cx));` and include it in the struct literal. In production this runs once per process (`run` and b2's `serve` each build exactly one `HeadlessProject`, b2 §3.9); b2's `reset_for_new_client` (b2:662-673) does not touch it, so PTYs survive fresh sessions. Embedders that build a `HeadlessProject` for mock servers (`zed.rs:3068`, `recent_projects`, `sidebar`, `collab` tests) get a manager with no threads until something spawns.
- After `:327` register:
  ```rust
  session.add_entity_request_handler(Self::handle_spawn_terminal);
  session.add_entity_message_handler(Self::handle_terminal_input);
  session.add_entity_message_handler(Self::handle_ack_terminal_output);
  session.add_entity_message_handler(Self::handle_resize_terminal);
  session.add_entity_message_handler(Self::handle_close_terminal);
  session.add_entity_request_handler(Self::handle_list_terminals);
  session.add_entity_request_handler(Self::handle_attach_terminal);
  ```
- New handlers (same shape as `:1315-1333`; every one does its work synchronously inside `this.update` — no `.await` before the PTY write, see `remote_client.rs:1831`):
  ```rust
  async fn handle_spawn_terminal(this: Entity<Self>, envelope: TypedEnvelope<proto::SpawnTerminal>, mut cx: AsyncApp) -> Result<proto::SpawnTerminalResponse>
  async fn handle_terminal_input(this: Entity<Self>, envelope: TypedEnvelope<proto::TerminalInput>, mut cx: AsyncApp) -> Result<()>
  async fn handle_ack_terminal_output(this: Entity<Self>, envelope: TypedEnvelope<proto::AckTerminalOutput>, mut cx: AsyncApp) -> Result<()>
  async fn handle_resize_terminal(this: Entity<Self>, envelope: TypedEnvelope<proto::ResizeTerminal>, mut cx: AsyncApp) -> Result<()>
  async fn handle_close_terminal(this: Entity<Self>, envelope: TypedEnvelope<proto::CloseTerminal>, mut cx: AsyncApp) -> Result<()>
  async fn handle_list_terminals(this: Entity<Self>, envelope: TypedEnvelope<proto::ListTerminals>, mut cx: AsyncApp) -> Result<proto::ListTerminalsResponse>
  async fn handle_attach_terminal(this: Entity<Self>, envelope: TypedEnvelope<proto::AttachTerminal>, mut cx: AsyncApp) -> Result<proto::AttachTerminalResponse>
  ```
  `handle_spawn_terminal` converts `shell` with `task::shell_from_proto` (`task.rs:374`), `working_directory` with `PathBuf::from`, and `cols/rows` as `u16` with `max(1)`. `handle_close_terminal` maps an unknown id to `Ok(())` with a debug log (the client's `Drop` legitimately sends `CloseTerminal` after the exit path already removed the entry). b2's session-detach hook (its `GpuiCommand` gains a `SessionDetached` variant for D20; the name is b2's) calls `PtyManager::global(cx).map(|m| m.detach_all())`; **nothing calls `kill_all` from `begin_fresh_session`** (D3, D20) — `kill_all` runs only from `on_app_quit` (b2's `Quit` → `cx.shutdown()` → quit observers) and `Drop`. `CloseTerminal` is the only per-terminal kill.

### 3.10 Threading model (summary for implementers)
- Native today: alacritty's `EventLoop` thread (`alacritty.rs:212`, `event_loop.rs:205-206`) parses PTY bytes into `Term` behind `FairMutex` (`sync.rs:11-49`); the UI locks it in `sync` (`terminal.rs:2411-2430`).
- Remote: no parser thread. Bytes arrive as `PtyEvent::Output` on the `events_rx` channel, and `Terminal::process_remote_output` parses them inside the `cx.spawn` task created by `subscribe` (`terminal.rs:1404`) — foreground executor, same thread as `sync`. This is the path `write_output` (`:1961-1972`) already uses for display-only terminals; it uses no dedicated thread (`scheduler.rs:207-224` panics on any dedicated thread on wasm). Foreground stalls are bounded in bytes, not events: `REMOTE_PARSE_BUDGET` (256 KiB, ≤ ~320 KiB with a straddling chunk) per `terminal.update`, then `yield_now`; ack-based flow control (`OUTPUT_WINDOW`) bounds the client queue to `WINDOW + one replay` bytes regardless of how slow the parser is. If the browser measurements show that budget is still too much per frame, the same `RemotePtyHandle` can be fed by a background parse task natively (b6's pump idea) without touching the transport.
- Server: three OS threads per terminal (reader, writer, waiter) that only enqueue into `outbound_tx`; one foreground drain task calls `AnyProtoClient::send`. Consequences: per-terminal offsets are monotonic on the wire, `TerminalOutput`/`TerminalExited` order is preserved, and the `ChannelClient` id/ack invariants (single producer) hold. Note that a request **response** (`SpawnTerminalResponse`, `AttachTerminalResponse`) is sent by the handler machinery, not through the drain, so it may overtake queued output; the protocol never relies on response-vs-output order (spawn is detached, attach's `exit` is informational and the ordered `TerminalExited` is authoritative).
- Reconnect: `resync` (`remote_client.rs:714`) replays the client's buffered envelopes — including `TerminalInput` typed during the outage — over the new socket **before** `Reconnected` fires (`:761`); their echoes stream from the server's still-attached reader. `Project::reattach_remote_terminals` (§3.6) then sends `AttachTerminal { from_offset: next_offset }`; the replay `[next_offset, end)` overlaps the live stream and is deduplicated by offset (integration test 2 asserts each echo appears once and offsets are contiguous across the outage). The server's `ChannelClient` re-sends its unacked `TerminalOutput` envelopes on `FlushBufferedMessages` (`:1751-1765`); each `send_buffered` clones the envelope into `buffer` (`:2036-2043`) until an incoming `ack_id` prunes it, so the per-terminal unacked buffer is at most `OUTPUT_WINDOW` in steady state but can transiently reach `OUTPUT_WINDOW + SCROLLBACK_CAPACITY` right after an attach replay. For fresh sessions this brief depends on b2's `begin_fresh_session` clearing `buffer`/`max_received`/response channels before `ChannelClient::reconnect` hands the client a new channel pair (b2:128, 955): without it a fresh client's replay buffer is pruned by stale acks.
- Fresh sessions (page reload, takeover, host `reconnect()` after `ReconnectExhausted` — b1:598-599, b2:447-452, D2, D3): the server detached every PTY when the previous session ended (D20 `detach_all`: readers keep filling the rings, children run on) and `begin_fresh_session` resets the project but **not** the manager (D3). The new client's `Terminals.remote` map starts empty; `TerminalPanel::load` refills it from `TerminalDb` (§3.6a): one `ListTerminals`, then `AttachTerminal { from_offset: 0 }` per persisted id the server still has (full scrollback replay ≤ 2 MiB each, `reset: true` on the first chunk if the ring evicted), then `CloseTerminal` for every inventory entry nobody restored (exited shells, terminals whose tab was closed but never flushed to the image). Nothing is killed for being a fresh session.
- Terminal outcomes on the client (D2): after `ReconnectExhausted`, 4001 (superseded) or 4005 no `Reconnected` ever fires; the terminals keep their last grid and typing goes nowhere (`attached` stays `true`, `TerminalInput` accumulates in `ChannelClient.buffer` until the workspace is torn down — harmless). The shell's host `reconnect()` or a page reload opens a fresh session and the restore path above brings the same server terminals back from offset 0.

## 4. New types and messages

`zed/crates/proto/proto/terminal.proto`:
```proto
syntax = "proto3";
package zed.messages;

import "task.proto";

message SpawnTerminal {
  uint64 project_id = 1;
  optional string working_directory = 2;
  Shell shell = 3;                       // task.proto; System => server login shell (`$SHELL -l`)
  map<string, string> env = 4;
  uint32 cols = 5;
  uint32 rows = 6;
  optional string task_id = 7;           // task::TaskId is a String (task.rs:38)
  optional string title = 8;             // task label for tasks, "<host> — Terminal" for shells (ListTerminals)
}
// The terminal starts detached; send AttachTerminal { from_offset: 0 } to stream.
message SpawnTerminalResponse { uint64 terminal_id = 1; }   // random 64-bit, unique across server restarts

message TerminalInput  { uint64 project_id = 1; uint64 terminal_id = 2; bytes data = 3; }   // <= 64 KiB per message

// Server-initiated. `offset` is the absolute byte offset of data[0] in the
// terminal's output stream; `reset` asks the client to clear its grid first
// (replay started after scrollback eviction).
message TerminalOutput { uint64 project_id = 1; uint64 terminal_id = 2; uint64 offset = 3; bytes data = 4; bool reset = 5; }

// Client has parsed everything below `offset`; opens the server's send window.
message AckTerminalOutput { uint64 project_id = 1; uint64 terminal_id = 2; uint64 offset = 3; }

message ResizeTerminal { uint64 project_id = 1; uint64 terminal_id = 2; uint32 cols = 3; uint32 rows = 4; }
// Kill the process group. Output keeps streaming until the child exits; the
// server drops the terminal after TerminalExited (immediately if already exited).
message CloseTerminal  { uint64 project_id = 1; uint64 terminal_id = 2; }

message TerminalExit { optional int32 code = 1; optional int32 signal = 2; }   // exactly one is set
// Server-initiated, sent after the remaining output has been flushed; re-sent
// after every AttachTerminal replay of an exited terminal.
message TerminalExited { uint64 project_id = 1; uint64 terminal_id = 2; TerminalExit exit = 3; uint64 end_offset = 4; }

message ListTerminals { uint64 project_id = 1; }
message TerminalInfo {
  uint64 terminal_id = 1;
  string title = 2;
  optional string cwd = 3;               // Linux only, best-effort (/proc/<pgrp>/cwd)
  optional string task_id = 4;
  uint64 end_offset = 5;
  uint64 scrollback_start = 6;           // oldest offset still replayable
  optional TerminalExit exit = 7;
  uint32 cols = 8;
  uint32 rows = 9;
}
message ListTerminalsResponse { repeated TerminalInfo terminals = 1; }

// Replays [max(from_offset, scrollback_start), end) as TerminalOutput messages
// (first one carries reset=true if from_offset was evicted), then resumes streaming.
// Unknown terminal_id => error response (the client marks the terminal lost).
message AttachTerminal { uint64 project_id = 1; uint64 terminal_id = 2; uint64 from_offset = 3; uint32 cols = 4; uint32 rows = 5; }
message AttachTerminalResponse { uint64 replayed_from = 1; uint64 end_offset = 2; optional TerminalExit exit = 3; }   // exit is informational
```

Rust types: `task::ExitStatus` (re-exported as `terminal::ExitStatus`), `terminal::{RemotePtyTransport, RemotePtyHandle, RemoteTerminalOptions}`, `terminal::remote_pty::RemotePtyState`, `TerminalType::Remote(RemotePtyState)`, `PtyEvent::{Output { offset, data, reset }, RemoteLost}` (§3.5); `project::terminals::{RemoteTerminalEntry, ProtoPtyTransport, RemoteTerminalGone, INPUT_CHUNK}` and `Project::{supports_remote_pty, fetch_remote_terminal_inventory, restore_remote_terminal, close_unrestored_remote_terminals}` (§3.6); `terminal_view::persistence::TerminalDb` columns `remote_terminal_id INTEGER`, `remote_title TEXT` with `save_remote_terminal`/`get_remote_terminal` (§3.6a); `remote_server::pty::{PtyManager, GlobalPtyManager, SpawnOptions, AttachOutcome, TerminalOutputSink, OutboundMessage, OutputStream}` and the constants (§3.8). Signatures are given in full in §3.

Wire semantics that tests pin down:
- Offsets are per-terminal, monotonic, start at 0, and count bytes produced by the PTY (not bytes sent). Terminal ids are random 64-bit values.
- The server never sends `TerminalOutput` for an unattached terminal; spawn is detached and the client attaches explicitly; attach re-sets `acked = replayed_from`. A detached child is never back-pressured (the ring evicts).
- Live streaming stalls (reader blocked, child back-pressured) while attached and `sent - acked >= OUTPUT_WINDOW`; replay and the post-exit drain ignore the window.
- `TerminalExited.end_offset == last TerminalOutput.offset + len` for that terminal; `TerminalExited` follows every replay of an exited terminal.
- `CloseTerminal` on a running terminal keeps streaming until the exit; the entry is removed after `TerminalExited`.
- The client drops any `TerminalOutput` whose range ends at or before `next_offset`, trims overlapping prefixes, clears the grid only on `reset`, answers a gap (`offset > next_offset`) with one `AttachTerminal { from_offset: next_offset }` and no grid change, acks at ≥ 64 KiB or at the end of each processing batch, and ignores a second `TerminalExited`.
- `TerminalInput` messages carry at most 64 KiB each; order is the arrival order.
- Fresh-session restore (D4): the restoring client sends one `ListTerminals`, then `AttachTerminal { from_offset: 0 }` for each persisted id present in the response with `exit == None`, then `CloseTerminal` for every other id in the response. The server never kills a terminal because a session ended or a new one began (D3); only `CloseTerminal`, process shutdown and the child's own exit end one.

## 5. Cargo/package changes

Verified against `zed/Cargo.toml` workspace deps (`alacritty_terminal` :523, `libc` :673, `parking_lot` :737, `portable-pty` :751, `smol` :818) — nothing new is added to the workspace.

`zed/crates/remote_server/Cargo.toml` `[dependencies]` (alphabetical placement; `uuid` with `v4` is already there at `:76`):
```toml
libc.workspace = true
parking_lot.workspace = true
portable-pty.workspace = true
```

`zed/crates/task/Cargo.toml`: no change (the wasm `ExitStatus` struct uses only `std`). `zed/crates/terminal/Cargo.toml`: no change (the transport is a trait; no `rpc`/`proto` dependency; `task` is already a dependency). `zed/crates/project/Cargo.toml`: no change (`remote`, `rpc`, `task`, `terminal` already present at `:80,81,94,96`). `zed/crates/proto`: no change (`build.rs` compiles `zed.proto` and its imports). `zed/crates/remote/Cargo.toml`: no change. `zed/crates/terminal_view/Cargo.toml`: no change (`db` `:23`, `project` `:33`, `task` `:36`, `workspace` `:48` already present; `project` with `test-support` in dev-deps at `:54` gives its tests `forget_remote_transport`). `zed/crates/workspace`, `acp_thread`, `agent_servers`: no change (§3.5a's import swaps use `task`, already a dependency of each — `workspace/Cargo.toml:64`, `agent_servers/Cargo.toml:54`). No crate outside `remote_server` gains a dependency; `alacritty_terminal` keeps coming from the workspace entry that D10/b6 re-points at `zed/vendor/alacritty_terminal`.

CI: `cargo check -p remote_server --target x86_64-pc-windows-msvc` must stay green (all unix-only calls are cfg-gated, §3.8); the server tests are `cfg(all(test, unix))`, so Windows has no runtime coverage (§7.11).

## 6. Tests

Server unit tests — `zed/crates/remote_server/src/pty.rs` `#[cfg(all(test, unix))] mod tests`, using a channel-backed `TerminalOutputSink` (`std::sync::mpsc`) and `gpui::TestAppContext` with `cx.executor().allow_parking()` (`PtyManager::new` needs an `App` for the drain task and `on_app_quit`; the drain must be pumped with `run_until_parked` between real-time waits). Unless stated, every test spawns, then `attach(id, 0, 80, 24)`:
1. `output_stream_ring_evicts_and_replays` (pure `OutputStream`): push 3 MiB → `ring_start == 1 MiB`, `end == 3 MiB`; `replay_range(0) == (1 MiB, true)`; `replay_range(end - 10) == (end - 10, false)`; `slice` returns the last 10 bytes.
2. `spawn_echoes_input`: spawn `Shell::WithArguments { program: "cat", args: [] }` with `cols: 80, rows: 24`; `write(id, b"hello\r")`; collect `TerminalOutput`s until the joined bytes contain `"hello"` (PTY echo + cat); assert offsets are contiguous from 0.
3. `input_order_is_preserved`: 200 single-byte writes `0..200 % 26 + b'a'` to `cat`; joined output (after stripping the PTY echo of each byte) equals the written sequence. (Covers `PtyManager::write` only; the cross-`ChannelClient` ordering is integration test 4.)
4. `resize_reaches_child`: spawn `sh -c 'sleep 0.3; stty size'`; `resize(id, 120, 40)` immediately; output contains `"40 120"`.
5. `exit_code_and_signal_are_reported`: `sh -c 'exit 3'` → `TerminalExited { exit: { code: Some(3), signal: None } }`; `sh -c 'kill -TERM $$'` → `{ code: None, signal: Some(15) }`; `end_offset` equals bytes received.
6. `flow_control_stalls_without_acks`: spawn `sh -c 'yes | head -c 4000000'`; with no acks, after 500 ms the sum of received `data.len()` is `<= OUTPUT_WINDOW + OUTPUT_CHUNK`; then `ack(id, received)` repeatedly until `TerminalExited` arrives and the total is 4,000,000.
7. `attach_replays_from_offset_with_reset`: spawn `sh -c 'head -c 3000000 /dev/zero | tr "\0" x; exit 0'`, ack everything, wait for exit; `attach(id, 0, 80, 24)` → first replayed chunk has `reset == true` and `offset == replayed_from == end - SCROLLBACK_CAPACITY`, and the last message is a second `TerminalExited`; `attach(id, end - 5, ..)` → one chunk of 5 bytes, `reset == false`; response `exit == Some(code 0)`.
8. `exit_drain_flushes_before_exited`: spawn `sh -c 'printf done; exit 0'` with a sink that records message order; the last `TerminalOutput` (containing `done`) precedes `TerminalExited`, and its `offset + len == end_offset`.
9. `close_streams_until_exit_then_removes`: spawn `sh -c 'trap "echo bye; exit 0" TERM; sleep 30 & wait'`; `close(id)`; output containing `bye` arrives, then `TerminalExited` within 1 s; `list()` is empty afterwards; the `sleep` pid (from `/proc`) is gone. Variant with `sh -c 'trap "" TERM; sleep 30'` → `signal: Some(9)` after the escalation.
10. `kill_all_on_quit`: two `sleep 30` terminals; `kill_all()`; both `TerminalExited` arrive; `list()` is empty afterwards. Variant: drop the `PtyManager` → children gone.
11. `spawn_is_detached_until_attach`: spawn `sh -c 'printf hi; exit 0'`; nothing is received for 200 ms; `attach(id, 0, ..)` → `TerminalOutput { offset: 0, data: "hi", reset: false }` then `TerminalExited`.
12. `detached_child_is_not_blocked`: `yes | head -c 4000000`, attach, then `detach(id)` immediately; `TerminalExited` still arrives (the ring evicts; no acks were sent); `attach(id, 0, ..)` → `reset == true`, `replayed_from == end - SCROLLBACK_CAPACITY`.
13. `unknown_id_errors`: `write`/`resize`/`attach`/`close` on `0xdead` → `Err` containing `unknown terminal`; `ack`/`detach` return normally.
14. `spawn_cap`: `MAX_TERMINALS` × `sleep 30` succeed, one more → `Err`; `kill_all()` afterwards.
15. `shlvl_is_reset_and_lang_defaults`: `env: {"SHLVL": "7"}`, `sh -c 'echo SHLVL=$SHLVL LANG=$LANG'` → output contains `SHLVL=1` and `LANG=` non-empty.
16. `close_after_exit_removes_immediately`: `sh -c 'exit 0'`, wait for exit, `close(id)` → `list()` empty, no further messages.
17. `install_replaces_global`: `PtyManager::install` twice in one `TestAppContext`, a `sleep 30` spawned on the first; `PtyManager::global(cx)` is the second (`Arc::ptr_eq`); the second's `list()` is empty; dropping the last `Arc` of the first kills its child (`Drop`, `/proc` check) and its `TerminalExited` reaches the first sink. `detach_all` on the second with no terminals is a no-op.

Client unit tests — `zed/crates/terminal/src/remote_pty.rs` `#[cfg(test)]` with a `FakeTransport { inputs: Mutex<Vec<Vec<u8>>>, resizes: Mutex<Vec<(u16,u16)>>, acks: Mutex<Vec<u64>>, resyncs: Mutex<Vec<u64>>, closes: AtomicUsize }`, built via `TerminalBuilder::new_remote` + `cx.new(|cx| builder.subscribe(cx))` (settings init as `terminal.rs:3690-3696`):
1. `lone_chunk_repaints`: subscribe to the entity's events; `push_output(0, b"hello\r\n", false)`; `run_until_parked`; exactly one `Event::Wakeup` was emitted; `get_content()` contains `hello`; `acks == [7]`; `remote_next_offset() == Some(7)`.
2. `duplicate_prefix_is_dropped`: push `(0, "abc")`, `(1, "bcdef")`, `(0, "abc")` → content `abcdef`, `next_offset == 6`, no extra acks beyond 6.
3. `reset_clears_grid`: push `(0, "old")` then `(100, "new", reset=true)` → content contains `new` and not `old`; `next_offset == 103`.
4. `gap_requests_resync_without_clearing`: push `(0, "abc")`, `(10, "xyz")` → content is still `abc`, `resyncs == [3]`, `next_offset == 3`; a second gap chunk `(20, "q")` adds no resync; then `(3, "def")` → `abcdef` and a later gap resyncs again.
5. `input_and_resize_go_to_transport`: `terminal.input(b"ls\r")` → `inputs == [b"ls\r"]`; with a window (`add_empty_window`, as `:3879-3908`) `set_size(TerminalBounds{80x24})` + `sync` → `resizes == [(80, 24)]`; a second identical `set_size` sends nothing (`:2093-2100`).
6. `crlf_is_not_inserted`: push `(0, b"a\nb")` → cursor column after `b` is 2 (bytes were not rewritten to CRLF).
7. `exit_completes_task_with_summary`: `TerminalMode::task(SpawnInTerminal{ label: "t", show_summary: true, ..})`; `push_exit(Some(2), None)` → `wait_for_completed_task` resolves with `code() == Some(2)`; `task().status == Completed { success: false }`; content contains `finished with exit code: 2`; `has_active_pty_resources() == false`; a second `push_exit` changes nothing. Variant `push_exit(None, Some(15))` → content contains `terminated by signal: 15` (unix).
8. `interactive_exit_closes_once`: interactive mode; `input(b"exit\r")`; `push_exit(Some(0), None)` twice → exactly one `Event::CloseTerminal` emitted.
9. `osc_title_still_reaches_breadcrumbs`: push `(0, b"\x1b]0;my title\x07")` → `breadcrumb_text == "my title"` and `Event::BreadcrumbsChanged` observed; `title(true)` equals the override passed in `RemoteTerminalOptions`.
10. `drop_closes_transport_once`: drop the entity; `closes == 1`; `release_pty_resources` twice sends one close; after `push_exit` no close is sent at all.
11. `kill_active_task_stays_attached_until_exit`: task mode; `kill_active_task()` → `closes == 1`, `has_active_pty_resources()` still true; `push_output` still feeds the grid; `push_exit(None, Some(15))` → task completed, `has_active_pty_resources() == false`.
12. `lost_marks_detached_and_finishes`: task mode; `push_lost()` → content contains `no longer available`, `wait_for_completed_task` yields `None`, `has_active_pty_resources() == false`, `inputs`/`resizes` unchanged by a later `input`/`set_size`.
13. `ack_flushes_at_batch_end_and_threshold`: push 3 × 30 KiB then 1 × 70 KiB → every batch ends with `acked == next_offset`, and an ack fires inside a batch once 64 KiB accumulate; pushing 10 × 64 KiB at once yields at least two acks (the parse budget splits the batch).
14. `forget_remote_transport_sends_no_close`: `forget_remote_transport()` → `has_active_pty_resources() == false`; `input`/`set_size` afterwards reach nothing; dropping the entity leaves `closes == 0`. `remote_working_directory()` and `title_override()` return what `RemoteTerminalOptions` carried.
15. `sync_update_expires`: push `(0, b"\x1b[?2026h" + b"hello")` (BSU, no ESU) → after b6's `expire_sync_update` deadline elapses (`advance_clock`), `get_content()` contains `hello` and a `Wakeup` was emitted — the D17 seam.

`zed/crates/project/src/terminals.rs` `#[cfg(test)]`: `input_is_chunked_at_64k`: `chunk_input(&vec![b'x'; (1 << 20) + 5])` yields 17 slices, all but the last of `INPUT_CHUNK` bytes, concatenating to the input.

`zed/crates/terminal_view` `#[cfg(test)]` (D4, §3.6a):
1. `persistence.rs` `remote_terminal_row_roundtrips_u64`: `TerminalDb::open_test_db`; `save_remote_terminal(1, ws, Some(u64::MAX - 5), Some("host — Terminal"))` → `get_remote_terminal` returns the same id (bit-cast through `i64`) and title; `save_remote_terminal(1, ws, None, None)` clears both; a row written by `save_working_directory` alone reads back `Some((None, None))`.
2. `terminal_view.rs` `test_remote_terminal_restore_roundtrip`: `fake_server_with_remote_pty` plus a `FakeTerminalServer` entity that registers `SpawnTerminal → { terminal_id: 7 }`, `ListTerminals → [TerminalInfo { terminal_id: 7, title: "t", exit: None, .. }]`, `AttachTerminal → Ok`, and recording message handlers for `TerminalInput`/`AckTerminalOutput`/`ResizeTerminal`/`CloseTerminal` (no `HeadlessProject`, no real PTY — the existing `init_remote_test` at `:2607-2640` is the shape, with the handlers replacing its bare `Ping`). Open a terminal via `create_terminal_shell`, add it to the panel, `run_until_parked` until the `TerminalDb` row for its item id carries `remote_terminal_id == Some(7)`; `forget_remote_transport()` on the terminal and drop the view; `TerminalView::deserialize(project, .., item_id)` → a view whose terminal has `remote_terminal_id() == Some(7)`, `title(true) == "t"` (or the persisted `remote_title`), and the fake saw exactly one `AttachTerminal { terminal_id: 7, from_offset: 0 }` after the restore and no `CloseTerminal`.
3. `terminal_view.rs` `test_dropped_remote_terminal_is_closed`: as 2 but `ListTerminals` answers `[TerminalInfo { terminal_id: 9, .. }]` (7 is gone); `TerminalPanel::load` restores zero terminals, the item is dropped with an info log, the fake saw `CloseTerminal { terminal_id: 9 }` exactly once, and the blank-pane fallback opened one fresh shell (`SpawnTerminal` seen once). Variant: `ListTerminals` answers `[TerminalInfo { terminal_id: 7, exit: Some(..) }]` → the item is dropped and `CloseTerminal { 7 }` is sent.

Integration tests — `zed/crates/remote_server/src/remote_editing_tests.rs` (unix only), using a new `init_test_with_remote_pty` (as `:4695-4740` but via `fake_server_with_remote_pty`). Real PTYs run on real OS threads, so each test calls `cx.executor().allow_parking()` and polls with `loop { cx.run_until_parked(); server_cx.run_until_parked(); if cond() { break } std::thread::sleep(10 ms) }` under a 10 s real-time deadline (`advance_clock` only moves the fake clock — `terminal.rs:3888` is the precedent). `remote_directory_environment` is short-circuited under test (`environment.rs:259-261`), so `GetDirectoryEnvironment` is not exercised here.
1. `test_remote_terminal_roundtrip`: `project.create_terminal_shell(Some("/"), cx).await` (mock shell is `sh`, `mock.rs:306`) → `terminal.read(cx).is_remote_pty()`; `input(b"printf marker-%s x\r")`; poll until `get_content()` contains `marker- x`; `HeadlessProject.pty_manager.list().len() == 1` on `server_cx`; `input(b"exit\r")` → `Event::CloseTerminal`; the exited entry stays until the entity drops (a `CloseTerminal` from `Drop` is not sent because `attached` is false, so the server removes it on the exit path — assert `list()` is empty after the exit).
2. `test_remote_terminal_survives_disconnect`: as above, then `client.simulate_disconnect(cx)` (pattern `:2780-2810`), `input(b"printf outage-%s y\r")` during the outage, wait for `Reconnected`; `outage- y` appears **exactly once**, offsets are contiguous across the outage, and the server saw `AttachTerminal { from_offset == remote_next_offset() at reconnect }`. Then `simulate_disconnect` twice in quick succession → two `Reconnected`s, still exactly one echo per input.
3. `test_remote_task_terminal_reports_exit_code`: `create_terminal_task(SpawnInTerminal { command: Some("sh"), args: ["-c", "exit 4"], label: "t", ..})` → `wait_for_completed_task` gives `code() == Some(4)`, the `SpawnTerminal` carried `task_id` and `title == "t"`.
4. `test_remote_terminal_input_order_across_channel`: 200 separate `terminal.input(&[b])` calls to a `cat` task; the echoed sequence is in order.
5. `test_two_remote_terminals_stream_concurrently`: two shells each running `yes | head -c 4000000`; both finish; each terminal's `remote_next_offset()` reaches its `TerminalExited.end_offset`; no cross-terminal offset regressions.
6. `test_ctrl_c_interrupts_foreground`: `input(b"sleep 30\r")`, then `input(b"\x03")`, then `input(b"printf after-%s z\r")` → `after- z` appears within 2 s.
7. `test_kill_active_task_completes_wait`: task `sh -c 'sleep 30'`; `kill_active_task()`; `wait_for_completed_task` resolves within 2 s with `signal() == Some(15)` (or 9) and `code() == None`.
8. `test_osc52_from_remote_sets_clipboard`: `input(b"printf '\\033]52;c;aGVsbG8=\\a'\r")` → `cx.read_from_clipboard()` text is `hello` (`pty_term_config` keeps OSC 52 enabled).
9. `test_ssh_style_mock_keeps_build_command`: with plain `init_test` (mock `supports_remote_pty() == false`), `create_terminal_shell` fails with an error naming the `mock` program and `pty_manager.list()` is empty — SSH/WSL/Docker projects are untouched.
10. `test_list_terminals_roundtrip`: one shell; `proto_client.request(ListTerminals { project_id: REMOTE_SERVER_PROJECT_ID })` returns one `TerminalInfo` with the shell's `terminal_id`, `title == "<host> — Terminal"`, `exit == None`.
11. `test_resize_before_first_output`: create the terminal, `set_size(120x40)` + `sync` before any output, then `input(b"stty size\r")` → `40 120`.
12. `test_attach_after_server_restart_marks_lost`: after 1, `simulate_disconnect`, then on `server_cx` `PtyManager::install(REMOTE_SERVER_PROJECT_ID, Arc::new(new_session), cx)` and a fresh `HeadlessProject` via `fake_server_with_opts_and_remote_pty` (a replaced manager with no entries), wait for `Reconnected` (the mock transport reconnects to whatever server is registered; b1's WebSocket transport would instead end with `Ok(90)`, b1:269, and go through the restore path — this test pins the defensive `push_lost` branch of §3.6); the terminal's content contains `no longer available`, `has_active_pty_resources() == false`, and typing sends nothing.
13. `test_remote_init_command_handshake`: interactive shell with `start_init_command_startup_handshake()` + `write_init_command_after_startup(b"printf init-%s ok\r")` → `init- ok` appears (the marker echo path works over the wire); the timeout fallback is not needed.
14. `test_unknown_terminal_output_is_dropped`: send a raw `TerminalOutput { terminal_id: 0xdead, .. }` and `TerminalExited` from the server session; no panic, no `Event`, `local_terminal_handles()` unchanged.
15. `test_fresh_client_restores_terminal_with_scrollback` (D4): as 1 up to `marker- x`; `terminal.update(cx, |t, _| t.forget_remote_transport())`, drop the entity (`Terminals.remote` loses the entry, no `CloseTerminal` is sent, `pty_manager.list().len() == 1` on `server_cx`); `project.update(cx, |p, cx| p.fetch_remote_terminal_inventory(cx)).await`; `restore_remote_terminal(id, Some("/"), Some("t"))` → `Ok(terminal)` whose `remote_terminal_id() == Some(id)`; poll until `get_content()` contains `marker- x` (replayed from offset 0 with `reset == false`); `input(b"printf again-%s y\r")` → `again- y`; `close_unrestored_remote_terminals` closes nothing (`list().len()` still 1). Then `input(b"exit\r")` → `CloseTerminal` event and `list()` empty.
16. `test_unrestored_terminals_are_closed` (D4): two shells, forget both and drop both entities; `fetch_remote_terminal_inventory` then `restore_remote_terminal(id1, ..)` only, then `close_unrestored_remote_terminals` → within 2 s `pty_manager.list()` contains exactly `id1`; the second shell's process is gone (`/proc`). A second `restore_remote_terminal(id1, ..)` returns `Err(RemoteTerminalGone)` (already taken).
17. `test_exited_terminal_is_not_restored` (D4): shell; `input(b"exit\r")`; forget and drop; `fetch_remote_terminal_inventory` → `restorable[id].exit == Some(code 0)`; `restore_remote_terminal(id, ..)` → `Err(RemoteTerminalGone)` and the server removed the entry (`list()` empty) because the restore sent `CloseTerminal`.

Existing tests that must stay green: `zed/crates/terminal/src/terminal.rs` module tests (local PTY path untouched; the test-module match at `:5602-5610` gains an arm), `zed/crates/agent/src/agent.rs:3924-3950` (`has_active_pty_resources`/`is_pty` on local terminals), and the whole `remote_editing_tests.rs` suite plus every other `fake_server` user (`zed.rs`, `collab`, `sidebar`, `extension_host`, `recent_projects`, `terminal_view`) — the mock's default `supports_remote_pty()` stays `false`, so none of them change behaviour.

## 7. Risks and open questions

1. b1/b2 dependency: `WebSocketRemoteConnection::supports_remote_pty() == true` (b1 — still missing from b1's text, §7.18) and `serve`'s session handling (b2) are assumed. Reconnect keeps the `ChannelClient` (b2:447-452, D3), so the `FlushBufferedMessages` + `AttachTerminal` path in §3.10 applies; fresh sessions restore terminals through §3.6a (D4). D20 binds b2 to (a) exclude `AckTerminalOutput`/`ResizeTerminal`/`ListTerminals`/`AttachTerminal` from `is_input_envelope` (§3.8) and (b) call `PtyManager::detach_all()` from its session-detach hook and never `kill_all` on a fresh session; (c) `MAX_FRAME_BYTES` is 16 MiB on both sides (D3, b1:131), far above `OUTPUT_CHUNK`/`INPUT_CHUNK` + envelope overhead.
2. Wasm: `std::process::ExitStatus` on `wasm32-unknown-unknown` cannot represent a non-zero code (unit stub, `unsupported.rs:201-216`), hence `task::ExitStatus` in §3.5a. The `terminal` crate itself does not build for wasm today (unconditional `alacritty_terminal`/`libc`/`sysinfo`, `pty_info.rs:37`); this brief only guarantees the new code path spawns no thread and uses only `std`/gpui-foreground primitives. b6 gates the rest (including the `alacritty_terminal → polling` `compile_error!` that b5 §7 item 10 attributes to "the terminal brief": it is the vendored-crate gate, b6 §3.6 / D10, not this brief's); the `ExitStatus` import swaps are this brief's (§3.5a). Nothing here was verified by compiling (no `cargo check` allowed in this pass).
3. Ordering guarantee: `TerminalInput` order relies on `ChannelClient` spawning handler futures on the foreground executor in arrival order (`remote_client.rs:1831`) and on GPUI polling freshly spawned tasks FIFO (real and test schedulers keep per-session FIFO, `test_scheduler.rs:344-348,606-617`). The handlers do their work before any `.await`; integration test 4 asserts the property end-to-end (server test 3 only covers `PtyManager::write`). A sequence number in `TerminalInput` is the fallback if the executor ever reorders first polls.
4. Flow control: the reader thread blocks on the ack window only while **attached**; a client that stops acking (crashed tab) freezes the child at `OUTPUT_WINDOW` until b2 detaches the session (`detach_all`) or a new client attaches. Detached children keep running into the ring, so a long build does not hang while nobody is looking. Interactive programs that poll the PTY may look hung for the next viewer until acks resume.
5. Memory and threads: per terminal `2 MiB ring + ≤ 512 KiB in flight + up to (512 KiB + 2 MiB) of transient envelope clones in ChannelClient.buffer right after an attach replay`, plus three OS threads; `MAX_TERMINALS = 64` (→ ≤ 192 threads) caps it and `spawn` returns an error beyond that. Exited terminals keep their ring until `CloseTerminal`; since fresh sessions no longer kill anything (D3), the restoring client closes every inventory entry it does not restore (§3.6a), so nothing leaks past a reload either — a workspace whose client never returns keeps at most `MAX_TERMINALS` rings until the sandbox stops.
6. Terminal title/cwd: `PtyProcessInfo` polling (`pty_info.rs:200-239`) is local-only, so remote tabs show the `"<host> — Terminal"` override or OSC titles, exactly like ssh today; `TerminalInfo.cwd` uses `/proc/<pgrp>/cwd` (Linux only, best-effort). Streaming cwd changes to the client (for `working_directory()` and new-tab inheritance) is out of scope.
7. `Project::exec_in_shell` (`terminals.rs:517-577`, vim `:!`) and `create_local_terminal` keep using `build_command`/local PTYs natively; on wasm both return an explicit `Err` when the connection supports remote PTYs (§3.6), so the UI shows `FailedToSpawnTerminal` rather than panicking. Hiding the "new local terminal" actions (`terminal_view.rs:222-228`, `terminal_panel.rs:754,948`) stays with W3.
8. Restore after page reload is in scope (D4, §3.6a) and nothing here is deferred. Residuals: (a) after a sandbox stop/resume every PTY process is gone, so `ListTerminals` is empty and every persisted terminal is dropped — panes survive only through the blank-pane fallback (`persistence.rs:284-313`, one fresh shell per empty pane), not one shell per tab in its persisted cwd; D4 says "drops the rest", so per-tab recreation is deliberately not done and is flagged for the tech lead as a possible follow-up (the persisted `working_directory` column already carries what it would need). (b) The image is flushed every 15 s / on hide / on STOPPING (D7), so a terminal opened in the last seconds before a crash or takeover is not in the image and is closed by the reap in §3.6a — the intended "no ghosts" outcome, noted so nobody files it as a bug. (c) `TerminalDb` rows for tasks are never written (`persistence.rs:66-72`, `terminal_view.rs:1870-1872`), so task terminals are never restored — same as desktop.
9. Signal-mask parity: portable-pty clears the child's signal mask (`unix.rs:254`) rather than applying the foreground mask alacritty does (`tty/unix.rs:309-311`); on the server there is no GUI thread mask to preserve. Ctrl-C delivery is covered by integration test 6.
10. `Shell::System` on the server runs `$SHELL -l` from the server's environment; if the sandbox supervisor launches `zed-remote-server` with a minimal env, `SHELL` may be unset and `/bin/sh` is used. b8 should set `SHELL` (and `HOME`, `USER`) in the supervisor and avoid exporting secrets into the server process env, since children inherit it (§3.8 contract). Verified against b8's current revision: it exports no `SHELL` (the universal image sets `HOME=/vercel`, b8:110) and D18 does not add one, so today the server would run `/bin/sh -l`; the ask stands (§9 lists it as unresolved). The server resolves `Shell::System` through `util::shell::get_system_shell()` (`util/src/shell.rs:71`: `$SHELL`, else `/bin/sh`) so the behaviour matches local Zed the moment b8 exports it. D18's "no `ZS_CONTROL_SECRET` in the server environment" also means no secret reaches terminal children through this path.
11. Windows builds of `remote_server`: `pty.rs` compiles with portable-pty's ConPTY backend; `killpg`, `waitpid`, `process_group_leader` and `/proc` are `cfg(unix)`, with `killer.kill()`/`child.wait()` arms elsewhere. Tests are `cfg(all(test, unix))`, so Windows has zero runtime coverage; `cargo check -p remote_server --target x86_64-pc-windows-msvc` is the CI guard (§5).
12. **b6 conflict — resolved by D17.** b6 rev. 2 (its §3.6, §4.2 and §8 R1-1/R2-1/R2-3/R2-10) dropped its `RemotePty`/`RemotePtyEvent`/`spawn_pump`/`reattach_remote`/`last_exit_code` design and records that b3 owns `remote_pty.rs`, `TerminalType::Remote`, `PtyEvent::{Output, RemoteLost}`, every `Remote` match arm (including the `:5602-5610` test helper) and `task::ExitStatus`; b3 adopted b6's `RemoteTerminalOptions` shape (offset/ack bookkeeping stays next to the parser so an ack means "parsed"). The remaining seam is one line: `process_remote_output` advances `Processor<SyncHandler>` and ends with `self.expire_sync_update(cx)` (§3.5g, client test 15). Both briefs may start on `terminal.rs`; b6 §3.6 touches `:53` and the `output_processor` type, b3 everything `Remote`.
13. Token expiry mid-session (BUILD-SPEC §13): if b2 later closes sessions at `exp`, the client reconnects and `reattach_remote_terminals` runs again; it is idempotent (offset dedup, `max` acks), so terminals need nothing more. Added to the chaos list.
14. Server restart: with b1's WebSocket transport a restart is terminal for the client (`reconnect && !HelloAck.resumed` → `Ok(90)`, b1:269; a stale epoch → 4001, D3), so the tab never reaches `Reconnected` — the next open is a fresh session, `ListTerminals` is empty and every persisted terminal is dropped (§3.6a). Random terminal ids plus `push_lost` on an `AttachTerminal` error (§3.6) remain as defence in depth (and are what the mock transport exercises, integration test 12): a surviving tab shows a notice instead of attaching to a stranger's terminal. b1's session epoch lives at the Hello level, not in this protocol; if a random id ever collides (2⁻⁶⁴) the client would silently attach to the wrong terminal.
15. Attach-vs-live overlap after a reconnect can deliver the same bytes twice on the wire (once live, once replayed); the offset dedup makes that harmless but doubles bandwidth for the overlap window (≤ `OUTPUT_WINDOW`). Acceptable.
16. Host PID for remote terminals (deferred to b3 by b6 §7 item 6 / §8 R2-1). `Terminal::pid()` is `None` for `Remote` (§3.5l), so `debugger_ui`'s `RunInTerminal` (`debugger_ui/src/session/running.rs:1389-1392`) fails with "Terminal was spawned but PID was not available" for `console: integratedTerminal` debugging against a remote-PTY project; `terminal_view.rs:1446-1447` (`pid_getter()?`) tolerates `None`. The server knows the child pid (`TerminalEntry.child_pid`) and `SpawnTerminalResponse`/`TerminalInfo` could carry it, but a host pid is meaningless to the client's `sysinfo` calls, so the fix is a debugger-side change (send the pid to the server-side DAP adapter, which already runs on the host) — out of scope here, recorded for the debugger brief.
17. Foreground process / cwd for remote tabs (b6 §7 item 6): `foreground_process_command_name`/`client_side_working_directory` are `None` (§3.5l) and `working_directory()` stays `None` (`terminal.rs:2878-2887`), so new-tab cwd inheritance and the agent panel's `foreground_process_command_name` consumer (`agent_panel.rs:1098`) see nothing for remote terminals — same as ssh today. `TerminalInfo.cwd` (Linux `/proc/<pgrp>/cwd`) is available at restore time and is used only as the cwd seed there; a `TerminalProcessChanged` notification streaming cwd/title changes is the follow-up BUILD-SPEC §5.1 hints at.
18. **Delta addressed to b1.** `supports_remote_pty` is a trait method with a `false` default (§3.4); b1's `impl RemoteConnection for WebSocketRemoteConnection` (b1:199) does not override it. Until b1 adds `fn supports_remote_pty(&self) -> bool { true }`, browser terminals fall back to `build_command` (which the WebSocket connection cannot run) and fail with `FailedToSpawnTerminal`. Recorded in §9 as unresolved on b1's side; nothing in this brief can substitute for it.

## 8. Review log

Reviewer 1 — wrong claims
1. `process_remote_output` "emits nothing": **accepted** (verified `subscribe` `:1405-1409`/`:1445-1448`/`:1450-1457`; `write_output` `:1970-1971`). §3.5g now emits `Event::Wakeup` and runs the marker scan after every parse; §3.5f no longer routes `Output` through the `wakeup` flag.
2. Duplicate-exit guard "inside `push_exit`": **accepted** (`push_exit` only owns `events_tx`; `register_task_finished` `:3129-3136`). Guard moved into `process_event`'s `ChildExit` arm (§3.5h), which is now listed as changed.
3. Passing `settings` whole after `settings.env` was moved (`:136`, `:378`, `:406`): **accepted**. §3.6 builds `RemoteTerminalOptions` from the still-owned fields.
4. `terminals.remote[&id].terminal = ..` on `collections::HashMap`: **accepted** (`FxHashMap`, no `IndexMut`). §3.6 uses `get_mut` and `Option<WeakEntity<Terminal>>`; `WeakEntity::new_invalid` noted but not used.
5. `PtyManager::new` registering `on_app_quit` over a by-value struct: **accepted** (`app.rs:2352-2366` closure gets `&mut App`; `server.rs:731`; `SHUTDOWN_TIMEOUT` 200 ms). §3.8 now has `Arc<PtyManagerState>`, `kill_all(&self)`, a bounded SIGTERM→SIGKILL future and `impl Drop`.
6. Wasm `ExitStatus` lacks `Display`: **accepted** (`terminal.rs:755` uses `{status}`; std stub `unsupported.rs:215`). Added; the type also moved to `task` (see R2-8).
7. "Works on wasm": **accepted as overstated** (no wasm cfg in `crates/terminal`; unconditional `libc`/`sysinfo`/`alacritty_terminal`). §1 and §7.2 now claim only that the new path spawns no thread; crate-level wasm compilation is b6's.
8. Missing `Remote` arm in the test-module match `:5602-5610`: **accepted**; added to §2 and §3.5d.
9. `is_pty()` production consumer `agent_panel.rs:2147` omitted: **accepted**; §3.5k now states that remote terminals run the marker handshake over the wire, `write_init_command_after_startup` becomes reachable, and integration test 13 covers it.
10. portable-pty `signal()` is a `strsignal` string, `exit_code()` forced to 1: **accepted** (lib.rs:215-226; macOS prints `"Interrupt: 2"`-style strings — verified with a C snippet). §3.8 uses `libc::waitpid` + `WIFEXITED/WIFSIGNALED` and sends `code: None` when signalled; server test 5 updated.
11. `TerminalExited.exit` is `Option<TerminalExit>` in prost: **accepted**; `unwrap_or_default()` in §3.6.
12. Missing trailing comma at `proto.rs:876`: **accepted**; §3.3 says to add it.
13. Unacked buffer "at most `OUTPUT_WINDOW`": **accepted**; §3.10/§7.5 now say `OUTPUT_WINDOW + SCROLLBACK_CAPACITY` transiently after an attach replay.
14. Integration tests polling with `advance_clock`: **accepted** (`terminal.rs:3888` `allow_parking`; `environment.rs:259-261`). §6 specifies `allow_parking` + real-time sleep polling and notes the env short-circuit.

Reviewer 1 — missing items
- Shared ownership of the terminal map: **accepted** (see R1-5).
- `kill_active_task` leaving `attached == true` / lost post-SIGTERM output: **accepted** with the server-side variant: `CloseTerminal` kills but keeps streaming until exit and removes the entry after `TerminalExited` (§3.5n/o, §3.8 close, §4 semantics, server test 9, client test 11).
- `is_pty()` in `start_init_command_startup_handshake` (`:2143`) and `agent_panel.rs:2147`: **accepted** (see R1-9).
- `SHLVL`/`LANG` fix-ups: **accepted**; the server applies both (§3.8), and `new_remote` explicitly does not (§3.5e); server test 15.
- Spawn-time ordering assumption: **accepted** by removing it — the server now spawns detached and the client attaches explicitly after inserting the entry; the (weaker) invariant is written down in §3.6 and server test 11 covers the detached spawn.
- `Send + Sync` on `RemotePtyTransport`: **accepted**; bound dropped (`'static` only) with a note that `AnyProtoClient` is `Send + Sync` regardless.
- `process_group_leader` is `#[cfg(unix)]` on the trait: **accepted**; the `list()` cwd call is `cfg(target_os = "linux")`.
- `PtyPair.slave` must be dropped after spawn: **accepted** (lib.rs:254); stated in §3.8.
- Unknown-id behaviour after close: **accepted**; `Err(anyhow!("unknown terminal {id}"))` specified, server test 13. The removed-while-running race no longer exists because entries are removed only after exit.

Reviewer 2 — wrong claims
1. `remote_id().unwrap_or(REMOTE_SERVER_PROJECT_ID)`: **accepted** (43 sites use the constant; only `download_file` differs; `remote_id()` is `Some` for `Shared`; `headless_project.rs:280` subscribes id 0 only). All terminal requests use `REMOTE_SERVER_PROJECT_ID`.
2. Wakeup emission: **accepted** (same as R1-1).
3. Gap handling and sends from OS threads: **accepted** on both counts (`send_dynamic` `:2031-2034` assigns ids outside the locks; `max_received` `:1780` is a last-write). Gap → drop chunk + `transport.resync(next_offset)` with a `resync_pending` latch, never a grid clear (§3.5g, client test 4); server sends go through one foreground drain task (§3.8 `OutboundMessage`, §3.10).
4. `waitpid` decoding and `code: None` when signalled: **accepted** (same as R1-10; `task_summary` `:3224-3231` verified).
5. `on_app_quit` / `Drop` / no signal handler: **accepted** (same as R1-5; `server.rs` has no signal handling — noted in §2).
6. `WeakEntity` has no empty state; INVARIANT comment: **accepted**; `Option<WeakEntity>` and the invariant comment are in §3.6. With detached spawn the invariant reduces to "insert before sending `AttachTerminal`" and the requested client-side test became server test 11 + integration test 14 (unknown-id output is dropped).
7. Server test 3 does not cross `ChannelClient`: **accepted**; integration test 4 added; §7.3 corrected.
8. `ExitStatus` cannot live in `terminal` for `workspace`; consumer list incomplete: **accepted** (`workspace/Cargo.toml:64` has `task` but no `terminal`; `workspace.rs:134,197`, `acp_thread.rs:36,2236`, `agent_servers/src/acp.rs:2109,2133`, `running.rs:1229`, `conversation_view.rs:2171-2185` verified). Type moved to `task::ExitStatus` (§3.5a), consumers listed in §2.
9. Sequential ids collide after a server restart; `AttachTerminal` errors dropped: **accepted**. Random 64-bit ids (`uuid` v4, already a dependency), `push_lost` on attach error (§3.5b/g, §3.6), idempotent reattach with `max` acks; integration test 12; §7.14. A `server_epoch` field was not added (§7.14 records the residual 2⁻⁶⁴ collision). **Rev. 3:** b1 carries a session epoch in `Hello`/`HelloAck` (D3), which makes a post-restart reconnect terminal before any `AttachTerminal` is sent; §7.14 rewritten and integration test 12 re-scoped to the mock transport.
10. Flipping the mock's `supports_remote_pty()` globally: **accepted in substance, different mechanism** — `MockConnectionOptions` has 10 constructor sites, so instead of a new field there, `MockRemoteConnection` gains `remote_pty: bool` (default `false`) with `fake_server_with_remote_pty`/`fake_server_with_opts_and_remote_pty` constructors (§3.4); only the new tests opt in.

Reviewer 2 — missing items
- b6 API conflict: **accepted as blocking**; ownership decision recorded in §1 and §7.12, `RemoteTerminalOptions` adopted from b6. **Rev. 3:** resolved by D17 and b6 rev. 2 (§7.12); the `SyncHandler`/`expire_sync_update` seam added to §3.5g.
- Orphaned terminals on reload/takeover: **accepted**, option (b) now (`kill_all` from `begin_fresh_session`, `detach_all` on detach) with (a) as the follow-up that replaces it (§3.8, §3.10, §7.8). **Rev. 3:** D3/D4 chose option (a): the fresh-session `kill_all` is gone, `detach_all` stays (D20), and the restore is specified in §3.6a.
- Idle accounting: **accepted**; input/non-input message classification in §3.8 and §7.1 for b2. **Rev. 3:** binding on b2 via D20.
- Foreground stall bound by event count: **accepted**; `REMOTE_PARSE_BUDGET = 256 KiB` per turn in `subscribe` (§3.5c/f, §3.10, client test 13). Background parsing natively is left as a measured follow-up.
- Unchunked input vs. frame ceiling: **accepted**; `INPUT_CHUNK = 64 KiB` in `ProtoPtyTransport::input`, `chunk_input` unit test.
- Reconnect ordering vs. attach replay: **accepted**; `resync` at `:714` before `Reconnected` at `:761` verified; stated in §3.10 and asserted by integration test 2; `reset_for_fresh_client` dependency noted. **Rev. 3:** that dependency is now `begin_fresh_session`'s buffer reset (b2 §8 R2-3), §3.10.
- Test gaps (1)-(11): **accepted**; added as client test 4, integration tests 4-14 and server tests 11-16. The `acp_thread` `release_pty_resources`-while-reading case (8) is covered by client test 10 (close is sent once and the grid stays readable) rather than a dedicated acp test.
- Sends from OS threads / Windows CI: **accepted**; foreground drain (§3.8) and the Windows `cargo check` guard (§5, §7.11).
- `create_local_terminal`/`exec_in_shell` on wasm: **accepted**; explicit `Err` under `cfg(target_family = "wasm")` when the connection supports remote PTYs (§3.6, §7.7).
- Server env parity, task title, cwd Linux-only: **accepted** (§3.8, §4; server test 15; `SpawnTerminal.title` is the task label for tasks).
- Trust statement and `TerminalError` wrapping: **accepted** (§3.6).
- Token expiry: **accepted** (§7.13).
- `local_handles` bookkeeping: **accepted**; remote terminals stay in `local_handles`, documented on the field (§3.6).
- Duplicate-exit guard location: **accepted** (same as R1-2).
- Server memory figure and thread cap: **accepted** (§7.5, `MAX_TERMINALS`, server test 14).
- Windows `exit_status_from_remote` dropping the signal: **accepted**; `128 + signal` (§3.5a).


## 9. Reconciliation log (revision 3)

Each decision in `DECISIONS.md` and each sibling delta addressed to this brief, with what changed here. "No impact" entries are listed so the check is auditable.

Decisions
- **D1 Identity.** Consumed, not defined: `"<host> — Terminal"` uses `connection_options().display_name()`, which for b1's transport is the URL host, else the D1 identity `workspace_id` (§3.6, §2 sibling citations). Persistence of terminal rows keys on `workspace_id` through `WorkspaceId`, never on `session_id`, so D1's "persistence never depends on `session_id`" holds for `TerminalDb` (§3.6a).
- **D2 Reconnect budget.** New §3.10 bullet "Terminal outcomes on the client": after `ReconnectExhausted`/4001/4005 no `Reconnected` fires, terminals keep their grid, and the host `reconnect()`/reload is a fresh session that goes through the D4 restore. No code change beyond what D4 already requires.
- **D3 Session semantics.** `PtyManager` moved out of `HeadlessProject` into a process-level `App` global (`GlobalPtyManager`, `PtyManager::{global, install}`, §3.8); `HeadlessProject.pty_manager` is now `Arc<PtyManager>` obtained lazily in `new` (§3.9); `kill_all` is called only from `on_app_quit`/`Drop`, never from `begin_fresh_session` (§3.8 comments, §3.9, §3.10, §7.5); `detach_all` on session detach kept and tied to b2's hook (§3.9). §2 records why a `HeadlessAppState` field was rejected (27 construction sites) and refreshes the b2/b1 citations to the Hello-time arbitration, epoch, 4001/4005/1001 and 16 MiB wording. `MAX_FRAME_BYTES` references now point at b1's `wire.rs` (§2, §7.1).
- **D4 Terminal restore in scope.** New §3.6a (`TerminalDb` migration `remote_terminal_id`/`remote_title`, `save_remote_terminal`/`get_remote_terminal`, `TerminalView::{new, serialize, deserialize}` changes, `TerminalPanel::load` inventory + reap, `deserialize_terminal_views` info-level drop); new `Project` API (`supports_remote_pty`, `fetch_remote_terminal_inventory`, `restore_remote_terminal`, `close_unrestored_remote_terminals`, `adopt_terminal_builder`, `Terminals.restorable`, `RemoteTerminalGone`, §3.6); `RemotePtyState.working_directory`, `remote_working_directory()`, `title_override()`, `forget_remote_transport()` (§3.5c/e/g); §3.10 fresh-session paragraph rewritten; §4 types and wire semantics extended; §5 dependency note; §6 terminal_view tests 1-3, client test 14, server test 17, integration tests 15-17; §7.5 and §7.8 rewritten (nothing deferred; residuals listed); §8 rev. 3 annotations. §1 goal updated.
- **D5 Control listener.** No impact (b2/b8 surface; no terminal message crosses `/control`).
- **D6 Unsaved buffers.** No impact (buffer store; terminals hold no client-side text to save).
- **D7 Client-state store.** Consumed: `TerminalDb` rows ride in the `AppDatabase` image; the flush cadence explains the reap residual (§3.6a, §7.8b).
- **D8 Private ports.** No impact.
- **D9 Rebuild tarball.** No impact (PTYs are processes, not files; the server data dir holds no terminal state).
- **D10 Vendored dependencies.** §2 alacritty evidence now says the workspace builds `zed/vendor/alacritty_terminal` (b6's `[patch]`, not yet in the tree) and that the cited upstream lines are unaffected; §5 notes no new dependency and no `<org>` placeholder anywhere in this brief (there was none).
- **D11 Wasm home directory.** No impact (server-side PTYs run natively; `/home/web` is the browser's settings/keymap home).
- **D12 Web keymap layer.** No impact on this brief (terminal `ctrl-w` bindings live in b7's `web.json`).
- **D13 Activity ping.** No impact beyond idle accounting (D20): terminal output/acks never count as input, so `lastInputAt` is driven by keystrokes only (§3.8).
- **D14 Prebuild / D15 AI proxy.** No impact.
- **D16 Entry point.** Consumed: the restore relies on the image being loaded before `deserialize_remote_project`, so `TerminalPanel::load` sees the rows (§3.6a).
- **D17 Terminal ownership.** §1 ownership paragraph rewritten; §2 `:1509` note; §3.5g advances `Processor<SyncHandler>` and ends with `self.expire_sync_update(cx)`; §7.12 marked resolved; client test 15 pins the seam; §3.5a takes ownership of the native `ExitStatus` import swaps b6 left to "the owning briefs".
- **D18 Supervisor contract.** No direct impact; §7.10 verified b8 exports no `SHELL` and notes the server helper used (`get_system_shell`). Left as an ask to b8 (unresolved list).
- **D19 Control plane contract.** No impact.
- **D20 serve contract.** §3.8 idle-accounting paragraph and §7.1 now cite D20 as binding on b2 for the four `is_input_envelope` exclusions and for `detach_all`-never-`kill_all`; §3.9 names b2's `SessionDetached` hook; §2 citations to b2's `is_input_envelope` (`:431`) and b4's three exclusions.

Sibling deltas addressed to b3
- **b4 (`:9`, `:24`, `:120`, §7 item 1, §8 item 5):** tags 500-514, not 500-513 — §2 protocol bullet and §3.2 comment corrected; 488-499 unchanged.
- **b6 (`:5`, `:355`, `:379`, `:443`, `:445`, `:464`, `:473`, `:692-708`, §7 items 3/5/6/17, §8 R1-1, R2-1..R2-3, R2-10, R2-12, R2-13, missing items 1-4, 12):** ownership accepted as recorded (§1, §7.12); `SyncHandler`/`expire_sync_update` seam adopted (§3.5g); `new_term` reuse and `pty_term_config` unchanged; wasm `TerminalBuilder::new` twin left to b6 and referenced from §3.6's explicit `Err`; `ExitStatus` import swaps taken into §3.5a (b6 keeps `acp_thread/src/terminal.rs`); deferred items answered — host PID (§7.16), foreground process/cwd (§7.17), `is_remote_pty()` accessor for `clone_terminal` (§3.5g/§3.6, already present), `RemoteLost`/input-while-disconnected (§3.5g/h, §3.10), `has_active_pty_resources` after lost (client test 12), grid readable after `release_pty_resources` (§3.5o, client test 10); the `:5602-5610` test-helper arm confirmed as b3's (§3.5d).
- **b5 (§7 item 10):** the `alacritty_terminal → polling` `compile_error!` is b6's vendored-crate gate; §7.2 says so to stop it being re-filed against this brief.
- **b1:** no delta addressed to b3 in its text, but b3 depends on a method b1 does not define — `WebSocketRemoteConnection::supports_remote_pty() -> true` (§3.4, §7.18). Also refreshed: server-restart semantics (`Ok(90)` terminal, no `Reconnected`; §3.6, §7.14, integration test 12), `Reconnected` emission point, `display_name()`.
- **b2:** no delta addressed to b3 in its text; citations refreshed (`ServeHooks`, `begin_fresh_session`, `GpuiCommand`, `reset_for_new_client`, `is_input_envelope`, attach algorithm); the `reset_for_fresh_client` dependency replaced by `begin_fresh_session`'s buffer reset (§3.10).
- **b7, b8, b9:** nothing addressed to b3. b7's "terminal" mentions are terminal *outcomes*; b8 verified for `SHELL` (§7.10); b9 untouched.

Contradictions removed
- `kill_all` from `begin_fresh_session` (§3.8, §3.9, §3.10, §7.1, §7.5, §7.8; §8 annotated rather than rewritten).
- `HeadlessProject`-owned `PtyManager` and "tests drop `HeadlessProject` so `Drop` must clean up" (§2, §3.8, §3.9).
- "Restore is a follow-up" (§7.8, §2 persistence bullet, §3.10).
- b4 tag range 500-513 (§2, §3.2).
- b1 line citations `:149-166`, `:582`, `:598` and b2 citations `:116-122`, `:268`, `:298-303`, `:342-350`, `:357-362` (all refreshed).
- "b6 must be amended before either starts" (§1, §7.12).
