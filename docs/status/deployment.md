# Production deployment — 2026-09-07, 03:56 UTC

Live: https://code.purduehackers.com, without login. Vercel project
`purdue-hackers/zedspaces`; production deployment
`dpl_EfYucZjS9ZyNwmPKKQRd6gvBzkkZ` is READY and aliased to the custom domain.

## Published release

- App source: `c6343dcc003e7d42ce22a7f87a8b414c0145893b`.
- Zed fork: `30a77871878847e1852847481b7eae000694131e`.
- Matching production WASM/server: `30a778718-34078287451.1`; no test hooks.
- Workspace image:
  `vcr.vercel.com/purdue-hackers/zedspaces/zs-workspace@sha256:d709caecfd5c006d1e798e91f4edac8c07158ae25944209ae3aefdce0cf3b2b1`.
  VCR reports ready. Uses the existing pinned universal base and reusable inline cache.
- Public editor archive SHA-256:
  `32ad4bf04f82411b5db06d43c566a93c8760e7b3a601c9574149f52e0fac5ed5`.
  Uploaded bytes were downloaded and checksum-verified; the manifest lists only this build.
- Automatic upgrade-on-open, Kintsugi and eight Ioskeley font faces remain.
  Round person icons replace animal artwork; anonymous animal names/colors remain.
  The generic Zed Avatar component and native startup code are restored to upstream.
- Removed abandoned AI proxy/edit-prediction code and other nonessential fork changes.
  Shell prompts and terminal titles remain unchanged; no localhost-link rewriting.
- Automatic public preview discovery supports 12 simultaneous ports, including
  localhost-only IPv4/IPv6 listeners. HTTP and WebSocket traffic use reusable proxies.
- Turso schema, KV tables and FK enforcement passed a read-only check. No new migration was needed or run.
- Public repos, anonymous shared access, Vercel Sandboxes and private Blob snapshots remain.

## Validation actually performed

[Release CI](https://github.com/purduehackers/zedspaces/actions/runs/34078287451)
passed web lint/typecheck/build, supervisor fmt/Clippy/release build, image/shell
checks, and both production Rust builds. No tests ran. Actions used `deploy=false`;
local Vercel authentication published the image/assets and deployed the app.
CI publication still needs `VERCEL_TOKEN`; local CLI publication does not.
The subsequent 12-slot fix also passed [web CI](https://github.com/purduehackers/zedspaces/actions/runs/34081027586)
and [supervisor CI](https://github.com/purduehackers/zedspaces/actions/runs/34081027499).
Its supervisor was rebuilt into the final image; Zed binaries did not change.

Vercel production build passed: 43 Function traces, largest 16.4 MiB.
Its 19 dynamic-filesystem tracing warnings remain; packaging checks passed.
The public homepage and current editor metadata returned HTTP 200.

Disposable workspace `ws_A5ZPQQ17GNMS14FWBR41` cloned public `octocat/Hello-World`
on the old release and booted in Chromium. After deployment, opening it initiated
automatic upgrade. The first attempt failed at Sandbox creation: both create and
update returned HTTP 500 with 15 declared ports. The same image worked with 14;
changing which port was omitted still worked. The final app and supervisor use
12 previews plus RPC/health, without retry/fallback compatibility code.

Reopening after the fix retried from the preserved recovery archive. Generation 1
became generation 2 on the final image; state became running and the workflow ID
cleared. Both independent Chromium profiles booted the current WASM simultaneously,
with normal cache settings, cross-origin isolation, no test hooks or takeover UI.
No panic/page error occurred. Restored upstream LM Studio/llama.cpp initialization
does make blocked localhost model-list requests (1234/8080), producing non-blocking
CSP console errors. CSP was not relaxed. No screenshots were used.

Git revision `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`, all three commits
(`is-shallow-repository=false`), and the uncommitted marker survived byte-for-byte.
Temporary HTTP/WebSocket servers bound to `127.0.0.1:36781` and `[::1]:36782`
were automatically published on slots 8444/8445. Public requests preserved path/query
and WebSocket echo payloads. Killing the servers removed their forwards automatically.

The disposable workspace and its sandboxes were deleted after verification (API
410; SDK inventory for its exact name prefix empty). The three existing workspaces
remain stopped on their prior pins, untouched; they upgrade when their owners open
them. In particular, `ws_16XFMPW5J0WCZ9WRSYXQ` and its greeting remain intact.

Evidence: ignored `apps/web/.zs-dev/focused-release-{final-deploy,image-port-fix,browser,ports}.log`
and temporary `/tmp/zedspaces-focused-release.7FaTMp/` diagnostics. No test suite was
added to the repository. This release did not separately recheck bidirectional editing,
unsaved-buffer/layout restoration, private previews or Firefox/WebKit. Provider
spending controls remain an owner task.
