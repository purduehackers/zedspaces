export const meta = {
  name: 'zs-impl-round4',
  description: 'Round 4: browser end-to-end. Test hooks in zed_web, Playwright suite across Chromium/Firefox/WebKit against the local backend, AI proxy Rust half; review, fix, run the suite for real',
  phases: [
    { title: 'Implement', detail: 'lanes hooks+playwright, b11-rust' },
    { title: 'Review', detail: 'adversarial lenses per lane' },
    { title: 'Fix', detail: 'apply accepted findings' },
    { title: 'E2E', detail: 'run the browser suite, fan out fixes per failing test, repeat' },
    { title: 'Integrate', detail: 'status' },
  ],
}

const REPO = '/Users/ray/Projects/play/wed'
const ZED = `${REPO}/zed`
const B = `${REPO}/docs/briefs`
const DEC = `${B}/DECISIONS.md`
const CON = `${B}/CONTRACTS.md`
const SPEC = `${REPO}/BUILD-SPEC.md`
const STATUS = [1, 2, '2b', 3, '3b', '3c'].map(n => `${REPO}/docs/status/round${n}.md`)
const MAX_LOOPS = 8

const ETIQUETTE = `
Working agreements (binding):
- Other agents are editing OTHER parts of this repository at the same time. Only touch files your lane owns. Shared files: minimal additive edits, re-read immediately before editing. Never rewrite an existing file wholesale.
- Never run git checkout, git stash, git reset, git clean, or anything that discards working-tree changes. Do not commit.
- Previous rounds landed: read ${STATUS.join(', ')} first. Build on them.
- Precedence when documents conflict: ${DEC} (v1 and v2) beats ${CON}, which beats the briefs.
- Cargo in ${ZED} shares one build directory and serializes on a lock. The wasm bundle is built with \`cd ${ZED} && ./script/build-web\` (slow: run it only when your lane's verification says so). Native: \`cargo check -p <crate>\`.
- Write real, complete code; validate by running it. Report exact commands and real output.
- Browser failures are diagnosed from console and network evidence, never screenshots: 'apps/web/.zs-dev/netdiag.mjs <workspace id> [takeover]' logs the first panic in full, failed requests, non-2xx responses and WebSocket lifecycle. './script/build-web --names' keeps wasm symbols so panic stacks name Rust functions (docs/status/round3c.md). The stack on port 3100 and the workspace it serves belong to the human; browser mode ('dev-local.sh browser', port 3110) is yours.`

const IMPL_SCHEMA = { type: 'object', properties: { files_changed: { type: 'array', items: { type: 'string' } }, tests_added: { type: 'array', items: { type: 'string' } }, verification: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, status: { type: 'string' }, notes: { type: 'string' } }, required: ['command', 'status'] } }, deviations_from_brief: { type: 'array', items: { type: 'string' } }, gaps: { type: 'array', items: { type: 'string' } } }, required: ['files_changed', 'tests_added', 'verification', 'deviations_from_brief', 'gaps'] }
const REVIEW_SCHEMA = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'integer' }, severity: { type: 'string', enum: ['blocking', 'major', 'minor'] }, claim: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' } }, required: ['file', 'severity', 'claim', 'evidence', 'fix'] } }, verdict: { type: 'string' } }, required: ['findings', 'verdict'] }
const FIX_SCHEMA = { type: 'object', properties: { fixed: { type: 'array', items: { type: 'string' } }, rejected: { type: 'array', items: { type: 'object', properties: { finding: { type: 'string' }, reason: { type: 'string' } }, required: ['finding', 'reason'] } }, verification: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, status: { type: 'string' }, notes: { type: 'string' } }, required: ['command', 'status'] } }, remaining_gaps: { type: 'array', items: { type: 'string' } } }, required: ['fixed', 'rejected', 'verification', 'remaining_gaps'] }
const E2E_SCHEMA = { type: 'object', properties: { all_passed: { type: 'boolean' }, report_path: { type: 'string' }, results: { type: 'array', items: { type: 'object', properties: { test: { type: 'string' }, browser: { type: 'string' }, status: { type: 'string' }, error: { type: 'string' }, likely_owner: { type: 'string', enum: ['zed_web', 'shell', 'local-backend', 'server', 'transport', 'test', 'unknown'] } }, required: ['test', 'browser', 'status', 'likely_owner'] } }, notes: { type: 'string' } }, required: ['all_passed', 'report_path', 'results', 'notes'] }

