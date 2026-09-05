export const meta = {
  name: 'zs-impl-round1',
  description: 'Implement round 1: WebSocket transport, serve mode, terminals, supervisor+image, control plane; review, fix, integrate',
  phases: [
    { title: 'Implement', detail: 'five lanes, partitioned by directory; skeleton-then-fill where needed' },
    { title: 'Review', detail: 'three adversarial lenses per lane' },
    { title: 'Fix', detail: 'apply accepted findings and re-verify' },
    { title: 'Integrate', detail: 'union compile and test across lanes' },
  ],
}

const REPO = '/Users/ray/Projects/play/wed'
const ZED = `${REPO}/zed`
const B = `${REPO}/docs/briefs`
const DEC = `${B}/DECISIONS.md`
const CON = `${B}/CONTRACTS.md`
const SPEC = `${REPO}/BUILD-SPEC.md`

const ETIQUETTE = `
Working agreements (binding):
- Other agents are editing OTHER parts of this repository at the same time. Only touch the files and crates your lane owns (listed below). If you must touch a shared file (the workspace Cargo.toml, Cargo.lock, crates/proto/proto/zed.proto, crates/proto/src/proto.rs, crates/remote_server/src/server.rs mod declarations), make a minimal additive edit and re-read the file immediately before editing. Never rewrite an existing file wholesale; use targeted edits.
- Never run git checkout, git stash, git reset, git clean, or anything that discards working-tree changes. Do not commit. You may run git diff and git status.
- Cargo commands in ${ZED} share one build directory and serialize on a lock: a check may wait for another lane's check. That is expected; wait for it. Use \`cargo check -p <crate>\` for the crates you touched and \`cargo test -p <crate> <filter>\` for tests you added. Do not run \`cargo build\` of the whole workspace or the \`zed\` binary. Do not run wasm builds in this round.
- The briefs are the plan of record. Follow your brief's change list, signatures and tests exactly unless the code proves the brief wrong; when it does, follow the code and record the deviation in your return value. Precedence when they conflict: ${DEC} (including "Decisions v2", D21 to D34, which were issued AFTER the briefs and CONTRACTS.md were written) beats ${CON}, which beats the brief. Read all of DECISIONS.md before starting.
- Decisions v2 highlights every lane must apply even where its brief says otherwise: D21 port map (8443 rpc; 8444-8447 private proxy slots; 8448 supervisor health; forward pool 3000,3001,4000,5000,5173,8000,8080,8888; loopback 127.0.0.1:8450 supervisor API and 127.0.0.1:8451 serve control listener; infra set 8443-8451 excluded from user forwards). D22 Heartbeat is server to client every 5 s; the server also sends WebSocket protocol pings every 5 s and treats 90 s of silence as dead. D23 close codes: 4001 superseded, 4002 build mismatch, 4003 unauthorized, 4005 session active, 4006 bad Hello, 1001 going away, 1008, 1009; 4004 does not exist. D24 warm = process alive; reconnect with same instance and matching epoch attaches warm; otherwise fresh session resets HeadlessProject; PtyManager lives at server level with a handle accessor and detach_all on detach. D25 Hello.instance per-boot nonce; arbitration keys on (workspace_id, instance). D26 connect returns { wsUrl, token, sessionId, workspaceId, serverBuild, sessionExpiresAt }; WebSocketConnectionOptions::new(url, workspace_id, session_id, token). D27 RemoteConnection::supports_remote_pty (WebSocket true) and ServeHooks::session_detached. D28 after stop/resume, recreate one shell per persisted terminal tab in its cwd; supervisor exports SHELL, HOME, USER, PATH, LANG. D29 ZS_CONTROL_URL (origin + /api) canonical; lifecycle kinds snake_case; ActivityDirective { idleStopAt, sessionCapAt, stop, forwards, serverTime }. D30 host reconnect() = re-POST /connect + reload. D31 vendored crates under zed/vendor/<name>, [workspace] exclude, path [patch]; vendor/README.md with the fixed section shape.
- Write real, complete code: no todo!() or unimplemented!() left behind in non-test code, no stubbed-out behavior described as done. If something cannot be finished, leave it compiling, clearly marked with a \`// ZS-TODO(<lane>):\` comment, and list it under gaps.
- Every new public item gets a doc comment. Match the surrounding crate's style (rustfmt / the repo's eslint+prettier config).
- Before returning, run the compile/test commands for your lane and make them pass; report exact commands and results.`

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    files_changed: { type: 'array', items: { type: 'string' } },
    tests_added: { type: 'array', items: { type: 'string' } },
    verification: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, status: { type: 'string' }, notes: { type: 'string' } }, required: ['command', 'status'] } },
    deviations_from_brief: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['files_changed', 'tests_added', 'verification', 'deviations_from_brief', 'gaps'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'integer' }, severity: { type: 'string', enum: ['blocking', 'major', 'minor'] }, claim: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' } }, required: ['file', 'severity', 'claim', 'evidence', 'fix'] } },
    verdict: { type: 'string' },
  },
  required: ['findings', 'verdict'],
}
const FIX_SCHEMA = {
  type: 'object',
  properties: {
    fixed: { type: 'array', items: { type: 'string' } },
    rejected: { type: 'array', items: { type: 'object', properties: { finding: { type: 'string' }, reason: { type: 'string' } }, required: ['finding', 'reason'] } },
    verification: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, status: { type: 'string' }, notes: { type: 'string' } }, required: ['command', 'status'] } },
    remaining_gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['fixed', 'rejected', 'verification', 'remaining_gaps'],
}

