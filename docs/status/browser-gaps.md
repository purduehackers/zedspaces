# Browser gaps — updated 2026-09-08

This separates unavailable features from real work delegated to the sandbox. It
is a code audit, not a claim that each feature was exercised live.

Build `d266d7729-34229255469.1` is deployed. Browser file transfers, completion
semantics, process labels, picker typing, extension installation/downloaded grammars,
development rebuilds and sandbox extension LSP adapters are shipped. Svelte completion
acceptance and upgrade persistence pass live Chromium; isolated file/grammar probes
pass Chromium, Firefox and WebKit.

Pushed follow-ups are blocked from release by GitHub organization billing, not code
errors: clipped/text accessibility, the channel-lock crash fix, and opt-in notebook
transport pass full WASM/native checks. Notebooks remain disabled because upstream
saving drops rich outputs; permission for that non-web-specific fix is pending.
This is not a claim that every previously stubbed feature is complete.

| Area | Current browser behavior | Source |
|---|---|---|
| Extensions | Native marketplace UI installs languages/themes/icons/snippets; code and LSPs execute in the sandbox. Browser grammars use bounded Wasmi, declarative assets use revisioned downloads, and completion/symbol labels delegate to the real extension. Dev folder upload/rebuild and cross-tab refresh are shipped; installed/dev revisions survive upgrades. SQL/Svelte highlighting and Svelte completion/formatting pass live. | `zed/crates/extension_host/src/web.rs`, `zed/crates/project/src/remote_extension_store.rs`, `zed/crates/language_extension/src/remote_lsp_adapter.rs` |
| Curated language tools | Astro highlighting (including TypeScript/CSS), diagnostics, formatting, completion and TypeScript import navigation pass live. TOML uses Taplo. The sandbox image corrects Astro's null document-color response. A separate null pull-diagnostic warning still needs server attribution. | `zed/crates/languages/src/web_languages.rs`, `zed/crates/grammars/src/astro`, `sandbox/image/Dockerfile` |
| Debugger | Private DAP, native process picking and early adapter-log buffering are shipped. Node/TypeScript/Python launch, breakpoints, variables, stepping/stopping passed earlier live checks. Further native Node PID attachment reproduced forbidden `Atomics.wait` in futures-channel. Browser-only dependency fix is pushed, not deployed; forced channel/mutex contention passes all three engines, pristine dependency reproduces the crash. Live attach and early-log UI recheck remain required. | `zed/crates/zed_web/src/debugger.rs`, `sandbox/supervisor/src/debugger.rs`, `zed/vendor/futures-channel`, `zed/vendor/futures-util` |
| Jupyter / REPL | Inline Python execution, Unicode, persistent values, rich output, errors/input and Run/Interrupt/Restart/Shutdown pass live. Bundled Python or project ipykernel; other installed kernel languages and widgets remain unsupported. Existing upstream notebook UI now compiles against the web kernel/clock boundary in source, not deployed/live-verified; experimental flag stays off because upstream saving drops rich outputs. | `zed/crates/repl/src/kernels/web_kernel.rs`, `zed/crates/repl/src/notebook`, `sandbox/image/kernel.py` |
| Calls and audio | Removed at the owner's request, including screen sharing, custom controls, browser media, signaling and TURN configuration. Not a backlog item. Collaborative editing remains. | `zed/crates/title_bar/src/collab_web.rs` |
| AI and MCP | AI is disabled by app settings. Browser-local process-backed MCP and OAuth callback servers cannot start; keychain credentials are unavailable. Compiled provider registries do not make this a supported feature. | `zed/crates/zed_web_core/src/web_settings.rs`, `zed/crates/context_server/src/transport/stdio_transport_web.rs`, `zed/crates/context_server/src/oauth.rs` |
| Local files and uploads | File/folder selection, project-tree drops/imports and browser save write-through are deployed. Remote Open/Save remains native sandbox selection. Dev extension folders upload over authenticated HTTP, not the desktop directory-sync command. Browser folder selections are snapshots; rebuilding reselects the folder. Actual OS File System Access dialogs remain unverified; folder-input fallback and isolated handle behavior pass. | `zed/crates/gpui_web/src/files.rs`, `zed/crates/gpui_web/src/files.js`, `zed/crates/zed_web/src/files.rs`, `zed/crates/zed_web/src/extensions.rs` |
| Desktop integration | One canvas window per tab; no native extra windows, hide/minimize/zoom, OS menus/Dock menu, Reveal in Finder, Open With, protocol registration or system keychain. Browser fullscreen and ordinary external links are implemented. | `zed/crates/gpui_web/src/platform.rs`, `zed/crates/gpui_web/src/window.rs` |
| Accessibility / input | AccessKit DOM, full-document mode, caret IME, tree/picker/tab/prompt and completion/code-action semantics are deployed. Completion list associations, selection and acceptance pass live; picker duplicate-focus/Vim chord bug is fixed. Plain UI text, theme option labels and clipped bounds are pushed, not deployed. Layout-map/observed-key fallback is implemented; never-observed non-US Option keys remain ambiguous without browser layout APIs. Real VoiceOver/NVDA and physical mobile/IME checks are not run. | `zed/crates/gpui_web/src/accessibility.rs`, `zed/crates/gpui_web/src/ime_mirror.rs`, `zed/crates/gpui_web/src/keyboard.rs`, `zed/crates/gpui/src/window/a11y.rs` |
| Clipboard | Browser text/image reads, native Copy/Cut/Paste events and async action replay are deployed. Text/PNG paste, secondary Vim register reads, dot repeat, motion/object replacement, cancellation, the Helix paste action and suspended macro replay pass live. Image copy lacks a verified UI consumer. | `zed/crates/gpui_web/src/clipboard.rs`, `zed/crates/zed_web/src/clipboard.rs` |
| Fonts | Bundled fonts only; no discovery of the computer's installed system fonts. | `zed/crates/gpui_web/src/platform.rs`, `zed/crates/zed_web/src/init.rs` |
| Developer/support UI | No native reliability/crash-report initialization, telemetry collection, feedback/onboarding, inspector/miniprofiler, journal or desktop dev-container manager. | `zed/crates/zed_web/src/init.rs`, `zed/crates/client/src/telemetry.rs` |
| Cargo / process boundaries | Cargo-registry permalinks delegate to the sandbox and pass live exact-commit/line verification. Executables, extension builds and raw sockets belong in the sandbox, not a browser-local subprocess/socket emulation. Desktop connection/password/forward commands remain intentionally unavailable; app-managed previews are separate. | `zed/crates/project/src/git_store.rs`, `zed/crates/zs_smol_shim/src/wasm/`, `zed/crates/remote/src/transport/websocket.rs` |

Not stubs: text editing, remote files, Git/history, terminals/tasks, bundled syntax,
sandbox language servers/formatters, settings/layout persistence, anonymous
multiplayer, and automatic HTTP/WebSocket preview ports. Ordinary confirmation
dialogs use Zed's in-canvas prompt implementation; the platform's `None` return is
a fallback hook, not a missing dialog. Native update installation is replaced by
the host-driven background-download/shared-restart flow.
