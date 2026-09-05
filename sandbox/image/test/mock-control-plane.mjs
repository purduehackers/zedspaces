#!/usr/bin/env node
// Mock control plane for the sandbox image test (brief b8 §3.22).
//
// Implements the sandbox-facing routes of CONTRACTS.md §7.4 (the ones `zs-agent` calls) plus a
// handful of `/__test/*` routes the harness uses to inspect and steer the run. Node >= 20, no
// dependencies.
//
// Usage:
//   node mock-control-plane.mjs --port 9977 --repo /abs/path/fixture.git \
//     --workspace-dir /workspaces/fixture --pubkey /abs/path/es256_public.pem \
//     --port-secret "$(openssl rand -base64 32)" [--token test-token] [--log-out logs.jsonl] \
//     [--restore-tarball /abs/path/restore.tgz] [--proxy-host localhost] [--bind 0.0.0.0]
//     [--services dockerd]   (emit the b10 devcontainer block with source "manifest", D38/D40)
//
// Routes (all sandbox routes require `Authorization: Bearer <--token>`):
//   GET    /api/sandboxes/:name/manifest        → SandboxManifest (docs/contracts fixture shape)
//   POST   /api/sandboxes/:name/git-token       → { username, token, expiresAt }
//   POST   /api/sandboxes/:name/ports           → { url, visibility, slot }
//   DELETE /api/sandboxes/:name/ports/:port     → 204
//   POST   /api/sandboxes/:name/activity        → ActivityDirective
//   POST   /api/sandboxes/:name/logs            → 204 (413 above 256 KiB)
//   POST   /api/sandboxes/:name/client-errors   → 202
//   POST   /api/sandboxes/:name/extensions      → 204
//   GET    /api/workspaces/:id/ports/:port/open → 303 to the slot's /__zs/auth bootstrap URL
//   GET    /__blob/restore.tgz                  → the --restore-tarball bytes, no auth accepted
//   GET    /__test/state                        → everything recorded so far
//   POST   /__test/directive                    → override the next activity directives
//   POST   /__test/forward                      → allocate a forward the way the UI would
//   POST   /__test/reset                        → clear the recorded state

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { isAbsolute, resolve } from 'node:path';