function implPrompt(lane, brief, ownership, task, verify) {
  return `${ETIQUETTE}

Lane: ${lane}
Brief (read it fully first): ${brief}
Also read: ${DEC}, ${CON} (sections relevant to this lane), and the relevant BUILD-SPEC sections in ${SPEC}.
Repository: ${REPO} (Zed fork at ${ZED}, branch zs).
Files and crates this lane owns: ${ownership}

Task:
${task}

Verification you must run before returning:
${verify}`
}

const LENSES = (lane, brief, scope, verifyCmd) => [
  { name: 'correctness', prompt: `You are an adversarial code reviewer for lane ${lane}. Scope: ${scope}. Read the brief ${brief}, ${DEC}, ${CON}, then review the actual diff (\`git -C ${ZED} diff\` limited to the scope, or \`git -C ${REPO} status\`/diff for non-Zed paths; for new untracked files read them directly). Hunt for correctness bugs: wrong protocol semantics, races, unhandled errors, panics on bad input, lifetime/ownership mistakes, wrong Send/!Send assumptions, off-by-one in framing, replay/ack mistakes, resource leaks (sockets, PTYs, tasks), anything the brief's tests would not catch. For each finding give file, line, severity, the concrete failure scenario, evidence, and a fix. Do not modify files. Be specific; a finding without a failure scenario is not a finding.` },
  { name: 'security', prompt: `You are an adversarial security reviewer for lane ${lane}. Scope: ${scope}. Read ${brief} sections on auth and security, ${CON}, and BUILD-SPEC section 10, then review the actual diff and new files. Hunt for: authentication bypass (token verification before upgrade, constant-time comparison, audience/expiry/issuer checks, key handling), path traversal in file endpoints, unbounded allocations from untrusted input (frame sizes, multipart bodies, scrollback), secrets in logs or environment, CORS/origin mistakes, cookie/HMAC misuse, command injection in spawned processes, TOCTOU on filesystem operations, and missing rate limits where the brief requires them. Do not modify files. Give concrete exploit scenarios.` },
  { name: 'spec-compliance', prompt: `You are a spec-compliance reviewer for lane ${lane}. Scope: ${scope}. Compare the implementation against the brief ${brief} change list, types, messages and tests, and against ${CON} and ${DEC}. List every brief item that is missing, partially done, or implemented with a different name/shape/default than the contract; every test the brief specified that was not written; every ZS-TODO left. Also run ${verifyCmd} and report its real result. Do not modify files.` },
]

