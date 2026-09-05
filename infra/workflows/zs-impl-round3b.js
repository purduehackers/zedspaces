export const meta = {
  name: 'zs-impl-round3b',
  description: 'Round 3b: drive the zed_web wasm closure to a clean check with keep-going passes and per-crate fixers, then build the bundle and record sizes',
  phases: [
    { title: 'WasmLoop', detail: 'check zed_web with --keep-going, fan out one fixer per failing crate, escalate stuck crates, repeat' },
    { title: 'Bundle', detail: 'build-web, sizes, default-list update' },
    { title: 'Integrate', detail: 'native regression, status' },
  ],
}

const REPO = '/Users/ray/Projects/play/wed'
const ZED = `${REPO}/zed`
const B = `${REPO}/docs/briefs`
const DEC = `${B}/DECISIONS.md`
const CON = `${B}/CONTRACTS.md`
const STATUS = [1, 2, '2b', 3].map(n => `${REPO}/docs/status/round${n}.md`)
const MAX_LOOPS = 30
const MAX_PARALLEL_FIXES = 12

const ETIQUETTE = `
Working agreements (binding):
- Other agents are editing OTHER crates at the same time. Only touch the crate you were assigned (its Cargo.toml and src) plus, if strictly needed, a one-line additive entry in the workspace Cargo.toml or .cargo/config.toml; re-read shared files immediately before editing. Never rewrite an existing file wholesale.
- Never run git checkout, git stash, git reset, git clean, or anything that discards working-tree changes. Do not commit.
- Cargo in ${ZED} shares one build directory and serializes on a lock; waiting is expected.
- Gates are cfg(target_family = "wasm") in upstream's crate layout. Native behavior must be unchanged: run \`cargo check -p <crate>\` natively after your change and keep it warning-free.
- Precedence: ${DEC} (v1 and v2) beats ${CON} beats the briefs in ${B} (b5 build env and shims, b6 leaf gates, b7 edge gates and zed_web; grep them for your crate name and follow their approach).
- Patterns already established in this tree (read examples before inventing): the smol shim (crates/zs_smol_shim) for process/fs/net; util's wasm gates (util.rs, paths.rs) for shell/archive/shell_env; http_client's gated github modules; fs::WasmFs; web_time::Instant instead of std::time::Instant; BackgroundExecutor::scoped is unavailable on wasm (use spawn + join or a sequential fallback under cfg); Send bounds on wasm differ (see language_core::ParseableLanguage and gpui_web notes).
- Real code only. Mark anything unfinished \`// ZS-TODO(wasm):\` and report it.`

const CHECK_SCHEMA = { type: 'object', properties: { clean: { type: 'boolean' }, log_path: { type: 'string' }, failing_crates: { type: 'array', items: { type: 'object', properties: { crate: { type: 'string' }, error_count: { type: 'integer' }, summary: { type: 'string' }, first_errors: { type: 'array', items: { type: 'string' } } }, required: ['crate', 'error_count', 'summary', 'first_errors'] } }, clean_count: { type: 'integer' }, notes: { type: 'string' } }, required: ['clean', 'log_path', 'failing_crates', 'clean_count', 'notes'] }
const FIX_SCHEMA = { type: 'object', properties: { crate: { type: 'string' }, files_changed: { type: 'array', items: { type: 'string' } }, wasm_clean: { type: 'boolean' }, native_clean: { type: 'boolean' }, remaining_errors: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } }, required: ['crate', 'files_changed', 'wasm_clean', 'native_clean', 'remaining_errors', 'notes'] }
const DONE_SCHEMA = { type: 'object', properties: { verification: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, status: { type: 'string' }, notes: { type: 'string' } }, required: ['command', 'status'] } }, sizes: { type: 'object', properties: { raw_bytes: { type: 'integer' }, gzip_bytes: { type: 'integer' }, brotli_bytes: { type: 'integer' }, assets_bytes: { type: 'integer' }, build_id: { type: 'string' } } }, gaps: { type: 'array', items: { type: 'string' } } }, required: ['verification', 'gaps'] }

