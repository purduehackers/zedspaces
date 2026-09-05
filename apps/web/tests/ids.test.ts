import { describe, expect, it } from "vitest";
import {
  newConnectId,
  newId,
  newJti,
  newSandboxName,
  newSandboxToken,
  REPO_ID_RE,
  SANDBOX_NAME_RE,
  sha256Hex,
  timingSafeEqualHex,
  timingSafeEqualString,
  WORKSPACE_ID_RE,
} from "@/lib/ids";

describe("ids", () => {
  it("new_id_shapes", () => {
    const ws = newId("ws");
    expect(WORKSPACE_ID_RE.test(ws)).toBe(true);
    expect(REPO_ID_RE.test(newId("repo"))).toBe(true);
    expect(newConnectId().startsWith("con_")).toBe(true);
    expect(newId("ws")).not.toBe(ws);
    expect(newJti().length).toBeGreaterThanOrEqual(22);
  });

  it("sandbox_names_are_valid_and_stable", () => {
    const ws = newId("ws");
    const name = newSandboxName(ws, 1);
    expect(SANDBOX_NAME_RE.test(name)).toBe(true);
    expect(name).toBe(newSandboxName(ws, 1));
    expect(newSandboxName(ws, 2)).not.toBe(name);
    expect(name.startsWith("sb-dev-")).toBe(true); // VERCEL_ENV unset in tests
    expect(SANDBOX_NAME_RE.test("pb-retired")).toBe(false);
    expect(SANDBOX_NAME_RE.test("ib-retired")).toBe(false);
  });

  it("sandbox_tokens_hash_and_compare", () => {
    const { token, hash } = newSandboxToken();
    expect(token.startsWith("zsb_")).toBe(true);
    expect(hash).toBe(sha256Hex(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(timingSafeEqualHex(hash, sha256Hex(token))).toBe(true);
    expect(timingSafeEqualHex(hash, sha256Hex(`${token}x`))).toBe(false);
    expect(timingSafeEqualHex(hash, "")).toBe(false);
    expect(timingSafeEqualHex(hash, "zz")).toBe(false);
    expect(newSandboxToken().token).not.toBe(token);
  });

  it("timing_safe_string_compare", () => {
    expect(timingSafeEqualString("abc", "abc")).toBe(true);
    expect(timingSafeEqualString("abc", "abd")).toBe(false);
    expect(timingSafeEqualString("abc", "abcd")).toBe(false);
    expect(timingSafeEqualString("", "")).toBe(true);
  });
});