async function reviewFix(lane, brief, scope, verifyCmd, ownership) {
  const findings = (await parallel(LENSES(lane, brief, scope, verifyCmd).map(l => () => agent(l.prompt, { label: `review:${lane}:${l.name}`, phase: 'Review', schema: REVIEW_SCHEMA })))).filter(Boolean).flatMap(r => r.findings)
  log(`${lane}: ${findings.length} review findings`)
  if (!findings.length) return { lane, findings: 0, fix: null }
  const fix = await agent(`${ETIQUETTE}

Lane: ${lane}. You own: ${ownership}. Brief: ${brief}. Contracts: ${CON}. Decisions: ${DEC}.
Three reviewers produced the findings below (JSON). For each: verify it against the code; if real, fix it properly (not by weakening tests or deleting features); if not real, reject it with a reason. Blocking and major findings must be fixed. Then run: ${verifyCmd} and any tests you touched, and report results. Findings:
${JSON.stringify(findings, null, 2)}`, { label: `fix:${lane}`, phase: 'Fix', schema: FIX_SCHEMA })
  return { lane, findings: findings.length, fix }
}

// ---------------- Lanes ----------------

const laneB1 = async () => {
  const brief = `${B}/b1-ws-transport.md`
  const own = `crates/remote (all files), crates/workspace/src/persistence/model.rs and persistence.rs (only the WebSocket variant per brief), crates/workspace/src/workspace.rs (only the new open_remote_project_in_new_window_with_client entry point per D16), zed/vendor/yawc (vendored copy per D10) and the workspace Cargo.toml [patch] entry for yawc only.`
  const verify = `cd ${ZED} && cargo check -p remote -p workspace && cargo test -p remote websocket`
  const impl = await agent(implPrompt('b1-ws-transport', brief, own, `Implement the whole brief: the WebSocket transport (RemoteConnectionOptions::WebSocket per D1, WebSocketRemoteConnection, the socket bridge, wire.rs serde types, Hello/HelloAck/Heartbeat, epoch, close codes 4001/4005, reconnect with refresh callback and D2 budget, RefreshError::{Unauthorized, Stopped, Other}), the vendored yawc under ${ZED}/vendor/yawc (copy the exact revision from ~/.cargo/git/checkouts, add connect_with_protocols and Drop per the brief, add the [patch] entry, write vendor/README.md per D10), workspace persistence for the new variant, the D16 entry point, and every unit/integration test the brief specifies (the loopback test may use a minimal in-process tungstenite/yawc echo server if b2's serve is not yet available; write it so it can later target serve).`, verify), { label: 'impl:b1', phase: 'Implement', schema: IMPL_SCHEMA })
  const rf = await reviewFix('b1-ws-transport', brief, 'crates/remote, crates/workspace persistence and the new entry point, vendor/yawc', verify, own)
  return { lane: 'b1', impl, review: rf }
}

const laneB2 = async () => {
  const brief = `${B}/b2-serve-mode.md`
  const own = `crates/remote_server (main.rs, server.rs, and new modules serve.rs, auth.rs, files.rs, control.rs, session.rs or as the brief names them), crates/remote_server/Cargo.toml, and the shared helpers in crates/remote/src/protocol.rs ONLY if the brief assigns them to b2 (coordinate: b1 may add the same helpers; re-read before editing and keep signatures identical).`
  const verify = `cd ${ZED} && cargo check -p remote_server && cargo test -p remote_server serve`
  const impl = await agent(implPrompt('b2-serve-mode', brief, own, `Implement the whole brief: the serve subcommand with the public listener (/health, /rpc upgrade with ES256 JWT verification from Sec-WebSocket-Protocol, Hello-time session arbitration with epoch/supersede/4005, warm attach on reconnect, fresh-session HeadlessProject reset per D3, Heartbeat, 16 MiB ceiling, /files upload/download with path confinement and CORS for --allowed-origin, /extensions asset route), the loopback control listener per D5 (--control-secret-file, POST /control/lifecycle|ports|extensions), is_input_envelope exclusions per D20, graceful SIGTERM flush, removal of the idle exit in serve mode, and all tests the brief specifies. Where b3's PtyManager or b4's handlers are referenced but not yet present, define the exact hook points (traits or function signatures named in CONTRACTS.md) so they slot in without changing serve.rs.`, verify), { label: 'impl:b2', phase: 'Implement', schema: IMPL_SCHEMA })
  const rf = await reviewFix('b2-serve-mode', brief, 'crates/remote_server serve/auth/files/control modules and CLI', verify, own)
  return { lane: 'b2', impl, review: rf }
}