const LENSES = (lane, scope, verifyCmd) => [
  { name: 'correctness', prompt: `Adversarial reviewer for lane ${lane}. Scope: ${scope}. Read ${DEC}, ${CON}, the status docs, then the diff and new files. Hunt for flaky test design (timing sleeps instead of state waits), hooks that expose internals unsafely or only in test builds incorrectly (feature gating), assertions that cannot fail, wrong D6/D28 semantics in stop/resume tests, and browser-specific assumptions. Each finding: file, line, severity, failure scenario, evidence, fix. Do not modify files.` },
  { name: 'spec-compliance', prompt: `Spec-compliance reviewer for lane ${lane}. Scope: ${scope}. Compare against the lane task, ${CON}, ${DEC}, and BUILD-SPEC sections 3.4, 3.6, 5.1-5.5, 13. List missing or partial items and tests. Run ${verifyCmd} and report its real result. Do not modify files.` },
]

async function reviewFix(lane, scope, verifyCmd, ownership) {
  const findings = (await parallel(LENSES(lane, scope, verifyCmd).map(l => () => agent(l.prompt, { label: `review:${lane}:${l.name}`, phase: 'Review', schema: REVIEW_SCHEMA })))).filter(Boolean).flatMap(r => r.findings)
  log(`${lane}: ${findings.length} review findings`)
  if (!findings.length) return { lane, findings: 0, fix: null }
  const fix = await agent(`${ETIQUETTE}\n\nLane: ${lane}. You own: ${ownership}.\nReviewers produced the findings below (JSON). Verify each; fix real ones properly; reject non-real ones with a reason. Then run: ${verifyCmd}; report results.\nFindings:\n${JSON.stringify(findings, null, 2)}`, { label: `fix:${lane}`, phase: 'Fix', schema: FIX_SCHEMA })
  return { lane, findings: findings.length, fix }
}

