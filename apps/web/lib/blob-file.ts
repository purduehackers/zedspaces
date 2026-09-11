import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BlobStore } from "./blob";
import { env, requireEnv } from "./env";
import { dockerBackendEnabled } from "./sandbox-docker";

function location(key: string) {
  if (!dockerBackendEnabled()) throw new Error("File archives require the local Docker backend");
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid archive key");
  return path.resolve(env().ZS_DOCKER_ROOT ?? ".zs-dev/docker", "archives", key);
}
const keyOf = (name: string) => createHash("sha256").update(name).digest("hex");
function signature(value: string) {
  return createHmac("sha256", requireEnv("BETTER_AUTH_SECRET").BETTER_AUTH_SECRET).update(value).digest("hex");
}

async function write(key: string, body: ReadableStream<Uint8Array> | Uint8Array, maximum = Infinity) {
  const dest = location(key);
  await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  const temporary = `${dest}.${randomUUID()}.tmp`;
  let bytes = 0;
  const counter = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > maximum ? new Error("Archive exceeds upload limit") : null, chunk);
  } });
  try {
    const stream = body instanceof Uint8Array ? Readable.from([body]) : Readable.fromWeb(body as import("node:stream/web").ReadableStream);
    await pipeline(stream, counter, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    await rename(temporary, dest);
    return bytes;
  } finally { await rm(temporary, { force: true }); }
}

function signedUrl(name: string, method: string, ttl: number, maximum = 0) {
  const query = new URLSearchParams({ key: keyOf(name), method, expires: String(Date.now() + ttl), maximum: String(maximum) });
  query.set("signature", signature(query.toString()));
  return `${requireEnv("ZS_DOCKER_CONTROL_URL").ZS_DOCKER_CONTROL_URL}/sandboxes/local-blobs?${query}`;
}

export class FileBlobStore implements BlobStore {
  async put(name: string, body: ReadableStream<Uint8Array> | Uint8Array) { return { pathname: name, bytes: await write(keyOf(name), body) }; }
  async del(name: string) { await rm(location(keyOf(name)), { force: true }); }
  async exists(name: string) {
    try { return (await stat(location(keyOf(name)))).isFile(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  async presignGet(name: string, ttl: number) { return signedUrl(name, "GET", ttl); }
  async presignPut(name: string, ttl: number, maximum: number) { return signedUrl(name, "PUT", ttl, maximum); }
}

/** Scoped capabilities for supervisor downloads and builder uploads, never a file browser. */
export async function serveLocalBlob(req: Request): Promise<Response> {
  if (!dockerBackendEnabled()) return new Response(null, { status: 404 });
  const query = new URL(req.url).searchParams;
  const supplied = query.get("signature") ?? "";
  query.delete("signature");
  const valid = /^[a-f0-9]{64}$/.test(supplied) && timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(signature(query.toString()), "hex"));
  const expires = Number(query.get("expires"));
  const key = query.get("key") ?? "";
  if (!valid || !Number.isFinite(expires) || expires <= Date.now() || query.get("method") !== req.method || !/^[a-f0-9]{64}$/.test(key)) return new Response(null, { status: 403 });
  if (req.method === "PUT") {
    const maximum = Number(query.get("maximum"));
    if (!req.body || !Number.isSafeInteger(maximum) || maximum <= 0) return new Response(null, { status: 400 });
    try { await write(key, req.body, maximum); }
    catch { return new Response(null, { status: 413 }); }
    return new Response(null, { status: 200 });
  }
  try { await stat(location(key)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Response(null, { status: 404 }); throw error; }
  return new Response(Readable.toWeb(createReadStream(location(key))) as ReadableStream, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
