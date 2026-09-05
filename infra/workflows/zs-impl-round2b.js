export const meta = {
  name: 'zs-impl-round2b',
  description: 'Round 2b (TypeScript side, parallel to round 2): local sandbox backend with a native end-to-end loop, devcontainer builder (b10), AI proxy (b11); review, fix, integrate',
  phases: [
    { title: 'Implement', detail: 'lanes local-backend, b10, b11' },
    { title: 'Review', detail: 'three adversarial lenses per lane' },
    { title: 'Fix', detail: 'apply accepted findings' },
    { title: 'Integrate', detail: 'run the native end-to-end loop for real' },
  ],
}

const REPO = '/Users/ray/Projects/play/wed'
const ZED = `${REPO}/zed`
const B = `${REPO}/docs/briefs`
const DEC = `${B}/DECISIONS.md`
const CON = `${B}/CONTRACTS.md`
const SPEC = `${REPO}/BUILD-SPEC.md`
const STATUS1 = `${REPO}/docs/status/round1.md`

const ETIQUETTE = `
Working agreements (binding):
- Other agents are editing OTHER parts of this repository at the same time (a Rust round is running inside ${ZED}; do not edit anything under ${ZED} unless your lane explicitly owns a path there). Only touch files your lane owns. Shared files (apps/web/package.json, apps/web/lib/env.ts, apps/web/lib/schema.ts, sandbox/supervisor/Cargo.toml, sandbox/supervisor/src/main.rs): minimal additive edits, re-read immediately before editing. Never rewrite an existing file wholesale.
- Never run git checkout, git stash, git reset, git clean, or anything that discards working-tree changes. Do not commit.
- Round 1 landed: read ${STATUS1} first. Build on the existing apps/web and sandbox/supervisor code; do not re-implement.
- Precedence when documents conflict: ${DEC} (v1 and v2) beats ${CON}, which beats your brief.
- Cargo in ${ZED} is shared with another running round and serializes on a lock; if your lane must build the server binary, use exactly \`cd ${ZED} && cargo build -p remote_server\` (debug profile) and wait. The supervisor crate at ${REPO}/sandbox/supervisor has its own target dir.
- Write real, complete code: no placeholders described as done. Mark anything unfinished \`// ZS-TODO(<lane>):\` and list it under gaps.
- Prefer building and validating with code over writing documents: every lane ends by RUNNING its verification and reporting real output.`

const IMPL_SCHEMA = { type: 'object', properties: { files_changed: { type: 'array', items: { type: 'string' } }, tests_added: { type: 'array', items: { type: 'string' } }, verification: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, status: { type: 'string' }, notes: { type: 'string' } }, required: ['command', 'status'] } }, deviations_from_brief: { type: 'array', items: { type: 'string' } }, gaps: { type: 'array', items: { type: 'string' } } }, required: ['files_changed', 'tests_added', 'verification', 'deviations_from_brief', 'gaps'] }
const REVIEW_SCHEMA = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'integer' }, severity: { type: 'string', enum: ['blocking', 'major', 'minor'] }, claim: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' } }, required: ['file', 'severity', 'claim', 'evidence', 'fix'] } }, verdict: { type: 'string' } }, required: ['findings', 'verdict'] }
const FIX_SCHEMA = { type: 'object', properties: { fixed: { type: 'array', items: { type: 'string' } }, rejected: { type: 'array', items: { type: 'object', properties: { finding: { type: 'string' }, reason: { type: 'string' } }, required: ['finding', 'reason'] } }, verification: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, status: { type: 'string' }, notes: { type: 'string' } }, required: ['command', 'status'] } }, remaining_gaps: { type: 'array', items: { type: 'string' } } }, required: ['fixed', 'rejected', 'verification', 'remaining_gaps'] }

function implPrompt(lane, brief, ownership, task, verify) {
  return `${ETIQUETTE}\n\nLane: ${lane}\n${brief ? `Brief (read fully first): ${brief}\n` : ''}Also read: ${DEC}, ${CON}, ${STATUS1}, and the relevant sections of ${SPEC}.\nRepository: ${REPO}.\nFiles this lane owns: ${ownership}\n\nTask:\n${task}\n\nVerification you must run before returning:\n${verify}`
}