const laneB3 = async () => {
  const brief = `${B}/b3-terminals.md`
  const ownServer = `crates/proto/proto/zed.proto and crates/proto/src/proto.rs (terminal messages only, additive), crates/remote_server/src/pty.rs (new) and the handler registrations in crates/remote_server/src/headless_project.rs (terminal handlers only), and the PtyManager hook into serve per CONTRACTS.md.`
  const ownClient = `crates/terminal (remote_pty.rs and TerminalType::Remote per D17), crates/project/src/terminals.rs (remote-over-WebSocket path), crates/terminal_view and crates/workspace persistence only for the D4 terminal-restore items the brief specifies.`
  const verifyServer = `cd ${ZED} && cargo check -p proto -p remote_server && cargo test -p remote_server pty`
  const verifyClient = `cd ${ZED} && cargo check -p terminal -p project -p terminal_view && cargo test -p terminal remote && cargo test -p project remote_terminal`
  const server = await agent(implPrompt('b3-terminals/server', brief, ownServer, `Implement the SERVER half of the brief: the proto messages (SpawnTerminal, TerminalInput, TerminalOutput, AckTerminalOutput if specified, ResizeTerminal, CloseTerminal, TerminalExited, ListTerminals, AttachTerminal) with correct registration and priorities, the PtyManager (bounded scrollback ring, survives sessions per D3: detach_all/kill_all semantics, exit codes, resize), the headless handlers, and the hook by which serve attaches/detaches sessions. Unit tests for PtyManager per the brief.`, verifyServer), { label: 'impl:b3-server', phase: 'Implement', schema: IMPL_SCHEMA })
  const client = await agent(implPrompt('b3-terminals/client', brief, ownClient, `The server half (proto messages, PtyManager, handlers) is already implemented; read the resulting code first (crates/proto, crates/remote_server/src/pty.rs). Implement the CLIENT half: TerminalType::Remote / remote_pty.rs driving alacritty's Term from TerminalOutput on the GPUI executor with the per-turn budget, input/resize/close messages, events (title, bell, exit) so terminal_view is unchanged, Project::create_terminal choosing this path for WebSocket remote projects and keeping ssh behavior, tasks via SpawnTerminal, reattach after reconnect, and the D4 restore path (persist terminal ids/titles/cwd, ListTerminals + AttachTerminal on fresh session). Tests with a fake proto client per the brief.`, verifyClient), { label: 'impl:b3-client', phase: 'Implement', schema: IMPL_SCHEMA })
  const rf = await reviewFix('b3-terminals', brief, 'proto terminal messages, remote_server pty.rs and handlers, crates/terminal remote_pty, project/terminals.rs, terminal restore persistence', `${verifyServer} && ${verifyClient}`, `${ownServer} ${ownClient}`)
  return { lane: 'b3', server, client, review: rf }
}

