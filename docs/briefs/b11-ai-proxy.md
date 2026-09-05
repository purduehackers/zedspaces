# b11-ai-proxy: AI provider proxy and model configuration for the browser client

Brief id: `b11-ai-proxy`. Plan of record: `BUILD-SPEC.md` §8 (lines 399-403), decided by D15. Written 2026-09-02; **revised 2026-09-03 after review — see §8 for the finding-by-finding log.** The first draft was written against a tree in which `apps/web` was still the Next.js scaffold. That premise was wrong and every claim below has been re-checked against the tree as it stands: b9 has landed, so `apps/web` holds `package.json` (61 lines), `next.config.ts` (39 lines), `proxy.ts` (62), `vercel.ts` (21), `drizzle/0000_init.sql`, `app/(site)/*`, `app/(editor)/*`, 34 modules under `lib/` (`env.ts`, `auth.ts`, `editor-cookie.ts`, `crypto.ts`, `secrets.ts`, `manifest.ts`, `plans.ts`, `ratelimit.ts`, `redis.ts`, `schema.ts`, `concurrency.ts`, `csp.ts`, `audit.ts`, `api.ts`, `tokens.ts`, …), 14 suites under `tests/`, and `scripts/{keygen,rotate-secrets}.ts`; `docs/contracts/` exists (`docs/contracts/fixtures/manifest.example.json`). Every `lib/*` and `app/*` item below is therefore an **edit against real code**, anchored `file:line` on this checkout. Only `zed/crates/zed_web` and `zed/crates/zed_web_core` still do not exist (b7 is landing them), so those stay deltas on the b7 design, cited by section. Every Zed anchor is a `file:line` read on this checkout.

---

## 1. Goal

Make Zed's bring-your-own-key model providers and the sign-in-free edit-prediction providers work from the browser tab without ever sending a provider key to the browser: the control plane gains an authenticated, streaming pass-through at `/api/ai/{provider}/{...path}` that injects the user's key from encrypted storage, enforces per-user rate limits, daily request caps and monthly token caps, and records usage; `zed_web` seeds `language_models.*.api_url` and `edit_predictions.codestral.api_url` to `<origin>/api/ai/<provider>` and installs a credentials provider that answers Zed's key lookups with a placeholder when the control plane holds a key (and stores keys typed in the editor by calling the control plane), so every existing provider code path in `language_models`, `codestral` and `edit_prediction` runs unchanged. Vercel AI Gateway is a first-class upstream (one gateway key, `provider/model` ids) through Zed's existing `vercel_ai_gateway` provider, and the dashboard gets an AI keys page that also lets a key be exported into the sandbox environment for the in-sandbox ACP agents. **Scope of the caps:** the rate limits, daily request caps and monthly token caps in this brief cover the **browser path only**. The dashboard's "expose to workspaces" toggle puts a key into the sandbox environment, from which the in-sandbox agents call providers directly and unmetered — BUILD-SPEC:401 calls those agents "the primary AI experience", so this brief delivers BUILD-SPEC §7.10's metering for one of the two paths; §7 item 19 proposes the other. ACP agents and Copilot's language server are also not made to run from the browser by this brief; §7 records exactly what is missing for them (a stdio process relay over the session) and who should own it.

---

## 2. Existing code and contracts that matter

### 2.1 Plan, decisions and shared contracts

| Anchor | What it fixes for this brief |
|---|---|
| `BUILD-SPEC.md:32` | AI row of the parity table: "Claude Code, Codex and Gemini CLI as in-sandbox ACP agents in Zed's agent panel; bring-your-own-key model providers via a proxy". |
| `BUILD-SPEC.md:35` | Non-goal: Zed-hosted AI features that require Zed sign-in. |
| `BUILD-SPEC.md:83` | Browser crate list: `language_models` (API-key providers only), `edit_prediction` (only providers reachable without Zed sign-in). |
| `BUILD-SPEC.md:323` | "Vercel AI Gateway as the optional model proxy." |
| `BUILD-SPEC.md:334, 347, 387` | `secrets` table, `GET\|PUT\|DELETE /secrets`, AES-256-GCM envelope; "Secrets are never included in logs, manifests or client payloads". Line 387 says envelopes are "decrypted only inside the create and resume workflows to build the sandbox `env`" — §3.10's `resolveAiKey` decrypts inside a route handler on **every proxied request**, which is an amendment to that policy, recorded in §7 item 1. |
| `BUILD-SPEC.md:389-391` (§7.10), `BUILD-SPEC.md:393-395` (§7.11) | Two separate sections: §7.10 is metering, billing and spend caps per user and org; §7.11 is abuse limits and "sustained-CPU-with-no-session detection stops the workspace and **flags the account**" — the flag is `users.flagged_at`, which §3.10 step 2 now checks. |
| `BUILD-SPEC.md:401-403` | §8: in-sandbox agents authenticate "inside the terminal or via secrets"; model providers go through `/api/ai/{provider}/…`; AI Gateway "as the configured `api_url` for OpenAI- and Anthropic-compatible endpoints with the user's gateway key"; edit prediction via Copilot (language server in the sandbox) or Codestral with a key. Line 402 states that browser CORS blocks most providers; §2.5 below shows that is no longer the case, so the proxy's justification is key custody, limits and metering, not CORS (amendment recorded in §7). |
| `DECISIONS.md` D15 (line 19), D18 (22), D28 (37), D29 (38) | This brief exists; no secret-bearing variable in the server environment beyond what the supervisor inherits from the control plane; supervisor exports only `SHELL, HOME, USER, PATH, LANG` itself; `ZS_CONTROL_URL` is the canonical control-plane variable. |
| `CONTRACTS.md` §6.2 (line 330) | `zs_editor` cookie: HS256 with `ZS_EDITOR_COOKIE_SECRET`, claims `{ sub, ws, aud: "zs-editor", iat, exp: +12 h, jti }`, **`Path=/api/workspaces/<id>`**, minted by `proxy.ts` on `/w/:id` document requests and by `POST /api/workspaces/{id}/session`. The path scope means the editor cookie is never sent to `/api/ai/*`; §3.9 adds a sibling cookie. |
| `CONTRACTS.md` §7.2 (lines 356-379) | Sandbox env: user/org/repo secrets are inherited untouched by the server and children; `manifest.secretNames` is names only; `RESERVED_SECRET_NAMES` and the `ZS_` prefix are refused at `PUT /api/secrets`. |
| `CONTRACTS.md` §8.1 (lines 485-489) | Route conventions: `requireViewer()`, `allowEditorCookie`, error envelope `{ error: { code, message, details? } }` with the 401/404/400/409/402/423/429/413/500 codes, `proxy.ts` protected lists. |
| `CONTRACTS.md` §8.2 (line 514) | `GET\|PUT\|DELETE /api/secrets`, name regex `^[A-Z_][A-Z0-9_]{0,127}$`, value ≤ 64 KiB, rate `user.secrets` 60/min. |
| `CONTRACTS.md` §8.4 (lines 525-537) | `ZsBootConfig`/`ZsHost` (unchanged by this brief) and the editor CSP: `connect-src 'self' wss://*.vercel.run https://*.vercel.run` — a same-origin `/api/ai/*` fetch is allowed by `'self'`; a direct call to `https://api.anthropic.com` from the wasm client would be blocked by this CSP even though the upstream allows CORS (§2.5). |
| `CONTRACTS.md` §11 (line 615) | Wasm home `/home/web`; settings at `/home/web/.config/zed/settings.json`. |

### 2.2 b9 control plane (the design this brief extends)

| b9 section | Used as |
|---|---|
| §3.2 `lib/env.ts` (lines 191-265) | `envSchema` zod object, `env()`, `requireEnv`, `controlPlaneUrl()`; new keys go here (§3.1). |
| §3.7 `lib/redis.ts`, `lib/ratelimit.ts` (309-345) | `KV`, `keys`, `LimitName` union and `LIMITS` table (line 336-339): new limits `user.ai.requests`, `user.ai.keys`, `user.ai.streams` (§3.6). On disk: `apps/web/lib/ratelimit.ts:7-19` (`LimitName`), `:22-35` (`LIMITS`). Note `apps/web/lib/concurrency.ts` is `mapConcurrent(items, n, fn)`, an **in-process** p-limit helper — it is not a cross-invocation slot leaser, so §3.6's stream cap is a new Redis counter, not a use of that file. |
| §3.8 `lib/auth.ts`, `lib/editor-cookie.ts` (346-369) | `Viewer`, `requireViewer`, `mintEditorCookie`/`verifyEditorCookie`/`editorCookieAttributes` (jose HS256); the `zs_ai` cookie copies this shape (§3.8). The **shipped** signatures are `verifyEditorCookie(jar: CookieReader, workspaceId): Promise<EditorClaims \| null>` and `editorCookieAttributes(workspaceId, expires): EditorCookieAttributes`, where `CookieReader { get(name): { value: string } \| undefined }` is defined locally — `apps/web/lib/editor-cookie.ts:24-26`, `:29-35`, `:69`, `:98`. There is no `ReadonlyRequestCookies` and no `CookieAttributes` in this codebase. |
| §3.9 `lib/api.ts` (370-382) | `ApiError`, `json`, `error`, `parseBody`, `handler`, `bearer`. |
| §3.10 `lib/crypto.ts` (383-397) | `encryptSecret(plaintext, aad)`, `decryptSecret`, `secretAad(scope, scopeId, name)`, `rotateEnvelope`; envelope `v1:<kv>:<iv>:<ct>:<tag>` (§4.4, line 1212). |
| §3.13 `lib/plans.ts`, `lib/audit.ts` (454-472) | `Plan`, `PLAN_LIMITS`, `assertCanCreate`, `audit()`. |
| §3.17 `lib/secrets.ts` (549-563) | Shipped at `apps/web/lib/secrets.ts`: `resolveEnvFor(workspace: Pick<Workspace, "ownerUserId" \| "orgId" \| "repoId">): Promise<ResolvedEnv>` (`:61-82`, user < org < repo precedence), `assertSecretName` (`:41-48`), `SECRET_NAME` (`:15`), `RESERVED_SECRET_NAMES` (`:21-34`). §3.12 edits this file, it does not create it. `lib/manifest.ts` is likewise on disk; its `prebuildManifest` (`:158-190`) builds its own `env` and never calls `resolveEnvFor`, which is why prebuild principals get no AI env. |
| §3.21 `proxy.ts` (636-678) | Shipped at `apps/web/proxy.ts`: `isProtectedPage` (`:9-18`), `isProtectedApi` (`:21` — `/api/repos`, `/api/me`, `/api/secrets`, `/api/admin`), editor-cookie minting on `/w/:id` document requests (`:46-51`, `sec-fetch-dest !== "empty"`, with the comment "the cookie proves `userId`; workspace access is checked in page.tsx"), and the `config.matcher` (`:55-61`) whose negative lookahead already excludes `api/sandboxes/`, `api/webhooks/` and `api/cron/` as "routes that authenticate on their own". §3.9 adds `api/ai/` to that list. |
| §3.22 `next.config.ts` (679-702) | `/api/:path*` already gets `Cache-Control: no-store`. |
| §3.24 route table (720-754) | Every route file exports `runtime = "nodejs"`; `maxDuration` via the route-segment export (§3.23, line **718**). §3.23 also owns `vercel.ts`, which §3.9a now edits (`apps/web/vercel.ts` has `framework` and `crons` only — no `functions` key). |
| §3.26 shell (767-818), bullet 8 | "Every 6 h and after any `401`: `POST /api/workspaces/{id}/session` to refresh `zs_editor`" — the same call re-mints `zs_ai` (§3.9). |
| §3.27 pages (819-822) | Dashboard pages use server actions calling `lib/*`; `secrets/page.tsx`, `settings/page.tsx` exist; §3.14 adds `ai/page.tsx`. |
| §4.1 schema | `secretScopeEnum` (line 851), `users` (**864-878**; line 862 is the `const ts = …` helper; `plan` 869, `spendCapCents` 871, `flaggedAt` 873 — "creation refused while set"), `orgs` (880-891; `spendCapCents` 887), `memberships` (many-to-many: `primaryKey([orgId, userId])` plus `memberships_user_idx`, so "the user's org" is a set, not a value — §3.5 must say which one applies), `secrets` (1031-1041), `settingsDocs` (1043-1049), `auditLog` (1080). On disk: `apps/web/lib/schema.ts:60` `users`, `:69` `spendCapCents`, `:72` `flaggedAt`, `:82` `orgs`, `:100-112` `memberships`. |
| §4.2 route contracts (1105-1207) | Error codes and id regexes; `GET /api/secrets` never returns values (1160-1161). |
| §5 (1506-1575) | Pinned versions: `next 16.3.4`, `zod 4.5.4`, `jose 6.2.10`, `@upstash/ratelimit 2.0.8`, `@upstash/redis 1.38.3`, `drizzle-orm 0.45.2`, `@vercel/functions 3.9.5`, `vitest 4.1.11`, `tsx 4.23.13`. The **versions** match the on-disk file; the file is **not** identical to b9 §5. `apps/web/package.json` is 61 lines (`scripts` 5-18, `dependencies` **19-39**, `devDependencies` **41-59**), and it has no `"@zs/sdk": "workspace:*"` (b9:1539), no `"prebuild": "tsx scripts/fetch-editor-bundle.ts"` (b9:1515), `test:integration` points at `vitest.integration.config.mts` (b9:1524 says `.ts`), and it declares **no `engines`** — §5 adds one. |
| §6.5 route tests (1626-1637) | Test style: route handlers invoked directly with `Request` objects, fakes on `globalThis`, `vi.mock` for SDKs. |
| §7 item 16 (line 1674), §8 M2 (1753) | "v0 ships with `language_models` disabled on wasm … b11 owns streaming, per-user rate limits, key lookup from `secrets` (scope user) and `maxDuration`", and "`proxy.ts`'s matcher and `lib/ratelimit.ts` gain nothing for it here". b7 §3.26 step 22 nevertheless calls `language_models::init` on wasm. This brief reverses all three clauses — `language_models` **is** initialised on wasm, keys live in a new `ai_keys` table rather than `secrets` (scope user), and `proxy.ts`'s matcher **does** change (§3.9) — and a peer brief cannot override b9 by itself: `DECISIONS.md:28` says only DECISIONS entries do that. §7 item 16 therefore asks for **D35**. |

### 2.3 b7 web entry crate (the design this brief extends)

| b7 section | Used as |
|---|---|
| §3.5 (304-313) | `language_models` on wasm: only `bedrock`, `extension_host`, `gpui_tokio` are gated; `init` signature unchanged. |
| §3.18 (529-562) | `crates/zed_web_core` (host-testable, pure deps): `WEB_SETTINGS_OVERRIDES`, `merge_web_defaults(base_json) -> Result<String>`; §3.16 adds `ai_proxy.rs` beside it. |
| §3.20 (567-617) | `crates/zed_web/src/zed_web.rs` module list (`assets, boot, bridge, connect, init, keymap, settings, window, workspace_chrome`); §3.17 adds `ai` and `edit_prediction`. |
| §3.21 (618-630) | `bridge::current_session()` for HTTPS calls to the sandbox; not used here (the proxy is same-origin and cookie-authenticated). |
| §3.24 (678-716) | `settings::web_default_settings() -> &'static str` ("parsed once"); `init(fs, settings_json, cx)`; §3.18 threads the origin through it. |
| §3.26 init order (734-780) | Step 4 `settings::init(fs.clone(), settings_json, cx)` (b7:737 — **before** step 8, which matters for §3.18: the origin must exist by step 4), step 8 `extension::init`, step 9 `Client::production(cx)` (which captures `zed_credentials_provider::global(cx)`, §2.4), step 13 `NodeRuntime::unavailable()`, step 21 `copilot_chat::init(.., zed_credentials_provider::global(cx), ..)`, step 22 `language_models::init`, step 23 "edit-prediction provider registration is a follow-up", step 30 (b7:774) `settings_ui::init(cx)` and the **crate** call `edit_prediction::init(cx)` — the reason §3.19's new module cannot also be called `edit_prediction`. |
| §4.5 (1068-1082) | Web default settings overrides JSON — extended, not replaced (§4.3). |
| §7 items 10 and 18 | `copilot`, `copilot_chat`, `copilot_ui`, `zed_credentials_provider` are in the browser closure but not compile-verified; the edit-prediction registry (`crates/zed/src/zed/edit_prediction_registry.rs`, `main.rs:703`) "needs a web copy limited to providers that work without Zed sign-in". |

### 2.4 Zed code (all `zed/crates/...`, read on this checkout)

**Provider registration and settings**

- `language_models/src/language_models.rs:36-47` `init(user_store, client, cx)` takes `client.credentials_provider()` and registers providers; `:216-344` `register_language_model_providers` (anthropic `:231-238`, openai `:239-246`, ollama `:247-254`, lmstudio `:255-262`, llama_cpp `:263-270`, deepseek `:271-278`, google `:279-286`, mistral `:287-294`, bedrock `:295-302`, open_router `:303-310`, vercel_ai_gateway `:311-318`, x_ai `:319-326`, opencode `:327-334`, copilot_chat `:335`, openai_subscribed `:336-343`); `:105-139` observes `SettingsStore` and (un)registers `openai_compatible`/`anthropic_compatible` entries keyed by their settings map keys.
- `language_models/src/settings.rs:16-34` `AllLanguageModelSettings`; `:47-213` every built-in provider's `api_url` is `content.api_url.unwrap()` (anthropic `:70`, deepseek `:114`, google `:119`, mistral `:136`, opencode `:152`, open_router `:163`, openai `:172`, vercel_ai_gateway `:195`, x_ai `:204`); compat entries carry `api_url: String` directly (`:85`, `:183`).
- `language_models/src/provider.rs:26` `COMMON_RESERVED_HEADER_NAMES = ["Authorization", "Content-Type", "Accept"]`; `:31-69` `resolve_custom_headers` drops reserved names, keeps any other valid header — user `custom_headers` reach the proxy and are forwarded per §4.6.
- `settings_content/src/language_model.rs:12-29` `AllLanguageModelSettingsContent` (fields `anthropic`, `anthropic_compatible`, `deepseek`, `google`, `llama.cpp`, `mistral`, `opencode`, `open_router`, `openai`, `openai_compatible`, `vercel_ai_gateway`, `x_ai`, `zed.dev`); `api_url: Option<String>` for built-ins (`:36, 190, 241, 292, 311, 341, 358, 379, 476, 496, 513, 577`), `api_url: String` for compat (`:44`, `:408`).
- `assets/settings/default.json:2542-2583` default `api_url`s: anthropic `https://api.anthropic.com`, google `https://generativelanguage.googleapis.com`, ollama `http://localhost:11434`, llama.cpp `http://localhost:8080`, openai `https://api.openai.com/v1`, opencode `https://opencode.ai/zen`, open_router `https://openrouter.ai/api/v1`, lmstudio `http://localhost:1234/api/v0`, deepseek `https://api.deepseek.com/v1`, mistral `https://api.mistral.ai/v1`, vercel_ai_gateway `https://ai-gateway.vercel.sh/v1`, x_ai `https://api.x.ai/v1`. `:1820-1898` `edit_predictions` (`provider: "zed"` `:1822`; `codestral.api_url` `https://codestral.mistral.ai` `:1865`; `open_ai_compatible_api.api_url ""` `:1878`). `:2854` `agent_servers: {}`.

**How `api_url` and keys are used**

