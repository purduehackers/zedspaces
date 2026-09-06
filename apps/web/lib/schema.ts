import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// SQLite stores enums as text; preserve the shared enumValues contract used by Zod.
function sqliteEnum<const T extends [string, ...string[]]>(_name: string, values: T) {
  return Object.assign((name: string) => text(name, { enum: values }), { enumValues: values });
}

// Enums (BUILD-SPEC §7.2; b9 §4.1).

/** Billing plan of a user or org. */
export const planEnum = sqliteEnum("plan", ["free", "pro", "team", "enterprise"]);
/** Lifecycle state of a workspace. */
export const workspaceStateEnum = sqliteEnum("workspace_state", [
  "creating",
  "running",
  "stopping",
  "stopped",
  "rebuilding",
  "deleting",
  "error",
]);
/** Sandbox machine size. */
export const machineTypeEnum = sqliteEnum("machine_type", ["vcpu2", "vcpu4", "vcpu8", "vcpu32"]);
/** Vercel Sandbox region. */
export const regionEnum = sqliteEnum("region", ["iad1", "sfo1", "cle1", "cdg1"]);

/** Kind of a per-user settings document. */
export const settingsKindEnum = sqliteEnum("settings_kind", ["settings", "keymap", "dotfiles"]);
/** Visibility of a forwarded port. */
export const portVisibilityEnum = sqliteEnum("port_visibility", ["private", "public"]);

/** Role of a user inside an org. */
export const membershipRoleEnum = sqliteEnum("membership_role", ["owner", "admin", "member"]);

/** Actor kind of an audit-log entry. */
export const actorTypeEnum = sqliteEnum("actor_type", ["user", "sandbox", "system", "cron"]);

/** How a workspace generation restores its files. */
export const restoreKindEnum = sqliteEnum("restore_kind", ["fresh", "snapshot", "tarball"]);

const ts = (name: string) => integer(name, { mode: "timestamp_ms" });
const nowMs = sql`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`;

/** Settings ownership and the shared-space abuse flag. Legacy identities remain readable. */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    githubId: integer("github_id"),
    githubLogin: text("github_login"),
    email: text("email"),
    plan: planEnum("plan").notNull().default("free"),
    idleMinutesDefault: integer("idle_minutes_default").notNull().default(30),
    /** Abuse rule (§4.10); creation refused while set. */
    flaggedAt: ts("flagged_at"),
    flagReason: text("flag_reason"),
    /**
     * Internal editor-cookie epoch, retained for the existing browser protocol.
     */
    authEpoch: integer("auth_epoch").notNull().default(0),
    createdAt: ts("created_at").notNull().default(nowMs),
    updatedAt: ts("updated_at").notNull().default(nowMs),
    deletedAt: ts("deleted_at"),
  },
  (t) => [uniqueIndex("users_github_id_idx").on(t.githubId)],
);

/** Legacy ownership anchors; no organization UI or access policy remains. */
export const orgs = sqliteTable(
  "orgs",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    plan: planEnum("plan").notNull().default("team"),
    allowedInstallationIds: text("allowed_installation_ids", { mode: "json" }).$type<number[] | null>(),
    networkAllowlist: text("network_allowlist", { mode: "json" }).$type<string[] | null>(),
    createdAt: ts("created_at").notNull().default(nowMs),
    deletedAt: ts("deleted_at"),
  },
  (t) => [uniqueIndex("orgs_slug_idx").on(t.slug)],
);

/** Org memberships. */
export const memberships = sqliteTable(
  "memberships",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: membershipRoleEnum("role").notNull().default("member"),
    createdAt: ts("created_at").notNull().default(nowMs),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] }), index("memberships_user_idx").on(t.userId)],
);

/** Legacy FK anchors: 0 means public GitHub, 1 means local test repositories. */
export const githubInstallations = sqliteTable(
  "github_installations",
  {
    installationId: integer("installation_id").primaryKey(),
    accountId: integer("account_id").notNull(),
    accountLogin: text("account_login").notNull(),
    /** "User" | "Organization" */
    accountType: text("account_type").notNull(),
    /** "all" | "selected" */
    repositorySelection: text("repository_selection").notNull(),
    ownerUserId: text("owner_user_id").references(() => users.id),
    orgId: text("org_id").references(() => orgs.id),
    suspendedAt: ts("suspended_at"),
    createdAt: ts("created_at").notNull().default(nowMs),
    deletedAt: ts("deleted_at"),
  },
  (t) => [index("gh_inst_owner_idx").on(t.ownerUserId), index("gh_inst_org_idx").on(t.orgId)],
);