const LENSES = (lane, brief, scope, verifyCmd) => [
  { name: 'correctness', prompt: `Adversarial code reviewer for lane ${lane}. Scope: ${scope}. Read ${brief || 'the lane description in docs/status/round1.md and CONTRACTS.md'}, ${DEC}, ${CON}, then the actual diff (git -C ${REPO} diff and new files). Hunt for correctness bugs: process lifecycle leaks (orphaned child processes, ports left bound), race conditions between spawn and health polling, wrong contract shapes, streaming proxies that buffer or drop chunks, hash instability, unhandled promise rejections, tests that pass without exercising the real path. Each finding: file, line, severity, concrete failure scenario, evidence, fix. Do not modify files.` },
  { name: 'security', prompt: `Adversarial security reviewer for lane ${lane}. Scope: ${scope}. Read the brief's security sections (${brief || 'none'}), ${CON}, BUILD-SPEC section 10, then the diff. Hunt for: dev-only auth or local backend modes reachable in production builds, registry credentials leaking into user contexts, SSRF through proxied provider paths or image references, API keys logged or returned to the browser, missing rate limits, command injection in spawned processes, path traversal in workspace directories. Do not modify files. Give exploit scenarios.` },
  { name: 'spec-compliance', prompt: `Spec-compliance reviewer for lane ${lane}. Scope: ${scope}. Compare the implementation against ${brief || 'the lane task'}, ${CON} and ${DEC}. List every item missing, partial, or differently named/shaped; every specified test not written; every ZS-TODO left. Run ${verifyCmd} and report its real result. Do not modify files.` },
]

async function reviewFix(lane, brief, scope, verifyCmd, ownership) {
  const findings = (await parallel(LENSES(lane, brief, scope, verifyCmd).map(l => () => agent(l.prompt, { label: `review:${lane}:${l.name}`, phase: 'Review', schema: REVIEW_SCHEMA })))).filter(Boolean).flatMap(r => r.findings)
  log(`${lane}: ${findings.length} review findings`)
  if (!findings.length) return { lane, findings: 0, fix: null }
  const fix = await agent(`${ETIQUETTE}\n\nLane: ${lane}. You own: ${ownership}. ${brief ? `Brief: ${brief}. ` : ''}Contracts: ${CON}. Decisions: ${DEC}.\nThree reviewers produced the findings below (JSON). Verify each against the code; fix real ones properly (never by weakening tests or deleting features); reject non-real ones with a reason. Blocking and major findings must be fixed. Then run: ${verifyCmd}; report results.\nFindings:\n${JSON.stringify(findings, null, 2)}`, { label: `fix:${lane}`, phase: 'Fix', schema: FIX_SCHEMA })
  return { lane, findings: findings.length, fix }
}

const laneLocal = async () => {
  const own = `${REPO}/apps/web/lib/sandbox-local.ts (new) and the backend selection in lib/sandbox.ts (additive), lib/auth.ts dev-mode auth (additive, gated to NODE_ENV !== 'production' and an explicit ZS_AUTH_MODE=dev), apps/web/scripts/dev-local.sh (new), apps/web/tests/e2e-native/** (new), ${REPO}/sandbox/supervisor: only cfg(target_os) gating for macOS in the port watcher and any Linux-only calls, plus a --local flag/env (ZS_LOCAL=1) that skips sandbox-only behavior; and ${ZED}/crates/remote/tests/native_e2e.rs (new integration test that uses the WebSocket transport from round 1).`
  const verify = `cd ${REPO}/apps/web && pnpm lint && pnpm exec tsc --noEmit && pnpm test && ./scripts/dev-local.sh e2e`
  const impl = await agent(implPrompt('local-backend', null, own, `Goal: the whole control-plane flow runs on this macOS machine with no Vercel account: dashboard/API -> workspace create -> supervisor spawned locally -> zed-remote-server serve on 127.0.0.1 -> connect returns { wsUrl, token, sessionId, workspaceId } -> a native client completes the Hello/RemoteStarted handshake and opens a worktree.
Implement:
1. lib/sandbox-local.ts implementing the same interface as the Vercel sandbox wrapper in lib/sandbox.ts (read it first: create/get/getOrCreate/stop/extendTimeout/update ports/domain/snapshot/runCommand as used by the workflows), backed by child processes: a workspace directory under $TMPDIR/zs-local/<name>, "create" spawns the supervisor binary (${REPO}/sandbox/supervisor/target/debug/zs-agent start, env per CONTRACTS.md with ZS_CONTROL_URL pointing at the local dev server, ZS_LOCAL=1) which in turn spawns the serve binary (path from ZS_SERVE_BIN, default ${ZED}/target/debug/zed-remote-server), "domain(port)" returns http://127.0.0.1:<port> (ws for rpc), "stop" sends SIGTERM and waits, "snapshot" tars the directory, resume restores it; port allocation avoids conflicts across workspaces (offset per workspace or pick free ports and write them into the manifest); selected via ZS_SANDBOX_BACKEND=local and never in production builds.
2. Dev auth: when ZS_AUTH_MODE=dev and NODE_ENV !== 'production', a fixed dev user (id, email from env) satisfies auth() and the middleware; all other modes unchanged. Fail closed in production.
3. Supervisor macOS compatibility: gate /proc/net/tcp parsing and other Linux-only calls behind cfg(target_os = "linux") with a no-op or lsof-based fallback on macOS behind ZS_LOCAL=1; the binary must build and run here (cd sandbox/supervisor && cargo build).
4. apps/web/scripts/dev-local.sh: builds zs-agent (cargo build in sandbox/supervisor), builds the server (cd ${ZED} && cargo build -p remote_server; wait for the shared lock), generates dev ES256 keys into apps/web/.zs-dev/, writes .env.local for local mode (DATABASE_URL for a local Postgres: use the option round 1 chose for local dev, e.g. docker postgres or PGlite; read lib/db.ts), starts pnpm dev on a fixed port, and with argument \`e2e\` runs the native end-to-end test and shuts everything down.
5. The native end-to-end test: apps/web/tests/e2e-native/flow.test.ts (vitest, separate config) creates a workspace via the API as the dev user (POST /api/workspaces with a local git repo fixture created in a temp dir), polls until running, calls /connect, asserts the response shape per D26, then invokes the Rust integration test ${ZED}/crates/remote/tests/native_e2e.rs (run via cargo test -p remote --test native_e2e with ZS_E2E_WS_URL/ZS_E2E_TOKEN/ZS_E2E_WORKSPACE_ID/ZS_E2E_SESSION_ID env) which dials the WebSocket transport from round 1, completes Hello/HelloAck and RemoteStarted, sends AddWorktree for the repo path and asserts the worktree snapshot arrives with the fixture files, opens a buffer, edits and saves, then asserts the file on disk changed; then the TS test stops the workspace and asserts the supervisor and server processes exited. Everything must actually run and pass here.`, verify), { label: 'impl:local-backend', phase: 'Implement', schema: IMPL_SCHEMA })
  const rf = await reviewFix('local-backend', null, 'apps/web sandbox-local backend, dev auth, dev-local script, native e2e test, supervisor macOS gating, crates/remote native_e2e test', verify, own)
  return { lane: 'local-backend', impl, review: rf }
}

