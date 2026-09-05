export const meta = {
  name: 'zs-impl-round3',
  description: 'Implement round 3: leaf-crate gates, edge gates and the zed_web entry crate; then loop wasm check-and-fix until zed_web compiles; review',
  phases: [
    { title: 'Implement', detail: 'lanes b6 and b7' },
    { title: 'Review', detail: 'three adversarial lenses per lane' },
    { title: 'Fix', detail: 'apply accepted findings' },
    { title: 'WasmLoop', detail: 'check zed_web for wasm32, fan out fixes per failing crate, repeat' },
    { title: 'Integrate', detail: 'native regression check and status report' },
  ],
}

const REPO = '/Users/ray/Projects/play/wed'
const ZED = `${REPO}/zed`
const B = `${REPO}/docs/briefs`
const DEC = `${B}/DECISIONS.md`
const CON = `${B}/CONTRACTS.md`
const SPEC = `${REPO}/BUILD-SPEC.md`
const STATUS1 = `${REPO}/docs/status/round1.md`
const STATUS2 = `${REPO}/docs/status/round2.md`
const MAX_LOOPS = 10

const ETIQUETTE = `
Working agreements (binding):
- Other agents are editing OTHER parts of this repository at the same time. Only touch the files and crates your lane owns (listed below). Shared files (workspace Cargo.toml, Cargo.lock, .cargo/config.toml, vendor/README.md): minimal additive edits, re-read immediately before editing. Never rewrite an existing file wholesale.
- Never run git checkout, git stash, git reset, git clean, or anything that discards working-tree changes. Do not commit.
- Cargo commands in ${ZED} share one build directory and serialize on a lock; waiting is expected. Native: \`cargo check -p <crate>\`. Wasm: \`./script/check-wasm -p <crate>\` (slow; run only what your verification lists). Never build the whole workspace or the zed binary.
- Rounds 1 and 2 landed: read ${STATUS1} and ${STATUS2} first. Build on them.
- Precedence when documents conflict: ${DEC} (v1 and v2) beats ${CON}, which beats your brief. Read all of DECISIONS.md before starting.
- Gates must be cfg(target_family = "wasm") in upstream's crate layout; native behavior must be byte-for-byte unchanged (native cargo check and tests still pass).
- Write real, complete code: no todo!() or unimplemented!() in non-test code. If something cannot be finished, leave it compiling, marked \`// ZS-TODO(<lane>):\`, and list it under gaps.
- Every new public item gets a doc comment. Match surrounding style.
- Before returning, run your lane's verification commands and make them pass; report exact commands and results.`

const IMPL_SCHEMA = { type: 'object', properties: { files_changed: { type: 'array', items: { type: 'string' } }, tests_added: { type: 'array', items: { type: 'string' } }, verification: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, status: { type: 'string' }, notes: { type: 'string' } }, required: ['command', 'status'] } }, deviations_from_brief: { type: 'array', items: { type: 'string' } }, gaps: { type: 'array', items: { type: 'string' } } }, required: ['files_changed', 'tests_added', 'verification', 'deviations_from_brief', 'gaps'] }
const REVIEW_SCHEMA = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'integer' }, severity: { type: 'string', enum: ['blocking', 'major', 'minor'] }, claim: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' } }, required: ['file', 'severity', 'claim', 'evidence', 'fix'] } }, verdict: { type: 'string' } }, required: ['findings', 'verdict'] }
const FIX_SCHEMA = { type: 'object', properties: { fixed: { type: 'array', items: { type: 'string' } }, rejected: { type: 'array', items: { type: 'object', properties: { finding: { type: 'string' }, reason: { type: 'string' } }, required: ['finding', 'reason'] } }, verification: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, status: { type: 'string' }, notes: { type: 'string' } }, required: ['command', 'status'] } }, remaining_gaps: { type: 'array', items: { type: 'string' } } }, required: ['fixed', 'rejected', 'verification', 'remaining_gaps'] }
const CHECK_SCHEMA = { type: 'object', properties: { clean: { type: 'boolean' }, log_path: { type: 'string' }, failing_crates: { type: 'array', items: { type: 'object', properties: { crate: { type: 'string' }, error_count: { type: 'integer' }, summary: { type: 'string' }, first_errors: { type: 'array', items: { type: 'string' } } }, required: ['crate', 'error_count', 'summary', 'first_errors'] } }, notes: { type: 'string' } }, required: ['clean', 'log_path', 'failing_crates', 'notes'] }