const laneB8 = async () => {
  const brief = `${B}/b8-supervisor-image.md`
  const own = `${REPO}/sandbox/supervisor (own Cargo workspace), ${REPO}/sandbox/image (Dockerfile, scripts, test mock), ${REPO}/.github/workflows (image and server jobs only), ${REPO}/docs/contracts/fixtures/manifest.example.json`
  const verifyCrate = `cd ${REPO}/sandbox/supervisor && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`
  const skeleton = await agent(implPrompt('b8/skeleton', brief, own, `Create the zs-agent crate skeleton exactly as the brief's module layout specifies: Cargo.toml with the chosen dependencies (verify each version exists with \`cargo search\` or by fetching from crates.io; generate Cargo.lock), main.rs with the clap CLI (start, credential, proxy, resume, prebuild per D14) and ALL module declarations, each module file containing the public signatures from the brief with bodies that compile (return Err(anyhow!("not implemented")) or equivalent, marked // ZS-TODO(b8-skeleton)), the config/env contract as a typed struct, the manifest JSON types with serde, and the docs/contracts/fixtures/manifest.example.json fixture (D19). It must compile (\`cargo check\`) before you return. Also write ${REPO}/sandbox/supervisor/README.md with the env/flag contract table.`, `cd ${REPO}/sandbox/supervisor && cargo check`), { label: 'impl:b8-skeleton', phase: 'Implement', schema: IMPL_SCHEMA })
  const fills = (await parallel([
    () => agent(implPrompt('b8/core', brief, own, `The crate skeleton exists (read it first). Fill in, completely, these modules per the brief: start (manifest fetch with ZS_SANDBOX_TOKEN/ZS_CONTROL_URL, clone-or-restore honoring manifest.repo.ref, dotfiles, postCreate once with marker, JWT public key file, control secret file, spawn zed-remote-server serve with the exact flags from CONTRACTS.md including --allowed-origin, health server on 8445 aggregating server /health, activity relay with busy/phase/cpuBusyPct per D13, log shipping, SIGTERM handling with a stopping budget above 5 s per D18), manifest, config, health, activity, logs, ports watcher (/proc/net/tcp + tcp6 diff every 2 s, POST /control/ports), extensions relay (POST /control/extensions at startup and POST /extensions passthrough). Do NOT edit proxy, credential, prebuild, resume modules (another agent owns them). Unit tests the brief specifies for these modules.`, verifyCrate), { label: 'impl:b8-core', phase: 'Implement', schema: IMPL_SCHEMA }),
    () => agent(implPrompt('b8/proxy-cred', brief, own, `The crate skeleton exists (read it first). Fill in, completely, these modules per the brief and D8/D18: credential (git credential helper protocol; POST /sandboxes/{name}/git-token; never caches), proxy (per-slot reverse proxy for 8444-8447 validating the zs_port_session HMAC cookie, /__zs/auth?zs_port_token=...&next= entry, WebSocket pass-through, x-vercel-protection-bypass where the brief says), resume (what onResume runs), prebuild (D14: headless warm-up driver). Do NOT edit start/manifest/config/health/activity/logs/ports/extensions modules (another agent owns them); if you need a shared helper, add it in a new module you own. Unit tests the brief specifies for these modules.`, verifyCrate), { label: 'impl:b8-proxy', phase: 'Implement', schema: IMPL_SCHEMA }),
    () => agent(implPrompt('b8/image', brief, own, `Implement the image side of the brief: ${REPO}/sandbox/image/Dockerfile (base vercel/sandbox/universal, toolchain and language-server layers with pinned versions, zed-remote-server from the cloud.zed.dev asset URL with a build arg, zs-agent copied from a builder stage that compiles ${REPO}/sandbox/supervisor for x86_64-unknown-linux-musl), .dockerignore, build script using vercel vcr build docker with a local docker fallback, the mock control plane under sandbox/image/test (small Node or Python server implementing the sandbox-facing routes from CONTRACTS.md with the manifest fixture) and a local test script that runs the image with docker and exercises zs-agent start against the mock, plus the CI jobs in .github/workflows for the server binary and image (gated on vars.ZED_FORK_REPO as the brief says). Do not edit supervisor Rust sources. Verify the Dockerfile parses (docker build --check if available, else a dry lint) and the mock server starts.`, `cd ${REPO}/sandbox/image && ls && (docker build --check -f Dockerfile . || true)`), { label: 'impl:b8-image', phase: 'Implement', schema: IMPL_SCHEMA }),
  ])).filter(Boolean)
  const rf = await reviewFix('b8-supervisor-image', brief, 'sandbox/supervisor crate, sandbox/image Dockerfile and scripts, CI jobs', verifyCrate, own)
  return { lane: 'b8', skeleton, fills, review: rf }
}