/** Public repositories registered for workspaces. */
export const repos = sqliteTable(
  "repos",
  {
    /** repo_… */
    id: text("id").primaryKey(),
    installationId: integer("installation_id")
      .notNull()
      .references(() => githubInstallations.installationId),
    githubRepoId: integer("github_repo_id").notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    private: integer("private", { mode: "boolean" }).notNull().default(true),
    defaultMachine: machineTypeEnum("default_machine").notNull().default("vcpu2"),
    idleMinutes: integer("idle_minutes"),
    createdAt: ts("created_at").notNull().default(nowMs),
    updatedAt: ts("updated_at").notNull().default(nowMs),
  },
  (t) => [uniqueIndex("repos_github_id_idx").on(t.githubRepoId), uniqueIndex("repos_owner_name_idx").on(t.owner, t.name)],
);

/**
 * Workspaces. `id` (ws_…) is the JWT `ws` claim, `ZsBootConfig.workspace.id`
 * and the client's stable identity (D1). The JWT `sid` is per connect
 * (`sessions.last_connect_id`), never this id.
 */
export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id),
    orgId: text("org_id").references(() => orgs.id),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id),
    name: text("name").notNull(),
    branch: text("branch"),
    /** Resolved commit sha. */
    revision: text("revision"),
    /** "refs/pull/N/head" for PR workspaces (manifest repo.ref). */
    gitRef: text("git_ref"),
    pullRequest: integer("pull_request"),
    machine: machineTypeEnum("machine").notNull(),
    region: regionEnum("region").notNull(),
    /** Immutable per generation. */
    sandboxName: text("sandbox_name").notNull(),
    /** Set by rebuild until the new generation is healthy (§4.8). */
    previousSandboxName: text("previous_sandbox_name"),
    /** Bumps on rebuild. */
    sandboxGeneration: integer("sandbox_generation").notNull().default(1),
    imageRef: text("image_ref").notNull(),
    /** ZS_BUILD_ID of imageRef at create/rebuild (manifest.build, connect.serverBuild). */
    serverBuild: text("server_build").notNull(),
    /** Bundle under public/editor/ the page loads (§3.26). */
    clientBuild: text("client_build").notNull(),
    restoreKind: restoreKindEnum("restore_kind").notNull().default("fresh"),
    /** Rebuild archive; retained until the healthy new generation replaces the old one. */
    restoreBlobPathname: text("restore_blob_pathname"),
    state: workspaceStateEnum("state").notNull().default("creating"),
    /** "boot:<phase>" during boot, workflow error text on error. */
    stateReason: text("state_reason"),
    /** JWT aud; = sandboxName, rotatable to `${sandboxName}.${n}`. */
    audience: text("audience").notNull(),
    sandboxTokenHash: text("sandbox_token_hash"),
    sandboxTokenGeneration: integer("sandbox_token_generation").notNull().default(0),
    supervisorCmdId: text("supervisor_cmd_id"),
    /** Host of domain(8443) for the current session. */
    currentWsHost: text("current_ws_host"),
    /** Proxy-slot port → host of domain(slot) for the current sandbox session (D8); null while stopped. */
    currentSlotHosts: text("current_slot_hosts", { mode: "json" }).$type<Record<string, string>>(),
    /** Host of domain(ZS_HEALTH_PORT). */
    currentHealthHost: text("current_health_host"),
    currentSandboxSessionId: text("current_sandbox_session_id"),
    /** VM session start: 24 h cap, usage wall time. */
    sessionStartedAt: ts("session_started_at"),
    /** Platform session timeout as last observed/extended (§4.10). */
    sandboxExpiresAt: ts("sandbox_expires_at"),
    /** Size of the snapshot taken at the last stop; accrued daily by the snapshot-usage cron. */
    snapshotSizeBytes: integer("snapshot_size_bytes"),
    /** In-flight lifecycle run, null when idle. */
    workflowRunId: text("workflow_run_id"),
    workflowRunStartedAt: ts("workflow_run_started_at"),
    lastActiveAt: ts("last_active_at").notNull().default(nowMs),
    idleMinutes: integer("idle_minutes").notNull().default(30),
    installedExtensions: text("installed_extensions", { mode: "json" }).$type<string[]>().notNull().default([]),
    retentionUntil: ts("retention_until"),
    retentionWarnedAt: ts("retention_warned_at"),
    createdAt: ts("created_at").notNull().default(nowMs),
    updatedAt: ts("updated_at").notNull().default(nowMs),
    lastStoppedAt: ts("last_stopped_at"),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    uniqueIndex("workspaces_sandbox_name_idx").on(t.sandboxName),
    index("workspaces_owner_state_idx").on(t.ownerUserId, t.state),
    index("workspaces_state_active_idx").on(t.state, t.lastActiveAt),
    index("workspaces_retention_idx").on(t.retentionUntil),
    index("workspaces_run_idx").on(t.workflowRunId),
  ],
);

