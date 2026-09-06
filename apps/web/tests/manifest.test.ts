import { beforeEach, describe, expect, it } from "vitest";
import { dbReady } from "@/lib/db";
import { controlPlaneUrl, infraPorts, portPool, proxySlots } from "@/lib/env";
import { buildManifest, blobPathnameFor, sha256FromBlobPathname } from "@/lib/manifest";
import { portAudience } from "@/lib/port-token";
import { requireSandbox } from "@/lib/sandbox-auth";
import { forwards, settingsDocs } from "@/lib/schema";
import { privateForwardUrl } from "@/lib/ports";
import { sandboxManifestSchema } from "@/lib/types";
import { loadManifestFixture, MANIFEST_FIXTURE_PATH } from "./helpers/fixture";
import { FIXTURE, insertWorkspaceWithToken, request, seedFixtures } from "./helpers/routes";

describe("sandbox manifest", () => {
  beforeEach(async () => {
    await seedFixtures();
  });

  it("matches the contract for a workspace principal", async () => {
    const db = await dbReady();
    const { workspace, token } = await insertWorkspaceWithToken({ installedExtensions: ["toml", "html"] });
    await db.insert(settingsDocs).values([
      { userId: FIXTURE.userId, kind: "settings", content: '// user\n{ "theme": "One Dark" }' },
      { userId: FIXTURE.userId, kind: "keymap", content: "[]" },
      {
        userId: FIXTURE.userId,
        kind: "dotfiles",
        content: JSON.stringify({ repoUrl: "https://github.com/route/dotfiles", installCommand: null }),
      },
    ]);
    await db.insert(forwards).values([
      {
        workspaceId: workspace.id,
        port: 3000,
        visibility: "private",
        label: "web",
        url: privateForwardUrl(workspace.id, 3000),
        slot: proxySlots()[0],
      },
      { workspaceId: workspace.id, port: 5173, visibility: "public", label: null, url: null, slot: null },
    ]);

    const principal = await requireSandbox(request("/", { bearer: token }), workspace.sandboxName);
    const manifest = await buildManifest(principal);

    expect(manifest.version).toBe(1);
    expect(manifest.workspaceId).toBe(workspace.id);
    expect(manifest.sandboxName).toBe(workspace.sandboxName);
    expect(manifest.userId).toBe(FIXTURE.userId);
    expect(manifest.build).toBe("test-0");
    expect(manifest.workspaceDir).toBe("/workspaces/api");
    expect(manifest.repo.cloneUrl).toBe("https://github.com/acme/api.git");
    // D8: no shared HMAC key in the manifest any more.
    expect(manifest).not.toHaveProperty("portSessionSecret");
    expect(manifest.jwt.portAudience).toBe(`${manifest.jwt.audience}/ports`);
    expect(manifest.jwt.portAudience).toBe(portAudience(workspace.audience));
    expect(manifest.jwt.publicKeys.length).toBeGreaterThanOrEqual(1);
    for (const pem of manifest.jwt.publicKeys) expect(pem).toContain("PUBLIC KEY");
    expect(manifest.proxySlots).toEqual(proxySlots());
    expect(manifest.proxySlots).toHaveLength(4);
    expect(manifest.portPool).toEqual(portPool());
    expect(manifest.session.capAt).toBeGreaterThan(manifest.session.startedAt);
    expect(manifest.session.id).toBe(workspace.currentSandboxSessionId);
    expect(manifest.allowedOrigins).toEqual([controlPlaneUrl()]);
    expect(manifest.extensions).toEqual(["toml", "html"]);
    expect(manifest.settings?.settings).toContain("One Dark");
    expect(typeof manifest.settings?.keymap).toBe("string");
    expect(manifest.dotfiles?.repoUrl).toBe("https://github.com/route/dotfiles");
    expect(manifest.restore).toBeNull();

    // Names only, never values.
    expect(manifest.secretNames).toEqual([]);
    expect(manifest.devcontainer).toBeNull();
    expect(JSON.stringify(manifest)).not.toContain("npm_supersecret");
    expect(manifest.env).toEqual({ ZS_WORKSPACE_ID: workspace.id, ZS_REGION: "iad1" });

    const infra = new Set(infraPorts());
    for (const forward of manifest.forwards) expect(infra.has(forward.port)).toBe(false);
    for (const port of manifest.portPool) expect(infra.has(port)).toBe(false);
    const priv = manifest.forwards.find((f) => f.visibility === "private");
    expect(priv?.slot).toBe(proxySlots()[0]);
    expect(priv?.url).toContain(`/workspaces/${workspace.id}/ports/3000/open`);
    expect(manifest.forwards.find((f) => f.visibility === "public")?.slot).toBeNull();

    // camelCase only.
    for (const key of Object.keys(manifest)) expect(key).not.toContain("_");
  });

  it("carries a presigned restore url on a rebuilt generation", async () => {
    const sha = "c".repeat(64);
    const pathname = blobPathnameFor("ws_x", 1756800000000, sha);
    expect(sha256FromBlobPathname(pathname)).toBe(sha);
    const { workspace, token } = await insertWorkspaceWithToken({
      restoreKind: "tarball",
      restoreBlobPathname: pathname,
    });
    const principal = await requireSandbox(request("/", { bearer: token }), workspace.sandboxName);
    const manifest = await buildManifest(principal);
    expect(manifest.restore?.sha256).toBe(sha);
    expect(manifest.restore?.tarballUrl.startsWith("https://")).toBe(true);
  });

  it("preserves full history for branch workspaces and pins revision workspaces", async () => {
    const sha = "a".repeat(40);
    const branch = await insertWorkspaceWithToken({ branch: "feature/x", revision: sha });
    const branchManifest = await buildManifest(
      await requireSandbox(request("/", { bearer: branch.token }), branch.workspace.sandboxName),
    );
    expect(branchManifest.repo.revision).toBe("feature/x");
    expect(branchManifest.repo.depth).toBe(0);
    expect(branchManifest.repo.commit).toBe(sha);
    expect(branchManifest.repo.ref).toBeUndefined();

    const pinned = await insertWorkspaceWithToken({ branch: null, revision: sha });
    const pinnedManifest = await buildManifest(
      await requireSandbox(request("/", { bearer: pinned.token }), pinned.workspace.sandboxName),
    );
    expect(pinnedManifest.repo.revision).toBe(sha);
    expect(pinnedManifest.repo.depth).toBe(0);
  });

  it("preserves the shared D19 envelope with the optional builder block disabled", () => {
    // The Rust fixture still exercises legacy devcontainer decoding. Public workspaces send null.
    const fixture = { ...(loadManifestFixture() as Record<string, unknown>), devcontainer: null, secretNames: [] };
    const parsed = sandboxManifestSchema.safeParse(fixture);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [], null, 2)).toBe(true);
    if (!parsed.success) return;
    const manifest = parsed.data;
    expect(manifest.session.capAt).toBeGreaterThan(manifest.session.startedAt);
    expect(manifest.jwt.portAudience).toBe(`${manifest.jwt.audience}/ports`);
    const infra = new Set(infraPorts());
    for (const forward of manifest.forwards) {
      expect(infra.has(forward.port)).toBe(false);
      if (forward.visibility === "private") {
        expect(forward.slot).not.toBeNull();
        expect(forward.url).toContain("/ports/");
      } else {
        expect(forward.slot).toBeNull();
      }
    }
    for (const port of manifest.portPool) expect(infra.has(port)).toBe(false);
    expect(manifest.proxySlots).toHaveLength(4);
    for (const key of Object.keys(manifest)) expect(key).not.toContain("_");
    expect(typeof manifest.settings?.settings).toBe("string");
    expect(MANIFEST_FIXTURE_PATH).toContain("docs/contracts/fixtures/manifest.example.json");
  });

  it("carries repo.ref for a pull-request workspace", async () => {
    const { workspace, token } = await insertWorkspaceWithToken({
      gitRef: "refs/pull/7/head",
      pullRequest: 7,
    });
    const principal = await requireSandbox(request("/", { bearer: token }), workspace.sandboxName);
    const manifest = await buildManifest(principal);
    expect(manifest.repo.ref).toBe("refs/pull/7/head");
    expect(manifest.repo.depth).toBe(0);
  });
});