function implPrompt(lane, brief, ownership, task, verify) {
  return `${ETIQUETTE}\n\nLane: ${lane}\nBrief (read fully first): ${brief}\nAlso read: ${DEC}, ${CON}, ${STATUS1}, ${STATUS2}, and the relevant sections of ${SPEC}.\nRepository: ${REPO} (Zed fork at ${ZED}, branch zs).\nFiles and crates this lane owns: ${ownership}\n\nTask:\n${task}\n\nVerification you must run before returning:\n${verify}`
}

const LENSES = (lane, brief, scope, verifyCmd) => [
  { name: 'correctness', prompt: `Adversarial code reviewer for lane ${lane}. Scope: ${scope}. Read ${brief}, ${DEC}, ${CON}, then the actual diff (git -C ${ZED} diff; new files read directly). Hunt for: gates that change native behavior, WasmFs semantics that break settings watchers, SQLite-in-wasm build mistakes, Send/!Send errors, panics on the wasm main thread (blocking calls), dropped futures, init-order mistakes in zed_web relative to crates/zed, missing registries, keymap layer ordering, boot-sequence races (client state loaded after workspace deserialization). Each finding: file, line, severity, failure scenario, evidence, fix. Do not modify files.` },
  { name: 'security', prompt: `Adversarial security reviewer for lane ${lane}. Scope: ${scope}. Read ${brief}, ${CON}, BUILD-SPEC section 10, then the diff and new files. Hunt for: tokens or secrets reachable from JS, CSP-violating inline script in the loader page, cross-origin isolation gaps, extension asset fetches without token, client-state images accepted without version/size checks, unsafe wasm-bindgen exports that expose internal state, and gates that silently disable a security check on wasm. Do not modify files. Give exploit scenarios.` },
  { name: 'spec-compliance', prompt: `Spec-compliance reviewer for lane ${lane}. Scope: ${scope}. Compare the implementation against ${brief}, ${CON} and ${DEC}. List every brief item missing, partial, or differently named/shaped/defaulted; every specified test not written; every ZS-TODO left. Run ${verifyCmd} and report its real result. Do not modify files.` },
]

async function reviewFix(lane, brief, scope, verifyCmd, ownership) {
  const findings = (await parallel(LENSES(lane, brief, scope, verifyCmd).map(l => () => agent(l.prompt, { label: `review:${lane}:${l.name}`, phase: 'Review', schema: REVIEW_SCHEMA })))).filter(Boolean).flatMap(r => r.findings)
  log(`${lane}: ${findings.length} review findings`)
  if (!findings.length) return { lane, findings: 0, fix: null }
  const fix = await agent(`${ETIQUETTE}\n\nLane: ${lane}. You own: ${ownership}. Brief: ${brief}. Contracts: ${CON}. Decisions: ${DEC}.\nThree reviewers produced the findings below (JSON). Verify each against the code; fix real ones properly (never by weakening tests or deleting features); reject non-real ones with a reason. Blocking and major findings must be fixed. Then run: ${verifyCmd}; report results.\nFindings:\n${JSON.stringify(findings, null, 2)}`, { label: `fix:${lane}`, phase: 'Fix', schema: FIX_SCHEMA })
  return { lane, findings: findings.length, fix }
}

