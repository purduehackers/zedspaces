# Production deployment — 2026-09-06, 22:03 UTC

Live: https://code.purduehackers.com, without login. Vercel project
`purdue-hackers/zedspaces`; production deployment
`dpl_5YZ8LqjC31LBSZJYtStZqAnfNFtQ` is READY and aliased to the custom domain.

## Published release

- App source: `c6d41511b91659375afcdce03bd52022f0bb73e6`.
- Zed fork: `4e766bcb8ee0a96187746c77394a01c9555d8c27`.
- Matching production WASM/server: `4e766bcb8-34060994866.1`; no test hooks.
- Workspace image:
  `vcr.vercel.com/purdue-hackers/zedspaces/zs-workspace@sha256:c887c406177c0e4a2d947f0adc5a1bb8971e55a67012dfbc79b741b2292a085e`.
  VCR reports ready. Uses the existing pinned universal base and reusable inline cache.
- Public editor archive SHA-256:
  `1f182ee79796e6a33198b8c6e55a7ef07b6bc23a8d8c56e27dfe59929c6eaf4c`.
  Uploaded bytes were downloaded and checksum-verified; the manifest lists only this build.
- Automatic upgrade-on-open, Kintsugi, eight Ioskeley font faces and 32 animal avatars are shipped.
- Turso schema, KV tables and FK enforcement passed a read-only check. No new migration was needed or run.
- Public repos, anonymous shared access, Vercel Sandboxes and private Blob snapshots remain.

## Validation actually performed

[Release CI](https://github.com/purduehackers/zedspaces/actions/runs/34060994866)
passed web lint/typecheck/build, supervisor fmt/Clippy/release build, image/shell
checks, and both production Rust builds. No tests ran. Actions used `deploy=false`;
local Vercel authentication published the image/assets and deployed the app.
CI publication still needs `VERCEL_TOKEN`; local CLI publication does not.

Vercel production build passed: 43 Function traces, largest 16.4 MiB.
Its 19 dynamic-filesystem tracing warnings remain; packaging checks passed.
The public homepage and current editor metadata returned HTTP 200.

Workspace `ws_16XFMPW5J0WCZ9WRSYXQ` cloned public `octocat/Hello-World` on the old
release. A manual rebuild first preserved its uncommitted marker byte-for-byte
(SHA-256 `c1e7da9dd5192f86244cc76cfd34cb9bcdde50f1bab553f37f3e097742b4e167`).
After deploying the new release, opening that workspace in a second browser
returned `202 upgrading`. Generation 2 became generation 3 with the new image
and both new build pins; recovery pointers and the workflow run ID cleared.
The existing tab automatically reloaded, and both browsers reached ready.
The opening browser fetched no editor assets during the upgrade and then loaded
only the new build. Normal stop/resume passed; an obsolete client received
`409 client_build_mismatch`, and a background reconnect to a stopped workspace
received `409 workspace_stopped`.

Both Chromium profiles used unchanged HTTP caches, cross-origin isolation and
no test hooks. The existing tab logged the expected stopped-transport messages
during shutdown; the opening browser had no console/page/network errors.
Console/network/DOM evidence only; no screenshots. The clean CI download matched
all four served files; its asset tar contains the eight fonts, 32 animal SVGs and theme.

Git revision `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d` and the original marker
contents survived. A greeting was added afterward, so the final file checksum
differs. **The workspace was left intact because it is being used.** Only the
automated browser sessions were closed; no user workspace was deleted.

Evidence: ignored `apps/web/.zs-dev/automatic-upgrades-{build,shell-deploy,image-publish,assets-publish,final-deploy}.log`
and this session's browser/SDK output. Unsaved-buffer/layout restoration, new-release
bidirectional editing, port forwarding and Firefox/WebKit were not separately checked.
Provider spending controls remain an owner task.
