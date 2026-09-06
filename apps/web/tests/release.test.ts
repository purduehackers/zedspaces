import { afterEach, describe, expect, it, vi } from "vitest";
import { configure, releaseValues } from "../scripts/release";

const repository = "vcr.vercel.com/purdue-hackers/zedspaces/zs-workspace";
const build = "abcdef123-12345.1";
const image = { build, tag: `${repository}:${build}`, digest: `sha256:${"a".repeat(64)}` };
afterEach(() => vi.unstubAllEnvs());

describe("release identity", () => {
  it("pins only the current matching client/server and immutable image", () => {
    const values = releaseValues(build, image, repository);
    expect(values.ZS_CLIENT_BUILD_ID).toBe(build);
    expect(values.ZS_SERVER_BUILD_ID).toBe(build);
    expect(values.ZS_IMAGE_REF).toBe(`${repository}@${image.digest}`);
    expect(values.ZS_EDITOR_BUNDLES).toBe(build);
    expect(values.ZS_EDITOR_BUNDLES_KEEP).toBe("1");
  });

  it("rejects mismatched builds, repositories, and mutable image references", () => {
    for (const patch of [{ build: "other-1" }, { tag: `${repository}:latest` }, { digest: "latest" }]) {
      expect(() => releaseValues(build, { ...image, ...patch }, repository)).toThrow();
    }
    expect(() => releaseValues(build, image, "vcr.vercel.com/somewhere/else/zs-workspace")).toThrow();
  });
  it("rejects development/debug/test builds", () => {
    for (const id of ["dev-0", "abc-1-test", "abc-1-names", "../unsafe"]) {
      expect(() => releaseValues(id, { ...image, build: id, tag: `${repository}:${id}` }, repository)).toThrow();
    }
  });
  it("changes only release pins and restores old values after a partial configuration failure", () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "project-1");
    const values = releaseValues(build, image, repository);
    const previous = { ZS_CLIENT_BUILD_ID: "old-1", ZS_SERVER_BUILD_ID: "old-1", ZS_IMAGE_REF: `${repository}@sha256:${"b".repeat(64)}`,
      ZS_EDITOR_BUNDLES: "old-1", ZS_EDITOR_BUNDLES_KEEP: null };
    const record = { build, values, previous, assetSha256: "test" };
    const entries = Object.keys(values).map(key => ({ key, id: key, target: ["production"] }));
    let writes = 0;
    const request = vi.fn((endpoint: string, method?: string, body?: unknown) => {
      if (!method) return { envs: entries };
      if (++writes === 2) throw new Error("simulated partial update");
      return { endpoint, method, body };
    });
    expect(() => configure(record, false, request)).toThrow("simulated partial update");
    configure(record, true, request);
    for (const [key, value] of Object.entries(previous)) {
      if (value === null) expect(request).toHaveBeenCalledWith(`/v9/projects/project-1/env/${key}`, "DELETE");
      else expect(request).toHaveBeenCalledWith(`/v9/projects/project-1/env/${key}`, "PATCH", { key, value, type: "encrypted", target: ["production"] });
    }
    expect(request.mock.calls.some(call => JSON.stringify(call).includes("TURSO"))).toBe(false);
  });
});
