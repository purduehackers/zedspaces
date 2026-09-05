/**
 * A loopback TCP proxy in front of a local sandbox's rpc listener
 * (`ZS_LOCAL_RPC_PROXY=1`, local backend only; `lib/sandbox-local.ts` wires it).
 *
 * With the proxy on, `domain(8443)` answers the proxy's port and every client
 * connection (the browser's WebSocket, `/files` uploads) is forwarded byte for
 * byte to the port `zed-remote-server serve` listens on. The one thing the
 * proxy adds is {@link dropRpcConnections}: the browser end-to-end suite's
 * test-only route severs every live connection at the TCP level, which the
 * client sees as an abnormal close (1006) and answers with its ordinary warm
 * reconnect (D3/D24) while the server process, its `HeadlessProject` and its
 * PTYs stay untouched — the "network blip" of BUILD-SPEC 13 without touching
 * the server or the sandbox.
 *
 * The proxies live in this process (a `net.Server` each, on `globalThis` like
 * the local backend's other stores so a Turbopack re-evaluation of the module
 * still finds them) and are re-bound lazily whenever the sandbox is touched
 * through the API, so a restarted `next dev` recovers them on the next
 * `/connect`.
 */
import net from "node:net";

interface RpcProxy {
  server: net.Server;
  port: number;
  upstreamPort: number;
  sockets: Set<net.Socket>;
  /** Resolves once the listener is bound (or rejects). */
  listening: Promise<void>;
}

const KEY = "__zsLocalRpcProxies" as const;
type GlobalWithProxies = typeof globalThis & { [KEY]?: Map<string, RpcProxy> };

function registry(): Map<string, RpcProxy> {
  const g = globalThis as GlobalWithProxies;
  if (!g[KEY]) g[KEY] = new Map();
  return g[KEY];
}

function log(message: string): void {
  console.log(`[local-rpc-proxy] ${message}`);
}

/**
 * Binds the proxy for `name` on `127.0.0.1:port` → `127.0.0.1:upstreamPort`
 * when it is not already bound. Idempotent; a proxy whose upstream changed
 * (a resumed session allocated new ports) is replaced.
 */
export function ensureRpcProxy(name: string, port: number, upstreamPort: number): Promise<void> {
  const existing = registry().get(name);
  if (existing && existing.port === port && existing.upstreamPort === upstreamPort && existing.server.listening) {
    return existing.listening;
  }
  if (existing) closeRpcProxy(name);

  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(upstreamPort, "127.0.0.1");
    sockets.add(client);
    sockets.add(upstream);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    const teardown = () => {
      sockets.delete(client);
      sockets.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    client.on("error", teardown);
    upstream.on("error", teardown);
    client.on("close", teardown);
    upstream.on("close", teardown);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.unref();
  const listening = new Promise<void>((resolve, reject) => {
    server.once("error", (err) => {
      log(`${name}: could not bind 127.0.0.1:${port} → ${upstreamPort}: ${err.message}`);
      registry().delete(name);
      reject(err);
    });
    server.listen(port, "127.0.0.1", () => {
      log(`${name}: 127.0.0.1:${port} → 127.0.0.1:${upstreamPort}`);
      resolve();
    });
  });
  // The rejection is reported to whoever awaits; nothing must crash the process on a bind race.
  listening.catch(() => undefined);
  registry().set(name, { server, port, upstreamPort, sockets, listening });
  return listening;
}

/**
 * Destroys every live proxied connection of `name` (both halves), leaving the
 * listener up so the client's reconnect succeeds. Returns how many client
 * connections were severed.
 */
export function dropRpcConnections(name: string): number {
  const proxy = registry().get(name);
  if (!proxy) return 0;
  const sockets = [...proxy.sockets];
  proxy.sockets.clear();
  for (const socket of sockets) socket.destroy();
  const dropped = Math.floor(sockets.length / 2);
  log(`${name}: dropped ${dropped} connection(s)`);
  return dropped;
}

/** Closes the listener and every connection of `name`; a no-op when there is none. */
export function closeRpcProxy(name: string): void {
  const proxy = registry().get(name);
  if (!proxy) return;
  registry().delete(name);
  for (const socket of proxy.sockets) socket.destroy();
  proxy.sockets.clear();
  proxy.server.close();
}

/** The proxy of `name`, for the test route's diagnostics. */
export function rpcProxyInfo(name: string): { port: number; upstreamPort: number; connections: number; listening: boolean } | null {
  const proxy = registry().get(name);
  if (!proxy) return null;
  return {
    port: proxy.port,
    upstreamPort: proxy.upstreamPort,
    connections: Math.floor(proxy.sockets.size / 2),
    listening: proxy.server.listening,
  };
}
