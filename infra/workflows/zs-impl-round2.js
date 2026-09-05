export const meta = {
  name: 'zs-impl-round2',
  description: 'Implement round 2: protocol additions (persistence, lifecycle, files, ports, extensions) and the wasm build environment with shims; review, fix, integrate',
  phases: [
    { title: 'Implement', detail: 'lanes b4 and b5' },
    { title: 'Review', detail: 'three adversarial lenses per lane' },
    { title: 'Fix', detail: 'apply accepted findings and re-verify' },
    { title: 'Integrate', detail: 'native check plus first wasm checks of leaf crates' },
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
- Other agents are editing OTHER parts of this repository at the same time. Only touch the files and crates your lane owns (listed below). If you must touch a shared file (the workspace Cargo.toml, Cargo.lock, .cargo/config.toml, crates/proto/proto/zed.proto, crates/proto/src/proto.rs, crates/remote_server/src/server.rs), make a minimal additive edit and re-read the file immediately before editing. Never rewrite an existing file wholesale; use targeted edits.
- Never run git checkout, git stash, git reset, git clean, or anything that discards working-tree changes. Do not commit. You may run git diff and git status.
- Cargo commands in ${ZED} share one build directory and serialize on a lock; waiting is expected. Use \`cargo check -p <crate>\` for crates you touched and \`cargo test -p <crate> <filter>\` for tests you added. Do not build the whole workspace or the zed binary. Wasm checks are slow (tens of minutes): run them only where your lane's verification says so, via script/check-wasm once it exists.
- Round 1 already landed: read ${STATUS1} first for what exists (WebSocket transport in crates/remote, serve mode in crates/remote_server with ServeHooks and ControlRoutes hook points, terminal messages and PtyManager, supervisor, control plane). Build on it; do not re-implement it.
- Precedence when documents conflict: ${DEC} (including Decisions v2, D21 to D34) beats ${CON}, which beats your brief. Read all of DECISIONS.md before starting.
- Write real, complete code: no todo!() or unimplemented!() in non-test code. If something cannot be finished, leave it compiling, marked \`// ZS-TODO(<lane>):\`, and list it under gaps.
- Every new public item gets a doc comment. Match surrounding style.
- Before returning, run your lane's verification commands and make them pass; report exact commands and results.`

const IMPL_SCHEMA = { type: 'object', properties: { files_changed: { type: 'array', items: { type: 'string' } }, tests_added: { type: 'array', items: { type: 'string' } }, verification: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, status: { type: 'string' }, notes: { type: 'string' } }, required: ['command', 'status'] } }, deviations_from_brief: { type: 'array', items: { type: 'string' } }, gaps: { type: 'array', items: { type: 'string' } } }, required: ['files_changed', 'tests_added', 'verification', 'deviations_from_brief', 'gaps'] }
const REVIEW_SCHEMA = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'integer' }, severity: { type: 'string', enum: ['blocking', 'major', 'minor'] }, claim: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' } }, required: ['file', 'severity', 'claim', 'evidence', 'fix'] } }, verdict: { type: 'string' } }, required: ['findings', 'verdict'] }
const FIX_SCHEMA = { type: 'object', properties: { fixed: { type: 'array', items: { type: 'string' } }, rejected: { type: 'array', items: { type: 'object', properties: { finding: { type: 'string' }, reason: { type: 'string' } }, required: ['finding', 'reason'] } }, verification: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, status: { type: 'string' }, notes: { type: 'string' } }, required: ['command', 'status'] } }, remaining_gaps: { type: 'array', items: { type: 'string' } } }, required: ['fixed', 'rejected', 'verification', 'remaining_gaps'] }

function implPrompt(lane, brief, ownership, task, verify) {
  return `${ETIQUETTE}\n\nLane: ${lane}\nBrief (read fully first): ${brief}\nAlso read: ${DEC}, ${CON}, ${STATUS1}, and the relevant sections of ${SPEC}.\nRepository: ${REPO} (Zed fork at ${ZED}, branch zs).\nFiles and crates this lane owns: ${ownership}\n\nTask:\n${task}\n\nVerification you must run before returning:\n${verify}`
}

