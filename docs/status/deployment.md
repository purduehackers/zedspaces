# Production deployment — 2026-09-06, 20:19 UTC

Live: https://code.purduehackers.com, without login. Vercel project
`purdue-hackers/zedspaces`; production deployment
`dpl_GsPbsFQQMnDs2wwoqyoeiErAR8pn` is READY.

## Published release

- App source: `8e2e3df444c3b3a936a077883a68d6dbd7d6d996`, including test removal.
- Zed fork: `648cf2f801f62294618ba1c1471bd9ea9291f4da`.
- Matching production WASM/server: `648cf2f80-34054725092.1`; no test hooks.
- Workspace image:
  `vcr.vercel.com/purdue-hackers/zedspaces/zs-workspace@sha256:57f39e62647473ca231d091cb83f47cb8df30df48eb1560c15ee9d27a2693139`.
  VCR reports ready. Uses the existing pinned universal base and reusable inline cache.
- Public editor archive SHA-256:
  `95e15648d81e1964bd055bb1b2ae9033ba349e6e2d3dbe0e71a484085a87014b`.
  Uploaded bytes were downloaded and checksum-verified; the manifest lists only this build.
- Turso/Drizzle multiplayer migration applied; schema, KV tables and FK enforcement checked.
- Public repos, anonymous shared access, Vercel Sandboxes and private Blob snapshots remain.

## Validation actually performed

[Release CI](https://github.com/purduehackers/zedspaces/actions/runs/34054725092)
passed web lint/typecheck/build, supervisor fmt/Clippy/release build, image/shell
checks, and both production Rust builds. No tests ran. Actions used `deploy=false`;
local Vercel authentication published the image/assets and deployed the app.
CI publication still needs `VERCEL_TOKEN`; local CLI publication does not.

Vercel production build passed: 43 Function traces, largest 16.4 MiB.
Its 19 dynamic-filesystem tracing warnings remain; packaging checks passed.
The public homepage and current editor metadata returned HTTP 200.

A disposable real sandbox cloned `octocat/Hello-World` without credentials;
Git reported `--is-shallow-repository=false`. Two independent Chromium contexts
reached ready and kept simultaneous WSS connections with no takeover UI.
Exact text propagated A→B and B→A. After A closed, B edited and saved again.
VM readback matched all 126 bytes, SHA-256
`6e53a840c2f46af1c12d791bff5372fff7c11dc84441b942266b1bd5147d12fa`.

Diagnostic caveat: Chromium 151's isolated contexts initially hit
`ERR_CACHE_WRITE_FAILURE` on the large editor downloads, both with the old
diagnostic launch flag and default cache settings. The two-context editing check
used CDP HTTP-cache disabling; no requests or responses were replaced.
A separate fresh persistent profile booted normally with cache unchanged,
cross-origin isolation, no test hooks and no console errors. No browser-cache
code change was made. Console/network/DOM evidence only; no screenshots.

The verification workspace `ws_DH2PKY4YSYG73AYT83P4` was deleted after validation.
Existing owner workspaces were not edited, restarted, rebuilt or repointed.
**Create new workspaces for multiplayer; old editor generations are not supported.**

Evidence: ignored `apps/web/.zs-dev/mp-release-{image-publish,assets-publish,vercel}.log`
and this session's browser/SDK output. Production stop/resume, restore,
port forwarding and Firefox/WebKit were not rerun. Earlier local test results
are historical, not release checks. Provider spending controls remain an owner task.