/** Ports the supervisor's private-port proxy binds, in allocation order (D21). */
const DEFAULT_SLOTS = [8444, 8445, 8446, 8447];
/** Ports that may never be forwarded (D21 infrastructure set 8443-8451). */
const INFRA_PORTS = [8443, 8444, 8445, 8446, 8447, 8448, 8449, 8450, 8451];
/** b9 `PORT_SESSION_TTL_SECS`. */
const PORT_SESSION_TTL_SECS = 3600;
/** Ceiling from CONTRACTS.md §7.6; larger log batches get a 413. */
const MAX_LOG_BYTES = 262144;
/** Refuse to buffer more than this from any request body. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const DEFAULT_SETTINGS = '// zs mock control plane\n{\n  "telemetry": { "metrics": false }\n}\n';

function parseArgs(argv) {
  const options = {
    bind: '0.0.0.0',
    port: 9977,
    token: 'test-token',
    workspaceId: 'ws_local',
    sandboxName: 'sb-local',
    userId: 'user_test',
    build: process.env.ZS_BUILD_ID ?? 'dev',
    region: 'local',
    repo: null,
    cloneUrl: null,
    workspaceDir: '/workspaces/fixture',
    revision: 'main',
    defaultBranch: 'main',
    pubkeys: [],
    portSecret: null,
    proxyHost: 'localhost',
    publicHost: 'localhost',
    idleMinutes: 30,
    activityIntervalSecs: 10,
    logOut: null,
    restoreTarball: null,
    restoreSha256: null,
    extensions: [],
    dotfilesUrl: null,
    settings: DEFAULT_SETTINGS,
    keymap: '[]',
    slots: DEFAULT_SLOTS,
    allowedOrigins: [],
    services: [],
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--bind': options.bind = next(); break;
      case '--port': options.port = Number(next()); break;
      case '--token': options.token = next(); break;
      case '--workspace-id': options.workspaceId = next(); break;
      case '--sandbox-name': options.sandboxName = next(); break;
      case '--user-id': options.userId = next(); break;
      case '--build': options.build = next(); break;
      case '--region': options.region = next(); break;
      case '--repo': options.repo = resolve(next()); break;
      case '--clone-url': options.cloneUrl = next(); break;
      case '--workspace-dir': options.workspaceDir = next(); break;
      case '--revision': options.revision = next(); break;
      case '--default-branch': options.defaultBranch = next(); break;
      case '--pubkey': options.pubkeys.push(readPem(next())); break;
      case '--port-secret': options.portSecret = next().trim(); break;
      case '--proxy-host': options.proxyHost = next(); break;
      case '--public-host': options.publicHost = next(); break;
      case '--idle-minutes': options.idleMinutes = Number(next()); break;
      case '--activity-interval': options.activityIntervalSecs = Number(next()); break;
      case '--log-out': options.logOut = resolve(next()); break;
      case '--restore-tarball': options.restoreTarball = resolve(next()); break;
      case '--restore-sha256': options.restoreSha256 = next(); break;
      case '--extensions': options.extensions = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--dotfiles': options.dotfilesUrl = next(); break;
      case '--settings-file': options.settings = readFileSync(next(), 'utf8'); break;
      case '--keymap-file': options.keymap = readFileSync(next(), 'utf8'); break;
      case '--slots': options.slots = next().split(',').map((s) => Number(s.trim())); break;
      case '--allowed-origin': options.allowedOrigins.push(next()); break;
      case '--services': options.services = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--quiet': options.quiet = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.pubkeys.length === 0) {
    throw new Error('--pubkey is required (a PEM SPKI public key, path or literal)');
  }
  if (!options.portSecret) {
    options.portSecret = randomBytes(32).toString('base64');
    process.stderr.write(`mock: generated --port-secret ${options.portSecret}\n`);
  }
  if (Buffer.from(options.portSecret, 'base64').length !== 32) {
    throw new Error('--port-secret must be standard base64 of exactly 32 bytes');
  }
  if (!options.cloneUrl) {
    if (!options.repo) throw new Error('one of --repo or --clone-url is required');
    options.cloneUrl = `file://${options.repo}`;
  }
  if (!isAbsolute(options.workspaceDir)) {
    throw new Error('--workspace-dir must be absolute');
  }
  return options;
}

/** Reads a PEM public key from a path, or accepts a literal PEM block. */
function readPem(value) {
  if (value.includes('-----BEGIN')) return value;
  return readFileSync(value, 'utf8');
}

const options = parseArgs(process.argv.slice(2));
const portSecretBytes = Buffer.from(options.portSecret, 'base64');
const startedAt = Date.now();

/** Everything the harness can assert on, exposed at `GET /__test/state`. */
const state = {
  requests: [],
  forwards: new Map(),
  pings: [],
  logs: [],
  extensions: [],
  clientErrors: [],
  gitTokens: [],
  restoreFetches: [],
  directive: { idleStopAt: null, sessionCapAt: null, stop: false },
};

function log(...parts) {
  if (!options.quiet) process.stderr.write(`mock: ${parts.join(' ')}\n`);
}

