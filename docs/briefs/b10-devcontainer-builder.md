# b10-devcontainer-builder: `devcontainer.json` support, the image builder pipeline, and the prebuild warm-up glue

Companion to BUILD-SPEC §6.3 (`devcontainer.json` support, builder), §6.4 (prebuilds), §7.4 (`buildDevcontainerImage`, `prebuild`), D14 (this brief), D18/D19 (supervisor and control-plane contracts), D21/D29 (port map, names). Written 2026-09-02, **re-verified against the trees on 2026-09-02 after review round 1** (§8). What is actually on disk, because the first revision of this brief got it wrong and mis-anchored a dozen rows as a result:

- `apps/web` is a working control plane, not a scaffold: `lib/` holds 37 modules (incl. `api.ts`, `sandbox.ts`, `sandbox-auth.ts`, `sandbox-fake.ts`, `manifest.ts`, `github.ts`, `schema.ts`, `types.ts`, `views.ts`, `repos.ts`, `lifecycle.ts`, `jsonc.ts`, `blob.ts`, `env.ts`, `ids.ts`), `workflows/` holds six workflows plus `steps/{db,sandbox,child}-steps.ts`, `app/api/**` holds ~30 route handlers (`repos`, `repos/[id]/prebuilds`, `workspaces`, `workspaces/[id]/*`, `sandboxes/[name]/*`, `webhooks/*`, `cron/{gc,sweep,invoice,snapshot-usage}`), `drizzle/0000_init.sql` + `meta/` are committed, `tests/` has 11 unit suites plus helpers, and `package.json` is 64 lines (deps `:19-40`, `packageManager` `:63`). **Not** on disk: `workflows/prebuild.ts` and `workflows/gc.ts` (both already named by `lib/lifecycle.ts:20-39`'s `LifecycleWorkflowName` map, so they are b9 work in flight), `app/(site)/(dashboard)/**` pages, `tests/routes/*` and `tests/workflows/*` (empty dirs), `public/editor/*` (only `.gitkeep`), and any `packages/` directory at all (§3.1).
- `sandbox/supervisor/` is a complete Rust crate (18 sources, 5 470 lines, `Cargo.toml`, `Cargo.lock`, `build.rs`, `proto/zs_warm.proto`), with several b8 functions still `ZS-TODO(b8-skeleton)` stubs. `sandbox/image/` **is** empty, so every `sandbox/image/**` path in §3 is new-file work that lands beside b8's Dockerfile when it arrives.
- `zed/crates/remote/src/transport/websocket.rs` (1 243 lines) and `transport/websocket/{dial_native,dial_web,wire,tests}.rs` **have landed**; `remote_client.rs:1329` already dispatches `RemoteConnectionOptions::WebSocket`. §3.15's rejection of a `RemoteClient`-based warm client is re-argued on that basis (the transport is no longer the blocker; the gpui/`Project` crate graph is).

Anchors marked `b8:`/`b9:` are brief anchors; anchors that name a file under `apps/web/`, `sandbox/supervisor/` or `zed/` are code anchors read in this session at the line given.

Precedence: DECISIONS.md (incl. Decisions v2) beats CONTRACTS.md beats this brief beats b8/b9 where they conflict on items this brief owns (the devcontainer manifest block, the image builder, the builder image, the `image_builds` table, the repo image routes). Because CONTRACTS wins, the rows this brief changes are **amended in CONTRACTS.md itself** (§3.17) and the decisions it makes over BUILD-SPEC are **written into DECISIONS.md** (§3.18, D35-D40) as part of the same change — a claim that lives only here loses to the stale text it contradicts.

---

## 1. Goal

Make a repository's `devcontainer.json` shape the workspace the way GitHub Codespaces does, within the subset BUILD-SPEC §6.3 names, without ever giving a user-controlled build access to the control plane's secrets:

1. **Parse** `.devcontainer/devcontainer.json` (or `.devcontainer.json`) leniently, normalise it into one canonical `DevcontainerNormalized` document, enforce the Features allowlist, resolve variable substitutions, and record every unsupported key as a warning the dashboard shows.
2. **Build** a per-repository, per-configuration image `zs-workspace-<repo>:<config-hash>` in a **builder sandbox** (our base image plus rootful `dockerd`, Docker Buildx and `@devcontainers/cli`), where the user's `image`/`build.dockerfile` plus allowlisted Features is the base and our supervisor+server layer goes on top; push it to Vercel Container Registry; wait until VCR reports the image `ready`; record it in `image_builds` and `repos`.
3. **Trigger** builds on first create, on a push touching `.devcontainer/**`, on a manual "Rebuild image", and lazily when the server build the image embeds has drifted from the deployed one.
4. **Hand the normalised config to the supervisor** through the manifest so `postCreate`/`postStart`/`postAttach`, `remoteEnv`, `forwardPorts`, `portsAttributes` and `customizations.zed` behave identically whether the workspace runs on the base image or on a repo image (delta to b8 §3.4/§3.14).
5. **Prebuild glue** (BUILD-SPEC §6.4, D14): a prebuild for a devcontainer repo runs on the repo image, `zs-agent prebuild` warms language servers with b8's built-in headless client (`warm.rs`), the devcontainer file can steer the warm-up, and a push that changes the devcontainer chains image build → prebuild.

Out of scope, stated: `dockerComposeFile`, `runArgs`, `mounts` beyond the workspace, VS Code customizations, `initializeCommand` (runs on the host, i.e. in our builder — refused), base images from anything but the registry allowlist of §3.1 rule 4 (`docker.io`, `ghcr.io`, `mcr.microsoft.com`, `quay.io`, `public.ecr.aws` — enforced at admission with `base_registry_not_allowed`, not merely "not supported"), non-`linux/amd64`, Alpine/musl bases (v1 supports Debian/Ubuntu and Fedora/RHEL families only, §3.14).

---

## 2. Existing code and contracts that matter

Every anchor below was read in this session. Paths are relative to `/Users/ray/Projects/play/wed`.

### 2.1 Plan and decisions

| Anchor | Note |
|---|---|
| `BUILD-SPEC.md:282` | Image pushed with `vercel vcr build docker . zs-workspace:<build> --push`; "limits are 500 MB per compressed layer and 15 GB per image". |
| `BUILD-SPEC.md:286` | Layer 1 includes "Docker CLI and dockerd (Vercel supports rootful Docker inside a sandbox)" — the builder image relies on exactly this. |
| `BUILD-SPEC.md:292` | "Image is `linux/amd64` only". |
| `BUILD-SPEC.md:299` | Supervisor first boot: "run `postCreateCommand` from `devcontainer.json` if present, warm LSP caches". |
| `BUILD-SPEC.md:309` | The supported key list: `image`, `build.dockerfile` + `build.context` + `build.args`, `features` allowlist (common-utils, node, python, go, rust, java, docker-in-docker, github-cli), `postCreateCommand`, `postStartCommand`, `postAttachCommand`, `remoteEnv`, `forwardPorts`, `portsAttributes` (label and visibility), `customizations.zed` ("we define the key"). Not supported: `dockerComposeFile`, `runArgs`, `mounts` beyond the workspace, VS Code customizations. |
| `BUILD-SPEC.md:311` | Builder: "a Workflow run creates a builder sandbox with Docker, checks out the repo, runs the devcontainer CLI's build to produce an image layered on our base (so the supervisor and server are present), pushes to the registry as `zs-workspace-<repo>:<config-hash>`, and records it. Workspaces for that repo use the resulting image; a config change triggers a rebuild on next create or on 'rebuild'". §3.14 keeps the outcome ("supervisor and server present") and changes the layering direction; §7 item 1 justifies it. |
| `BUILD-SPEC.md:313-315` | Prebuild = create from the repo image, clone, `postCreateCommand`, warm language servers "by opening the project once with a headless client (the desktop transport in a Vercel Function, connecting long enough to trigger LSP downloads)", then `snapshot({ expiration })`; refreshed on push per branch, keep last three. D14 moved the headless client into `zs-agent` (b8 §3.16a); §3.15/§7 item 9 record why a Vercel-Function client is not used. |
| `BUILD-SPEC.md:329` | `repos (owner, name, default branch, devcontainer hash, image ref)`. |
| `BUILD-SPEC.md:343-349` | Routes: `POST /workspaces/{id}/rebuild`; `GET /repos`, `POST /repos/{id}/prebuilds`; sandbox-facing `GET /sandboxes/{name}/manifest`, `POST …/git-token`, `…/logs`; webhooks `POST /webhooks/github` (`push`, `installation`, `pull_request`). |
| `BUILD-SPEC.md:356` | `createWorkspace`: "pick image (prebuild snapshot if fresh, else repo image, else base)"; "`image_not_ready` retries with backoff". |
| `BUILD-SPEC.md:361-362` | `prebuild` "triggered by webhook or manually, deduplicated per branch"; `buildDevcontainerImage: section 6.3`. |
| `BUILD-SPEC.md:379` | Dashboard create flow includes "devcontainer detection"; repo settings page. |
| `BUILD-SPEC.md:383` | GitHub App events: `installation`, `push` (prebuilds), `pull_request`; installation tokens "minted on demand, one hour, never stored". |
| `BUILD-SPEC.md:431, 433` | Secrets never in manifests/logs; "Image builds are reproducible from a pinned base digest and pinned tool versions; images are referenced by digest at create". |
| `BUILD-SPEC.md:448` | `sandbox/image/` holds "Dockerfile, supervisor sources (Rust), devcontainer builder" — the builder lives at `sandbox/image/builder/` (M24 in CONTRACTS §14 already records the supervisor moving to `sandbox/supervisor/`). |
| `BUILD-SPEC.md:457, 459` | `docker buildx build --platform linux/amd64`, referenced by digest; both binaries embed `ZS_BUILD_ID = <zed-commit>-<patch>`, "the sandbox image for a build is created before the web deploy promotes". A repo image embeds the same coupled binaries, so its identity must include the build id (§3.6). |
| `BUILD-SPEC.md:535` | Risk 7: "readiness after push is undocumented in duration, so image builds run ahead of deploys and previews pin the previous image until the new one reports ready". §3.11 step 9 polls the documented REST status. |
| `docs/briefs/DECISIONS.md:13` (D9) | Rebuild tarball = `/workspaces` + `$HOME/.local/share/zed`, extracted at `/` — b9 hard-codes `vercel/.local/share/zed`, so a repo image **must** keep `HOME=/vercel` (§3.14 fixup). |
| `DECISIONS.md:17` (D13), `:22` (D18), `:23` (D19) | Activity `busy`/`phase`; supervisor contract; control-plane contract with the fixture at `docs/contracts/fixtures/manifest.example.json`. |
| `DECISIONS.md:18` (D14) | "`zs-agent prebuild` (headless connect to warm language servers) is owned by b8. The devcontainer image builder workflow is a new brief b10". |
| `DECISIONS.md:30` (D21), `:38` (D29) | Port map: 15 declarable ports, infrastructure set `8443-8451` excluded from user forwards (§3.1 rule 8 filters `forwardPorts` against `infraPorts()`, which `apps/web/lib/env.ts:278-286` builds as the whole `INFRA_PORT_MIN..INFRA_PORT_MAX` range ∪ rpc/health/slots — so 8449/8450/8451 *are* in it). D21 says **nothing** about builder sandboxes; "a builder declares no ports" is this brief's own decision (§3.8), recorded as D35 in §3.18, not a quotation from D21. `ZS_CONTROL_URL` canonical (origin + `/api`); snake_case kinds. |

### 2.2 CONTRACTS.md rows this brief consumes or extends

| Row | Note |
|---|---|
| `CONTRACTS.md:341-354` (§7.1) | `zs-agent` subcommands incl. `prebuild` ("requires `ZS_PREBUILD=1`; clone + postCreate + LSP warm-up (D14) + `ZS_PREBUILD_WARM_CMD`; exit 0") and hidden `warm`; exit codes 0/1/2/3/4. |
| `CONTRACTS.md:356-379` (§7.2) | Environment read by `zs-agent`: `ZS_CONTROL_URL`, `ZS_SANDBOX_TOKEN`, `ZS_SANDBOX_NAME`/`ZS_WORKSPACE_ID`, `ZS_BUILD_ID` (image `ENV`), `ZS_PREBUILD`, `ZS_PREBUILD_WARM_CMD` ("from `repos.prebuild_warm_command`"), `ZS_WORKSPACES_DIR`, `ZS_SERVER_BIN`, `ZS_SUPERVISOR_URL`, `ZS_CONTROL_SECRET_FILE`, `SHELL`/`USER`/`HOME` ("`zs-agent` fills `SHELL`/`USER=ubuntu` when missing"). A repo image sets the same `ENV` (§3.14) and §3.16 changes the `USER` fill. |
| `CONTRACTS.md:381-413` (§7.3), row `:407` | Manifest table; `devcontainer` is `{ configHash } \| null`, "informational". This brief widens the row to the `DevcontainerSpec` block of §4.4 (additive: every new field has a serde default, so b8's current type keeps parsing). |
| `CONTRACTS.md:415-431` (§7.4) | Sandbox → control plane calls, all bearer `zsb_…`; `git-token` "token scoped to the workspace repo"; `logs` `LogBatch` (§7.6: `source` values include `prebuild`, `warm`); rate limits per sandbox. The builder principal uses `git-token` and `logs` and adds two routes (§3.10). |
| `CONTRACTS.md:455-481` (§7.7) | Boot order ("devcontainer parse" after `write_settings`; postCreate 30 min beside the server; `postAttachCommand` on first `session_active`); budgets: prebuild exit ≤ 50 min, warm budget `min(15 min, 48 min − elapsed)`. |
| `CONTRACTS.md:489` (§8.1) | Route conventions, error body `{ error: { code, message, details? } }`, ids `^(ws\|repo)_[0-9A-HJKMNP-TV-Z]{20}$`, sandbox names `^(sb\|pb)-[a-z0-9-]{1,60}$`. **Both** regexes must be amended by §3.17: `img_` is a new id prefix and `ib-` a new sandbox prefix, and the sandbox regex lives in code twice (`apps/web/lib/ids.ts:14` `SANDBOX_NAME_RE`, `apps/web/lib/types.ts:24` `sandboxNameSchema`) — `lib/api.ts` and `lib/sandbox-auth.ts` contain no copy of it. |
| `CONTRACTS.md:379` (§7.2) | Stripped from every child: `ZS_SANDBOX_TOKEN`, `ZS_CONTROL_URL`, `ZS_CONTROL_PLANE_URL`, `ZS_BYPASS_SECRET`, `ZS_CONTROL_SECRET`; `manifest.env` literals merged minus `ZS_*` and b9's `RESERVED_SECRET_NAMES` (`LD_PRELOAD, LD_LIBRARY_PATH, BASH_ENV, ENV, PROMPT_COMMAND, GIT_ASKPASS, SSH_ASKPASS, GIT_CONFIG_PARAMETERS, HOME, PATH, USER, SHELL`). §3.1 rule 7 applies **the same filter** to `containerEnv` and `remoteEnv`, which arrive from repository content and are not covered by that rule today. |
| `CONTRACTS.md:453` (§7.6) | `LogBatch` requires `workspaceId`, `sandboxName`, `sessionId (= manifest.session.id)`, `build`; `source` enum is `server\|agent\|post_create\|post_start\|post_attach\|dotfiles\|proxy\|prebuild\|warm\|server:<module_path>`. It has neither `builder` (§3.13) nor `services` (§3.16), and an `ib-` principal has no workspace, manifest or session — §3.17 amends the row for both. |
| `CONTRACTS.md:495` (§8.2) | `POST /api/workspaces` → `409 image_building`; `:510-511` `GET\|POST /api/repos`, `GET\|POST /api/repos/{id}/prebuilds`. |
| `CONTRACTS.md:595-615` (§11) | Sandbox paths: `HOME=/vercel`, data dir `/vercel/.local/share/zed`, `/workspaces`, `/vercel/.zs`, binaries in `/usr/local/bin`, image `ENV` line (`:612`, which includes `RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo` — §4.5 now reproduces those too and no longer invents an undeclared `ZS_DEVCONTAINER_HASH`), git config (`:613`), server environment (`:614`: process env ∪ filtered `manifest.env` ∪ **`remoteEnv`** ∪ …). `:614` unions `remoteEnv` *unfiltered*, so a repository-controlled `remoteEnv.LD_PRELOAD` would be code execution inside `zed-remote-server`: §3.1 rule 7 filters it in the control plane and §3.16 re-applies the filter in the supervisor. A repo image must reproduce `:612-613` exactly (§3.14). |
| `CONTRACTS.md:619-630` (§12) | `ZS_BUILD_ID` format and where it is baked; `ZS_IMAGE_REF` (`zs-workspace:<build>` or `@sha256:…` from `image.json`); `workspaces.server_build` "stamped at create/rebuild"; `builds_compatible` is exact match; `ZS_EDITOR_BUNDLES_KEEP = 5`. A repo image built at build B stays usable after a deploy of B′ only while bundle B is still served (§3.9). |
| `CONTRACTS.md:718` (M24) | Supervisor sources at `sandbox/supervisor/`, image inputs at `sandbox/image/` — the builder follows: `sandbox/image/builder/`. |

### 2.3 b8 (supervisor and image) — what this brief builds on and where it deviates

| Anchor | Note |
|---|---|
| `b8-supervisor-image.md:20` | b8 §2 already records that the builder is b10 and that b8 parses the checkout's devcontainer file itself. |
| `b8:274-343` (§3.4 `Manifest`), `:300` | `devcontainer: Option<DevcontainerHint>` = `{ config_hash }`, "informational (§3.14 parses the checkout)". §3.16 replaces `DevcontainerHint` with `DevcontainerSpec` (§4.4) and makes the manifest authoritative when present. |
| `b8:345-375` (§3.4 `DevcontainerConfig`) | Rust subset: `post_create_command`/`post_start_command`/`post_attach_command: Option<LifecycleCommand>` (`Shell(String) \| Argv(Vec) \| Parallel(BTreeMap<_, Leaf>)`), `remote_env`, `forward_ports: Vec<u16>`, `ports_attributes: BTreeMap<String, PortAttributes { label, visibility }>` (ranges/host:port/regex keys ignored with a warning), `customizations.zed.extensions`; `load(repo_root)` reads `.devcontainer/devcontainer.json` then `.devcontainer.json` with `serde_json_lenient` and returns the raw bytes for the post-create marker hash; `expand_remote_env` handles `${containerEnv:NAME}`/`${localEnv:NAME}`; `parse_port_key`. The TypeScript normaliser (§3.1) produces exactly this shape plus the additions in §4.4, so the Rust side gains fields, never changes semantics. |
| `b8:825-904` (§3.14) | `Markers::post_create_done` stores `sha256:<hex>` of the devcontainer bytes; `needs_post_create(hash)`; `extension_install_list(manifest, devcontainer)` merges `manifest.extensions ∪ customizations.zed.extensions`; `lifecycle_specs`/`run_lifecycle` (string → `bash -lc`, array → argv, object → parallel); `write_settings(docs, home, markers)` writes verbatim. §3.16 adds the settings overlay and `dockerd` service start. |
| `b8:948-977` (§3.16) | `start` sequence step 3 "`DevcontainerConfig::load` (also yields the hash)", step 6 lifecycle order; the prebuild sequence (`ZS_PREBUILD=1`, `Phase::Warm`, `WARM_BUDGET = min(15 min, 48 min − elapsed)`, then `ZS_PREBUILD_WARM_CMD`). |
| `b8:979-1018` (§3.16a `warm.rs`) | The headless warm-up client: `tokio-tungstenite` to `ws://127.0.0.1:8443/rpc` with `Sec-WebSocket-Protocol: zs.v1, <token>`, `Hello`, `AddWorktree`, `OpenBufferByPath` per probe file from `pick_probe_files(root)` (extension table, depth ≤ 6, `WARM_MAX_FILES = 24`), settle on 20 s of LSP silence, never `SaveClientState`. §3.15/§3.16 keep it and widen the signature **once**, to `pick_probe_files(root, hints, feature_langs)` (the arity used everywhere below). |
| **Code anchors (the crate is on disk)** | `sandbox/supervisor/src/manifest.rs:67` `pub devcontainer: Option<DevcontainerHint>`, `:201` `DevcontainerHint`, `:440` `DevcontainerConfig`, `:483` `#[serde(untagged)] pub enum LifecycleCommand`, `:495` `LifecycleCommandLeaf`; `bootstrap.rs:187` `pub fn write_settings(docs: &SettingsDocs, home: &Path, markers: &Markers)` (currently a `ZS-TODO(b8-skeleton)` stub returning an error); `warm.rs:69` `pub fn pick_probe_files(root: &Path) -> Vec<PathBuf>`; `Cargo.toml:38` `nix = { version = "0.29", features = ["signal", "process"] }`. §3.16 is written against **these** signatures, not against b8's prose. |
| `b8:1073-1173` (§3.19 Dockerfile) | Workspace image: `FROM ${BASE_IMAGE}` (universal, digest-pinned by `base.lock`), `:1133` `docker.io docker-buildx docker-compose-v2` installed ("nothing starts it"), `:1149-1150` `COPY --from=server-fetch … /usr/local/bin/zed-remote-server`, `COPY --from=agent-builder … /usr/local/bin/zs-agent`, `:1152-1157` `/workspaces` + git config, `:1158-1164` the `ENV` block, `:1165-1168` `USER ubuntu`, `WORKDIR /workspaces`. The builder image (§3.13) is `FROM` this image; the synthesised layer (§3.14) reproduces `:1149-1168` on top of the user's base. |
| `b8:1200-1250` (§3.21 `build.sh`) | `docker buildx build --platform linux/amd64 … --provenance=false --sbom=false`, layer-size guard (`docker history`), readiness poll via `vercel vcr image ls --format json` with an **assumed** field shape (§7 item 22 there). This brief replaces that poll with the documented REST endpoint (§2.6) and reuses the size guard. |
| `b8:1288-1350` (§3.25 CI) | `sandbox-image.yml` `image` job: `vercel vcr login docker`, `build.sh --push`, `run-local.sh`, uploads `image.json`. §3.13 appends a `builder` step. |
| `b8:1352-1366` (§3.26) | `docs/contracts/sandbox-manifest.v1.json` + fixture are the shared source of truth; §3.17 adds the devcontainer block to both. |
| `b8:1454-1479` (§4.6) | Environment contract; `ZS_PREBUILD_WARM_CMD` "shell command run after the LSP warm-up with the remaining budget". |
| `b8:1483-1553` (§5) | `serde_json_lenient = "0.2.4"`, `sha2`, `serde_json` — no new crates needed for §3.16. |
| `b8:1683` (§7 item 14) | Warm-up risks: probe table and adapter downloads under the network policy. |
| `b8:1689` (item 20) | "repos with `build.dockerfile` are not accepted until [b10] exists". |
| `b8:1690-1691` (items 21-22) | Pulling from VCR needs a login even without pushing; `vercel vcr image ls --format json` shape undocumented. |
| `b8:1693` (item 24) | "Docker inside the sandbox is installed but not started; whether `dockerd` should be a manifest-driven optional service is open" — resolved here (§3.16 `services`). |

### 2.4 b9 (control plane) — what this brief plugs into

| Anchor | Note |
|---|---|
| `b9-control-plane.md:99-183` (tree) | `lib/{env,ids,schema,github,sandbox,manifest,sandbox-auth,ratelimit}.ts`, `workflows/steps/{sandbox,db,github,child}-steps.ts`, `workflows/prebuild.ts`, `app/api/repos/[id]/prebuilds/route.ts`, `app/api/sandboxes/[name]/*`, `app/api/webhooks/github/route.ts`, `app/(site)/(dashboard)/repos/[id]/page.tsx`, `tests/helpers/fake-sandbox.ts`, `packages/sdk/`. New files in §3 sit beside these. |
| `b9:191-264` (§3.2 `env.ts`) | `:219-222`: `ZS_CLIENT_BUILD_ID`, `ZS_SERVER_BUILD_ID`, `ZS_IMAGE_REF`, **`ZS_BUILDER_IMAGE_REF: z.string().optional()`** (already reserved for this brief); `controlPlaneUrl()`, `controlApiBase()`, `envTag()`, `proxySlots()`, `infraPorts()`. |
| `b9:266-277` (§3.3 `ids.ts`) | `IdPrefix = "ws" \| "sb" \| "ses" \| "con" \| "repo" \| "pb" \| "sec" \| "inv"`; `newPrebuildSandboxName(id) = pb-${envShort()}-${id.slice(3).toLowerCase()}`; `newSandboxToken()`; `sha256Hex`. §3.4 adds `"ib"`/`"img"` and `newImageBuildSandboxName`. |
| `b9:336-339` (§3.7) | `LimitName` union and `LIMITS`; §3.4 adds `sandbox.image-build` and `user.image-builds`. |
| `b9:424-429` (§3.12) | `SandboxPrincipal = { kind: "workspace" … } \| { kind: "prebuild" … }`; `requireSandbox` resolves `sb-`/`pb-` names; `rotateSandboxToken({ kind, id })`. §3.4 adds `{ kind: "imageBuild"; build: schema.ImageBuild; repo: schema.Repo; … }`. |
| `b9:482-501` (§3.15 `github.ts`) | `installationToken`, `installationOctokit`, `fetchDevcontainer(installationId, owner, repo, ref) → { hash: sha256(raw), raw } \| null` (".devcontainer/devcontainer.json or .devcontainer.json"), `resolveRef`, `verifyGithubWebhook`, `cloneUrl`; `:501` installation tokens "minted only inside `POST /api/sandboxes/{name}/git-token` … never inside a workflow step". §3.5 extends `fetchDevcontainer` into `fetchDevcontainerSources` and keeps that rule for the builder. |
| `b9:503-547` (§3.16 `sandbox.ts`) | `SandboxHandle` (`runDetached`, `run`, `waitCommand(cmdId, timeoutMs)`, `killCommand`, `stop`, `delete`, `readFile`), `CreateSandboxInput { name, region, vcpus, ports, timeoutMs, image?, source?, env, networkPolicy, tags, snapshotExpirationMs, keepLastSnapshots }`, `SandboxApi.create` = `Sandbox.getOrCreate({ …, persistent: true, … })` (`:537`), `SandboxError.code` incl. `image_not_ready` (retryable). §3.7 adds `persistent?: boolean` (default `true`) so a builder is never snapshotted. |
| `b9:549-562` (§3.17) | `RESERVED_SECRET_NAMES`, `assertSecretName` (no `ZS_*`), `buildManifest(principal)`; the `ZS_` denylist protects `ZS_VCR_*` too. |
| `b9:564-583` (§3.18) | `supervisorEnvFor`, `startSupervisor`, `probeHealth`; nothing changes, but the builder's `runCommand` env is built by a sibling `builderEnvFor` (§3.8). |
| `b9:585-630` (§3.19 steps) | `stepCreateSandbox` (`image_not_ready` → `RetryableError(retryAfter "20s")`), `stepWaitForCommandExit(name, cmdId, timeoutMs)` (null on timeout), `stepDeleteSandbox`, `stepDeleteBlob`; `:615` `stepPickImage(workspaceId)` "fresh prebuild … else `repo.image_ref ?? ZS_IMAGE_REF`"; `:620-623` prebuild steps (`stepCreatePrebuildRow` sets `imageRef = repo.imageRef ?? ZS_IMAGE_REF`); `:627-629` `stepRunChild`, `stepRunStatus`. |
| `b9:632-634` (§3.20) | Every workflow body ends with `stepFinishRun` on both paths (the `image_builds` analogue is `stepFinishImageBuild`, §3.9). |
| `b9:734-735, 747` (§3.24) | `app/api/repos/route.ts` (`GET`, `POST` "registers/refreshes repos row incl. devcontainer hash"), `app/api/repos/[id]/prebuilds/route.ts`, `app/api/webhooks/github/route.ts`. |
| `b9:854-855` (§4.1 enums) | `prebuildStatusEnum`, **`imageStatusEnum = ["none", "building", "ready", "failed"]`** already declared. |
| `b9:913-930` (§4.1 `repos`) | Columns incl. `devcontainerHash`, `imageRef` ("`zs-workspace-<owner>-<name>:<hash>` once built (§6.3)"), `imageStatus`, `prebuildBranches`, `prebuildWarmCommand`, `defaultMachine`, `idleMinutes`; unique `(owner, name)`. §3.2 adds columns and the `image_builds` table. |
| `b9:1001-1019` (§4.1 `prebuilds`) | `imageRef: text().notNull()`, `sandboxName`, token columns, `status`, `workflowRunId`. |
| `b9:1110-1122` (§4.2) | `createWorkspaceInput` (`repo`, `ref`, `machine`, `region`, `idleMinutes`, `name`, `orgId`); `:1122` "409 image_building (repo image not ready and no base fallback allowed by org)". §3.10 adds `allowBase?: boolean` and the `runId` detail. |
| `b9:1153-1156` (§4.2) | `GET /api/repos`, `POST /api/repos { installationId, owner, name } → { repo: RepoView }`, `GET\|POST /api/repos/{id}/prebuilds`. |
| `b9:1199-1202` (§4.2 webhooks) | `push { ref, after } → if b ∈ repo.prebuildBranches: withLock(prebuild:…, start(prebuild))`. §3.10 inserts the `.devcontainer/**` check ahead of it. |
| `b9:1251-1281` (§4.7 `SandboxManifest`), `:1274` | `devcontainer: { configHash } \| null` — "the supervisor reads devcontainer.json from the clone itself". Widened by §3.6/§4.4. |
| `b9:1292-1311` (§4.8 `createWorkspace`) | `stepPickImage` → `stepCreateSandbox({ image \| source, env identity only, tags ≤ 5, … })`; `workspaces.server_build` must equal the image's `ZS_BUILD_ID` (`waitUntilReady` → `FatalError build_mismatch`, `:1318`). |
| `b9:1405-1419` (§4.8 `prebuild`) | `stepCreatePrebuildRow` → `stepCreateSandbox({ image: pb.imageRef, ports: [ZS_RPC_PORT, ZS_HEALTH_PORT], env: { ZS_PREBUILD: "1", … } })` → `zs-agent prebuild` → `stepSnapshot(name, 0)` → prune to three. `:1435`: "`buildDevcontainerImage` (§7.4) belongs to brief b10 … this brief only reads `repos.image_ref`/`image_status` and starts nothing for it". |
| `b9:1506-1574` (§5) | Pinned versions (`@vercel/sandbox 3.2.1`, `workflow 4.8.5`, `zod 4.5.4`, `@octokit/rest 22.0.1`, `@vercel/blob 2.8.0`, `@vercel/functions 3.9.5`, dev `@workflow/vitest 4.0.21`, `vitest 4.1.11`, `drizzle-kit 0.31.10`). §5 adds one dependency. |
| `b9:1576-1580, 1638-1653` (§6) | Two vitest configs; the sandbox fake keeps state on `globalThis`, records calls, scripts `/health`; workflow integration tests via `@workflow/vitest`. On disk it is `apps/web/lib/sandbox-fake.ts`, not `tests/helpers/fake-sandbox.ts` (§2.4b). §6 extends it with a scripted detached command and a fake VCR. |
| `b9:1665` (§7 item 7), `:1677` (item 19) | b8 follow-ups and the "b8 on disk lags the contract" note. Superseded for this brief: `sandbox/supervisor/` **is** on disk (§2.3 code-anchor row), so §3.16 is written against its real signatures; where a b8 function is still a `ZS-TODO(b8-skeleton)` stub (`write_settings`), §3.16 states the final signature and b8 fills the body. |
| `b9:1153` (§4.2) | `GET /api/repos` → `{ installations: [{ installationId, accountLogin, accountType, repos: RepoView[] }] }` — **live from GitHub, cached 60 s in kv per user**. §3.10 therefore does *not* claim "no GitHub calls": only the `devcontainer` sub-object of each `RepoView` comes from the `repos` row. |

### 2.4b `apps/web` code anchors this brief modifies (read in this session)

| Anchor | What it means for §3 |
|---|---|
| `apps/web/lib/ids.ts:14` `SANDBOX_NAME_RE = /^(sb\|pb)-[a-z0-9-]{1,60}$/`; `lib/types.ts:24` `sandboxNameSchema` (same regex, inline) | The two places §3.4 must widen to `^(sb\|pb\|ib)-…`. `lib/api.ts` (195 lines) and `lib/sandbox-auth.ts` hold no copy. |
| `lib/sandbox-auth.ts:14-19` `SandboxPrincipal = { kind: "workspace"; workspace; sandboxName; tokenGeneration } \| { kind: "prebuild"; … }`; `:68` `requireSandbox(req, sandboxName)` (no options parameter today); `:81-82` `rotateSandboxToken({ kind: "workspace" \| "prebuild"; id })` | §3.4 adds the `imageBuild` variant, adds the third `kind`, and adds the optional third parameter `opts?: { kinds?: SandboxPrincipal["kind"][] }` to `requireSandbox` — a signature change, not a new function. |
| `lib/sandbox.ts:38-45` `RunInput { cmd, args, env?, cwd?, sudo?, timeoutMs? }`; `:230-243` `runDetached` builds `runCommand({ cmd, args, env, cwd, sudo, detached: true })` — **`timeoutMs` is declared and then dropped**; `:99-114` `CreateSandboxInput` (no `persistent`); `:319` `persistent: true` hard-coded; `:327-328` `snapshotExpiration: input.snapshotExpirationMs`, `keepLastSnapshots: { count: input.keepLastSnapshots }` | §3.4 must forward `timeoutMs` in **both** `runDetached` and `run`, or the builder's 45-minute hard budget silently does not exist (§6.4 would still pass against the fake). |
| `lib/env.ts:9-11` `INFRA_PORT_MIN = 8443`, `INFRA_PORT_MAX = 8451`; `:278-286` `infraPorts()` = the whole range ∪ `ZS_RPC_PORT` ∪ `ZS_HEALTH_PORT` ∪ `proxySlots()`; `:58-61` `ZS_CLIENT_BUILD_ID`, `ZS_SERVER_BUILD_ID`, `ZS_IMAGE_REF`, `ZS_BUILDER_IMAGE_REF` already declared | §3.1 rule 8 and §3.3 land on top of this unchanged; a `forwardPorts: [8450]` **is** dropped today. |
| `lib/github.ts:167-180` `fetchDevcontainer(...) → { hash: createHash("sha256").update(raw,"utf8").digest("hex"), raw }` — **bare hex**; `lib/manifest.ts:156`, `:199` emit `devcontainer: repo.devcontainerHash ? { configHash: repo.devcontainerHash } : null`; `lib/types.ts:391` `devcontainer: { configHash: string } \| null`; `docs/contracts/fixtures/manifest.example.json:56-58` carries 64 bare hex | `configHash`/`contentHash` on the wire stay **bare hex** (§3.1 hash.ts), so no migration of `repos.devcontainer_hash`, no fixture rewrite, and b8's `example_manifest_parses` keeps passing. |
| `lib/lifecycle.ts:20-39` `LifecycleWorkflowName` union + `WORKFLOW_MODULES` map (`prebuild` and `gc` are *declared* but their files do not exist yet) | §3.9's child run adds `"buildDevcontainerImage"` to **both** the union and the map; `workflows/steps/child-steps.ts:15` `stepRunChild(name: LifecycleWorkflowName, args)` then accepts it with no further change. |
| `lib/schema.ts:45` `imageStatusEnum = ["none","building","ready","failed"]`; `:141-161` `repos` (incl. `installationId`, `githubRepoId`, `defaultBranch`, `devcontainerHash`, `imageRef`, `imageStatus`, `prebuildBranches`); `:196-206` `workspaces.{serverBuild, clientBuild, stateReason}` | §3.2's columns are additive against this exact table. `image_status` is **not** widened (§4.7 derives `preparing`/`stale` in the view). |
| `lib/types.ts:79-91` `RepoView` (`imageStatus?: "none"\|"building"\|"ready"\|"failed"`) | §4.7 adds `devcontainer: DevcontainerSummary` beside the existing optional fields. |
| `lib/sandbox-fake.ts:394` `fakeSandbox()`, `:490` `fakeSandboxApi()`, `:24-51` `FakeCall`/`FakeCommand`/`FakeSandboxRecord` | §6.4's builder fake extends **this** module (there is no `tests/helpers/fake-sandbox.ts`; `tests/helpers/` holds `db.ts`, `keys.ts`, `server-only.ts`, `setup.ts`). |
| `lib/jsonc.ts:8` `stripJsonc(input)` (hand-rolled, used for settings/keymap text) | Not reused: §3.1 needs error offsets and comment-preserving positions, hence `jsonc-parser` (§5). The two coexist. |

### 2.5 `apps/web` scaffold and installed package types (read in `apps/web/node_modules`)

| Anchor | Note |
|---|---|
| `apps/web/package.json:19-40` (dependencies), `:41-61` (devDependencies), `:63` `"packageManager": "pnpm@11.20.0"` | Dependencies as b9 §5 pins them (`@vercel/sandbox 3.2.1`, `workflow 4.8.5`, `zod 4.5.4`, `@octokit/rest 22.0.1`, `@vercel/blob 2.8.0`, `@vercel/functions 3.9.5`, `drizzle-orm 0.45.2`) plus `@clerk/nextjs`, `@upstash/*`, `stripe`, `pg`, `jose`, `@electric-sql/pglite`. `node_modules` is installed (`@workflow/vitest 4.0.21`, `vitest 4.1.11`, `drizzle-kit 0.31.10`). `jsonc-parser` is **not** installed (§5). |
| `apps/web/next.config.ts:1-39` | **Not** empty: `withWorkflow(nextConfig)`, COOP/COEP/CORP on `/w/:id` and `/editor/:build/:path*`, `X-Frame-Options`, `Referrer-Policy`, immutable caching for the editor bundle, `Service-Worker-Allowed` for `/sw.js`, `no-store` for `/api/:path*`. This brief changes nothing in it. `tsconfig.json:21-23` `@/*` → `./*`. |
| `node_modules/@vercel/sandbox/dist/sandbox.d.ts:20-140` | `BaseCreateSandboxParams`: `name`, `source`, `ports?: number[]` (`:54`, optional — the builder declares none), `timeout` (`:58`), `resources: { vcpus }` (`:65-67`, "2048 MB of memory per vCPU"), `networkPolicy` (`:72`), `env` (`:85`), `tags` (`:89`, ≤ 5), `region` (`:95`), `persistent?: boolean` (`:108`), `snapshotExpiration` (`:114`), `keepLastSnapshots` (`:118-133`), `onResume` (`:139`); `:142-181` `image?: SandboxImage` (repo name, `repo:tag`, `repo@sha256:…`, `team/project/repo`), exclusive with `source`. |
| `sandbox.d.ts:612, 646, 678` | `static create`, `static get`, `static getOrCreate`. |
| `sandbox.d.ts:731-750` | `runCommand(cmd, args?, { signal, timeoutMs })`, `runCommand(params & { detached: true }) → Command`, `runCommand(params) → CommandFinished`. |
| `node_modules/@vercel/sandbox/dist/session.d.ts:21-63` | `RunCommandParams { cmd, args?, cwd?, env?, sudo?, detached?, stdout?, stderr?, signal?, timeoutMs? }` — `timeoutMs` (`:56-62`) "enforced by the sandbox at exec time, so it applies whether or not the command is awaited (including `detached: true`)". ⚠ Our wrapper drops it (`lib/sandbox.ts:230-243`); §3.4 forwards it, otherwise the 45-minute hard budget exists only in the fake. |
| `sandbox.d.ts:105-108`, `:109-114`, `:115-134` | `persistent?: boolean` = "Enable or disable automatic restore of the filesystem between sessions" — **not** a promise that no snapshot is taken; `snapshotExpiration` "Use `0` for no expiration" (so `0` means *never expires*, the opposite of §3.8's earlier intent); `keepLastSnapshots` is an **object** `{ count: 1..10, expiration?, deleteEvicted? }`, which `lib/sandbox.ts:328` builds from our numeric `keepLastSnapshots`. `count` is documented as 1-10, so "no retention" cannot be expressed as `0`: §3.4 makes `snapshotExpirationMs`/`keepLastSnapshots` **optional** on `CreateSandboxInput` and §3.8 omits both for the builder, relying on `persistent: false` plus the explicit `stepDeleteBuilder`. |
| `sandbox.d.ts:848-855, 862` | `writeFiles([{ path, content, mode? }])`; `domain(p)` throws when the port has no route. |
| `sandbox.d.ts:930-947` | `getDefaultUser()`: "The user that non-`sudo` commands and the HTTP file API run as … resolved from the running sandbox rather than assuming a fixed name" — **but it is marked `@internal` (`:944`) and `lib/sandbox.ts`'s `SandboxHandle` does not expose it**, and this brief does not add it. So it is *evidence that a foreign uid-1000 name is tolerated by the platform*, not a mechanism we call: the name is resolved inside the sandbox from `/etc/zs/user` (§3.14 fixup step 8) and `nix::unistd::User::from_uid` (§3.16), which is what `USER 1000` in §4.5 relies on. |
| `node_modules/@vercel/sandbox/dist/command.d.ts:44-79` | `Command { exitCode: number \| null; cmdId }`, `wait()`. |
| `node_modules/workflow/dist/api.d.ts:1` | `start`, `getRun`, `Run` re-exported from `@workflow/core/runtime` (`workflow/api`). |
| `node_modules/.pnpm/@workflow+core@4.8.5_*/node_modules/@workflow/core/dist/index.d.ts:12, 15` | `FatalError`, `RetryableError` (from `@workflow/errors`), `sleep` — importable from `"workflow"`. |
| `node_modules/.pnpm/@workflow+errors@4.2.1/node_modules/@workflow/errors/dist/index.d.ts:454-478` | `class FatalError extends Error { constructor(message) }`; `RetryableError(message, { retryAfter?: number \| StringValue \| Date })` (default 1 s). |
| `@workflow/core/dist/sleep.d.ts:12-32` | `sleep(duration: StringValue) \| sleep(date: Date) \| sleep(durationMs: number)`. |
| `node_modules/@vercel/functions/oidc/index.d.ts:15` | `export { getVercelOidcToken, getVercelOidcTokenSync } from '@vercel/oidc'` (`@vercel/oidc 3.8.5`, `package.json:80`); `getVercelOidcToken(options?): Promise<string>`. Used for the builder's registry credential when `ZS_VCR_AUTH=oidc` (§3.8, §7 item 3). |
| `node_modules/@vercel/blob/dist/index.d.ts:2`; `create-folder-BM6BTlko.d.ts:324, 374-430` | Line 2 re-exports `issueSignedToken`, `presignUrl` and the `Presign{Get,Head,Put,Delete}UrlOptions` types (`put` is exported elsewhere in the file). `presignUrl(signedToken, options)` is **two-argument** — §3.8 writes it out in full. |
| `node_modules/.pnpm/@octokit+plugin-rest-endpoint-methods@17.0.0_*/…/method-types.d.ts:5828` (`git.getTree`), `:11139` (`repos.getContent`), `:10031` (`repos.compareCommitsWithBasehead`; `:9930` is only the deprecation note on `repos.compareCommits`) | Used by §3.5 to read the config, digest the build context (tree sha) and list changed files when a push payload is truncated. |

### 2.6 Zed fork (read-only evidence for the warm-up)

| Anchor | Note |
|---|---|
| `zed/crates/remote_server/src/headless_project.rs:115` | `languages::init(languages.clone(), fs.clone(), node_runtime.clone(), cx)` in `HeadlessProject::new`. |
| `headless_project.rs:318`, `:657` | `session.add_entity_request_handler(Self::handle_open_buffer_by_path)` (registration) and `pub async fn handle_open_buffer_by_path` (definition); it opens the buffer through `BufferStore::open_buffer` and `create_buffer_for_peer`. (`:299` is the unrelated `subscribe_to_entity(REMOTE_SERVER_PROJECT_ID, &context_server_store)`.) |
| `zed/crates/project/src/lsp_store.rs:4815-4841` | `on_buffer_store_event`: `BufferAdded` → `on_buffer_added` → `register_buffer_with_language_servers` — opening a buffer is what starts (and, for adapters without `check_if_user_installed`, downloads) the language servers. Confirms b8 §3.16a's mechanism: a headless client needs only `AddWorktree` + `OpenBufferByPath`. |
| `zed/crates/remote_server/src/server.rs:556-560`, `:764` | `pub(crate) fn init_paths()` creates `paths::languages_dir()` (`:560`); `languages.set_language_server_download_dir(paths::languages_dir().clone())` (`:764`) — downloads land under the data dir, inside the prebuild snapshot and the D9 tarball. |
| `zed/crates/language/src/language_registry.rs:554-555, 918-919`; `language.rs:698, 822` | `set_language_server_download_dir`; `check_if_user_installed` is the PATH-lookup hook (b8 §2 lists which adapters implement it). A repo image built on a user base has none of our preinstalled servers, so the warm-up matters more there (§3.15). |
| `zed/crates/remote/src/remote_client.rs:1377` (`pub enum RemoteConnectionOptions`), `:1656` (`pub trait RemoteConnection: Send + Sync`), `:1329` (`RemoteConnectionOptions::WebSocket(opts) => WebSocketRemoteConnection::new(opts, delegate, cx)`), `transport/websocket.rs` (1 243 lines) + `transport/websocket/{dial_native,dial_web,wire,tests}.rs` | b1's WebSocket transport **has landed**. So the reason §3.15 still keeps `warm.rs` is no longer "no transport exists": it is that a `RemoteClient`-based client pulls in `Project`, `gpui::Application::headless()` and most of the client crate graph for two requests (§7 item 9). |

### 2.7 External documentation and registries (fetched 2026-09-02)

| Source | Fact used |
|---|---|
| `https://vercel.com/docs/sandbox/concepts/images` | "Custom images give you full control over the sandbox environment. Define the Linux distribution, system packages, language toolchains, and filesystem layout in a Dockerfile" — **no base-image requirement**. Readiness table: `Ready` ("VCR prepared the image and Sandbox can use it"), `Preparing` ("VCR is preparing a `linux/amd64` image"), `Unoptimized` ("not `linux/amd64` and cannot be used in Sandbox"); "If `Sandbox.create()` returns `image_not_ready`, retry after preparation finishes." "Vercel Sandbox does not run Docker `ENTRYPOINT` or `CMD`"; `WORKDIR` is the default cwd else `/`. References: `repo`, `repo:tag`, `repo@sha256:…`, `team/project/repo[:tag\|@digest]`, optional `vcr.vercel.com/` prefix; `not_found` for unshared repositories. |
| `https://vercel.com/docs/container-registry` | "Authenticate with a Vercel token": `printf '%s' "$VERCEL_TOKEN" \| docker login vcr.vercel.com --username "$VERCEL_TEAM_ID" --password-stdin` ("The Docker username is the team ID that owns the project"). `vercel vcr login docker` "mints a short-lived, project-scoped OpenID Connect (OIDC) token and passes it to your container tool with the username `oidc`. The credentials are valid for 12 hours". Recommended push: `docker buildx build --platform linux/amd64 --output "type=image,name=vcr.vercel.com/team-slug/project-name/my-repository:latest,push=true,oci-mediatypes=true,compression=zstd,compression-level=3,force-compression=true" .`; plain `docker push` works without zstd. Repository names: `[a-z0-9._-]`, no leading/trailing `.`/`_`/`-`. |
| `https://vercel.com/docs/container-registry/limits-and-pricing` | Compressed image layer 500 MB; total image 15 GB ("calculated from the compressed layers and config blob referenced by the image manifest"); manifest 4 MB; config blob 1 MB; layers gzip or zstd only; "Single-platform image manifests must include `os` and `architecture`"; Pro: 1,000 repositories/project, 10,000 images/repository, 10,000 tags/repository; $0.10/GB storage. |
| `https://vercel.com/docs/container-registry/cli-reference` | `vercel vcr image ls <repo> --format json`, `vercel vcr image inspect <repo> <image-id>`, `vercel vcr image rm <repo> <image-id> --yes`, `vercel vcr tag ls`; `vercel vcr build docker [path] [name]` (`--platform`, `--push`, `--` pass-through; name without `/`). The CLI is **not** installed in the builder (§3.13): the builder uses `docker` directly with an injected credential. |
| `https://vercel.com/docs/rest-api/vcr/get-a-repository-image` | `GET https://api.vercel.com/v1/vcr/repository/{idOrName}/images/{imageIdOrDigest}?projectId=…&teamId=…` (bearer access token); `image.status ∈ "preparing" \| "ready" \| "unoptimized" \| null` ("VHS-readiness status, or `null` for a multi-platform index"), `manifestDigest`, `kind ∈ attestation \| index \| manifest`, `platform`, `arch`, `sizeInBytes`, `tags[]`, `createdAt`; 404/410 for unknown images. This is the readiness poll (§3.8 `vcr.ts`). |
| `https://vercel.com/docs/rest-api/vcr/list-repository-images` | `GET /v1/vcr/repository/{idOrName}/images?projectId&limit(1..100)&cursor&untagged&teamId` → `{ images: [...same fields...], nextCursor? }` — used by the gc step to delete superseded tags (§3.9). |
| `https://vercel.com/docs/sandbox/concepts/runtimes` | "System-privileged processes … Container runtimes: Run Docker and other container engines inside the sandbox to build images or run containerized workloads … run them with `sudo`". Sudo: `HOME=/root`, `PATH` unchanged, env inherited. "Containers do not inherit the proxy CA" (only matters when firewall transformation rules terminate TLS; the builder runs `allow-all`). CA env vars (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, …) point at `/etc/ssl/certs/ca-certificates.crt`. |
| `https://vercel.com/changelog/run-docker-containers-inside-vercel-sandbox` | Daemon started as `sudo dockerd` detached, readiness by looping `sudo docker info`; Docker installations and pulled images persist across sessions on persistent sandboxes. |
| `https://vercel.com/kb/guide/test-container-image-vercel-sandbox` | Same `docker buildx build … --output type=image,…,push=true,compression=zstd` line; readiness "Check the readiness state on the repository details page … `image_not_ready` if preparation hasn't completed"; docker installed in a sandbox with `curl -fsSL https://get.docker.com \| sh` under `sudo`. |
| `https://raw.githubusercontent.com/vercel/sandbox/main/images/ubuntu/Dockerfile` | `FROM ubuntu:26.04`; packages `ca-certificates sudo`; `/etc/sudoers.d/sandbox` = `Defaults always_set_home`, `Defaults !env_reset`, `Defaults !fqdn`, `ubuntu ALL=(ALL) NOPASSWD:ALL` (mode 0440); `install -d -o ubuntu -g ubuntu /vercel`, home moved to `/vercel`, `ENV HOME=/vercel`, `USER ubuntu`, `WORKDIR /vercel`. The layer fixup (§3.14) reproduces exactly this on a foreign base. |
| `https://raw.githubusercontent.com/devcontainers/cli/main/src/spec-node/devContainersSpecCLI.ts` (`buildOptions`) | `devcontainer build [path]` options: `--workspace-folder`, `--config` ("devcontainer.json path"), `--log-level`, `--log-format`, `--no-cache`, `--image-name`, `--cache-from`, `--cache-to`, `--buildkit auto`, `--platform`, `--push` (default false), `--label`, `--output` ("Overrides the default behavior to load built images into the local docker registry"), `--additional-features` (JSON), `--skip-feature-auto-mapping`, `--skip-persisting-customizations-from-features`, `--docker-path`, lockfile flags, `--omit-syntax-directive`. `read-configuration`: `--include-features-configuration`, `--include-merged-configuration`, `--config`, `--workspace-folder`. |
| `https://registry.npmjs.org/@devcontainers/cli/latest` | `0.89.0`, `engines.node >= 20.0.0`, bin `devcontainer` (`devcontainer.js`), no runtime dependencies (bundled). README: "To install the npm package you will need Python and C/C++ installed to build one of the dependencies" — b8's image has `build-essential` and Python. |
| `https://containers.dev/implementors/json_reference/` (re-fetched 2026-09-02) | Types/semantics for every key in §4.1; lifecycle commands accept string (shell), array (argv), object (parallel named commands). Substitutions, **exactly as documented**: `${localEnv:NAME}` (any property, `:default` supported), `${containerEnv:NAME}` (**`remoteEnv` only**, `:default` supported), `${localWorkspaceFolder}`, `${containerWorkspaceFolder}`, `${localWorkspaceFolderBasename}`, `${containerWorkspaceFolderBasename}` (any property, **no** `:default`), `${devcontainerId}` (a named subset of properties). The page does **not** document discovery paths — our two-path lookup (§3.1) comes from the CLI's behaviour and §7 item 7 owns the subfolder gap. `containerEnv` "sets the variable on the Docker container itself, so all processes spawned in the container have access to it"; `remoteEnv` sets it for the tool/sub-processes only. `remoteUser`/`containerUser`; `hostRequirements { cpus, memory, storage, gpu }`. Consequence for §3.1 step 7: `${containerEnv:…}` is resolved **nowhere at build time** — it is left verbatim for the supervisor in `remoteEnv`, and its use anywhere else is an `unresolved_variable` warning with the reference left as written. |
| `https://containers.dev/implementors/features/` | Feature ids: `ghcr.io/owner/repo/name[:version]` (`:latest` implied), HTTPS tarballs, local paths; options object or shorthand string/boolean (`"1.18"` ⇒ `{ version: "1.18" }`); tools stack one layer per Feature `install.sh` on the base image; `_REMOTE_USER`/`_CONTAINER_USER`; `overrideFeatureInstallOrder`; `installsAfter` (soft) and `dependsOn` (hard); feature metadata may declare `containerEnv`, `mounts`, `privileged`, `init`, `capAdd`, `securityOpt`, `entrypoint` (the last five have no effect in a Firecracker VM without a container runtime; §3.1 records them as warnings). |
| `https://registry.npmjs.org/jsonc-parser/latest` | `3.3.1`, MIT, zero dependencies (the parser the devcontainer CLI itself uses). |
| `https://docs.github.com/en/webhooks/webhook-events-and-payloads#push` | `push` payload: `ref`, `before`, `after`, `commits[]` each with `added`, `modified`, `removed`; "The array includes a maximum of 2048 commits. If necessary, you can use the Commits API to fetch additional commits"; `head_commit`. |
| Real-world configs, fetched verbatim from `raw.githubusercontent.com` in this session and re-fetched into `apps/web/tests/fixtures/devcontainer/` by §6.1 | `github/docs` (`build.dockerfile` + `args.VARIANT`, features `sshd: "latest"`, `copilot-cli`, `github-cli`, `docker-in-docker`, `forwardPorts: [4000]`, `portsAttributes.4000.label`, `postStartCommand`, `postAttachCommand` using `$CODESPACE_NAME`, `remoteUser: "node"`, `hostRequirements { memory: "16gb", cpus: "4" }`, `customizations.vscode/.codespaces`); `denoland/deno` (`build.dockerfile`, `runArgs`, `postCreateCommand`, `remoteUser: "vscode"`, nested comment inside `customizations.vscode.settings`); `microsoft/vscode-remote-try-node` (`image: mcr.microsoft.com/devcontainers/javascript-node:1-18-bullseye`, `portsAttributes.3000`, `postCreateCommand: "npm install"`, tab-indented with comments); `microsoft/vscode-remote-try-python` (`image`, `portsAttributes.9000`, `postCreateCommand`); `microsoft/TypeScript` (`image: …/go:dev-1.26-bookworm`, features `node:2 { version, pnpmVersion, nvmVersion }`, `dprint-asdf:2` (not allowlisted), `github-cli:1`, **object-form** `postCreateCommand` with three named commands); `microsoft/vscode-remote-try-go` (`image`, `portsAttributes.9000`, everything else commented out). |

---

## 3. Change list in dependency order

New unless marked *modified*. TypeScript paths are under `apps/web/` unless prefixed. `†` marks a file that does not exist on disk yet and is **not** created by this brief — it is b8/b9 work in flight, and this brief's edit lands when it does (if it lands later, the edit is a new file with only this brief's content).

There is **no `packages/` directory in the repository** (`ls` at the root: `apps docs infra sandbox zed`), so b9 §3.32's `packages/sdk` is a plan, not a place. The shared schema therefore lives at `apps/web/lib/devcontainer/schema.ts`, imported by routes, workflows, tests and the schema emitter through the existing `@/*` alias; if `packages/sdk` ever lands, that file moves and re-exports. Nothing else in this brief depends on the package boundary.

```
apps/web/lib/devcontainer/schema.ts              zod schema + types of DevcontainerNormalized and the manifest block (shared with tests, b9's sandboxManifest schema, docs/contracts)
apps/web/lib/devcontainer/jsonc.ts               JSONC → JSON (jsonc-parser), error mapping
apps/web/lib/devcontainer/substitute.ts          ${…} variable substitution
apps/web/lib/devcontainer/features.ts            allowlist, id canonicalisation
apps/web/lib/devcontainer/normalize.ts           parseDevcontainer(): raw → DevcontainerNormalized + warnings/errors
apps/web/lib/devcontainer/hash.ts                canonical JSON, contentHash, configHash, ZS_LAYER_VERSION
apps/web/lib/devcontainer/env-filter.ts          containerEnv/remoteEnv key filter (RESERVED_SECRET_NAMES ∪ ZS_* ∪ LD_*/GIT_*/NODE_OPTIONS/…), settings-overlay key allowlist
apps/web/lib/devcontainer/dockerfile.ts          synthesised zs-layer Dockerfile (string), used by the builder script generator and tests
apps/web/lib/devcontainer/index.ts               re-exports
apps/web/lib/schema.ts                           modified (repos columns, image_builds table, enums)
apps/web/lib/env.ts                              modified (VCR/Vercel variables, builder image ref, limits)
apps/web/lib/ids.ts                              modified ("img", "ib" prefixes, newImageBuildSandboxName)
apps/web/lib/ratelimit.ts                        modified (two LimitName entries)
apps/web/lib/types.ts                            modified (sandboxNameSchema gains ib-; manifest devcontainer block; views)
apps/web/lib/sandbox-auth.ts                     modified (imageBuild principal; requireSandbox(req, name, opts?))
apps/web/lib/sandbox.ts                          modified (CreateSandboxInput.persistent + optional snapshot fields; runDetached/run forward RunInput.timeoutMs; SandboxHandle.commandStatus)
apps/web/lib/lifecycle.ts                        modified (LifecycleWorkflowName + WORKFLOW_MODULES gain buildDevcontainerImage)
apps/web/lib/github.ts                           modified (fetchDevcontainerSources, treeSha, pushTouchesDevcontainer, changedFiles)
apps/web/lib/vcr.ts                              VCR REST client, credential minting, repository/tag naming
apps/web/lib/images.ts                           resolveRepoImage(), staleness rule, image-build admission
apps/web/lib/manifest.ts                         modified (devcontainer block, prebuild image)
apps/web/workflows/steps/image-steps.ts          "use step" functions for the builder workflow
apps/web/workflows/build-devcontainer-image.ts   the buildDevcontainerImage workflow
apps/web/workflows/steps/db-steps.ts             modified (stepPickImage → resolveRepoImage; stepCreatePrebuildRow(imageRef); stepResolveImageForPrebuild, stepSetPrebuildStatus, stepReposWithImages live here)
apps/web/workflows/prebuild.ts                   † modified (image resolution + child build)
apps/web/workflows/gc.ts                         † modified (superseded image tags, orphan reconciliation, log-blob expiry)
apps/web/app/api/sandboxes/[name]/image-build/route.ts        GET spec / POST status (builder principal)
apps/web/app/api/repos/[id]/image-builds/route.ts             GET history / POST manual rebuild
apps/web/app/api/repos/[id]/image-builds/[buildId]/log/route.ts   GET → 303 presigned log URL
apps/web/app/api/repos/route.ts                  modified (POST computes contentHash and admits a build)
apps/web/app/api/workspaces/route.ts             modified (409 image_building with runId; allowBase)
apps/web/app/api/webhooks/github/route.ts        modified (.devcontainer/** push trigger)
apps/web/app/(site)/(dashboard)/repos/[id]/page.tsx           † modified (image panel)
apps/web/app/(site)/(dashboard)/workspaces/new/page.tsx       † modified (devcontainer detection states)
apps/web/app/(site)/(dashboard)/workspaces/[id]/page.tsx      † modified (stale-image banner)
apps/web/scripts/emit-schemas.ts                 z.toJSONSchema → docs/contracts/*.v1.json (new; run by pnpm zs:schemas, checked in CI)
sandbox/image/Dockerfile                         † (b8 §3.19) — build-builder.sh consumes its pushed digest via sandbox/image/dist/image.json
sandbox/image/builder/Dockerfile                 builder image
sandbox/image/builder/zs-build-devcontainer.sh   the in-sandbox build driver
sandbox/image/builder/layer/zs-layer-fixup.sh    root-time fixup run inside the synthesised layer
sandbox/image/builder/layer/Dockerfile.zs-layer.tmpl   template the driver renders (mirrors lib/devcontainer/dockerfile.ts)
sandbox/image/build-builder.sh                   builds and pushes zs-builder:<build>
.github/workflows/sandbox-image.yml              † modified (builder job; only web.yml exists today)
sandbox/supervisor/src/{manifest,bootstrap,config,start,warm}.rs    modified (b8 delta, §3.16 — real signatures in §2.3)
sandbox/supervisor/Cargo.toml                    modified (nix "user" feature)
docs/contracts/sandbox-manifest.v1.json          † modified (devcontainer block); docs/contracts/devcontainer-normalized.v1.json new; docs/contracts/sandbox-api.md † modified; docs/contracts/fixtures/manifest.example.json modified (exists)
docs/briefs/CONTRACTS.md                         modified (§7.2, §7.3, §7.4, §7.6, §8.1, §8.2, §11, §12 rows — §3.17)
docs/briefs/DECISIONS.md                         modified (D35-D40 — §3.18)
apps/web/tests/…                                 §6 (tests/routes/ and tests/workflows/ exist but are empty; the builder fake extends lib/sandbox-fake.ts)
```

### 3.1 Parser: `lib/devcontainer/*.ts`

Types and the zod schema live in `apps/web/lib/devcontainer/schema.ts` (there is no `packages/` directory; see the change-list preamble). The parser itself is server-only code in the same directory. `zod 4.5.4` is already a dependency of `apps/web` (`package.json:39`).

```ts
// lib/devcontainer/jsonc.ts
import { parse, type ParseError, printParseErrorCode } from "jsonc-parser";
export class DevcontainerSyntaxError extends Error { constructor(public readonly errors: Array<{ code: string; offset: number; length: number }>) }
export function parseJsonc(text: string): unknown;   // parse(text, errors, { allowTrailingComma: true, disallowComments: false, allowEmptyContent: false }); throws DevcontainerSyntaxError when errors.length > 0 or the root is not an object

// lib/devcontainer/substitute.ts
export interface SubstitutionContext { workspaceFolder: string /* /workspaces/<repo> */; workspaceFolderBasename: string; devcontainerId: string /* repo id */; localEnv: Record<string, string> /* always {} in the control plane and in the builder */; containerEnv: Record<string, string> /* the config's own containerEnv literals */ }
export interface SubstitutionReport { unresolved: string[] /* "${localEnv:FOO}" occurrences resolved to "" (or their default) */ }
export function substitute(value: string, ctx: SubstitutionContext, report: SubstitutionReport): string;
// Grammar, exactly the seven documented forms (containers.dev json_reference, re-fetched 2026-09-02 — §2.7):
//   ${localEnv:NAME[:default]}                 → ctx.localEnv[NAME] ?? default ?? "" ; ctx.localEnv is ALWAYS {} here (no host), so a use without a default is recorded as unresolved_variable
//   ${containerEnv:NAME[:default]}             → NEVER resolved at build time. The spec restricts it to `remoteEnv`, where the supervisor resolves it at boot against the real process env (b8 §3.4 expand_remote_env); in remoteEnv it is kept verbatim, anywhere else it is kept verbatim AND warned (unresolved_variable). It is no longer applied to build.args or containerEnv — those are baked into the image, where no container env exists yet.
//   ${localWorkspaceFolder} | ${containerWorkspaceFolder}   → ctx.workspaceFolder (there is no "local" side: the clone IS the workspace)
//   ${localWorkspaceFolderBasename} | ${containerWorkspaceFolderBasename} → basename (no `:default` form for these four)
//   ${devcontainerId}                          → ctx.devcontainerId
// unknown ${x} left verbatim and recorded. Applied to: build.args values, containerEnv values, remoteEnv values, lifecycle command strings/argv.
export function substituteDeep<T>(value: T, ctx: SubstitutionContext, report: SubstitutionReport, opts?: { allowContainerEnv?: boolean /* true only for remoteEnv: keep the reference without a warning */ }): T;

// lib/devcontainer/features.ts
export const FEATURE_ALLOWLIST = ["common-utils", "node", "python", "go", "rust", "java", "docker-in-docker", "github-cli"] as const;   // BUILD-SPEC:309
export const FEATURE_REGISTRY = "ghcr.io/devcontainers/features";
export type AllowedFeature = (typeof FEATURE_ALLOWLIST)[number];
export interface FeatureRef { id: `${typeof FEATURE_REGISTRY}/${AllowedFeature}`; version: string /* tag; "latest" when omitted */; options: Record<string, string | boolean> }
export function canonicalizeFeatureId(raw: string): { name: string; version: string; registry: string | null } | null;   // "node" → { name: "node", version: "latest", registry: null } (the CLI's legacy auto-mapping, which we mirror only for allowlisted names); "ghcr.io/devcontainers/features/node:2" → { name: "node", version: "2", registry: "ghcr.io/devcontainers/features" }; "ghcr.io/devcontainers-extra/features/dprint-asdf:2" → registry outside FEATURE_REGISTRY; https:// tarballs and ./local paths → null
export function normalizeFeatures(raw: Record<string, unknown> | undefined, warnings: Warning[]): FeatureRef[];   // sorted by id; shorthand string → { version: s }, boolean true → {}, false → dropped; non-allowlisted or non-canonical → warning { code: "feature_not_allowed", key } and dropped (the build proceeds without it — Codespaces would fail; we degrade and show the warning; §7 item 6)
export function featuresNeedDockerd(features: FeatureRef[]): boolean;   // docker-in-docker present

// lib/devcontainer/normalize.ts
export interface Warning { code: "unsupported_key" | "feature_not_allowed" | "port_key_ignored" | "unresolved_variable" | "invalid_value" | "unsupported_lifecycle" | "reserved_name" | "unsupported_setting_key"; key: string; message: string }
export type ParseOutcome =
  | { ok: true; config: DevcontainerNormalized; warnings: Warning[]; raw: string; path: DevcontainerPath }
  | { ok: false; error: { code: "syntax" | "not_object" | "unsupported_compose" | "no_image_or_dockerfile" | "invalid_dockerfile_path" | "invalid_context_path" | "base_registry_not_allowed"; message: string; details?: unknown }; warnings: Warning[]; raw: string; path: DevcontainerPath };
export type DevcontainerPath = ".devcontainer/devcontainer.json" | ".devcontainer.json";   // §7 item 7: `.devcontainer/<subfolder>/devcontainer.json` (multiple configs) is not selectable in v1
export interface ParseInput { raw: string; path: DevcontainerPath; repo: { id: string; name: string }; localEnv?: Record<string, string> }
export function parseDevcontainer(input: ParseInput): ParseOutcome;
```

`parseDevcontainer` rules, in order (each is a unit test in §6.1):

1. `parseJsonc`; root must be an object.
2. `dockerComposeFile` present → error `unsupported_compose` (BUILD-SPEC:309). `image` and `build` both absent → error `no_image_or_dockerfile`. Both present → `build` wins, warning `invalid_value:image`.
3. `build.dockerfile` (string, required with `build`), `build.context` (default `"."`), `build.args` (object of strings after substitution), `build.target` (string, passed through), `build.options` (array → warning `unsupported_key`, dropped), `build.cacheFrom` (dropped, we manage caching). Paths are resolved relative to the config's directory (`.devcontainer/` or the repo root for `.devcontainer.json`), normalised with `path.posix`, and must stay inside the repo (`..` escaping → `invalid_dockerfile_path` / `invalid_context_path`). Output holds **repo-relative** paths (`dockerfilePath`, `contextPath`).
4. `image` (string): parsed as an OCI reference and validated against `BASE_REGISTRY_ALLOWLIST = ["docker.io", "ghcr.io", "mcr.microsoft.com", "quay.io", "public.ecr.aws"]` (a bare `foo/bar` or `node:20` normalises to `docker.io`). Anything else — including a bare host:port, an IP literal, `169.254.169.254`, and **`vcr.vercel.com`** — is error `base_registry_not_allowed` (an unrestricted `image` is a pull, by a VM inside our infrastructure with `networkPolicy: "allow-all"`, of an attacker-chosen host: the SSRF surface of this brief). Digest form is allowed and preserved. The same check runs over the fetched `build.dockerfile` bytes at admission: every `FROM <ref>`, `COPY --from=<ref>` and `RUN --mount=type=bind,from=<ref>` host must be on the allowlist, and a `# syntax=` directive is rejected outright (the driver also passes `--omit-syntax-directive`, §3.13, so a BuildKit frontend image can never be downloaded and executed). Rejecting at admission means the user sees it in the dashboard instead of after a 45-minute build. `image` and `build.dockerfile` references are additionally resolved to a digest at admission (§3.7 step 3).
5. `features` → §features.ts; `overrideFeatureInstallOrder` kept (filtered to allowlisted ids).
6. Lifecycle: `postCreateCommand`, `postStartCommand`, `postAttachCommand` **and, as a compatibility extension, `onCreateCommand` and `updateContentCommand`** (they run before `postCreateCommand` in Codespaces and appear in real configs; the supervisor folds them into its `post_create` phase, §3.16). Each becomes `LifecycleCommand = { kind: "shell"; command: string } | { kind: "argv"; argv: string[] } | { kind: "parallel"; commands: Record<string, { kind: "shell" | "argv"; … }> }`. `initializeCommand` → warning `unsupported_lifecycle` and dropped (it would run in the builder). `waitFor` dropped (we always wait for nothing: the server starts beside the commands, b8 §3.16).
7. `remoteEnv` (object of strings; `${containerEnv:…}` kept verbatim for the supervisor), `containerEnv` (object of strings; substituted except for `${containerEnv:…}`; baked into the image by §3.14). **Both maps are filtered by `lib/devcontainer/env-filter.ts` before anything else sees them** — this is repository-controlled content that ends up in the image `ENV` (`containerEnv`, i.e. the environment of `zs-agent` itself) and in the server environment (`remoteEnv`, unioned unfiltered by CONTRACTS §11:614). A key is dropped with warning `reserved_name` when it matches any of:
   - `^ZS_` — every `ZS_*` name, not just the five CONTRACTS §7.2 strips. `containerEnv.ZS_LOCAL_API_LISTEN=0.0.0.0:8450` would expose the loopback supervisor API; `ZS_INSECURE_COOKIES=1` would drop `Secure` from the private-port proxy cookie (D8); `ZS_STATE_DIR`/`ZS_DATA_DIR`/`ZS_CONTROL_SECRET_FILE` would move state under repository control.
   - b9's `RESERVED_SECRET_NAMES` (`LD_PRELOAD, LD_LIBRARY_PATH, BASH_ENV, ENV, PROMPT_COMMAND, GIT_ASKPASS, SSH_ASKPASS, GIT_CONFIG_PARAMETERS, HOME, PATH, USER, SHELL`) — the list that already exists to stop exactly this for user secrets (CONTRACTS §7.2, §8.2 `reserved_name`). `containerEnv.LD_PRELOAD=/workspaces/x/evil.so` is code execution inside the supervisor, which holds `ZS_SANDBOX_TOKEN` and the control secret (D18).
   - `^(LD_|GIT_|PERL5)`, `NODE_OPTIONS`, `PYTHONSTARTUP`, `PYTHONPATH` — the same class one step down.
   `PATH` is the one special case §4.5 keeps: a `containerEnv.PATH` is applied only when it still contains `/usr/local/bin`, else warned and dropped. `renderLayerDockerfile` re-asserts the filter (defence in depth: the layer template never emits a dropped key), and §3.16 makes the supervisor apply the same filter when unioning `remoteEnv` into the server environment. `remoteUser`/`containerUser`/`updateRemoteUserUID` → warnings `unsupported_key` (v1 always runs uid 1000, §3.14).
8. `forwardPorts`: integers 1..65535 only; `"host:port"` entries → warning `port_key_ignored`; ports in `infraPorts()` → warning `invalid_value` and dropped. `infraPorts()` (`lib/env.ts:278-286`, verified) is the whole `8443-8451` range unioned with the configured rpc/health/slot ports, so `8449`, `8450` and `8451` are covered. `portsAttributes`: keys that are a single port → `{ label?: string; visibility?: "public" | "private" /* our extension, BUILD-SPEC:309 */; onAutoForward?: string (kept, informational); protocol?: "http" | "https" }`; range/host/regex keys → `port_key_ignored` (matches b8 `parse_port_key`). `otherPortsAttributes` → `{ visibility?, label? }` default for auto-detected ports.
9. `customizations.zed`: `{ extensions?: string[] (ids ^[a-z0-9][a-z0-9_-]{0,63}$, b9 §4.2 — **not** auto-installed: repo-declared extensions are offered in the dashboard and installed only after a per-repo user opt-in, because a fork's branch can reach a user through BUILD-SPEC:383's create-from-PR flow), settings?: object filtered to the presentation-only allowlist below (JSON, merged under the user's settings by the supervisor, §3.16), prebuild?: { files?: string[] (repo-relative probe files for the warm-up), command?: string (default for ZS_PREBUILD_WARM_CMD when repos.prebuild_warm_command is null) }, services?: ("dockerd")[] (explicit opt-in besides the docker-in-docker feature) }`. Every other `customizations.*` member (`vscode`, `codespaces`, …) → warning `unsupported_key` (informational, not shown as a problem).

   **`customizations.zed.settings` key allowlist** (`lib/devcontainer/env-filter.ts`, enforced at parse time, warning `unsupported_setting_key` per dropped key). A Zed settings blob is not inert data: `lsp.<name>.binary.{path,arguments}`, `terminal.{shell,env}`, `task`/`tasks`, `context_servers`, `agent`, `node`, `command_aliases` and `file_scan_*` all name a program or a path the editor will execute or read. "User wins on conflict" (§3.16) protects only keys the user has already set explicitly, which is almost none of these. Repository content therefore cannot set them. Kept: `theme`, `icon_theme`, `ui_font_*`, `buffer_font_*`, `tab_size`, `hard_tabs`, `soft_wrap`, `preferred_line_length`, `format_on_save`, `remove_trailing_whitespace_on_save`, `ensure_final_newline_on_save`, `show_whitespaces`, `wrap_guides`, `indent_guides`, `file_types`, and `languages.<lang>.{tab_size, hard_tabs, soft_wrap, preferred_line_length, format_on_save, formatter}` where `formatter` is `"auto"`, `"prettier"`, `"language_server"` or `{ "external": … }`→dropped. Everything else is dropped with the warning shown in the repo panel. §7 item 17 tracks widening this by opt-in.
10. `hostRequirements` → `{ cpus?: number; memoryMb?: number }` parsed from `"4"`/`"16gb"`; the create flow uses it to preselect the machine (§3.12).
11. Anything else (`runArgs`, `mounts`, `workspaceMount`, `workspaceFolder`, `shutdownAction`, `capAdd`, `securityOpt`, `privileged`, `init`, `appPort`, `userEnvProbe`, `overrideCommand`, `name` is kept) → `unsupported_key` warning; `name` is kept.

```ts
// lib/devcontainer/hash.ts
export const ZS_LAYER_VERSION = 1;                                   // bump when zs-layer-fixup.sh or Dockerfile.zs-layer.tmpl changes behaviour
export function canonicalJson(value: unknown): string;               // RFC 8785-style: object keys sorted (code-point order), no whitespace, numbers as shortest round-trip, strings JSON-escaped; arrays keep order
export function contentHash(config: DevcontainerNormalized): string; // BARE hex(sha256(canonicalJson({ v: 1, config }))) — no "sha256:" prefix → repos.devcontainer_hash, manifest.devcontainer.configHash
export interface ConfigHashInput { config: DevcontainerNormalized; dockerfileSha256: string | null /* hex of the Dockerfile bytes at the revision */; contextDigest: string | null /* §3.7 step 3: NOT the whole-tree sha */; baseDigests: Record<string, string> /* resolved OCI digests of the base image and of every Feature ref */; serverBuild: string /* ZS_SERVER_BUILD_ID of the builder image */; layerVersion: number }
export function configHash(input: ConfigHashInput): string;          // hex(sha256(canonicalJson({ v: 1, ...input }))) — the image identity; tag = configHash.slice(0, 16)
export const MARKER_V = 1;                                           // the supervisor's post-create marker is `${MARKER_V}:${contentHash}` (§3.16), so adding a defaulted field to the zod schema does not re-run postCreate in every existing workspace
```

**Format: bare hex, deliberately.** Both consumers on disk use bare hex today — `lib/github.ts:180` returns `createHash("sha256").update(raw,"utf8").digest("hex")`, which b9's `POST /api/repos` writes to `repos.devcontainer_hash`; `lib/manifest.ts:156,199` ship that value as `devcontainer.configHash`; `docs/contracts/fixtures/manifest.example.json:57` is 64 bare hex characters, asserted by b8's `example_manifest_parses` and b9's `fixture_parses_with_sdk_schema`. Adding a `"sha256:"` prefix would mix two formats in one column, break both fixture tests and need a migration, for nothing. b8's *marker file* keeps its own `sha256:<hex>` shape internally (b8 §3.14); §3.16 states the conversion.

Why two hashes: `contentHash` answers "did the devcontainer *config* change?" (triggers, the supervisor's post-create marker, the dashboard's "config changed since last build") and is independent of our build id; `configHash` answers "is there an image that is exactly this config on exactly this Dockerfile/context with exactly this server build and layer script?" and names the image. A push that only touches `.devcontainer/Dockerfile` changes `configHash` but not `contentHash`; a deploy changes `configHash` for every repo (§3.9 handles staleness lazily, and §3.13's registry cache plus the `<contentHash16>-<serverBuild>` tag make a server-build-only rebuild cheap — otherwise every deploy would be a cold rebuild of every repo's whole Feature stack).

```ts
// lib/devcontainer/dockerfile.ts
export interface LayerDockerfileInput { stageImage: string /* local tag produced by `devcontainer build --image-name` */; containerEnv: Record<string, string>; serverBuild: string; configHash: string; repoFullName: string; layerVersion: number; startDockerd: boolean }
export function renderLayerDockerfile(input: LayerDockerfileInput): string;   // exact text in §4.5; used by unit tests (snapshot) and mirrored by sandbox/image/builder/layer/Dockerfile.zs-layer.tmpl, which the driver renders with the same variables — tests/devcontainer/dockerfile.test.ts diff-checks the two (§6.1)
```

### 3.2 `lib/schema.ts` (*modified*, additive)

Insert after `repos` (`b9:913-930`) and before `workspaces`; extend `repos`:

```ts
export const imageBuildStatusEnum = pgEnum("image_build_status", ["queued", "building", "pushing", "preparing", "ready", "failed", "superseded"]);
export const imageBuildTriggerEnum = pgEnum("image_build_trigger", ["create", "push", "manual", "register", "stale", "prebuild"]);

// repos: added columns (existing devcontainerHash/imageRef/imageStatus keep their meaning: the DEFAULT-BRANCH summary)
  devcontainerPath: text("devcontainer_path"),                   // ".devcontainer/devcontainer.json" | ".devcontainer.json" | null (none at the default branch head)
  devcontainerConfig: jsonb("devcontainer_config").$type<DevcontainerNormalized | null>(),   // normalised config of the default branch head (dashboard, create flow); null when absent or unparsable
  devcontainerWarnings: jsonb("devcontainer_warnings").$type<Warning[]>().notNull().default([]),
  devcontainerError: text("devcontainer_error"),                 // ParseOutcome.error.code when the file is unusable
  devcontainerCheckedRevision: text("devcontainer_checked_revision"),   // sha the summary was computed from
  imageBuild: text("image_build"),                               // ZS_BUILD_ID embedded in imageRef (= the builder's build)
  imageDigest: text("image_digest"),                             // sha256:… from VCR (BUILD-SPEC:433 "referenced by digest at create")
  imageConfigHash: text("image_config_hash"),                    // configHash the imageRef was built from
  imageBuiltAt: ts("image_built_at"),
  imageError: text("image_error"),                               // last failed build's error code:message (dashboard)
  imageBuildRunId: text("image_build_run_id"),                   // in-flight buildDevcontainerImage run for the default branch, null when idle
  allowBaseFallback: boolean("allow_base_fallback").notNull().default(true),   // org policy hook: false ⇒ POST /workspaces answers 409 image_building instead of falling back (b9:1122)

export const imageBuilds = pgTable("image_builds", {
  id: text("id").primaryKey(),                                   // img_…
  repoId: text("repo_id").notNull().references(() => repos.id),
  configHash: text("config_hash").notNull(),                     // image identity (hash.ts configHash)
  contentHash: text("content_hash").notNull(),                   // contentHash of the normalised config
  revision: text("revision").notNull(),                          // commit sha the sources were read at
  branch: text("branch"),                                        // branch that triggered it (null for revision builds)
  trigger: imageBuildTriggerEnum("trigger").notNull(),
  requestedByUserId: text("requested_by_user_id"),               // null for webhook/system
  serverBuild: text("server_build").notNull(),                   // ZS_BUILD_ID of the builder image used
  layerVersion: integer("layer_version").notNull(),
  devcontainerPath: text("devcontainer_path").notNull(),
  config: jsonb("config").$type<DevcontainerNormalized>().notNull(),
  warnings: jsonb("warnings").$type<Warning[]>().notNull().default([]),
  dockerfileSha256: text("dockerfile_sha256"),
  contextDigest: text("context_digest"),                         // digest over the .dockerignore-aware context walk (§3.7 step 3), NOT a whole-tree sha
  baseDigests: jsonb("base_digests").$type<Record<string, string>>().notNull().default({}),   // resolved OCI digests of the base image and every Feature ref at admission (§3.7 step 3)
  attempt: integer("attempt").notNull().default(0),              // forced rebuilds of the same configHash get attempt 1,2,… and a distinct tag
  imageRepository: text("image_repository").notNull(),           // "zs-workspace-<slug>" (vcr.ts imageRepositoryName)
  imageTag: text("image_tag").notNull(),                         // `${contentHash.slice(0,16)}-${serverBuild}` (+ `-a<attempt>` when attempt > 0): a human-readable label only — every consumer references the image by DIGEST (BUILD-SPEC:433)
  imageRef: text("image_ref"),                                   // "<repository>@<digest>" (project-relative, what Sandbox.create takes) — COMPUTED SERVER-SIDE from imageRepository + the verified digest, never from the builder's report (§3.10)
  imageDigest: text("image_digest"),                             // manifestDigest from VCR; set when status ≥ preparing
  imageSizeBytes: bigint("image_size_bytes", { mode: "number" }),
  sandboxName: text("sandbox_name"),                             // ib-… builder; a sandbox principal (§3.4)
  sandboxTokenHash: text("sandbox_token_hash"),
  sandboxTokenGeneration: integer("sandbox_token_generation").notNull().default(0),
  builderCmdId: text("builder_cmd_id"),
  status: imageBuildStatusEnum("status").notNull().default("queued"),
  phase: text("phase"),                                          // builder-reported: "boot"|"dockerd"|"clone"|"devcontainer_build"|"layer_build"|"push"|"done"
  error: text("error"),                                          // "<code>: <message>"
  logBlobPathname: text("log_blob_pathname"),                    // image-builds/<id>/build.log (private Blob)
  workflowRunId: text("workflow_run_id"),
  thenPrebuildBranch: text("then_prebuild_branch"),              // chain a prebuild for this branch when ready (§3.9 step 12)
  createdAt: ts("created_at").notNull().defaultNow(),
  startedAt: ts("started_at"),
  finishedAt: ts("finished_at"),
  readyAt: ts("ready_at"),
}, (t) => [
  index("image_builds_repo_created_idx").on(t.repoId, t.createdAt),
  uniqueIndex("image_builds_repo_hash_active_idx").on(t.repoId, t.configHash, t.attempt).where(sql`status IN ('queued','building','pushing','preparing','ready')`),   // at most one live build per (identity, attempt): a forced rebuild is a new attempt, so it never has to supersede the ready row it is replacing (§3.10)
  index("image_builds_repo_branch_active_idx").on(t.repoId, t.branch).where(sql`status IN ('queued','building','pushing','preparing')`),   // one in-flight build per (repo, branch) is enforced against this (§3.7 admission)
  uniqueIndex("image_builds_sandbox_name_idx").on(t.sandboxName),
  index("image_builds_run_idx").on(t.workflowRunId),
]);
export type ImageBuild = typeof imageBuilds.$inferSelect;
export type ImageBuildStatus = (typeof imageBuildStatusEnum.enumValues)[number];
```

`repos.imageStatus` (`lib/schema.ts:45`, `none|building|ready|failed`) stays exactly as it is — **the enum is not widened**. §4.7's `DevcontainerSummary.image.status` and §3.12's pill add `preparing` and `stale`, and both are **derived in the view**, never stored: `preparing` from the live `image_builds.status`, `stale` from `isStaleServerBuild(build)`. Widening a pg enum used by an existing column would be a migration with no benefit, and no step would ever write the two values.

`repos` also gains `staleBuildCooldownAt: ts("stale_build_cooldown_at")` — the `stale` trigger (§3.7 step 5) is admitted at most once per `ZS_STALE_REBUILD_COOLDOWN_MS` (default 6 h) per repo, so the first create per repo after each deploy does not queue a fleet-wide rebuild storm (§7 item 10 refuses to schedule that from cron; admitting it from user traffic is the same storm with a worse arrival pattern).

`image_builds` is the index every image decision reads (§3.7). Migration: one `drizzle-kit generate` (b9 §3.6), committed under `drizzle/` beside the existing `0000_init.sql`.

### 3.3 `lib/env.ts` (*modified*, additive rows in `envSchema`)

```ts
  ZS_BUILDER_IMAGE_REF: z.string().optional(),              // already present (b9:222): "zs-builder:<build>" or "zs-builder@sha256:…"; must embed ZS_SERVER_BUILD_ID (§3.13)
  ZS_VERCEL_TOKEN: z.string().optional(),                   // team access token for the VCR REST API (readiness poll, gc) and, under ZS_VCR_AUTH=token, the builder's registry password
  VERCEL_TEAM_ID: z.string().optional(),                    // team_… — docker login username under ZS_VCR_AUTH=token (VCR docs); REST teamId
  VERCEL_PROJECT_ID: z.string().optional(),                 // prj_… — REST projectId
  VERCEL_TEAM_SLUG: z.string().optional(),                  // registry path segment vcr.vercel.com/<team-slug>/<project-slug>/…
  VERCEL_PROJECT_SLUG: z.string().optional(),
  ZS_VCR_AUTH: z.enum(["token", "oidc"]).default("token"),  // how the builder authenticates docker (§3.8 vcrPushCredential; §7 item 3)
  ZS_IMAGE_BUILD_BUDGET_MS: z.coerce.number().default(45 * 60_000),    // builder command timeoutMs (hard, SDK-enforced) and the workflow's poll ceiling
  ZS_IMAGE_READY_BUDGET_MS: z.coerce.number().default(30 * 60_000),    // readiness poll ceiling after push (BUILD-SPEC:535: undocumented duration)
  ZS_IMAGE_MAX_BYTES: z.coerce.number().default(6 * 1024 ** 3),        // CHEAP PRE-CHECK on the uncompressed size, deliberately well under the 32 GB sandbox disk that must hold the pulled base + the devcontainer stage + the final image + the BuildKit cache at once; the authoritative limits are VCR's COMPRESSED ones, checked after push (§3.13 step 8)
  ZS_IMAGE_KEEP_PER_REPO: z.coerce.number().default(3),                // ready images retained per repo (gc deletes older tags)
  ZS_BUILDER_VCPUS: z.coerce.number().default(4),                      // floor; hostRequirements raises it (§3.8 builderVcpus)
  ZS_BUILDER_MAX_VCPUS: z.coerce.number().default(8),
  ZS_IMAGE_BUILDS_MAX_INFLIGHT_ORG: z.coerce.number().default(3),      // org-level builder concurrency (§3.7 admission)
  ZS_STALE_REBUILD_COOLDOWN_MS: z.coerce.number().default(6 * 3_600_000),
  ZS_EDITOR_BUNDLES: z.string().optional(),                            // comma-separated served client builds, newest first — set by the deploy from public/editor/manifest.json (b9 §3.30). The ONLY way a Function may learn which bundles are served: public/ is CDN-served and is not traced into the serverless function bundle, so fs.existsSync("public/editor/<b>/build.json") is false in production.
export function vcrRegistryPath(): string;    // `vcr.vercel.com/${VERCEL_TEAM_SLUG}/${VERCEL_PROJECT_SLUG}` — throws EnvError when either is missing
export function servedEditorBundles(): string[];   // ZS_EDITOR_BUNDLES split, deduplicated; [] when unset. Used by the staleness rule (§3.7 step 5) instead of touching the filesystem.
```

`requireEnv("ZS_VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID")` is called by `vcr.ts` only when a build actually runs, so the app still builds without them (b9 §3.2 lazy rule).

### 3.4 `lib/ids.ts`, `lib/ratelimit.ts`, `lib/sandbox-auth.ts`, `lib/sandbox.ts` (*modified*)

```ts
// ids.ts
export type IdPrefix = "ws" | "sb" | "ses" | "con" | "repo" | "pb" | "sec" | "inv" | "img" | "ib";
export function newImageBuildSandboxName(buildId: string): string;   // `ib-${envShort()}-${buildId.slice(4).toLowerCase()}` (buildId is img_…; 3 + 20 chars → fits ^(sb|pb|ib)-[a-z0-9-]{1,60}$)
// ratelimit.ts
export type LimitName = … | "sandbox.image-build" | "user.image-builds" | "repo.image-builds";   // LIMITS: image-build 60/60 (status posts every phase + heartbeat), user.image-builds 5/600 (manual rebuilds), repo.image-builds 20/3600 (EVERY admission path, incl. the push webhook and the create/stale triggers — the manual route is not the only way to start a 4-vCPU builder)
// sandbox-auth.ts (current: `:14-19` two variants, `:68` requireSandbox(req, sandboxName), `:81` rotateSandboxToken({ kind: "workspace" | "prebuild"; id }))
export type SandboxPrincipal =
  | { kind: "workspace"; … } | { kind: "prebuild"; … }
  | { kind: "imageBuild"; build: schema.ImageBuild; repo: schema.Repo; sandboxName: string; tokenGeneration: number };
export async function requireSandbox(req: Request, sandboxName: string, opts?: { kinds?: SandboxPrincipal["kind"][] }): Promise<SandboxPrincipal>;
// `ib-` names resolve image_builds.sandbox_name; 410 sandbox_retired once status ∈ {ready, failed, superseded}; `kinds` defaults to ["workspace","prebuild"], so EVERY existing route keeps its current behaviour and answers 404 not_found for an imageBuild principal without being edited — the manifest, ports, activity, extensions and client-errors routes included. Only git-token, logs and image-build/* pass `kinds: [... , "imageBuild"]`.
export async function rotateSandboxToken(target: { kind: "workspace" | "prebuild" | "imageBuild"; id: string }): Promise<{ token: string; generation: number }>;
// sandbox.ts (current: `:99-114` CreateSandboxInput, `:230-243` runDetached, `:319` persistent: true, `:327-328` snapshot fields)
export interface CreateSandboxInput { …; persistent?: boolean /* default true; the builder passes false */; snapshotExpirationMs?: number /* now optional */; keepLastSnapshots?: number /* now optional; SDK count is 1-10, so "no retention" is expressed by omitting it */ }
// real driver: Sandbox.getOrCreate({ …, persistent: input.persistent ?? true, ...(input.snapshotExpirationMs !== undefined ? { snapshotExpiration: input.snapshotExpirationMs } : {}), ...(input.keepLastSnapshots !== undefined ? { keepLastSnapshots: { count: input.keepLastSnapshots } } : {}) }); fake records all three
// runDetached AND run must forward RunInput.timeoutMs into runCommand — today (`lib/sandbox.ts:230-243`) it is declared on RunInput and silently dropped, so the builder's 45-minute SDK-enforced budget would exist only in the fake while production had none.
export interface CommandStatus { exitCode: number | null; running: boolean }
// SandboxHandle gains commandStatus(cmdId): Promise<CommandStatus> — a NON-BLOCKING read (`Command.exitCode` is `number | null` per command.d.ts:44-79). stepStartBuilder's reuse check needs it: waitCommand(cmdId, ms) blocks and killCommand is destructive, so with only those two there is no way to ask "is the builder I already started still running?".
//
// `persistent: false` and later `get()`: b9's create uses `Sandbox.getOrCreate({ persistent: true })` precisely so a later step can re-`get` the sandbox by name, and this workflow re-gets it from three different function invocations (stepStartBuilder, stepWaitBuilder every 30 s for up to 45 min, stepDeleteBuilder). The SDK doc for `persistent` ("automatic restore of the filesystem between sessions") does not say what it does to name lookup. e2e step 1 verifies `Sandbox.get(name, { resume: false })` on a non-persistent sandbox BEFORE the workflow relies on it; if it does not resolve, the builder falls back to `persistent: true` with `snapshotExpirationMs`/`keepLastSnapshots` omitted and the explicit `stepDeleteBuilder({ deleteSnapshots: true })` as the only hygiene mechanism (§7 item 18).
```

The sandbox-name regex exists in exactly two places on disk — `lib/ids.ts:14` (`SANDBOX_NAME_RE`) and `lib/types.ts:24` (`sandboxNameSchema`, its own inline copy) — and **both** become `^(sb|pb|ib)-[a-z0-9-]{1,60}$`. `lib/api.ts` and `lib/sandbox-auth.ts` contain no copy; editing those two files (as the first revision of this brief said) would have left both real definitions rejecting `ib-` names. CONTRACTS §8.1's id regex `^(ws|repo)_[0-9A-HJKMNP-TV-Z]{20}$` also gains `img` (§3.17).

### 3.5 `lib/github.ts` (*modified*)

```ts
export const DEVCONTAINER_PATHS = [".devcontainer/devcontainer.json", ".devcontainer.json"] as const;
export const DEVCONTAINER_TOUCH = /^\.devcontainer(\.json$|\/)/;    // FLOOR only, used when nothing is stored yet
export function devcontainerTouchMatcher(repo: schema.Repo): (path: string) => boolean;
// The real filter is derived from repos.devcontainerPath + repos.devcontainerConfig: `.devcontainer/**` ∪ `.devcontainer.json` ∪ config.base.dockerfilePath ∪ `${config.base.contextPath}/**`. A constant regex is wrong in both directions: `build.dockerfile: "../Dockerfile.dev"` (two of the six real fixtures use build.dockerfile) never matches `.devcontainer/`, so a push that genuinely changes the image never triggers a rebuild and the drift is only noticed lazily at the next create; and when contextPath is the repo root every push matches. When contextPath resolves to `.`, the matcher does NOT expand to `**` — see §3.7 step 3 for why the whole-tree sha is not part of the identity.
export interface DevcontainerSources { path: DevcontainerPath; raw: string; rawSha: string /* blob sha */; dockerfile: { path: string; raw: string; sha256: string } | null; contextDigest: string | null; revision: string }
export async function fetchDevcontainerSources(installationId: number, owner: string, repo: string, revision: string, parsed?: DevcontainerNormalized): Promise<DevcontainerSources | null>;
// 1. repos.getContent({ owner, repo, path, ref: revision }) for each DEVCONTAINER_PATHS entry in order (404 → next; both 404 → null); base64-decode `content` (files ≤ 1 MiB via this API — a larger devcontainer.json is rejected with invalid_value).
// 2. When `parsed` (from parseDevcontainer on that raw) has build: getContent for parsed.build.dockerfilePath → { raw, sha256 }; contextDigest = contextDigestFor(revision, parsed.base.contextPath).
export async function treeSha(installationId: number, owner: string, repo: string, commitSha: string, repoRelativeDir: string): Promise<string | null>;
// git.getTree({ tree_sha: commitSha }) walks one segment at a time (each answer lists `tree` entries with `sha`; "." → the commit's root tree sha via repos.getCommit → commit.tree.sha); null when a segment is missing
export async function contextDigestFor(installationId: number, owner: string, repo: string, commitSha: string, contextPath: string): Promise<string | null>;
// contextPath deeper than the repo root → treeSha() of that directory (cheap, exact). contextPath === "." (the repo root — which §6.1's own path_confinement case blesses, and which `context: ".."` from `.devcontainer/` resolves to) → NOT the root tree sha: that changes on every commit, so every create at a new revision would admit a fresh 45-minute build for an untouched devcontainer. Instead: sha256 over the sorted `<path>\0<blob sha>` list of the entries a `.dockerignore`-aware walk keeps (git.getTree({ recursive: true }) once, ≤ 100 000 entries), and when the tree is truncated or `.dockerignore` is absent, null + a `context_unpinned` note on the row — the identity then rests on dockerfileSha256 + baseDigests, and context-only changes need a manual rebuild (documented in the repo panel).
export function pushTouchesDevcontainer(payload: { commits?: Array<{ added?: string[]; modified?: string[]; removed?: string[] }>; head_commit?: { added?: string[]; modified?: string[]; removed?: string[] } | null }): boolean | "unknown";
// true when any listed file matches DEVCONTAINER_TOUCH; "unknown" when commits is absent/empty AND head_commit is null (force-push/branch creation) or commits.length >= 2048 (payload cap) — the caller then calls changedFilesBetween
export async function changedFilesBetween(installationId: number, owner: string, repo: string, before: string, after: string): Promise<string[] | null>;   // repos.compareCommitsWithBasehead({ basehead: `${before}...${after}` }).files[].filename (≤ 300 files per page; paginate up to 10 pages; null when `before` is 0000… or the compare 404s → treat as touched)
```

The rule at `b9:501` stands: no installation token enters workflow state; the builder obtains its own via `POST /api/sandboxes/{name}/git-token` (§3.10).

### 3.6 `lib/manifest.ts` (*modified*) and the manifest block

`buildManifest(principal)` fills `devcontainer` from the **workspace's** image build when the workspace was created on a repo image (`workspaces.image_build_id`, §3.7), else from the repo's default-branch summary when the workspace's revision is the default branch head, else `null` (the supervisor then parses the checkout, b8 §3.14, exactly as today). Shape in §4.4. For `pb-` principals the same rule applies with the prebuild's `image_build_id`. `manifest.extensions` for prebuild principals additionally includes `config.zed.extensions` so they land in the snapshot (b8 §3.16 prebuild sequence posts `extension_install_list`, which already unions both — this only makes the manifest self-sufficient).

`workspaces` gains one column (`b9:932-982`): `imageBuildId: text("image_build_id").references(() => imageBuilds.id)` (null on the base image); `prebuilds` likewise `imageBuildId`.

### 3.7 `lib/vcr.ts` and `lib/images.ts`

```ts
// vcr.ts — the only module that talks to api.vercel.com/v1/vcr and mints registry credentials
export function imageRepositoryName(owner: string, name: string): string;
// `zs-workspace-${slug}` where slug = `${owner}-${name}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[._-]+|[._-]+$/g, "") truncated to 40 chars + `-${sha256Hex(owner.toLowerCase() + "/" + name.toLowerCase()).slice(0, 8)}` → ≤ 62 chars, VCR-valid, collision-free across case/renames (b9:922 names it zs-workspace-<owner>-<name>; the hash suffix is the addition)
export function imageTag(contentHash: string, serverBuild: string, attempt: number): string;   // `${contentHash.slice(0,16)}-${serverBuild}` + (attempt ? `-a${attempt}` : "") — a human label. VCR allows 10 000 tags/repository (§2.7), and a per-serverBuild tag is what makes the registry cache of §3.13 hit on a server-build-only rebuild.
export function projectImageRef(repository: string, digest: string): string;   // `${repository}@${digest}` — what Sandbox.create({ image }) takes. NEVER a tag: BUILD-SPEC:433 requires "images are referenced by digest at create", the SDK accepts `repo@sha256:…` (`sandbox.d.ts:142-181`), and a mutable tag is re-pushed by design whenever a forced rebuild reuses a configHash — every existing workspace would silently move onto the new image on its next resume with nothing in `image_builds` to show it.
export function fullImageRef(repository: string, tag: string): string;    // `${vcrRegistryPath()}/${repository}:${tag}` — what docker pushes (a tag is needed to push; the digest is what we then store)
export type VcrImageStatus = "preparing" | "ready" | "unoptimized" | null;
export interface VcrImage { id: string; manifestDigest: string; kind: "attestation" | "index" | "manifest"; platform?: string; arch?: string; sizeInBytes: number; status: VcrImageStatus; tags: string[]; createdAt: string }
export async function getImage(repository: string, imageIdOrDigest: string): Promise<VcrImage | null>;   // GET /v1/vcr/repository/{repository}/images/{digest}?projectId=&teamId= with `Authorization: Bearer ${ZS_VERCEL_TOKEN}`; 404/410 → null; other non-2xx → throws VcrError { status, body }
export async function listImages(repository: string, opts?: { untagged?: boolean }): Promise<VcrImage[]>;   // paginates with nextCursor, limit 100
export async function deleteImage(repository: string, imageId: string): Promise<void>;                     // DELETE /v1/vcr/repository/{repository}/images/{imageId}?projectId=&teamId= — ASSUMED. The published REST docs cover only list and get; only the CLI (`vercel vcr image rm`) is documented. Verifying this against https://openapi.vercel.sh/ is a change-list item, not a "first use" surprise: `stepDeleteVcrImage`, gc's prune loop and §6.4's `prune_keeps_n_and_referenced` are all built on it. Until verified, 404/405 is treated as "not deletable": the row stays `superseded`, the tag stays, and the repo panel shows an operator note (§7 item 4).
export interface RegistryCredential { username: string; password: string; expiresAt: Date | null }
export async function vcrPushCredential(): Promise<RegistryCredential>;
// ZS_VCR_AUTH=token → { username: VERCEL_TEAM_ID, password: ZS_VERCEL_TOKEN, expiresAt: null } (documented form);
// ZS_VCR_AUTH=oidc  → { username: "oidc", password: await getVercelOidcToken(), expiresAt: token exp } (the CLI's form; whether a Function-minted OIDC token is accepted by vcr.vercel.com is §7 item 3 — the integration test flips the default)

// images.ts — every "which image does this repo/revision use?" decision
export type ImageResolution =
  | { kind: "base"; image: string; serverBuild: string; reason: "no_devcontainer" | "parse_error" | "fallback_building" | "fallback_failed" }
  | { kind: "repo"; image: string /* `${repository}@${digest}` — the ref Sandbox.create takes */; digest: string; tag: string /* label only */; serverBuild: string; imageBuildId: string; stale: boolean /* serverBuild !== ZS_SERVER_BUILD_ID */ }
  | { kind: "building"; imageBuildId: string; runId: string | null }
  | { kind: "failed"; imageBuildId: string; error: string };
export type ImageBuildTrigger = (typeof schema.imageBuildTriggerEnum.enumValues)[number];   // "create"|"push"|"manual"|"register"|"stale"|"prebuild" — exported HERE (the pgEnum in §3.2 is the only other declaration; the first revision used this name in three signatures without ever declaring it)
export interface ResolveOpts { admit: boolean; trigger: ImageBuildTrigger; userId?: string | null; allowBase?: boolean; branch?: string | null; thenPrebuildBranch?: string | null }
export async function resolveRepoImage(repo: schema.Repo, revision: string, opts: ResolveOpts): Promise<ImageResolution>;
// Every field but `admit` and `trigger` is optional with a default (`userId: null`, `allowBase: false`, `branch: null`, `thenPrebuildBranch: null`), because the four call sites genuinely differ: the webhook passes `{ admit, trigger: "push", branch, thenPrebuildBranch }` and has no user; the prebuild workflow passes `{ admit, trigger: "prebuild", branch }` and has no user; `POST /api/workspaces` passes `{ admit, trigger: "create", userId, allowBase }`; `POST /api/repos` passes `{ admit, trigger: "register", userId, allowBase: true }`. `branch` and `thenPrebuildBranch` are forwarded verbatim into `admitImageBuild` — without them the `image_builds` row's `branch`/`then_prebuild_branch` columns and `stepStartPrebuildIfWanted` have no source.
// 1. sources = fetchDevcontainerSources(repo.installationId, owner, name, revision) → null ⇒ base (no_devcontainer).
// 2. outcome = parseDevcontainer(...) → !ok ⇒ base (parse_error). The CALLER still gates on repo.allowBaseFallback: `POST /api/workspaces` answers 409 devcontainer_invalid when it is false (§3.10). An org that turned base fallback off did so to keep workspaces off an image with passwordless sudo and our preinstalled tooling; a trailing brace in devcontainer.json must not silently hand them exactly that.
// 3. hash = configHash({ config, dockerfileSha256, contextDigest, baseDigests, serverBuild: ZS_SERVER_BUILD_ID, layerVersion: ZS_LAYER_VERSION }).
//    baseDigests resolves the base `image` and every Feature ref to an OCI digest first (registry manifest HEAD via the anonymous token flow, ≤ 8 refs, 5 s each, cached 10 min in kv). Without it the identity hashes a REFERENCE, not content: five of the six real fixtures pin a mutable tag (`mcr.microsoft.com/devcontainers/javascript-node:1-18-bullseye`) and `featureRef.version` defaults to "latest", so the same configHash would map to a materially different image whenever upstream moved — and nothing would ever notice (BUILD-SPEC:433 "reproducible from a pinned base digest and pinned tool versions" would be false). With it, a moved upstream yields a new hash and an automatic rebuild. A ref that cannot be resolved (registry down, private) → the digest map records `"<ref>": "unresolved"` and the row carries `base_unpinned`; the build still runs.
// 4. live = image_builds WHERE repo_id AND config_hash = hash AND status IN (queued,building,pushing,preparing,ready) → ready ⇒ repo { stale: false }; in flight ⇒ building.
// 5. else: previous = newest ready build for (repo_id, content_hash, dockerfile_sha256, context_digest, base_digests) whose server build is in servedEditorBundles() (ZS_EDITOR_BUNDLES, §3.3; CONTRACTS §12) ⇒ repo { stale: true } and, when admit AND repo.staleBuildCooldownAt is past, enqueue a fresh build (trigger "stale", cooldown stamped) without waiting.
//    NOT `fs.existsSync("public/editor/<build>/build.json")`: public/ is served by the CDN and is not traced into the serverless function bundle (nothing references those paths statically), the path is cwd-relative, and apps/web/public/editor/ holds only .gitkeep. In production that existsSync is false, the stale-reuse path never fires, and every create after a deploy falls through to `building` → 409 for every devcontainer repo. A unit test runs the rule with a cwd that has no public/ directory (§6.2).
// 6. else when admit ⇒ admitImageBuild() ⇒ building; when allowBase ⇒ caller may still create on the base image (b9:1122) — the resolution stays `building` so the caller decides.
export async function admitImageBuild(input: { repo: schema.Repo; revision: string; branch: string | null; trigger: ImageBuildTrigger; userId: string | null; sources: DevcontainerSources; outcome: Extract<ParseOutcome, { ok: true }>; thenPrebuildBranch?: string | null }): Promise<{ build: schema.ImageBuild; runId: string; created: boolean }>;
// withLock(keys.lock(`image-build:${repo.id}:${hash}`), 30_000): reuse the live row if present; else admission control, then INSERT image_builds (status queued, config, warnings, hashes, repository/tag, branch, then_prebuild_branch, attempt) → start(buildDevcontainerImage, [{ imageBuildId }]) → UPDATE workflow_run_id; when trigger ∈ {register, push, manual} and the revision is the default-branch head also UPDATE repos SET image_status='building', image_build_run_id, devcontainer_* summary
// Admission control (nothing above this line limited anything but the manual route, and a 4-vCPU/8 GB VM per push is real money):
//   a. one in-flight build per (repo, branch): a newer revision SUPERSEDES the older in-flight row (status 'superseded', its run cancelled, its builder deleted) instead of racing it — enforced by image_builds_repo_branch_active_idx (§3.2). N pushes in a row therefore cost one builder, not N.
//   b. `repo.image-builds` 20/3600 s and at most ZS_IMAGE_BUILDS_MAX_INFLIGHT_ORG concurrent builds per org across repos → over the cap the row is inserted `queued` with no run and the cron sweep starts it when a slot frees.
//   c. builder vCPU-seconds accrue into usage_ledger in stepDeleteBuilder (BUILD-SPEC §7.10) and the org's spend cap is consulted before (b) — an image build is compute the customer pays for, like a workspace.
export function isStaleServerBuild(build: schema.ImageBuild): boolean;   // build.serverBuild !== ZS_SERVER_BUILD_ID || build.layerVersion !== ZS_LAYER_VERSION
```

`stepPickImage` (`b9:615`, `workflows/steps/db-steps.ts`) is rewritten on top of this: `{ kind: "snapshot" }` for a fresh prebuild whose `imageBuildId` matches the resolution (a prebuild snapshot taken on an older repo image is skipped when a newer ready image exists), else `resolveRepoImage(repo, ws.revision, { admit: false, trigger: "create" })` → `repo` ⇒ `{ kind: "image", image: projectImageRef(repository, digest), serverBuild, imageBuildId }` — **the digest ref, never the tag** — else `{ kind: "image", image: ZS_IMAGE_REF, serverBuild: ZS_SERVER_BUILD_ID }`. `stepReserveWorkspace` already stamps `server_build`/`client_build`; it now takes them from the resolution so a stale-but-served repo image gets `client_build = image.serverBuild` (the bundle that matches it, CONTRACTS §12).

### 3.8 `workflows/steps/image-steps.ts` — `"use step"` functions (retried 3× by default, b9 §3.19)

```ts
export async function stepLoadImageBuild(id: string): Promise<schema.ImageBuild & { repo: schema.Repo }>;   // FatalError("image_build_missing")
export async function stepSetImageBuild(id: string, patch: Partial<schema.ImageBuild>): Promise<void>;
export async function stepFinishImageBuild(id: string, outcome: { ok: true } | { ok: false; error: string }): Promise<void>;
// ALWAYS clears workflow_run_id and repos.image_build_run_id (when it points at this run); on error: status failed, error, finished_at, repos.image_status='failed' + image_error when this build was the default-branch build; on ok nothing else (stepRecordImageReady already wrote the row)
export async function stepCreateBuilderSandbox(id: string): Promise<{ name: string; region: string }>;
// vcpus = clamp(config.hostRequirements?.cpus ?? ZS_BUILDER_VCPUS, ZS_BUILDER_VCPUS, ZS_BUILDER_MAX_VCPUS) rounded to the SDK's 2|4|8 — the github/docs fixture declares memory "16gb" and cpus "4", and 2048 MB per vCPU (§2.5) means a 4-vCPU builder has 8 GB: a Rust/Java Feature stack in 8 GB is the difference between a build and a 45-minute build_timeout with no diagnosis. Sizing the builder from the same hostRequirements §3.12 already parses costs one line.
// sandboxApi().create({ name: build.sandboxName ?? newImageBuildSandboxName(id) (persisted first), region: ZS_DEFAULT_REGION, vcpus, ports: [], timeoutMs: ZS_IMAGE_BUILD_BUDGET_MS + 10 * 60_000, image: requireEnv("ZS_BUILDER_IMAGE_REF"), env: { ZS_SANDBOX_NAME: name, ZS_IMAGE_BUILD_ID: id, ZS_REGION: region }, networkPolicy: "allow-all", tags: { zs: envTag(), ib: id }, persistent: false })
//   — snapshotExpirationMs and keepLastSnapshots are OMITTED (both optional now, §3.4). The earlier `snapshotExpirationMs: 0, keepLastSnapshots: 1` said the opposite of what it meant: the SDK documents `0` as "no expiration" and `keepLastSnapshots` as a retention policy, i.e. "keep a snapshot of the VM that holds the registry login and the checkout, forever".
// image_not_ready (the BUILDER image itself) → RetryableError("builder_image_not_ready", { retryAfter: "30s" }); quota → FatalError("quota")
export async function stepStartBuilder(id: string): Promise<{ cmdId: string }>;
// ORDER MATTERS (steps retry 3× by default, b9 §3.19):
// 1. const build = await load(id); if (build.builderCmdId) { const st = await handle.commandStatus(build.builderCmdId); if (st.running) return { cmdId: build.builderCmdId }; }   // reuse FIRST
// 2. only now: const { token } = await rotateSandboxToken({ kind: "imageBuild", id }); const cred = await vcrPushCredential();
//    Rotating before the reuse check (as the first revision did) means a retry after a transient failure invalidates the token of a builder that is STILL RUNNING: its next image-build/logs POST gets 401, it can no longer report `failed`, and the workflow then blocks for the full 45-minute budget before build_timeout — while a second registry credential was minted for nothing.
// 3. handle = await sandboxApi().get(name, { resume: false }); const { cmdId } = await handle.runDetached({ cmd: "/usr/local/bin/zs-build-devcontainer", args: [], cwd: "/vercel", sudo: false, env: {
//      ZS_CONTROL_URL: controlApiBase(), ZS_SANDBOX_TOKEN: token, ZS_SANDBOX_NAME: name, ZS_IMAGE_BUILD_ID: id,
//      ZS_VCR_USERNAME: cred.username, ZS_VCR_PASSWORD: cred.password, ZS_VCR_REGISTRY: vcrRegistryPath(),
//      ...(VERCEL_AUTOMATION_BYPASS_SECRET ? { ZS_BYPASS_SECRET } : {}) }, timeoutMs: ZS_IMAGE_BUILD_BUDGET_MS });   // timeoutMs only bites once §3.4 forwards it
// 4. UPDATE image_builds SET builder_cmd_id = cmdId, status = 'building', started_at = now
export async function stepWaitBuilder(id: string, cmdId: string, sliceMs: number): Promise<{ exitCode: number | null; phase: string | null; status: ImageBuildStatus }>;   // stepWaitForCommandExit(name, cmdId, sliceMs) + re-read of the row (phase/status written by the status route) — never throws
export async function stepVerifyPushed(id: string): Promise<{ digest: string; sizeInBytes: number; status: VcrImageStatus; imageRef: string }>;
// getImage(build.imageRepository, build.imageDigest): the builder reports the pushed manifestDigest in its final status post (§3.10); the step confirms VCR knows it and that it is OURS:
//   kind === "manifest" (a multi-platform index has status null and never becomes ready), arch === "amd64",
//   AND image.tags includes build.imageTag — the digest existing somewhere in the repository is not enough; this is what ties the digest to the tag WE told the builder to push.
//   Then imageRef = projectImageRef(build.imageRepository, digest), computed here from the ROW, never from the builder's report (§3.10 drops `result.imageRef` from the wire).
//   404 → RetryableError("vcr_not_visible", { retryAfter: "10s" }) up to 3 attempts (registry propagation); other kinds → FatalError("image_kind_" + kind)
// Also runs on the FAILURE path (§3.9 catch): a builder that completed `docker push` and then died leaves a tag nothing references; verifying it there recovers the build instead of orphaning the image.
export async function stepVerifyRegistryLimits(id: string, digest: string): Promise<void>;
// `docker buildx imagetools inspect --format '{{json .Manifest}}'` output is posted by the driver (§3.13 step 8) and re-checked here against VCR's documented COMPRESSED limits (§2.7): every layer ≤ 500 MB, total ≤ 15 GB, manifest ≤ 4 MB, config blob ≤ 1 MB → FatalError("image_too_large:<what>"). The driver's uncompressed guard is a cheap pre-check only: 900 MB of already-compressed content (wheels, tarballs, wasm, model files) passes it and blows the 500 MB compressed cap, and that failure would otherwise surface as a raw registry error mapped to the generic `push` code after ~45 minutes.
export async function stepPollImageReady(id: string): Promise<{ status: VcrImageStatus }>;   // one getImage() call; "unoptimized" → FatalError("image_unoptimized"); never sleeps (the workflow paces with sleep("15s"))
export async function stepRecordImageReady(id: string): Promise<void>;
// transaction: image_builds.status='ready', ready_at, finished_at; supersede older ready rows of the same (repo_id, content_hash, dockerfile_sha256, context_digest) — including the predecessor of a forced rebuild, which is superseded HERE and not at admission (§3.10) AND older rows for the same repo whose server_build ≠ this one and that no workspace references → status 'superseded'; when this build is the default-branch head build (branch = repo.defaultBranch or revision = repo.devcontainerCheckedRevision): repos.image_ref=imageRef, image_digest, image_build=serverBuild, image_config_hash, image_built_at, image_status='ready', image_error=null, devcontainer_hash=contentHash; audit "image.ready"
export async function stepDeleteBuilder(id: string): Promise<void>;   // stepDeleteSandbox(build.sandboxName, { deleteSnapshots: true }) (b9:605; not_found is success); also image_builds.sandbox_token_hash = null (principal retired)
export async function stepStartPrebuildIfWanted(id: string): Promise<{ runId: string | null }>;   // when then_prebuild_branch is set and ∈ repo.prebuildBranches: withLock(`prebuild:${repoId}:${branch}`, 60_000, () => start(prebuild, [{ repoId, branch, commit: build.revision }])) — the same lock and call as b9's webhook (b9:1201), so a concurrent webhook prebuild is not doubled
export async function stepPruneRepoImages(repoId: string): Promise<string[]>;   // keep the ZS_IMAGE_KEEP_PER_REPO newest ready builds + every build referenced by a non-deleted workspace/prebuild; mark the rest superseded and return their image ids; the gc workflow calls vcr.deleteImage for each (§3.9)
export async function stepDeleteVcrImage(repository: string, imageId: string): Promise<void>;   // vcr.deleteImage, 404/405 tolerated (§3.7); called by §3.9 step 10 and by gc.ts
export async function stepReposWithImages(): Promise<string[]>;                                  // repo ids with ≥ 1 ready image_builds row; gc.ts's outer loop
export async function stepResolveImageForPrebuild(prebuildId: string): Promise<ImageResolution>; // resolveRepoImage(repo, pb.commit, { admit: true, trigger: "prebuild", branch: pb.branch, allowBase: true })
export async function stepSetPrebuildStatus(prebuildId: string, status: schema.PrebuildStatus, patch?: { imageRef?: string; imageBuildId?: string }): Promise<void>;
export async function stepReconcileOrphanImages(repoId: string): Promise<number>;                // listImages(repository) → delete tags older than 24 h that match no image_builds row (a builder that pushed and then died leaves one); logs what it deletes
// (These four/five were called by §3.9 and gc.ts in the first revision without ever being declared.)
export async function presignLogUpload(id: string): Promise<{ url: string; pathname: string }>;
// A PLAIN FUNCTION, not a step: the GET /image-build route computes it inline (§3.10), and a second, step-shaped copy would be dead code that can drift from the one the builder actually receives.
// issueSignedToken({ pathname: `image-builds/${id}/build.log`, operations: ["put"], validUntil: +2 h, maximumSizeInBytes: 64 * 1024 ** 2 }) → presignUrl(signedToken, { operation: "put", access: "private" }) (two-argument, §2.5).
// The token must be scoped to that single pathname — a prefix-scoped token would let a compromised builder overwrite `rebuild/<ws>/<ts>.tgz`, which D9 restore extracts at `/` inside a victim workspace. `image-builds/` and `rebuild/` are separate prefixes and the assertion that the token cannot address the latter is part of §6.2.
```

Token scoping model (what the builder gets, and what it never gets):

| Secret | Where it lives | Who can read it |
|---|---|---|
| `ZS_SANDBOX_TOKEN` (`zsb_…`, `imageBuild` principal) | `runCommand` env of the driver only; never `Sandbox.create({ env })` | the driver process; child processes it spawns explicitly (the devcontainer CLI is started with `env -i`, §3.13). Scope: `git-token` for the build's repo (read-only), `logs`, `image-build/*`. Rotated per start (**after** the reuse check), retired at `ready/failed`. |
| Registry credential (`ZS_VCR_USERNAME/PASSWORD`) | `runCommand` env; consumed by `docker login --password-stdin` into **`DOCKER_CONFIG=/var/lib/zs-builder/docker-push`** (0700, builder user) in the first seconds; then `unset` | **only** the `docker tag`/`docker push`/`imagetools` commands of step 8, which are run with that `DOCKER_CONFIG`. The devcontainer CLI and every BuildKit build get `DOCKER_CONFIG=/var/lib/zs-builder/docker-anon` (an empty directory). This is the correction that matters most: `env -i … DOCKER_CONFIG=/vercel/.docker` handed the credential to the process that builds the user's Dockerfile and Features, and BuildKit would then use it for **any** `vcr.vercel.com/…` reference — a repo's devcontainer could `FROM vcr.vercel.com/<team>/<project>/zs-workspace:<build>`, `…/zs-builder:<build>` or `COPY --from=…/zs-workspace-<other-slug>:<tag>` and read our base image, our builder payload and every other tenant's repo image (target names are a pure function of the public owner/name, and the same credential enumerates tags through `/v2/…/tags/list`). It is also push-scoped to the whole project, so any code execution on the builder VM (the `ubuntu` user is in the `docker` group ⇒ docker socket ⇒ root) could overwrite `zs-workspace:<build>` — the image every workspace boots from. Belt and braces: §3.1 rule 4 rejects `vcr.vercel.com` in any user `FROM`/`--from`, and §7 item 3's move to `ZS_VCR_AUTH=oidc` (12 h, project-scoped) shortens the window. Under `ZS_VCR_AUTH=token` it is the team token — §7 item 3. |
| GitHub installation token | fetched by the driver from `POST …/git-token`, used through an in-process `credential.helper` shell function, never written to `.git/config` | the `git fetch` process only; unset after checkout. |
| Control-plane secrets (`ZS_JWT_PRIVATE_KEY`, `ZS_SECRETS_KEYS`, DB, Clerk, Stripe, `ZS_VERCEL_TOKEN` under `oidc`) | never leave the control plane | — |
| The workspace sandbox | receives the pushed image by reference through Vercel (`Sandbox.create({ image })`); no registry credential, no builder token, nothing from the builder VM is copied | — |

The builder sandbox is `persistent: false`, declares no ports (D35, §3.18) and is deleted in `finally`, so nothing outlives a registry login. What this table does **not** claim any more: that `env -i` protects the credential (it did not — the credential was in the `DOCKER_CONFIG` the `env -i` line passed through), and that `dockerd` is started before the credential exists (it is not: §3.13 starts `dockerd` only after the spec fetch and gives it a scrubbed environment, because Vercel's sudoers is documented `Defaults !env_reset` — a `sudo dockerd` started while `ZS_VCR_PASSWORD` and `ZS_SANDBOX_TOKEN` are still exported would carry both in the daemon's process environment for the life of the build).

### 3.9 `workflows/build-devcontainer-image.ts` — `"use workflow"`

```ts
import { sleep, FatalError } from "workflow";
export async function buildDevcontainerImage(input: { imageBuildId: string }): Promise<{ imageRef: string; digest: string }> {
  "use workflow";
  const id = input.imageBuildId;
  try {
    const build = await stepLoadImageBuild(id);                                   // 1
    await stepCreateBuilderSandbox(id);                                           // 2  builder VM from ZS_BUILDER_IMAGE_REF (RetryableError while the builder image prepares)
    const { cmdId } = await stepStartBuilder(id);                                 // 3  rotates the ib token, mints the registry credential, runDetached(zs-build-devcontainer)
    const deadline = Date.now() + ZS_IMAGE_BUILD_BUDGET_MS;                       //    Date.now() is replay-safe in Workflow DevKit (b9:1314)
    for (;;) {                                                                    // 4  wait on the builder's own exit (D13 spirit: no fixed sleeps beyond pacing)
      const w = await stepWaitBuilder(id, cmdId, 30_000);
      if (w.exitCode !== null) { if (w.exitCode !== 0) throw new FatalError(`builder_exit:${w.exitCode}:${w.phase ?? "unknown"}`); break; }
      if (w.status === "failed") throw new FatalError(`builder_reported:${w.phase ?? "unknown"}`);   // the driver posted failed and is exiting
      if (Date.now() > deadline) throw new FatalError(`build_timeout:${w.phase ?? "unknown"}`);
    }
    await stepDeleteBuilder(id);                                                  // 5  the credential-bearing VM goes away before we wait on VCR
    const pushed = await stepVerifyPushed(id);                                    // 6  VCR knows the digest; kind manifest, arch amd64, tag ours; imageRef computed server-side
    await stepVerifyRegistryLimits(id, pushed.digest);                            // 6b compressed layer/total/manifest/config limits (§2.7)
    await stepSetImageBuild(id, { status: "preparing", imageDigest: pushed.digest, imageSizeBytes: pushed.sizeInBytes });
    const readyBy = Date.now() + ZS_IMAGE_READY_BUDGET_MS;
    for (;;) {                                                                    // 7  readiness = documented VCR status, polled every 15 s (BUILD-SPEC:535)
      const r = await stepPollImageReady(id);
      if (r.status === "ready") break;
      if (Date.now() > readyBy) throw new FatalError("image_ready_timeout");
      await sleep("15s");
    }
    await stepRecordImageReady(id);                                               // 8  image_builds ready, repos summary, supersede
    await stepStartPrebuildIfWanted(id);                                          // 9  chain (BUILD-SPEC 6.4)
    for (const imageId of await stepPruneRepoImages(build.repoId)) await stepDeleteVcrImage(build.imageRepository, imageId);   // 10 keep N newest ready images per repo
    await stepFinishImageBuild(id, { ok: true });
    return { imageRef: pushed.imageRef, digest: pushed.digest };                  // 11 from step 6, NOT from the row loaded at step 1: `build.imageRef` is null at load time (it is written by the pushed report), so `build.imageRef!` returned undefined or threw.
  } catch (e) {
    try { const late = await stepVerifyPushed(id); await stepRecordImageReady(id); await stepFinishImageBuild(id, { ok: true }); return { imageRef: late.imageRef, digest: late.digest }; } catch { /* genuinely not pushed */ }
    await stepDeleteBuilder(id);                                                  // idempotent (not_found is success); a failed build never leaves a VM billing
    await stepFinishImageBuild(id, { ok: false, error: String(e) });
    throw e;
  }
}
```

`stepDeleteVcrImage`, `stepReposWithImages`, `stepResolveImageForPrebuild` and `stepSetPrebuildStatus` are declared in §3.8 (the first revision called all four without declaring any). `"buildDevcontainerImage"` is added to `LifecycleWorkflowName` **and** to `WORKFLOW_MODULES` in `lib/lifecycle.ts:20-39`, which is what makes `stepRunChild` (`workflows/steps/child-steps.ts:15`) able to name it.

Failure states shown to the dashboard come from `image_builds.error` (`builder_exit:<code>:<phase>`, `builder_reported:<phase>` with the driver's `error` text stored by the status route, `image_unoptimized`, `image_ready_timeout`, `quota`) and `repos.image_error` for the default branch. Driver exit codes (§3.13): 10 clone, 11 devcontainer parse/read-configuration, 12 devcontainer build, 13 layer build, 14 size limit, 15 push, 16 dockerd, 2 config.

Other workflow edits (`b9:1405-1419`, `:1421-1432`):

- `prebuild.ts`: after `stepCreatePrebuildRow`, `const img = await stepResolveImageForPrebuild(pb.id)` (`resolveRepoImage(repo, commit, { admit: true, trigger: "prebuild", allowBase: true })`); `building` ⇒ `await stepRunChild("buildDevcontainerImage", { imageBuildId })` then re-resolve; `repo` ⇒ `stepSetPrebuildStatus(pb.id, "queued", { imageRef: img.image, imageBuildId })`; `failed`/`base` ⇒ base image (a prebuild on the base image is still useful). `stepRunChild`'s name union (`b9:628`) gains `"buildDevcontainerImage"`.
- `gc.ts`: `for (const r of await stepReposWithImages()) { for (const imageId of await stepPruneRepoImages(r)) await stepDeleteVcrImage(...); await stepReconcileOrphanImages(r); }`; and delete `image-builds/<id>/build.log` blobs older than 30 days (`stepDeleteBlob`). The reconciliation pass is why `listImages` exists: a builder that dies between a successful `docker push` and its `pushed` report leaves a tag no `image_builds` row references, and a row-only walk can never see it.

### 3.10 Route handlers

| File | Exports and contract |
|---|---|
| `app/api/sandboxes/[name]/image-build/route.ts` (new) | `GET` → `requireSandbox(req, name, { kinds: ["imageBuild"] })` → 200 `ImageBuildSpec` (§4.6): the build row's config, sources paths, hashes, image names, the layer parameters, limits and a fresh `logUploadUrl` from the shared `presignLogUpload(id)` (§3.8 — one implementation, not a step-shaped duplicate); limit `sandbox.image-build`. `POST` body `ImageBuildStatusReport` (§4.6) → 204: updates `phase`; `phase: "failed"` sets `status='failed', error` (the workflow reads it on the next poll); `phase: "pushed"` stores `imageDigest` and `imageSizeBytes` **only** — `imageRef` is not accepted on the wire (§4.6) and is recomputed from `build.imageRepository` + the verified digest in `stepVerifyPushed`. The report comes from a VM that has just executed user-controlled Dockerfiles and Feature scripts; a ref taken from it would flow through `repos.image_ref` → `stepPickImage` → `Sandbox.create({ image })`, so a buggy or compromised builder reporting `zs-builder:<build>` or another tenant's repository would get that image booted for the victim's workspaces. `phase: "done"` is informational; a report for a build that is no longer `building` → 409 `build_not_active`. |
| `app/api/sandboxes/[name]/git-token/route.ts` (*modified*) | accepts `imageBuild` principals; scope `repositoryIds: [repo.githubRepoId]`, `permissions: { contents: "read" }` (read-only, unlike the workspace's write token); audit `git_token.issue` with `principal: "image_build"`. |
| `app/api/sandboxes/[name]/logs/route.ts` (*modified*) | accepts `imageBuild` principals; the `source` enum gains **`builder`** (the driver) and **`services`** (the supervisor's dockerd service, §3.16) — CONTRACTS §7.6's list (`CONTRACTS.md:453`) has neither today, so §3.17 amends it or both batches are rejected as `invalid_body`. `LogBatch`'s required `workspaceId`/`sessionId`/`build` are undefined for an `ib-` principal, which has no workspace, manifest or session: for that principal they are `workspaceId = repoId`, `sessionId = buildId`, `build = ZS_SERVER_BUILD_ID`, recorded in the same amendment. Drop policy: `docker build` output exceeds §7.6's 200 lines/s per source by an order of magnitude, so the driver's flusher counts drops and sets `fields.dropped`/`truncated`; the full transcript is the uploaded `build.log`, not the log stream. |
| `app/api/repos/[id]/image-builds/route.ts` (new) | `GET` → 200 `{ builds: ImageBuildView[] }` (newest 20; view in §4.7). `POST { ref?: { branch } \| { revision }, force?: boolean }` → 202 `{ build: ImageBuildView, runId }` (manual rebuild: `resolveRepoImage(..., { admit: true, trigger: "manual", userId })`; `force: true` starts a new **attempt** of the same `configHash` (a distinct `image_tag`, §3.2) and **leaves the existing ready row alone**; `stepRecordImageReady` supersedes the predecessor only once the replacement is `ready`. Superseding first — as the first revision did — is a live downgrade: `resolveRepoImage` step 4 matches only `queued|building|pushing|preparing|ready` and step 5 only *ready* rows, so from the supersede until the rebuild reports ready (and permanently if it fails) the repo resolves to `building` then `failed`, every new workspace gets a 409 or silently drops to the base image, and a perfectly good image sits unused in the registry; 200 `{ build }` when a live build already exists; 400 `no_devcontainer` / `devcontainer_invalid { error, warnings }`; rate `user.image-builds`; `requireViewer` + repo access (b9's repo access check from `POST /api/repos/{id}/prebuilds`). |
| `app/api/repos/[id]/image-builds/[buildId]/log/route.ts` (new) | `GET` → 303 to a presigned **get** URL of `log_blob_pathname` (1 h) or 404 `log_unavailable`. |
| `app/api/repos/route.ts` (*modified*, `POST`) | after registering the row: `resolveRepoImage(repo, defaultBranchHeadSha, { admit: true, trigger: "register", userId, allowBase: true })` (b9:1154 says the POST "refreshes … devcontainer hash" — this is where it happens); the response `RepoView` gains `devcontainer: DevcontainerSummary` (§4.7). `GET /api/repos` stays exactly what b9 defines (`b9:1153`: the installation/repo list **live from GitHub**, cached 60 s in kv per user); the only change is that each `RepoView` carries the `devcontainer` summary from the `repos` row, so that sub-object costs no extra GitHub call. |
| `app/api/workspaces/route.ts` (*modified*, `POST`) | `createWorkspaceInput` gains `allowBase: z.boolean().default(false)`. After ref resolution: `resolveRepoImage(repo, sha, { admit: true, trigger: "create", userId, allowBase })` → `building` ⇒ when `allowBase && repo.allowBaseFallback` continue on the base image with `state_reason = "devcontainer_pending"` (the workspace detail page offers "Rebuild on the repo image" once it is ready), else 409 `{ error: { code: "image_building", message, details: { imageBuildId, runId, phase } } }` (b9:1122 shape kept, details added); `failed` ⇒ same rule with code `image_failed` and `details.error`; `base` with `reason: "parse_error"` ⇒ **also** gated on `repo.allowBaseFallback`, answering 409 `devcontainer_invalid { error, warnings }` when it is false (a broken devcontainer.json must not be a way around the org's policy); `repo` ⇒ `stepReserveWorkspace` records `image_ref = image`, `server_build`, `client_build = serverBuild`, `image_build_id`. |
| `app/api/workspaces/[id]/rebuild/route.ts` (*modified*) | `{ fromImage?: boolean }` keeps b9's semantics; `rebuildWorkspace`'s `stepBumpGeneration` (b9:618) re-resolves the image through `resolveRepoImage(repo, ws.revision, { admit: true, trigger: "create", … })` so "Rebuild" after an image build moves the workspace onto the repo image (`409 image_building` if it is still building and `fromImage` was requested). |
| `app/api/webhooks/github/route.ts` (*modified*, `push`) | `const touched = pushTouchesDevcontainer(payload); const t = touched === "unknown" ? (await changedFilesBetween(...))?.some(DEVCONTAINER_TOUCH.test) ?? true : touched;` then: `if (t) { withLock(keys.lock(\`image-build-webhook:${repoId}:${b}\`), 60_000, () => resolveRepoImage(repo, after, { admit: true, trigger: "push", branch: b, thenPrebuildBranch: b ∈ repo.prebuildBranches ? b : null })) } else if (b ∈ repo.prebuildBranches) { …b9's existing prebuild start… }`. Only pushes to `repo.defaultBranch` or to a branch in `prebuildBranches` trigger builds (other branches build lazily at create). A push that deletes the devcontainer (`removed` matches) resets the default-branch summary to `devcontainer_path = null`, `image_status = 'none'` (existing images stay for existing workspaces). |
| `app/api/cron/sweep/route.ts` (*modified*, step 1) | dead-run reconciliation (b9:1459-1466) also covers `image_builds` rows with `workflow_run_id` set: terminal/unknown or older than `ZS_IMAGE_BUILD_BUDGET_MS + ZS_IMAGE_READY_BUDGET_MS + 15 min` → `stepVerifyPushed` first (recover a build whose push landed before the run died), else `status = 'failed', error = run_<status>` and the `sandbox_name` VM deleted through the route-context plain function behind `stepDeleteBuilder`. Step 2: start the oldest `queued` row with no run whenever the org's in-flight count is below `ZS_IMAGE_BUILDS_MAX_INFLIGHT_ORG` (the queue admission of §3.7). |

### 3.11 Trigger matrix (what starts a build and what the caller sees)

| Trigger | Where | Revision | Waits? | Result to the caller |
|---|---|---|---|---|
| `register` | `POST /api/repos` | default-branch head | no | `RepoView.devcontainer.image.status = building` |
| `create` | `POST /api/workspaces` | the requested ref's sha | no | 409 `image_building { runId }` (dashboard polls `GET /api/repos/{id}/image-builds`), or base image with `devcontainer_pending` when `allowBase` |
| `push` | webhook, default branch / prebuild branches, `.devcontainer/**` touched | `after` | no | chained prebuild when the branch is a prebuild branch |
| `manual` | `POST /api/repos/{id}/image-builds` | branch head / revision | no | 202 `{ runId }` |
| `stale` | `resolveRepoImage` at create when `serverBuild ≠ ZS_SERVER_BUILD_ID`, the old bundle is still in `servedEditorBundles()`, **and** `repos.stale_build_cooldown_at` has passed | the requested sha | no; the workspace is created on the stale image | workspace detail shows "Image built for an older server build — rebuild when ready" (`stateReason` unchanged; `WorkspaceView.image.stale = true`) |
| `prebuild` | `prebuild` workflow | the prebuild commit | **yes** (child run) | prebuild proceeds on the new image |

### 3.12 Dashboard (`app/(site)/(dashboard)/…`, *modified*)

- `repos/[id]/page.tsx`: "Development container" panel — path, parse status (`ok`/`error` with message), warnings list (unsupported keys, dropped features, ignored port keys), image status pill (`none/building/preparing/ready/failed/stale`; `preparing` and `stale` are derived in the view, §3.2), the repo-declared extensions with an "allow for this repository" opt-in and the dropped-settings warnings (§3.1 rule 9), tag and digest (short), built-at, "Rebuild image" button (`POST image-builds`, disabled while a live build exists), build history table (trigger, revision short, status, duration, "log" link → `/log` route), and the org policy toggle `allowBaseFallback`.
- `workspaces/new/page.tsx` (create flow, BUILD-SPEC:379 "devcontainer detection"): after branch selection the page calls `GET /api/repos/{id}` (summary) and shows one of: "No devcontainer — base image", "devcontainer detected — image ready (tag)", "devcontainer detected — image building (progress phase) — you can wait or create on the base image" (checkbox `allowBase`), "devcontainer failed — details — create on the base image". `hostRequirements.cpus` ≥ 4 preselects `vcpu4`, ≥ 8 `vcpu8` (never above the plan's allowed machines). On `409 image_building` the page polls `GET /api/repos/{id}/image-builds` every 10 s and re-submits when the build is `ready`.
- `workspaces/[id]/page.tsx`: banner when `WorkspaceView.image.stale` or `stateReason === "devcontainer_pending"` with a "Rebuild on the current image" action (`POST /rebuild { fromImage: true }`).
- `WorkspaceView` (b9:1124) gains `image: { kind: "base" | "repo"; ref: string; serverBuild: string; stale: boolean; imageBuildId: string | null }`.

### 3.13 Builder image and driver — `sandbox/image/builder/`

`sandbox/image/builder/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.7
# Built by sandbox/image/build-builder.sh right after the workspace image of the same ZS_BUILD_ID; WORKSPACE_IMAGE is the just-pushed digest ref from sandbox/image/dist/image.json.
ARG WORKSPACE_IMAGE
FROM ${WORKSPACE_IMAGE}
ARG DEVCONTAINER_CLI_VERSION=0.89.0
ARG ZS_BUILD_ID                      # declared, because build-builder.sh passes --build-arg ZS_BUILD_ID; without this line the arg is silently unconsumed and ${ZS_BUILD_ID} below resolves from the inherited image ENV instead
USER root
ENV HOME=/root
# docker.io, docker-buildx, docker-compose-v2 are already in the workspace image (b8 §3.19 layer 1); the builder only adds the CLI, the driver and the layer payload.
RUN npm install -g --no-fund --no-audit --prefix /usr/local "@devcontainers/cli@${DEVCONTAINER_CLI_VERSION}" && npm cache clean --force && rm -rf /root/.npm
RUN usermod -aG docker ubuntu \
 && install -d -o ubuntu -g ubuntu /var/lib/zs-builder /opt/zs/layer/bin \
 && cp /usr/local/bin/zed-remote-server /usr/local/bin/zs-agent /opt/zs/layer/bin/ \
 && test -n "${ZS_BUILD_ID}" && test "${ZS_BUILD_ID}" = "$(printenv ZS_BUILD_ID)" \
 && printf '%s\n' "${ZS_BUILD_ID}" > /opt/zs/layer/BUILD_ID \
 && printf '%s\n' "@@LAYER_VERSION@@" > /opt/zs/layer/LAYER_VERSION
COPY --chmod=0755 sandbox/image/builder/zs-build-devcontainer.sh /usr/local/bin/zs-build-devcontainer
COPY --chmod=0755 sandbox/image/builder/layer/zs-layer-fixup.sh /opt/zs/layer/zs-layer-fixup.sh
COPY sandbox/image/builder/layer/Dockerfile.zs-layer.tmpl /opt/zs/layer/Dockerfile.zs-layer.tmpl
# dockerd data on the sandbox disk (32 GB, SCOPE.md:110); the builder VM is never snapshotted
RUN install -d -m 0711 /var/lib/docker && printf '{ "storage-driver": "overlay2", "features": { "buildkit": true } }\n' > /etc/docker/daemon.json
ENV HOME=/vercel ZS_LAYER_DIR=/opt/zs/layer
USER ubuntu
WORKDIR /vercel
```

The builder embeds the exact `zed-remote-server`/`zs-agent` of its `ZS_BUILD_ID` (copied from the workspace image it is built from), and `ZS_BUILDER_IMAGE_REF`/`ZS_SERVER_BUILD_ID` are set together by the deploy (CONTRACTS §12 row for `ZS_IMAGE_REF`). **That equality is enforced, not assumed**: the binaries come from `/opt/zs/layer/bin` in the builder image while `spec.layer.serverBuild` comes from the control plane, and any drift — a rolled-back deploy, a preview pinned to the previous builder, a half-applied env change — would otherwise produce a repo image that *advertises* a build id it does not contain. CONTRACTS §12 then bites in the worst place: `serve --client-build` is fed from the image `ENV`, so clients get close code 4002, or `waitUntilReady` fails `FatalError build_mismatch` after a 35-minute boot. So: the driver's step 0 compares `cat /opt/zs/layer/BUILD_ID` with `spec.layer.serverBuild` and `cat /opt/zs/layer/LAYER_VERSION` with `spec.layer.version`, exiting 2 (`errorCode: "config"`) on either mismatch, and §4.5 renders `@@ZS_BUILD_ID@@` **from the file on disk**, not from the spec. No Vercel CLI, no toolchain additions.

`sandbox/image/build-builder.sh`: `ZS_BUILD_ID=… sandbox/image/build-builder.sh [--push]` → reads `sandbox/image/dist/image.json` (`digest`), `docker buildx build --platform linux/amd64 -f sandbox/image/builder/Dockerfile --build-arg WORKSPACE_IMAGE="vcr.vercel.com/$VERCEL_TEAM_SLUG/$VERCEL_PROJECT_SLUG/zs-workspace@<digest>" --build-arg ZS_BUILD_ID --provenance=false --sbom=false [--push -t …/zs-builder:<build>] .`, then the same REST readiness poll as §3.8 (`scripts/vcr-wait-ready.mjs`, a 40-line Node script using `ZS_VERCEL_TOKEN`) and writes `sandbox/image/dist/builder.json { tag, digest, build }`. `.github/workflows/sandbox-image.yml` (`b8:1330-1347`) gains, after `build.sh --push`: `- run: ZS_BUILD_ID=… sandbox/image/build-builder.sh --push` and uploads `builder.json`; the web deploy sets `ZS_BUILDER_IMAGE_REF=zs-builder@sha256:…` next to `ZS_IMAGE_REF`.

`sandbox/image/builder/zs-build-devcontainer.sh` (bash, `set -euo pipefail`, ~250 lines; every phase posts a status and ships its log lines):

```
0. env: ZS_CONTROL_URL ZS_SANDBOX_TOKEN ZS_SANDBOX_NAME ZS_IMAGE_BUILD_ID ZS_VCR_USERNAME ZS_VCR_PASSWORD ZS_VCR_REGISTRY [ZS_BYPASS_SECRET]; missing → exit 2.
   api() = curl -fsS -H "Authorization: Bearer $ZS_SANDBOX_TOKEN" [-H "x-vercel-protection-bypass: $ZS_BYPASS_SECRET"] "$ZS_CONTROL_URL/sandboxes/$ZS_SANDBOX_NAME/$1" …
   report() = api image-build -X POST -d '{"phase":"…","message":"…", …}'; log() = tee -a /var/lib/zs-builder/build.log + batched POST …/logs {"entries":[{ts,level,source:"builder",msg}]} every 5 s / 200 lines (a background flusher; CONTRACTS §7.6 caps)
   trap: on any error → report failed {errorCode from the phase's exit code}; on EXIT → scrub then upload build.log to $LOG_UPLOAD_URL (PUT, from the spec), flush logs.
   scrub before upload: sed -E over $ZS_VCR_PASSWORD, $ZS_SANDBOX_TOKEN, `ghs_[A-Za-z0-9]+`, `zsb_[A-Za-z0-9]+`, `[Bb]earer [A-Za-z0-9._-]+`, `x-access-token:[^@]*@` → `***`. The blob PUT bypasses CONTRACTS §7.6's `scrub` entirely (that runs on the logs route), and this file is served straight back to the user through the /log 303: a `docker login` diagnostic, a Feature that prints its environment or a `RUN env` in a user Dockerfile would otherwise be stored verbatim.
1. spec FIRST: SPEC=$(api image-build)  (ImageBuildSpec §4.6) → jq into shell vars; write $SPEC to /var/lib/zs-builder/spec.json (0600); LOG_UPLOAD_URL is now set. Verify /opt/zs/layer/BUILD_ID == spec.layer.serverBuild and /opt/zs/layer/LAYER_VERSION == spec.layer.version, else exit 2 (config).
   (Fetching the spec before starting dockerd is deliberate: a dockerd failure — exit 16, the one failure class a user cannot debug from outside — used to happen before LOG_UPLOAD_URL existed, so exactly that log was lost and /log answered 404 log_unavailable.)
2. phase dockerd: env -u ZS_VCR_PASSWORD -u ZS_VCR_USERNAME -u ZS_SANDBOX_TOKEN sudo -n dockerd >/var/log/dockerd.log 2>&1 & ; until docker info >/dev/null 2>&1 (as ubuntu, group docker); 60 s → exit 16.
   (Vercel's sudoers is documented `Defaults !env_reset` — the sudo'd command "inherits all other environment variables that were set" — so a plain `sudo dockerd` would carry the registry password and the sandbox bearer token in the daemon's process environment for the whole build. The explicit `env -u` is the whole mitigation; the login below then happens after dockerd is up.)
3. docker login, into a dedicated config dir: install -d -m 0700 /var/lib/zs-builder/docker-push /var/lib/zs-builder/docker-anon; printf '%s' "$ZS_VCR_PASSWORD" | DOCKER_CONFIG=/var/lib/zs-builder/docker-push docker login vcr.vercel.com --username "$ZS_VCR_USERNAME" --password-stdin; unset ZS_VCR_PASSWORD ZS_VCR_USERNAME. Only steps 6 (cache export) and 8 use `docker-push`; every command that touches user content uses `docker-anon`, which contains no credential.
4. phase clone: T=$(api git-token -X POST -d '{"host":"github.com","protocol":"https","path":"<owner>/<name>.git"}' | jq -r .token)
   git -c credential.helper='!f() { printf "username=x-access-token\npassword=%s\n" "$GIT_TOKEN"; }; f' -c credential.useHttpPath=true clone --no-checkout --filter=blob:none "$CLONE_URL" /var/lib/zs-builder/src  (GIT_TOKEN exported only for this command); git -C src fetch --depth 1 origin "$REVISION"; git -C src checkout --detach FETCH_HEAD (blobless partial clone keeps the checkout small; the CLI reads the tree, not history); unset GIT_TOKEN; git -C src config --unset credential.helper || true. Failure → exit 10.
5. phase devcontainer_build:
   - write /var/lib/zs-builder/devcontainer.json = spec.devcontainer.effective (the control plane's SANITISED config: unsupported keys removed, features filtered, ${localEnv} pre-resolved, initializeCommand removed, build.dockerfile/context rewritten to paths relative to this file's directory — it is placed in src/<dir of the original> as devcontainer.zs.json so relative paths resolve unchanged)
   - env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/vercel DOCKER_CONFIG=/var/lib/zs-builder/docker-anon DOCKER_BUILDKIT=1 BUILDKIT_SYNTAX=docker/dockerfile:1.7 devcontainer build --workspace-folder src --config src/<dir>/devcontainer.zs.json --image-name "zs-dc-stage:$TAG" --platform linux/amd64 --log-level info --skip-persisting-customizations-from-features --omit-syntax-directive --cache-from "type=registry,ref=$ZS_VCR_REGISTRY/$REPOSITORY:cache-$CONTENT16" --cache-to "type=registry,mode=max,ref=$ZS_VCR_REGISTRY/$REPOSITORY:cache-$CONTENT16"
     (DOCKER_CONFIG is the EMPTY dir: `env -i` is not what isolates the credential — passing the credential-bearing config dir through it was the leak. `--omit-syntax-directive` + a pinned BUILDKIT_SYNTAX stop a `# syntax=<attacker-image>` line in a user Dockerfile from downloading and executing an arbitrary BuildKit frontend with the daemon's privileges. The cache flags are what make a rebuild affordable: the builder is a fresh VM per build and `serverBuild`/`layerVersion` are inputs to configHash, so without them every deploy is a cold 45-minute rebuild of every repo's full Feature stack; VCR allows 10 000 tags per repository. The cache ref is keyed on contentHash, so it survives a server-build-only rebuild — which then rebuilds only our ~30 MB layer.)
     `--no-lockfile` is NOT passed: the CLI's lockfile is one of the two ways (with §3.7 step 3's `baseDigests`) that a Feature ref resolves to something immutable; the lockfile is written into the build dir, posted with the `pushed` report and stored on the row.
   - failure → exit 12 (the CLI's stderr is the user-facing error in the log)
6. phase layer_build: render Dockerfile.zs-layer.tmpl with STAGE_IMAGE=zs-dc-stage:$TAG, CONTAINER_ENV lines (from spec, values single-quoted through printf %q → Dockerfile ENV key="value" with JSON escaping done by the control plane into spec.layer.envLines), ZS_BUILD_ID, CONFIG_HASH, REPO, LAYER_VERSION, START_DOCKERD → /var/lib/zs-builder/layer/Dockerfile; cp -r $ZS_LAYER_DIR/{bin,zs-layer-fixup.sh} layer/
   docker buildx build --platform linux/amd64 --provenance=false --sbom=false --load -t "zs-dc-final:$TAG" -f layer/Dockerfile layer/   → exit 13 on failure
7. phase size_check (CHEAP PRE-CHECK, uncompressed): docker image inspect --format '{{.Size}}' ≤ spec.limits.imageMaxBytes (6 GB default — the sandbox disk is 32 GB and must hold the pulled base, the devcontainer stage, the final image and the BuildKit cache at once, so a 12 GB ceiling was unreachable and ENOSPC would surface as an opaque exit 12/13 long before image_too_large); docker history per-layer guard (b8 §3.21 awk) with spec.limits.layerMaxUncompressedBytes (900 MB) → exit 14 with message "layer <n> is <size>: split it or slim the base". This does not replace VCR's COMPRESSED limits: those are checked after push (step 8 and stepVerifyRegistryLimits), because 900 MB of already-compressed content passes an uncompressed guard and still blows the 500 MB compressed cap
8. phase push: docker tag zs-dc-final:$TAG "$ZS_VCR_REGISTRY/$REPOSITORY:$TAG"; DIGEST=$(docker push "$ZS_VCR_REGISTRY/$REPOSITORY:$TAG" | sed -n 's/.*digest: \(sha256:[0-9a-f]*\).*/\1/p' | tail -1); [ -n "$DIGEST" ] || DIGEST=$(docker buildx imagetools inspect "$ZS_VCR_REGISTRY/$REPOSITORY:$TAG" --format '{{json .Manifest.Digest}}' | tr -d '"') (both with DOCKER_CONFIG=/var/lib/zs-builder/docker-push); MANIFEST=$(docker buildx imagetools inspect "$ZS_VCR_REGISTRY/$REPOSITORY:$TAG" --format '{{json .Manifest}}') — gzip-compressed classic push (VCR accepts gzip; zstd via --output type=image needs the docker-container driver, which cannot see the local stage image — §7 item 5); exit 15 on failure. Push stderr matching the registry's size errors maps to errorCode image_too_large, not the generic push.
   report pushed {digest, sizeBytes, manifest: MANIFEST, lockfile} — NO imageRef: the control plane recomputes it from the row (§3.10) and re-checks the manifest's compressed layer sizes, total, manifest and config-blob limits against §2.7 (stepVerifyRegistryLimits)
9. report done; docker logout vcr.vercel.com; exit 0
```

`sandbox/image/builder/layer/zs-layer-fixup.sh` (runs as root inside the layer build; idempotent; the source of truth for what "our layer" means; `ZS_LAYER_VERSION` bumps when it changes):

```
1. . /etc/os-release; case "$ID $ID_LIKE" in *debian*|*ubuntu*) PM=apt;; *fedora*|*rhel*|*centos*) PM=dnf;; *) echo "zs: unsupported base ($ID)"; exit 90;; esac
2. packages (only if missing): git bash sudo ca-certificates curl tar gzip procps openssl  (apt-get update && install --no-install-recommends; dnf install -y; clean caches)
3. user: U=$(getent passwd 1000 | cut -d: -f1); if [ -z "$U" ]; then groupadd -g 1000 ubuntu 2>/dev/null || groupadd ubuntu; useradd -m -u 1000 -g 1000 -s /bin/bash ubuntu; U=ubuntu; fi; usermod -s /bin/bash "$U"
4. home: OLDHOME=$(getent passwd 1000 | cut -d: -f6); [ "$OLDHOME" = /vercel ] || { install -d -o "$U" -g "$(id -gn "$U")" /vercel; usermod -d /vercel -m "$U" 2>/dev/null || { [ -d "$OLDHOME" ] && cp -a "$OLDHOME/." /vercel/ 2>/dev/null; usermod -d /vercel "$U"; }; [ -e "$OLDHOME" ] || ln -s /vercel "$OLDHOME"; }; chown -R "$U": /vercel   (OLDHOME is assigned here — it was referenced without assignment in the first revision. D9/CONTRACTS §11: HOME=/vercel is not negotiable; dotfiles Features wrote into the old home, so it is moved along and a symlink is left behind for images that hard-code /home/<user> in scripts, §7 item 2)
5. sudoers: printf 'Defaults always_set_home\nDefaults !env_reset\nDefaults !fqdn\n%s ALL=(ALL) NOPASSWD:ALL\n' "$U" > /etc/sudoers.d/sandbox; chmod 0440 (mirrors vercel/sandbox images/ubuntu)
6. workspaces: install -d -o "$U" -g "$(id -gn "$U")" /workspaces; git config --system credential.helper '!zs-agent credential'; git config --system credential.useHttpPath true; git config --system safe.directory '*'; git config --system init.defaultBranch main (CONTRACTS §11:613)
7. binaries already copied to /usr/local/bin by the layer Dockerfile; sanity: /usr/local/bin/zed-remote-server --version && ZS_BUILD_ID="$ZS_BUILD_ID" /usr/local/bin/zs-agent version (both static musl — run on any glibc/musl base). ZS_BUILD_ID is passed to this RUN as a build ARG because `zs-agent version` prints it (CONTRACTS §7.1 `version` row) and the image `ENV` block is emitted AFTER this step in §4.5 — without the ARG the sanity check would print an empty build id
8. echo "$U" > /etc/zs/user; [ "$START_DOCKERD" = 1 ] && { command -v dockerd >/dev/null || echo "zs: docker-in-docker requested but dockerd missing after Feature install" >&2; usermod -aG docker "$U" 2>/dev/null || true; }
9. rm -rf /var/lib/apt/lists/* /var/cache/dnf
```

`Dockerfile.zs-layer.tmpl` is the text `renderLayerDockerfile` emits (§4.5); the driver substitutes with `envsubst`-free `sed` on `@@VAR@@` markers so no shell expansion touches user values.

### 3.14 Layering decision (user image as base, our layer on top) — why

Two directions were on the table (BUILD-SPEC:311 says "layered on our base"):

- **A. Our base under, user's Dockerfile on top.** For `image:` configs (five of the six real-world fixtures, §2.7) there is no Dockerfile to run on top of our base — the user's image *is* a rootfs; merging it into ours (`COPY --from=<user-image> / /`) overwrites `/etc`, `/usr`, users and libc and is unsupportable. For `build.dockerfile` configs it means rewriting the user's `FROM` to our image, which changes every `apt`/glibc/toolchain assumption their Dockerfile makes (github/docs pins `javascript-node:dev-24-bullseye@sha256:…`; deno pins `devcontainers/rust:1`).
- **B. User's image/Dockerfile (+ Features, via the devcontainer CLI) as the base, our supervisor+server layer on top** (chosen). The Vercel images doc imposes no base requirement (§2.7: "Define the Linux distribution … in a Dockerfile"); our runtime needs are two static musl binaries plus `git bash sudo ca-certificates curl tar gzip` and a uid-1000 user homed at `/vercel` — all of which `zs-layer-fixup.sh` guarantees in one ≈ 30 MB layer on Debian/Ubuntu/Fedora families. The user gets exactly the toolchain they asked for (Codespaces semantics), Features install exactly as the CLI intends (its generated Dockerfile stacks `install.sh` layers on *their* base), `containerEnv` and Feature `containerEnv` become image `ENV`, and the build is reproducible from their pins plus our `ZS_BUILD_ID` and `ZS_LAYER_VERSION` (BUILD-SPEC:433). The cost: none of b8's preinstalled language servers exist in a repo image — Zed's adapters download into `paths::languages_dir()` on first open (§2.6 anchors), which the prebuild warm-up (§3.15) turns into a snapshot-time cost instead of a first-open cost; and `HOME` must be moved to `/vercel` (fixup step 4) so D9, CONTRACTS §11 and b9's archive command keep working unchanged.

Our binaries are copied from the builder's local payload (`/opt/zs/layer/bin`) rather than `COPY --from=vcr.vercel.com/…/zs-workspace:<build>`: no 5 GB pull per build, no second registry login scope, and the builder's `ZS_BUILD_ID` is by construction the one baked into the layer.

### 3.15 Prebuild warm-up glue (BUILD-SPEC §6.4, D14)

Headless client: **keep b8 §3.16a `warm.rs`** (a ~600-line tokio-tungstenite client inside `zs-agent` speaking b1's wire format with a vendored minimal `.proto`). Alternatives rejected: (a) the desktop `zed` binary needs a display/GPU platform (`gpui` Linux backends) and is ≈ 200 MB — not headless; (b) `zed-remote-server` has no client mode; (c) a new `zs-warm` binary on `crates/remote`'s `WebSocketRemoteConnection` — which **now exists** (`transport/websocket.rs`, 1 243 lines, dispatched at `remote_client.rs:1329`), so the transport is no longer the obstacle; the obstacle is that `RemoteConnection` is driven through `RemoteClient` + `Project` + a gpui headless `App`, i.e. most of Zed's client crate graph (≈ 30 min extra CI build, ≈ 100 MB extra in every image), to send the same two requests (`AddWorktree`, `OpenBufferByPath`) whose server-side effect (`headless_project.rs:302, 582-608` → `lsp_store.rs:4815-4841`) is what warms the servers; (d) BUILD-SPEC:315's "desktop transport in a Vercel Function" would need the same crate graph compiled to a Function runtime and an exposed `/rpc` on the prebuild sandbox (b9's prebuild declares `[8443, 8445]`, `b9:1409`), for no gain over a loopback client. §7 item 9 keeps (c) as the upgrade path if Zed's language-detection-by-content ever matters.

Glue this brief adds:

1. `prebuild` workflow runs on the repo image when one exists or can be built (§3.9), so downloads happen on the same base the workspace will use (a snapshot is only valid for its image).
2. The manifest's `devcontainer` block reaches `pb-` principals (§3.6); `manifest.extensions` includes `config.zed.extensions`; `ZS_PREBUILD_WARM_CMD` = `repos.prebuild_warm_command ?? config.zed.prebuild.command ?? ""` (`stepStartSupervisorForPrebuild`, `b9:622`, reads the build row's config).
3. b8 `warm::pick_probe_files(root, hints, feature_langs)` (§3.16 — one signature, used identically in both places): hints from `manifest.devcontainer.zed.prebuild.files` are opened first (existing, repo-relative, ≤ `WARM_MAX_FILES`), then the extension table fills the remainder; the Features list adds implied probes (`node` ⇒ `.ts/.js`, `python` ⇒ `.py`, `go` ⇒ `.go`, `rust` ⇒ `.rs`, `java` ⇒ `.java`) so a repo whose main sources sit deeper than depth 6 still warms its servers.
4. A push that changes the devcontainer on a prebuild branch chains image build → prebuild (§3.9 step 9) instead of prebuilding on the old image and rebuilding the image in parallel.
5. `stepPickImage` skips a prebuild snapshot whose `imageBuildId` is superseded by a newer ready image (§3.7), so a workspace never boots a snapshot of an older image when a fresher one exists (snapshots are per image).

### 3.16 Supervisor delta (b8, `sandbox/supervisor/src/*.rs`) — the "from the manifest" behaviour

All changes are additive to b8's change list; b8's `DevcontainerConfig::load` stays as the fallback path.

```rust
// manifest.rs — replaces DevcontainerHint (b8:300, 326)
#[derive(Clone, Debug, Default, serde::Deserialize)] #[serde(rename_all = "camelCase")]
pub struct DevcontainerSpec {
    pub config_hash: String,                                  // contentHash, BARE hex (§3.1) — the marker value is `format!("{MARKER_V}:{config_hash}")`, not the hash itself, so a schema change that moves contentHash does not re-run postCreateCommand in every existing workspace on next boot
    #[serde(default)] pub image_build_id: Option<String>,     // informational
    #[serde(default)] pub source: DevcontainerSource,         // "manifest" (authoritative) | "checkout" (use load(); default when the control plane sent only configHash)
    #[serde(default)] pub lifecycle: LifecycleSpec,
    #[serde(default)] pub remote_env: BTreeMap<String, String>,
    #[serde(default)] pub forward_ports: Vec<u16>,
    #[serde(default)] pub ports_attributes: BTreeMap<String, PortAttributes>,   // keys are plain ports already (the control plane dropped the rest)
    #[serde(default)] pub other_ports_attributes: Option<PortAttributes>,
    #[serde(default)] pub zed: ZedCustomizations,
    #[serde(default)] pub services: Vec<Service>,             // [Dockerd]
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Deserialize)] #[serde(rename_all = "lowercase")] pub enum DevcontainerSource { #[default] Checkout, Manifest }
#[derive(Clone, Debug, Default, serde::Deserialize)] #[serde(rename_all = "camelCase")]
pub struct LifecycleSpec { pub on_create: Option<ManifestLifecycleCommand>, pub update_content: Option<ManifestLifecycleCommand>, pub post_create: Option<ManifestLifecycleCommand>, pub post_start: Option<ManifestLifecycleCommand>, pub post_attach: Option<ManifestLifecycleCommand> }
#[derive(Clone, Debug, serde::Deserialize)] #[serde(tag = "kind", rename_all = "lowercase")]
pub enum ManifestLifecycleCommand { Shell { command: String }, Argv { argv: Vec<String> }, Parallel { commands: BTreeMap<String, LifecycleCommandLeaf> } }
// NAME: `ManifestLifecycleCommand`, not `LifecycleCommand`. The untagged `LifecycleCommand` already lives in this very module (`manifest.rs:483`, beside `LifecycleCommandLeaf` at `:495`) and is what the checkout parser produces; declaring a second `LifecycleCommand` in the same module is a duplicate-definition compile error, and there is no `checkout` module to name in a `From<checkout::LifecycleCommand>` impl. The conversion that exists is the other direction: `impl From<ManifestLifecycleCommand> for LifecycleCommand`, so `run_lifecycle` keeps taking exactly one type.
#[derive(Clone, Debug, Default, serde::Deserialize)] #[serde(rename_all = "camelCase")]
pub struct ZedCustomizations { #[serde(default)] pub extensions: Vec<String>, #[serde(default)] pub settings: Option<serde_json::Value>, #[serde(default)] pub prebuild: Option<PrebuildHints> }
#[derive(Clone, Debug, Default, serde::Deserialize)] #[serde(rename_all = "camelCase")] pub struct PrebuildHints { #[serde(default)] pub files: Vec<String>, #[serde(default)] pub command: Option<String> }
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)] #[serde(rename_all = "lowercase")] pub enum Service { Dockerd }

// bootstrap.rs
/// manifest.devcontainer with source == Manifest → DevcontainerConfig::from(spec) (no file read); otherwise DevcontainerConfig::load(repo_root) (b8 §3.4) and, when the manifest carried a hash, log a mismatch if it differs from the loaded bytes' hash.
pub fn effective_devcontainer(manifest: &Manifest, repo_root: &Path) -> anyhow::Result<Option<(DevcontainerConfig, String /* marker hash */)>>;
/// Phase::PostCreate now runs on_create → update_content → post_create in sequence (each with POST_CREATE_TIMEOUT sharing one 30-minute budget), one marker for the sequence.
/// Phase::Services (new, between ServerStarting and Dotfiles): for Service::Dockerd → `sudo -n dockerd` in its own process group, wait ≤ 30 s for `docker info`; failure is non-fatal (`lastError = "dockerd: …"`); on stop the group is SIGTERMed with the lifecycle task.
/// Its log source is `services`, which CONTRACTS §7.6 (`CONTRACTS.md:453`) does not list — §3.17 adds it there and to the route's zod enum, otherwise every batch from this service is rejected `invalid_body` and §6.5's run-local.sh assertion fails on a contract violation rather than a bug.
pub async fn start_services(services: &[Service], logs: &LogShipper, state: &AgentState, shutdown: &CancellationToken) -> Vec<ChildGroup>;
/// write_settings gains an overlay: when Some(obj) (customizations.zed.settings), the user's JSONC text is parsed leniently, deep-merged OVER the overlay (user wins, arrays replaced not concatenated), and the merged JSON is written; the marker hash covers overlay + text. The control plane's copy (the document the user edits) is untouched; only the sandbox file loses comments.
pub fn write_settings(docs: &SettingsDocs, overlay: Option<&serde_json::Value>, home: &Path, markers: &Markers) -> std::io::Result<()>;
/// SIGNATURE CHANGE from the shipped `write_settings(docs, home, markers)` (`sandbox/supervisor/src/bootstrap.rs:187`, currently a ZS-TODO(b8-skeleton) stub). Every caller is updated in the same change: `start.rs`'s boot sequence (CONTRACTS §7.7 "→ write_settings → devcontainer parse") passes `effective_devcontainer(...)`'s overlay, and the two b8 unit tests that call it directly pass `None`. The overlay is the ALLOWLISTED subset (§3.1 rule 9), so an unvalidated repo-controlled `lsp.*`/`terminal.*`/`task` blob can never reach it.
/// forwardPorts: the label/visibility default comes from ports_attributes[port] then other_ports_attributes then (label None, visibility Private) — unchanged from b8 §3.16 step 6 apart from other_ports_attributes.
```

```rust
// config.rs / start.rs
// USER fill (CONTRACTS §7.2 "fills SHELL/USER=ubuntu when missing"): use `nix::unistd::User::from_uid(getuid())` → name, falling back to the contents of /etc/zs/user, then "ubuntu". A repo image's uid-1000 user may be `node` or `vscode` (§3.14 fixup step 3).
// remoteEnv filter: the union that builds the server environment (CONTRACTS §11:614) applies the SAME key filter as §3.1 rule 7 (^ZS_, RESERVED_SECRET_NAMES, LD_*/GIT_*/NODE_OPTIONS/PYTHONSTARTUP/PYTHONPATH) before merging manifest remoteEnv. The control plane filters on the way in; the supervisor filters on the way out, so an older control plane cannot inject LD_PRELOAD into zed-remote-server.
// warm.rs
pub fn pick_probe_files(root: &Path, hints: &[String], feature_langs: &[&str]) -> Vec<PathBuf>;   // widens the shipped `pick_probe_files(root)` (sandbox/supervisor/src/warm.rs:69); hints first (validated: relative, exists, no `..`), then feature-implied extensions, then b8's table; deduplicated; ≤ WARM_MAX_FILES. This is the only arity — §3.15 item 3 uses the same one.
// start.rs prebuild: ZS_PREBUILD_WARM_CMD when empty falls back to manifest.devcontainer.zed.prebuild.command (b9 already resolves this server-side; the fallback keeps an older control plane working).
```

Acceptance for this delta is in b8's test tables (§6.4 below lists the additions).

### 3.17 Contracts and fixtures (`docs/contracts/`, *modified/new*)

- `sandbox-manifest.v1.json`: `devcontainer` becomes `oneOf [null, DevcontainerSpec]` with `DevcontainerSpec` requiring only `configHash`; every other property optional with defaults.
- `devcontainer-normalized.v1.json` (new): JSON Schema of `DevcontainerNormalized` (§4.1), generated from the zod schema by **`apps/web/scripts/emit-schemas.ts` (new — it does not exist today and is in the change list)**, run as `pnpm zs:schemas` (`z.toJSONSchema`, zod 4) and committed; `tests/devcontainer/schema.test.ts` fails when the committed file is stale. Note that `docs/contracts/` currently holds only `fixtures/manifest.example.json`: `sandbox-manifest.v1.json` and `sandbox-api.md` are b8 files not yet on disk (`†` in the change list).
- `fixtures/manifest.example.json`: the `devcontainer` member becomes a full block (source `manifest`, one shell `postCreate`, `forwardPorts: [3000]`, `portsAttributes.3000 = { label: "web", visibility: "private" }`, `zed.extensions: ["toml"]`), so b8's `example_manifest_parses` and b9's `fixture_parses_with_sdk_schema` both exercise it. `configHash` keeps its **bare-hex** form (the file's current value at `:57` is 64 hex characters) — no migration, no format split (§3.1).
- `fixtures/devcontainer/`: the six real-world files (§2.7) plus their expected normalised output and hashes (§6.1).
- `sandbox-api.md`: the two image-build routes and the widened principal table.

**`docs/briefs/CONTRACTS.md` is amended in the same change** (it was missing from the first revision's change list, and by this brief's own precedence rule CONTRACTS beats the brief — reviewers would otherwise check round 1 against stale text):

| CONTRACTS row | Amendment |
|---|---|
| §7.2 (`:356-379`) | `ZS_IMAGE_BUILD_ID`, `ZS_VCR_USERNAME/PASSWORD/REGISTRY` (builder `runCommand` env only, never `Sandbox.create({ env })`); a repo image sets the §11:612 `ENV` line verbatim; the `USER` fill resolves from uid 1000 then `/etc/zs/user` then `ubuntu`. |
| §7.3 (`:407`) | `devcontainer` becomes the `DevcontainerSpec` block of §4.4 and is **authoritative when `source: "manifest"`** — the current row says `{ configHash } \| null`, "informational". |
| §7.4 (`:415-431`) | Two new sandbox routes (`GET\|POST …/image-build`); `git-token` gains a read-only variant for `imageBuild` principals; the `sandbox.image-build` rate limit; the principal column gains `ib-`. |
| §7.6 (`:453`) | `source` gains `builder` and `services`; `LogBatch`'s `workspaceId`/`sessionId`/`build` are defined for an `ib-` principal (`repoId`/`buildId`/`ZS_SERVER_BUILD_ID`); the drop policy for high-rate build output. |
| §8.1 (`:489`) | Ids `^(ws\|repo\|img)_…`; sandbox names `^(sb\|pb\|ib)-…`. |
| §8.2 (`:495`, `:510-511`) | Three new user routes (`GET\|POST /api/repos/{id}/image-builds`, `GET …/{buildId}/log`); `POST /api/workspaces` gains `allowBase` and the `409 image_failed` / `409 devcontainer_invalid` codes beside `image_building`. |
| §11 (`:612`) | Unchanged — §4.5 now reproduces it exactly (incl. `RUSTUP_HOME`/`CARGO_HOME`); the note that `remoteEnv` is filtered before the union at `:614`. |
| §12 (`:619-630`) | A repo image's `ZS_BUILD_ID` is verified against the builder payload at build time (`/opt/zs/layer/BUILD_ID`), and `ZS_LAYER_VERSION` is recorded beside it. |

### 3.18 `docs/briefs/DECISIONS.md` (*modified*) — the decisions this brief makes over BUILD-SPEC and CONTRACTS

Each needs a D-number before implementation starts, because each contradicts or extends a written decision:

| D | Decision |
|---|---|
| D35 | A builder sandbox declares **no** ports and is `persistent: false` (D21 governs workspace ports and says nothing about builders — the first revision quoted it as if it did). |
| D36 | Inverted layering: the user's image/Dockerfile + Features is the base and our supervisor+server layer goes on top, amending BUILD-SPEC:311's "layered on our base" (§3.14, §7 item 1). |
| D37 | `onCreateCommand`/`updateContentCommand` are supported beyond BUILD-SPEC:309's literal list, folded into the post-create phase (§3.1 rule 6, §7 item 16). |
| D38 | The manifest becomes **authoritative** over the checkout for the devcontainer config when `source: "manifest"`, contradicting CONTRACTS §7.3's "informational" (§3.6, §3.16). |
| D39 | `customizations.zed.{settings,services,prebuild}` extend BUILD-SPEC:309's "settings and extensions"; `settings` is restricted to a presentation-only allowlist and repo-declared `extensions` need a per-repo user opt-in (§3.1 rule 9). |
| D40 | A non-allowlisted Feature is **dropped with a warning** rather than failing the build (Codespaces fails); `repos.strict_devcontainer` may later make it fatal (§7 item 6). Also covers the supervisor's new `Phase::Services`/`dockerd` step, which resolves b8 §7 item 24. |

---

## 4. New types, messages, schemas

### 4.1 `DevcontainerNormalized` (`apps/web/lib/devcontainer/schema.ts`, zod + inferred type)

```ts
import { z } from "zod";
export const lifecycleLeaf = z.union([z.object({ kind: z.literal("shell"), command: z.string().min(1) }), z.object({ kind: z.literal("argv"), argv: z.array(z.string()).min(1) })]);
export const lifecycleCommand = z.union([lifecycleLeaf, z.object({ kind: z.literal("parallel"), commands: z.record(z.string(), lifecycleLeaf) })]);
export const portAttributes = z.object({ label: z.string().max(64).optional(), visibility: z.enum(["public", "private"]).optional(), protocol: z.enum(["http", "https"]).optional(), onAutoForward: z.string().optional() });
export const featureRef = z.object({ id: z.string().regex(/^ghcr\.io\/devcontainers\/features\/(common-utils|node|python|go|rust|java|docker-in-docker|github-cli)$/), version: z.string().default("latest"), options: z.record(z.string(), z.union([z.string(), z.boolean()])).default({}) });
export const zedSettingsOverlay = z.record(z.string(), z.unknown()).superRefine(allowlistedSettingKeys);   // §3.1 rule 9: presentation-only keys survive; lsp, terminal, task/tasks, context_servers, agent, node, command_aliases, file_scan_* are stripped with an unsupported_setting_key warning. An unvalidated z.record here would be code execution on open for anyone who opens the repo — including through BUILD-SPEC:383's create-from-PR flow, where the config comes from a fork's branch and the workspace carries the user's, org's and repo's secrets (BUILD-SPEC §7.9).
export const zedCustomizations = z.object({
  extensions: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)).max(64).default([]),   // offered, not auto-installed (§3.1 rule 9)
  settings: zedSettingsOverlay.optional(),
  prebuild: z.object({ files: z.array(z.string()).max(24).default([]), command: z.string().max(4096).optional() }).optional(),
  services: z.array(z.enum(["dockerd"])).default([]),
});
export const devcontainerNormalized = z.object({
  version: z.literal(1),
  name: z.string().max(128).optional(),
  base: z.union([
    z.object({ kind: z.literal("image"), image: z.string().min(1) }),
    z.object({ kind: z.literal("dockerfile"), dockerfilePath: z.string(), contextPath: z.string(), args: z.record(z.string(), z.string()).default({}), target: z.string().optional() }),
  ]),
  features: z.array(featureRef).default([]),
  overrideFeatureInstallOrder: z.array(z.string()).default([]),
  lifecycle: z.object({ onCreate: lifecycleCommand.optional(), updateContent: lifecycleCommand.optional(), postCreate: lifecycleCommand.optional(), postStart: lifecycleCommand.optional(), postAttach: lifecycleCommand.optional() }).default({}),
  containerEnv: z.record(z.string(), z.string()).default({}),
  remoteEnv: z.record(z.string(), z.string()).default({}),
  forwardPorts: z.array(z.number().int().min(1).max(65535)).default([]),
  portsAttributes: z.record(z.string().regex(/^\d{1,5}$/), portAttributes).default({}),
  otherPortsAttributes: portAttributes.optional(),
  hostRequirements: z.object({ cpus: z.number().int().positive().optional(), memoryMb: z.number().int().positive().optional() }).optional(),
  zed: zedCustomizations.default({}),
});
export type DevcontainerNormalized = z.infer<typeof devcontainerNormalized>;
export const devcontainerWarning = z.object({ code: z.enum(["unsupported_key", "feature_not_allowed", "port_key_ignored", "unresolved_variable", "invalid_value", "unsupported_lifecycle"]), key: z.string(), message: z.string() });
```

Ordering guarantees for hashing: `features` sorted by `id`, then `version`; record keys are sorted by `canonicalJson`; `forwardPorts` sorted ascending and deduplicated; `parallel.commands` keep their keys (sorted by `canonicalJson`) — order is not semantic for parallel commands.

### 4.2 Database (see §3.2): `image_builds`, `repos` additions, `workspaces.image_build_id`, `prebuilds.image_build_id`, enums `image_build_status`, `image_build_trigger`.

### 4.3 Environment additions (see §3.3): `ZS_VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_SLUG`, `VERCEL_PROJECT_SLUG`, `ZS_VCR_AUTH`, `ZS_IMAGE_BUILD_BUDGET_MS`, `ZS_IMAGE_READY_BUDGET_MS`, `ZS_IMAGE_MAX_BYTES`, `ZS_IMAGE_KEEP_PER_REPO`, `ZS_BUILDER_VCPUS`, `ZS_BUILDER_MAX_VCPUS`, `ZS_IMAGE_BUILDS_MAX_INFLIGHT_ORG`, `ZS_STALE_REBUILD_COOLDOWN_MS`, `ZS_EDITOR_BUNDLES`; builder `runCommand` env `ZS_IMAGE_BUILD_ID`, `ZS_VCR_USERNAME`, `ZS_VCR_PASSWORD`, `ZS_VCR_REGISTRY` (never in `Sandbox.create({ env })`).

### 4.4 Manifest block (`SandboxManifest.devcontainer`, replaces `{ configHash } | null`)

```ts
export const manifestDevcontainer = z.object({
  configHash: z.string().regex(/^[0-9a-f]{64}$/),           // contentHash, bare hex — the shape lib/github.ts:180, lib/manifest.ts:156/199 and the committed fixture already use
  imageBuildId: z.string().optional(),
  source: z.enum(["manifest", "checkout"]).default("checkout"),
  lifecycle: devcontainerNormalized.shape.lifecycle,        // same tagged LifecycleCommand shape
  remoteEnv: z.record(z.string(), z.string()).default({}),  // already key-filtered by §3.1 rule 7; `${containerEnv:…}` left for the supervisor (b8 expand_remote_env), which filters again before the §11:614 union
  forwardPorts: z.array(z.number().int()).default([]),
  portsAttributes: z.record(z.string(), portAttributes).default({}),
  otherPortsAttributes: portAttributes.optional(),
  zed: zedCustomizations.default({}),
  services: z.array(z.enum(["dockerd"])).default([]),       // derived: zed.services ∪ (features has docker-in-docker ? ["dockerd"] : [])
});
// SandboxManifest.devcontainer: manifestDevcontainer.nullable()
```

Rust mirror: §3.16 `DevcontainerSpec`. Backwards compatibility: a control plane that emits only `{ configHash }` parses as `source: checkout`; a supervisor built against b8's old `DevcontainerHint` ignores the extra fields (serde default behaviour) and keeps parsing the checkout.

### 4.5 Synthesised layer Dockerfile (`renderLayerDockerfile`, exact text; `@@…@@` are the driver's substitution markers, the TS function inlines the same values)

```dockerfile
# syntax=docker/dockerfile:1.7
# zs layer v@@LAYER_VERSION@@ on top of the devcontainer stage; generated — do not edit
FROM @@STAGE_IMAGE@@
USER root
SHELL ["/bin/sh", "-c"]
COPY --chmod=0755 bin/zed-remote-server bin/zs-agent /usr/local/bin/
COPY --chmod=0755 zs-layer-fixup.sh /usr/local/lib/zs/zs-layer-fixup.sh
ARG ZS_BUILD_ID=@@ZS_BUILD_ID@@
RUN START_DOCKERD=@@START_DOCKERD@@ ZS_BUILD_ID="$ZS_BUILD_ID" /usr/local/lib/zs/zs-layer-fixup.sh
@@CONTAINER_ENV_LINES@@
ENV HOME=/vercel \
    SHELL=/bin/bash \
    ZS_BUILD_ID=@@ZS_BUILD_ID@@ \
    ZS_WORKSPACES_DIR=/workspaces \
    ZS_SERVER_BIN=/usr/local/bin/zed-remote-server \
    ZS_SUPERVISOR_URL=http://127.0.0.1:8450 \
    ZS_CONTROL_SECRET_FILE=/vercel/.zs/run/control.secret \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo
LABEL dev.zs.build="@@ZS_BUILD_ID@@" dev.zs.devcontainer.hash="@@CONFIG_HASH@@" dev.zs.repo="@@REPO@@" dev.zs.layer.version="@@LAYER_VERSION@@"
USER 1000
WORKDIR /workspaces
```

The `ENV` block reproduces CONTRACTS §11:612 **exactly**, `RUSTUP_HOME`/`CARGO_HOME` included (they were missing in the first revision, and an invented `ZS_DEVCONTAINER_HASH` — a row that appears nowhere in CONTRACTS §7.2 and that nothing reads — has been dropped; the `LABEL` below already records the hash for `docker inspect`).

`@@CONTAINER_ENV_LINES@@` is zero or more `ENV KEY="value"` lines with the value JSON-string-escaped, produced by the control plane as `spec.layer.envLines` **after** the §3.1 rule 7 filter: keys match `^[A-Za-z_][A-Za-z0-9_]*$` and are not `ZS_*`, not in `RESERVED_SECRET_NAMES`, not `LD_*`/`GIT_*`/`NODE_OPTIONS`/`PYTHONSTARTUP`/`PYTHONPATH`. `renderLayerDockerfile` re-applies the filter itself and throws on a violating key, so the template can never emit one even if a caller skips the normaliser. The one exception is `PATH`: applied as `ENV PATH="<value>"` only when it still contains `/usr/local/bin`, else warned and dropped.

`USER 1000` is numeric on purpose: the uid-1000 user's *name* is unknown at template time (a repo image may call it `node` or `vscode`). It is resolved at runtime inside the sandbox — `nix::unistd::User::from_uid(getuid())`, falling back to `/etc/zs/user` written by fixup step 8 (§3.16) — **not** by `Sandbox.getDefaultUser`, which is `@internal` and not exposed by `lib/sandbox.ts` (§2.5).

### 4.6 Builder ↔ control plane messages

```ts
// GET /api/sandboxes/{name}/image-build → 200
export interface ImageBuildSpec {
  version: 1; buildId: string;
  repo: { owner: string; name: string; cloneUrl: string; revision: string /* 40-hex */ };
  devcontainer: { path: DevcontainerPath; dir: string /* ".devcontainer" | "." */; effective: Record<string, unknown> /* sanitised devcontainer.json the CLI consumes (§3.13 step 5) */; normalized: DevcontainerNormalized; contentHash: string; configHash: string };
  image: { repository: string; tag: string; ref: string /* project-relative */; fullRef: string /* vcr.vercel.com/… */ };
  layer: { serverBuild: string; version: number; startDockerd: boolean; envLines: string[] /* already key-filtered, §3.1 rule 7 */; repoLabel: string };
  limits: { imageMaxBytes: number /* uncompressed pre-check */; layerMaxUncompressedBytes: number; compressedLayerMaxBytes: 500_000_000; compressedTotalMaxBytes: 15_000_000_000; manifestMaxBytes: 4_000_000; configBlobMaxBytes: 1_000_000; budgetMs: number };
  cache: { from: string; to: string };                      // registry cache refs, `<repository>:cache-<contentHash16>`
  logUploadUrl: string;                                     // presigned Blob PUT, 2 h
}
// POST /api/sandboxes/{name}/image-build → 204
export const imageBuildStatusReport = z.object({
  phase: z.enum(["boot", "dockerd", "clone", "devcontainer_build", "layer_build", "size_check", "push", "pushed", "done", "failed"]),
  message: z.string().max(4096).optional(),
  errorCode: z.enum(["config", "clone", "devcontainer_config", "devcontainer_build", "layer_build", "image_too_large", "push", "dockerd", "unsupported_base"]).optional(),
  result: z.object({ digest: z.string().regex(/^sha256:[0-9a-f]{64}$/), sizeBytes: z.number().int().nonnegative(), manifest: z.unknown().optional(), lockfile: z.unknown().optional() }).optional(),   // required with phase "pushed". NO imageRef: it is recomputed server-side from build.imageRepository + this digest (§3.10), because this body comes from a VM that has just run user-controlled Dockerfiles and Feature scripts and it feeds Sandbox.create({ image }).
});
```

### 4.7 User-facing views

```ts
// image.status is DERIVED in the view (repos.image_status is not widened, §3.2): "preparing" from the live image_builds row, "stale" from isStaleServerBuild(build).
export interface DevcontainerSummary { path: DevcontainerPath | null; status: "none" | "ok" | "error"; error?: { code: string; message: string }; warnings: Warning[]; contentHash: string | null; checkedRevision: string | null; hostRequirements?: { cpus?: number; memoryMb?: number }; image: { status: "none" | "building" | "preparing" | "ready" | "failed" | "stale"; ref: string | null; digest: string | null; serverBuild: string | null; builtAt: string | null; error: string | null; runId: string | null; allowBaseFallback: boolean } }
export interface ImageBuildView { id: string; status: ImageBuildStatus; phase: string | null; trigger: string; branch: string | null; revision: string; configHash: string; contentHash: string; imageRef: string | null; digest: string | null; sizeBytes: number | null; serverBuild: string; error: string | null; warnings: Warning[]; createdAt: string; startedAt: string | null; finishedAt: string | null; readyAt: string | null; logAvailable: boolean }
// RepoView += devcontainer: DevcontainerSummary ; WorkspaceView += image: { kind: "base" | "repo"; ref; serverBuild; stale; imageBuildId }
// POST /api/workspaces error details: 409 image_building { imageBuildId, runId, phase } ; 409 image_failed { imageBuildId, error }
// createWorkspaceInput += allowBase: z.boolean().default(false)
```

---

## 5. Package/Cargo changes with verified versions

`apps/web/package.json` (b9 §5 block, one addition):

```json
"dependencies": { …, "jsonc-parser": "3.3.1" }
```

`jsonc-parser 3.3.1` (npm registry, 2026-09-02): MIT, zero dependencies, the parser `@devcontainers/cli` itself uses — comments, trailing commas, error offsets. Everything else this brief imports is already pinned by b9: `@vercel/sandbox 3.2.1` (`persistent`, `runCommand({ detached, sudo, timeoutMs })`, `image`), `workflow 4.8.5` (`start`, `sleep`, `FatalError`, `RetryableError`), `@vercel/functions 3.9.5` (`getVercelOidcToken` via `@vercel/oidc 3.8.5`), `@vercel/blob 2.8.0` (`issueSignedToken`, `presignUrl` for put/get), `@octokit/rest 22.0.1` (`repos.getContent`, `git.getTree`, `repos.compareCommitsWithBasehead`), `zod 4.5.4` (`package.json:39`), `drizzle-orm 0.45.2`; dev `@workflow/vitest 4.0.21`, `vitest 4.1.11`, `drizzle-kit 0.31.10`. There is no `packages/` directory in the repository, so nothing is added to a `packages/sdk/package.json`: the schema module lives under `apps/web/lib/devcontainer/` and adds no dependency of its own.

Builder image pins (`sandbox/image/builder/Dockerfile`): `@devcontainers/cli@0.89.0` (npm, requires Node ≥ 20; the universal base ships Node 24); Docker from the workspace image's Ubuntu 26.04 `docker.io`/`docker-buildx` packages (b8 §3.19:1133 — versions come from apt and are pinned only through `base.lock`'s digest; §7 item 5).

One Cargo change: the b8 delta (§3.16) uses `serde`, `serde_json`, `serde_json_lenient` (all present) plus `nix::unistd::User::from_uid`. `nix` has **no `unistd` feature** — its `unistd` items are gated individually, and `User`/`User::from_uid` sit behind the **`user`** feature, which the shipped `sandbox/supervisor/Cargo.toml:38` (`nix = { version = "0.29", features = ["signal", "process"] }`) does not enable. So that line becomes `features = ["signal", "process", "user"]`; it is the only line touched.

---

## 6. Tests

### 6.1 Parser and hashing (`apps/web/tests/devcontainer/*.test.ts`, vitest unit config)

Fixtures in `apps/web/tests/fixtures/devcontainer/<name>/{devcontainer.json, Dockerfile?, expected.json, warnings.json}` — the six real-world files of §2.7 copied verbatim (`github-docs`, `deno`, `try-node`, `try-python`, `typescript`, `try-go`), plus two synthetic ones: `root-devcontainer` (`.devcontainer.json` at the repo root with `${containerWorkspaceFolder}`, `${localEnv:HOME}` and `${containerEnv:PATH}` uses, `forwardPorts: ["db:5432", 3000, 8443]`, `portsAttributes: { "3000-3999": {}, "3000": { "visibility": "public" } }`) and `compose` (`dockerComposeFile`).

| Test | Asserts |
|---|---|
| `parses_all_real_world_fixtures` | each fixture → `ok: true`; normalised output deep-equals `expected.json`; warnings deep-equal `warnings.json`. Specific expectations: github-docs → `base.kind = "dockerfile"`, `dockerfilePath = ".devcontainer/Dockerfile"`, `args.VARIANT = "24"`, features = `[github-cli:1, docker-in-docker:2]` with warnings `feature_not_allowed` for `sshd` and `copilot-cli`, `forwardPorts [4000]`, `portsAttributes["4000"].label = "Review"`, `lifecycle.postStart.kind = "shell"`, `lifecycle.postAttach` present, `hostRequirements = { cpus: 4, memoryMb: 16384 }`, warnings `unsupported_key` for `remoteUser`, `customizations.vscode`, `customizations.codespaces`; `services = ["dockerd"]` in the manifest block. typescript → `base.kind = "image"`, features `[github-cli:1, node:2 { version: "24", pnpmVersion: "latest", nvmVersion: "latest" }]`, `dprint-asdf` warned, `postCreate.kind = "parallel"` with three named shell commands. deno → dockerfile base, `runArgs` warned, `postCreate` shell. try-node/try-python/try-go → image base, `portsAttributes` label kept, `onAutoForward` kept. |
| `rejects_compose_and_missing_base` | `compose` → `{ ok: false, error.code: "unsupported_compose" }`; `{}` → `no_image_or_dockerfile`; `[]` → `not_object`; `{ "image": "x", ` → `syntax` with offset. |
| `path_confinement` | `build.dockerfile: "../../etc/passwd"` → `invalid_dockerfile_path`; `context: ".."` from `.devcontainer/` resolves to `"."` (repo root, allowed); `context: "../.."` → `invalid_context_path`. |
| `substitution` | `${containerWorkspaceFolder}` → `/workspaces/<repo>`; `${localEnv:HOME}` → `""` + `unresolved_variable` warning; `${localEnv:X:dflt}` → `dflt`; `${containerEnv:PATH}` kept verbatim in `remoteEnv` and lifecycle, resolved in `build.args`/`containerEnv`. |
| `features_allowlist` | shorthand `"ghcr.io/devcontainers/features/go": "1.22"` → `{ version: "1.22" }`; `"node": true` → allowed (auto-mapped); `"https://…/x.tgz": {}` and `"./local": {}` → warned and dropped; sorted output. |
| `ports` | `"db:5432"` warned; `8443` (infra) warned and dropped; ranges/regex keys → `port_key_ignored`; `visibility: "public"` kept. |
| `content_hash_stability` | the same fixture re-serialised with different key order, indentation, comments and trailing commas → identical `contentHash`; changing `postCreateCommand` → different; adding a `customizations.vscode` key → identical (unsupported keys do not hash). |
| `config_hash_inputs` | `configHash` changes with `dockerfileSha256`, `contextDigest`, `baseDigests`, `serverBuild`, `layerVersion` independently; `contentHash` does not; tag = first 16 hex chars; pinned golden values for two fixtures (so an accidental canonicalisation change fails loudly). |
| `canonical_json` | key sorting by code point, nested arrays untouched, `-0` → `0`, non-finite rejected, unicode escaped like `JSON.stringify`. |
| `dockerfile_render_matches_template` | `renderLayerDockerfile(sample)` equals `sandbox/image/builder/layer/Dockerfile.zs-layer.tmpl` after marker substitution; `containerEnv` with quotes/newlines is escaped; `PATH` without `/usr/local/bin` is dropped with a warning; snapshot of the rendered text. |
| `schema_file_is_current` | `docs/contracts/devcontainer-normalized.v1.json` equals `z.toJSONSchema(devcontainerNormalized)` output (`scripts/emit-schemas.ts`). |
| `env_keys_are_filtered` | `containerEnv`/`remoteEnv` carrying `LD_PRELOAD`, `LD_LIBRARY_PATH`, `PATH` without `/usr/local/bin`, `HOME`, `USER`, `ZS_LOCAL_API_LISTEN`, `ZS_INSECURE_COOKIES`, `ZS_CONTROL_SECRET_FILE`, `GIT_ASKPASS`, `NODE_OPTIONS` → every one dropped with `reserved_name`; `renderLayerDockerfile` throws if handed one anyway; a benign `MY_VAR` survives in both maps. |
| `zed_settings_allowlist` | overlay `{ theme, tab_size, languages: { rust: { tab_size } }, lsp: { rust-analyzer: { binary: { path } } }, terminal: { shell }, tasks: [...], context_servers: {...} }` → only the first three survive, three `unsupported_setting_key` warnings; `extensions` are recorded but marked `requiresOptIn`. |
| `base_registry_allowlist` | `image: "10.0.0.5:5000/x"`, `"169.254.169.254/x"`, `"vcr.vercel.com/t/p/zs-workspace:b"` → `base_registry_not_allowed`; `mcr.microsoft.com/devcontainers/go:dev-1.26-bookworm` and `node:20` (→ docker.io) → ok. A Dockerfile whose body has `FROM vcr.vercel.com/...`, `COPY --from=vcr.vercel.com/...` or a `# syntax=` line → the same error at admission. |
| `marker_is_versioned` | adding a defaulted optional field to `devcontainerNormalized` changes `contentHash` but **not** `${MARKER_V}:${…}`'s version segment — the test pins the marker of a golden fixture, so the change that would silently re-run `postCreateCommand` in every existing workspace fails loudly instead. |

### 6.2 Images, VCR and admission (`tests/images.test.ts`, `tests/vcr.test.ts`)

Fake `fetch` for `api.vercel.com` (scripted `status` sequence per digest) and the pglite DB (b9 `tests/helpers/db.ts`).

| Test | Asserts |
|---|---|
| `repository_name_rules` | `imageRepositoryName("Octo Cat", "My.Repo_v2")` matches `^[a-z0-9][a-z0-9._-]*[a-z0-9]$`, ≤ 62 chars, stable, differs for `octo/cat` vs `oct/ocat`. |
| `resolve_base_without_devcontainer` | GitHub fake returns 404 for both paths → `{ kind: "base", reason: "no_devcontainer" }`; no `image_builds` row. |
| `resolve_admits_once` | two concurrent `resolveRepoImage(..., { admit: true })` for the same hash → one row, one `start()` (fake `start` counter), both return `building` with the same id (lock + partial unique index). |
| `resolve_ready_and_stale` | ready row with `serverBuild = "old-1"` and `ZS_EDITOR_BUNDLES = "cur,old-1"` → `{ kind: "repo", stale: true }` and a new `stale`-trigger row admitted; with `ZS_EDITOR_BUNDLES = "cur"` → `building` (no stale use); **run with `process.chdir()` into a directory that has no `public/`**, so a reintroduced `fs.existsSync` fails the test rather than production. |
| `stale_trigger_cooldown` | two creates within `ZS_STALE_REBUILD_COOLDOWN_MS` on the same repo → one `stale` row, not two. |
| `resolve_returns_digest_ref` | a ready build → `image === `${repository}@${digest}``, never `:${tag}`; `stepPickImage` passes that string to the fake `create`. |
| `admission_caps` | a second push on the same (repo, branch) while one is in flight supersedes the older row and starts exactly one builder; over `ZS_IMAGE_BUILDS_MAX_INFLIGHT_ORG` the row is `queued` with `workflow_run_id` null and the sweep starts it later; `repo.image-builds` 20/3600 applies to the webhook path, not just the manual route. |
| `presign_scope` | `presignLogUpload` issues a token for exactly `image-builds/<id>/build.log` with `maximumSizeInBytes` set, and a PUT to `rebuild/<ws>/<ts>.tgz` with that token is rejected by the fake blob store. |
| `vcr_get_image_statuses` | `preparing` → `preparing`; `ready`; 404 → null; `kind: "index"` with `status: null` surfaces as `null`. |
| `credential_modes` | `ZS_VCR_AUTH=token` → `{ username: VERCEL_TEAM_ID, password: ZS_VERCEL_TOKEN }`; `oidc` → username `oidc`, password from a mocked `getVercelOidcToken`. |

### 6.3 Routes (`tests/routes/image-builds.test.ts`, `tests/routes/webhooks-github-devcontainer.test.ts`)

| Test | Asserts |
|---|---|
| `spec_route_requires_ib_principal` | `GET /api/sandboxes/ib-…/image-build` with the rotated `zsb_` → 200 spec with `effective` lacking `initializeCommand`, `runArgs`, `customizations.vscode`, non-allowlisted features, and `build.dockerfile` rewritten relative to `dir`; a `sb-` principal → 404; and an `ib-` principal is refused (404 `not_found`) by **every** route that does not opt into it: `manifest`, `ports`, `ports/[port]`, `activity`, `extensions`, `client-errors` — the default `kinds` of `requireSandbox` (§3.4) is what makes that true without editing those files, and the test proves it. |
| `status_route_transitions` | `pushed` with `result` → row `imageDigest`, `imageSizeBytes` written and `imageRef` **still null** (it is set by `stepVerifyPushed` from the row, not by the report); a body carrying an extra `result.imageRef` naming `zs-builder:<build>` or a foreign repository is rejected by the zod schema and changes nothing; `failed { errorCode: "devcontainer_build", message }` → `status failed`, `error = "devcontainer_build: …"`; a report after `ready` → 409 `build_not_active`. |
| `logs_route_accepts_builder_source` | an `ib-` principal posting `source: "builder"` with `workspaceId = repoId`, `sessionId = buildId` → 204; `source: "post_create"` from an `ib-` principal → 400; a `sb-` principal posting `source: "services"` → 204. |
| `git_token_for_builder_is_read_only` | fake `installationToken` receives `permissions: { contents: "read" }` and `repositoryIds: [repo.githubRepoId]`. |
| `manual_rebuild_route` | `POST /api/repos/{id}/image-builds` → 202 + row; second call → 200 same row; `force: true` supersedes and starts a new one; rate limit 5/600 s. |
| `create_workspace_image_building` | repo with a devcontainer and no image → `POST /api/workspaces` → 409 `image_building` with `details.runId`; with `allowBase: true` → 202 and the row has `imageRef = ZS_IMAGE_REF`, `stateReason = "devcontainer_pending"`; with a ready build → 202 and `imageRef = <repo image>`, `serverBuild = build.serverBuild`, `imageBuildId` set. |
| `push_webhook_devcontainer_filter` | payload with `commits[].modified = [".devcontainer/Dockerfile"]` on the default branch → one admitted build (`trigger: "push"`); `.devcontainerx/foo` → none; **a repo whose stored config has `build.dockerfile: "../Dockerfile.dev"` and `context: "."` → a push touching `Dockerfile.dev` DOES admit a build (the matcher comes from the stored config, not from the constant regex) while a push touching an unrelated `README.md` does not**; empty `commits` + null `head_commit` → `changedFilesBetween` fake consulted; a prebuild branch push touching the devcontainer → build row with `thenPrebuildBranch` and **no** direct `start(prebuild)`. |
| `parse_error_respects_allow_base_fallback` | repo with `allowBaseFallback: false` and a devcontainer.json with a trailing brace → `POST /api/workspaces` 409 `devcontainer_invalid`; with `true` → 202 on the base image. |
| `forced_rebuild_keeps_previous_ready` | `force: true` while a ready build exists → the ready row stays `ready` and resolvable through the whole new build; when the new attempt **fails**, workspaces still create on the old image; only a successful attempt supersedes it. |

### 6.4 Workflow integration (`tests/workflows/build-devcontainer-image.integration.test.ts`, `@workflow/vitest`)

Fake sandbox additions (**`lib/sandbox-fake.ts:394`/`:490`** — the fake lives in `lib/`, not in `tests/helpers/`, which holds only `db.ts`, `keys.ts`, `server-only.ts`, `setup.ts`): `scriptDetachedCommand(name, { exitCode, afterMs, statusPosts: [...] })` — the fake "runs" the builder by posting the scripted `ImageBuildStatusReport`s to the real route handlers (in-process `fetch` to the app routes) on a timer, then reports the exit code through `waitCommand`; records `create` inputs (`persistent`, `ports`, `image`, `env`, `timeoutMs`). Fake VCR (`tests/helpers/fake-vcr.ts` on `globalThis`): scripted `status` sequence per digest, records `delete` calls.

| Test | Asserts |
|---|---|
| `happy_path` | `start(buildDevcontainerImage)` → fake recorded `create` with `image === ZS_BUILDER_IMAGE_REF`, `ports: []`, `persistent: false`, `env` **without** any token or registry credential, `tags.zs === envTag()`; `runDetached("/usr/local/bin/zs-build-devcontainer")` env **with** `ZS_SANDBOX_TOKEN`, `ZS_VCR_USERNAME/PASSWORD`, `ZS_CONTROL_URL === controlApiBase()`, `timeoutMs === ZS_IMAGE_BUILD_BUDGET_MS`; status walk `clone → devcontainer_build → layer_build → push → pushed → done`, exit 0; builder deleted **before** the first VCR poll; VCR `preparing, preparing, ready` → `image_builds.status = ready`, `readyAt`, `repos.image_ref/image_digest/image_build/image_status = ready`; `workflowRunId` and `repos.image_build_run_id` null; no `sleep` step longer than 15 s. |
| `builder_failure_marks_failed_and_deletes_vm` | scripted `failed { errorCode: "devcontainer_build" }` then exit 12 → run fails, `status failed`, `error` starts with `builder_reported:` or `builder_exit:12`, builder `delete` recorded, `repos.image_status = failed` + `image_error`, `workflowRunId` null. |
| `unoptimized_is_fatal` | VCR answers `unoptimized` → `FatalError image_unoptimized`, row failed, no `ready`. |
| `ready_timeout` | VCR stays `preparing` past a shortened `ZS_IMAGE_READY_BUDGET_MS` → `image_ready_timeout`; the digest stays recorded so an operator can retry `stepPollImageReady` via manual rebuild with `force`. |
| `retry_reuses_running_builder` | `stepStartBuilder` retried after persisting `builder_cmd_id` → exactly one `runDetached` **and zero additional `rotateSandboxToken` calls**: the token generation on the row is unchanged and the first builder's bearer still authenticates. (Asserting only the `runDetached` count passes even with the rotate-first ordering bug, which 401s a live builder.) |
| `builder_command_carries_budget` | the fake records `runDetached({ timeoutMs })` and `timeoutMs === ZS_IMAGE_BUILD_BUDGET_MS`; a companion unit test on the **real** `RealSandboxHandle` asserts the value reaches `sandbox.runCommand` (the fake alone would keep passing while production had no budget). |
| `orphan_push_is_recovered` | scripted builder posts `pushed` and then exits 1 without `done` → the catch path's `stepVerifyPushed` finds the digest and the run still ends `ready`; a builder that dies **before** pushing → `failed`, and `stepReconcileOrphanImages` deletes the untracked tag on the next gc. |
| `sweep_reconciles_dead_build` | an `image_builds` row whose run is `unknown` and older than the budget → the sweep marks it failed, deletes the builder VM, and starts the oldest `queued` row when a slot is free. |
| `chains_prebuild` | row with `thenPrebuildBranch = "main"` and `repos.prebuildBranches = ["main"]` → `start(prebuild)` called once with `{ repoId, branch: "main", commit: revision }`; `prebuild` (fake) creates its sandbox with `image === build.imageRef`. |
| `prune_keeps_n_and_referenced` | five ready builds, `ZS_IMAGE_KEEP_PER_REPO = 3`, the oldest referenced by a workspace → two marked `superseded`, fake VCR `delete` called for exactly the unreferenced one beyond three. |
| `prebuild_waits_for_child_build` | `prebuild` on a repo whose image is `building` → `stepRunChild("buildDevcontainerImage")` observed, prebuild row `imageRef` = the new image, `imageBuildId` set. |

### 6.5 Supervisor (b8 delta, Rust unit tests added to b8's tables)

| Test | Asserts |
|---|---|
| `manifest.rs: devcontainer_block_parses_and_defaults` | `{ "configHash": "sha256:…" }` → `source = Checkout`, empty lifecycle; the full fixture block → `source = Manifest`, tagged commands, `services = [Dockerd]`; an unknown `services` value fails deserialisation (typo safety). |
| `bootstrap.rs: effective_devcontainer_prefers_manifest` | with `source = Manifest` no file is read (temp dir has a *different* checkout file) and the marker hash is `configHash`; with `Checkout` the file is loaded and a hash mismatch is logged. |
| `bootstrap.rs: lifecycle_sequence_order` | `on_create`, `update_content`, `post_create` run in order (fake `run_lifecycle` recorder), one marker written after the third. |
| `bootstrap.rs: settings_overlay_merge` | user `{"theme":"One Dark", "lsp": {"a":1}}` (JSONC with comments) over overlay `{"theme":"x","tab_size":2,"lsp":{"b":2}}` → `{"theme":"One Dark","tab_size":2,"lsp":{"a":1,"b":2}}`; arrays replaced; marker covers both. |
| `config.rs: user_name_from_uid` | with `HOME`/`USER` unset and a fake passwd lookup returning `vscode` → `USER=vscode`; fallback to `/etc/zs/user`, then `ubuntu`. |
| `warm.rs: probe_hints_first` | hints `["src/main.rs", "missing.go", "../x"]` → `src/main.rs` first, the other two dropped; feature `node` adds a `.ts` probe when the table found none. |
| `manifest.rs: remote_env_is_filtered` | a manifest `remoteEnv` carrying `LD_PRELOAD`, `PATH` and `ZS_SANDBOX_TOKEN` → none of the three reaches the server environment built for `zed-remote-server` (CONTRACTS §11:614), while a benign key does. |
| `run-local.sh` (b8 §3.24) step (6) gains: with a manifest carrying `source: manifest` and `services: ["dockerd"]`, `docker info` succeeds inside the container within 30 s and `/__test/state` shows a `services` log source (which §3.17 has added to CONTRACTS §7.6 and to the route's enum — otherwise this assertion fails on a rejected batch). |

**`zs-layer-fixup.sh` CI matrix** (`.github/workflows/sandbox-image.yml`, cheap, not gated behind `ZS_E2E`): run the script under `docker run` in `debian:12`, `ubuntu:24.04`, `fedora:41` and `alpine:3` and assert the CONTRACTS §11 invariants — uid 1000 exists, `getent passwd 1000` home is `/vercel`, `/home/<user>` is a symlink to it, `/etc/sudoers.d/sandbox` is 0440 with the four documented lines, `/workspaces` exists and is owned by the user, the four `git config --system` entries are present, `/etc/zs/user` matches the user, and `alpine:3` exits **90**. This is the single point where a foreign base becomes usable; leaving it to the nightly e2e is what turns §7 item 2's `/home/<user>` breakage into a customer report instead of a caught regression.

### 6.6 Integration plan against real sandboxes (`apps/web/tests/e2e/image-build.e2e.test.ts`, run only with `ZS_E2E=1` and real credentials; nightly job `sandbox-image.yml: builder-e2e`, budget 60 min)

0. **Fixtures and prerequisites** (part of the change list, not assumed): create the public GitHub repositories `zs-fixtures/devcontainer-node` (a copy of `vscode-remote-try-node`) and `zs-fixtures/devcontainer-docs` (a trimmed `github/docs` config) under our org and install the GitHub App on them; verify `Sandbox.get(name, { resume: false })` resolves for a `persistent: false` sandbox (§3.4) and verify the VCR REST `DELETE` path against `https://openapi.vercel.sh/` (§7 item 4). Steps 2-4 below depend on all three.
1. **Builder image smoke** (after `build-builder.sh --push` reports ready): `Sandbox.create({ image: ZS_BUILDER_IMAGE_REF, ports: [], persistent: false })` → `runCommand("zs-build-devcontainer", [], { env: { ZS_SELFTEST: "1" } })` → the driver's self-test path starts `dockerd`, runs `docker run --rm hello-world`, `devcontainer --version` prints `0.89.0`, exits 0 in < 90 s. Verifies rootful Docker in the sandbox and the CLI install.
2. **End-to-end build of a public fixture repo** (`zs-fixtures/devcontainer-node`, a copy of `vscode-remote-try-node` under our org, `image:` base): `POST /api/repos` on a preview deployment → `image_builds` row → poll `GET /api/repos/{id}/image-builds` until `ready` (assert < 20 min) → `GET …/log` 303 → the log contains `Login Succeeded`, `phase=push`, a `sha256:` digest → `vcr.getImage` reports `ready`, `arch amd64`, `kind manifest`.
3. **Dockerfile + Features fixture** (`zs-fixtures/devcontainer-docs`, a trimmed `github/docs` config: Dockerfile with `ARG VARIANT`, `github-cli` and `docker-in-docker` features, `forwardPorts [4000]`, `postStartCommand`) → ready; then **workspace on the repo image**: `POST /api/workspaces` → running; assert through the manifest/health that `HOME=/vercel`, `id -u` = 1000 (user `node`, moved home), `zs-agent version` prints the builder's build, `docker info` works (services), the `4000` forward exists after `postStartCommand`, and `gh --version` works (Feature installed). Then `rebuild` → tarball restore works on the repo image (D9 paths present).
4. **Prebuild on the repo image**: `POST /api/repos/{id}/prebuilds { branch: main }` → ready; a workspace created from the snapshot opens a `.ts` file and `/health.worktrees`/LSP status shows `typescript-language-server`/`vtsls` running without a download (assert `languages_dir` non-empty in the snapshot via a `readFile`).
5. **Negative paths**: fixture with `dockerComposeFile` → `POST /api/repos` summary `status: error, code unsupported_compose`; fixture whose Dockerfile `FROM alpine` → build fails with `unsupported_base` (exit 13, message from fixup step 1) shown in the dashboard; fixture producing an image over the uncompressed pre-check (`RUN fallocate -l 7G`, comfortably under the 32 GB disk so the failure is the guard and not ENOSPC) → `image_too_large` at step 7; and a fixture whose single layer is ~600 MB of **already-compressed** content (random bytes) → passes the uncompressed guard, is pushed, and is then failed by `stepVerifyRegistryLimits` with `image_too_large:layer_compressed` — the case an uncompressed-only guard misses.
6. **Credential hygiene**: the driver's self-test mode asserts, after `docker login`, that (a) `env | grep -c ZS_VCR_` is 0, (b) `/var/lib/zs-builder/docker-push/config.json` is 0600 and `/var/lib/zs-builder/docker-anon` contains **no** `config.json`, (c) `tr '\\0' '\\n' < /proc/$(pgrep -f '^dockerd')/environ | grep -c 'ZS_VCR\\|zsb_'` is 0 (the `env -u` before `sudo dockerd`, given `Defaults !env_reset`), and (d) a build of a throwaway Dockerfile whose body is `FROM vcr.vercel.com/$TEAM/$PROJECT/zs-workspace:$BUILD` **fails to authenticate** — proving the CLI's `DOCKER_CONFIG` carries no credential — while the same reference is rejected earlier at admission by §3.1 rule 4. The workspace sandbox of step 3 gets `runCommand("sh", ["-lc", "env | grep -c 'ZS_VCR\\|VERCEL_TOKEN'"])` → `0`, and `ls ~/.docker` → absent.
7. **Deploy drift**: with `ZS_SERVER_BUILD_ID` flipped on a second preview, `POST /api/workspaces` for the fixture repo → 202 on the stale image (bundle still served), `WorkspaceView.image.stale = true`, and a `stale` build row appears and completes.

---

## 7. Risks and open questions

1. **Layering direction vs BUILD-SPEC:311 wording.** The spec says "layered on our base"; §3.14 puts the user's image at the bottom and our layer on top because `image:` configs cannot be placed on top of anything and the Vercel docs impose no base requirement. The consequence — no preinstalled language servers in repo images — is mitigated by the prebuild warm-up and by Zed's own downloader; the spec sentence should be amended to "layered with our supervisor and server on top". Needs the tech lead's nod (D-number).
2. **`HOME=/vercel` on foreign bases.** Fixup step 4 moves the uid-1000 user's home (Feature `common-utils` and dotfiles-style images write `.bashrc`/`.zshrc` into `/home/<user>`); `usermod -m` handles it, but an image that hard-codes `/home/vscode` in scripts (`postCreateCommand: "source /home/vscode/.nvm/nvm.sh"`) will break. A symlink `/home/<user> → /vercel` is left behind by the fixup (added to step 4) to soften this; documented in the dashboard warnings when `remoteUser` is set.
3. **Registry credential from inside a sandbox.** Documented: `docker login vcr.vercel.com -u $VERCEL_TEAM_ID` with a Vercel access token; the CLI's `oidc` username uses a project-scoped OIDC token the CLI mints. Whether a Vercel-Function-minted OIDC token (`getVercelOidcToken()`) is accepted by `vcr.vercel.com` is **unverified** (audience/claims may differ) — hence `ZS_VCR_AUTH` defaults to `token`, e2e step 1 also runs under `oidc`, and the default flips to `oidc` if it works (12-hour, project-scoped, no long-lived token in the builder). Under `token`, the team token has broad scope; mitigation is the builder's isolation (§3.8 table), `env -i` around the CLI, pre-resolved `${localEnv}` (so `build.args` cannot exfiltrate the environment) and a dedicated least-privileged Vercel account/token if the platform offers scoped tokens.
4. **VCR REST delete endpoint.** `vercel vcr image rm` exists in the CLI; the published REST docs cover only `GET …/images` and `GET …/images/{imageIdOrDigest}`. `deleteImage` assumes `DELETE /v1/vcr/repository/{idOrName}/images/{imageId}`; gc treats 404/405 as "not deletable, keep row `superseded`" and logs, so a wrong path costs storage ($0.10/GB), not correctness. **Verifying it against `https://openapi.vercel.sh/` is e2e step 0, not a first-use surprise** — `stepDeleteVcrImage`, gc's prune loop, `stepReconcileOrphanImages` and §6.4's `prune_keeps_n_and_referenced` all rest on it.
5. **zstd and OCI media types.** The documented zstd path (`--output type=image,…,compression=zstd`) works with the docker-container Buildx driver, which cannot use the locally built devcontainer stage as `FROM` without an extra push. The driver pushes the classic way (gzip, accepted by VCR). If VCR preparation is measurably slower for gzip, switch step 5 to `devcontainer build --push --image-name <fullRef>-stage` and build the layer with the container driver from the registry.
6. **Feature allowlist semantics.** Dropping a non-allowlisted Feature with a warning (instead of failing the build, as Codespaces would) keeps most real configs (github/docs, TypeScript) buildable but silently changes the environment; the dashboard shows the warnings prominently and `hostRequirements`/`remoteUser` warnings are informational. Decide whether org policy may make `feature_not_allowed` fatal (`repos.strict_devcontainer`).
7. **Multiple configs** (`.devcontainer/<subfolder>/devcontainer.json`) are not selectable in v1; the first two lookup paths only. Adding a `devcontainerPath` input to `POST /api/workspaces` and `image_builds` is additive.
8. **Docker inside a Firecracker VM.** Verified by Vercel's changelog and KB for `dockerd` + `docker run`; `docker buildx build` with BuildKit under the same daemon is expected to work but is only proven by e2e step 1. Fallback: `DOCKER_BUILDKIT=0` classic builder (the devcontainer CLI supports `--buildkit never`; the layer Dockerfile avoids BuildKit-only syntax except `--chmod`, which has a `RUN chmod` fallback path in the template).
9. **Headless client choice.** `warm.rs` re-implements a sliver of the client protocol; if the server's language detection ever requires client-provided settings/toolchains (Zed's `Project::open_buffer` path does more than the headless handler), the upgrade is a `zs-warm` binary on b1's `WebSocketRemoteConnection` with `gpui::Application::headless()`. Build cost ≈ 30 min and ≈ 100 MB per image; not for v1.
10. **Stale-image window.** After a deploy, a repo image built for build B is used for new workspaces while bundle B is still on disk (`ZS_EDITOR_BUNDLES_KEEP = 5`); those workspaces stay on B until "Rebuild". This mirrors b9's existing-workspace behaviour; the cron could proactively rebuild images for repos used in the last 30 days (`trigger: "stale"`) — not scheduled here to avoid a build storm per deploy; open.
11. **Image size and build time budgets.** 45 min build + 30 min readiness; the builder is sized from `hostRequirements` between `ZS_BUILDER_VCPUS` and `ZS_BUILDER_MAX_VCPUS` (§3.8) rather than fixed at 4 — the `github/docs` fixture already declares `memory: "16gb"`, and 2 048 MB/vCPU means a 4-vCPU builder has 8 GB, where a Rust/Java Feature stack is the difference between a build and an undiagnosable `build_timeout`. A Rust-toolchain Dockerfile plus Features can still approach 45 min; both budgets are env-tunable.
12. **GitHub push payload heuristics.** `pushTouchesDevcontainer` reads `commits[].{added,modified,removed}` (≤ 2048 commits) and falls back to the compare API; a force-push with `before = 0000…` builds unconditionally (safe, one extra build).
13. **Per-branch images without prebuild.** Non-default, non-prebuild branches build lazily at create (409 `image_building` on first open of that branch when its devcontainer differs). Codespaces shows a progress screen here; our dashboard polls and re-submits. Acceptable for v1.
14. **VCR quotas.** Pro allows 1,000 repositories per project — one per repo with a devcontainer; at ~1,000 active devcontainer repos the naming scheme must move to a shared repository with `<slug>-<hash>` tags. Tracked, not designed. Because the failure mode at the cap is silent ("new repos cannot build"), the gc workflow emits the repository count each run and the sweep alerts at 80 % of the quota.
15. **Proxy CA inside build containers.** Only matters if the builder's network policy gains firewall transformation rules; the builder runs `allow-all`. If an org allowlist is ever applied to builders, mount `/etc/pki/ca-trust/source/anchors/vercel-proxy-ca.pem` into the devcontainer build via `--build-arg`-driven `COPY` (Vercel's runtimes doc, §2.7).
16. **`onCreateCommand`/`updateContentCommand` support** goes beyond BUILD-SPEC:309's list (a compatibility extension, §3.1 step 6, D37). If the tech lead prefers the literal list, the normaliser keeps them as `unsupported_lifecycle` warnings — a one-line switch.
17. **`customizations.zed.settings` allowlist width.** The presentation-only allowlist (§3.1 rule 9) rejects the keys a repo most wants to set — a project-standard formatter binary, a task list, an MCP context server. Widening it needs a per-repo, per-user opt-in ("this repository wants to configure language servers and tasks — allow?") stored beside the extensions opt-in, not a longer allowlist. Not in v1.
18. **`persistent: false` and `Sandbox.get`.** The workflow re-`get`s the builder from three separate function invocations over up to 45 minutes. b9's `SandboxApi.create` uses `getOrCreate({ persistent: true })` precisely so later steps can re-`get`; the SDK does not document what `persistent: false` does to name resolution. e2e step 0 settles it before the workflow relies on it; the fallback is `persistent: true` with the snapshot options omitted and `stepDeleteBuilder({ deleteSnapshots: true })` as the only hygiene.
19. **Build cache correctness.** `--cache-to type=registry,mode=max` writes a `cache-<contentHash16>` tag into the same repository the workspace image lives in, so cache blobs count toward the 10 000-tag and 15 GB-per-image quotas and are visible to anything that can pull the repository. If VCR ever rejects cache manifests (they are OCI artifacts, not runnable images), the fallback is `--cache-to type=inline` on the final image, which caches less but needs no extra tag.

---

## 8. Review log (round 1, 2026-09-02)

Two reviews, both `blocking`. Every finding was checked against the trees before acting; the verdict column says what I found, the action column says what changed above. "Confirmed" means I reproduced the reviewer's evidence myself.

### 8.1 Review A — anchors, signatures and coverage

| # | Finding | Verdict | Action |
|---|---|---|---|
| A1 | §1 says `apps/web` is still the Next.js scaffold with no `lib/`, `workflows/`, `app/api/` | **Confirmed** (and the reviewer's own inventory was already stale: `lib/` has **37** modules, not 22; `package.json` is **64** lines, not 61 or 44; `app/api/**` now holds ~30 route handlers incl. `repos`, `workspaces`, `sandboxes/[name]/*`, `webhooks`, `cron/*`) | §1 preamble rewritten with the verified inventory, including what is genuinely absent (`workflows/{prebuild,gc}.ts`, dashboard pages, `public/editor/*`, `packages/`). New §2.4b table of real `apps/web` code anchors. |
| A2 | §1/§2.4 say `sandbox/supervisor/` is empty, so §3.16 is written against a brief | **Confirmed** — 18 sources, 5 470 lines; `manifest.rs:67/201/440/483/495`, `bootstrap.rs:187`, `warm.rs:69`, `Cargo.toml:38` all read | §2.3 gains a code-anchor row; §2.4's b8-lag row is superseded; §3.16 rewritten against the real signatures. `sandbox/image/` **is** empty — that part of the claim stands, and §3 marks the b8 files `†`. |
| A3 | The WebSocket transport has landed (`transport/websocket.rs`, 1 243 lines; `remote_client.rs:1329` dispatches it), so §3.15's rejection of option (c) is argued from a false premise | **Confirmed** | §2.6 row rewritten; §3.15 option (c) re-argued on the real obstacle (the `RemoteClient`/`Project`/gpui graph, not the missing transport). |
| A4 | `headless_project.rs` anchors wrong (`:106`, `:302`, `:582-608`) | **Confirmed** — `:115` `languages::init`, `:318` registration, `:657` definition; `:299` is `subscribe_to_entity` | §2.6 corrected. |
| A5 | `server.rs:542-558`, `:704-705` wrong | **Confirmed** — `:556` `init_paths`, `:560` `languages_dir()`, `:764` `set_language_server_download_dir` | §2.6 corrected. |
| A6 | `remote_client.rs:1330`/`:1597` wrong | **Confirmed** — `:1377` enum, `:1656` trait | §2.6 corrected. |
| A7 | `next.config.ts:1-7` "empty config" | **Confirmed** — 39 lines: COOP/COEP/CORP, frame/referrer headers, editor caching, `withWorkflow` | §2.5 corrected (`tsconfig.json:21-23` was right). |
| A8 | `package.json:11-32` / `:43` wrong | **Confirmed** — deps `:19-40`, `packageManager` `:63` | §2.5 corrected. |
| A9 | §3.1 rule 8: `infraPorts()` does not contain 8449-8451, so a `forwardPorts: [8450]` passes | **Rejected** — `lib/env.ts:278-286` seeds the set with the whole `INFRA_PORT_MIN(8443)..INFRA_PORT_MAX(8451)` range before unioning rpc/health/slots. The reviewer read only the union tail. | Rule 8 keeps its behaviour; §2.4b and the rule now cite `lib/env.ts:278-286` explicitly so this is not re-litigated. §6.1's `ports` case adds 8450. |
| A10 | §2.7's containers.dev row lists substitutions the page does not document; `${containerEnv:…}` is `remoteEnv`-only; the page documents no discovery paths | **Partially confirmed** — I re-fetched the page: it documents **seven** forms (the reviewer's "exactly four" is wrong: `${containerWorkspaceFolder}` and both Basename forms are there), `:default` only on the two Env forms, `${devcontainerId}` restricted to named properties, **and the reviewer is right** that `${containerEnv:…}` is `remoteEnv`-only and that discovery paths are not on that page | §2.7 row rewritten to the exact seven forms; §3.1's `substitute` no longer resolves `${containerEnv:…}` in `build.args`/`containerEnv` (kept verbatim + warned), and `substituteDeep`'s option becomes `allowContainerEnv` for `remoteEnv` only. |
| A11 | `RealSandboxHandle.runDetached` drops `timeoutMs`, so the 45-min hard budget does not exist in production | **Confirmed** — `lib/sandbox.ts:230-243` builds `runCommand` without it although `RunInput:44` declares it | §3.4 change list now includes forwarding `timeoutMs` in `run` **and** `runDetached`; §2.4b flags it; §6.4 adds `builder_command_carries_budget` asserting it on the real handle, not only the fake. |
| A12 | `persistent: false` is not "no snapshot"; `snapshotExpiration: 0` means *never expires*; the two options contradict each other | **Confirmed** — `sandbox.d.ts:105-134` | §2.5 row added; §3.4 makes both snapshot fields optional; §3.8 omits them and keeps `persistent: false` + explicit deletion. `keepLastSnapshots` is an object with `count: 1..10`, so "0" was never expressible. |
| A13 | The sandbox-name regex is not in `lib/api.ts`/`lib/sandbox-auth.ts` | **Confirmed with a correction** — it is in `lib/ids.ts:14` and `lib/types.ts:24`; `lib/api.ts` has no copy; `lib/sandbox-auth.ts` **does exist** (the reviewer says it does not) but holds no regex | §3.4 names the two real definitions; §2.4b anchors them. |
| A14 | §4.5 does not reproduce CONTRACTS:612 (missing `RUSTUP_HOME`/`CARGO_HOME`) and invents `ZS_DEVCONTAINER_HASH` | **Confirmed** | §4.5 adds both vars and drops `ZS_DEVCONTAINER_HASH` (the `LABEL` already carries the hash). |
| A15 | `contentHash` as `"sha256:<hex>"` breaks the committed fixture and `lib/github.ts`'s bare hex, with no migration | **Confirmed** — `manifest.example.json:57` is 64 bare hex; `lib/github.ts:180` produces bare hex; `lib/manifest.ts:156,199` ship it | §3.1 switches to bare hex and says why; §4.4 pins `/^[0-9a-f]{64}$/`; §3.16 keeps the supervisor's own marker shape separate. |
| A16 | §3.16 declares a second `LifecycleCommand` in `manifest.rs` (duplicate definition) and a `From<checkout::LifecycleCommand>` with no such module | **Confirmed** — `manifest.rs:483` already defines the untagged enum | Renamed to `ManifestLifecycleCommand`; the conversion goes `From<ManifestLifecycleCommand> for LifecycleCommand`; `LifecycleSpec` updated. |
| A17 | Staleness via `fs.existsSync("public/editor/<b>/build.json")` cannot work in a Function | **Confirmed** (see also B8) | §3.3 adds `ZS_EDITOR_BUNDLES` + `servedEditorBundles()`; §3.7 step 5 uses it; §6.2 runs the rule with a cwd that has no `public/`. |
| A18 | `getDefaultUser` is `@internal` and not exposed by `SandboxHandle`, so §4.5's rationale has no implementation path | **Confirmed** — `sandbox.d.ts:944` | §2.5 and §4.5 rewritten: the runtime name comes from `User::from_uid` + `/etc/zs/user`; `getDefaultUser` is cited only as evidence the platform tolerates a foreign uid-1000 name. |
| A19 | "`GET /api/repos` lists the same summary from the row (no GitHub calls)" contradicts b9 | **Confirmed** — `b9:1153` is live-from-GitHub, cached 60 s | §3.10 row corrected; §2.4 gains the anchor. |
| A20 | `nix` has no `unistd` feature | **Confirmed** — `Cargo.toml:38` has `["signal","process"]`; `User::from_uid` is behind `user` | §5 rewritten (the conclusion "add `user`" survives; the parenthetical is gone). |
| A21 | octokit `:9930` is the `compareCommits` deprecation note | **Confirmed** — the declaration is `:10031`; `:5828`/`:11139` were right | §2.5 corrected. |
| A22 | `@vercel/blob/dist/index.d.ts:2` does not export `put`; `presignUrl` is two-argument | **Confirmed** | §2.5 corrected; §3.8 writes the two-argument call. |
| A23 | §2.1 attributes "builder declares no ports" to D21 | **Confirmed** — `DECISIONS.md:30` says nothing about builders | §2.1 row corrected; the decision is now ours, recorded as D35 in §3.18. |

Coverage gaps from Review A:

| # | Gap | Verdict | Action |
|---|---|---|---|
| A24 | `stepDeleteVcrImage`, `stepResolveImageForPrebuild`, `stepSetPrebuildStatus`, `stepReposWithImages` used but never declared | Confirmed | All four declared in §3.8 (plus `stepReconcileOrphanImages`, `stepVerifyRegistryLimits`). |
| A25 | §3.9 returns `build.imageRef!`, null at load time | Confirmed | Returns `pushed.imageRef` from step 6; §3.9 says why. |
| A26 | `resolveRepoImage` opts do not match its four call sites | Confirmed | `ResolveOpts` in §3.7: `admit`/`trigger` required, `userId`/`allowBase`/`branch`/`thenPrebuildBranch` optional and forwarded into `admitImageBuild`. |
| A27 | `ImageBuildTrigger` never declared | Confirmed | Exported in §3.7 from the pgEnum's values. |
| A28 | `lib/sandbox.ts` must forward `timeoutMs` | Confirmed | See A11. |
| A29 | `stepStartBuilder`'s reuse rule needs a non-blocking exit-code read | Confirmed — `SandboxHandle` has only `waitCommand`/`killCommand` | §3.4 adds `commandStatus(cmdId)`; §3.8 step 1 uses it. |
| A30 | `services` log source missing from CONTRACTS §7.6 and from the enum widening | Confirmed — `CONTRACTS.md:453` has neither `builder` nor `services` | §3.10 widens both; §3.17 amends §7.6, incl. `LogBatch` fields for `ib-` principals and the drop policy. |
| A31 | Files listed as *modified* that do not exist | Confirmed for `workflows/{prebuild,gc}.ts`, dashboard pages, `.github/workflows/sandbox-image.yml`, `docs/contracts/{sandbox-manifest.v1.json,sandbox-api.md}`, `sandbox/image/Dockerfile`; **not** for `lib/manifest.ts`, `lib/sandbox-auth.ts`, `workflows/steps/db-steps.ts`, `app/api/{repos,workspaces,webhooks/github,cron/sweep,workspaces/[id]/rebuild}/route.ts`, which all exist | Change list marks the genuinely absent ones `†` and leaves the existing ones as plain *modified*. |
| A32 | `packages/` does not exist; `scripts/emit-schemas.ts` was never in the change list | Confirmed | Schema moved to `apps/web/lib/devcontainer/schema.ts`; `scripts/emit-schemas.ts` added to the change list and §3.17. |
| A33 | `ARG ZS_BUILD_ID` never declared in the builder Dockerfile | Confirmed | Declared, plus an equality assertion against the inherited image `ENV`, plus `/opt/zs/layer/LAYER_VERSION`. |
| A34 | `$OLDHOME` never assigned in `zs-layer-fixup.sh` | Confirmed | Assigned from `getent passwd 1000`; the `/home/<user>` symlink is now part of step 4. |
| A35 | `zs-agent version` runs before `ZS_BUILD_ID` is set | Confirmed — CONTRACTS §7.1's `version` row prints it | The layer template passes `ZS_BUILD_ID` as a build `ARG` into the fixup `RUN`. |
| A36 | `write_settings`'s new arity forces caller updates that are not listed | Confirmed — `bootstrap.rs:187` is `(docs, home, markers)` | §3.16 states the change and names the callers. |
| A37 | `pick_probe_files` arity inconsistent between §2.3/§3.15 and §3.16 | Confirmed | One arity everywhere: `(root, hints, feature_langs)`. |
| A38 | No migration for the hash format | Confirmed | Moot: the format no longer changes (A15). |
| A39 | `stepPresignLogUpload` is dead code beside the route's inline computation | Confirmed | Demoted to a plain function `presignLogUpload` used by both. |
| A40 | The devcontainer CLI is handed `DOCKER_CONFIG=/vercel/.docker`, the directory `docker login` wrote into | Confirmed — this is the same defect as B1 | Two config dirs (`docker-push` / `docker-anon`); §6.6 step 6 tests it. |
| A41 | `sudo dockerd` before the credential is unset, under `Defaults !env_reset` | Confirmed | Driver reordered: spec → `env -u … sudo -n dockerd` → login; §6.6 checks `/proc/<dockerd>/environ`. |
| A42 | e2e depends on `zs-fixtures/*` repos that do not exist | Confirmed | New e2e step 0 creates them and gates steps 2-4 on it. |
| A43 | The VCR REST delete path is unverified | Confirmed | §7 item 4 sharpened and the verification moved into e2e step 0. |

### 8.2 Review B — security and design

| # | Finding | Verdict | Action |
|---|---|---|---|
| B1 | The registry credential reaches the devcontainer CLI through `DOCKER_CONFIG`, so a user Dockerfile can `FROM vcr.vercel.com/…/zs-workspace` (or another tenant's repo image), and the credential is push-scoped project-wide | **Confirmed, highest severity** | Split `DOCKER_CONFIG` (§3.13 steps 3/5/8), §3.1 rule 4 rejects `vcr.vercel.com` in any `FROM`/`--from`, §3.8's table rewritten (it no longer claims `env -i` protects anything), §6.6 step 6 adds a negative authentication test. Moving `zs-workspace`/`zs-builder` to a project the builder credential cannot reach and flipping to `ZS_VCR_AUTH=oidc` stay in §7 item 3. |
| B2 | Workspaces are created from a mutable tag, violating BUILD-SPEC:433 | **Confirmed** — and a forced rebuild deliberately re-pushes the same tag | `projectImageRef(repository, digest)`; `imageTag` becomes a label (`<contentHash16>-<serverBuild>[-a<attempt>]`); `stepPickImage`/`stepReserveWorkspace` store the digest ref; §6.2 asserts it. |
| B3 | `result.imageRef` is builder-supplied and flows into `Sandbox.create({ image })` | **Confirmed** | Dropped from the wire (§4.6); recomputed in `stepVerifyPushed`, which now also asserts `tags` contains our tag; §6.3 tests a foreign ref. |
| B4 | `containerEnv`/`remoteEnv` are not filtered against `RESERVED_SECRET_NAMES`/`ZS_*` | **Confirmed** — CONTRACTS §11:614 unions `remoteEnv` unfiltered, and `containerEnv` becomes image `ENV`, i.e. `zs-agent`'s own environment | §3.1 rule 7 filters both (`^ZS_`, `RESERVED_SECRET_NAMES`, `LD_*`/`GIT_*`/`NODE_OPTIONS`/`PYTHONSTARTUP`/`PYTHONPATH`), §4.5 re-asserts it, §3.16 filters again in the supervisor; §6.1 `env_keys_are_filtered`, §6.5 `remote_env_is_filtered`. |
| B5 | `customizations.zed.settings` is an unvalidated blob = code execution on open (fork PRs included) | **Confirmed** | Presentation-only allowlist in §3.1 rule 9 + `zedSettingsOverlay` in §4.1; repo-declared extensions need a per-repo opt-in; §6.1 `zed_settings_allowlist`; D39; §7 item 17 for widening by opt-in. |
| B6 | `stepStartBuilder` rotates the token before the reuse check, 401ing a live builder on retry | **Confirmed** | Step order inverted and spelled out; §6.4's `retry_reuses_running_builder` now asserts *zero* rotations. |
| B7 | `keepLastSnapshots: 1` contradicts "never snapshotted"; and `get()` semantics under `persistent: false` are unverified | **Confirmed** | Both snapshot options omitted (A12); §3.4 and §7 item 18 record the `get()` question and the fallback; e2e step 0 settles it. |
| B8 | The stale-reuse path can never fire in production (`public/` is not in the function bundle) | **Confirmed** | Same fix as A17. |
| B9 | `contextTreeSha` + a constant `DEVCONTAINER_TOUCH` disagree in both directions | **Confirmed** — `context: "."` rebuilds on every commit; `build.dockerfile: "../Dockerfile"` never rebuilds; two of six fixtures use `build.dockerfile` | §3.5 `devcontainerTouchMatcher(repo)` derives the filter from the stored config; `contextDigestFor` replaces the whole-tree sha (`.dockerignore`-aware walk, `context_unpinned` when it cannot); §6.3 adds both cases. |
| B10 | Size guards are uncompressed while VCR's limits are compressed; 12 GB is unreachable on a 32 GB disk | **Confirmed** | `ZS_IMAGE_MAX_BYTES` default 6 GB as a pre-check; `stepVerifyRegistryLimits` checks compressed layer/total/manifest/config after push; push stderr maps to `image_too_large`; §6.6 step 5 tests the compressed-only case. |
| B11 | `force: true` supersedes the ready row first — a live downgrade | **Confirmed** | Forced rebuild is a new `attempt` with its own tag; supersede happens in `stepRecordImageReady`; the partial unique index keys on `(repo, configHash, attempt)`; §6.3 `forced_rebuild_keeps_previous_ready`. |
| B12 | Nothing enforces that the image's `ZS_BUILD_ID` equals the binaries it contains | **Confirmed** | `/opt/zs/layer/{BUILD_ID,LAYER_VERSION}` written at builder-image build time; driver step 1 fails fast (exit 2, `config`) on mismatch; §4.5 renders the id from the file. |
| B13 | `--no-lockfile` + `version: "latest"` + mutable base tags make the build non-reproducible | **Confirmed** | `--no-lockfile` removed and the lockfile persisted; §3.7 step 3 resolves the base image and every Feature ref to digests (`baseDigests`) and feeds them into `configHash`, so a moved upstream produces a new identity and an automatic rebuild. |
| B14 | No registry allowlist; `# syntax=` frontends execute arbitrary images | **Confirmed** | §3.1 rule 4 (allowlist + Dockerfile scan + `base_registry_not_allowed`), `--omit-syntax-directive` and a pinned `BUILDKIT_SYNTAX` in §3.13; §1's out-of-scope line no longer implies an allowlist that did not exist; §6.1 `base_registry_allowlist`. |
| B15 | The log trap needs `LOG_UPLOAD_URL` before `dockerd` can fail; the blob PUT bypasses `scrub`; the presign is under-specified | **Confirmed** | Driver fetches the spec first; the trap scrubs before upload; §3.8 states single-pathname scope, `maximumSizeInBytes`, and that it cannot address the `rebuild/` prefix (§6.2 `presign_scope`). |

Coverage gaps from Review B:

| # | Gap | Verdict | Action |
|---|---|---|---|
| B16 | No build cache anywhere | Confirmed | `--cache-from`/`--cache-to type=registry,mode=max` keyed on `contentHash16`, tag `<contentHash16>-<serverBuild>` so a server-build-only rebuild rebuilds only our layer; §7 item 19 records the quota/fallback. |
| B17 | No concurrency or cost control outside the manual route | Confirmed | §3.7 admission control: one in-flight build per (repo, branch) with supersede, `repo.image-builds` 20/3600, `ZS_IMAGE_BUILDS_MAX_INFLIGHT_ORG`, spend-cap check, ledger accrual in `stepDeleteBuilder`; §6.2 `admission_caps`. |
| B18 | No throttle on the `stale` trigger — a user-triggered build storm per deploy | Confirmed | `repos.stale_build_cooldown_at` + `ZS_STALE_REBUILD_COOLDOWN_MS`; §6.2 `stale_trigger_cooldown`. |
| B19 | No reconciliation of orphaned VCR images | Confirmed | `stepReconcileOrphanImages` in gc; `stepVerifyPushed` also runs on the failure path; §6.4 `orphan_push_is_recovered`. |
| B20 | `LogBatch` undefined for `ib-` principals; no drop policy | Confirmed | Defined in §3.10 and amended into CONTRACTS §7.6 (§3.17); flusher sets `fields.dropped`/`truncated`. |
| B21 | `repos.image_status` cannot hold `preparing`/`stale` | Confirmed | Enum explicitly **not** widened; §3.2 and §4.7 state that the view derives both. |
| B22 | CONTRACTS.md is never amended | Confirmed | New amendment table in §3.17 and `docs/briefs/CONTRACTS.md` in the change list. |
| B23 | No DECISIONS entries for the choices made over BUILD-SPEC/CONTRACTS | Confirmed | New §3.18 with D35-D40. |
| B24 | `parse_error` ignores `allowBaseFallback` | Confirmed | §3.7 step 2 and §3.10 route it through the same gate with `409 devcontainer_invalid`; §6.3 test added. |
| B25 | The builder is never sized from `hostRequirements` | Confirmed | §3.8 sizes it between `ZS_BUILDER_VCPUS` and `ZS_BUILDER_MAX_VCPUS`; §7 item 11 rewritten. |
| B26 | Security tests missing (env filter, digest ref, foreign `imageRef`, `DOCKER_CONFIG`, settings allowlist, principal refusal on the other sandbox routes) | Confirmed | All six added across §6.1-§6.4 and §6.6. |
| B27 | Correctness tests missing (rotation on retry, Dockerfile outside `.devcontainer/`, failed force, orphan push, sweep reconciliation, infra ports 8450/8451) | Confirmed | All six added. |
| B28 | Hash-stability tests do not cover the marker's side effect | Confirmed | `MARKER_V` versions the marker independently; §6.1 `marker_is_versioned`. |
| B29 | `zs-layer-fixup.sh` has no unit coverage | Confirmed | A four-distro CI matrix in §6.5 asserting the §11 invariants and `exit 90` for alpine. |
| B30 | VCR limits/delete unverified; quota has no monitoring | Confirmed | e2e step 0 verifies the delete path; §7 item 14 adds repository-count reporting and an 80 % alert. |
| B31 | The prompt's AI-proxy concerns are out of scope (D15 → b11) | Confirmed, no conflict | No action; the analogous surfaces inside b10 are B1 and B14, both fixed. |

Two findings were **not** adopted as written: A9 (rejected outright — the shipped `infraPorts()` does cover 8443-8451) and A10 (adopted for the `${containerEnv:…}` restriction and the discovery-path claim, rejected for "only four forms are documented").