const laneB6 = async () => {
  const brief = `${B}/b6-leaf-gates.md`
  const own = `crates/fs (WasmFs and gates), ${ZED}/vendor/alacritty_terminal (vendored per D10/D31 with gates) plus its [patch]/exclude entries, crates/terminal (cfg gates only; remote_pty.rs belongs to b3 and already exists), crates/client (gates), crates/acp_thread (gates), crates/sqlez and crates/db (SQLite-in-wasm build and wasm write queue per the brief; ClientStateStore from round 2 stays), crates/prompt_store (in-memory store on wasm), and vendor/README.md sections for what you vendor.`
  const verify = `cd ${ZED} && cargo check -p fs -p terminal -p client -p acp_thread -p sqlez -p db -p prompt_store && cargo test -p fs wasm_fs && ./script/check-wasm -p fs -p terminal -p client -p acp_thread -p sqlez -p db -p prompt_store`
  const impl = await agent(implPrompt('b6-leaf-gates', brief, own, `Implement the whole brief (its remote-pty section is superseded by b3's existing crates/terminal/src/remote_pty.rs; keep only cfg gates in terminal): WasmFs implementing the full Fs trait with an in-memory tree, change events for watchers, take_dirty and insert_dir per D32; gates for RealFs, the watcher, libc and trash; vendored alacritty_terminal with tty/event_loop/thread gated; client gates keeping the Client type and AppState usable with sign-in disabled; acp_thread portable-pty gate; sqlez/db built on SQLite for wasm32 (the approach the brief chose, e.g. sqlite-wasm-rs or a vendored amalgamation build with wasi-sdk, memory VFS) with the wasm write queue; prompt_store in-memory; all specified unit tests. Native checks must remain clean. Then run script/check-wasm on your crates and fix what fails inside your ownership; report crate-by-crate status.`, verify), { label: 'impl:b6', phase: 'Implement', schema: IMPL_SCHEMA })
  const rf = await reviewFix('b6-leaf-gates', brief, 'fs WasmFs and gates, vendor/alacritty_terminal, terminal/client/acp_thread gates, sqlez/db on wasm, prompt_store', verify, own)
  return { lane: 'b6', impl, review: rf }
}

const laneB7 = async () => {
  const brief = `${B}/b7-edge-gates-entry.md`
  const own = `edge gates in crates/title_bar, crates/git_ui, crates/language_models, crates/agent_ui, crates/recent_projects, crates/settings_ui, crates/workspace (node_runtime local paths), crates/remote_connection (auto_update), the gpui_tokio dependents listed in the brief, crates/http_client_tls consumers; the new crate ${ZED}/crates/zed_web (Cargo.toml, src/main.rs, host bridge, boot sequence, JS loader assets under crates/zed_web/web/), assets/keymaps/web.json and its wasm-only loading, the PlatformStyle override in crates/ui per D12, script/build-web (bundle build: nightly, build-std, wasm-bindgen 0.2.120 --target web, wasm-opt, assets tarball, output to ${REPO}/apps/web/public/editor/<build>/), the workspace Cargo.toml members entry for zed_web, and these round-2 gaps assigned to this lane: R3-4 swap std::time::Instant to web_time::Instant in crates/rpc (peer.rs, message_stream.rs) and crates/remote where it runs on wasm; R3-5 declare both getrandom lines (0.2 js, 0.3 wasm_js) in zed_web's wasm target table; R3-6 verify remote_server's serve feature stays out of the browser closure (cargo tree --target wasm32-unknown-unknown -p zed_web -i tokio); R3-3 add crates/remote to script/check-wasm's default list and delete tools/ws-transport-wasm-check.`
  const verify = `cd ${ZED} && cargo check -p title_bar -p git_ui -p language_models -p agent_ui -p recent_projects -p settings_ui -p workspace -p ui && ./script/check-wasm -p zed_web`
  const impl = await agent(implPrompt('b7-edge-gates-entry', brief, own, `Implement the whole brief: every edge gate (Cargo target-conditional dependencies plus source cfgs) so call/livekit, bedrock, extension_host, gpui_tokio, http_client_tls, auto_update and dev_container leave the wasm closure while native builds are unchanged; the zed_web crate with the full init sequence mirroring crates/zed (registries, settings and keymap from WasmFs seeded by JS-provided JSON per D11/D32, themes, fonts from the assets crate, panels, agent UI, terminal view, git UI, the client-state load over the session before workspace deserialization via b1's D16 entry point, ClientStateStore flush wiring incl. hidden/pagehide/stopping, lifecycle toasts, host bridge exports per CONTRACTS.md: start(config_json, assets, host), flush_client_state, set_hidden, host callbacks onClosed/onLifecycle/keepAlive/stop/setDirty/openExternal with close_code_detail names per D23), the web keymap layer per D12 loaded last on wasm only, the PlatformStyle override, the loader page assets (module worker bootstrap for wasm_thread, memory settings, the wasm-bindgen glue patch if the brief requires it) and script/build-web. Then run ./script/check-wasm -p zed_web; it will fail on crates outside your ownership at first: fix what is yours, and return a precise list of failing crates with first errors for the wasm loop that follows.`, verify), { label: 'impl:b7', phase: 'Implement', schema: IMPL_SCHEMA })
  const rf = await reviewFix('b7-edge-gates-entry', brief, 'edge gates, crates/zed_web, web keymap layer, loader assets, script/build-web', verify, own)
  return { lane: 'b7', impl, review: rf }
}

