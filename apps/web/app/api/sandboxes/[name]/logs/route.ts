import { ApiError, handler, noContent, readBodyText, type RouteCtx } from "@/lib/api";
import { shipToSink } from "@/lib/log-sink";
import { principalSubjectId } from "@/lib/sandbox-auth";
import { requireSandboxParam, type SandboxParams } from "@/lib/sandbox-request";
import { logBatch, logLineNdjson, logSourceAllowed, type LogBatch, type LogEntry } from "@/lib/types";

export const runtime = "nodejs";

/** b8 §3.6 constants: at most 200 entries and 256 KiB per batch. */
const MAX_BATCH_BYTES = 256 * 1024;
/** See {@link MAX_BATCH_BYTES}. */
const MAX_ENTRIES = 200;

function tooLarge(): never {
  throw new ApiError(413, "payload_too_large", `Log batches are at most ${MAX_BATCH_BYTES} bytes`);
}

/** Parses the NDJSON body b8 sends today, mapping each line's `target` to `source`. */
function parseNdjson(text: string): LogEntry[] {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length > MAX_ENTRIES) tooLarge();
  const entries: LogEntry[] = [];
  for (const line of lines) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new ApiError(400, "invalid_body", "One NDJSON line is not valid JSON");
    }
    const parsed = logLineNdjson.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(400, "invalid_body", "One NDJSON line failed validation", {
        issues: parsed.error.issues,
      });
    }
    const { target, ...rest } = parsed.data;
    entries.push({ ...rest, source: target });
  }
  return entries;
}

function parseJsonBatch(text: string): LogBatch {
  let raw: unknown;
  try {
    raw = text.trim() === "" ? { entries: [] } : JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_body", "Body is not valid JSON");
  }
  const parsed = logBatch.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(400, "invalid_body", "Body failed validation", { issues: parsed.error.issues });
  }
  return parsed.data;
}

/**
 * `POST /api/sandboxes/{name}/logs` – the supervisor's log shipper (b9 §4.2).
 * Accepts the JSON `LogBatch` and the NDJSON stream b8 sends today; the
 * bearer already names the sandbox, so the batch's identity fields are
 * optional and never trusted.
 */
export const POST = handler(async (req: Request, ctx: RouteCtx<SandboxParams>) => {
  const principal = await requireSandboxParam(req, ctx, "sandbox.logs");
  // Streams and cuts the body off past the ceiling instead of buffering it whole.
  const text = await readBodyText(req, MAX_BATCH_BYTES);

  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  const isNdjson = contentType.includes("ndjson");
  const batch: LogBatch = isNdjson ? { entries: parseNdjson(text) } : parseJsonBatch(text);
  if (batch.entries.length > MAX_ENTRIES) tooLarge();
  // CONTRACTS §7.6 (b10 §3.17): a builder may only report `builder`; a
  // supervisor the b8 sources plus `services`.
  const refused = batch.entries.find((entry) => !logSourceAllowed(entry.source, principal.kind));
  if (refused) {
    throw new ApiError(400, "invalid_body", `Log source ${refused.source} is not allowed for this principal`);
  }

  await shipToSink({
    kind: "log",
    workspaceId: principalSubjectId(principal),
    sandboxName: principal.sandboxName,
    build: req.headers.get("x-zs-build"),
    payload: batch,
  });
  return noContent();
});