const LENSES = (lane, brief, scope, verifyCmd) => [
  { name: 'correctness', prompt: `Adversarial code reviewer for lane ${lane}. Scope: ${scope}. Read ${brief}, ${DEC}, ${CON}, then the actual diff (git -C ${ZED} diff for tracked files; read new untracked files directly). Hunt for correctness bugs: wrong protocol semantics, races, unhandled errors, panics on bad input, ownership/lifetime mistakes, Send/!Send assumptions that break on wasm, data loss in persistence paths (partial writes, version mismatches), shim stubs that silently succeed, feature-unification mistakes in Cargo manifests that would pull native crates into a wasm build or break native builds. Each finding needs file, line, severity, a concrete failure scenario, evidence, and a fix. Do not modify files.` },
  { name: 'security', prompt: `Adversarial security reviewer for lane ${lane}. Scope: ${scope}. Read ${brief}'s security sections, ${CON}, BUILD-SPEC section 10, then the diff and new files. Hunt for: control-listener auth weaknesses (secret file handling, constant-time compare, loopback-only bind), unbounded allocations from untrusted input (client-state blobs, extension ids, port lists), path traversal in asset/extension routes, secrets in logs, unsafe deserialization, command injection in extension install, and any shim that turns a security-relevant native behavior into a silent no-op. Do not modify files. Give exploit scenarios.` },
  { name: 'spec-compliance', prompt: `Spec-compliance reviewer for lane ${lane}. Scope: ${scope}. Compare the implementation against ${brief} (change list, types, messages, tests), ${CON} and ${DEC} (v1 and v2). List every brief item missing, partial, or differently named/shaped/defaulted; every specified test not written; every ZS-TODO left. Run ${verifyCmd} and report its real result. Do not modify files.` },
]

async function reviewFix(lane, brief, scope, verifyCmd, ownership) {
  const findings = (await parallel(LENSES(lane, brief, scope, verifyCmd).map(l => () => agent(l.prompt, { label: `review:${lane}:${l.name}`, phase: 'Review', schema: REVIEW_SCHEMA })))).filter(Boolean).flatMap(r => r.findings)
  log(`${lane}: ${findings.length} review findings`)
  if (!findings.length) return { lane, findings: 0, fix: null }
  const fix = await agent(`${ETIQUETTE}\n\nLane: ${lane}. You own: ${ownership}. Brief: ${brief}. Contracts: ${CON}. Decisions: ${DEC}.\nThree reviewers produced the findings below (JSON). For each: verify against the code; if real, fix it properly (never by weakening tests or deleting features); if not real, reject with a reason. Blocking and major findings must be fixed. Then run: ${verifyCmd} and any tests you touched; report results.\nFindings:\n${JSON.stringify(findings, null, 2)}`, { label: `fix:${lane}`, phase: 'Fix', schema: FIX_SCHEMA })
  return { lane, findings: findings.length, fix }
}

const laneB4 = async () => {
  const brief = `${B}/b4-proto-additions.md`
  const own = `crates/proto (additive messages for remote_session: SaveClientState, LoadClientState, LifecycleNotice, PortsChanged, ForwardPort, UnforwardPort, FilesUploaded, ListExtensions, InstallExtension, UninstallExtension, ExtensionsChanged and their responses), crates/remote_server (headless handlers for those messages, the ControlRoutes adapter that plugs into b2's control listener, client-state storage under the server data dir, the ports.rs module with DEFAULT_SUPERVISOR_URL per D21, extension install via the registry client), crates/db and crates/sqlez (ClientStateStore: serialize/restore hooks, unsaved_buffers table per D6, flush triggers per D7; keep native behavior unchanged), crates/project (client-side handlers/stores for these messages), crates/workspace (lifecycle notifications toast and the unsaved-buffer capture/restore per D6), crates/extension_host only where the brief assigns the supports_extension_upload gate if b1 did not take it.`
  const verify = `cd ${ZED} && cargo check -p proto -p remote_server -p db -p sqlez -p project -p workspace && cargo test -p remote_server client_state && cargo test -p remote_server control && cargo test -p db client_state`
  const impl = await agent(implPrompt('b4-proto-additions', brief, own, `Implement the whole brief on top of round 1: the proto messages with registration and priorities; server handlers in HeadlessProject and the server-level ControlRoutes adapter wired into serve's loopback control listener (127.0.0.1:8451, secret file) with the request/response bodies from CONTRACTS.md (POST /control/lifecycle, /control/ports, /control/extensions; 1 MiB body cap; {"error":"bad_request","message":...}); client-state storage (SaveClientState/LoadClientState with version checks, stored under the server data dir so it lands in the sandbox snapshot); the client-side ClientStateStore in crates/db (whole AppDatabase image per D7/D34, unsaved_buffers table per D6, flush triggers exposed as functions the shell/zed_web will call: flush_client_state, set_hidden), the lifecycle toast in workspace with keep-alive, ports and extension client handlers (data stores plus events; UI panels are b7's), ForwardPort calling the supervisor via DEFAULT_SUPERVISOR_URL (http://127.0.0.1:8450) and every test the brief specifies, using the fake-session harness round 1 established.`, verify), { label: 'impl:b4', phase: 'Implement', schema: IMPL_SCHEMA })
  const rf = await reviewFix('b4-proto-additions', brief, 'proto remote_session messages, remote_server handlers/control routes/client state, db ClientStateStore, project and workspace client wiring', verify, own)
  return { lane: 'b4', impl, review: rf }
}