- `language_models/src/provider/anthropic.rs:43-47` env var `ANTHROPIC_API_KEY`, `RESERVED_HEADER_NAMES = ["X-Api-Key", "Anthropic-Version", "Anthropic-Beta"]`; `:62-82` `set_api_key` → `ApiKeyState::store`; `:84-102` `authenticate` → `load_if_needed(api_url)`; `:104-131` `fetch_models` → `anthropic::list_models(http, &api_url, key, &extra_headers)`; `:139-177` observes `SettingsStore`, `handle_url_change` and re-authenticates when `api_url` changes; `:193-200` `api_url()` = settings value or `ANTHROPIC_API_URL`; `:278-286` `settings_view` → `ProviderSettingsView::ApiKey(ApiKeyConfiguration::new(has_key, is_from_env_var, env_var_name, "https://console.anthropic.com/settings/keys"))`.
- `anthropic/src/anthropic.rs:21` `ANTHROPIC_API_URL = "https://api.anthropic.com"`; `:345-357` `list_models` → `GET {api_url}/v1/models?limit=1000` with `Anthropic-Version: 2023-06-01`, `X-Api-Key`; `:261` `stream_completion`, which calls the private `send_request` (`:426-464`) whose `:434-444` builds `POST {api_url}/v1/messages` with `Anthropic-Version`, `X-Api-Key`, `Content-Type`, optional `Anthropic-Beta`; `:578` `parse_retry_after`; `:1010-1026` `Usage { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, iterations }`; `:1070` `Event::MessageStart { message }`, `:1081` `Event::MessageDelta { delta, usage }`.
- `language_models/src/provider/open_ai.rs:37-38` `OPENAI_API_KEY`; `:52-84` `State` with `ApiKeyState`; `:128-135` `api_url()`; `:364-399` `stream_completion` reads `(key, api_url, extra_headers)` and returns `LanguageModelCompletionError::NoApiKey` when the key is `None` (`:383-385`) — the reason the browser credentials provider must return a non-empty placeholder.
- `open_ai/src/open_ai.rs:22` `OPEN_AI_API_URL = "https://api.openai.com/v1"`; `:606-623` `StreamOptions { include_usage: true }`; `:1096-1136` `stream_completion`, which calls `chat_completion_request` (`:1137-1163`) — that is where `POST {api_url}/chat/completions` and `Authorization: Bearer` are actually built; `:1215-1233` `embed`; `open_ai/src/responses.rs:737-739` `POST {api_url}/responses/compact`, `:774-788` `stream_response` → `POST {api_url}/responses`. `open_ai/src/completion.rs:192` sets `stream_options` whenever streaming, so the last chat chunk carries `usage`.
- `language_models/src/provider/vercel_ai_gateway.rs:24-30` provider id `vercel_ai_gateway`, `API_URL = "https://ai-gateway.vercel.sh/v1"`, env `VERCEL_AI_GATEWAY_API_KEY`; `:159-166` `api_url()`; `:502-533` `list_models` → `GET {api_url}/models?include_mappings=true` with `Authorization: Bearer`; `:560-604` maps gateway model metadata to `AvailableModel` (tools/images/parallel_tool_calls/prompt_cache_key).
- `language_models/src/provider/api_compatible.rs:13-15` `ApiCompatibleProviderSettings::api_url`; `:24-53` state with env var `{ID}_API_KEY` (UpperSnake); `:59-72` `set_api_key`, `:74-82` `authenticate`, `:84-96` `update_settings` → `handle_url_change`; `:149-166` `save_api_key` from the inline editor; `:181-196` `remove_provider` edits the settings file. `anthropic_compatible.rs:27` placeholder text, `:165-189` `new(id, http, credentials_provider, cx)`, `:317-341` completion uses `state.settings.api_url`.
- `language_models/src/provider/google.rs:139-146` `api_url()`; `google_ai/src/google_ai.rs:12` `API_URL = "https://generativelanguage.googleapis.com"`, `:28` request URL `{api_url}/v1beta/models/{model_id}:streamGenerateContent?alt=sse&key={api_key}` — **the key travels in the query string**; `:138` `usage_metadata`, `:263-269` `prompt_token_count`, `tool_use_prompt_token_count`.
- `mistral/src/mistral.rs:12` `MISTRAL_API_URL = "https://api.mistral.ai/v1"`, `:426` Bearer; `deepseek/src/deepseek.rs:14` `https://api.deepseek.com/v1`, `:305-310` `{api_url}/chat/completions` Bearer; `open_router/src/open_router.rs:17` `https://openrouter.ai/api/v1`, `:580-593` `list_models` → `{api_url}/models/user` with Bearer, `HTTP-Referer: https://zed.dev`, `X-Title`; `x_ai/src/x_ai.rs:5` `https://api.x.ai/v1`; `opencode/src/opencode.rs:10` `https://opencode.ai/zen`, `:931-950` Google-style path `{api_url}/v1/models/{model}:streamGenerateContent?alt=sse` with `Authorization: Bearer` (not `key=`). **`opencode/src/opencode.rs:46-51` `OpenCodeSubscription::api_path_suffix()` returns `""` for Zen and `"/go"` for Go**, and `language_models/src/provider/opencode.rs:341-361` `base_api_url` appends it to the settings `api_url` before `:431-432`/`:468-469` append `/v1` and the anthropic arm (`:394-396`) uses it directly — so a Go model's real path is `{api_url}/go/v1/…`. Go models are shown by default (`settings_content/src/language_model.rs:247` `show_go_models: Option<bool>`, "Defaults to true"; `provider/opencode.rs:168`). `provider/opencode.rs:342-352` `Model::Custom { custom_model_api_url }` **replaces** the base URL entirely, bypassing the proxy (§7 item 4); `lmstudio/src/lmstudio.rs:10`, `ollama/src/ollama.rs:12` localhost defaults.
- `language_models/src/provider/copilot_chat.rs:26-31` authenticated iff the `CopilotChat` global holds an OAuth token; `:123-129` `authenticate` returns `CredentialsNotFound`; `:169-181`. `copilot_chat/src/copilot_chat.rs:23-24` env `GH_COPILOT_TOKEN`/`GITHUB_COPILOT_TOKEN`; `:536-545` `init(client, credentials_provider, configuration, cx)`; `:553-564` `load_stored_token` reads `credentials_provider.read_credentials(&configuration.credentials_url())`; `:634-640` `sign_in` starts a GitHub device-code flow (cross-origin to github.com).
- `language_models/Cargo.toml:14-68` dependencies (no change needed here).

**Key state and credentials providers**

- `language_model/src/api_key.rs:19-24` `ApiKeyState { url, env_var, load_status, load_task }`; `:72-96` `key(url)` returns the key only when `url == self.url` (keys are bound to the `api_url` they were loaded for); `:99-134` `store(url, key, ..)` → `provider.write_credentials(&url, "Bearer", key)` with `.log_err()` and then sets `LoadStatus::Loaded` **regardless of the write result** (`:113-131`); `:160-203` `load_if_needed` prefers a non-empty env var (`:173-182`) then `load()`; `:250-272` `load_from_system_keychain_impl` → `read_credentials(url)` → `Ok(Some((_, bytes)))` = loaded, `Ok(None)` = `NotPresent`, `Err` = `Error`.
- `env_var/src/env_var.rs:10-18` `EnvVar::new` reads `std::env::var` once; on `wasm32-unknown-unknown` that is `Err`, so `value: None` and every provider falls through to the credentials provider.
- `credentials_provider/src/credentials_provider.rs:11-34` trait `CredentialsProvider: Send + Sync` with `read_credentials(url, cx) -> Pin<Box<dyn Future<Output = Result<Option<(String, Vec<u8>)>>> + 'a>>`, `write_credentials(url, username, password, cx)`, `delete_credentials(url, cx)`. **The `Send + Sync` bound at `:11` is load-bearing**: an implementor must be `Sync`, so no `RefCell` may appear in its fields — `Arc<T>` would not coerce to `Arc<dyn CredentialsProvider>` (`zed_credentials_provider.rs:32-34` says the same in a comment). Every method returns a future borrowing `&'a self`, so a lock guard must never be held across an `await` inside one. `zed_credentials_provider/Cargo.toml` depends on `futures` for `boxed_local()` (`:99`, `:179`) and on `gpui` for `App`/`AsyncApp`.
- `zed_credentials_provider/src/zed_credentials_provider.rs:26-28` `pub struct ZedCredentialsProvider(pub Arc<dyn CredentialsProvider>); impl Global` — a public tuple struct, so any crate can `cx.set_global(ZedCredentialsProvider(provider))`; `:39-43` `global(cx)` returns the global or builds `new(cx)`; `:45-66` `new` picks `DevelopmentCredentialsProvider` (`:103-181`, `std::fs` on `paths::config_dir()/development_credentials` — unusable on wasm) or `KeychainCredentialsProvider` (`:68-101`, `cx.read_credentials` etc.).
- `gpui_web/src/platform.rs:657-671` the web platform's `write_credentials`/`delete_credentials` return `Err("credential storage is not available on the web")` and `read_credentials` returns `Ok(None)`: with the stock provider every key is "not present" and a typed key survives only in memory (because of `store`'s unconditional `Loaded`).
- `client/src/client.rs:359-362` `ClientCredentialsProvider::new(cx)` captures `zed_credentials_provider::global(cx)`; `:569` `Client::new` builds it; `:584` `production`; `:602` `credentials_provider()` — so the global must be installed **before** `Client::production` (b7 §3.26 step 9).
- `codestral/src/codestral.rs:24-26` `CODESTRAL_API_URL = "https://codestral.mistral.ai"`, env `CODESTRAL_API_KEY`; `:32-56` global `ApiKeyState` loaded through `zed_credentials_provider::global(cx)`; `:58-66` `codestral_api_url(cx)` = `edit_predictions.codestral.api_url` or the constant; `:149-154` `POST {api_url}/v1/fim/completions` with `Authorization: Bearer`; `:196-199` delegate name `"codestral"`.
- `edit_prediction/src/open_ai_compatible.rs:9-17` api url from `edit_predictions.open_ai_compatible_api.api_url`; `:19-21` env `ZED_OPEN_AI_COMPATIBLE_EDIT_PREDICTION_API_KEY`; `:42-50` token via `zed_credentials_provider::global`; `:105` Bearer.

**Edit prediction registry and UI**

- `zed/src/zed/edit_prediction_registry.rs:16-109` `init(client, user_store, cx)` (observe new editors, user-store events, settings changes); `:111-155` provider → config mapping (`Copilot`, `Codestral`, `Zed(Zeta)`, `Ollama`/`OpenAiCompatibleApi` → FIM/Zeta/Sweep formats, `Mercury`); `:213-289` `assign_edit_prediction_provider`: Copilot `:231-248` via `EditPredictionStore::start_copilot_for_project`, Codestral `:249-253` (`CodestralEditPredictionDelegate::new(client.http_client())`), Zed models `:254-288` via `ZedEditPredictionDelegate::new(project, buffer, &client, &user_store, cx)`. Called from `zed/src/main.rs:703`; not available to `zed_web` (b7 §3.26 step 23).
- `edit_prediction/src/edit_prediction.rs:1272-1299` `start_copilot_for_project` requires `project.node_runtime()` and spawns the Copilot LSP **locally** (`Copilot::new(Some(project), id, fs, node, cx)`); `:2502-2511` `is_ep_store_provider`; `:2763-2770` Zeta requests need Zed cloud credentials only when the provider is not `Ollama`/`OpenAiCompatibleApi`; `:3522` `pub fn init(cx)`.
- `copilot/src/copilot.rs:256-297` `GlobalCopilotAuth`; `:317-323` `Copilot::new(project, id, fs, node_runtime, cx)`; `:442-479` `start_copilot`; `:556-591` `start_language_server` → `get_copilot_lsp` then `lsp::LanguageServer::new(.., LanguageServerBinary { path, arguments: ["--stdio"], env }, "/", ..)`; `:1347-1380` `get_copilot_lsp` installs `@github/copilot-language-server` with the node runtime into `paths::copilot_dir()`; `:1382-1409` the native binary `node_modules/@github/copilot-language-server-<platform>-<arch>/copilot-language-server`.
- `lsp/src/lsp.rs:429-495` `LanguageServer::new` spawns the process with `util::command` (`util/src/command.rs:21` `Child = smol::process::Child`, `:113` `spawn`); `:497-517` private `fn new_internal<Stdin, Stdout, Stderr, F>(server_id, server_name, stdin, stdout, stderr: Option<Stderr>, stderr_capture, server: Option<Child>, code_action_kinds, binary, root_uri, workspace_folders, cx, on_unhandled_notification: F) -> Self where Stdin: AsyncWrite + Unpin + Send + 'static, Stdout: AsyncRead + Unpin + Send + 'static, Stderr: AsyncRead + Unpin + Send + 'static, F: Fn(&NotificationOrRequest) -> bool + 'static + Send + Sync + Clone` — the io-injecting constructor a remote transport would need. Note the fourth generic and the `Send + 'static` bounds on all three pipes; §4.8's wrapper must satisfy both (§7).
- `edit_prediction_ui/src/edit_prediction_button.rs:84-100` Copilot status from `EditPredictionStore::copilot_for_project`; `:198-210` Codestral "Missing API key for Codestral" tooltip; `:562-575` loads Mercury, OpenAI-compatible and Codestral keys on construction; `:1483-1520` `get_available_providers` (always `Zed`; Copilot only when `GlobalCopilotAuth` is authenticated; Codestral when a key is loaded; Ollama/OpenAI-compatible when configured; Mercury when a key is loaded).
- `settings_ui/src/pages/llm_providers_page.rs:151-174` renders a provider's `settings_view`; `:213-260` the API-key item: "API Key Configured"/"Reset Key" (`provider.set_api_key(None, cx)` at `:244`) when `has_key`, otherwise an input labelled `<provider> API Key` (`:252-260`). `settings_ui/src/pages/edit_prediction_provider_setup.rs:62-84` Codestral card bound to `codestral_api_key_state(cx)` and `codestral_api_url(cx)`; `:86-95` OpenAI-compatible card.
- `agent_ui/src/conversation_view/thread_view.rs:11213-11261` `render_model_not_available_error`: "Failed to authenticate with {provider} provider / Open the settings to configure the selected provider" (`:11227-11232`) and "No model selected / Configure a provider to get started" (`:11255-11258`) when no provider is authenticated (`language_model/src/registry.rs:278-280` `has_authenticated_provider`).
- `language_model/src/language_model.rs:420-426` `ProviderSettingsView::{ApiKey, Inline, SubPage}`; `:455-479` `ApiKeyConfiguration { has_key, is_from_env_var, env_var_name, api_key_url }`.

**HTTP client on wasm**

- `gpui_web/src/http_client.rs:23-39` `FetchHttpClient { credentials: FetchCredentials }` with `FetchCredentials::SameOrigin` as the default (`:35-36`), so same-origin requests carry cookies; `:63-66` `with_credentials`; `:78-102` `send` dispatches to the main thread; `:105-197` `fetch` copies every request header (`:138-146`) and wraps the response `ReadableStream` (`:183-194`) so SSE streams through; `:199-209` request bodies are buffered into memory ("streaming uploads require half-duplex Fetch support that browsers largely don't ship yet"). `gpui_web/src/platform.rs:199-210` `fetch_http_client()`; `gpui/src/app.rs:1635-1640` `http_client()`/`set_http_client`.

**ACP agents on a remote project (for §3.20 and §7)**

- `proto/proto/ai.proto:6-31` `GetAgentServerCommand { project_id, name, root_dir? } → AgentServerCommand { path, args, env, root_dir, login? }`. `project/src/agent_server_store.rs:615-625` the headless server answers it for local projects; `:850-882` the remote client requests it and returns `AgentServerCommand { path, args, env }` with `extra_env` merged; `:1163-1211` and `:1376-1411` local command env composition (project environment ∪ registry/distribution env ∪ `extra_env` ∪ `agent_servers.*.env` from settings — `settings_content/src/agent.rs:669` `AllAgentServersSettings`, `:738-770` `CustomAgentServerSettings::{Custom, Registry}` both carry `env`).
- `agent_servers/src/acp.rs:824-847` turns the command into a template with `remote_client.build_command(program, args, env, cwd, None, Interactive::No)` and, when that fails, uses the sandbox path **as a local program**; `:849-861` spawns it with `Child::spawn` — a local process. `remote/src/remote_client.rs:129-136` `Interactive`, `:1006` `RemoteClient::build_command`, `:1678` the `RemoteConnection` trait method (`:964-977` is `set_state`/`shell`/`default_system_shell` and `:1619-1627` is a test assertion plus `impl From<SshConnectionOptions>`; both were mis-anchored in the first draft). b1 line 776: the WebSocket transport's `build_command` returns `Err`. Consequently, on the browser build the agent panel resolves the agent on the server and then tries to spawn it in the tab, which b5's `smol` shim reports as unsupported. No brief b1-b9 adds a stdio relay (b3 relays PTYs only, CONTRACTS §5.1 lines 247-262). This is the delta recorded in §3.20/§7.

### 2.5 External facts verified on 2026-09-03

- **Vercel AI Gateway** (`https://vercel.com/docs/ai-gateway`, `/sdks-and-apis/openai-chat-completions`, `/sdks-and-apis/responses`, `/sdks-and-apis/anthropic-messages-api`, `/authentication-and-byok`, `/authentication-and-byok/api-keys`): OpenAI-compatible base `https://ai-gateway.vercel.sh/v1` with `GET /models`, `GET /models/{model}`, `POST /chat/completions`, `POST /embeddings`, `POST /responses`; Anthropic-compatible base `https://ai-gateway.vercel.sh` with `POST /v1/messages` and `POST /v1/messages/count_tokens`; auth `Authorization: Bearer <AI_GATEWAY_API_KEY>` (the Anthropic surface also accepts `x-api-key`); model ids are `provider/model` (`anthropic/claude-opus-5`, `openai/gpt-5.6-sol`); keys are created in the dashboard/CLI/API and look like `vck_…`; `POST /v1/api-keys` takes an optional **`expiresAt`** (UNIX ms) and an optional budget, and "When a team member leaves your team, Vercel deactivates any API keys they created" — so a gateway key **can** stop working without anyone revoking it, which is why §3.20 and §7 item 14 must not assume `routeAgents` keys are permanent; Claude Code is pointed at the gateway with `ANTHROPIC_BASE_URL=https://ai-gateway.vercel.sh`, `ANTHROPIC_AUTH_TOKEN=<key>`, `ANTHROPIC_API_KEY=""` ("Claude Code checks this variable first"). Live preflight from an arbitrary origin: `200`, `access-control-allow-origin: <origin>`, `access-control-allow-credentials: true`, allowed headers include `Authorization`, `x-api-key`, `anthropic-beta`, `ai-reporting-user`, `ai-reporting-tags`.
- **Anthropic**: `anthropic-sdk-typescript/src/client.ts` throws "It looks like you're running in a browser-like environment … set the `dangerouslyAllowBrowser` option" and, when allowed, sends `anthropic-dangerous-direct-browser-access: true`; `platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript` lists "Web browsers: disabled by default to avoid exposing your secret API credentials". Live preflight of `POST https://api.anthropic.com/v1/messages`: **`400` with no `access-control-allow-origin`** when the requested headers are `anthropic-version,content-type,x-api-key`; **`200` with `access-control-allow-origin: *`** when `anthropic-dangerous-direct-browser-access` is added to the requested headers. Zed's `anthropic` crate does not send that header (`anthropic.rs:434-444`), so a direct browser call to Anthropic fails at preflight unless the user adds it through `custom_headers`.
- **OpenAI**: `openai-node/src/client.ts` has the same `dangerouslyAllowBrowser` guard and no special header. Live preflight of `POST https://api.openai.com/v1/chat/completions` and `/v1/responses`: `200` with `access-control-allow-origin` set (echoed origin / `*`).
- Live preflights of Google `generativelanguage.googleapis.com`, Mistral, Codestral, OpenRouter, xAI and DeepSeek all answer `200`/`204` with `access-control-allow-origin`. Conclusion: CORS is not the blocker BUILD-SPEC §8 line 402 assumes; key custody ("never sent to the browser"), the editor CSP (`connect-src 'self' …*.vercel.run`, CONTRACTS §8.4), limits and metering are. §7 item 1 records the amendment.
- **Vercel Functions**, re-verified 2026-09-03 against the live docs (the bundled `vercel:vercel-functions` skill is wrong here and was the source of the first draft's error):
  - `https://vercel.com/docs/functions/limitations` (last_updated 2026-08-24), §"Request body size": **"The maximum payload size for the request body or the response body of a Vercel Function is 4.5 MB"**, exceeding it returns `413 FUNCTION_PAYLOAD_TOO_LARGE`. The skill's "request bodies up to 100 MB (up from 4.5 MB)" (`skills/vercel-functions/SKILL.md:484`) contradicts the live docs; the docs win. §3.1's cap is 4 MiB, below the platform ceiling, so the proxy's own 413 envelope is what a client sees. (The same sentence's "or the response body" clause is about buffered responses; streaming responses are documented separately and are the mechanism §3.10 uses — but it is not proven that a >4.5 MB **streamed** response is exempt, so §7 item 18 records it.)
  - `maxDuration`: fluid compute defaults to 300 s on every plan; Hobby maximum 300 s, Pro/Enterprise maximum 800 s with an 1800 s extended beta. `FUNCTION_INVOCATION_TIMEOUT` is 504.
  - **Client-disconnect cancellation is opt-in** (`https://vercel.com/docs/functions/functions-api-reference` §"Cancel requests"; `https://vercel.com/docs/functions/runtimes/node-js` §"Cancelled Requests"): `request.signal` fires **only** when `vercel.json`/`vercel.ts` declares `"functions": { "<path>": { "supportsCancellation": true } }` for that path. Without it the platform never signals disconnect at all, so neither `req.signal` nor a `ReadableStream` `cancel` hook runs and an abandoned stream keeps billing the user's provider. §3.9a adds the flag.
  - Node.js version is **not** documented as defaulting to 24: it comes from `engines.node` in `package.json` or the project setting (`https://vercel.com/docs/functions/runtimes/node-js/node-js-versions`). `apps/web/package.json` declares no `engines`, so §5 adds `"engines": { "node": "24.x" }` — `AbortSignal.any` needs Node ≥ 20.3.
  - Next docs on disk: `apps/web/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md:107-121` (`RouteContext<'/…'>` typing), `:367-401` (streaming `Response(stream)`), `02-route-segment-config/maxDuration.md:6-13`, `04-functions/after.md:6` ("after a response (or prerender) is finished") and **`after.md:50`** ("`after` will run for the platform's default or configured max duration of your route") — the on-disk docs do **not** say when `after` fires relative to a *streamed* body finishing, which §3.10 step 9 and §7 item 18 now treat as unproven.