const stuck = {}
let last = null
phase('WasmLoop')
for (let i = 1; i <= MAX_LOOPS; i++) {
  const check = await agent(`Run \`cd ${ZED} && ./script/check-wasm -p zed_web --keep-going\` and wait for it (it can take 10 to 40 minutes). Read the full log it writes under target/wasm-logs/. Group every error by the crate it occurs in (from "--> crates/<crate>/..." or vendor paths and from "error: could not compile" lines). Return clean=true only if the check finished with no errors. For each failing crate: error_count, a one-paragraph summary of the failure kinds, and up to 10 representative first_errors verbatim with file:line. Also count crates that checked clean (clean_count). Do not modify files.`, { label: `wasm-check:${i}`, phase: 'WasmLoop', schema: CHECK_SCHEMA })
  if (!check) { log(`pass ${i}: checker returned nothing; stopping`); break }
  last = check
  log(`pass ${i}: clean=${check.clean}, failing=${check.failing_crates.length}, clean_count=${check.clean_count}`)
  if (check.clean) break
  const groups = check.failing_crates.slice(0, MAX_PARALLEL_FIXES)
  if (check.failing_crates.length > MAX_PARALLEL_FIXES) log(`pass ${i}: fixing ${MAX_PARALLEL_FIXES} of ${check.failing_crates.length} failing crates this pass`)
  await parallel(groups.map(g => () => {
    const n = (stuck[g.crate] = (stuck[g.crate] || 0) + 1)
    const escalate = n >= 3
    const effort = escalate ? 'max' : undefined
    const extra = escalate ? `\nThis crate has failed ${n} passes in a row. Escalation: you may also edit the crates it directly depends on inside the workspace when the root cause lives there (name them in your report), and you may restructure the gate (e.g. move a native-only module behind a cfg at the module level rather than gating call sites one by one). Read the previous fixers' notes in git diff for this crate before starting.` : ''
    return agent(`${ETIQUETTE}\n\nWasm closure pass ${i}. Assigned crate: \`${g.crate}\`.${extra}\nErrors seen (full log at ${check.log_path}):\n${g.summary}\n${g.first_errors.join('\n')}\n\nMake \`${g.crate}\` compile for wasm32-unknown-unknown. Verify with \`cd ${ZED} && ./script/check-wasm -p ${g.crate}\` (if it cannot be checked alone because of features, use \`./script/check-wasm -p zed_web --keep-going\` and read only your crate's errors) and \`cargo check -p ${g.crate}\` natively (0 warnings). Report files changed, wasm_clean, native_clean, and any remaining errors verbatim.`, { label: `wasm-fix:${i}:${g.crate}`, phase: 'WasmLoop', schema: FIX_SCHEMA, effort })
  }))
}

phase('Bundle')
const bundle = await agent(`${ETIQUETTE}\n\nThe zed_web wasm closure check result was: ${JSON.stringify(last && { clean: last.clean, failing: last.failing_crates.map(f => f.crate) })}.\n1. If clean: run \`cd ${ZED} && ./script/build-web\` (wasm-opt and brotli should now be installed via Homebrew; if wasm-opt is missing, use --skip-wasm-opt and say so). Record build id, raw/gzip/brotli wasm sizes and the assets tarball size from its output, and confirm the bundle landed under ${REPO}/apps/web/public/editor/<build>/ with manifest.json updated (replace the dev-0 stub as the served bundle per CONTRACTS §8.4). Then load the loader page in a headless Chromium (playwright is available under apps/web; write a 30-line smoke script under ${ZED}/crates/zed_web/tests/ or apps/web/tests/e2e-browser/smoke.spec.ts) that serves apps/web/public with COOP/COEP headers and asserts the wasm instantiates and the canvas mounts without console errors; report the real result.\n2. Append every crate that now checks clean in the closure to script/check-wasm's default_packages (round-3 gap R4-2) and run \`./script/check-wasm\` to prove the default list is green.\n3. If not clean: do not build; list the remaining failing crates with first errors.\nReturn verification and sizes.`, { label: 'bundle', phase: 'Bundle', schema: DONE_SCHEMA })

phase('Integrate')
const integ = await agent(`${ETIQUETTE}\n\nRound-3b integrator. Bundle result: ${JSON.stringify(bundle && { sizes: bundle.sizes, gaps: bundle.gaps })}.\n1. Native regression: \`cd ${ZED} && cargo check -p zed -p zed_web -p remote -p remote_server -p project -p workspace -p editor\` (0 warnings) and the test filters: cargo test -p remote websocket; -p remote_server serve; -p remote_server pty; -p remote_server client_state; -p remote_server control; -p terminal remote; -p db client_state; -p fs wasm_fs; -p project remote; -p workspace remote. Fix minimal breakage.\n2. Update ${CON} §13.2 with the round-3 vendored crates (alacritty_terminal, wasm_thread, async-tar, pet*, tree-sitter-{python,rust,bash,cpp,yaml}) and the sqlite-wasm-rs provenance rule, and mark §5.4 rows for KeymapOs, PlatformStyle::set_platform_style, WasmFs, sign_in_supported as landed (round-3 gap R4-6); minimal edits.\n3. Write ${REPO}/docs/status/round3b.md, ONE PAGE: wasm status (clean or the failing list), bundle sizes and build id, browser smoke result, verification commands with pass/fail, gaps for round 4.\nReturn verification results and gaps.`, { label: 'integrate:round3b', phase: 'Integrate', schema: DONE_SCHEMA })

return { wasm: last && { clean: last.clean, failing: last.failing_crates.map(f => f.crate), clean_count: last.clean_count }, bundle: bundle && bundle.sizes, integration: integ }
