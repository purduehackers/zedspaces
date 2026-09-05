import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_INVENTORY, isCompletedInventoryAbort, observeInventoryReader, type FailedRequest, type InventoryRead } from "./e2e-browser/smoke-network";

const origin = "http://127.0.0.1:3210";
const failure: FailedRequest = { method: "GET", url: `${origin}/api/ai/keys`, error: "net::ERR_ABORTED" };
const complete: InventoryRead = { url: failure.url, status: 200, bytes: [...new TextEncoder().encode(EMPTY_INVENTORY)], eof: true, error: null, cancelled: false };

const scope = globalThis as typeof globalThis & { __smokeInventoryReads?: InventoryRead[] };
afterEach(() => {
  vi.unstubAllGlobals();
  delete scope.__smokeInventoryReads;
});

function install(response: Response) {
  Object.defineProperty(response, "url", { value: failure.url });
  vi.stubGlobal("location", { origin });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  observeInventoryReader();
}

describe("actual application reader observer", () => {
  it("does not consume or replace the response, and records only reads made by the application", async () => {
    const response = new Response(EMPTY_INVENTORY);
    install(response);
    const fetched = await fetch(failure.url);
    expect(fetched).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(scope.__smokeInventoryReads).toEqual([{ ...complete, bytes: [], eof: false }]);
    const reader = fetched.body!.getReader();
    expect(await reader.read()).toEqual({ value: new TextEncoder().encode(EMPTY_INVENTORY), done: false });
    expect(scope.__smokeInventoryReads![0].eof).toBe(false);
    expect(await reader.read()).toEqual({ value: undefined, done: true });
    expect(scope.__smokeInventoryReads).toEqual([complete]);
  });

  it("rethrows the original stream error and cannot classify a partial body as complete", async () => {
    const error = new Error("broken stream");
    const response = new Response(new ReadableStream({ start(controller) { controller.error(error); } }));
    install(response);
    const reader = (await fetch(failure.url)).body!.getReader();
    await expect(reader.read()).rejects.toBe(error);
    expect(scope.__smokeInventoryReads![0]).toMatchObject({ eof: false, error: "Error: broken stream" });
    expect(isCompletedInventoryAbort(failure, origin, 1, scope.__smokeInventoryReads!)).toBe(false);
  });

  it("does not mistake cancellation-induced done:true for the server's EOF", async () => {
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(EMPTY_INVENTORY)); },
    }));
    install(response);
    const reader = (await fetch(failure.url)).body!.getReader();
    await reader.read();
    const pending = reader.read();
    await reader.cancel();
    expect(await pending).toEqual({ value: undefined, done: true });
    expect(scope.__smokeInventoryReads).toEqual([{ ...complete, cancelled: true }]);
    expect(isCompletedInventoryAbort(failure, origin, 1, scope.__smokeInventoryReads!)).toBe(false);
  });

  it("records body cancellation and an aborted fetch signal", async () => {
    const response = new Response(EMPTY_INVENTORY);
    install(response);
    const controller = new AbortController();
    await fetch(failure.url, { signal: controller.signal });
    controller.abort();
    expect(scope.__smokeInventoryReads![0].cancelled).toBe(true);
    scope.__smokeInventoryReads![0].cancelled = false;
    await response.body!.cancel();
    expect(scope.__smokeInventoryReads![0].cancelled).toBe(true);
  });
});

describe("smoke completed-reader evidence", () => {
  it("classifies only the proved Chromium inventory event artifact", () => {
    expect(isCompletedInventoryAbort(failure, origin, 1, [complete])).toBe(true);
  });
  it.each([
    { eof: false }, { error: "TypeError: Failed to fetch" }, { status: 500 },
    { bytes: complete.bytes.slice(0, -1) }, { bytes: [...complete.bytes, 32] }, { url: `${origin}/other` }, { cancelled: true },
  ])("does not excuse incomplete or errored application reads: %j", (change) => {
    expect(isCompletedInventoryAbort(failure, origin, 1, [{ ...complete, ...change }])).toBe(false);
  });
  it.each([
    { method: "POST" }, { url: `${origin}/other` }, { url: "https://other.test/api/ai/keys" },
    { error: "net::ERR_CONNECTION_RESET" },
  ])("does not excuse another request or error: %j", (change) => {
    expect(isCompletedInventoryAbort({ ...failure, ...change }, origin, 1, [complete])).toBe(false);
  });
  it("rejects missing or ambiguous reader/request evidence", () => {
    expect(isCompletedInventoryAbort(failure, origin, 1, [])).toBe(false);
    expect(isCompletedInventoryAbort(failure, origin, 2, [complete])).toBe(false);
    expect(isCompletedInventoryAbort(failure, origin, 1, [complete, complete])).toBe(false);
  });
});
