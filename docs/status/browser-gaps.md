# Browser gaps — updated 2026-09-08

This separates unavailable features from real work delegated to the sandbox. It
is a code audit, not a claim that each feature was exercised live.

Build `7b39240f7-34200616408.1` is deployed: browser file/folder selection and
project-tree uploads, browser Save write-through, completion/code-action semantics,
and the sandbox-only Astro documentColor correction. CI/full WASM checking pass;
isolated browser file probes pass Chromium, Firefox and WebKit. Real Chromium file
selection/upload preserves Unicode/binary bytes. Remaining live checks are ongoing.
Next source batch adds native adapter logs and accessible process-picker rows.

| Area | Current browser behavior | Source |
|---|---|---|
| Extensions | Server installation RPCs exist, but the extension marketplace UI and browser extension-host integration are not initialized. Arbitrary downloaded syntax grammars cannot load; grammars must be linked into the browser build. | `zed/crates/zed_web/src/init.rs`, `zed/crates/project/src/remote_extension_store.rs`, `zed/crates/language/src/language_registry.rs` |
| Curated language tools | Astro highlighting (including TypeScript/CSS), diagnostics, formatting, completion and TypeScript import navigation are deployed and verified live. TOML now uses the installed Taplo server for diagnostics/formatting. Astro's upstream server sometimes returns null document colors; Zed logs a non-blocking deserialization warning. | `zed/crates/languages/src/web_languages.rs`, `zed/crates/grammars/src/astro`, `sandbox/image/Dockerfile` |
| Debugger | Private sandbox DAP transport is deployed. Live Node, TypeScript and Python launch, breakpoints, stack/variables, stepping and stopping pass. Native process picking already uses sandbox RPC (the previous audit incorrectly called it unsupported); Node PID attach/evaluation passes a production protocol probe. See README for Node type/address and short TypeScript source-map settings. Adapter logs and accessible picker rows are in the next source batch. | `zed/crates/zed_web/src/debugger.rs`, `sandbox/supervisor/src/debugger.rs` |
| Jupyter / REPL | Inline Python execution, Unicode, persistent values, rich output, errors and input pass live. The clock/control-reply fixes are deployed; actual editor Run, Interrupt, Restart and Shutdown pass on the published image. Bundled Python or a project interpreter with ipykernel; no notebook editor or widget protocol. | `zed/crates/repl/src/kernels/web_kernel.rs`, `sandbox/image/kernel.py` |
| Calls and audio | Removed at the owner's request, including screen sharing, custom controls, browser media, signaling and TURN configuration. Not a backlog item. Collaborative editing remains. | `zed/crates/title_bar/src/collab_web.rs` |
| AI and MCP | AI is disabled by app settings. Browser-local process-backed MCP and OAuth callback servers cannot start; keychain credentials are unavailable. Compiled provider registries do not make this a supported feature. | `zed/crates/zed_web_core/src/web_settings.rs`, `zed/crates/context_server/src/transport/stdio_transport_web.rs`, `zed/crates/context_server/src/oauth.rs` |
| Local files and uploads | Browser file/folder selection, project-tree drops/imports and browser save write-through are deployed. Remote Open/Save remains native sandbox file selection. Dev-extension directory synchronization through the WebSocket transport is still unsupported; it is distinct from project-tree imports. | `zed/crates/gpui_web/src/files.rs`, `zed/crates/gpui_web/src/files.js`, `zed/crates/zed_web/src/files.rs`, `zed/crates/remote/src/transport/websocket.rs` |
| Desktop integration | One canvas window per tab; no native extra windows, hide/minimize/zoom, OS menus/Dock menu, Reveal in Finder, Open With, protocol registration or system keychain. Browser fullscreen and ordinary external links are implemented. | `zed/crates/gpui_web/src/platform.rs`, `zed/crates/gpui_web/src/window.rs` |
| Accessibility / input | AccessKit-to-DOM, full-document text mode, caret-anchored IME, tree/picker/tab/prompt semantics, cached-subtree fix and modal/composite keyboard handling are deployed. Native completion acceptance works, but suggestions are not exposed as list options in the semantic DOM. Real screen-reader/physical mobile checks and full international keyboard-layout mapping remain incomplete. | `zed/crates/gpui_web/src/accessibility.rs`, `zed/crates/gpui_web/src/ime_mirror.rs`, `zed/crates/gpui_web/src/events.rs`, `zed/crates/editor/src/code_context_menus.rs` |
| Clipboard | Browser text/image reads, native Copy/Cut/Paste events and async action replay are deployed. Text/PNG paste, secondary Vim register reads, dot repeat, motion/object replacement, cancellation, the Helix paste action and suspended macro replay pass live. Image copy lacks a verified UI consumer. | `zed/crates/gpui_web/src/clipboard.rs`, `zed/crates/zed_web/src/clipboard.rs` |
| Fonts | Bundled fonts only; no discovery of the computer's installed system fonts. | `zed/crates/gpui_web/src/platform.rs`, `zed/crates/zed_web/src/init.rs` |
| Developer/support UI | No native reliability/crash-report initialization, telemetry collection, feedback/onboarding, inspector/miniprofiler, journal or desktop dev-container manager. | `zed/crates/zed_web/src/init.rs`, `zed/crates/client/src/telemetry.rs` |
| Smaller desktop-only helpers | Cargo-registry source permalinks, local executable/archive installers, raw TCP/UDP/Unix sockets and browser-local subprocesses return unsupported errors. Desktop-style connection commands, password prompts and native port-forward commands are not implemented by the WebSocket transport; automatic app-managed previews are separate. | `zed/crates/project/src/git_store.rs`, `zed/crates/zs_smol_shim/src/wasm/`, `zed/crates/remote/src/transport/websocket.rs` |

Not stubs: text editing, remote files, Git/history, terminals/tasks, bundled syntax,
sandbox language servers/formatters, settings/layout persistence, anonymous
multiplayer, and automatic HTTP/WebSocket preview ports. Ordinary confirmation
dialogs use Zed's in-canvas prompt implementation; the platform's `None` return is
a fallback hook, not a missing dialog. Native update installation is replaced by
the host-driven background-download/shared-restart flow.