const laneB5 = async () => {
  const brief = `${B}/b5-wasm-build-env.md`
  const own = `${ZED}/.cargo/config.toml (target-specific wasm32 section and [env] only), ${ZED}/script/check-wasm and script/wasm-cc (new), ${ZED}/crates/zs_smol_shim (new), the url helper in crates/util or crates/paths and the mechanical from_file_path/to_file_path call-site replacements in util, editor, project, copilot, languages, lsp, edit_prediction_context, terminal, agent_ui (targeted one-line edits only), ${ZED}/vendor/lsp-types and ${ZED}/vendor/agent-client-protocol (vendored per D10/D31 with cfg gates), the [patch] and [workspace] exclude entries in the workspace Cargo.toml for those, the tree-sitter "wasm" feature target-conditioning in every Cargo.toml that declares it, time/wasm-bindgen and web-time additions, and the CI job wiring for check-wasm in ${ZED}/tooling/xtask if the brief specifies it.`
  const verify = `cd ${ZED} && cargo check -p util -p paths -p lsp -p project -p editor -p terminal -p languages && ./script/check-wasm -p gpui_platform -p cloud_api_client -p util -p paths -p task -p fuzzy -p lsp -p language_core -p http_client -p zs_smol_shim`
  const impl = await agent(implPrompt('b5-wasm-build-env', brief, own, `Implement the whole brief: the wasm32 build environment (rustflags incl. atomics/bulk-memory/mutable-globals/shared-memory/import-memory/max-memory/TLS exports and --cfg getrandom_backend="wasm_js"; CC/AR/CFLAGS for wasi-sdk at target/wasi-sdk via the script/wasm-cc wrapper; nothing that changes native builds), script/check-wasm (nightly, -Zbuild-std, default package list, accepts -p overrides, prints a compact error summary and writes a full log under target/wasm-logs/), the zs_smol_shim crate applied as a [patch.crates-io] replacement for smol that re-exports real smol on non-wasm and provides the stub/runtime modules on wasm (Timer fires via the scheduler/web timers, spawn runs futures, block_on panics with a clear message, process/fs/net return io::ErrorKind::Unsupported), the url file-path helper and all call-site replacements, vendored lsp-types and agent-client-protocol with cfg gates and vendor/README.md sections per D31, target-conditional tree-sitter wasm feature declarations (verify with cargo tree -e features --target wasm32-unknown-unknown -i wasmtime that wasmtime is no longer in the wasm closure of language), time/wasm-bindgen and web-time. Native builds must still pass. Then run script/check-wasm on the leaf list in the verification and fix what fails in the crates you own; report precisely which crates now check clean on wasm and which do not and why.`, verify), { label: 'impl:b5', phase: 'Implement', schema: IMPL_SCHEMA })
  const rf = await reviewFix('b5-wasm-build-env', brief, '.cargo/config.toml wasm section, script/check-wasm, zs_smol_shim, url helper call sites, vendored lsp-types and agent-client-protocol, tree-sitter feature gating', verify, own)
  return { lane: 'b5', impl, review: rf }
}

phase('Implement')
log('Round 2: lanes b4 and b5 starting')
const lanes = (await parallel([laneB4, laneB5])).filter(Boolean)

phase('Integrate')
const integ = await agent(`${ETIQUETTE}\n\nYou are the round-2 integrator. Lanes b4 (proto additions, client state, control routes) and b5 (wasm build env, shims, vendored deps) have landed. Read ${CON}, ${DEC} and ${STATUS1}. Then:\n1. Run \`cd ${ZED} && cargo check -p remote -p remote_server -p terminal -p project -p terminal_view -p workspace -p proto -p db -p sqlez -p editor -p languages -p lsp -p util\` and fix every cross-lane error minimally.\n2. Run the round-1 and round-2 test filters: \`cargo test -p remote websocket\`, \`cargo test -p remote_server serve\`, \`cargo test -p remote_server pty\`, \`cargo test -p remote_server client_state\`, \`cargo test -p remote_server control\`, \`cargo test -p terminal remote\`, \`cargo test -p db client_state\`; make them pass.\n3. Run \`./script/check-wasm\` (default list) and \`./script/check-wasm -p proto -p rpc -p db -p sqlez -p language_core -p zs_smol_shim\`; record which pass; fix cross-lane wasm breakage that is clearly in scope (feature unification, missing cfg on a new item from b4); leave deeper gating to round 3 but list it precisely.\n4. Write ${REPO}/docs/status/round2.md, ONE PAGE maximum: per lane one line of deliverables, the exact verification commands with pass/fail, and the gap list for round 3. No prose beyond that.\nReturn verification results and the gap list.`, { label: 'integrate:round2', phase: 'Integrate', schema: FIX_SCHEMA })

return { lanes: lanes.map(l => ({ lane: l.lane, review: l.review && l.review.findings })), integration: integ }
