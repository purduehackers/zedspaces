import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, bearer, error, handler, idempotent, json, noContent, parseBody, readBodyText } from "@/lib/api";
import { scrubSecrets, scrubValue } from "@/lib/log-sink";
import { limit } from "@/lib/ratelimit";
import { keys, kv, withLock } from "@/lib/kv";

function req(method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://zs.test/api/x", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("api helpers", () => {
  it("json_and_error_bodies", async () => {
    const ok = json({ a: 1 });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/application\/json/);
    expect(await ok.json()).toEqual({ a: 1 });

    const err = error(409, "conflict", "nope", { x: 1 }, { "Retry-After": "3" });
    expect(err.status).toBe(409);
    expect(err.headers.get("retry-after")).toBe("3");
    expect(await err.json()).toEqual({ error: { code: "conflict", message: "nope", details: { x: 1 } } });
    expect(noContent().status).toBe(204);
  });

  it("parse_body_validates_and_limits", async () => {
    const schema = z.object({ port: z.number().int() });
    expect(await parseBody(req("POST", { port: 3000 }), schema)).toEqual({ port: 3000 });
    expect(await parseBody(req("POST", ""), z.object({}))).toEqual({});

    await expect(parseBody(req("POST", { port: "x" }), schema)).rejects.toMatchObject({ status: 400, code: "invalid_body" });
    await expect(parseBody(req("POST", "{oops"), schema)).rejects.toMatchObject({ status: 400, code: "invalid_body" });
    await expect(parseBody(req("POST", { port: 1 }), schema, { maxBytes: 4 })).rejects.toMatchObject({
      status: 413,
      code: "payload_too_large",
    });
  });

  it("parse_body_cuts_a_chunked_body_off_at_the_ceiling", async () => {
    // No Content-Length: the body streams in and is refused as soon as it passes the limit.
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 1_000) controller.close();
        else controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
      },
    });
    const request = new Request("https://zs.test/api/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    await expect(readBodyText(request, 4096)).rejects.toMatchObject({ status: 413, code: "payload_too_large" });
    expect(pulled).toBeLessThan(20);
    // The declared length short-circuits before any read.
    await expect(
      readBodyText(new Request("https://zs.test/api/x", { method: "POST", headers: { "content-length": "999999" } }), 10),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("idempotent_never_caches_a_refusal", async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return calls === 1 ? error(409, "image_building") : json({ call: calls }, { status: 202 });
    };
    const first = await idempotent(req("POST", {}, { "idempotency-key": "ghi" }), "user_test", fn);
    expect(first.status).toBe(409);
    const second = await idempotent(req("POST", {}, { "idempotency-key": "ghi" }), "user_test", fn);
    expect(second.status).toBe(202);
    expect(second.headers.get("idempotent-replayed")).toBeNull();
    const third = await idempotent(req("POST", {}, { "idempotency-key": "ghi" }), "user_test", fn);
    expect(third.headers.get("idempotent-replayed")).toBe("true");
    expect(calls).toBe(2);
  });

  it("log_sink_scrubs_token_shapes", () => {
    const jwt = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.c2lnbmF0dXJlc2lnbmF0dXJl";
    const line = [
      "clone failed https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123@github.com/acme/api.git",
      "bearer zsb_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd",
      `token ${jwt}`,
      "github_pat_11AAAAAAA0bbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "?zs_port_token=v1.abcdefghijklmnop.qrstuvwxyz012345&next=/",
    ].join(" ");
    const scrubbed = scrubSecrets(line);
    expect(scrubbed).not.toContain("ghs_abcdefghijklmnopqrstuvwxyz0123");
    expect(scrubbed).not.toContain("zsb_AbCd");
    expect(scrubbed).not.toContain(jwt);
    expect(scrubbed).not.toContain("github_pat_11AAAAAAA0bbbb");
    expect(scrubbed).not.toContain("v1.abcdefghijklmnop.qrstuvwxyz012345");
    expect(scrubbed).toContain("[redacted]");
    expect(scrubValue({ entries: [{ msg: line, fields: { stack: line } }] })).toEqual({
      entries: [{ msg: scrubbed, fields: { stack: scrubbed } }],
    });
  });

  it("handler_maps_errors", async () => {
    const ctx = { params: Promise.resolve({}) };
    const throwsApi = handler(async () => {
      throw new ApiError(423, "workspace_busy", "busy", { state: "stopping" });
    });
    const res = await throwsApi(req("GET"), ctx);
    expect(res.status).toBe(423);
    expect(await res.json()).toEqual({ error: { code: "workspace_busy", message: "busy", details: { state: "stopping" } } });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwsUnknown = handler(async () => {
      throw new Error("secret detail");
    });
    const internal = await throwsUnknown(req("GET"), ctx);
    expect(internal.status).toBe(500);
    const body = await internal.json();
    expect(body.error.code).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("secret detail");
    expect(typeof body.error.details.requestId).toBe("string");
    spy.mockRestore();

    const passes = handler(async () => json({ ok: true }));
    expect((await passes(req("GET"), ctx)).status).toBe(200);
  });

  it("bearer_header", () => {
    expect(bearer(req("GET", undefined, { authorization: "Bearer zsb_abc" }))).toBe("zsb_abc");
    expect(bearer(req("GET", undefined, { authorization: "bearer   zsb_abc " }))).toBe("zsb_abc");
    expect(bearer(req("GET", undefined, { authorization: "Basic xyz" }))).toBeNull();
    expect(bearer(req("GET"))).toBeNull();
  });

  it("idempotent_replays_the_first_response", async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return json({ call: calls }, { status: 202 });
    };
    const first = await idempotent(req("POST", {}, { "idempotency-key": "abc" }), "user_test", fn);
    const second = await idempotent(req("POST", {}, { "idempotency-key": "abc" }), "user_test", fn);
    expect(calls).toBe(1);
    expect(second.status).toBe(202);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(await first.json()).toEqual({ call: 1 });
    expect(await second.json()).toEqual({ call: 1 });

    // Another user with the same key runs independently; no header runs every time.
    await idempotent(req("POST", {}, { "idempotency-key": "abc" }), "user_other", fn);
    await idempotent(req("POST", {}), "user_test", fn);
    expect(calls).toBe(3);

    // A failed first call does not poison the key.
    let failing = 0;
    const fails = async () => {
      failing += 1;
      if (failing === 1) throw new ApiError(500, "internal");
      return json({ failing });
    };
    await expect(idempotent(req("POST", {}, { "idempotency-key": "def" }), "user_test", fails)).rejects.toBeInstanceOf(ApiError);
    const recovered = await idempotent(req("POST", {}, { "idempotency-key": "def" }), "user_test", fails);
    expect(await recovered.json()).toEqual({ failing: 2 });
  });

  it("memory_kv_lock_and_ratelimit", async () => {
    const store = kv();
    expect(await store.set("k", "1", { nx: true })).toBe(true);
    expect(await store.set("k", "2", { nx: true })).toBe(false);
    expect(await store.get("k")).toBe("1");
    expect(await store.incr("c", 60_000)).toBe(1);
    expect(await store.incr("c")).toBe(2);
    expect(await store.mget(["k", "c", "missing"])).toEqual(["1", "2", null]);
    await store.set("ttl", "x", { exMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await store.get("ttl")).toBeNull();

    const results = await Promise.all([
      withLock(keys.lock("t"), 10_000, async () => "a"),
      withLock(keys.lock("t"), 10_000, async () => "b"),
    ]);
    expect(results.filter((r) => r !== undefined)).toHaveLength(1);
    expect(await withLock(keys.lock("t"), 10_000, async () => "c")).toBe("c");

    for (let i = 0; i < 10; i += 1) await limit("sandbox.activity", "sb-x");
    await expect(limit("sandbox.activity", "sb-x")).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    await limit("sandbox.activity", "sb-y");
  });
});
