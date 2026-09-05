/**
 * The document `zs-agent` fetches at boot (b9 §4.7, CONTRACTS.md §7.3). It
 * carries names, not secret values: the values reach the sandbox only as the
 * supervisor's `runCommand` environment (b9 §3.18).
 */
import { and, eq, inArray } from "drizzle-orm";
import { sha256FromBlobPathname } from "./archive";
import { blobStore } from "./blob";
import { dbReady } from "./db";
import { controlPlaneUrl, env, portPool, proxySlots } from "./env";
import { cloneUrl } from "./github";
import { portAudience } from "./port-token";
import type { SandboxPrincipal } from "./sandbox-auth";
import { repos, settingsDocs, type Repo, type Workspace } from "./schema";
import { loadSigningKeys, publicKeyPems } from "./tokens";
import type { SandboxManifest } from "./types";
import { forwardViews } from "./views";

export { blobPathnameFor, sha256FromBlobPathname } from "./archive";

/** How long the presigned `restore.tarballUrl` stays valid (b8 fetches it once at boot). */
export const RESTORE_URL_TTL_MS = 3_600_000;

/** Constant log shipper limits every manifest carries (CONTRACTS.md §7.6). */
const LOGS = { flushIntervalSecs: 5, maxBatch: 200, maxBatchBytes: 262144 } as const;

/** Activity ping interval (CONTRACTS.md §7.5). */
const ACTIVITY = { intervalSecs: 30 } as const;

interface UserDocuments {
  settings: { settings: string; keymap: string } | null;
  dotfiles: { repoUrl: string; installCommand: string | null } | null;
}

async function userDocuments(userId: string): Promise<UserDocuments> {
  const db = await dbReady();
  const rows = await db
    .select()
    .from(settingsDocs)
    .where(and(eq(settingsDocs.userId, userId), inArray(settingsDocs.kind, ["settings", "keymap", "dotfiles"])));
  const byKind = new Map(rows.map((row) => [row.kind, row.content]));
  const settings = byKind.get("settings");
  const keymap = byKind.get("keymap");
  const dotfilesRaw = byKind.get("dotfiles");
  let dotfiles: UserDocuments["dotfiles"] = null;
  if (dotfilesRaw) {
    try {
      const parsed = JSON.parse(dotfilesRaw) as { repoUrl?: unknown; installCommand?: unknown };
      if (typeof parsed.repoUrl === "string" && parsed.repoUrl.length > 0) {
        dotfiles = {
          repoUrl: parsed.repoUrl,
          installCommand: typeof parsed.installCommand === "string" ? parsed.installCommand : null,
        };
      }
    } catch {
      dotfiles = null;
    }
  }
  return {
    settings:
      settings !== undefined || keymap !== undefined
        ? { settings: settings ?? "{}", keymap: keymap ?? "[]" }
        : null,
    dotfiles,
  };
}

async function repoOf(repoId: string): Promise<Repo> {
  const db = await dbReady();
  const [row] = await db.select().from(repos).where(eq(repos.id, repoId)).limit(1);
  if (!row) throw new Error(`manifest: repo ${repoId} is missing`);
  return row;
}

async function jwtBlock(audience: string): Promise<SandboxManifest["jwt"]> {
  const keys = await loadSigningKeys();
  return {
    issuer: env().ZS_JWT_ISSUER,
    audience,
    portAudience: portAudience(audience),
    publicKeys: publicKeyPems(keys),
  };
}

async function restoreBlock(workspace: Workspace): Promise<SandboxManifest["restore"]> {
  if (workspace.restoreKind !== "tarball" || !workspace.restoreBlobPathname) return null;
  const tarballUrl = await blobStore().presignGet(workspace.restoreBlobPathname, RESTORE_URL_TTL_MS);
  return { tarballUrl, sha256: sha256FromBlobPathname(workspace.restoreBlobPathname) };
}

async function workspaceManifest(workspace: Workspace): Promise<SandboxManifest> {
  const repo = await repoOf(workspace.repoId);
  const [docs, forwards, jwt, restore] = await Promise.all([
    userDocuments(workspace.ownerUserId),
    forwardViews(workspace.id),
    jwtBlock(workspace.audience),
    restoreBlock(workspace),
  ]);
  const startedAt = (workspace.sessionStartedAt ?? workspace.createdAt).getTime();
  // A branch workspace checks out the *branch* (so the user can commit and
  // push on it) at depth 1; a pull-request or explicit-revision workspace is
  // pinned to the resolved sha at full depth (b9 §4.7, CONTRACTS.md §7.3).
  const pinned = workspace.gitRef !== null || workspace.branch === null;
  const revision = pinned ? (workspace.revision ?? repo.defaultBranch) : (workspace.branch ?? repo.defaultBranch);
  return {
    version: 1,
    workspaceId: workspace.id,
    sandboxName: workspace.sandboxName,
    sandboxGeneration: workspace.sandboxGeneration,
    userId: workspace.ownerUserId,
    build: workspace.serverBuild,
    // The client build the server must accept in Hello (D26/D23); distinct from the server build
    // whenever the bundle and the server binary are not built from one commit (local dev).
    clientBuild: workspace.clientBuild,
    region: workspace.region,
    repo: {
      owner: repo.owner,
      name: repo.name,
      cloneUrl: cloneUrl(repo.owner, repo.name),
      defaultBranch: repo.defaultBranch,
      revision,
      depth: pinned ? 0 : 1,
      ...(workspace.revision ? { commit: workspace.revision } : {}),
      ...(workspace.gitRef ? { ref: workspace.gitRef } : {}),
    },
    workspaceDir: `/workspaces/${repo.name}`,
    restore,
    dotfiles: docs.dotfiles,
    env: { ZS_WORKSPACE_ID: workspace.id, ZS_REGION: workspace.region },
    secretNames: [],
    jwt,
    forwards,
    proxySlots: proxySlots(),
    portPool: portPool(),
    idle: { minutes: workspace.idleMinutes },
    session: {
      id: workspace.currentSandboxSessionId ?? "",
      startedAt,
      capAt: startedAt + env().ZS_SESSION_CAP_MS,
      // Informational (b8 decides from its first-boot marker): this VM session
      // follows a stop of the same generation.
      resumed: workspace.lastStoppedAt !== null && workspace.restoreKind !== "tarball",
    },
    devcontainer: null,
    settings: docs.settings,
    logs: LOGS,
    activity: ACTIVITY,
    allowedOrigins: [controlPlaneUrl()],
    extensions: workspace.installedExtensions,
  };
}

/** Builds the manifest for whichever principal the bearer resolved to. */
export async function buildManifest(principal: SandboxPrincipal): Promise<SandboxManifest> {
  return workspaceManifest(principal.workspace);
}