const laneB9 = async () => {
  const brief = `${B}/b9-control-plane.md`
  const own = `${REPO}/apps/web (Next.js app; scaffolded with create-next-app: app router, TypeScript, Tailwind 4, ESLint, pnpm), ${REPO}/infra/vercel.ts if the brief places it at the app root instead adjust, ${REPO}/.github/workflows (web job only).`
  const verifyWeb = `cd ${REPO}/apps/web && pnpm install --frozen-lockfile=false && pnpm lint && pnpm exec tsc --noEmit && pnpm test`
  const foundation = await agent(implPrompt('b9/foundation', brief, own, `The app is scaffolded (Next.js 16, React 19, Tailwind 4, pnpm; read apps/web/package.json and the tree). Implement the FOUNDATION per the brief: dependencies with the versions the brief verified (add with pnpm add; do not guess versions: check the registry), Drizzle schema for every table in BUILD-SPEC 7.2 as the brief specifies plus migrations config, lib/db.ts (Postgres via the Marketplace env var names the brief names; local dev via the option the brief chose), lib/auth.ts (Clerk: middleware/proxy per the brief, auth() helpers, org roles), lib/tokens.ts (ES256 JWT minting with jose, kid rotation, 1 h), lib/crypto.ts (AES-256-GCM secrets with versioned key), lib/usage.ts (ledger math), lib/env.ts (typed env contract, ZS_* names from CONTRACTS.md), vitest setup with tests for tokens, crypto and usage, and the README section documenting env vars and the Marketplace integrations to install (vercel integration add commands) — do NOT attempt to provision integrations or deploy. Leave route handlers, workflows, shell page and dashboard to other agents but create the directory skeleton and shared types (lib/types.ts, lib/api.ts response helpers) they will import. Ensure pnpm lint, tsc --noEmit and pnpm test pass.`, verifyWeb), { label: 'impl:b9-foundation', phase: 'Implement', schema: IMPL_SCHEMA })
  const fills = (await parallel([
    () => agent(implPrompt('b9/lifecycle', brief, own, `Foundation exists (read lib/*, schema, env). Implement per the brief: lib/sandbox.ts (thin typed wrapper over @vercel/sandbox v2 for create/get/getOrCreate/stop/extendTimeout/update ports/domain/snapshot with the exact options from CONTRACTS.md: ports 8443 + 8444-8447 + forward pool, resources, region, env, networkPolicy, persistent, onResume, no git source per D19), workflows/*.ts (createWorkspace, connectWorkspace, stopWorkspace, rebuildWorkspace with the D9 tarball, deleteWorkspace, prebuild, gc) using Workflow DevKit "use workflow"/"use step" exactly as the brief specifies (verify the installed workflow package docs under node_modules/workflow/docs), the sandbox-facing route handlers (manifest, git-token, ports, activity honoring busy/phase per D13, logs, client-errors, extensions relay) authenticated by the per-sandbox bearer token, the cron sweep route and vercel.ts crons/headers, and vitest tests with the SDK mocked. Do not edit user-facing routes, the shell page or dashboard.`, verifyWeb), { label: 'impl:b9-lifecycle', phase: 'Implement', schema: IMPL_SCHEMA }),
    () => agent(implPrompt('b9/user-api', brief, own, `Foundation exists (read lib/*, schema, env). Implement per the brief: the user-facing route handlers under app/api (workspaces CRUD/connect/stop/rebuild/keepalive, ports incl. private-slot allocation per D8 and the /open redirect, repos and prebuilds, me/settings, me/keymap, me/dotfiles, secrets scoped), lib/github.ts (GitHub App: installation tokens via octokit, repo listing, clone URL construction; webhook signature verification) and the webhooks routes (github push→prebuild via the queue/workflow the brief specifies, installation events; stripe stub per brief), plus vitest tests for handlers with mocked db and SDK. Do not edit workflows/*.ts, the shell page or dashboard.`, verifyWeb), { label: 'impl:b9-user-api', phase: 'Implement', schema: IMPL_SCHEMA }),
    () => agent(implPrompt('b9/shell', brief, own, `Foundation exists. Implement per the brief section on the editor shell: app/w/[id]/page.tsx (server component gating on auth), the client component that loads /editor/<build>/zed_web.js via the host bridge contract in CONTRACTS.md (connect → {wsUrl, token, sessionId, workspaceId}, boot overlay stages, reconnect overlay, takeover dialog, lifecycle toasts, host extensions onClosed/onLifecycle/keepAlive/stop/setDirty/openExternal per b9 §7 item 6, a terminal 'stopped' state that offers resume), the COOP/COEP/CSP headers scoped to /w/* and /editor/* in next.config.ts or vercel.ts as the brief chose, the static /editor/<build>/ placeholder with a README explaining the bundle drop-in and a tiny stub zed_web.js so the page renders a "bundle not built" state in dev, the PWA manifest, and component tests. Do not edit route handlers or workflows.`, verifyWeb), { label: 'impl:b9-shell', phase: 'Implement', schema: IMPL_SCHEMA }),
    () => agent(implPrompt('b9/dashboard', brief, own, `Foundation exists. Implement per the brief section 7.7 dashboard: workspace list with state/repo/branch/machine/last active/cost, create flow (installation → repo → branch or PR → machine → region, devcontainer detection), workspace detail (stop/rebuild/delete/ports), repo settings (prebuild branches, default machine, idle timeout), secrets, dotfiles, settings and keymap editor, usage and billing view, org and audit log pages; server components calling the lib layer and the API contracts (read the route handler files if they exist; otherwise code to the contracts in CONTRACTS.md), accessible forms, loading and error states, Tailwind 4 styling consistent with the app. Component tests for the create flow and workspace list. Do not edit route handlers, workflows or the shell page.`, verifyWeb), { label: 'impl:b9-dashboard', phase: 'Implement', schema: IMPL_SCHEMA }),
  ])).filter(Boolean)
  const rf = await reviewFix('b9-control-plane', brief, 'apps/web (lib, schema, workflows, api routes, shell page, dashboard)', verifyWeb, own)
  return { lane: 'b9', foundation, fills, review: rf }
}