const laneB10 = async () => {
  const brief = `${B}/b10-devcontainer-builder.md`
  const own = `${REPO}/apps/web/lib/devcontainer/** (new), workflows/buildDevcontainerImage.ts and related workflow steps, the repos/image tables and migrations the brief specifies, API routes and dashboard pieces the brief specifies, ${REPO}/sandbox/image/builder/** (builder Dockerfile and scripts), the supervisor manifest deltas the brief specifies (manifest.rs fields and lifecycle command handling only), scripts/emit-schemas.ts, and tests.`
  const verify = `cd ${REPO}/apps/web && pnpm lint && pnpm exec tsc --noEmit && pnpm test && cd ${REPO}/sandbox/supervisor && cargo test`
  const impl = await agent(implPrompt('b10-devcontainer-builder', brief, own, `Implement the whole brief: the devcontainer.json parser with zod schema and the six real-world fixtures, config and content hashing with stability tests, the builder workflow with the exact SDK calls and all security items the brief settled (split DOCKER_CONFIG, digest-pinned image refs, env key filtering, base-registry allowlist, syntax directive omission), admission and rate limits, DB changes with a migration, the API and dashboard changes, the builder image Dockerfile and zs-layer-fixup.sh, the supervisor manifest/lifecycle deltas, and every test the brief lists that can run without a Vercel account (mock the SDK and registry). Where the brief asks for CONTRACTS.md or DECISIONS.md amendments (D35-D40), apply them as minimal additive edits.`, verify), { label: 'impl:b10', phase: 'Implement', schema: IMPL_SCHEMA })
  const rf = await reviewFix('b10-devcontainer-builder', brief, 'apps/web devcontainer parser and builder workflow, builder image, supervisor manifest deltas', verify, own)
  return { lane: 'b10', impl, review: rf }
}

const laneB11 = async () => {
  const brief = `${B}/b11-ai-proxy.md`
  const own = `${REPO}/apps/web/app/api/ai/** (new), lib/ai/** (new), the secrets scope additions, dashboard AI keys page, rate-limit and usage additions the brief specifies, and tests. The Rust/zed_web parts of the brief are NOT in this lane (zed_web does not exist yet); write them down as a precise follow-up in the return value.`
  const verify = `cd ${REPO}/apps/web && pnpm lint && pnpm exec tsc --noEmit && pnpm test`
  const impl = await agent(implPrompt('b11-ai-proxy', brief, own, `Implement the TypeScript side of the brief: the authenticated streaming proxy routes for each provider (path allowlist, header allowlist, key injection from the user's ai:<provider> secret, SSE and chunked streaming passthrough with abort propagation, per-user rate limits and spend caps, usage logging), the AI Gateway mode, the dashboard page to manage AI keys, and vitest tests with a mocked upstream that verify streaming order, abort, missing-key 4xx, rate limiting and that keys never appear in responses or logs.`, verify), { label: 'impl:b11', phase: 'Implement', schema: IMPL_SCHEMA })
  const rf = await reviewFix('b11-ai-proxy', brief, 'apps/web AI proxy routes, lib/ai, AI keys dashboard', verify, own)
  return { lane: 'b11', impl, review: rf }
}

