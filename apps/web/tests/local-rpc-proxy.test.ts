import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { closeRpcProxy, dropRpcConnections, ensureRpcProxy, rpcProxyInfo } from "@/lib/local-rpc-proxy";

/**
 * The loopback TCP proxy the browser suite's reconnect test severs
 * connections through (`ZS_LOCAL_RPC_PROXY=1`).
 */

function listen(handler: (socket: net.Socket) => void): Promise<{ port: number; close(): void }> {
  const server = net.createServer(handler);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() });
    }),
  );
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function once<T>(socket: net.Socket, event: "data" | "close"): Promise<T> {
  return new Promise((resolve) => socket.once(event, (value: T) => resolve(value)));
}

const names: string[] = [];
afterEach(() => {
  for (const name of names.splice(0)) closeRpcProxy(name);
});

describe("local rpc proxy", () => {
  it("forwards bytes both ways and reports its connections", async () => {
    const upstream = await listen((socket) => socket.on("data", (chunk) => socket.write(`echo:${chunk}`)));
    const port = await freePort();
    names.push("sb-proxy-a");
    await ensureRpcProxy("sb-proxy-a", port, upstream.port);
    expect(rpcProxyInfo("sb-proxy-a")).toMatchObject({ port, upstreamPort: upstream.port, listening: true, connections: 0 });

    const client = await connect(port);
    const reply = once<Buffer>(client, "data");
    client.write("hello");
    expect(String(await reply)).toBe("echo:hello");
    expect(rpcProxyInfo("sb-proxy-a")?.connections).toBe(1);
    client.destroy();
    upstream.close();
  });

  it("severs every live connection but keeps listening, so a reconnect succeeds", async () => {
    const upstream = await listen((socket) => socket.on("data", (chunk) => socket.write(chunk)));
    const port = await freePort();
    names.push("sb-proxy-b");
    await ensureRpcProxy("sb-proxy-b", port, upstream.port);
    const one = await connect(port);
    const two = await connect(port);
    const closed = Promise.all([once(one, "close"), once(two, "close")]);
    expect(dropRpcConnections("sb-proxy-b")).toBe(2);
    await closed;
    expect(rpcProxyInfo("sb-proxy-b")).toMatchObject({ connections: 0, listening: true });

    const again = await connect(port);
    const reply = once<Buffer>(again, "data");
    again.write("back");
    expect(String(await reply)).toBe("back");
    again.destroy();
    upstream.close();
  });

  it("is idempotent for the same mapping and replaces a changed upstream", async () => {
    const first = await listen((socket) => socket.end("first"));
    const second = await listen((socket) => socket.end("second"));
    const port = await freePort();
    names.push("sb-proxy-c");
    await ensureRpcProxy("sb-proxy-c", port, first.port);
    await ensureRpcProxy("sb-proxy-c", port, first.port);
    expect(rpcProxyInfo("sb-proxy-c")?.upstreamPort).toBe(first.port);
    await ensureRpcProxy("sb-proxy-c", port, second.port);
    const client = await connect(port);
    expect(String(await once<Buffer>(client, "data"))).toBe("second");
    client.destroy();
    first.close();
    second.close();
  });

  it("dropping or closing an unknown proxy is a no-op", () => {
    expect(dropRpcConnections("sb-nothing")).toBe(0);
    expect(rpcProxyInfo("sb-nothing")).toBeNull();
    closeRpcProxy("sb-nothing");
  });
});