---

## 3. Change list in dependency order

Control plane first (the wasm side depends on the routes), then `zed_web_core`, then `zed_web`.

### 3.1 `apps/web/lib/env.ts` (modify b9 §3.2)

Add to `envSchema`:

```ts
ZS_AI_PROXY: z.enum(["on", "off"]).default("on"),                 // "off" → every /api/ai route answers 404 ai_disabled; GET /api/ai/keys answers 404 too, and zed_web treats that as "no provider configured" (§3.17)
ZS_AI_MAX_BODY_BYTES: z.coerce.number().int().max(4_500_000).default(4 * 1024 * 1024),
ZS_AI_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().max(290_000).default(290_000),
ZS_AI_FIRST_BYTE_TIMEOUT_MS: z.coerce.number().int().default(60_000),
ZS_AI_MAX_STREAMS_PER_USER: z.coerce.number().int().default(8),   // concurrent in-flight proxied requests per user (§3.10 step 3a)
ZS_AI_ALLOW_COMPAT: z.enum(["0", "1"]).default("0"),              // user-registered OpenAI/Anthropic-compatible upstreams: off unless deliberately enabled
ZS_AI_COMPAT_HOSTS: z.string().optional(),                        // optional comma-separated host allowlist for compat upstreams; when set, assertPublicHttpsUpstream accepts only these
```

`ZS_AI_MAX_BODY_BYTES` is capped at 4.5 MB by the schema because that is the platform ceiling (§2.5): above it the request is rejected by Vercel with its own `413 FUNCTION_PAYLOAD_TOO_LARGE` before `proxyAiRequest` runs, so the brief's 413 envelope would never fire. `ZS_AI_UPSTREAM_TIMEOUT_MS` is capped at 290 s so it always stays below the route's `maxDuration = 300` (§3.11) and the proxy, not the platform, produces the 504.

There is deliberately **no** `ZS_AI_UPSTREAM_OVERRIDES`. The first draft had one, gated on `VERCEL_ENV !== "production"`; that gate does not fire on a **preview** deployment, which is exactly where BUILD-SPEC §13 runs Playwright and which normally shares `ZS_SECRETS_KEYS` and the database with production (b9 §3.2 defines no separate preview key set). A single preview environment variable would then redirect every user's decrypted provider key to an attacker-chosen host — key exfiltration through configuration alone. §6.6's e2e instead registers a `compat/<name>` row pointing at the local fake upstream: per-user, already audited, already rate-limited, and it exercises the real code path.

No new `requireEnv` keys: the proxy reuses `ZS_EDITOR_COOKIE_SECRET` (cookie) and `ZS_SECRETS_KEYS`/`ZS_SECRETS_ACTIVE_KEY_VERSION` (envelope).

### 3.2 `apps/web/lib/schema.ts` (modify b9 §4.1)

New enum, two tables, two columns (full definitions in §4.1):

- `export const aiProviderKindEnum = pgEnum("ai_provider_kind", ["anthropic", "openai", "google", "mistral_fim", "opencode"]);`
- `aiKeys` (`ai_keys`): one row per `(userId, provider)`; ciphertext via `lib/crypto.ts`; `exportEnv`, `routeAgents`, `upstream` (compat only), `lastUsedAt`.
- `aiUsage` (`ai_usage`): one row per proxied request.
- `users.aiTokenCapMonth: integer("ai_token_cap_month")` (nullable; **tightens** the plan default, never raises it — §3.5), `orgs.aiTokenCapMonth` (same; the stricter of user and org applies).

