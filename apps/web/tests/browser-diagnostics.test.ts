import { EventEmitter } from "node:events";
import type { Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { watchPage } from "./e2e-browser/control-plane";
import { untilOrPanic, waitForHooks } from "./e2e-browser/hooks";

function watchedPage() {
  const events = new EventEmitter();
  const waitForFunction = vi.fn(() => new Promise<never>(() => undefined));
  const page = Object.assign(events, { waitForFunction }) as unknown as Page;
  return { events, page, waitForFunction, log: watchPage(page) };
}

function pageError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

describe("browser WASM trap diagnostics", () => {
  it.each([
    ["Unhandled Promise Rejection", "RuntimeError: Out of bounds memory access (evaluating 'wasm.callback()')"],
    ["Error", "Out of bounds memory access"],
    ["Error", "memory access out of bounds"],
    ["Error", "unreachable"],
    ["RuntimeError", "unreachable"],
    ["RuntimeError", "null function or function signature mismatch"],
    ["RuntimeError", "table index is out of bounds"],
    ["RuntimeError", "integer divide by zero"],
    ["WebAssembly.RuntimeError", "indirect call type mismatch"],
  ])("rejects a pending wait for %s: %s", async (name, message) => {
    const { events, log } = watchedPage();
    const pending = untilOrPanic(new Promise<never>(() => undefined), log);
    const rejected = expect(pending).rejects.toThrow("the page panicked while waiting: pageerror:");
    events.emit("pageerror", pageError(name, message));
    await rejected;
    expect(log.errors).toHaveLength(1);
    expect(log.firstPanic).toContain(message);
    expect(log.onPanic).toEqual([]);
  }, 1_000);

  it("rejects waitForHooks on a WebKit trap without waiting for its navigation timeout", async () => {
    const { events, page, log, waitForFunction } = watchedPage();
    const pending = waitForHooks(page, 180_000, log, 123);
    const rejected = expect(pending).rejects.toThrow("Out of bounds memory access");
    events.emit("pageerror", pageError("Unhandled Promise Rejection", "RuntimeError: Out of bounds memory access"));
    await rejected;
    expect(waitForFunction).toHaveBeenCalledOnce();
    expect(log.onPanic).toEqual([]);
  }, 1_000);

  it("rejects immediately when the trap was reported before the wait began", async () => {
    const { events, log } = watchedPage();
    events.emit("pageerror", pageError("RuntimeError", "memory access out of bounds"));
    await expect(untilOrPanic(new Promise<never>(() => undefined), log)).rejects.toThrow("memory access out of bounds");
    expect(log.onPanic).toEqual([]);
  }, 1_000);

  it("keeps Rust panic detection and reports only the first trap", () => {
    const { events, log } = watchedPage();
    const listener = vi.fn();
    log.onPanic.push(listener);
    events.emit("console", { type: () => "error", text: () => "[zed-web] panic: fixture" });
    events.emit("pageerror", pageError("RuntimeError", "unreachable"));
    expect(log.firstPanic).toBe("[zed-web] panic: fixture");
    expect(listener).toHaveBeenCalledExactlyOnceWith("[zed-web] panic: fixture");
    expect(log.errors).toHaveLength(2);
  });

  it("records connection replacement without mistaking it for a WASM trap", async () => {
    const { events, log } = watchedPage();
    events.emit("console", { type: () => "error", text: () => "remote connection replaced by participant reload" });
    events.emit("pageerror", new Error("fetch failed"));
    expect(log.errors).toHaveLength(2);
    expect(log.firstPanic).toBeNull();
    await expect(untilOrPanic(Promise.resolve("ready"), log)).resolves.toBe("ready");
    expect(log.onPanic).toEqual([]);
  });
});
