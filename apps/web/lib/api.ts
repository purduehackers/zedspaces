import { ipAddress } from "@vercel/functions";
import { z } from "zod";
import { keys, kv } from "./kv";

/**
 * An error a route handler turns into `{ error: { code, message, details? } }`
 * with the given HTTP status. `headers` (for example `Retry-After`) are added
 * to the response.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly details?: unknown,
    public readonly headers?: Record<string, string>,
  ) {
    super(message ?? code);
    this.name = "ApiError";
  }
}

/** Wire shape of every error body. */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

function withJsonHeaders(init?: ResponseInit): Headers {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  return headers;
}

/** A JSON response (200 unless `init.status` says otherwise). */
export function json<T>(body: T, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { ...init, headers: withJsonHeaders(init) });
}

/** A `202 Accepted` JSON response. */
export function accepted<T>(body: T, init?: ResponseInit): Response {
  return json(body, { ...init, status: 202 });
}

/** A `204 No Content` response. */
export function noContent(init?: ResponseInit): Response {
  return new Response(null, { ...init, status: 204 });
}

/** An error response with body `{ error: { code, message, details? } }`. */
export function error(
  status: number,
  code: string,
  message?: string,
  details?: unknown,
  headers?: Record<string, string>,
): Response {
  const body: ApiErrorBody = { error: { code, message: message ?? code } };
  if (details !== undefined) body.error.details = details;
  return json(body, { status, headers });
}

/** Turns an {@link ApiError} into its response. */
export function errorResponse(err: ApiError): Response {
  return error(err.status, err.code, err.message, err.details, err.headers);
}

/** Default request body ceiling for {@link parseBody}: 1 MiB. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Reads a request body as UTF-8 text, refusing it with
 * `ApiError(413, "payload_too_large")` as soon as more than `maxBytes` have
 * arrived — the declared `Content-Length` is checked first, but a chunked or
 * lying body is cut off while streaming rather than buffered whole.
 */
export async function readBodyText(req: Request, maxBytes: number): Promise<string> {
  const tooLarge = () => new ApiError(413, "payload_too_large", `Body exceeds ${maxBytes} bytes`);
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  const body = req.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Reads and validates a JSON request body. An empty body parses as `{}`.
 * Throws `ApiError(413, "payload_too_large")` above `maxBytes` (default 1 MiB)
 * and `ApiError(400, "invalid_body")` with the zod issues otherwise.
 */
export async function parseBody<S extends z.ZodType>(
  req: Request,
  schema: S,
  opts?: { maxBytes?: number },
): Promise<z.infer<S>> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  const text = await readBodyText(req, maxBytes);
  let raw: unknown;
  try {
    raw = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_body", "Body is not valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(400, "invalid_body", "Body failed validation", { issues: parsed.error.issues });
  }
  return parsed.data;
}

/** Context Next hands a route handler: `params` resolve asynchronously. */
export interface RouteCtx<P> {
  params: Promise<P>;
}

/** A route handler function as Next calls it. */
export type RouteHandler<R extends Request = Request, P = Record<string, never>> = (
  req: R,
  ctx: RouteCtx<P>,
) => Promise<Response>;

/**
 * Wraps a route handler so that an {@link ApiError} becomes its response, a
 * zod error a `400 invalid_body`, and anything else a `500 internal` whose
 * `details.requestId` is also written to the server log. Routes that need
 * `NextRequest` (the Clerk webhook) instantiate `R = NextRequest`.
 */
export function handler<R extends Request = Request, P = Record<string, never>>(
  fn: RouteHandler<R, P>,
): RouteHandler<R, P> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err);
      if (err instanceof z.ZodError) {
        return error(400, "invalid_body", "Validation failed", { issues: err.issues });
      }
      const requestId = globalThis.crypto.randomUUID();
      console.error(`[api] ${requestId} ${req.method} ${new URL(req.url).pathname}`, err);
      return error(500, "internal", "Internal error", { requestId });
    }
  };
}

/** The bearer token of an `Authorization: Bearer …` header, or `null`. */
export function bearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** Best-effort client ip (Vercel headers), or `null`. */
export function clientIp(req: Request): string | null {
  return ipAddress(req) ?? null;
}

/** Cached form of an idempotent response. */
interface CachedResponse {
  status: number;
  body: string;
  contentType: string | null;
}

const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
const IDEMPOTENCY_PENDING_TTL_MS = 60_000;
const PENDING = "__pending__";

/**
 * Honours an `Idempotency-Key` header: the first call runs `fn` and caches a
 * *successful* `{ status, body }` for 24 h under `keys.idem(userId, key)`; a
 * replay returns the cached response; a concurrent duplicate gets
 * `409 idempotency_in_progress`. A refusal (4xx/5xx) is never cached — the
 * condition it reports (`409 image_building`, `402 plan_limit`, …) is
 * transient, so the same key may be retried once it clears. Without the
 * header `fn()` runs as is.
 */
export async function idempotent(req: Request, userId: string, fn: () => Promise<Response>): Promise<Response> {
  const key = req.headers.get("idempotency-key");
  if (!key) return fn();
  if (key.length > 255) throw new ApiError(400, "invalid_idempotency_key", "Idempotency-Key is too long");
  const store = kv();
  const cacheKey = keys.idem(userId, key);
  const acquired = await store.set(cacheKey, PENDING, { nx: true, exMs: IDEMPOTENCY_PENDING_TTL_MS });
  if (!acquired) {
    const cached = await store.get(cacheKey);
    if (cached === null || cached === PENDING) {
      throw new ApiError(409, "idempotency_in_progress", "A request with this Idempotency-Key is still running");
    }
    const replay = JSON.parse(cached) as CachedResponse;
    const headers: Record<string, string> = { "idempotent-replayed": "true" };
    if (replay.contentType) headers["content-type"] = replay.contentType;
    return new Response(replay.status === 204 ? null : replay.body, { status: replay.status, headers });
  }
  let res: Response;
  try {
    res = await fn();
  } catch (err) {
    await store.del(cacheKey);
    throw err;
  }
  if (res.status < 200 || res.status >= 300) {
    await store.del(cacheKey);
    return res;
  }
  const body = await res.clone().text();
  const cached: CachedResponse = { status: res.status, body, contentType: res.headers.get("content-type") };
  await store.set(cacheKey, JSON.stringify(cached), { exMs: IDEMPOTENCY_TTL_MS });
  return res;
}
