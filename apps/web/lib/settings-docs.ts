import { and, eq } from "drizzle-orm";
import { ApiError } from "./api";
import { dbReady } from "./db";
import { isJsonc } from "./jsonc";
import { settingsDocs, type SettingsKind } from "./schema";

/**
 * Per-user `settings.json`, `keymap.json` and dotfiles configuration
 * (b9 §4.2 `/api/me/*`). Stored as text, not json, because Zed's documents are
 * JSONC with comments — the supervisor writes them out verbatim (D18).
 */

/** Largest document accepted: 512 KiB. */
export const MAX_DOC_BYTES = 512 * 1024;

/** What a brand-new account's `settings.json` looks like. */
export const DEFAULT_SETTINGS = "{\n}\n";
/** What a brand-new account's `keymap.json` looks like. */
export const DEFAULT_KEYMAP = "[\n]\n";

/** A settings document and the version a conditional `PUT` must quote. */
export interface SettingsDocView {
  content: string;
  version: number;
}

function defaultFor(kind: SettingsKind): string {
  if (kind === "settings") return DEFAULT_SETTINGS;
  if (kind === "keymap") return DEFAULT_KEYMAP;
  return JSON.stringify({ repoUrl: null, installCommand: null });
}

/** Reads one document, falling back to the built-in default at version 0. */
export async function readDoc(userId: string, kind: SettingsKind): Promise<SettingsDocView> {
  const db = await dbReady();
  const [row] = await db
    .select()
    .from(settingsDocs)
    .where(and(eq(settingsDocs.userId, userId), eq(settingsDocs.kind, kind)))
    .limit(1);
  return row ? { content: row.content, version: row.version } : { content: defaultFor(kind), version: 0 };
}

/**
 * Writes one document. `expectedVersion`, when given, must equal the stored
 * version or the write fails with `409 version_conflict` carrying the current
 * document, so an editor can merge rather than clobber.
 */
export async function writeDoc(
  userId: string,
  kind: SettingsKind,
  content: string,
  expectedVersion?: number,
): Promise<SettingsDocView> {
  if (Buffer.byteLength(content, "utf8") > MAX_DOC_BYTES) {
    throw new ApiError(413, "payload_too_large", `A ${kind} document may not exceed ${MAX_DOC_BYTES} bytes`);
  }
  if (kind !== "dotfiles" && !isJsonc(content)) {
    throw new ApiError(400, "invalid_body", `The ${kind} document is not valid JSON with comments`);
  }

  const db = await dbReady();
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(settingsDocs)
      .where(and(eq(settingsDocs.userId, userId), eq(settingsDocs.kind, kind)))
      .limit(1);
    const version = current?.version ?? 0;
    if (expectedVersion !== undefined && expectedVersion !== version) {
      throw new ApiError(409, "version_conflict", "The document changed since it was read", {
        version,
        content: current?.content ?? defaultFor(kind),
      });
    }
    const next = version + 1;
    await tx
      .insert(settingsDocs)
      .values({ userId, kind, content, version: next })
      .onConflictDoUpdate({
        target: [settingsDocs.userId, settingsDocs.kind],
        set: { content, version: next, updatedAt: new Date() },
      });
    return { content, version: next };
  });
}

/** The dotfiles repository a workspace installs at boot. */
export interface DotfilesView {
  repoUrl: string | null;
  installCommand: string | null;
}

/** Reads the dotfiles configuration; an unreadable row reads as "not configured". */
export async function readDotfiles(userId: string): Promise<DotfilesView> {
  const { content } = await readDoc(userId, "dotfiles");
  try {
    const parsed = JSON.parse(content) as Partial<DotfilesView>;
    return {
      repoUrl: typeof parsed.repoUrl === "string" ? parsed.repoUrl : null,
      installCommand: typeof parsed.installCommand === "string" ? parsed.installCommand : null,
    };
  } catch {
    return { repoUrl: null, installCommand: null };
  }
}

/** Writes the dotfiles configuration. */
export async function writeDotfiles(userId: string, value: DotfilesView): Promise<DotfilesView> {
  await writeDoc(userId, "dotfiles", JSON.stringify(value));
  return value;
}
