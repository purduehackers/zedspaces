/**
 * The rebuild tarball store (b9 §3.19 `stepArchiveWorkspaceDir`, §4.7
 * `manifest.restore`). Vercel Blob in production, signed disk archives for
 * Docker, or an in-process development fixture when no store is attached.
 */
import { BlobNotFoundError, del, head, issueSignedToken, presignUrl, put } from "@vercel/blob";
import { env } from "./env";
import { FileBlobStore } from "./blob-file";

/** What a stored archive reports back to the caller. */
export interface StoredBlob {
  pathname: string;
  bytes: number;
}

/** The narrow blob interface the steps depend on. */
export interface BlobStore {
  /** Uploads `body` privately under `pathname`. */
  put(pathname: string, body: ReadableStream<Uint8Array> | Uint8Array, contentType: string): Promise<StoredBlob>;
  /** Deletes an object; a missing object is success. */
  del(pathname: string): Promise<void>;
  /** Whether an object exists (the builder's log is offered only once its upload landed, b10 §3.10). */
  exists(pathname: string): Promise<boolean>;
  /** A presigned `GET` URL valid for `ttlMs` (the manifest's `restore.tarballUrl`). */
  presignGet(pathname: string, ttlMs: number): Promise<string>;
  /**
   * A presigned `PUT` URL valid for `ttlMs`, scoped to exactly `pathname` and
   * at most `maxBytes` (the builder's log upload, b10 §3.8).
   */
  presignPut(pathname: string, ttlMs: number, maxBytes: number): Promise<string>;
}

async function collect(body: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Wraps a stream so the bytes that pass through it are counted. */
function counting(body: ReadableStream<Uint8Array>): { stream: ReadableStream<Uint8Array>; count: () => number } {
  let total = 0;
  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );
  return { stream, count: () => total };
}

class VercelBlobStore implements BlobStore {
  /**
   * Streams the body straight into a multipart upload: a rebuild archive can
   * be several gigabytes and must never be buffered in the function's memory.
   */
  async put(
    pathname: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    contentType: string,
  ): Promise<StoredBlob> {
    const common = { access: "private" as const, contentType, addRandomSuffix: false, allowOverwrite: true };
    if (body instanceof Uint8Array) {
      await put(pathname, Buffer.from(body), common);
      return { pathname, bytes: body.byteLength };
    }
    const counted = counting(body);
    await put(pathname, counted.stream, { ...common, multipart: true });
    return { pathname, bytes: counted.count() };
  }

  async del(pathname: string): Promise<void> {
    await del(pathname);
  }

  async exists(pathname: string): Promise<boolean> {
    try {
      await head(pathname);
      return true;
    } catch (err) {
      if (err instanceof BlobNotFoundError) return false;
      throw err;
    }
  }

  async presignGet(pathname: string, ttlMs: number): Promise<string> {
    const validUntil = Date.now() + ttlMs;
    const token = await issueSignedToken({ pathname, operations: ["get"], validUntil });
    const { presignedUrl } = await presignUrl(token, { operation: "get", pathname, access: "private" });
    return presignedUrl;
  }

  async presignPut(pathname: string, ttlMs: number, maxBytes: number): Promise<string> {
    const validUntil = Date.now() + ttlMs;
    // Scoped to this one pathname: a prefix-scoped token would let a compromised
    // builder overwrite a `rebuild/<ws>/<ts>.tgz` that D9 restore extracts at `/`.
    const token = await issueSignedToken({ pathname, operations: ["put"], validUntil, maximumSizeInBytes: maxBytes });
    const { presignedUrl } = await presignUrl(token, { operation: "put", pathname, access: "private" });
    return presignedUrl;
  }
}

const MEMORY_KEY = "__zsMemoryBlob" as const;
type GlobalWithBlob = typeof globalThis & { [MEMORY_KEY]?: Map<string, Uint8Array> };

function memoryStore(): Map<string, Uint8Array> {
  const g = globalThis as GlobalWithBlob;
  if (!g[MEMORY_KEY]) g[MEMORY_KEY] = new Map();
  return g[MEMORY_KEY];
}

class MemoryBlobStore implements BlobStore {
  async put(
    pathname: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    _contentType: string,
  ): Promise<StoredBlob> {
    void _contentType;
    const bytes = await collect(body);
    memoryStore().set(pathname, bytes);
    return { pathname, bytes: bytes.byteLength };
  }

  async del(pathname: string): Promise<void> {
    memoryStore().delete(pathname);
  }

  async exists(pathname: string): Promise<boolean> {
    return memoryStore().has(pathname);
  }

  async presignGet(pathname: string, ttlMs: number): Promise<string> {
    const expires = Date.now() + ttlMs;
    return `https://blob.test/${pathname}?expires=${expires}`;
  }

  async presignPut(pathname: string, ttlMs: number, maxBytes: number): Promise<string> {
    const expires = Date.now() + ttlMs;
    return `https://blob.test/put/${pathname}?expires=${expires}&max=${maxBytes}`;
  }
}

let cached: BlobStore | null = null;

/** The configured store: Vercel Blob, or the in-process map when none is attached. */
export function blobStore(): BlobStore {
  if (cached) return cached;
  const e = env();
  const driver = e.ZS_BLOB_DRIVER ?? (e.BLOB_READ_WRITE_TOKEN ? "vercel" : "memory");
  cached = driver === "file" ? new FileBlobStore() : driver === "vercel" ? new VercelBlobStore() : new MemoryBlobStore();
  return cached;
}