function base64url(buffer) {
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * b9 `signPortSession`, byte for byte: `v1.<b64url(payload)>.<b64url(HMAC-SHA256(secret, input))>`
 * with the payload keys in the order ws, port, sub, iat, exp, jti.
 */
function signPortSession(secret, payload) {
  const ordered = {
    ws: payload.ws,
    port: payload.port,
    sub: payload.sub,
    iat: payload.iat,
    exp: payload.exp,
    jti: payload.jti,
  };
  const signingInput = `v1.${base64url(Buffer.from(JSON.stringify(ordered), 'utf8'))}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${base64url(signature)}`;
}

/** Mints a bootstrap token for `port`, exactly as the control plane's `/open` route does. */
function mintBootstrapToken(port) {
  const iat = Math.floor(Date.now() / 1000);
  return signPortSession(portSecretBytes, {
    ws: options.workspaceId,
    port,
    sub: options.userId,
    iat,
    exp: iat + PORT_SESSION_TTL_SECS,
    jti: randomUUID().replaceAll('-', ''),
  });
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function fail(res, status, code, message = code) {
  send(res, status, { error: { code, message } });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(buffer) {
  if (buffer.length === 0) return {};
  return JSON.parse(buffer.toString('utf8'));
}

/**
 * The b10 devcontainer block (docs/contracts/manifest-devcontainer.v1.json, D38): with
 * `--services` the block is `source: "manifest"` and therefore AUTHORITATIVE — the supervisor
 * never reads the checkout's devcontainer.json — so it reproduces what run-local.sh's seed
 * config declares (the lifecycle files the harness asserts on, port 3000, the extension) and
 * adds the services (`dockerd`, D40). The marker hash is `1:<configHash>` on the supervisor.
 */
function devcontainerBlock() {
  if (options.services.length === 0) return null;
  const postCreate = `echo post-create > ${options.workspaceDir}/.post-create`;
  const postStart = `echo post-start > ${options.workspaceDir}/.post-start`;
  return {
    configHash: createHash('sha256').update(`zs-mock:${postCreate}:${postStart}:${options.services.join(',')}`).digest('hex'),
    source: 'manifest',
    lifecycle: {
      postCreate: { kind: 'shell', command: postCreate },
      postStart: { kind: 'shell', command: postStart },
    },
    remoteEnv: { ZS_MOCK_REMOTE_ENV: 'ignored-by-the-key-filter', MOCK_REMOTE_ENV: '1' },
    forwardPorts: [3000],
    portsAttributes: { 3000: { label: 'web', visibility: 'private' } },
    zed: { extensions: options.extensions, services: options.services },
    services: options.services,
    features: [],
  };
}

/** The manifest, rebuilt on every request so it reflects the current forwards. */
function manifest() {
  return {
    version: 1,
    workspaceId: options.workspaceId,
    sandboxName: options.sandboxName,
    sandboxGeneration: 1,
    userId: options.userId,
    build: options.build,
    region: options.region,
    repo: {
      owner: 'acme',
      name: 'fixture',
      cloneUrl: options.cloneUrl,
      defaultBranch: options.defaultBranch,
      revision: options.revision,
      depth: 0,
      ref: null,
    },
    workspaceDir: options.workspaceDir,
    restore: options.restoreTarball
      ? {
          tarballUrl: `http://${options.publicHost}:${options.port}/__blob/restore.tgz`,
          sha256: options.restoreSha256,
        }
      : null,
    dotfiles: options.dotfilesUrl ? { repoUrl: options.dotfilesUrl, installCommand: null } : null,
    env: {
      ZS_WORKSPACE_ID: options.workspaceId,
      ZS_REGION: options.region,
      NODE_ENV: 'development',
    },
    secretNames: [],
    jwt: {
      issuer: 'zs',
      audience: options.sandboxName,
      publicKeys: options.pubkeys,
    },
    portSessionSecret: options.portSecret,
    proxySlots: options.slots,
    forwards: [...state.forwards.values()],
    portPool: [3000, 3001, 4000, 5000, 5173, 8000, 8080, 8888],
    idle: { minutes: options.idleMinutes },
    session: {
      id: 'ses_mock_00000000',
      startedAt: startedAt,
      capAt: startedAt + 24 * 3600 * 1000,
      resumed: false,
    },
    devcontainer: devcontainerBlock(),
    settings: { settings: options.settings, keymap: options.keymap },
    logs: { flushIntervalSecs: 5, maxBatch: 200, maxBatchBytes: MAX_LOG_BYTES },
    activity: { intervalSecs: options.activityIntervalSecs },
    allowedOrigins:
      options.allowedOrigins.length > 0
        ? options.allowedOrigins
        : [`http://${options.publicHost}:${options.port}`],
    extensions: options.extensions,
    prebuild: null,
  };
}

/** Allocates (or returns) a forward, mirroring b9's slot allocation. */
function upsertForward({ port, visibility, label }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || INFRA_PORTS.includes(port)) {
    return { error: 'invalid_port', status: 400 };
  }
  const existing = state.forwards.get(port);
  if (existing && existing.visibility === visibility) return { forward: existing };

  if (visibility === 'private') {
    const used = new Set([...state.forwards.values()].map((f) => f.slot).filter(Boolean));
    const slot = options.slots.find((candidate) => !used.has(candidate));
    if (slot === undefined) return { error: 'slots_exhausted', status: 409 };
    const forward = {
      port,
      visibility,
      label: label ?? null,
      url: `http://${options.publicHost}:${options.port}/api/workspaces/${options.workspaceId}/ports/${port}/open`,
      slot,
    };
    state.forwards.set(port, forward);
    return { forward };
  }

  const forward = {
    port,
    visibility: 'public',
    label: label ?? null,
    url: `http://${options.publicHost}:${port}`,
    slot: null,
  };
  state.forwards.set(port, forward);
  return { forward };
}

function activityDirective() {
  const now = Date.now();
  return {
    idleStopAt: state.directive.idleStopAt ?? now + options.idleMinutes * 60_000,
    sessionCapAt: state.directive.sessionCapAt ?? startedAt + 24 * 3600 * 1000,
    stop: state.directive.stop,
    forwards: [...state.forwards.values()],
    serverTime: now,
  };
}

function recordLogs(batch) {
  const entries = Array.isArray(batch.entries) ? batch.entries : [];
  for (const entry of entries) state.logs.push(entry);
  if (options.logOut) {
    const lines = entries.map((entry) => JSON.stringify(entry)).join('\n');
    if (lines.length > 0) appendFileSync(options.logOut, `${lines}\n`);
  }
  return entries.length;
}

function streamRestore(req, res) {
  if (req.headers.authorization || req.headers['x-vercel-protection-bypass']) {
    state.restoreFetches.push({ authenticated: true });
    fail(res, 400, 'unexpected_credentials', 'the restore tarball must be fetched header-less');
    return;
  }
  state.restoreFetches.push({ authenticated: false });
  const size = statSync(options.restoreTarball).size;
  res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': size });
  createReadStream(options.restoreTarball).pipe(res);
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    log('handler error', error?.message ?? String(error));
    if (!res.headersSent) fail(res, 500, 'internal', String(error?.message ?? error));
    else res.end();
  });
});

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const body = await readBody(req);

  state.requests.push({
    at: Date.now(),
    method,
    path,
    bytes: body.length,
    bypass: Boolean(req.headers['x-vercel-protection-bypass']),
    build: req.headers['x-zs-build'] ?? null,
  });
  log(method, path);

  // --- test-harness routes -------------------------------------------------
  if (path === '/__test/state' && method === 'GET') {
    return send(res, 200, {
      requests: state.requests,
      forwards: [...state.forwards.values()],
      pings: state.pings,
      logs: state.logs,
      extensions: state.extensions,
      clientErrors: state.clientErrors,
      gitTokens: state.gitTokens,
      restoreFetches: state.restoreFetches,
      directive: state.directive,
      portSecret: options.portSecret,
    });
  }
  if (path === '/__test/directive' && method === 'POST') {
    const patch = parseJson(body);
    if ('idleStopAt' in patch) state.directive.idleStopAt = patch.idleStopAt;
    if ('sessionCapAt' in patch) state.directive.sessionCapAt = patch.sessionCapAt;
    if ('stop' in patch) state.directive.stop = Boolean(patch.stop);
    return send(res, 200, state.directive);
  }
  if (path === '/__test/forward' && method === 'POST') {
    const request = parseJson(body);
    const result = upsertForward({
      port: Number(request.port),
      visibility: request.visibility === 'public' ? 'public' : 'private',
      label: request.label ?? null,
    });
    if (result.error) return fail(res, result.status, result.error);
    return send(res, 200, result.forward);
  }
  if (path === '/__test/reset' && method === 'POST') {
    state.requests.length = 0;
    state.pings.length = 0;
    state.logs.length = 0;
    state.extensions.length = 0;
    state.clientErrors.length = 0;
    state.gitTokens.length = 0;
    state.restoreFetches.length = 0;
    state.forwards.clear();
    state.directive = { idleStopAt: null, sessionCapAt: null, stop: false };
    return send(res, 204);
  }

  // --- the presigned blob (no credentials accepted) ------------------------
  if (path === '/__blob/restore.tgz' && method === 'GET') {
    if (!options.restoreTarball) return fail(res, 404, 'not_found');
    return streamRestore(req, res);
  }

  // --- the /open redirect that hands the browser a bootstrap token ---------
  const open = path.match(/^\/api\/workspaces\/([^/]+)\/ports\/(\d+)\/open$/);
  if (open && method === 'GET') {
    const [, workspaceId, portText] = open;
    const port = Number(portText);
    if (workspaceId !== options.workspaceId) return fail(res, 404, 'not_found');
    const forward = state.forwards.get(port);
    if (!forward || forward.visibility !== 'private' || !forward.slot) {
      return fail(res, 404, 'not_found', 'no private forward on that port');
    }
    const token = mintBootstrapToken(port);
    const next = url.searchParams.get('next') ?? '/';
    const location = `http://${options.proxyHost}:${forward.slot}/__zs/auth?zs_port_token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`;
    res.writeHead(303, { location, 'content-length': 0 });
    return res.end();
  }

  // --- sandbox-facing routes ----------------------------------------------
  const sandbox = path.match(/^\/api\/sandboxes\/([^/]+)(\/.*)?$/);
  if (!sandbox) return fail(res, 404, 'not_found');

  const [, name, restRaw] = sandbox;
  const rest = restRaw ?? '';
  const authorization = req.headers.authorization ?? '';
  if (authorization !== `Bearer ${options.token}`) return fail(res, 401, 'unauthenticated');
  if (name !== options.sandboxName) return fail(res, 404, 'not_found', `unknown sandbox ${name}`);

  if (rest === '/manifest' && method === 'GET') {
    return send(res, 200, manifest());
  }

  if (rest === '/git-token' && method === 'POST') {
    const request = parseJson(body);
    state.gitTokens.push(request);
    if (request.host && request.host !== 'github.com') {
      return fail(res, 404, 'host_unsupported');
    }
    if (request.path && !/(^|\/)fixture(\.git)?$/.test(String(request.path))) {
      return fail(res, 403, 'repo_not_allowed');
    }
    return send(res, 200, {
      username: 'x-access-token',
      token: 'ghs_mock',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
  }

  if (rest === '/ports' && method === 'POST') {
    const request = parseJson(body);
    const result = upsertForward({
      port: Number(request.port),
      visibility: request.visibility === 'public' ? 'public' : 'private',
      label: request.label ?? null,
    });
    if (result.error) return fail(res, result.status, result.error);
    const { url: forwardUrl, visibility, slot } = result.forward;
    return send(res, 200, { url: forwardUrl, visibility, slot });
  }

  const portDelete = rest.match(/^\/ports\/(\d+)$/);
  if (portDelete && method === 'DELETE') {
    state.forwards.delete(Number(portDelete[1]));
    return send(res, 204);
  }

  if (rest === '/activity' && method === 'POST') {
    const report = parseJson(body);
    state.pings.push({ at: Date.now(), report });
    return send(res, 200, activityDirective());
  }

  if (rest === '/logs' && method === 'POST') {
    if (body.length > MAX_LOG_BYTES) return fail(res, 413, 'payload_too_large');
    const count = recordLogs(parseJson(body));
    log('logs', `+${count}`);
    return send(res, 204);
  }

  if (rest === '/client-errors' && method === 'POST') {
    state.clientErrors.push(parseJson(body));
    return send(res, 202, { accepted: true });
  }

  if (rest === '/extensions' && method === 'POST') {
    const request = parseJson(body);
    state.extensions.push(request);
    return send(res, 204);
  }

  return fail(res, 404, 'not_found');
}

server.listen(options.port, options.bind, () => {
  process.stderr.write(
    `mock: listening on http://${options.bind}:${options.port}/api for ${options.sandboxName} (${options.workspaceId})\n`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
