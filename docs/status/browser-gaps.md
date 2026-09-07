# Browser gaps — source audit, 2026-09-07

This separates unavailable features from real work delegated to the sandbox. It
is a code audit, not a claim that each feature was exercised live.

| Area | Current browser behavior | Source |
|---|---|---|
| Extensions | Server installation RPCs exist, but the extension marketplace UI and browser extension-host integration are not initialized. Arbitrary downloaded syntax grammars cannot load; grammars must be linked into the browser build. | `zed/crates/zed_web/src/init.rs`, `zed/crates/project/src/remote_extension_store.rs`, `zed/crates/language/src/language_registry.rs` |
| Debugger | Authenticated sandbox DAP transport is implemented and Node/debugpy broker diagnostics pass. Browser launch/breakpoint/step validation and deployment are pending. Native process picking and browser-local executables are not supported. | `zed/crates/zed_web/src/debugger.rs`, `sandbox/supervisor/src/debugger.rs` |
| Jupyter / REPL | Not initialized in the browser. | `zed/crates/zed_web/src/init.rs` |
| Calls and audio | No native Zed channels/call UI, voice, screen sharing, audio-device selection or audio test window. Anonymous collaborative editing is separate and works. | `zed/crates/title_bar/src/collab_web.rs`, `zed/crates/settings_ui/src/pages/audio_web.rs` |
| AI and MCP | AI is disabled by app settings. Browser-local process-backed MCP and OAuth callback servers cannot start; keychain credentials are unavailable. Compiled provider registries do not make this a supported feature. | `zed/crates/zed_web_core/src/web_settings.rs`, `zed/crates/context_server/src/transport/stdio_transport_web.rs`, `zed/crates/context_server/src/oauth.rs` |
| Local files and uploads | Native local Open/Save dialogs error. Dropped files are intercepted but not imported. Directory upload through the WebSocket transport errors. Remote project file editing/saving works. | `zed/crates/gpui_web/src/platform.rs`, `zed/crates/gpui_web/src/events.rs`, `zed/crates/remote/src/transport/websocket.rs` |
| Desktop integration | One canvas window per tab; no native extra windows, hide/minimize/zoom, OS menus/Dock menu, Reveal in Finder, Open With, protocol registration or system keychain. Browser fullscreen and ordinary external links are implemented. | `zed/crates/gpui_web/src/platform.rs`, `zed/crates/gpui_web/src/window.rs` |
| Accessibility / input | AccessKit-to-DOM, full-document text mode, caret-anchored IME, tree/picker/tab/prompt semantics are deployed. A cached-subtree omission fix and modal/composite keyboard handling await the next release. Real screen-reader/physical mobile checks and full international keyboard-layout mapping remain incomplete. | `zed/crates/gpui_web/src/accessibility.rs`, `zed/crates/gpui_web/src/ime_mirror.rs`, `zed/crates/gpui_web/src/events.rs` |
| Clipboard | Browser text/image reads, native Copy/Cut/Paste events and async action replay are implemented. Text and PNG paste were verified live; image copy lacks a verified UI consumer. Some secondary Vim/Helix register-insert paths still use synchronous reads. | `zed/crates/gpui_web/src/clipboard.rs`, `zed/crates/zed_web/src/clipboard.rs` |
| Fonts | Bundled fonts only; no discovery of the computer's installed system fonts. | `zed/crates/gpui_web/src/platform.rs`, `zed/crates/zed_web/src/init.rs` |
| Developer/support UI | No native reliability/crash-report initialization, telemetry collection, feedback/onboarding, inspector/miniprofiler, journal or desktop dev-container manager. | `zed/crates/zed_web/src/init.rs`, `zed/crates/client/src/telemetry.rs` |
| Smaller desktop-only helpers | Cargo-registry source permalinks, local executable/archive installers, raw TCP/UDP/Unix sockets and browser-local subprocesses return unsupported errors. Desktop-style connection commands, password prompts and native port-forward commands are not implemented by the WebSocket transport; automatic app-managed previews are separate. | `zed/crates/project/src/git_store.rs`, `zed/crates/zs_smol_shim/src/wasm/`, `zed/crates/remote/src/transport/websocket.rs` |

Not stubs: text editing, remote files, Git/history, terminals/tasks, bundled syntax,
sandbox language servers/formatters, settings/layout persistence, anonymous
multiplayer, and automatic HTTP/WebSocket preview ports. Ordinary confirmation
dialogs use Zed's in-canvas prompt implementation; the platform's `None` return is
a fallback hook, not a missing dialog. Native update installation is replaced by
the host-driven background-download/shared-restart flow.