phase('Implement')
log('Round 3: lanes b6 and b7 starting')
const lanes = (await parallel([laneB6, laneB7])).filter(Boolean)

phase('WasmLoop')
let loopResult = null
for (let i = 1; i <= MAX_LOOPS; i++) {
  const check = await agent(`Run \`cd ${ZED} && ./script/check-wasm -p zed_web\` (this can take a long time; wait for it). Read the full log it writes under target/wasm-logs/. Group every error by the crate it occurs in (from the "--> path" lines and "error: could not compile" lines). Return clean=true only if the check finished with no errors. For each failing crate return error_count, a one-paragraph summary of the failure kinds, and up to 8 representative first_errors (verbatim error lines with file:line). Do not modify files.`, { label: `wasm-check:${i}`, phase: 'WasmLoop', schema: CHECK_SCHEMA })
  if (!check) { log(`wasm loop ${i}: checker returned nothing; stopping`); break }
  log(`wasm loop ${i}: clean=${check.clean}, failing crates=${check.failing_crates.length}`)
  loopResult = check
  if (check.clean) break
  const groups = check.failing_crates.slice(0, 12)
  if (check.failing_crates.length > 12) log(`wasm loop ${i}: fixing the first 12 of ${check.failing_crates.length} failing crates this pass`)
  await parallel(groups.map(g => () => agent(`${ETIQUETTE}\n\nWasm compile loop pass ${i}. You own ONLY crate \`${g.crate}\` (its Cargo.toml and src) plus, if strictly needed for this crate, a one-line additive entry in the workspace Cargo.toml. Read ${DEC}, ${CON}, and the brief that covers this crate (search ${B}/b5-wasm-build-env.md, b6-leaf-gates.md, b7-edge-gates-entry.md for the crate name; b7's edge-gate list and b5's shim/url helper rules apply). Make \`${g.crate}\` compile for wasm32-unknown-unknown with cfg(target_family = "wasm") gates in upstream style, without changing native behavior. Errors seen (log at ${check.log_path}):\n${g.summary}\n${g.first_errors.join('\n')}\n\nVerify with \`cd ${ZED} && ./script/check-wasm -p ${g.crate}\` (if the crate cannot be checked in isolation because of features, use \`./script/check-wasm -p zed_web\` and read only your crate's errors) and \`cargo check -p ${g.crate}\` natively. Return files changed, verification, and remaining errors if any.`, { label: `wasm-fix:${i}:${g.crate}`, phase: 'WasmLoop', schema: IMPL_SCHEMA })))
}

phase('Integrate')
const integ = await agent(`${ETIQUETTE}\n\nYou are the round-3 integrator. Read ${STATUS1}, ${STATUS2}, ${CON}, ${DEC}. The wasm loop result was: ${JSON.stringify(loopResult && { clean: loopResult.clean, failing: loopResult.failing_crates.map(f => f.crate) })}.\n1. Native regression: \`cd ${ZED} && cargo check -p remote -p remote_server -p terminal -p project -p workspace -p editor -p fs -p client -p db -p title_bar -p git_ui -p agent_ui -p settings_ui\` and the round-1/2 test filters (websocket, serve, pty, client_state, control, remote, wasm_fs); fix minimal cross-lane breakage.\n2. If the wasm loop ended clean, run \`./script/build-web\` and record the bundle sizes (raw, gzip, brotli) and where it landed under apps/web/public/editor/<build>/; if it did not end clean, do not attempt the build and list the remaining failing crates with first errors.\n3. Write ${REPO}/docs/status/round3.md, ONE PAGE maximum: deliverables one line per lane, exact verification commands with pass/fail, wasm status as a crate list, bundle sizes, and the gap list for round 4. No prose beyond that.\nReturn verification results and the gap list.`, { label: 'integrate:round3', phase: 'Integrate', schema: FIX_SCHEMA })

return { lanes: lanes.map(l => ({ lane: l.lane, review: l.review && l.review.findings })), wasm: loopResult && { clean: loopResult.clean, failing: loopResult.failing_crates.map(f => f.crate) }, integration: integ }
