/** Evidence from the application's actual reader, not a cloned/independently read body. */
export interface InventoryRead {
  url: string;
  status: number;
  bytes: number[];
  eof: boolean;
  error: string | null;
  cancelled: boolean;
}

export interface FailedRequest {
  method: string;
  url: string;
  error: string;
}

export const EMPTY_INVENTORY = '{"providers":[]}';

/** Passed to addInitScript: deliberately self-contained for browser serialization. */
export function observeInventoryReader() {
  const scope = globalThis as typeof globalThis & { __smokeInventoryReads: InventoryRead[] };
  scope.__smokeInventoryReads = [];
  const fetch = scope.fetch;
  scope.fetch = async function (...args) {
    const response = await Reflect.apply(fetch, this, args);
    if (response.url !== `${location.origin}/api/ai/keys`) return response;
    const observed: InventoryRead = { url: response.url, status: response.status, bytes: [], eof: false, error: null, cancelled: false };
    scope.__smokeInventoryReads.push(observed);
    const signal = args[1]?.signal ?? (args[0] instanceof Request ? args[0].signal : null);
    if (signal) {
      observed.cancelled = signal.aborted;
      signal.addEventListener("abort", () => { observed.cancelled = true; }, { once: true });
    }
    const body = response.body;
    if (!body) return response;
    const cancelBody = body.cancel;
    body.cancel = function (reason) {
      observed.cancelled = true;
      return Reflect.apply(cancelBody, this, [reason]);
    };
    const getReader = body.getReader;
    body.getReader = function (this: ReadableStream<Uint8Array>, ...readerArgs: unknown[]) {
      const reader = Reflect.apply(getReader, this, readerArgs) as ReadableStreamDefaultReader<Uint8Array>;
      const cancelReader = reader.cancel;
      reader.cancel = function (reason) {
        observed.cancelled = true;
        return Reflect.apply(cancelReader, this, [reason]);
      };
      const read = reader.read;
      reader.read = async function () {
        try {
          const result = await Reflect.apply(read, this, []);
          if (result.value) {
            // Bound diagnostic storage; an unexpected large response cannot pass the assertion.
            if (observed.bytes.length + result.value.byteLength > 1024) observed.error = "inventory exceeds fixture limit";
            else observed.bytes.push(...result.value);
          }
          if (result.done) observed.eof = true;
          return result;
        } catch (error) {
          observed.error = String(error);
          throw error;
        }
      };
      return reader;
    } as typeof body.getReader;
    return response;
  };
}

/**
 * Chromium 151 emits ERR_ABORTED for a stream read through EOF (also reproduced without
 * WASM). Only this exact single inventory request may be classified as that event artifact,
 * and only after the actual application reader consumed the expected bytes and true EOF.
 */
export function isCompletedInventoryAbort(
  failure: FailedRequest,
  origin: string,
  requestCount: number,
  reads: InventoryRead[],
): boolean {
  if (failure.method !== "GET" || failure.url !== `${origin}/api/ai/keys` || failure.error !== "net::ERR_ABORTED") return false;
  if (requestCount !== 1 || reads.length !== 1) return false;
  const read = reads[0];
  return read.url === failure.url && read.status === 200 && read.eof && read.error === null && !read.cancelled
    && new TextDecoder().decode(new Uint8Array(read.bytes)) === EMPTY_INVENTORY;
}