const laneE2E = async () => {
  const own = `${ZED}/crates/zed_web/src/test_hooks.rs (new, behind cargo feature test-hooks) and the minimal wiring in zed_web main/host bridge; ${ZED}/script/build-web (a --test-hooks flag); ${REPO}/apps/web/tests/e2e-browser/** (new Playwright project, config, fixtures), apps/web/scripts/dev-local.sh (add a \`browser\` mode that builds the bundle with test hooks if missing and serves it), and apps/web/package.json test scripts.`
  const verify = `cd ${REPO}/apps/web && pnpm lint && pnpm exec tsc --noEmit && pnpm test && ./scripts/dev-local.sh browser --project=chromium`
  const impl = await agent(`${ETIQUETTE}\n\nLane: e2e-browser. You own: ${own}.\nRead ${STATUS.join(', ')}, ${CON}, ${DEC}, BUILD-SPEC 3.4/3.6/5/13, and the existing zed_web crate, host bridge and shell page.\nTask:\n1. Test hooks: add a \`test-hooks\` cargo feature to crates/zed_web that, when enabled, exposes \`window.__zs_test\` via wasm-bindgen with async methods implemented against the real workspace/editor/terminal entities on the GPUI foreground executor: connectionState() -> {phase, epoch, closeDetail}, openFile(path), bufferText(path), activeBufferText(), insertText(text), moveCursorEnd(), save(), isDirty(path), spawnTerminal(cwd?), terminals() -> [{id,title,cwd}], terminalInput(id, text), terminalScrollback(id) -> string, lifecycleEvents() -> [...], completionsVisible() -> bool, triggerCompletion(), waitIdle(). Never compiled into production bundles; script/build-web gains --test-hooks and emits to a separate <build>-test directory.\n2. Playwright: apps/web/tests/e2e-browser with projects chromium, firefox, webkit (install browsers with pnpm exec playwright install), served through the dev server with COOP/COEP, using the local backend (round 2b) and dev auth. Tests, each waiting on state via hooks (no fixed sleeps): boot-to-editable (assert under 15 s locally and record the actual time); open a fixture file, type, save, assert the file on disk changed (read via the local backend workspace dir exposed by a test-only API route); completions appear in a TypeScript fixture with typescript-language-server available on PATH (skip with a clear reason if not installed, but install it via pnpm in the fixture if feasible); terminal: spawn, send \`echo zs-e2e-$RANDOM\`, assert scrollback; reconnect: a test-only local-backend route drops the socket, assert the client reconnects and buffer text survives; takeover: open a second page, assert first page shows superseded (close detail per D23); stop and resume: stop via API with a dirty buffer open, assert unsaved text restored dirty after resume (D6) and terminal tabs recreated in their cwd (D28); hidden-tab flush (visibilitychange) persists client state; keyboard layer: Cmd/Ctrl+W remapped does not close the tab. Produce an HTML report under apps/web/test-results/.\n3. dev-local.sh browser mode wiring and package.json scripts (test:e2e, test:e2e:ci).
4. Two bugs observed in a manual run (fix them and add regression tests): (a) apps/web: a workspace whose database state is "running" but whose sandbox is dead (local backend: supervisor and server processes gone, e.g. after scripts/dev-local.sh stop; Vercel: session ended) makes POST /connect return sandbox_unhealthy forever with no recovery. /connect must reconcile: when the backend reports the sandbox not alive or health fails, transition the workspace to stopped and resume it (getOrCreate/resume path), then continue; dev-local.sh stop must also mark affected workspaces stopped through the API or DB. (b) The editor shell's CSP blocks Next.js dev-mode inline styles (dozens of "Applying inline style violates style-src" errors); fix by plumbing the nonce to those styles or by a dev-only style-src relaxation that never ships in production, and assert in a test that the production CSP is unchanged.\nVerification you must run before returning:\n${verify}`, { label: 'impl:e2e-browser', phase: 'Implement', schema: IMPL_SCHEMA })
  const rf = await reviewFix('e2e-browser', 'zed_web test hooks, Playwright suite, dev-local browser mode', verify, own)
  return { lane: 'e2e-browser', impl, review: rf }
}

const laneB11Rust = async () => {
  const brief = `${B}/b11-ai-proxy.md`
  const own = `${ZED}/crates/zed_web (settings seeding for language_models per the brief, credentials placeholder provider on wasm), ${ZED}/crates/language_models and crates/credentials_provider only for the cfg-gated changes the brief specifies, and tests.`
  const verify = `cd ${ZED} && cargo check -p zed_web -p language_models -p credentials_provider && ./script/check-wasm -p zed_web && cargo test -p language_models proxy`
  const impl = await agent(`${ETIQUETTE}\n\nLane: b11-rust. Brief: ${brief} (Rust sections). You own: ${own}.\nThe TypeScript proxy exists (round 2b: apps/web/app/api/ai/**, lib/ai/**). Implement the Rust half: on wasm, seed language_models settings so each provider's api_url points at <origin>/api/ai/<provider> (origin from the host bridge config), a credentials provider that returns the placeholder token the proxy expects so provider code proceeds, gating of providers that cannot work in the browser (bedrock already gated; anything else the brief lists), and the in-editor prompt when a provider is unconfigured (the proxy's 4xx maps to a clear message). Unit tests for settings seeding and the credentials provider. Native behavior unchanged.\nVerification you must run before returning:\n${verify}`, { label: 'impl:b11-rust', phase: 'Implement', schema: IMPL_SCHEMA })
  const rf = await reviewFix('b11-rust', 'zed_web AI settings seeding and credentials provider, language_models gates', verify, own)
  return { lane: 'b11-rust', impl, review: rf }
}

