import { afterEach, describe, expect, it } from "vitest";
import {
  _resetEnvForTests,
  controlApiBase,
  controlPlaneUrl,
  env,
  EnvError,
  envTag,
  infraPorts,
  isInfraPort,
  isTestClientBuild,
  refusesTestClientBuild,
  portPool,
  proxySlots,
  requireEnv,
} from "@/lib/env";

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetEnvForTests();
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetEnvForTests();
  }
}

describe("env", () => {
  afterEach(() => _resetEnvForTests());

  it("applies_the_d21_port_map_by_default", () => {
    expect(env().ZS_RPC_PORT).toBe(8443);
    expect(proxySlots()).toEqual([8444, 8445, 8446, 8447]);
    expect(env().ZS_HEALTH_PORT).toBe(8448);
    expect(portPool()).toEqual([3000, 3001, 4000, 5000, 5173, 8000, 8080, 8888]);
    expect(infraPorts()).toEqual([8443, 8444, 8445, 8446, 8447, 8448, 8449, 8450, 8451]);
    expect(isInfraPort(8450)).toBe(true);
    expect(isInfraPort(3000)).toBe(false);
  });

  it("proxy_slots_validation", () => {
    withEnv({ ZS_PROXY_SLOTS: "8444,8445,8446" }, () => expect(() => proxySlots()).toThrow(EnvError));
    withEnv({ ZS_PROXY_SLOTS: "8444,8445,8446,8447,8449" }, () => expect(() => proxySlots()).toThrow(/four/));
    withEnv({ ZS_PROXY_SLOTS: "8443,8445,8446,8447" }, () => expect(() => proxySlots()).toThrow(/rpc/));
    withEnv({ ZS_PROXY_SLOTS: "8444,8445,8446,8448" }, () => expect(() => proxySlots()).toThrow(/health/));
    withEnv({ ZS_PROXY_SLOTS: "3000,8445,8446,8447" }, () => expect(() => proxySlots()).toThrow(/ZS_PORT_POOL/));
    withEnv({ ZS_PROXY_SLOTS: "8444,8444,8446,8447" }, () => expect(() => proxySlots()).toThrow(/four/));
    withEnv({ ZS_PORT_POOL: "3000,8449" }, () => expect(() => portPool()).toThrow(/infrastructure/));
  });

  it("control_urls", () => {
    expect(controlApiBase()).toBe("https://zs.test/api");
    expect(controlPlaneUrl()).toBe("https://zs.test");
    withEnv({ ZS_CONTROL_URL: "https://zs.example.com/api/" }, () => {
      expect(controlApiBase()).toBe("https://zs.example.com/api");
      expect(controlPlaneUrl()).toBe("https://zs.example.com");
    });
    withEnv({ ZS_CONTROL_URL: undefined, VERCEL_URL: "web-abc.vercel.app" }, () => {
      expect(controlApiBase()).toBe("https://web-abc.vercel.app/api");
      expect(controlPlaneUrl()).toBe("https://web-abc.vercel.app");
    });
    withEnv({ ZS_CONTROL_URL: undefined, VERCEL_URL: undefined }, () => expect(() => controlApiBase()).toThrow(EnvError));
  });

  it("env_tag_and_require_env", () => {
    expect(envTag()).toBe("development");
    withEnv({ VERCEL_ENV: "preview" }, () => expect(envTag()).toBe("preview"));
    expect(requireEnv("ZS_JWT_KID").ZS_JWT_KID).toBe("k1");
    withEnv({ CRON_SECRET: undefined, ZS_JWT_PRIVATE_KEY: undefined }, () => {
      let caught: unknown;
      try {
        requireEnv("CRON_SECRET", "ZS_JWT_PRIVATE_KEY", "ZS_JWT_KID");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(EnvError);
      expect((caught as EnvError).missing).toEqual(["CRON_SECRET", "ZS_JWT_PRIVATE_KEY"]);
    });
  });

  it("rejects_invalid_values_and_treats_empty_as_unset", () => {
    withEnv({ ZS_KV: "redis" }, () => expect(() => env()).toThrow(/ZS_KV/));
    withEnv({ CRON_SECRET: "" }, () => expect(env().CRON_SECRET).toBeUndefined());
    withEnv({ ZS_SESSION_CAP_MS: "1000" }, () => expect(env().ZS_SESSION_CAP_MS).toBe(1000));
  });

  it("refuses_a_test_hooks_client_build_in_production", () => {
    expect(isTestClientBuild("c3cf80c0d-42-test")).toBe(true);
    expect(isTestClientBuild("c3cf80c0d-42-test-names")).toBe(true);
    expect(isTestClientBuild("c3cf80c0d-42")).toBe(false);
    expect(isTestClientBuild(undefined)).toBe(false);
    // Development keeps serving it (scripts/dev-local.sh browser).
    withEnv({ ZS_CLIENT_BUILD_ID: "c3cf80c0d-42-test", NODE_ENV: "test", VERCEL_ENV: undefined, ZS_ALLOW_TEST_BUNDLE: undefined }, () =>
      expect(env().ZS_CLIENT_BUILD_ID).toBe("c3cf80c0d-42-test"),
    );
    for (const production of [{ NODE_ENV: "production" }, { VERCEL_ENV: "production" }]) {
      withEnv({ ZS_CLIENT_BUILD_ID: "c3cf80c0d-42-test", NODE_ENV: "test", VERCEL_ENV: undefined, ZS_ALLOW_TEST_BUNDLE: undefined, ...production }, () => {
        let caught: unknown;
        try {
          env();
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(EnvError);
        expect((caught as EnvError).missing).toEqual(["ZS_CLIENT_BUILD_ID"]);
        expect((caught as EnvError).message).toMatch(/test-hooks bundle/);
      });
      withEnv({ ZS_CLIENT_BUILD_ID: "c3cf80c0d-42", NODE_ENV: "test", VERCEL_ENV: undefined, ...production }, () =>
        expect(env().ZS_CLIENT_BUILD_ID).toBe("c3cf80c0d-42"),
      );
      withEnv({ ZS_CLIENT_BUILD_ID: "c3cf80c0d-42-test", NODE_ENV: "test", VERCEL_ENV: undefined, ZS_ALLOW_TEST_BUNDLE: "1", ...production }, () =>
        expect(env().ZS_CLIENT_BUILD_ID).toBe("c3cf80c0d-42-test"),
      );
    }
  });

  // The workspace row's build, not `ZS_CLIENT_BUILD_ID`, is what the editor document loads: a row
  // stamped `-test` (a test deployment, a shared database) must be refused there too.
  it("refuses_a_test_hooks_workspace_build_where_the_bundle_is_chosen", () => {
    const development = { ZS_CLIENT_BUILD_ID: "c3cf80c0d-42", NODE_ENV: "test", VERCEL_ENV: undefined, ZS_ALLOW_TEST_BUNDLE: undefined };
    withEnv(development, () => {
      expect(refusesTestClientBuild("c3cf80c0d-42-test")).toBe(false);
      expect(refusesTestClientBuild("c3cf80c0d-42")).toBe(false);
    });
    for (const production of [{ NODE_ENV: "production" }, { VERCEL_ENV: "production" }]) {
      withEnv({ ...development, ...production }, () => {
        expect(refusesTestClientBuild("c3cf80c0d-42-test")).toBe(true);
        expect(refusesTestClientBuild("c3cf80c0d-42-test-names")).toBe(true);
        expect(refusesTestClientBuild("c3cf80c0d-42")).toBe(false);
        expect(refusesTestClientBuild(undefined)).toBe(false);
      });
      withEnv({ ...development, ...production, ZS_ALLOW_TEST_BUNDLE: "1" }, () =>
        expect(refusesTestClientBuild("c3cf80c0d-42-test")).toBe(false),
      );
    }
  });
});