const laneB8Sec = async () => {
  const brief = `${B}/b8-supervisor-image.md`
  const own = `${REPO}/sandbox/supervisor (src, tests) and ${REPO}/sandbox/image (Dockerfile, scripts) only for fixes to accepted findings.`
  const verify = `cd ${REPO}/sandbox/supervisor && cargo clippy --all-targets -- -D warnings && cargo test`
  const findings = (await parallel([
    () => agent(`Adversarial security reviewer for the sandbox supervisor (zs-agent) and image. Round 1's security review of this lane never completed, so this is the first one. Read ${brief} security sections, ${CON} (supervisor env/flag contract, control listener, proxy cookie), BUILD-SPEC section 10, then read ${REPO}/sandbox/supervisor/src/** and ${REPO}/sandbox/image/** fully. Hunt for: secrets written to disk or exported into child environments (control secret, sandbox token, git tokens), the git credential helper leaking or caching tokens, HMAC cookie validation weaknesses in the private-port proxy (timing, missing expiry, host binding, slot confusion), open redirect in /__zs/auth next=, header injection, SSRF via manifest-controlled URLs, command injection in postCreate/dotfiles handling, path traversal in restore/tarball extraction, TOCTOU in marker files, log shipping leaking secrets, missing TLS verification, privilege issues with sudo, and Dockerfile supply-chain pins. Each finding: file, line, severity, exploit scenario, evidence, fix. Do not modify files.`, { label: 'review:b8:security', phase: 'Review', schema: REVIEW_SCHEMA }),
    () => agent(`Adversarial correctness reviewer for the sandbox supervisor's process lifecycle. Read ${brief}, ${CON}, then ${REPO}/sandbox/supervisor/src/** fully. Hunt for: orphaned children on SIGTERM, restart storms, health reporting lies (ready before serve accepts), activity relay drift, port watcher misreports, resume path mistakes, blocking the async runtime, unbounded buffers in log shipping. Each finding: file, line, severity, failure scenario, evidence, fix. Do not modify files.`, { label: 'review:b8:lifecycle', phase: 'Review', schema: REVIEW_SCHEMA }),
  ])).filter(Boolean).flatMap(r => r.findings)
  log(`b8-security: ${findings.length} findings`)
  if (!findings.length) return { lane: 'b8-security', review: { findings: 0 } }
  const fix = await agent(`${ETIQUETTE}\n\nLane: b8-security. You own: ${own}. Brief: ${brief}. Contracts: ${CON}. Decisions: ${DEC}.\nReviewers produced the findings below (JSON). Verify each against the code; fix real ones properly; reject non-real ones with a reason. Blocking and major findings must be fixed. Then run: ${verify}; report results.\nFindings:\n${JSON.stringify(findings, null, 2)}`, { label: 'fix:b8-security', phase: 'Fix', schema: FIX_SCHEMA })
  return { lane: 'b8-security', review: { findings: findings.length, fix } }
}

phase('Implement')
log('Round 2b: lanes local-backend, b10, b11, b8-security starting')
const lanes = (await parallel([laneLocal, laneB10, laneB11, laneB8Sec])).filter(Boolean)

phase('Integrate')
const integ = await agent(`${ETIQUETTE}\n\nYou are the round-2b integrator. Lanes local-backend, b10 and b11 landed in ${REPO}/apps/web, ${REPO}/sandbox/supervisor and ${ZED}/crates/remote/tests. Read ${CON}, ${DEC}, ${STATUS1}.\n1. Run \`cd ${REPO}/apps/web && pnpm lint && pnpm exec tsc --noEmit && pnpm test\` and \`cd ${REPO}/sandbox/supervisor && cargo clippy --all-targets -- -D warnings && cargo test\`; fix cross-lane breakage minimally.\n2. Run the native end-to-end loop for real: \`cd ${REPO}/apps/web && ./scripts/dev-local.sh e2e\`. If it fails, diagnose and fix (in any of the three lanes' files, minimally) and re-run until it passes or you have exhausted three distinct root causes; report the exact output either way.\n3. Write ${REPO}/docs/status/round2b.md, ONE PAGE maximum: one line per lane, verification commands with pass/fail, the e2e result, and gaps.\nReturn verification results and gaps.`, { label: 'integrate:round2b', phase: 'Integrate', schema: FIX_SCHEMA })

return { lanes: lanes.map(l => ({ lane: l.lane, review: l.review && l.review.findings })), integration: integ }
