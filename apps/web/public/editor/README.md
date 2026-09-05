# `public/editor/<build>/` — the wasm editor bundle

The editor page (`app/(editor)/w/[id]`) loads the Zed wasm client from this
directory, at a path chosen **per workspace**: `workspaces.client_build`
(stamped from `ZS_CLIENT_BUILD_ID` when the workspace is created) becomes
`/editor/<build>/`. b1's build check is exact-match, so an existing workspace
keeps loading the bundle that matches the server inside its image until it is
rebuilt — which is why several builds live here side by side.

## What one build directory contains

| File | Produced by | Served |
|---|---|---|
| `zed_web.js` | `wasm-bindgen --target web` (b7 §3.31) | yes — the ES module the shell `import()`s |
| `zed_web_bg.wasm` | the same build | yes — instantiated with `module_or_path` |
| `zed-assets.tar` | b7's asset packer (fonts, themes, icons, queries) | yes — fetched once, kept in Cache Storage `zs-assets-<build>` |
| `build.json` | b7 §3.31 step 7 | not served to the client; `{ build_id, commit, wasm_bytes, wasm_brotli_bytes }`, and `build_id` must equal the directory name |
| `index.html`, `loader.js` | b7's dev harness | **dropped on unpack** — `apps/web` implements the same loader contract in `loader.ts`/`zs-host.ts` |

`next.config.ts` serves everything under `/editor/:build/:path*` with
`Cache-Control: public, max-age=31536000, immutable` plus the COOP/COEP/CORP
isolation headers: the page is cross-origin isolated, so the bundle **must** be
same-origin. It can never move to a Blob or CDN origin.

## Dropping a bundle in

Vercel builds this app from git, so a bundle copied here by a separate CI job
never reaches `next build`. The supported route is the `prebuild` step
(b9 §3.30, `scripts/fetch-editor-bundle.ts`): it reads `ZS_CLIENT_BUILD_ID`,
downloads `editor/<build>.tar` from `ZS_EDITOR_BUNDLE_SOURCE`, unpacks it into
`public/editor/<build>/`, and mirrors `editor/manifest.json` (newest build
first) so the previous `ZS_EDITOR_BUNDLES_KEEP - 1` builds stay available.

Locally, unpack a bundle by hand:

```sh
mkdir -p public/editor/<build>
tar -xf <build>.tar -C public/editor/<build>
rm -f public/editor/<build>/index.html public/editor/<build>/loader.js
# then point the workspace at it
echo 'ZS_CLIENT_BUILD_ID=<build>' >> .env.local
```

## The `dev-0` placeholder

`dev-0/zed_web.js` is a stub: it exports the loader contract but sets
`zsStub = true`. `loader.ts` treats that as `bundle_not_built` and the shell
renders "The editor bundle has not been built for this deployment" instead of a
blank canvas, so `/w/<id>` is developable without a 70 MB wasm build. Delete
the directory (or point `ZS_CLIENT_BUILD_ID` elsewhere) once a real bundle is
in place — a real bundle for `dev-0` simply overwrites the stub.

`manifest.json` lists the builds present here; the service worker uses it to
drop caches of builds that are gone.