/**
 * Per-tab editor sessions (ses_…).
 * NOT the JWT `sid`, which is minted per connect (D1) and recorded in
 * `lastConnectId`.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    sandboxGeneration: integer("sandbox_generation").notNull(),
    /** Vercel session id. */
    sandboxSessionId: text("sandbox_session_id"),
    /** sessionStorage id, stable across reloads. */
    holderTabId: text("holder_tab_id").notNull(),
    wsHost: text("ws_host").notNull(),
    clientBuild: text("client_build"),
    serverBuild: text("server_build"),
    startedAt: ts("started_at").notNull().default(nowMs),
    endedAt: ts("ended_at"),
    endReason: text("end_reason"),
    tokensMinted: integer("tokens_minted").notNull().default(0),
    /** The last per-connect `sid` (con_…) minted for this row (D1). */
    lastConnectId: text("last_connect_id"),
  },
  (t) => [
    index("sessions_ws_started_idx").on(t.workspaceId, t.startedAt),
    uniqueIndex("sessions_open_idx").on(t.workspaceId, t.holderTabId).where(sql`ended_at IS NULL`),
  ],
);

/** Forwarded ports. A slot is held by at most one forward per workspace; NULL slots do not collide. */
export const forwards = sqliteTable(
  "forwards",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    port: integer("port").notNull(),
    visibility: portVisibilityEnum("visibility").notNull().default("private"),
    label: text("label"),
    /** public: https://<domain(port)>; private: the control plane /open link (D8). */
    url: text("url"),
    /** Private forwards only: the proxy slot (one of ZS_PROXY_SLOTS) the supervisor binds to `port` (D8). */
    slot: integer("slot"),
    createdAt: ts("created_at").notNull().default(nowMs),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.port] }), uniqueIndex("forwards_slot_idx").on(t.workspaceId, t.slot)],
);

/**
 * Per-user settings documents. `content` is text rather than json because
 * Zed's settings.json and keymap.json are JSONC with comments.
 */
export const settingsDocs = sqliteTable(
  "settings_docs",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    kind: settingsKindEnum("kind").notNull(),
    /** JSONC for settings/keymap; JSON { repoUrl, installCommand } for dotfiles. */
    content: text("content").notNull(),
    version: integer("version").notNull().default(1),
    updatedAt: ts("updated_at").notNull().default(nowMs),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind] })],
);

/** Audit log. */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    /** "workspace.create" | "workspace.stop" | "secret.put" | "git_token.issue" | "admin.stop" | … */
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    ip: text("ip"),
    createdAt: ts("created_at").notNull().default(nowMs),
  },
  (t) => [
    index("audit_target_idx").on(t.targetType, t.targetId, t.createdAt),
    index("audit_actor_idx").on(t.actorId, t.createdAt),
  ],
);

// Row types (select shape) – one alias per table.

/** A `users` row. */
export type User = typeof users.$inferSelect;

/** A `repos` row. */
export type Repo = typeof repos.$inferSelect;

/** A `workspaces` row. */
export type Workspace = typeof workspaces.$inferSelect;
/** A `sessions` row. */
export type Session = typeof sessions.$inferSelect;

/** Insert shape of `workspaces`. */
export type NewWorkspace = typeof workspaces.$inferInsert;

// Enum value types.

/** Workspace lifecycle state. */
export type WorkspaceState = (typeof workspaceStateEnum.enumValues)[number];

/** Machine size. */
export type MachineType = (typeof machineTypeEnum.enumValues)[number];
/** Sandbox region. */
export type Region = (typeof regionEnum.enumValues)[number];

/** Settings document kind. */
export type SettingsKind = (typeof settingsKindEnum.enumValues)[number];
/** Forward visibility. */
export type PortVisibility = (typeof portVisibilityEnum.enumValues)[number];

/** Audit actor kind. */
export type ActorType = (typeof actorTypeEnum.enumValues)[number];

/** Shared TTL keys for locks, rate limits and ephemeral state (D44). */
export const kvEntries = sqliteTable("kv", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at"),
}, (t) => [index("kv_expiry_idx").on(t.expiresAt)]);