phase('Implement')
log('Round 4: lanes e2e-browser and b11-rust starting')
const lanes = (await parallel([laneE2E, laneB11Rust])).filter(Boolean)

phase('E2E')
let last = null
for (let i = 1; i <= MAX_LOOPS; i++) {
  const run = await agent(`Run the browser end-to-end suite for real: \`cd ${REPO}/apps/web && ./scripts/dev-local.sh browser\` (all three Playwright projects; this builds the test-hooks bundle if missing, starts the local backend and dev server, runs the suite, and shuts down). Read the JSON/HTML report it produces. Return all_passed, the report path, and one entry per test per browser with status, the error text if any, and your best attribution of the failing layer (zed_web, shell, local-backend, server, transport, test, unknown). Do not modify files.`, { label: `e2e-run:${i}`, phase: 'E2E', schema: E2E_SCHEMA })
  if (!run) { log(`e2e loop ${i}: runner returned nothing; stopping`); break }
  last = run
  const failing = run.results.filter(r => r.status !== 'passed' && r.status !== 'skipped')
  log(`e2e loop ${i}: all_passed=${run.all_passed}, failing=${failing.length}`)
  if (run.all_passed || !failing.length) break
  const byOwner = {}
  for (const f of failing) (byOwner[f.likely_owner] = byOwner[f.likely_owner] || []).push(f)
  await parallel(Object.entries(byOwner).map(([owner, items]) => () => agent(`${ETIQUETTE}\n\nE2E fix pass ${i}, layer: ${owner}. Ownership by layer: zed_web -> ${ZED}/crates/zed_web and the crates it drives (edit the crate where the bug is, minimally); shell -> ${REPO}/apps/web/app/w and the host bridge JS; local-backend -> apps/web/lib/sandbox-local.ts and scripts; server -> ${ZED}/crates/remote_server; transport -> ${ZED}/crates/remote; test -> apps/web/tests/e2e-browser. Failing tests (JSON):\n${JSON.stringify(items, null, 2)}\nReport at ${run.report_path}. Reproduce each failure (run just that test with --project=<browser> -g "<name>" via ./scripts/dev-local.sh browser -- <args>, reading its trace), find the root cause, fix it properly (never by loosening the assertion unless the assertion itself is wrong, and say so), rebuild the bundle if you changed Rust (./script/build-web --test-hooks), and re-run the affected tests until they pass. Return files changed and verification.`, { label: `e2e-fix:${i}:${owner}`, phase: 'E2E', schema: IMPL_SCHEMA })))
}

phase('Integrate')
const integ = await agent(`${ETIQUETTE}\n\nRound-4 integrator. Final e2e result: ${JSON.stringify(last && { all_passed: last.all_passed, failing: last.results.filter(r => r.status !== 'passed' && r.status !== 'skipped').map(r => `${r.browser}:${r.test}`) })}.\n1. Run \`cd ${ZED} && cargo check -p zed -p zed_web -p remote -p remote_server\` natively and the round-1/2 test filters; fix minimal breakage. Then close round-2b gaps E1 and E2: rebuild the server (\`cargo build -p remote_server\`) so scripts/dev-local.sh no longer falls back to the stashed binary, re-run \`cd ${REPO}/apps/web && ./scripts/dev-local.sh e2e\` against the fresh binary and record the result; and fix the Turbopack warning from apps/web/lib/db.ts (\`new URL("../drizzle", import.meta.url)\`) by resolving the migrations directory without a URL-relative import.\n2. Record measured numbers from the e2e run: boot-to-editable per browser, bundle sizes from script/build-web output.\n3. Write ${REPO}/docs/status/round4.md, ONE PAGE: per lane one line, verification commands with pass/fail, e2e matrix (test x browser), measured numbers, gaps for round 5 (real Vercel run).\nReturn verification results and gaps.`, { label: 'integrate:round4', phase: 'Integrate', schema: FIX_SCHEMA })

return { lanes: lanes.map(l => ({ lane: l.lane, review: l.review && l.review.findings })), e2e: last && { all_passed: last.all_passed }, integration: integ }
