/**
 * Unit tests of `lib/dev-auth.ts`: the loopback binding of dev-mode auth
 * (`ZS_AUTH_MODE=dev`). Kept beside the native end-to-end suite that also
 * exercises it against the live dev server (`flow.test.ts` step 0); `pnpm
 * test` runs it like every other `tests/**` file.
 */
import { describe, expect, it } from "vitest";
import { devRequestRefusal, isLoopbackHost } from "@/lib/dev-auth";

describe("isLoopbackHost", () => {
  it("accepts localhost, 127.0.0.0/8 and ::1, with or without a port", () => {
    for (const host of ["localhost", "localhost:3100", "127.0.0.1", "127.0.0.1:3100", "127.1.2.3:80", "[::1]", "[::1]:3100"]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it("refuses every other name, an empty header and garbage", () => {
    for (const host of ["attacker.example:3100", "10.0.0.5:3000", "192.168.1.20", "localhost.attacker.example", "0.0.0.0:3100", "", "[::]:3100", "::1:3100:x"]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
    expect(isLoopbackHost(null)).toBe(false);
  });
});

describe("devRequestRefusal", () => {
  it("accepts a loopback request without fetch metadata (curl, node fetch, the e2e suite)", () => {
    expect(devRequestRefusal(new Headers({ host: "127.0.0.1:3100" }))).toBeNull();
    expect(devRequestRefusal(new Headers({ host: "localhost:3100" }))).toBeNull();
  });

  it("accepts a browser's own navigations and same-origin fetches, form posts and server actions", () => {
    expect(devRequestRefusal(new Headers({ host: "127.0.0.1:3100", "sec-fetch-site": "none" }))).toBeNull();
    expect(
      devRequestRefusal(
        new Headers({ host: "127.0.0.1:3100", "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:3100" }),
      ),
    ).toBeNull();
    expect(devRequestRefusal(new Headers({ host: "[::1]:3100", origin: "http://[::1]:3100" }))).toBeNull();
  });

  it("refuses a foreign or missing Host (a LAN peer, DNS rebinding)", () => {
    expect(devRequestRefusal(new Headers({ host: "attacker.example:3100" }))).toMatch(/loopback/);
    expect(devRequestRefusal(new Headers({ host: "192.168.1.20:3000" }))).toMatch(/loopback/);
    expect(devRequestRefusal(new Headers({}))).toMatch(/loopback/);
  });

  it("refuses cross-site and same-site fetches (another site, another port on localhost)", () => {
    expect(devRequestRefusal(new Headers({ host: "127.0.0.1:3100", "sec-fetch-site": "cross-site" }))).toMatch(/cross-site/);
    expect(devRequestRefusal(new Headers({ host: "localhost:3100", "sec-fetch-site": "same-site" }))).toMatch(/same-site/);
  });

  it("refuses an Origin that is not the loopback origin itself", () => {
    expect(devRequestRefusal(new Headers({ host: "localhost:3100", origin: "http://localhost:4000" }))).toMatch(/origin/);
    expect(devRequestRefusal(new Headers({ host: "localhost:3100", origin: "https://attacker.example" }))).toMatch(/origin/);
    expect(devRequestRefusal(new Headers({ host: "localhost:3100", origin: "null" }))).toMatch(/origin/);
    expect(devRequestRefusal(new Headers({ host: "127.0.0.1:3100", origin: "http://localhost:3100" }))).toMatch(/origin/);
  });
});
