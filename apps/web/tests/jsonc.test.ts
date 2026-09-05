import { describe, expect, it } from "vitest";
import { isJsonc, parseJsonc, stripJsonc } from "@/lib/jsonc";

describe("stripJsonc", () => {
  it("removes line and block comments outside strings", () => {
    const input = '{\n  // a comment\n  "a": 1, /* inline */ "b": "// not a comment"\n}';
    expect(parseJsonc(input)).toEqual({ a: 1, b: "// not a comment" });
  });

  it("removes trailing commas before } and ]", () => {
    expect(parseJsonc('{ "a": [1, 2,], }')).toEqual({ a: [1, 2] });
  });

  it("keeps commas that separate values", () => {
    expect(parseJsonc('{ "a": 1, "b": 2 }')).toEqual({ a: 1, b: 2 });
  });

  it("does not touch escaped quotes inside strings", () => {
    expect(parseJsonc('{ "a": "he said \\"hi\\" // ok" }')).toEqual({ a: 'he said "hi" // ok' });
    expect(stripJsonc('"a\\\\"')).toBe('"a\\\\"');
  });

  it("treats an empty document as valid", () => {
    expect(isJsonc("")).toBe(true);
    expect(isJsonc("   \n // nothing but a comment\n")).toBe(true);
    expect(parseJsonc("")).toBeUndefined();
  });

  it("rejects malformed documents", () => {
    expect(isJsonc('{ "a": ')).toBe(false);
    expect(isJsonc('{ "a" 1 }')).toBe(false);
    expect(isJsonc('{ "a": 1 } trailing')).toBe(false);
  });
});
