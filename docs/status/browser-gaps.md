# Browser gaps — source audit, 2026-09-07

This separates unavailable features from real work delegated to the sandbox. It
is a code audit, not a claim that each feature was exercised live.

| Area | Current browser behavior | Source |
|---|---|---|
| Extensions | Server installation RPCs exist, but the extension marketplace UI and browser extension-host integration are not initialized. Arbitrary downloaded syntax grammars cannot load; grammars must be linked into the browser build. | `zed/crates/zed_web/src/init.rs`, `zed/crates/project/src/remote_extension_store.rs`, `zed/crates/language/src/language_registry.rs` |
| Debugger | Panels/actions are initialized, but launch/attach still needs the desktop command/TCP transport. Browser debug-adapter startup and downloads return errors. This is not working end-to-end. | `zed/crates/project/src/debugger/dap_store.rs`, `zed/crates/dap/src/transport.rs`, `zed/crates/remote/src/transport/websocket.rs` |
| Jupyter / REPL | Not initialized in the browser. | `zed/crates/zed_web/src/init.rs` |
| Calls and audio | No native Zed channels/call UI, voice, screen sharing, audio-device selection or audio test window. Anonymous collaborative editing is separate and works. | `zed/crates/title_bar/src/collab_web.rs`, `zed/crates/settings_ui/src/pages/audio_web.rs` |
| AI and MCP | AI is disabled by app settings. Browser-local process-backed MCP and OAuth callback servers cannot start; keychain credentials are unavailable. Compiled provider registries do not make this a supported feature. | `zed/crates/zed_web_core/src/web_settings.rs`, `zed/crates/context_server/src/transport/stdio_transport_web.rs`, `zed/crates/context_server/src/oauth.rs` |
| Local files and uploads | Native local Open/Save dialogs error. Dropped files are intercepted but not imported. Directory upload through the WebSocket transport errors. Remote project file editing/saving works. | `zed/crates/gpui_web/src/platform.rs`, `zed/crates/gpui_web/src/events.rs`, `zed/crates/remote/src/transport/websocket.rs` |
| Desktop integration | One canvas window per tab; no native extra windows, hide/minimize/zoom, OS menus/Dock menu, Reveal in Finder, Open With, protocol registration or system keychain. Browser fullscreen and ordinary external links are implemented. | `zed/crates/gpui_web/src/platform.rs`, `zed/crates/gpui_web/src/window.rs` |
| Accessibility / input | The browser backend does not implement GPUI's accessibility-tree adapter. Native IME candidate-position updates and keyboard-layout mapping are incomplete; text/composition input itself is implemented. | `zed/crates/gpui/src/platform.rs`, `zed/crates/gpui_web/src/window.rs`, `zed/crates/gpui_web/src/platform.rs`, `zed/crates/gpui_web/src/events.rs` |
| Clipboard | Async text/image reading and paste events work subject to browser permissions. Synchronous clipboard reads return nothing; copying writes text only, not arbitrary rich/image clipboard entries. | `zed/crates/gpui_web/src/platform.rs`, `zed/crates/gpui_web/src/events.rs` |
| Fonts | Bundled fonts only; no discovery of the computer's installed system fonts. | `zed/crates/gpui_web/src/platform.rs`, `zed/crates/zed_web/src/init.rs` |
| Developer/support UI | No native reliability/crash-report initialization, telemetry collection, feedback/onboarding, inspector/miniprofiler, journal or desktop dev-container manager. | `zed/crates/zed_web/src/init.rs`, `zed/crates/client/src/telemetry.rs` |
| Smaller desktop-only helpers | Cargo-registry source permalinks, local executable/archive installers, raw TCP/UDP/Unix sockets and browser-local subprocesses return unsupported errors. Desktop-style connection commands, password prompts and native port-forward commands are not implemented by the WebSocket transport; automatic app-managed previews are separate. | `zed/crates/project/src/git_store.rs`, `zed/crates/zs_smol_shim/src/wasm/`, `zed/crates/remote/src/transport/websocket.rs` |

Not stubs: text editing, remote files, Git/history, terminals/tasks, bundled syntax,
sandbox language servers/formatters, settings/layout persistence, anonymous
multiplayer, and automatic HTTP/WebSocket preview ports. Ordinary confirmation
dialogs use Zed's in-canvas prompt implementation; the platform's `None` return is
a fallback hook, not a missing dialog. Native update installation is replaced by
the host-driven background-download/shared-restart flow.