phase('Implement')
log('Round 1: five lanes starting')
const lanes = (await parallel([laneB1, laneB2, laneB3, laneB8, laneB9])).filter(Boolean)

phase('Integrate')
const integ = await agent(`${ETIQUETTE}

You are the round-1 integrator. Lanes b1 (crates/remote, workspace persistence), b2 (remote_server serve), b3 (proto terminal messages, remote_server pty, terminal, project) have landed in ${ZED}; b8 (${REPO}/sandbox/supervisor, sandbox/image) and b9 (${REPO}/apps/web) landed outside it. Read ${CON} and ${DEC}. Then:
1. Run \`cd ${ZED} && cargo check -p remote -p remote_server -p terminal -p project -p terminal_view -p workspace -p proto\` and fix every error and warning-as-error that stems from cross-lane interaction (mismatched helper signatures between b1 and b2, missing hook wiring between serve and PtyManager, proto registration collisions). Keep fixes minimal and consistent with the briefs; do not redesign.
2. Run \`cargo test -p remote -p remote_server -p terminal -p project\` filtered to the new tests (websocket, serve, pty, remote) and make them pass.
3. Run \`cd ${REPO}/sandbox/supervisor && cargo clippy --all-targets -- -D warnings && cargo test\`.
4. Run \`cd ${REPO}/apps/web && pnpm lint && pnpm exec tsc --noEmit && pnpm test\`.
5. Write ${REPO}/docs/status/round1.md: what each lane delivered (files, tests), the exact verification commands and results, deviations from briefs, and the consolidated gap list with owners for round 2.
Return the verification results and the gap list.`, { label: 'integrate:round1', phase: 'Integrate', schema: FIX_SCHEMA })

return { lanes: lanes.map(l => ({ lane: l.lane, review: l.review && l.review.findings })), integration: integ }