Both columns are admin-only. `PUT /api/admin/users/{id}/ai-caps` (b9's `/api/admin` surface, already in `isProtectedApi`) is the only writer, it clamps to `min(value, PLAN_LIMITS[plan].ai.tokensPerMonth)`, and it writes an `ai_cap.set` audit row. No user-facing route sets them; the AI page (§3.14) renders them read-only.

A drizzle migration `drizzle/000X_ai_keys.sql` is generated with `pnpm db:generate` (b9 §5 scripts); this brief does not run it.

### 3.3 `apps/web/lib/ai/providers.ts` (new)

The provider table (data in §4.2, also written to `docs/contracts/ai-providers.v1.json` so `zed_web_core` tests pin the same ids). Two rules that the first draft left to string concatenation are now explicit, because Next hands `params` **percent-decoded**: a segment sent as `%3F`, `%23`, `%5C` or `%2F` decodes *before* both the allowlist test and the URL join, so `/api/ai/anthropic/v1/models/x%3Ffoo%3Dbar` would produce the validated string `/v1/models/x?foo=bar` (which `/v1/models/[^/]+` accepts, since `[^/]` matches `?`) and an upstream URL carrying an attacker-chosen query. Therefore (a) every decoded segment must match `PATH_SEGMENT` before anything else, and (b) the upstream URL is built with `new URL()` and re-validated (`url.origin === new URL(spec.upstream).origin` and `url.pathname.startsWith(new URL(spec.upstream).pathname)`) rather than concatenated.

```ts
export type AiProviderKind = "anthropic" | "openai" | "google" | "mistral_fim" | "opencode";
export interface AiProviderSpec {
  id: string;                       // route segment and ai_keys.provider; compat providers are "compat/<name>"
  kind: AiProviderKind;             // request/response dialect: auth injection + usage extraction
  upstream: string;                 // base URL joined with the incoming {...path}; no trailing slash
  envName: string | null;           // sandbox env var when exportEnv is set (§3.12)
  paths: RegExp;                    // allowlist on "/" + path.join("/") (query excluded)
  methods: ReadonlySet<"GET" | "POST">;
  forwardHeaders: readonly string[]; // provider-specific request headers kept in addition to §4.6's common list
}
export const AI_PROVIDERS: Record<string, AiProviderSpec>;               // the nine built-ins + codestral (§4.2)
export const AI_PROVIDER_ID = /^(anthropic|openai|google|mistral|deepseek|open_router|x_ai|opencode|vercel_ai_gateway|codestral|compat\/[a-z0-9][a-z0-9_-]{0,31})$/;
export const COMPAT_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export function providerSpec(id: string, compat?: { kind: "anthropic" | "openai"; upstream: string }): AiProviderSpec | null; // compat specs are built from the ai_keys row
export function isPathAllowed(spec: AiProviderSpec, method: string, path: string): boolean;
export function assertPublicHttpsUpstream(url: string): Promise<void>;    // 400 invalid_upstream; see below
export const PATH_SEGMENT = /^[A-Za-z0-9._~:@-]{1,128}$/;                 // every decoded {...path} segment must match, else 404 path_not_allowed
export function buildUpstreamUrl(spec: AiProviderSpec, path: string[], search: URLSearchParams): URL; // throws 404 path_not_allowed unless origin and path prefix survive
```

`assertPublicHttpsUpstream` is now **async and resolves DNS**. The first draft asserted "DNS resolution is not attempted (Vercel egress has no private network), so literal private IPs are the only address check"; that premise is not among the facts verified in §2.5 and the literal check is bypassed by any public hostname that resolves to `169.254.169.254` or an internal address. The check is therefore: `https:` only; no userinfo, query or fragment; host is not a control-plane host; host is not `localhost`, `*.local`, `*.internal`, an IPv4/IPv6 literal in any form (`127.0.0.1`, `127.1`, `0x7f.1`, `[::1]`, `[::ffff:169.254.169.254]` — normalise before comparing); then `dns.lookup(host, { all: true })` and reject when **any** answer falls in loopback, link-local `169.254.0.0/16` / `fe80::/10`, RFC1918, CGNAT `100.64.0.0/10`, ULA `fc00::/7`, or IPv4-mapped IPv6. Resolution runs both at `PUT` time and immediately before the fetch (a DNS answer can change between them). When `ZS_AI_COMPAT_HOSTS` is set, the host must additionally be on that list; with `ZS_AI_ALLOW_COMPAT="0"` (the default) compat providers are refused outright, and where they are enabled they are gated to a paid plan and capped at **10 rows per user** (`409 compat_limit`). Without all of this the control plane is an authenticated request-shaping proxy from Vercel's egress IPs, with arbitrary `x-*` headers (§4.6) and a user-controlled JSON body.

### 3.4 `apps/web/lib/ai/keys.ts` (new)

```ts
export function aiKeyAad(userId: string, provider: string): string;     // `ai:${provider}:${userId}`, bound to the row exactly as `secretAad(scope, scopeId, name)` is (b9 §3.10). D15 (`DECISIONS.md:19`) says only "a new brief b11" and specifies no scope or AAD shape; this is this brief's choice, not an inherited one
export interface AiProviderStatus { id: string; kind: AiProviderKind; configured: boolean; upstream: string; envName: string | null; exportEnv: boolean; routeAgents: boolean; updatedAt: string | null; lastUsedAt: string | null }
export async function listAiProviders(userId: string): Promise<AiProviderStatus[]>;   // built-ins (configured or not) + the user's compat rows; never values
export async function putAiKey(userId: string, provider: string, input: PutAiKeyInput, actor: { ip?: string }): Promise<void>; // validates (§4.4), encrypts with encryptSecret(key, aiKeyAad(..)), upserts, audit "ai_key.put" { provider } (never the value)
export async function deleteAiKey(userId: string, provider: string): Promise<void>;    // 404 not_found when absent; audit "ai_key.delete"
export async function resolveAiKey(userId: string, provider: string): Promise<{ key: string; spec: AiProviderSpec; row: schema.AiKey } | null>; // decrypts; touches last_used_at at most once per minute (kv key zs:ai:touch:<row.id>)
export async function exportedAiEnv(userId: string): Promise<Record<string, string>>;  // rows with export_env → { [envName]: key }; plus gateway agent routing (§3.12); consumed by resolveEnvFor
```

Key validation (`PutAiKeyInput.key`): 1..8192 bytes, printable ASCII, no leading/trailing whitespace; **`key === PLACEHOLDER_KEY` ("zs-proxy-v1") is refused with 400 `invalid_key`** — without that guard any code path that round-trips a loaded credential through `ApiKeyState::store` (`api_key.rs:99-134`) would silently overwrite the user's real key with the placeholder and the provider would 401 forever; `compat/*` requires `kind` and `upstream` on create (and `assertPublicHttpsUpstream`); `routeAgents` accepted only for `vercel_ai_gateway`; `exportEnv` refused for `compat/*` (no env name).

`resolveAiKey` also refuses to decrypt for a user whose `flagged_at` is set (§3.10 step 2 checks it first, so this is defence in depth).

### 3.5 `apps/web/lib/ai/usage.ts` (new)

```ts
export interface AiUsageTotals { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
export class UsageExtractor {                        // one per response; fed the raw upstream bytes
  constructor(kind: AiProviderKind, streamed: boolean);
  feed(chunk: Uint8Array): void;                     // SSE: scans complete "data:" lines containing "usage"/"usageMetadata"; JSON: buffers ≤ 256 KiB
  finish(): AiUsageTotals | null;
}
export interface AiPrincipal { userId: string; plan: Plan; orgIds: string[]; userCap: number | null; planCap: number | null; orgCaps: (number | null)[]; requestCap: number | null; flaggedAt: Date | null }
export interface AiReservation { id: string; userId: string; day: string; period: string; estimatedTokens: number; settled: boolean }
export async function aiPrincipal(userId: string): Promise<AiPrincipal>;   // one join over users + memberships + orgs; cached in Redis 60 s under zs:ai:pr:<userId>, invalidated by the Clerk webhook, by admin cap writes and by the flag path
export async function reserveAiRequest(p: AiPrincipal): Promise<AiReservation>; // atomic; see below. Throws 403 account_flagged, 429 ai_daily_limit, 402 ai_spend_cap, 429 too_many_streams, 503 ai_unavailable
export async function settleAiRequest(r: AiReservation, actual: AiUsageTotals | null): Promise<void>; // reconciles the token debit (positive or negative INCRBY) and releases the stream slot
export async function recordAiUsage(row: NewAiUsage): Promise<void>;    // INSERT into ai_usage; called from after()
export function monthlyTokenCap(p: AiPrincipal): number | null;         // null = unlimited; see below
```

**Caps must not be counted only in `after()`.** The first draft incremented `zs:ai:tokens` and `zs:ai:req` from `recordAiUsage` inside `after()`, which fails twice: N concurrent requests all pass the precheck because nothing is written until they finish, and when the invocation dies (290 s timeout, crash, redeploy, OOM) `after` never runs, so the *largest* requests are exactly the ones never billed. Instead `reserveAiRequest` runs **before** the upstream call: it first rejects when `p.flaggedAt` is set (a plain check on the cached principal), then in one Redis pipeline (1) `INCR zs:ai:req:<user>:<YYYY-MM-DD>` (TTL 2 d), rejecting over `p.requestCap` and decrementing again on rejection, (2) `INCRBY zs:ai:tokens:<user>:<YYYY-MM>` (TTL 40 d) by a conservative estimate (`ceil(requestBytes / 3) + (max_tokens ?? 4096)`), rejecting over `monthlyTokenCap(p)` and decrementing again on rejection, (3) `INCR zs:ai:live:<user>`, rejecting with 429 `too_many_streams` above `ZS_AI_MAX_STREAMS_PER_USER`. `settleAiRequest` then applies `actual − estimate` (which may be negative) and `DECR`s the live counter; it is called from the stream's `flush`, from its `cancel`, and from `after()`, and is idempotent on the reservation id. One user holding hundreds of 300 s invocations at 120 req/min is a direct cost and DoS vector against BUILD-SPEC §7.11, which the stream slot closes.

**Redis unavailability is fail-closed here.** If the pipeline throws, `reserveAiRequest` raises 503 `ai_unavailable` rather than letting unbounded provider spend land on the user's card; `limit()` (the sliding window) keeps b9's existing behaviour. §6.1 tests both.

**`monthlyTokenCap` must filter nulls before comparing.** `Math.min(x, null)` is `0` in JavaScript (`null` coerces to `0`), so the first draft's `min(user.aiTokenCapMonth ?? PLAN_LIMITS[plan].ai.tokensPerMonth, org?.aiTokenCapMonth)` gave every user whose org has no cap a cap of **0** and a 402 on every request. The definition is:

```ts
export function monthlyTokenCap(p: AiPrincipal): number | null {
  const caps = [p.userCap, p.planCap, ...p.orgCaps].filter((n): n is number => typeof n === "number");
  return caps.length === 0 ? null : Math.min(...caps);   // null (enterprise plan default) = unlimited, never 0
}
```

and "the org" is defined: for a cookie caller it is the workspace's org, for a Clerk caller the **strictest** cap across the user's `memberships` rows (b9 §4.1 `memberships` is many-to-many, so there is no single org). A user value can only tighten, never raise, the plan default. `ai_usage.orgId` is populated from the same resolution; when it is ambiguous it is written `null` rather than guessed.

`Retry-After` for `ai_daily_limit` is **capped at 3600 s**, not pointed at 00:00 UTC. Zed's providers read `retry-after` and schedule against it (`anthropic.rs:578`), and a 24 h timer is indistinguishable from a hang.

Extraction rules by `kind`: `anthropic` — `message_start` → `message.usage.input_tokens` (+ cache fields), `message_delta` → `usage.output_tokens`; non-stream body → `usage`; `openai` — chat: the chunk with `usage` (present because `stream_options.include_usage`, `open_ai.rs:606-623`), responses: `response.completed` → `response.usage.{input_tokens, output_tokens}`; non-stream `usage`; `google` — every chunk's `usageMetadata.{promptTokenCount, candidatesTokenCount, cachedContentTokenCount}` (last wins); `mistral_fim` — final `usage`; `opencode` — try anthropic, then openai, then google shapes. Anything unparseable → `null` (the request still counts toward `requestsPerDay`, and `settleAiRequest` leaves the estimate in place rather than zeroing it). `feed` keeps a **bounded** partial-line buffer: 1 MiB for the SSE path (the first draft capped only the non-stream JSON path at 256 KiB, so an upstream — especially a user-registered compat upstream — that never emits a newline grew the buffer without limit); past the cap extraction is abandoned and `finish()` returns `null`.

### 3.6 `apps/web/lib/ratelimit.ts` and `lib/redis.ts` (modify b9 §3.7)

`LimitName` gains `"user.ai.requests"` and `"user.ai.keys"`; `LIMITS` gains `"user.ai.requests": { tokens: 120, windowSec: 60 }` (per user id; sliding) and `"user.ai.keys": { tokens: 30, windowSec: 60 }`. `keys` gains `aiTokens: (userId, period) => \`zs:ai:tokens:${userId}:${period}\``, `aiRequests: (userId, day) => …`, `aiLive: (userId) => \`zs:ai:live:${userId}\``, `aiPrincipal: (userId) => \`zs:ai:pr:${userId}\``, `aiEpoch: (userId) => \`zs:ai:epoch:${userId}\`` (§3.8), `aiTouch: (rowId) => …`. The stream cap is **not** `lib/concurrency.ts` (`mapConcurrent` is an in-process p-limit and cannot bound work across function invocations); it is the `aiLive` counter of §3.5.

### 3.7 `apps/web/lib/plans.ts` (modify b9 §3.13)

`PLAN_LIMITS[plan].ai = { requestsPerDay: number | null; tokensPerMonth: number | null }`: free `{ 500, 2_000_000 }`, pro `{ 5_000, 50_000_000 }`, team `{ 5_000, 50_000_000 }`, enterprise `{ null, null }`. These are guard rails on the user's own spend (BYOK: the provider bills the user), sized so a normal day of agent use never trips them; the dashboard shows them next to usage.

### 3.8 `apps/web/lib/editor-cookie.ts` and `lib/auth.ts` (modify b9 §3.8)

```ts
export const AI_COOKIE = "zs_ai";
export const AI_COOKIE_AUDIENCE = "zs-ai";
export interface AiClaims { sub: string; aud: "zs-ai"; ep: number; iat: number; oat: number; exp: number; jti: string }
export interface AiCookieAttributes { httpOnly: true; secure: boolean; sameSite: "strict"; path: "/api/ai"; expires: Date }
export async function mintAiCookie(userId: string, opts?: { originalIat?: number }): Promise<{ value: string; expires: Date }>; // jose SignJWT HS256, ZS_EDITOR_COOKIE_SECRET, exp +12 h — same key and lifetime as zs_editor
export async function verifyAiCookie(jar: CookieReader): Promise<AiClaims | null>;   // jwtVerify({ algorithms: ["HS256"], audience: AI_COOKIE_AUDIENCE }); also checks `ep` against zs:ai:epoch:<sub>
export function aiCookieAttributes(expires: Date): AiCookieAttributes;               // HttpOnly; Secure (not in dev); SameSite=Strict; Path=/api/ai; Expires

// auth.ts
export interface AiViewer { userId: string; via: "clerk" | "ai-cookie" }
export async function requireAiViewer(req: Request): Promise<AiViewer>;
// 1. reject cross-site callers: `Sec-Fetch-Site` present and not "same-origin"/"none" → 403 cross_site; when authenticating by cookie, an *absent* Sec-Fetch-Site is also 403 (fail closed);
//    `Sec-Fetch-Mode: navigate` → 403 cross_site (a top-level cross-site navigation must not burn quota through the Clerk session);
//    `Origin` present and !== the request's own origin (from `req.url` / `Host`) → 403 cross_site
// 2. zs_ai cookie valid and its `ep` matches zs:ai:epoch:<sub> → { via: "ai-cookie" }
// 3. else Clerk auth() → { via: "clerk" } (dashboard "test key" button, curl with a Clerk session)
// 4. else 401 unauthenticated
```

Four corrections to the first draft, all of which changed shapes:

- **Types.** `CookieReader` and `AiCookieAttributes` mirror the names actually shipped in `apps/web/lib/editor-cookie.ts` (`:24-26`, `:29-35`). `ReadonlyRequestCookies` and `CookieAttributes` do not exist in this codebase.
- **No `ws` claim.** `proxy.ts:47` states plainly that the editor cookie "proves `userId`; workspace access is checked in `page.tsx`", so a user who visits `/w/<someone else's id>` would receive a `zs_ai` naming a workspace they cannot open, and could poison `ai_usage.workspaceId`. The proxy only ever needs `sub`, so `ws` is dropped and `ai_usage.workspaceId` is `null` for cookie callers in v1 (§4.1 keeps the nullable column for when a mint-time access check exists).
- **Origin comparison.** Comparing `Origin` to `controlPlaneUrl()` 403s every request from a preview deployment URL, an apex/`www` variant, or a second custom domain. The comparison is against the request's own origin.
- **Revocation.** `zs_ai` is a 12 h bearer and `POST /api/workspaces/{id}/session` re-mints it while accepting a still-valid editor cookie (CONTRACTS §8.2), so the chain would refresh forever with no Clerk reauth. The cookie therefore carries `oat` (the original issue time) and refresh is refused past `oat + 24 h` — after that a Clerk session is required — and it carries `ep`, checked against a per-user `zs:ai:epoch:<userId>` counter that is bumped on key delete, on account flag and on sign-out. Deleting a key or flagging an account invalidates every outstanding `zs_ai` immediately.

Why a second cookie: `zs_editor` is deliberately `Path=/api/workspaces/<id>` (CONTRACTS §6.2) and browsers never send it to `/api/ai/*`; widening its path would change b9's blast-radius argument for every workspace route, whereas `zs_ai` is additive, `Path=/api/ai`, and proves only "this user, opened from this workspace". The wasm client sends it automatically because `FetchHttpClient` defaults to `SameOrigin` credentials (`http_client.rs:35-36`) and the proxy is same-origin.

### 3.9 `apps/web/proxy.ts` and `app/api/workspaces/[id]/session/route.ts` (modify b9 §3.21, §3.24)

- `proxy.ts`: in the `/w/:id` document branch, next to `res.cookies.set(EDITOR_COOKIE, …)` (`apps/web/proxy.ts:49-50`), also `const a = await mintAiCookie(userId); res.cookies.set(AI_COOKIE, a.value, aiCookieAttributes(a.expires));`. `isProtectedPage` gains `"/ai(.*)"`. `isProtectedApi` is **not** extended with `/api/ai` (those routes authenticate themselves), and — correcting the first draft — **`api/ai/` is added to the negative lookahead in `config.matcher`** (`proxy.ts:60`), beside `api/sandboxes/`, `api/webhooks/` and `api/cron/`. The comment already on that line is the whole argument: those are "routes that authenticate on their own … a Clerk outage must not fail the 30 s activity pings". `/api/ai/*` authenticates on its own with `zs_ai` (§3.8), and streaming completions are far more latency-sensitive than an activity ping; leaving them inside the matcher pays a Clerk middleware invocation per streamed request and takes AI down with Clerk. The `/w/:id` mint branch is unaffected — that path stays inside the matcher.
- `session/route.ts`: re-mint both cookies in the `204` (the shell calls it every 6 h and after a 401, b9 §3.26 bullet 8), carrying the existing `oat` forward and refusing the `zs_ai` half past `oat + 24 h` (§3.8).

### 3.9a `apps/web/vercel.ts` (modify b9 §3.23)

```ts
export const config: VercelConfig = {
  framework: "nextjs",
  crons: [ /* unchanged */ ],
  functions: {
    "app/api/ai/**": { supportsCancellation: true },
  },
};
```

This is not optional. Client-disconnect cancellation on Vercel is opt-in per path (§2.5): without `supportsCancellation` the platform never signals a disconnect, so `req.signal` never fires, the `cancel` hook of the response stream never runs, and an abandoned tab leaves the upstream request streaming — spending the user's provider quota — for up to 290 s. §3.10 steps 7-8, §6.1's `client_cancel_aborts_upstream` and §7 item 6 all depend on this flag. `apps/web/vercel.ts` currently has no `functions` key at all; b9 §3.23 line 718 says per-route `maxDuration` is declared with the route-segment export rather than through `functions` globs, which stays true — this entry adds only `supportsCancellation`.

### 3.10 `apps/web/lib/ai/proxy.ts` (new) — the streaming pass-through

```ts
export interface ProxyDeps { fetchImpl?: typeof fetch; now?: () => number }     // injected in tests
export async function proxyAiRequest(req: Request, viewer: AiViewer, providerId: string, path: string[], deps?: ProxyDeps): Promise<Response>;
```

Steps, in order:

1. `ZS_AI_PROXY === "off"` → 404 `ai_disabled`. `providerId` must match `AI_PROVIDER_ID` else 404 `unknown_provider`; `compat/*` refused with 404 when `ZS_AI_ALLOW_COMPAT === "0"` (the default).
2. `limit("user.ai.requests", viewer.userId)` (429 `rate_limited` + `Retry-After`), then `const p = await aiPrincipal(viewer.userId)`. `p.flaggedAt` set → **403 `account_flagged`** (BUILD-SPEC §7.11 flags the account; b9 already refuses workspace creation while it is set, and a flagged account must not keep proxying AI traffic either).
3. `isPathAllowed(spec, method, "/" + path.join("/"))` after every decoded segment has matched `PATH_SEGMENT`, else 404 `path_not_allowed`; method not in `spec.methods` → 405. Header count and size are checked here too: at most 32 forwarded headers and 8 KiB of forwarded header bytes, else 400 `too_many_headers` (the wasm client's `custom_headers` are user-controlled, `provider.rs:31-69`).
3a. `const reservation = await reserveAiRequest(p)` — the atomic flag/day/token/stream-slot reservation of §3.5 (429 `ai_daily_limit` with `Retry-After ≤ 3600`, 402 `ai_spend_cap`, 429 `too_many_streams`, 503 `ai_unavailable`). Every later failure path releases it.
4. `resolveAiKey(viewer.userId, providerId)`; `null` → 401 with the **provider-dialect** body in §4.5 (`ai_key_missing`) so Zed shows a readable message in the thread, plus header `x-zs-ai-error: ai_key_missing`.
5. Request body: only for POST; `Content-Type` must be `application/json` (415 `unsupported_media_type` otherwise); read with `req.arrayBuffer()` guarded by `Content-Length` and a running counter, 413 `payload_too_large` above `ZS_AI_MAX_BODY_BYTES` (4 MiB, under the platform's own 4.5 MB / `FUNCTION_PAYLOAD_TOO_LARGE` ceiling — §2.5). The wasm client always sends a buffered body with `Content-Length` (`http_client.rs:199-209`), so buffering costs nothing extra and lets the proxy read `model`, `stream` and `max_tokens` (`JSON.parse` when ≤ 1 MiB, else a bounded regex `"model"\s*:\s*"([^"]{1,200})"` / `"stream"\s*:\s*true`) for the usage row, the extractor mode and the token estimate. Streaming request bodies (`duplex: "half"`) are deliberately not used in v1; §7 item 5.
6. Build the upstream request with `buildUpstreamUrl(spec, path, search)`: `new URL(spec.upstream)`, then each **already-validated** segment appended with `encodeURIComponent`, then the incoming query minus any `key` parameter; the result is re-checked (`url.origin === new URL(spec.upstream).origin`, `url.pathname.startsWith(new URL(spec.upstream).pathname)`) before the fetch, because Next hands `params` percent-decoded and string concatenation let a decoded `%3F` split the path into a path plus a query (§3.3). Headers per §4.6; credential injection by `kind`: `anthropic` → `x-api-key: <key>` (drop incoming `x-api-key`/`authorization`); `openai`, `mistral_fim`, `opencode` → `authorization: Bearer <key>`; `google` → **`x-goog-api-key: <key>` only**. The first draft also re-appended `key=<key>` to the outgoing query "so either server accepts it"; that puts the plaintext provider key in the outbound URL, and every Node `fetch` rejection carries the request URL through its error/`cause` chain, so any unhandled rejection or platform error logger captures the key. Google's REST API accepts the header form, so the query form buys nothing and is dropped (§7 item 15). A `redactUrl()` helper strips every query string from anything that can be logged or thrown. `accept-encoding: identity` is sent so upstream bytes are forwarded verbatim and `content-length` stays honest. `user-agent: zed-codespaces-ai-proxy/<ZS_CLIENT_BUILD_ID>`.
7. `fetchImpl(url, { method, headers, body, redirect: "manual", signal })` where `signal = AbortSignal.any([upstreamAbort.signal, AbortSignal.timeout(ZS_AI_UPSTREAM_TIMEOUT_MS)])`, plus `req.signal.addEventListener("abort", () => upstreamAbort.abort())` — which fires only because §3.9a declares `supportsCancellation` for `app/api/ai/**`. **The first-byte timer is wired, not just declared:** the `fetchImpl(...)` promise is raced against `AbortSignal.timeout(ZS_AI_FIRST_BYTE_TIMEOUT_MS)`, whose expiry aborts `upstreamAbort` and answers 504 `upstream_timeout`; the timer is cleared the moment headers arrive, after which the total timeout is the only bound. Without this the env var is dead and a silent upstream holds a function instance for the full 290 s. A `3xx` from upstream → 502 `upstream_redirect` (never followed: the allowlist would be bypassed). Network error → 502 `upstream_unreachable`.
8. Response: `new Response(body, { status: upstream.status, headers })` with headers filtered per §4.6 plus `cache-control: no-store`, `x-accel-buffering: no`, `x-zs-ai-request-id: <crypto.randomUUID()>` (§5 adds no dependencies and the pinned set has no ULID library, so it is a UUID, not a ULID), and `content-type` copied (fallback `application/octet-stream`). `body = upstream.body.pipeThrough(new TransformStream({ transform(chunk, c) { extractor.feed(chunk); bytesOut += chunk.byteLength; c.enqueue(chunk); }, flush() { settle(); } }))`, wrapped in a `ReadableStream` whose `cancel` hook aborts `upstreamAbort` and calls `settle()` too, so the abort does not depend on `req.signal` alone. Upstream `4xx/5xx` bodies are passed through unchanged (Zed's `from_http_status` parsing works on the provider's own error JSON; `anthropic.rs:578` reads `retry-after`). When the **total** timeout fires after bytes have already been sent, the transform enqueues one dialect-shaped SSE `error` event before closing rather than truncating the body into a parse failure at the client.
9. `after(() => { settle(); recordAiUsage({ ... extractor.finish(), status, durationMs, requestBytes, responseBytes, upstreamRequestId }); })` (`next/server` `after`). Two caveats the first draft asserted without a citation: the on-disk docs say only "after a response (or prerender) is finished" (`after.md:6`) — they do **not** say a *streamed* body's completion is what "finished" means — and `after.md:50` says "`after` will run for the platform's default or configured max duration of your route", so a 290 s stream leaves roughly 10 s of budget. That is why `settle()` (the cap reconciliation, §3.5) runs from the stream's `flush`/`cancel` and is merely re-attempted here, and why `ai_usage` insertion is the only thing that depends on `after`. §6.1's `after_ordering_streamed` pins the ordering against a real streamed response, and §7 item 18 records what happens if it turns out `after` fires at handler return. Nothing about the key, the prompt or the completion is logged; only sizes, tokens, model id, status and timing.

### 3.11 Route handlers (new; conventions of b9 §3.24: `export const runtime = "nodejs"`, `handler()` wrapper, error envelope)

| File | Exports |
|---|---|
| `app/api/ai/[provider]/[[...path]]/route.ts` | `GET`, `POST`; `export const maxDuration = 300`; `ctx: RouteContext<'/api/ai/[provider]/[[...path]]'>`; body: `const viewer = await requireAiViewer(req); const { provider, path = [] } = await ctx.params; const id = provider === "compat" ? \`compat/${path.shift()}\` : provider; return proxyAiRequest(req, viewer, id, path);`. The catch-all is **optional** (`[[...path]]`): a required `[...path]` matches only ≥ 1 segment, so `GET /api/ai/anthropic` would fall through to Next's HTML 404 instead of the CONTRACTS §8.1 envelope that §4.4's error table promises. With the optional form an empty `path` reaches `isPathAllowed`, which answers 404 `path_not_allowed` in the right shape. |
| `app/api/ai/keys/route.ts` | `GET` → `{ providers: AiProviderStatus[] }` (`requireAiViewer`, rate `user.ai.keys`) |
| `app/api/ai/keys/[...provider]/route.ts` | `PUT` (`{ key, kind?, upstream?, exportEnv?, routeAgents? }` → 204), `DELETE` (→ 204); provider id = `params.provider.join("/")`; `requireAiViewer`; rate `user.ai.keys`; audit |
| `app/api/ai/usage/route.ts` | `GET ?period=YYYY-MM` (default current) → §4.4 `AiUsageSummary`; Clerk or cookie |

Next resolves the static segments `keys` and `usage` before the dynamic `[provider]`, and `AI_PROVIDER_ID` cannot match them, so there is no ambiguity. `PUT /api/ai/keys/...` from the wasm client authenticates with the `zs_ai` cookie exactly like the proxy; from the dashboard with Clerk. `maxDuration = 300` is a literal while `ZS_AI_UPSTREAM_TIMEOUT_MS` is env-driven; the `env()` refinement in §3.1 (`.max(290_000)`) is what keeps them consistent. Raising `maxDuration` to 800 requires a Pro/Enterprise team and is a per-plan product decision, not a code default (§7 item 7).

### 3.12 `apps/web/lib/secrets.ts` (modify b9 §3.17) and `lib/manifest.ts`

`resolveEnvFor(workspace: Pick<Workspace, "ownerUserId" | "orgId" | "repoId">)` (the shipped signature, `apps/web/lib/secrets.ts:61-82`) composes `{ ...(await exportedAiEnv(workspace)), ...user, ...org, ...repo }`: exported AI keys sit **below** explicit secrets so a user who already set `ANTHROPIC_API_KEY` under Secrets keeps that value. `exportedAiEnv` also adds, when `ai_keys.vercel_ai_gateway.routeAgents` is set: `ANTHROPIC_BASE_URL=https://ai-gateway.vercel.sh`, `ANTHROPIC_AUTH_TOKEN=<gateway key>`, `ANTHROPIC_API_KEY=""` (the documented Claude Code configuration, §2.5). Nothing else changes: the manifest keeps carrying names only (`secretNames` now includes the exported names), the supervisor keeps inheriting the values into the server and every child (CONTRACTS §7.2), and Zed's `AgentServerStore` passes the process environment to the agent (`agent_server_store.rs:1163-1211`). Prebuild principals get no AI env — `lib/manifest.ts:158-190` `prebuildManifest` builds its own `env` (`{ ZS_WORKSPACE_ID, ZS_REGION, ZS_PREBUILD }`) and never calls `resolveEnvFor` (§6.2 tests it).

Two constraints the first draft left implicit:

- **`exportedAiEnv` takes the workspace, not just the owner id, and refuses to export into an untrusted checkout.** A workspace can be created from a pull request (`ref: refs/pull/N/head`, CONTRACTS §7.3) and the supervisor runs that PR's `devcontainer.json` `postCreateCommand` (BUILD-SPEC §6.3) with the environment in place — so opening a workspace on someone else's PR would hand that PR's code the user's provider keys. `exportedAiEnv` therefore returns `{}` when `workspace.repo.ref` is a PR head or the revision is off the repo's default branch, and `exportEnv` is scoped per repo rather than globally. §3.14's UI copy says this in as many words.
- **BUILD-SPEC §7.9 (line 387) is amended.** It says envelopes are "decrypted only inside the create and resume workflows to build the sandbox `env`"; `resolveAiKey` decrypts inside a route handler on every proxied request. Recorded in §7 item 1 alongside the §8 line 402 amendment.
- **Traffic through exported keys is neither metered nor capped.** The key leaves the control plane and the agent calls the provider directly, so nothing in `lib/ai/usage.ts`, `user.ai.requests` or `ai_usage` sees it. §3.14 shows an explicit warning on the toggle, and §1/§7 say plainly that this brief's caps cover the browser path only. §7 item 19 proposes the metered sandbox path.

### 3.13 `apps/web/scripts/rotate-secrets.ts` (modify b9 §4.4)

Also rotate every `ai_keys` row with `key_version < active` using `rotateEnvelope(ciphertext, aiKeyAad(userId, provider))`.

### 3.14 Dashboard: `app/(site)/(dashboard)/ai/page.tsx`, `ai/actions.ts`, nav entry (new; b9 §3.27 conventions)

Server component + server actions calling `lib/ai/keys.ts` and `lib/ai/usage.ts` directly. Sections: (1) provider list with "Configured"/"Not configured", a masked key input with Save (replaces), Remove, and per-row toggles "Expose to workspaces as `ANTHROPIC_API_KEY`" (`exportEnv`) — with the note that explicit Secrets win, the exact variable name shown (⚠ rows in §4.2 are unverified and their toggle stays hidden until checked), and an explicit warning that a workspace opened on a pull-request ref runs that PR's `postCreateCommand` with the environment in place, which is why export is scoped per repo and refused off the default branch (§3.12), and that traffic through an exported key is neither metered nor capped; (2) Vercel AI Gateway card with the extra toggle "Route Claude Code through the gateway" (`routeAgents`) and a link to the Vercel API-keys page; (3) "Compatible providers" (paid plans only, at most 10 rows, hidden entirely when `ZS_AI_ALLOW_COMPAT="0"`): name (`COMPAT_NAME`), kind (OpenAI/Anthropic), upstream URL, key; after saving it shows the exact settings snippet to paste into `/settings` (`"openai_compatible": { "<name>": { "api_url": "<origin>/api/ai/compat/<name>", "available_models": [...] } }`) — v1 does not edit `settings_docs` server-side; (4) usage for the current period per provider with the plan caps. Values are never rendered back; the page shows `updatedAt`/`lastUsedAt` only.

### 3.15 `docs/contracts/ai-providers.v1.json` (new; shared fixture)

`{ "version": 1, "placeholderKey": "zs-proxy-v1", "proxyPrefix": "/api/ai/", "providers": [ { "id": "anthropic", "kind": "anthropic", "upstream": "https://api.anthropic.com", "envName": "ANTHROPIC_API_KEY", "settingsPath": "language_models.anthropic.api_url" }, … ] }` — the rows of §4.2 minus the regexes.

**The `include_str!` scheme of the first draft cannot work and is replaced.** From `zed/crates/zed_web_core/src/`, three `..` resolves to `zed/`, so `include_str!("../../../docs/contracts/ai-providers.v1.json")` names `zed/docs/contracts/…`, which does not exist; the file is at repo-root `docs/contracts/` and needs four. Worse, `zed/` is its **own git repository** (both `/Users/ray/Projects/play/wed/.git` and `/Users/ray/Projects/play/wed/zed/.git` exist), so a `zed_web_core` build from a standalone `zed` checkout cannot see the outer repo's `docs/` at all. Instead:

- `zed/crates/zed_web_core/tests/fixtures/ai-providers.v1.json` is a **checked-in copy** inside the `zed` repo, embedded with `include_str!("fixtures/ai-providers.v1.json")` from the test module.
- `apps/web/tests/ai/providers.test.ts` reads the canonical `docs/contracts/ai-providers.v1.json` from the monorepo root (the same helper b9 uses for `manifest.example.json`, b9:837) and asserts `AI_PROVIDERS` equals it.
- A CI step (`infra/workflows`) diffs the two files and fails the build when they drift, which is the only mechanism that survives the nested repository.

**Compatibility rule (v1).** `docs/contracts/ai-providers.v1.json` is **append-only** within version 1: ids and their `kind`/`upstream`/`envName` never change, only new rows are added. The TS test asserts equality against the control plane's table; `zed_web_core`'s test asserts `PROXIED_LANGUAGE_MODEL_PROVIDERS` is a **subset** of the fixture's ids and that unknown ids are ignored at runtime, so a deployed wasm bundle predating a new provider simply does not seed its `api_url`. A provider is usable only once the bundle carrying it is a workspace's `client_build` (CONTRACTS §12).

### 3.16 `zed/crates/zed_web_core/src/ai_proxy.rs` (new; host-testable) and `zed_web_core/src/lib.rs` (modify b7 §3.18)

```rust
pub const PLACEHOLDER_KEY: &str = "zs-proxy-v1";           // what the browser credentials provider returns; the proxy strips it
pub const PROXY_PREFIX: &str = "/api/ai/";
pub const KEYS_PATH: &str = "/api/ai/keys";
/// Built-in language_models providers whose api_url is redirected to the proxy (default.json:2542-2583 ids).
pub const PROXIED_LANGUAGE_MODEL_PROVIDERS: &[&str] = &["anthropic", "openai", "google", "mistral", "deepseek", "open_router", "x_ai", "opencode", "vercel_ai_gateway"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProxyProvider { pub id: String }                // "anthropic" | "codestral" | "compat/<name>"

pub fn proxy_api_url(origin: &str, provider: &str) -> String;                       // "{origin}/api/ai/{provider}" — no trailing slash
pub fn provider_for_url(origin: &str, url: &str) -> Option<ProxyProvider>;          // Some when url's host equals origin's host (scheme and host, port included; path and query ignored for the comparison) and its path is "/api/ai/" + id [+ "/..."]; strips query; None otherwise
pub fn keys_url(origin: &str, provider: Option<&str>) -> String;                    // "{origin}/api/ai/keys" or "{origin}/api/ai/keys/{provider}"
/// JSON object merged over the web defaults: §4.3 verbatim with `{origin}` substituted.
pub fn ai_proxy_settings_overrides(origin: &str) -> serde_json::Value;
/// Deep-merges `ai_proxy_settings_overrides(origin)` over `settings_json` (JSONC via serde_json_lenient, same helper as merge_web_defaults).
pub fn merge_ai_proxy_defaults(settings_json: &str, origin: &str) -> anyhow::Result<String>;

#[derive(serde::Deserialize)] #[serde(rename_all = "camelCase")]
pub struct KeysResponse { pub providers: Vec<ProviderStatus> }
#[derive(serde::Deserialize)] #[serde(rename_all = "camelCase")]
pub struct ProviderStatus { pub id: String, pub configured: bool, #[serde(default)] pub env_name: Option<String> }
pub fn configured_ids(response: &KeysResponse) -> std::collections::HashSet<String>;
```

`provider_for_url` matches on the whole **origin** (scheme, host and port, case-insensitively, default ports dropped), as the signature line above says — *amended 2026-09-04 during implementation*, because this paragraph's original "matches on host, not on the exact origin string" contradicted that signature line and would not have solved the problem it named anyway: a page served from `www.zs.example.com` and an `api_url` of `https://zs.example.com/api/ai/anthropic` have different hosts too, so host comparison fails there exactly as origin comparison does, while additionally handing the placeholder to a scheme-downgraded or port-shifted URL that the editor CSP (`connect-src 'self'`) then blocks — i.e. a provider that reads "API Key Configured" and always fails at request time.

The real problem is real: Zed persists a compat provider's `api_url` into the user's `settings.json` (`api_compatible.rs:181-196` edits that file; the settings document syncs through `/api/me/settings`, b9 §3.24), and the same user reaches the app from a preview URL, a custom domain, and apex vs `www`. It is solved from two sides instead. (a) §3.14's snippet generator emits an **origin-relative** `api_url` wherever Zed accepts one, and `provider_for_url` accepts a relative `/api/ai/…` path unconditionally — the browser resolves it against whichever origin served the page, so a synced settings document is correct on all of them. (b) When an absolute foreign-origin `/api/ai/…` URL does arrive, `foreign_proxy_provider(origin, url)` names it, and §3.17 makes it **loud**: `read_credentials` logs and answers `Ok(None)` (never the placeholder), and `write_credentials` returns an error and raises a notification instead of silently writing the key into `session_keys`, where `ApiKeyState::store` would show it as saved and a reload would lose it. §6.5 pins both directions.

`lib.rs`: `pub mod ai_proxy;`. No new dependencies beyond `serde`, `serde_json`, `serde_json_lenient`, `anyhow` (already b7's).

### 3.17 `zed/crates/zed_web/src/ai.rs` (new) and `zed_web.rs` (modify b7 §3.20: `mod ai; mod web_edit_prediction;`)

```rust
/// Credentials provider for the browser: proxy URLs are answered from the control plane, every other
/// URL from an in-memory map that lives for the tab (there is no keychain on the web,
/// gpui_web/src/platform.rs:657-671).
pub struct ProxyCredentialsProvider {
    origin: String,
    http: Arc<dyn HttpClient>,                                    // cx.http_client(): FetchHttpClient, SameOrigin credentials → zs_ai cookie
    configured: Mutex<CacheState>,                                // parking_lot::Mutex — NOT RefCell (see below); GET /api/ai/keys, cached 60 s, invalidated on write/delete
    session_keys: Mutex<HashMap<String, (String, Vec<u8>)>>,      // non-proxy URLs (direct mode, §4.3 note)
}

enum CacheState {
    Empty,
    InFlight(Shared<BoxFuture<'static, Result<HashSet<String>, String>>>),  // single-flight: ~10 providers authenticate at boot
    Fresh { at: web_time::Instant, ids: HashSet<String> },
}

impl ProxyCredentialsProvider {
    pub fn new(origin: String, http: Arc<dyn HttpClient>) -> Self;
    async fn configured_ids(&self) -> KeysOutcome;   // GET keys_url(origin, None); see the outcome table below
}

enum KeysOutcome { Known(HashSet<String>), Disabled, Unknown }

impl CredentialsProvider for ProxyCredentialsProvider {
    // proxy URL: Known(ids) → Ok(Some(("Bearer".into(), PLACEHOLDER_KEY.as_bytes().to_vec()))) if ids.contains(id), else Ok(None);
    //            Disabled (404 ai_disabled) → Ok(None);  Unknown (429/5xx/offline) → Ok(None), never Err;
    // other URL: Ok(session_keys.lock().get(url).cloned()) — and never the placeholder
    fn read_credentials<'a>(&'a self, url: &'a str, cx: &'a AsyncApp) -> Pin<Box<dyn Future<Output = Result<Option<(String, Vec<u8>)>>> + 'a>>;
    // proxy URL: refuse when password == PLACEHOLDER_KEY; else PUT keys_url(origin, Some(id)) with { "key": <password as utf8> } → 204,
    //            invalidate the cache, re-fetch, and Err (with error.message) when the provider is still `configured: false`;
    // other URL: insert into session_keys
    fn write_credentials<'a>(&'a self, url: &'a str, username: &'a str, password: &'a [u8], cx: &'a AsyncApp) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>>;
    // proxy URL: DELETE keys_url(origin, Some(id)) (404 tolerated), invalidate cache; other URL: remove
    fn delete_credentials<'a>(&'a self, url: &'a str, cx: &'a AsyncApp) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>>;
}

/// Install as the zed_credentials_provider global. Must run before Client::production (client.rs:359-362, 569).
pub fn install_credentials_provider(origin: &str, cx: &mut App) {
    let provider: Arc<dyn CredentialsProvider> = Arc::new(ProxyCredentialsProvider::new(origin.to_owned(), cx.http_client()));
    cx.set_global(zed_credentials_provider::ZedCredentialsProvider(provider));  // zed_credentials_provider.rs:26-28 (public tuple struct, Global)
}

/// window.location.origin (web_sys::Window::location().origin()).
pub fn page_origin() -> anyhow::Result<String>;

/// Command-palette action `zed_web::ManageAiKeys` → cx.open_url("{origin}/ai") (gpui_web opens a new tab, platform.rs:440-444).
pub fn register_actions(origin: String, cx: &mut App);
```

**Why `Mutex` and not `RefCell`.** `CredentialsProvider` is declared `pub trait CredentialsProvider: Send + Sync` (`credentials_provider.rs:11`), so the concrete type must be `Sync`; `RefCell<T>` never is, and the unsizing coercion `Arc<ProxyCredentialsProvider> → Arc<dyn CredentialsProvider>` in `install_credentials_provider` would fail to compile with "`RefCell<…>` cannot be shared between threads safely" (`zed_credentials_provider.rs:32-34` records the same constraint in a comment). Both fields are `parking_lot::Mutex`. Because every trait method returns a future borrowing `&'a self`, **no guard may be held across an `await`**: `configured_ids` takes the lock, reads or installs the in-flight `Shared` future, drops the guard, and only then awaits. A `RefCell` borrow held across the keys request would additionally have panicked on the second concurrent `authenticate`, and all ~10 providers call `load_if_needed` at boot (`api_key.rs:160-203`).

**Single-flight, and failures are not `Err`.** Nine language-model providers plus codestral each call `read_credentials` at boot, so the 60 s cache is cold for all of them at once — up to ten concurrent `GET /api/ai/keys` against `user.ai.keys` at 30/min, and the third page reload inside a minute would 429. `CacheState::InFlight` shares one future across all of them. And a failed keys request must **not** map to `Err`: `api_key.rs:255-272` turns `Err` into `LoadStatus::Error`, which `:275-283` turns into `AuthenticateError::Other`, i.e. *every* provider showing an authentication error. `Unknown` (429, 5xx, offline) therefore returns `Ok(None)` without poisoning the cache and is retried on the next `authenticate`; `Disabled` — the 404 `ai_disabled` body that `ZS_AI_PROXY=off` returns, which is not a `KeysResponse` and so would have parsed as an error in the first draft — is an explicit branch returning `Ok(None)`, which is exactly "no provider configured". This is what §3.18's claim that "a disabled proxy simply reports every provider unconfigured" actually requires.

**Placeholder guards, both directions.** `read_credentials` never returns `PLACEHOLDER_KEY` for a non-proxy URL, and `write_credentials` refuses to `PUT` it (the control plane refuses it too, §3.4) — otherwise any round-trip of a loaded credential through `ApiKeyState::store` would overwrite the user's real key with the placeholder.

**Save failures must surface.** `ApiKeyState::store` calls `provider.write_credentials(...).await.log_err()` and then sets `LoadStatus::Loaded` **regardless of the result** (`api_key.rs:112-131`), so a failed `PUT /api/ai/keys/*` would leave the settings page showing "API Key Configured" with nothing saved. `write_credentials` therefore invalidates the cache, re-fetches `/api/ai/keys`, and returns `Err` (raising a workspace notification) when the provider still reports `configured: false`. **Landed deviation (round 4, D43):** when the confirming `GET` itself fails (`KeysOutcome::Unknown`: a 429 or 5xx against the same 30/min limit, or offline), the 2xx `PUT` is taken as authoritative and the write is `Ok(())` with a warning; only `Known` without the provider, or `Disabled`, is `Err`. A 401/403 on the inventory read (the `zs_ai` cookie lapsed) still reads as "no key" but raises one "reload the page" notice per tab (`KeysOutcome::is_session_expired`).

Behaviour notes that follow from the anchors: `ApiKeyState::load_if_needed` calls `read_credentials` once per provider per `api_url` (`api_key.rs:160-203`), so the first `authenticate` of any provider triggers at most one `GET /api/ai/keys` (shared by the others through `CacheState::InFlight`). When the user types a key in the settings page (`llm_providers_page.rs:252-260` → `set_api_key` → `store`), the provider's `write_credentials` PUTs it to the control plane; `store` then keeps the typed key in memory (`api_key.rs:113-131`) and the proxy ignores whatever credential header it receives, so behaviour is correct either way (§7 item 9 on residency). Copilot Chat's `load_stored_token` (`copilot_chat.rs:553-564`) hits the non-proxy branch and gets `None` → `SignedOut` (Copilot Chat is not proxied in v1, §7 item 13). `codestral::load_codestral_api_key` (`codestral.rs:50-56`) and the OpenAI-compatible edit-prediction token (`open_ai_compatible.rs:42-50`) go through the same global, so they resolve `<origin>/api/ai/codestral` and `<origin>/api/ai/compat/<name>` exactly like the language-model providers.

### 3.18 `zed/crates/zed_web/src/settings.rs` and `src/init.rs` (modify b7 §3.24, §3.26)

- `settings.rs`: `pub fn web_default_settings() -> &'static str` becomes `pub fn web_default_settings(origin: &str) -> &'static str`, backed by a `static CACHE: OnceLock<Mutex<HashMap<String, &'static str>>>` **keyed on the origin** (each miss computes `merge_ai_proxy_defaults(&merge_web_defaults(settings::default_settings())?, origin)` and `Box::leak`s the result, so the `&'static str` return type survives). A plain `OnceLock<String>` parameterised by `origin` returns the first caller's origin to every later caller — invisible in production, wrong in any test or harness that boots twice with different origins, and §6.5 exercises exactly that. `init(fs, settings_json, cx)` takes `origin: &str` and passes it on. When the keys route answers 404 `ai_disabled` (`ZS_AI_PROXY=off`) the overrides are still seeded, so every provider points at a URL that 404s; §3.17's explicit `Disabled` branch is what makes that read as "unconfigured" rather than "error", and §7 item 20 records the residue. Both signatures are b7-owned APIs changed by this brief, so both go into CONTRACTS §5.4 (§7 item 16).
- `init.rs`: the origin must exist **before b7's step 4**, because step 4 is `settings::init(fs.clone(), settings_json, cx)` and it now takes the origin — four steps earlier than the first draft's "step 8a". So: `init_before_connect(fs, assets, host_os, settings_json, build, cx)` gains an `origin: &str` parameter, resolved by the caller (`boot.rs`) with `ai::page_origin()?`; step 4 passes it to `settings::init`. `ai::install_credentials_provider(origin, cx)` becomes **step 8a** (after `extension::init`, before step 9 `Client::production`, which is the only ordering constraint that matters — `client.rs:359-362, 569`); `cx.http_client()` is already the `FetchHttpClient` from `application_with_web_backend` (b7 step 9 note). Step 21 is unchanged: `zed_credentials_provider::global(cx)` now returns the proxy provider. New step **30a**, after b7's step 30 (`edit_prediction::init(cx)`, b7:774): `web_edit_prediction::init(client.clone(), user_store.clone(), cx)` (§3.19) — after, not before, so the `edit_prediction` crate has installed its globals before the registry starts observing editors, and named `web_edit_prediction` because a crate-root `mod edit_prediction` would collide with the `edit_prediction` crate that `zed_web` also depends on (an unqualified `edit_prediction::init(client, user_store, cx)` resolves to the crate's `pub fn init(cx: &mut App)` at `edit_prediction.rs:3522` — an arity error — and a stray `use crate::edit_prediction` would silently break b7's step 30 instead). New step 34a: `ai::register_actions(origin.to_owned(), cx)`.
- `language_models` registration on wasm (an addition to b7 §3.5's gating, which today gates only `bedrock`, `extension_host` and `gpui_tokio`): `register_language_model_providers` (`language_models.rs:243-270`) also skips `OllamaLanguageModelProvider`, `LmStudioLanguageModelProvider` and `LlamaCppLanguageModelProvider` under `cfg(target_family = "wasm")`. All three default to a `localhost` `api_url` that the editor CSP forbids (`connect-src 'self' wss://*.vercel.run https://*.vercel.run`, `apps/web/lib/csp.ts:11`), so without the skip they appear in the model picker and the settings UI and always fail with an opaque network error (§4.2). Upstream-shaped, same style as the `bedrock` gate.

### 3.19 `zed/crates/zed_web/src/web_edit_prediction.rs` (new) — the web edit-prediction registry (b7 §7 item 18)

A copy of `crates/zed/src/zed/edit_prediction_registry.rs:16-109, 185-211` with these differences:

```rust
pub fn init(client: Arc<Client>, user_store: Entity<UserStore>, cx: &mut App);   // same observers as :16-109 minus telemetry::event! (:90-94)

#[derive(Copy, Clone, PartialEq, Eq)]
enum WebEditPredictionConfig { Codestral, Fim(edit_prediction::EditPredictionModel) }

/// :111-155 with these arms: Copilot → None (until §7 item 3 lands; a one-time workspace notification
/// "Copilot edit predictions are not available in the browser yet"); Zed → None ("Zed's edit prediction
/// requires Zed sign-in", one-time); Mercury → None; Codestral → Codestral; Ollama → None (localhost is
/// unreachable from the tab under the editor CSP, §4.2); OpenAiCompatibleApi →
/// Fim(model) with exactly the prompt-format inference of :121-149 (Zeta-format FIM is allowed: the store
/// only requires cloud credentials when the provider is not Ollama/OpenAiCompatibleApi, edit_prediction.rs:2763-2770)
/// — but **only** when `provider_for_url(origin, &settings.open_ai_compatible_api.api_url).is_some()`; that
/// setting defaults to "" (default.json:1878) and is not in §4.3's overrides, so without the guard the user
/// gets an edit-prediction provider that either does nothing or is blocked by CSP. Otherwise None, with the
/// same one-time notification as Copilot.
fn config_for_settings(cx: &App) -> Option<WebEditPredictionConfig>;

/// :213-289 restricted: Codestral arm verbatim (:249-253); Fim arm = the Zed(model) arm verbatim (:254-288);
/// None → set_edit_prediction_provider::<ZedEditPredictionDelegate>(None, ..).
fn assign(editor: &mut Editor, config: Option<WebEditPredictionConfig>, trigger: EditPredictionRequestTrigger, client: &Arc<Client>, user_store: Entity<UserStore>, window: &mut Window, cx: &mut Context<Editor>);
```

Exact Codestral wiring in the browser: `edit_predictions.codestral.api_url` is seeded to `<origin>/api/ai/codestral` (§4.3) → `codestral_api_url(cx)` (`codestral.rs:58-66`) → `load_codestral_api_key` reads the proxy provider → placeholder → `CodestralEditPredictionDelegate::fetch_completion` posts `POST <origin>/api/ai/codestral/v1/fim/completions` with `Authorization: Bearer zs-proxy-v1` (`codestral.rs:149-154`) → proxy → `POST https://codestral.mistral.ai/v1/fim/completions` with the user's key. The key is entered in the settings window's edit-prediction page (`edit_prediction_provider_setup.rs:62-84`, bound to the same `ApiKeyState`) or in the dashboard. `edit_prediction_ui`'s status-bar menu keeps listing `Zed` first (`edit_prediction_button.rs:1486`); selecting it yields no provider on the web (§7 item 11).

**Landed (round 4):** `crates/zed_web/src/web_edit_prediction.rs` as above, with `init(client, user_store, origin, cx)` taking the control-plane origin (step 30a passes it; `init_after_db` gained the `origin` parameter). Two refinements: the `Zed` arm's one-time notice is suppressed at boot — `zed` is the shipped default of `edit_predictions.provider`, so a user who never chose a provider is told nothing until the setting changes — and raised on any later change; an absent `open_ai_compatible_api` block, a non-proxied `api_url` and a failed `prompt_format` inference each raise their own one-time notice. `load_codestral_api_key` runs at init as well as on change when Codestral is selected.

### 3.20 ACP agents — deltas only (b3/b8 own the sandbox side)

- **Auth via secrets (this brief):** §3.12's `exportEnv` puts `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, … into the sandbox environment through the existing secrets path, and `routeAgents` on the gateway key sets Claude Code's `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`. No change to b8's env filtering (`ZS_` prefix and `RESERVED_SECRET_NAMES` do not touch these names) or to the manifest schema (`secretNames` grows). Terminal sign-in (`claude login`, `codex login`) keeps working as BUILD-SPEC §8 says. **This path is unmetered and uncapped** — the key leaves the control plane and the agent calls the provider directly — and BUILD-SPEC:401 calls in-sandbox agents "the primary AI experience", so the caps this brief builds cover the browser path only (§1, §3.12, §7 item 19). The gateway key can also expire or be deactivated when its creator leaves the Vercel team (§2.5), which surfaces as an opaque agent failure inside the sandbox; §3.14 says so on the toggle.
- **Per-agent env from settings (no change):** `agent_servers.<name>.env` (`settings_content/src/agent.rs:738-770`) is merged last on the server (`agent_server_store.rs:1209-1211`), so a user can still point an agent at the gateway from settings; the dashboard toggle is the no-secrets-in-settings way.
- **Spawn (not covered by any brief, recorded for the tech lead):** on the browser build the agent command is resolved on the server (`ai.proto:6-31`, `agent_server_store.rs:615-625, 850-882`) but spawned by the client (`acp.rs:824-861`); b1's WebSocket `build_command` returns `Err` (b1 line 776) and the tab cannot spawn processes. A stdio process relay over the session (`SpawnProcess`/`ProcessStdin`/`ProcessOutput`/`ProcessExited`/`KillProcess`, §4.8) with an `acp.rs` wasm arm that builds `RemoteChild` pipes instead of `Child::spawn` is required for the agent panel to work at all in the browser. The same relay is what Copilot's language server needs (§7 item 3). This brief does not implement it; §7 item 2 asks for an owner.

### 3.21 Tests — §6.

---

## 4. New types, messages, schemas

### 4.1 Drizzle schema additions (`lib/schema.ts`)

```ts
export const aiProviderKindEnum = pgEnum("ai_provider_kind", ["anthropic", "openai", "google", "mistral_fim", "opencode"]);

export const aiKeys = pgTable("ai_keys", {
  id: text("id").primaryKey(),                                   // aik_…
  userId: text("user_id").notNull().references(() => users.id),
  provider: text("provider").notNull(),                          // AI_PROVIDER_ID; "compat/<name>" for user upstreams
  kind: aiProviderKindEnum("kind").notNull(),
  upstream: text("upstream"),                                    // compat only; assertPublicHttpsUpstream
  ciphertext: text("ciphertext").notNull(),                      // "v1:<kv>:<iv>:<ct>:<tag>", AAD = aiKeyAad(userId, provider)
  keyVersion: integer("key_version").notNull(),
  exportEnv: boolean("export_env").notNull().default(false),     // → sandbox env under AI_PROVIDERS[provider].envName
  routeAgents: boolean("route_agents").notNull().default(false), // vercel_ai_gateway only: Claude Code env (§3.12)
  lastUsedAt: ts("last_used_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("ai_keys_user_provider_idx").on(t.userId, t.provider)]);

export const aiUsage = pgTable("ai_usage", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: text("user_id").notNull(),
  orgId: text("org_id"),
  workspaceId: text("workspace_id"),                             // from the zs_ai cookie's ws; null for Clerk callers
  provider: text("provider").notNull(),
  model: text("model"),                                          // from the request body when parseable (≤ 200 chars)
  streamed: boolean("streamed").notNull(),
  status: integer("status").notNull(),                           // upstream status, or the proxy's own 4xx/5xx
  inputTokens: integer("input_tokens"), outputTokens: integer("output_tokens"),
  cacheReadTokens: integer("cache_read_tokens"), cacheWriteTokens: integer("cache_write_tokens"),
  requestBytes: integer("request_bytes").notNull(), responseBytes: integer("response_bytes").notNull(),
  durationMs: integer("duration_ms").notNull(),
  upstreamRequestId: text("upstream_request_id"),                // request-id / x-request-id
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [index("ai_usage_user_created_idx").on(t.userId, t.createdAt)]);

// users, orgs: + aiTokenCapMonth: integer("ai_token_cap_month")
```

### 4.2 Provider table (`AI_PROVIDERS`; `docs/contracts/ai-providers.v1.json`)

| id | kind | upstream | envName | allowed paths (`^…$`, on `/`+path) | methods | extra forwarded request headers |
|---|---|---|---|---|---|---|
| `anthropic` | anthropic | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` | `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`, `/v1/models/[^/]+` | GET, POST | `anthropic-version`, `anthropic-beta` |
| `openai` | openai | `https://api.openai.com/v1` | `OPENAI_API_KEY` | `/chat/completions`, `/responses`, `/responses/compact`, `/embeddings`, `/models`, `/models/[^/]+` | GET, POST | `openai-beta` |
| `google` | google | `https://generativelanguage.googleapis.com` | `GEMINI_API_KEY` ⚠ | `/v1beta/models`, `/v1beta/models/[^/:]+:(streamGenerateContent\|generateContent\|countTokens)` | GET, POST | — |
| `mistral` | openai | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` ⚠ | `/chat/completions`, `/models` | GET, POST | — |
| `deepseek` | openai | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` ⚠ | `/chat/completions`, `/models` | GET, POST | — |
| `open_router` | openai | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` ⚠ | `/chat/completions`, `/models`, `/models/user` | GET, POST | `http-referer`, `x-title` |
| `x_ai` | openai | `https://api.x.ai/v1` | `XAI_API_KEY` ⚠ | `/chat/completions`, `/responses`, `/models` | GET, POST | — |
| `opencode` | opencode | `https://opencode.ai/zen` | `OPENCODE_API_KEY` ⚠ | `/(go/)?v1/messages`, `/(go/)?v1/chat/completions`, `/(go/)?v1/responses`, `/(go/)?v1/models`, `/(go/)?v1/models/[^/:]+:streamGenerateContent` | GET, POST | `anthropic-version`, `anthropic-beta` |
| `vercel_ai_gateway` | openai | `https://ai-gateway.vercel.sh/v1` | `AI_GATEWAY_API_KEY` | `/chat/completions`, `/responses`, `/responses/compact`, `/embeddings`, `/models`, `/models/[^/]+/[^/]+`, `/models/[^/]+` | GET, POST | `anthropic-beta`, `x-title`, `http-referer` |
| `codestral` | mistral_fim | `https://codestral.mistral.ai` | `CODESTRAL_API_KEY` ⚠ | `/v1/fim/completions` | POST | — |
| `compat/<name>` | openai \| anthropic (row) | row `upstream` | — | openai: `/(v1/)?(chat/completions\|responses\|completions\|embeddings\|models(/[^/]+)?)`; anthropic: `/(v1/)?(messages\|messages/count_tokens\|models(/[^/]+)?)` | GET, POST | as the kind |

⚠ marks an `envName` whose spelling is **conventional but unverified**. Only `ANTHROPIC_API_KEY`, `AI_GATEWAY_API_KEY`, `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` were checked against vendor documentation (§2.5). An unverified `envName` costs nothing in the proxy — it is used solely by `exportEnv` (§3.12) — but it silently fails to configure the in-sandbox tool it is meant for, so §3.14 shows the exact variable name next to the toggle and each ⚠ row must be verified before its toggle is offered. `OPENAI_API_KEY` is Zed's own env var for that provider (`open_ai.rs:37-38`) and is safe.

The `id`s are Zed's settings keys (`settings_content/src/language_model.rs:12-29`, `default.json:2542-2583`); `x_ai` and `open_router` keep Zed's underscore spelling.

**`ollama`, `lmstudio` and `llama.cpp` are not proxied, and are not reachable at all.** The first draft said a tab can reach their `localhost` defaults directly (`default.json:2551-2569`); it cannot — the editor CSP is `connect-src 'self' wss://*.vercel.run https://*.vercel.run` (CONTRACTS §8.4, `apps/web/lib/csp.ts:11`), and `http://localhost:11434`, `http://localhost:8080` and `http://localhost:1234/api/v0` match none of those sources, so the request is blocked before it leaves the page. `register_language_model_providers` registers all three unconditionally (`language_models.rs:247-270`), so without a change they appear in the model picker and the settings UI and always fail with an opaque network error. §3.18 therefore adds a `cfg(target_family = "wasm")` skip for those three in `register_language_model_providers` (`language_models.rs:243-270`), upstream-shaped and alongside the `bedrock` gate b7 §3.5 already adds, and §3.19 maps the `Ollama` edit-prediction arm to `None`.

`bedrock`, `zed.dev`, `copilot_chat` and `openai_subscribed` are out of scope (AWS SigV4, Zed sign-in, GitHub device flow, ChatGPT OAuth with a localhost callback, `openai_subscribed/src/*.rs:35-36, 1117-1146`).

`opencode`'s allowlist carries the optional `go/` prefix because every OpenCode **Go** model appends `/go` to the api_url before the dialect crates append `/v1/…` (`opencode.rs:46-51`, `provider/opencode.rs:341-361`), and Go models are shown by default (`show_go_models`, "Defaults to true"). Without the prefix every Go model 404s with `path_not_allowed`. Still **unverified**: opencode's Anthropic-protocol models are built by the `anthropic` crate, which sends `X-Api-Key`, whereas §3.10 step 6 injects `authorization: Bearer` for kind `opencode` and drops `x-api-key`. Nothing here establishes that `https://opencode.ai/zen` (or `/zen/go`) accepts Bearer on its Anthropic surface. Until it is checked against a live endpoint, treat opencode's Anthropic models as broken and ship the provider with only its OpenAI-dialect models enabled (§7 item 21).

Gateway mode = the `vercel_ai_gateway` row: one `vck_…` key, Zed's `vercel_ai_gateway` provider lists the gateway's models (`vercel_ai_gateway.rs:502-604`) and routes `anthropic/…`, `openai/…`, `google/…` ids through one upstream. The `/models/.+` entry of the first draft is replaced by `/models/[^/]+/[^/]+` and `/models/[^/]+`: `.+` matches `/`, so `/models/anything/you/like` reached the gateway — the widest hole in the allowlist and inconsistent with the `[^/]+` every other row uses. `/responses/compact` is added so `open_ai/src/responses.rs:737-739` works through the gateway as it does through the `openai` row. An Anthropic-dialect gateway entry is a compat provider: `PUT /api/ai/keys/compat/gateway-anthropic { kind: "anthropic", upstream: "https://ai-gateway.vercel.sh", key }` plus `anthropic_compatible.gateway-anthropic = { api_url: "<origin>/api/ai/compat/gateway-anthropic", available_models: [{ name: "anthropic/claude-sonnet-5", … }] }` in settings (`available_models` is required because the gateway's Anthropic surface does not document `/v1/models`, §7 item 12).

### 4.3 Settings JSON seeded by `zed_web` (`ai_proxy_settings_overrides(origin)`, merged over b7 §4.5's overrides)

```jsonc
{
  "language_models": {
    "anthropic":         { "api_url": "{origin}/api/ai/anthropic" },
    "openai":            { "api_url": "{origin}/api/ai/openai" },
    "google":            { "api_url": "{origin}/api/ai/google" },
    "mistral":           { "api_url": "{origin}/api/ai/mistral" },
    "deepseek":          { "api_url": "{origin}/api/ai/deepseek" },
    "open_router":       { "api_url": "{origin}/api/ai/open_router" },
    "x_ai":              { "api_url": "{origin}/api/ai/x_ai" },
    "opencode":          { "api_url": "{origin}/api/ai/opencode" },
    "vercel_ai_gateway": { "api_url": "{origin}/api/ai/vercel_ai_gateway" }
  },
  "edit_predictions": {
    "codestral": { "api_url": "{origin}/api/ai/codestral" }
  }
}
```

`edit_predictions.open_ai_compatible_api.api_url` is deliberately **not** seeded: it defaults to `""` (`default.json:1878`) and there is no single proxied upstream it could point at, so §3.19 gates the `OpenAiCompatibleApi` arm on `provider_for_url(origin, api_url).is_some()` and otherwise offers no provider. `ollama`, `lmstudio` and `llama.cpp` are likewise not seeded and are filtered out of registration on wasm (§4.2).

`{origin}` is `window.location.origin` (e.g. `https://zs.example.com`). Resulting request URLs (from the crates' `format!`s): `{origin}/api/ai/anthropic/v1/messages`, `{origin}/api/ai/openai/chat/completions`, `{origin}/api/ai/google/v1beta/models/<m>:streamGenerateContent?alt=sse&key=zs-proxy-v1`, `{origin}/api/ai/vercel_ai_gateway/models?include_mappings=true`, `{origin}/api/ai/codestral/v1/fim/completions`. These are defaults: a user's own `settings.json` value wins (SettingsStore layering), which is how **direct mode** works — set `language_models.openai.api_url` back to `https://api.openai.com/v1` (and, for Anthropic, `custom_headers: { "anthropic-dangerous-direct-browser-access": "true" }`, allowed by `resolve_custom_headers` since it is not reserved, `anthropic.rs:46-47`) and paste the key in the settings page; it lives in `session_keys` for the tab only and the editor CSP must also allow the host (CONTRACTS §8.4 `connect-src` does not today — §7 item 4).

### 4.4 Route contracts (zod, `lib/ai/schemas.ts`)

```ts
export const putAiKeyInput = z.object({
  key: z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/),
  kind: z.enum(["openai", "anthropic"]).optional(),          // compat/* only, required on create
  upstream: z.string().url().optional(),                      // compat/* only; assertPublicHttpsUpstream
  exportEnv: z.boolean().optional(),                          // built-ins only
  routeAgents: z.boolean().optional(),                        // vercel_ai_gateway only
});
// PUT  /api/ai/keys/{provider}  → 204 | 400 invalid_body | 400 invalid_provider | 400 invalid_upstream | 400 export_not_supported | 429 rate_limited
// DELETE /api/ai/keys/{provider} → 204 | 404 not_found
// GET  /api/ai/keys → 200 { providers: AiProviderStatus[] }        (§3.4; never values; 404 ai_disabled when ZS_AI_PROXY=off)
export interface AiUsageSummary { period: string; totals: { requests: number; inputTokens: number; outputTokens: number }; byProvider: Array<{ provider: string; requests: number; inputTokens: number; outputTokens: number }>; caps: { requestsPerDay: number | null; requestsToday: number; tokensPerMonth: number | null; tokensThisMonth: number } }
// GET  /api/ai/usage?period=YYYY-MM → 200 AiUsageSummary
// ANY  /api/ai/{provider}/{...path} → upstream status + streamed body; proxy-originated errors are dialect-shaped (§4.5)
//   with `x-zs-ai-error: <code>` carrying the machine-readable code:
//   401 unauthenticated | ai_key_missing · 403 cross_site | account_flagged · 404 ai_disabled | unknown_provider | path_not_allowed
//   400 too_many_headers · 405 method_not_allowed · 413 payload_too_large · 415 unsupported_media_type
//   429 rate_limited (Retry-After) | ai_daily_limit (Retry-After ≤ 3600) | too_many_streams · 402 ai_spend_cap
//   502 upstream_unreachable | upstream_redirect · 503 ai_unavailable · 504 upstream_timeout
// The CONTRACTS §8.1 envelope is used for /api/ai/keys and /api/ai/usage only.
// PUT /api/ai/keys/{provider} additionally: 400 invalid_key (the placeholder) | 409 compat_limit | 403 plan_required
```

### 4.5 Dialect-shaped proxy errors (header `x-zs-ai-error: <code>`)

**Every** proxy-originated 4xx/5xx on `/api/ai/{provider}/{...path}` is shaped into the provider's own dialect by one helper, not just `ai_key_missing`. Zed's `LanguageModelCompletionError::from_http_status` parses the *provider's* error JSON to get a message, so a b9-envelope body for a 402 `ai_spend_cap`, a 413, a 415 or a 504 yields no message at all and the user sees a generic failure in the thread instead of "monthly token cap reached" — and 402 in particular is a status no Zed provider special-cases. The `x-zs-ai-error` header keeps the machine-readable code for the shell and for tests; the CONTRACTS §8.1 envelope is reserved for `/api/ai/keys` and `/api/ai/usage`, which are consumed by the dashboard and by `zed_web_core`, not by a language-model provider.

- anthropic / opencode: `{ "type": "error", "error": { "type": "<authentication_error|invalid_request_error|rate_limit_error|api_error|overloaded_error>", "message": "<text>" } }`
- openai / mistral_fim / google: `{ "error": { "message": "<text>", "type": "invalid_request_error", "code": "zs_<code>" } }`

`ai_key_missing` text (status 401): "No <Provider> API key is configured for your Zed Codespaces account. Add one in the editor's Settings > AI or at <origin>/ai." `ai_spend_cap` (402) and `ai_daily_limit` (429) name the cap and the period; `too_many_streams` (429) says how many concurrent requests are allowed. Zed surfaces these messages verbatim in the thread and marks the provider unauthenticated on 401 (`from_http_status`), which points the user at the settings page (`thread_view.rs:11227-11232`).

### 4.6 Header allowlists (`lib/ai/headers.ts`)

- Request → upstream, always: `content-type`, `accept`, `idempotency-key`; per provider the `forwardHeaders` column; plus any `x-*` header except `x-api-key`, `x-goog-api-key`, `x-zs-*`, `x-vercel-*`, `x-forwarded-*`, `x-real-ip`, `x-middleware-*`, `x-nonce` (this is how Zed `custom_headers` reach the upstream). **Bounded**: at most 32 forwarded headers and 8 KiB of forwarded header bytes in total, else 400 `too_many_headers` — the wasm client's `custom_headers` are user-controlled (`provider.rs:31-69`) and the first draft's "any `x-*` header" had no count or size limit. Always dropped: `cookie`, `authorization`, `x-api-key`, `host`, `origin`, `referer`, `content-length`, `connection`, `accept-encoding`, `sec-*`, `user-agent` (replaced). Injected: the credential per kind, `accept-encoding: identity`, `user-agent`.
- Upstream → client, kept: `content-type`, `retry-after`, `request-id`, `x-request-id`, `anthropic-ratelimit-*`, `x-ratelimit-*`, `openai-processing-ms`, `openai-version`, `x-should-retry`, `x-provider-name`, `x-generation-id`. Dropped: `set-cookie`, `content-encoding`, `content-length`, `transfer-encoding`, `connection`, `access-control-*`, `cf-*`, `server`, `via`, `alt-svc`, `strict-transport-security`. Added: `cache-control: no-store`, `x-accel-buffering: no`, `x-zs-ai-request-id`.

### 4.7 `zs_ai` cookie

`zs_ai` = HS256 JWT `{ sub: <userId>, aud: "zs-ai", ep: <epoch>, iat, oat: <original iat>, exp: iat + 43200, jti }` signed with `ZS_EDITOR_COOKIE_SECRET`; attributes `HttpOnly; Secure; SameSite=Strict; Path=/api/ai; Expires=<exp>`; minted with `zs_editor` on `/w/:id` document requests and by `POST /api/workspaces/{id}/session`, which refuses to refresh past `oat + 24 h`. There is **no `ws` claim** (§3.8): the mint site cannot check workspace access, so the cookie proves only `sub`. `ep` is checked against `zs:ai:epoch:<sub>`, bumped on key delete, account flag and sign-out. Proposed CONTRACTS §6.2 row: "AI cookie `zs_ai` | HS256 (`ZS_EDITOR_COOKIE_SECRET`); claims `{ sub, aud: "zs-ai", ep, iat, oat, exp: +12 h, jti }`; refresh refused past `oat` + 24 h; `ep` checked against `zs:ai:epoch:<sub>`; `HttpOnly; Secure; SameSite=Strict; Path=/api/ai` | b11 §3.8".

### 4.8 Stdio process relay (proposal only — §3.20, §7 items 2-3; not implemented here)

CONTRACTS.md:245 says "No other brief changes `.proto`" — `remote_process.proto` conflicts with that line, so it cannot land without a CONTRACTS amendment (recorded in §7 item 16).

`remote_process.proto` (b4 style, all `Background`, `entity_messages` by `project_id`): `SpawnProcess { project_id; program; args; env map; cwd optional; } → SpawnProcessResponse { process_id u64 }`; `ProcessStdin { project_id; process_id; data bytes ≤ 64 KiB }`; `ProcessOutput { project_id; process_id; stream STDOUT|STDERR; data bytes ≤ 64 KiB }`; `ProcessExited { project_id; process_id; code optional int32; signal optional int32 }`; `KillProcess { project_id; process_id }`. Server: a `ProcessManager` beside b3's `PtyManager` (piped stdio, no PTY, killed on session detach). Client: `remote::RemoteChild { stdin: impl AsyncWrite, stdout: impl AsyncRead, stderr: impl AsyncRead, exit: Task<ExitStatus> }`; `RemoteConnection::supports_process_relay() -> bool { false }` (true for WebSocket). Consumers: `acp.rs:849-861` wasm arm (`RemoteChild` instead of `Child::spawn`), and `lsp::LanguageServer::new_with_io<Stdin, Stdout, Stderr, F>(server_id, server_name, stdin, stdout, stderr: Option<Stderr>, stderr_capture, code_action_kinds, binary, root_uri, workspace_folders, cx, on_unhandled_notification: F) -> Self` (a `pub` wrapper over `new_internal`, `lsp.rs:497-517`, with `server: None`) — the wrapper must carry `new_internal`'s **fourth** generic `F: Fn(&NotificationOrRequest) -> bool + 'static + Send + Sync + Clone` and supply the argument, and the `RemoteChild` pipes must satisfy `Stdin: AsyncWrite + Unpin + Send + 'static` / `Stdout`,`Stderr: AsyncRead + Unpin + Send + 'static`, which is a real constraint on the relay's design used by a wasm arm of `copilot.rs:556-591` that spawns `/usr/local/lib/copilot-language-server/copilot-language-server --stdio` from the image (b8) instead of `get_copilot_lsp` — that is the "Copilot via its language server in the sandbox" of BUILD-SPEC §8, and the sign-in device flow then runs inside the sandbox process, with the verification URL opened in a new tab by `copilot_ui`.

---

## 5. Package/Cargo changes with verified versions

**npm (`apps/web/package.json`)**: no new dependencies. Everything used is already pinned on disk — `dependencies` at `apps/web/package.json:19-39`, `devDependencies` at `:41-59` (the first draft cited `:12-51`, which is the `scripts` block through `drizzle-kit` and excludes both `tsx` at `:55` and `vitest` at `:58`): `next 16.3.4` (`after`, `RouteContext`, route-segment `maxDuration`), `zod 4.5.4`, `jose 6.2.10` (`zs_ai` cookie), `@upstash/ratelimit 2.0.8` / `@upstash/redis 1.38.3` (limits and counters), `drizzle-orm 0.45.2` / `drizzle-kit 0.31.10` (schema, migration), `@vercel/functions 3.9.5` (not needed; `after` from `next/server` is used), `vitest 4.1.11`, `tsx 4.23.13`. `crypto.randomUUID()` supplies `x-zs-ai-request-id`; there is no ULID library in the pinned set.

**One addition to `package.json`**: `"engines": { "node": "24.x" }`. Vercel's Node.js version comes from `engines.node` or the project setting — it is **not** documented as defaulting to 24 (§2.5) — and the proxy needs `AbortSignal.any` (Node ≥ 20.3), `AbortSignal.timeout`, `TransformStream` and `fetch`. Pinning it in the repo is the only way to guarantee them. `dns/promises.lookup` (§3.3) is core.

The file also differs from b9 §5 in three ways that are **not** this brief's to fix and are recorded so nobody "restores" them: no `"@zs/sdk": "workspace:*"`, no `"prebuild"` script, and `test:integration` pointing at `vitest.integration.config.mts`.

**Cargo** (workspace lines from `zed/Cargo.toml`): `crates/zed_web_core/Cargo.toml` — no additions (`serde` 1.0.221 `:808`, `serde_json` 1.0.144 `:809`, `serde_json_lenient` 0.2 `:810`, `anyhow` 1.0.86 `:527` are b7's). `crates/zed_web/Cargo.toml` `[target.'cfg(target_family = "wasm")'.dependencies]` gains only two entries: `credentials_provider.workspace = true` (`:324`) and `codestral.workspace = true` (`:310`), plus `parking_lot.workspace = true` for §3.17's `Mutex`. Everything else the first draft listed is **already** in b7 §3.19's table (b7:1250-1320): `futures`, `gpui`, `serde_json`, `wasm-bindgen-futures`, `web-time` (1.1.0, `:909`), `client`, `http_client`, `editor`, `edit_prediction`, `zed_credentials_provider` (`:507`), and `web-sys = { version = "0.3", features = ["Window", "Navigator", "Location", "Document", "console"] }` — which already carries both `Window` and `Location`, so §3.17's `page_origin()` needs no feature change. `futures` and `gpui` in particular are not additions: `zed_credentials_provider/Cargo.toml` depends on both for the same reasons (`boxed_local()`, `App`/`AsyncApp`) and b7 already declares them for `zed_web`. `copilot` (`:320`) is added only when §4.8 lands. No vendored crates, no `[patch]` entries (D31 untouched).

---

## 6. Tests

### 6.1 `apps/web/tests/ai/proxy.test.ts` (vitest; `proxyAiRequest` with an injected `fetchImpl`, `ZS_REDIS=memory`, `ZS_DB_DRIVER=pglite`; keys seeded through `putAiKey`)

| Case | Asserts |
|---|---|
| `unknown_provider`, `path_not_allowed`, `method_not_allowed` | 404/404/405 envelopes; the upstream mock is never called |
| `anthropic_injects_x_api_key` | upstream URL `https://api.anthropic.com/v1/messages`; `x-api-key` = plaintext key; incoming `x-api-key: zs-proxy-v1`, `cookie`, `authorization` absent; `anthropic-version`, `anthropic-beta`, `content-type` forwarded; `accept-encoding: identity`; `user-agent` replaced |
| `openai_bearer`, `google_query_key` | `authorization: Bearer <key>`; Google: incoming `?alt=sse&key=zs-proxy-v1` → upstream `?alt=sse&key=<key>` and `x-goog-api-key` |
| `custom_headers_forwarded` | `x-my-header` reaches upstream; `x-vercel-id`, `x-forwarded-for`, `x-zs-anything` do not |
| `key_missing_dialect_body` | no row → 401, `x-zs-ai-error: ai_key_missing`, anthropic-shaped body for `anthropic`, openai-shaped for `openai` |
| `streams_sse_without_buffering` | mock body yields three SSE chunks 50 ms apart; the first chunk is readable before the mock closes; response has `content-type: text/event-stream`, no `content-encoding`, `x-accel-buffering: no`, `cache-control: no-store` |
| `client_cancel_aborts_upstream` | cancelling the returned body's reader flips the mock's `signal.aborted` |
| `timeout_504` | mock never answers headers; fake timers past `ZS_AI_UPSTREAM_TIMEOUT_MS` → 504 `upstream_timeout` |
| `redirect_502`, `network_502` | 302 from mock → 502 `upstream_redirect`; thrown `TypeError` → 502 `upstream_unreachable` |
| `passthrough_429_headers` | upstream 429 with `retry-after`, `anthropic-ratelimit-requests-remaining` reach the client; `set-cookie` and `access-control-allow-origin` do not |
| `usage_anthropic_stream`, `usage_openai_chat`, `usage_openai_responses`, `usage_google`, `usage_nonstream` | `ai_usage` row tokens equal the mocked `usage`/`usageMetadata`; `model` from body; `workspaceId` is `null` (the cookie no longer carries `ws`, §3.8); `after()` executed (use the `vitest` `after` shim: call the registered callbacks explicitly) |
| `rate_limited_121st`, `daily_cap`, `monthly_cap`, `null_org_cap` | 429 + `Retry-After` (≤ 3600); plan `free` with 500 requests reserved today → 429 `ai_daily_limit`; `zs:ai:tokens` ≥ cap → 402 `ai_spend_cap` with `details.used/cap`; a user in an org with `ai_token_cap_month = null` gets the **plan** cap, not 0 (the `Math.min` trap of §3.5); an `enterprise` user with every cap `null` is unlimited |
| `body_limits` | `ZS_AI_MAX_BODY_BYTES` + 1 (4 MiB + 1) → 413; `text/plain` → 415; GET ignores body; `env()` refuses `ZS_AI_MAX_BODY_BYTES` above 4 500 000 and `ZS_AI_UPSTREAM_TIMEOUT_MS` above 290 000 |
| `compat_provider` | upstream from the row, kind-specific injection; `PUT` with `http://`, `https://127.0.0.1`, `https://127.1`, `https://0x7f.1`, `https://[::1]`, `https://[::ffff:169.254.169.254]`, `https://user:pass@host`, `https://zs.example.com`, and a public host whose stubbed DNS answer is `169.254.169.254` → 400 `invalid_upstream`; the 11th row → 409 `compat_limit`; `ZS_AI_ALLOW_COMPAT="0"` → 404 |
| `path_segment_encoding` | `/v1/models/x%3Ffoo%3Dbar`, `%23`, `%5C`, `%2F` in any segment → 404 `path_not_allowed`; the upstream mock is never called; `/../` likewise |
| `opencode_go_paths` | `/go/v1/messages`, `/go/v1/chat/completions`, `/go/v1/models/x:streamGenerateContent` are allowed for `opencode`; `/go/v1/messages/batches` is not |
| `gateway_paths` | `/models/anthropic/claude-sonnet-5` and `/responses/compact` allowed; `/models/a/b/c` → 404 `path_not_allowed` |
| `google_no_query_key` | the outgoing URL carries **no** `key=` parameter; `x-goog-api-key` carries the plaintext key; an incoming `key=<anything>` is stripped; a thrown `fetch` error's message contains no query string |
| `header_limits` | 33 forwarded `x-*` headers → 400 `too_many_headers`; 8 KiB + 1 of header bytes → 400 |
| `concurrency_cap` | 9 concurrent requests with `ZS_AI_MAX_STREAMS_PER_USER=8` → the 9th is 429 `too_many_streams`; finishing one releases the slot; a cancelled stream releases it too |
| `reserve_before_upstream` | N concurrent requests cannot pass a daily cap of N−1 (all reserve before any upstream call); a killed invocation (no `after`) still leaves the reservation debited, and the next `settle` reconciles it |
| `redis_down` | `reserveAiRequest` with the KV rejecting → 503 `ai_unavailable` (fail closed); `limit()` with the KV rejecting → request proceeds (fail open, b9 behaviour) |
| `flagged_account` | `users.flagged_at` set → 403 `account_flagged` before any key is decrypted |
| `dialect_errors` | 402 `ai_spend_cap`, 413, 415, 429 `ai_daily_limit`, 504 all carry the provider dialect body plus `x-zs-ai-error`; `Retry-After` for `ai_daily_limit` is ≤ 3600 |
| `first_byte_timeout` | mock delays headers past `ZS_AI_FIRST_BYTE_TIMEOUT_MS` but under the total timeout → 504 and the mock's `signal.aborted` |
| `sse_unterminated_line` | a mock that streams 2 MiB with no newline → the extractor abandons at 1 MiB, memory stays bounded, tokens recorded `null`, bytes still forwarded verbatim |
| `after_ordering_streamed` | with a real streamed body, `after`'s callback observes the extractor's final totals (this pins the §3.10 step 9 assumption; if it fails, `settle()` from `flush` is what keeps caps correct and the `ai_usage` row records `null` tokens) |
| `mid_stream_timeout` | total timeout firing after bytes are sent → one dialect-shaped SSE `error` event, then close (no bare truncation) |
| `disabled` | `ZS_AI_PROXY=off` → 404 `ai_disabled` on proxy and keys routes |

### 6.2 `apps/web/tests/ai/keys.test.ts`

Ciphertext ≠ plaintext and decrypts only with `aiKeyAad(userId, provider)` (wrong AAD → `auth_failed`); `PUT` with `key: "zs-proxy-v1"` → 400 `invalid_key`; `GET /api/ai/keys` lists all built-ins with `configured` flags and compat rows, never values; `DELETE` → 204 then 404, and it bumps `zs:ai:epoch:<user>` so an outstanding `zs_ai` stops verifying; `exportEnv` for `compat/*` → 400 `export_not_supported`; `routeAgents` for `openai` → 400; `exportedAiEnv` returns `{}` for a workspace whose `repo.ref` is a PR head; `resolveEnvFor` is never reached for a `pb-` prebuild principal (`prebuildManifest` builds its own env); `resolveEnvFor` includes `ANTHROPIC_API_KEY` only when `exportEnv` and an explicit user secret of the same name wins (`explicit_secret_wins`); `routeAgents` yields the three Claude Code variables with `ANTHROPIC_API_KEY=""`; `buildManifest().secretNames` includes the exported names and never values; `scripts/rotate-secrets.ts` rotates `ai_keys` rows; audit rows `ai_key.put`/`ai_key.delete` carry `{ provider }` only; rate `user.ai.keys` 31st → 429.

### 6.3 `apps/web/tests/ai/auth.test.ts`

`proxy.ts` sets `zs_ai` with `Path=/api/ai; SameSite=Strict; HttpOnly` on `/w/ws_…` document requests and not on `sec-fetch-dest: empty`; `config.matcher` does **not** match `/api/ai/anything` (so a Clerk outage cannot fail a completion); `POST /session` re-mints both and refuses the `zs_ai` half past `oat + 24 h`; `requireAiViewer`: valid cookie → `via: "ai-cookie"`; `aud: "zs-editor"` token in the `zs_ai` slot → 401; expired → 401; a cookie whose `ep` is behind `zs:ai:epoch:<sub>` (key deleted, account flagged, signed out) → 401; `Sec-Fetch-Site: cross-site` with a valid cookie → 403 `cross_site`; **absent** `Sec-Fetch-Site` with a cookie → 403; `Sec-Fetch-Mode: navigate` → 403; `Origin` equal to a preview-deployment host that matches the request's own origin → allowed; Clerk session without cookie → `via: "clerk"`.

### 6.4 `apps/web/tests/ai/providers.test.ts`

`AI_PROVIDERS` equals `docs/contracts/ai-providers.v1.json` (ids, kinds, upstreams, envNames), and that file equals `zed/crates/zed_web_core/tests/fixtures/ai-providers.v1.json` byte for byte (§3.15); every Zed request path from §2.4 (`/v1/messages`, `/v1/models?limit=1000`, `/chat/completions`, `/responses`, `/responses/compact`, `/models?include_mappings=true`, `/models/user`, `/v1beta/models/x:streamGenerateContent`, `/go/v1/chat/completions`, `/v1/fim/completions`, `/embeddings`) is allowed for its provider; `/v1/messages/batches`, `/models/a/b/c` and `/../` are not.

### 6.5 Rust (`cargo test -p zed_web_core`, host)

`provider_for_url`: matches on the whole **origin** and on any origin-relative `/api/ai/…` path (§3.16, amended 2026-09-04), query and fragment stripped, `compat/groq` parsed, a different scheme, host or port → `None`, a non-`/api/ai/` path → `None`, `keys`/`usage` → `None`; `foreign_proxy_provider` names every absolute `/api/ai/<id>` URL the origin comparison rejected (`www`, a preview host, `http://`, `:8443`, a malformed page origin) and nothing that `provider_for_url` accepts, so the two are mutually exclusive; `proxy_api_url` has no trailing slash; `merge_ai_proxy_defaults(default_settings(), origin)` yields exactly the §4.3 URLs for the nine providers and codestral, does **not** set `edit_predictions.open_ai_compatible_api.api_url`, leaves `ollama`/`lmstudio`/`llama.cpp` at their defaults, and keeps every other key of `default.json`; the same call with **two different origins in one process** returns two different results (the `OnceLock` is keyed on origin, §3.18); `PROXIED_LANGUAGE_MODEL_PROVIDERS` ⊆ the fixture's ids and an unknown fixture id is ignored rather than panicking (§3.15's append-only rule); `KeysResponse` parses the fixture-shaped JSON, and a 404 `ai_disabled` body parses as `Disabled`, not as an error.

`zed_web` itself is wasm-only (b7 §3.19), so `ai.rs` is covered end to end below — but two of its invariants are pinned by host-testable helpers extracted into `zed_web_core`: a credential lookup for a non-proxy URL never yields `PLACEHOLDER_KEY`, and a `write_credentials` payload never contains it.

### 6.6 Playwright (`apps/web/e2e/ai.spec.ts`, against a `compat/<name>` row whose upstream is the local fake — there is no global override env var, §3.1)

Save an Anthropic key on `/ai` → open `/w/<id>` → Settings > AI shows Anthropic "API Key Configured" (placeholder loaded) → send a prompt → the fake upstream receives `x-api-key` = the saved key and streams SSE → tokens appear incrementally in the thread → `/api/ai/usage` counts one request. Second scenario: no key → thread shows the `ai_key_missing` message; typing a key in the settings page → `PUT /api/ai/keys/anthropic` observed → retry succeeds without reload; a `PUT` forced to fail raises a notification instead of showing "API Key Configured" (§3.17). Third scenario: closing the tab mid-stream aborts the fake upstream within a second — which is what proves §3.9a's `supportsCancellation` is deployed, since without it the abort never arrives.

---

## 7. Risks and open questions

1. **Two BUILD-SPEC amendments.** (a) §8 line 402: live preflights (§2.5) show Anthropic (with its opt-in header), OpenAI, Google, Mistral, OpenRouter, xAI, DeepSeek and the AI Gateway all allow browser CORS today, so "Browser CORS blocks most providers" should be amended — the proxy stays for key custody, the editor CSP, limits and metering. (b) §7.9 line 387: "decrypted only inside the create and resume workflows to build the sandbox `env`" no longer holds, because `resolveAiKey` decrypts inside a route handler on every proxied request (§3.10, §3.12). Both need a line in BUILD-SPEC and, because a peer brief cannot amend the plan of record on its own, a DECISIONS entry (item 16). Direct mode (§4.3) is possible but needs a CSP change (item 4).
2. **ACP agents cannot spawn from the browser (delta for the tech lead).** §2.4/§3.20: the agent command is resolved on the server but spawned by the client, and b1's WebSocket `build_command` returns `Err`. Without the §4.8 relay the agent panel — BUILD-SPEC §8's "primary AI experience" — does not work in the tab. Proposed ownership: proto + server handler as a b4/b2-style addition, `acp.rs` wasm arm here or in b7's follow-up. Decision requested.
3. **Copilot in the sandbox needs the same relay** plus a `pub` io-injecting `LanguageServer` constructor (`lsp.rs:497-517`) and the Copilot LSP binary in the image (b8 does not list it). Until then Copilot edit prediction and Copilot Chat are unavailable in the browser; the web registry maps `Copilot` to `None` with a notification (§3.19). Also unverified: whether `project.node_runtime()` is `Some` for a remote project when `AppState.node_runtime` is `NodeRuntime::unavailable()` (`edit_prediction.rs:1288-1298`).
4. **Direct mode, CSP, and the three paths that bypass the proxy.** CONTRACTS §8.4's `connect-src` allows only `'self'` and `*.vercel.run` (`apps/web/lib/csp.ts:11`); a user who sets `api_url` back to a provider host fails at CSP before CORS. Three configurations reach that state without the user meaning to: (a) deliberate direct mode (§4.3); (b) `opencode::Model::Custom { custom_model_api_url }`, which **replaces** the api_url entirely (`provider/opencode.rs:342-352`) and so leaves the proxy for a host the CSP blocks; (c) `ollama`/`lmstudio`/`llama.cpp`, whose `localhost` defaults are unreachable from a tab — §4.2 filters those three out of wasm registration rather than leaving three always-failing entries in the picker. For (b), `zed_web` shows a one-time notification when a selected opencode model carries a custom api_url. Recommendation for (a): keep the CSP as is in v1; the placeholder-based proxy already covers every provider.
5. **Request streaming.** v1 buffers request bodies (needed for `model`/`stream`/`max_tokens` and the 4 MiB cap; the wasm client buffers anyway). If a future client streams uploads, switch to `body: req.body, duplex: "half"` and move model detection to a bounded prefix scan.
6. **Abort propagation on Vercel — resolved, and it is opt-in.** It *is* documented (§2.5): `request.signal` fires on client disconnect only when the deployment config declares `"supportsCancellation": true` for the path. Without it neither `req.signal` nor the response stream's `cancel` hook runs at all — the first draft's "the design does not rely on `Request.signal`" was wrong, because the `cancel` hook it relied on instead is driven by the same platform signal. §3.9a adds the flag to `apps/web/vercel.ts`; §6.6's third scenario is what proves it is deployed. Residual risk: if the flag is dropped in a future config edit, abandoned streams silently bill the user's provider for up to 290 s, and nothing else in the system notices — worth a deploy-time assertion.
7. **Duration.** `maxDuration = 300` matches the Fluid default; long non-streaming generations near that limit die at the proxy (504 from our timer at 290 s). Pro can raise it to 800 s; decide per plan, and consider refusing `stream: false` bodies with `max_tokens` above a threshold.
8. **Caps are token counts, not money.** BUILD-SPEC §7.10's spend caps are in cents; provider pricing changes too often to hard-code. v1 caps tokens per month and requests per day; a `lib/ai/prices.ts` estimate is dashboard-only. Confirm with product.
9. **Key residency in the tab.** After a user types a key in the settings page, `ApiKeyState::store` keeps the plaintext in wasm memory for the tab (`api_key.rs:113-131`) even though the proxy ignores it. Acceptable (the user typed it there); a reload replaces it with the placeholder. A `set_api_key(None)` in the UI deletes the control-plane key too (via `delete_credentials`).
10. **Org-level keys.** v1 keys are per user; a team BYOK (org row, members inherit) needs an `orgId` column and precedence rules. Deferred.
11. **`edit_prediction_ui` still offers `Zed` and, when `GlobalCopilotAuth` says authenticated, `Copilot`** (`edit_prediction_button.rs:1483-1520`); on the web both are dead ends. A small `cfg(target_family = "wasm")` filter there is an upstream-shaped follow-up.
12. **Gateway Anthropic dialect and `/v1/models`.** Zed's Anthropic providers list models from `{api_url}/v1/models` (`anthropic.rs:345-357`); the gateway documents only `/v1/messages` and `/v1/messages/count_tokens` on its Anthropic surface, so an `anthropic_compatible` gateway entry needs `available_models` in settings. The OpenAI-dialect `vercel_ai_gateway` provider has no such gap.
13. **Copilot Chat, `openai_subscribed`, `zed.dev`** are excluded (device/OAuth flows with localhost callbacks or Zed sign-in). Copilot Chat could later ride the relay (the LSP holds the token) or a proxied device flow.
14. **Env var names for agents, and gateway key lifetime.** `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `AI_GATEWAY_API_KEY` are verified (§2.5); every ⚠ row in §4.2 (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `OPENCODE_API_KEY`, `CODESTRAL_API_KEY`) and `OPENAI_BASE_URL` for Codex-through-gateway are conventional but unverified, so their `exportEnv` toggle stays hidden and `routeAgents` configures Claude Code only in v1. Separately, a gateway key **can** expire (`expiresAt`) or be deactivated when its creator leaves the Vercel team (§2.5), which breaks in-sandbox Claude Code with no signal from this system; the AI page shows the key's last-used time and §3.14 says so.
15. **Google's query-string key — removed on the outbound leg.** The first draft re-appended `key=<plaintext>` to the upstream query "so either server accepts it"; that is the leak, and the incoming URL carrying only the placeholder is irrelevant because the exposure is outbound: a Node `fetch` rejection surfaces the request URL through its error/`cause` chain, and any unhandled rejection or platform error logger captures it. §3.10 step 6 now injects `x-goog-api-key` **only** (Google's REST API accepts the header form), strips any incoming `key=`, and routes every logged or thrown URL through `redactUrl()`. `recordAiUsage` still stores no URL.
16. **Reconciliation with b9 and CONTRACTS — needs a DECISIONS entry, not a brief sentence.** `DECISIONS.md:28` says decisions "override any brief text and any CONTRACTS.md row that conflicts with them", and only DECISIONS has that power; b11 is a peer brief, so it cannot by itself supersede b9 §7 item 16 (b9:1674), which still reads "v0 ships with `language_models` disabled on wasm … `proxy.ts`'s matcher and `lib/ratelimit.ts` gain nothing for it here". **Requested: D35**, stating that `language_models` is initialised on wasm; that b11 seeds its `api_url`s and installs the credentials provider; that keys live in `ai_keys`, not `secrets` (scope user), which is a substitution of b9 §7 item 16's own wording; that `api/ai/` is excluded from the Clerk matcher and `lib/ratelimit.ts` does gain limits; that BUILD-SPEC §8 line 402 and §7.9 line 387 are amended (item 1); and that `remote_process.proto` (§4.8), if it lands, is an exception to CONTRACTS.md:245's "No other brief changes `.proto`".

    CONTRACTS.md additions this brief owns, none of which exist today: §6.2 the `zs_ai` row (§4.7); §8.2 a block for the four `/api/ai` routes (auth, rate limits, error codes, `maxDuration`); §11 a line for `docs/contracts/ai-providers.v1.json` and its append-only rule; §8.4 a note that `supportsCancellation` is required for `app/api/ai/**`; and **§5.4** entries for the b7-owned Rust signatures this brief changes — `settings::web_default_settings(origin)`, `settings::init(fs, settings_json, origin, cx)` and `init_before_connect(.., origin, ..)`. Until those land, an implementer following CONTRACTS.md alone builds neither the cookie nor the routes.
17. **`ai-reporting-user` on the gateway.** The gateway's CORS allowlist advertises `ai-reporting-user`/`ai-reporting-tags`; their semantics were not verified. Optionally send `ai-reporting-user: sha256(userId)[..16]` behind an env flag once documented.
18. **`after` timing and the response-body limit (both unproven).** The on-disk Next docs say `after` runs "after a response (or prerender) is finished" (`after.md:6`) and "for the platform's default or configured max duration" (`:50`) — neither sentence settles when it fires for a *streamed* body. §3.10 is written so the cap accounting does not depend on the answer (`settle()` runs from the stream's `flush`/`cancel`), but the `ai_usage` row does: if `after` fires at handler return, every usage row records zero tokens. `after_ordering_streamed` (§6.1) is the test that decides; if it fails, move the insert into `flush` and use `after` only for the retry. Separately, Vercel's limits page says 4.5 MB is the maximum "for the request body **or the response body**"; streaming is documented as a supported and separate mechanism, but nothing states that a streamed response is exempt from that number. A long completion is well under it in practice; verify before assuming.
19. **The in-sandbox agents are unmetered — the biggest gap in this brief.** BUILD-SPEC:401 calls them "the primary AI experience", and §3.12's `exportEnv`/`routeAgents` puts a plaintext key (and `ANTHROPIC_AUTH_TOKEN`) into the sandbox environment, from which Claude Code, Codex and Gemini CLI call the provider directly. Nothing in `lib/ai/usage.ts`, `user.ai.requests` or `ai_usage` sees a byte of it, so this brief delivers BUILD-SPEC §7.10's "metering and spend caps per user and org" **for the browser path only**. The fix, proposed and not implemented: a sandbox-facing `POST {api}/sandboxes/{name}/ai/{provider}/{...path}` authenticated by `ZS_SANDBOX_TOKEN` (the CONTRACTS §7.4 pattern, with its own `sandbox.ai` limit), plus a supervisor loopback relay at `127.0.0.1:8450/ai/*` that attaches the bearer — so the agent sees `ANTHROPIC_BASE_URL=http://127.0.0.1:8450/ai/anthropic` and a per-boot local token, the provider key never enters the VM, and agent traffic is capped and metered on the same counters. That spans b8 (supervisor) and b9 (routes); it needs an owner.
20. **`ZS_AI_PROXY=off` is only half a kill switch.** The §4.3 overrides are static and still seeded, so with the proxy off every provider's `api_url` points at a URL that 404s. §3.17's explicit `Disabled` branch makes that read as "no provider configured" rather than an error on every `authenticate`, which is the important half. `exportedAiEnv` deliberately keeps working (those keys are already in the database and the sandbox path does not go through the proxy). Accepted as a documented state rather than a fully clean one; a fully clean version would have `zed_web` skip the overrides when the boot-time keys request answers 404, at the cost of a boot-order dependency on that request.
21. **opencode's Anthropic surface and Bearer (unverified).** Opencode's Anthropic-protocol models are built by the `anthropic` crate, which sends `X-Api-Key`; §3.10 injects `authorization: Bearer` for kind `opencode` and drops `x-api-key`, and nothing establishes that `https://opencode.ai/zen` accepts Bearer there. Ship opencode with OpenAI-dialect models only until a live check says otherwise; the alternative is a per-path credential rule inside the `opencode` kind.

---

## 8. Review log

Two reviews of the first draft, 2026-09-03. Every finding was re-checked against the tree and the live vendor docs before a verdict was recorded. **Confirmed** = the finding is right and the brief has been changed. **Partly** = the substance is right, a detail is not. **Not confirmed** = the finding is wrong; the brief is unchanged and the reason is given.

### 8.1 Correctness of claims and anchors

| # | Finding | Verdict | What changed |
|---|---|---|---|
| 1 | The whole preamble ("`apps/web` is still the Next.js scaffold … `docs/contracts/` does not exist") is stale; b9 has landed. | **Confirmed** — `apps/web/lib/` holds 34 modules, `package.json` is 61 lines, `next.config.ts` 39, and `docs/contracts/fixtures/manifest.example.json` exists. | Preamble rewritten; §2.2's b9 rows re-anchored to on-disk `file:line`; §3.12 and §3.8 rewritten against the shipped code. |
| 2 | `ProxyCredentialsProvider`'s `RefCell` fields cannot compile: `CredentialsProvider: Send + Sync` requires `Sync`. | **Confirmed** — `credentials_provider.rs:11`; `zed_credentials_provider.rs:32-34` says the same in a comment. | §3.17 uses `parking_lot::Mutex`, states that no guard may be held across an `await`, and §5 adds `parking_lot`. |
| 3 | Vercel's request-body limit is 4.5 MB, not 100 MB; an 8 MiB default is above the platform ceiling. | **Confirmed** — `vercel.com/docs/functions/limitations` §"Request body size" (last_updated 2026-08-24): "The maximum payload size for the request body or the response body of a Vercel Function is **4.5 MB**", 413 `FUNCTION_PAYLOAD_TOO_LARGE`. The bundled skill (`SKILL.md:484`) is wrong. | §2.5 rewritten; `ZS_AI_MAX_BODY_BYTES` default 4 MiB with a `.max(4_500_000)` refinement; §6.1 `body_limits` updated. The same sentence's "or the response body" clause is recorded as unproven for streams in §7 item 18. |
| 4 | Client-disconnect cancellation is opt-in (`supportsCancellation`); without it neither `req.signal` nor the stream `cancel` hook fires, and `vercel.ts` is never touched. | **Confirmed** — functions API reference §"Cancel requests"; `apps/web/vercel.ts` has no `functions` key. | New §3.9a adds `functions: { "app/api/ai/**": { supportsCancellation: true } }`; §3.10 steps 7-8 and §7 item 6 rewritten; §6.6 gains a third scenario. |
| 5 | Every OpenCode **Go** model appends `/go` before `/v1/…`, so none of the allowlisted paths match; Go models are on by default. | **Confirmed** — `opencode.rs:46-51`, `provider/opencode.rs:341-361`, `settings_content/src/language_model.rs:247`. | §4.2's opencode row is `/(go/)?v1/…`; §2.4 documents the suffix; §6.1/§6.4 gain `opencode_go_paths`. |
| 6 | `include_str!("../../../docs/contracts/…")` is the wrong depth **and** `zed/` is a nested git repository, so the shared fixture cannot work as specified. | **Confirmed** — both `.git` directories exist; three `..` lands in `zed/`. | §3.15 replaces it with a checked-in copy under `zed/crates/zed_web_core/tests/fixtures/`, the canonical file at repo root, and a CI drift check; §6.4 asserts the two are byte-identical. |
| 7 | Two of three `remote_client.rs` anchors are wrong. | **Confirmed** — `build_command` is at `:1006` and `:1678`; `Interactive` at `:129-136`. | §2.4 corrected. |
| 8 | §5's `package.json:12-51` is the wrong range and "identical to b9 §5" is false. | **Confirmed** — `dependencies` 19-39, `devDependencies` 41-59; no `@zs/sdk`, no `prebuild`, `.mts` not `.ts`. | §2.2 and §5 corrected; the three deltas are recorded as not-this-brief's-to-fix. |
| 9 | A crate-root `mod edit_prediction` collides with the `edit_prediction` crate that b7 step 30 already calls. | **Confirmed** — `edit_prediction.rs:3522` `pub fn init(cx: &mut App)`; b7:774. | Module renamed `web_edit_prediction` throughout (§3.17, §3.19, §3.18), and step 30a is placed **after** b7's step 30. |
| 10 | Step 8a's `origin` does not exist when step 4 needs it, and `init_before_connect` has no `origin` parameter. | **Confirmed** — b7:737 (step 4) precedes b7:741 (step 8). | §3.18 adds `origin: &str` to `init_before_connect`, resolved in `boot.rs`, passed to step 4. |
| 11 | D15 contains no "scope `ai:<provider>`" design, and b9 §7 item 16's "key lookup from `secrets` (scope user)" is silently replaced. | **Confirmed** — `DECISIONS.md:19` is one sentence; b9:1674. | §3.4's AAD comment no longer claims inheritance; the substitution is recorded in §2.2 and §7 item 16, which now asks for D35. |
| 12 | AI Gateway keys can expire (`expiresAt`) and are deactivated when the creating member leaves the team. | **Confirmed** — AI Gateway API-keys doc. | §2.5 corrected; §7 item 14 and §3.14 note the failure mode. |
| 13 | CONTRACTS §11's wasm-home row is at line 615, not 618. | **Confirmed.** | §2.1 corrected. |
| 14 | §3.18's "a disabled proxy simply reports every provider unconfigured" contradicts §3.17, where a non-`KeysResponse` body becomes `Err` → `AuthenticateError::Other`. | **Confirmed** — `api_key.rs:255-283`. | §3.17 gains an explicit `KeysOutcome::{Known, Disabled, Unknown}` and never returns `Err`; §3.18 and §7 item 20 rewritten. |
| 15 | `anthropic.rs:434-444` and `open_ai.rs:1096-1155` mislabel the functions at those lines. | **Confirmed** — `send_request` at `:426`, `stream_completion` at `:261`; `chat_completion_request` at `:1137`. Endpoints and headers were right. | §2.4 corrected. |
| 16 | b9's `users` table is 864-878 (862 is the `ts` helper); the `maxDuration` sentence is b9:718, not 719. | **Confirmed.** | §2.2 corrected, plus `flaggedAt` and `memberships` added to the row. |
| 17 | `lsp.rs`'s `pub fn new(` is at 428 and `copilot.rs`'s at 317, both off by one in the brief. | **Partly** — `copilot.rs:317` is right and is fixed. `lsp.rs` `pub fn new(` is at **429**, so the brief's `:429-495` was already correct; that half of the finding is wrong. | §2.4's copilot anchor corrected; the lsp anchor left as is. |
| 18 | §4.8's `new_with_io` signature omits `new_internal`'s fourth generic `F` and its `Send + 'static` pipe bounds. | **Confirmed** — `lsp.rs:497-517`. | §2.4 quotes the full signature; §4.8's wrapper carries `F` and the bounds, called out as a real constraint on the relay. |
| 19 | `ReadonlyRequestCookies` and `CookieAttributes` do not exist; the shipped names are `CookieReader` and `EditorCookieAttributes`, and `verifyEditorCookie` takes a `workspaceId`. | **Confirmed** — `apps/web/lib/editor-cookie.ts:24-26, 29-35, 69, 98`. | §3.8 rewritten with the real names; §2.2 records them. |
| 20 | `BUILD-SPEC.md:389-391` is §7.10 only; "Abuse and limits" is §7.11 at 393. | **Confirmed.** | §2.1 split into two rows; the `flagged_at` check follows from the §7.11 row (§3.10 step 2). |
| 21 | `Math.min(x, null) === 0`, so `monthlyTokenCap` gives every user in a capless org a cap of 0; and "the org" is undefined given many-to-many `memberships`. | **Confirmed.** | §3.5 filters nulls, defines which org applies (workspace org for cookie callers, strictest membership otherwise), states that `null` means unlimited and that a user value can only tighten. |
| 22 | `/api/ai/*` should be excluded from the Clerk matcher, exactly as `api/sandboxes/`, `api/webhooks/` and `api/cron/` are. | **Confirmed** — `apps/web/proxy.ts:57-60` and its own comment. | §3.9 adds `api/ai/` to the negative lookahead; §6.3 tests it. |
| 23 | Next hands `params` percent-decoded, so `%3F`/`%23`/`%5C`/`%2F` split the validated path from the fetched URL. | **Confirmed.** | §3.3 adds `PATH_SEGMENT` and `buildUpstreamUrl`; §3.10 steps 3 and 6 rewritten; §6.1 gains `path_segment_encoding`. |
| 24 | "Vercel egress has no private network" is asserted, not verified; the literal-IP check is bypassed by a public host resolving privately. | **Confirmed** — the premise is not among §2.5's verified facts. | §3.3's `assertPublicHttpsUpstream` is async, resolves DNS at PUT and at fetch time, rejects obfuscated literals and userinfo, gains an optional host allowlist, defaults `ZS_AI_ALLOW_COMPAT` to `"0"`, caps compat rows at 10 and gates them behind a paid plan. |
| 25 | Re-appending `key=<plaintext>` to the outgoing Google query leaks the key through `fetch` error chains; the header form suffices. | **Confirmed.** | §3.10 step 6 injects `x-goog-api-key` only, strips incoming `key=`, adds `redactUrl()`; §7 item 15 and §6.1 `google_no_query_key` rewritten. |
| 26 | Only `ai_key_missing` is dialect-shaped; a 402/413/415/504 in the b9 envelope shows the user a generic failure. | **Confirmed** — `from_http_status` parses the provider's own error JSON. | §4.5 now shapes **every** proxy-originated 4xx/5xx, keeping `x-zs-ai-error` for the code and the CONTRACTS §8.1 envelope for the keys/usage routes; §6.1 `dialect_errors`. |
| 27 | `ZS_AI_FIRST_BYTE_TIMEOUT_MS` is declared but never wired. | **Confirmed** — step 7 composed only the total timeout. | §3.10 step 7 races the fetch against a first-byte timer that is cleared on headers; §6.1 `first_byte_timeout`. |
| 28 | `ollama`/`lmstudio`/`llama.cpp` are not "reachable directly" — the editor CSP blocks `localhost`, and all three register unconditionally. | **Confirmed** — `csp.ts:11`, `language_models.rs:243-270`, `default.json:2551-2569`. | §4.2 rewritten; §3.18 filters them out of wasm registration; §3.19 maps the `Ollama` edit-prediction arm to `None`. |
| 29 | Gateway's `/models/.+` matches slashes; `/responses/compact` is missing from that row. | **Confirmed.** | §4.2 row corrected; §6.1 `gateway_paths`. |
| 30 | `ZS_AI_UPSTREAM_OVERRIDES` is a key-exfiltration path: its `VERCEL_ENV === "production"` guard does not fire on previews, which share secrets and the database. | **Confirmed** — BUILD-SPEC §13 runs Playwright against a preview; b9 §3.2 defines no preview key set. | The variable is **removed** (§3.1); §6.6 uses a `compat/<name>` row pointing at the fake upstream instead. |
| 31 | The `ws` claim is minted before workspace access is checked. | **Confirmed** — `proxy.ts:47` says so explicitly. | `ws` dropped from `AiClaims` (§3.8, §4.7); `ai_usage.workspaceId` is `null` for cookie callers in v1. |
| 32 | `Origin` compared to `controlPlaneUrl()` 403s previews, apex/`www` and second domains; an absent `Sec-Fetch-Site` should fail closed; `Sec-Fetch-Mode: navigate` should be refused. | **Confirmed.** | §3.8 step 1 rewritten; §6.3 covers all four cases. |
| 33 | `web_default_settings`'s `OnceLock` returns the first caller's origin forever, and the changed b7 signatures are missing from CONTRACTS §5.4. | **Confirmed** — §6.5 itself boots with several origins. | §3.18 keys the cache on origin; §7 item 16 lists the §5.4 entries; §6.5 tests two origins in one process. |
| 34 | `provider_for_url`'s exact-origin match degrades silently when settings sync across preview/apex/`www`. | **Confirmed** — settings sync via `/api/me/settings` (b9 §3.24); compat `api_url`s live in the user's settings file. | §3.14's snippet generator emits origin-relative URLs, which `provider_for_url` accepts on any origin. (Superseded 2026-09-04: "§3.16 matches on host" was wrong — host comparison fails on apex-vs-`www` too — so §3.16 keeps the origin comparison and adds `foreign_proxy_provider`, which makes an absolute foreign-origin proxy URL loud instead of silent.) §6.5 updated. |
| 35 | `edit_predictions.open_ai_compatible_api.api_url` defaults to `""` and is not seeded, yet §3.19 maps it to a live FIM provider. | **Confirmed** — `default.json:1878`. | §3.19 gates the arm on `provider_for_url(...).is_some()`; §4.3 says why it is not seeded. |
| 36 | b9 §7 item 16 and CONTRACTS cannot be overridden by a peer brief; D35 is needed. | **Confirmed** — `DECISIONS.md:28`. | §7 item 16 rewritten as a D35 request plus the exact CONTRACTS rows (§6.2, §8.2, §8.4, §11, §5.4). |
| 37 | §5 omits `futures` and `gpui` from `zed_web`'s dependencies. | **Not confirmed** — b7 §3.19's `zed_web/Cargo.toml` already declares `futures` (b7:1259) and `gpui` (b7:1263), along with `client`, `http_client`, `editor`, `edit_prediction`, `zed_credentials_provider`, `web-time`, `wasm-bindgen-futures`, `serde_json`, and `web-sys` with both `Window` and `Location`. | §5 corrected in the other direction: the additions are only `credentials_provider`, `codestral` and `parking_lot`; the rest of the first draft's list was redundant. |
| 38 | `lib/secrets.ts` and `lib/manifest.ts` do not exist, so §3.12 is a create-or-conflict. | **Not confirmed** — both are on disk (`lib/secrets.ts`, `lib/manifest.ts`). | §2.2 and §3.12 now cite the shipped signatures (`resolveEnvFor(workspace: Pick<Workspace, …>)`, `:61-82`) rather than a b9 section. |
| 39 | The stream cap should use `lib/concurrency.ts`, which b9 already ships. | **Partly** — the cap is needed (see 8.2), but `lib/concurrency.ts` is `mapConcurrent(items, n, fn)`, an in-process p-limit that cannot bound work across function invocations. | §3.5/§3.6 implement the cap as a Redis `zs:ai:live:<user>` counter and §3.6 says explicitly that it is not that file. |

### 8.2 Gaps that were missing entirely

Each of these was absent from the first draft and is now specified; all were confirmed against the code or the live docs.

| Gap | Where it now lives |
|---|---|
| Concurrency cap on streams (one user could hold hundreds of 300 s invocations at 120/min) | §3.1 `ZS_AI_MAX_STREAMS_PER_USER`, §3.5 `reserveAiRequest`, §3.10 step 3a, §6.1 `concurrency_cap` |
| Caps counted only in `after()`: N concurrent requests all pass the precheck, and a killed invocation never bills the largest requests | §3.5 reserve-then-reconcile, §3.10 steps 3a/8/9, §6.1 `reserve_before_upstream` |
| Undefined behaviour when Upstash is down | §3.5 (fail closed with 503 `ai_unavailable` for reservations, fail open for `limit`), §6.1 `redis_down` |
| No principal load: `requireAiViewer` returned no plan, org or caps | §3.5 `aiPrincipal` with a 60 s Redis cache and webhook invalidation |
| `users.flagged_at` never checked | §3.10 step 2 → 403 `account_flagged`, §6.1 `flagged_account` |
| No revocation path for `zs_ai` (a self-refreshing 12 h bearer) | §3.8/§4.7 `oat` + 24 h refresh ceiling and `ep` vs `zs:ai:epoch:<user>`, §6.3 |
| `PUT` accepting the placeholder as a stored key | §3.4 400 `invalid_key`, §3.17 client-side guard, §6.2 |
| `ApiKeyState::store` shows "API Key Configured" even when the write failed | §3.17 `write_credentials` re-fetches and errors, §6.6 second scenario |
| No single-flight on `GET /api/ai/keys` (≈10 concurrent GETs per boot against a 30/min limit) | §3.17 `CacheState::InFlight`, and `Unknown` → `Ok(None)` rather than `Err` |
| Unbounded SSE partial-line buffer | §3.5 1 MiB cap, §6.1 `sse_unterminated_line` |
| No cap on forwarded headers | §4.6 32 headers / 8 KiB → 400 `too_many_headers`, §6.1 `header_limits` |
| No cap or plan gate on `compat/*` rows | §3.3 10 rows, paid plan, `ZS_AI_ALLOW_COMPAT` default `"0"` |
| `exportEnv` blast radius: a workspace on an untrusted PR ref runs `postCreateCommand` with the key present | §3.12 (per-repo scope, refused off the default branch), §3.14 UI copy, §6.2 |
| No metered path for in-sandbox agents | §1, §3.12, §3.20, §7 item 19 (proposal with an owner request) |
| No writer, gate or audit for `ai_token_cap_month` | §3.2 (admin-only, clamped to the plan default, audited) |
| `maxDuration` literal vs env timeout; mid-stream timeout truncates the body | §3.1 `.max(290_000)` refinement, §3.10 step 8 SSE `error` event, §6.1 `mid_stream_timeout` |
| `Retry-After` up to 24 h on `ai_daily_limit` | §3.5 capped at 3600 s, §6.1 `dialect_errors` |
| `x-zs-ai-request-id` described as a ULID with no ULID dependency | §3.10 step 8 uses `crypto.randomUUID()`; §5 says so |
| `/api/ai/{provider}` with no trailing path fell through to Next's HTML 404 | §3.11 uses the optional catch-all `[[...path]]` |
| No compatibility rule for `ai-providers.v1.json` | §3.15 append-only within v1; unknown ids ignored by `zed_web_core`; usable only once the bundle is the workspace's `client_build` |
| `remote_process.proto` conflicts with CONTRACTS.md:245 | §4.8 note and §7 item 16's D35 request |
| Node version and `AbortSignal.any` availability unverified | §2.5 and §5: `"engines": { "node": "24.x" }` added to `package.json` |
| Seven `envName`s shipped unverified | §4.2 ⚠ markers, §3.14 (toggle hidden until checked), §7 item 14 |
| `opencode::Model::Custom` bypasses the proxy and then fails CSP | §7 item 4 (b), with a one-time notification |
| opencode's Anthropic surface may not accept Bearer | §4.2 and §7 item 21 — treated as broken until checked |
| `after` ordering for a streamed response asserted without a citation | §3.10 step 9, §7 item 18, §6.1 `after_ordering_streamed` |
| Test gaps (placeholder rejection, concurrent-cap race, killed invocation, SSRF literals, encoded segments, header limits, unterminated SSE, Redis down, prebuild env, Clerk matcher, flagged/deleted-key `zs_ai`) | §6.1-§6.5, listed case by case |
