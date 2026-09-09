/**
 * Forwarding supervisor logs and client error reports to the external sink
 * (`ZS_LOG_SINK_URL`, BUILD-SPEC §12). Delivery is best effort: a sink outage
 * must never fail a sandbox's request.
 */
import { env } from "./env";
import { scrubSecrets } from "./redact";

/** One record handed to the sink. */
export interface SinkRecord {
  /** `"log"` for a supervisor log batch, `"client_error"` for an error report. */
  kind: "log" | "client_error";
  workspaceId: string | null;
  sandboxName: string;
  /** Build the reporter claims to be (logged, never trusted). */
  build: string | null;
  payload: unknown;
}

/** Applies {@link scrubSecrets} to every string inside a JSON-like value (keys included). */
export function scrubValue<T>(value: T): T {
  if (typeof value === "string") return scrubSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((entry) => scrubValue(entry)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[scrubSecrets(key)] = scrubValue(entry);
    }
    return out as T;
  }
  return value;
}

/**
 * Ships `record` to `ZS_LOG_SINK_URL`, with every known token shape scrubbed
 * from the payload first. Without a configured sink the record is written to
 * the platform log instead. Never throws.
 */
export async function shipToSink(record: SinkRecord): Promise<void> {
  const e = env();
  const scrubbed: SinkRecord = { ...record, payload: scrubValue(record.payload) };
  if (!e.ZS_LOG_SINK_URL) {
    console.log(`[sink:${scrubbed.kind}] ${scrubbed.sandboxName}`, JSON.stringify(scrubbed.payload).slice(0, 4096));
    return;
  }
  try {
    await fetch(e.ZS_LOG_SINK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(e.ZS_LOG_SINK_TOKEN ? { authorization: `Bearer ${e.ZS_LOG_SINK_TOKEN}` } : {}),
      },
      body: JSON.stringify(scrubbed),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    console.warn(`[sink:${record.kind}] delivery failed`, err instanceof Error ? err.message : err);
  }
}
