# UX cleanup — 2026-09-06

**Published to Vercel; source not committed or pushed.** Production is
`dpl_Erxk22dfUtWZJRC27T18nRW9vXi1` at code.purduehackers.com. New workspaces use
`0641c4c48-dd4fda5d`; existing workspaces keep their pinned images/bundles until
explicitly rebuilt. The owner's cloud workspace and original local server
binary have not been changed. See [deployment.md](deployment.md).

Implemented:

- Removed the floating HTML workspace strip and its unused actions/styles.
  Boot, reconnect, stopped-state controls and lifecycle toasts remain.
- Removed macOS traffic-light padding from the WASM title bar.
- Bundled four Lilex Nerd Font Mono faces and made that the terminal default.
- Added F1 / Alt+Shift+P command palette, Alt+P file finder and Ctrl+backtick
  terminal bindings. Fixed macOS Option-generated Unicode/dead keys when
  matching shortcuts; unbound Unicode input retains its text. The existing
  US-layout limitation remains; international-layout coverage is not claimed.
- Added bundled Dockerfile, HTML and TOML grammars, with installed Dockerfile
  and HTML LSP adapters. Tailwind 0.16.0 is now pinned in the image because Zed
  also starts that server for HTML. TOML LSP and general extensions are not added.
- New Git clones fetch full selected-ref history (`depth: 0`). A read-only
  check of the running `wack-hacker` workspace found a shallow repository with
  exactly one commit. Existing checkouts are unchanged; recovering that history
  needs `git fetch --unshallow origin`.

Validation:

- Web: typecheck, lint, 394 unit tests passed (one skipped), six workflow
  integration tests passed. Isolated Next production build passed; 44 server
  traces checked, largest 14.7 MiB, no local state/assets/env-file leakage.
- Rust: 41 `zed_web_core` tests and one grammar test passed, including font
  family/glyph checks, shortcut bindings and query compilation. WASM check
  passed with test hooks. Fresh native macOS server built successfully.
- Test bundle `0641c4c48-dd4fda5d-test` built: 75,126,914-byte WASM,
  19,975,562-byte Brotli estimate, 13,400,576-byte asset tar.
- Chromium + Firefox + WebKit: **54/54 passed**, including the new language and
  macOS Option/F1 cases, editing, terminals, layout and lifecycle regressions.
  Log: `.zs-dev/ux-browser-4.log`; report/JSON/timings preserved in
  `.zs-dev/ux-browser-success/` before the separate production smoke run.
- Production bundle `0641c4c48-dd4fda5d` built successfully: 75,054,467-byte
  WASM (19,936,924-byte Brotli estimate), same 13,400,576-byte asset tar;
  `test_hooks: false`. Both production smoke tests passed against the new
  native server, including ready/canvas and absence of `window.__zs_test`.
  Log: `.zs-dev/ux-smoke-production-1.log`. Together: **56 browser checks passed**.

Evidence: ignored `apps/web/.zs-dev/ux-*` logs. Earlier attempts are retained:
an overlapping bundle invocation was stopped before tests; the first browser
run lacked LSP paths after pnpm's install-script rejection; the next exposed
the missing Tailwind binary via console errors. The fixture install now skips
unneeded scripts and fails explicitly on installation errors.

Publication was explicitly authorized. The matching static Linux server built
in a temporary native Vercel Sandbox (the slow emulated Docker build was
cancelled); the builder was stopped after downloading the artifact. Binary:
141,396,528 bytes, SHA-256
`4cd3f7673f68aad1c8cbd9e476f872f446a98cd9873b967518a0718075fbaa85`.
Image `sha256:09ffb61d541e9630a2d9bfdba1bd37370a788868e85ab73a2ff84e03836f8b4d`
is ready in VCR and passed local image assertions plus a fresh Sandbox probe.
The public editor tar is checksum-verified and the manifest retains the old
bundle. Production build passed (44 traces, largest 16.5 MiB). Evidence:
`.zs-dev/ux-deploy-*` and `.zs-dev/ux-native-*`.

Live Chromium verification passed: new bundle/server, no HTML status strip,
full three-commit Git history, Alt+P file finder, exact 63-byte typed file save,
Ctrl+backtick terminal command, and stop/resume with the same saved SHA-256.
The test workspace is `ws_PEH163TG5MVDF42HDWT4`, stopped afterwards. Earlier
attempts did not pass: absolute-path file lookup did not open the file, and
bulk `Input.insertText` dropped a shared prefix. The final typing test does
not certify bulk insertion/clipboard/IME; that edge case remains open.

CI follow-up: `.github/workflows/release.yml` builds matching artifacts with
separate native/WASM caches, gates publishing on tests, boots the image in a
Sandbox, retains old bundles, and deploys manually through a `production`
environment. The old independent image-publishing lane was removed. Docker's
build ID argument now comes after the expensive install layers (a cache-only
change made after the published image build finished). See the short setup
section in [deploy-vercel.md](../deploy-vercel.md). No GitHub Actions run, secret
configuration, commit or push was performed. Local validation: actionlint,
ShellCheck, Dockerfile check, typecheck/lint, 399 unit tests (one skipped), and
an isolated production build (44 traces, largest 14.7 MiB).

Multiplayer/WebRTC investigation is in [the brief](../briefs/multiplayer.md).
It is a proposed next lane, not implemented; singleton safety is still intact.
