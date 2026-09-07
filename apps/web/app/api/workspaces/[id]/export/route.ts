import path from "node:path";
import { z } from "zod";
import { ApiError, handler, parseBody } from "@/lib/api";
import { keys, withLock } from "@/lib/kv";
import { limit } from "@/lib/ratelimit";
import { requireWorkspaceParam, type WorkspaceParams } from "@/lib/route-context";
import { sandboxApi } from "@/lib/sandbox";
import { localBackendEnabled, localSandboxDir } from "@/lib/sandbox-local";
import { repoOf, workspaceDir, workspacePathsFor } from "@/lib/shell";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({
  path: z.string().min(1).max(4096).refine(value => !/[\0\\]/.test(value)),
  includeIgnored: z.boolean().default(false),
});
const archiveSchema = z.object({
  directory: z.string().regex(/^zedspaces-export-[a-z0-9_]{8}$/),
  bytes: z.number().int().nonnegative().max(272 * 1024 * 1024),
  files: z.number().int().nonnegative().max(20_000),
  skippedFiles: z.number().int().nonnegative(),
});

export const POST = handler<Request, WorkspaceParams>(async (req, ctx) => {
  const origin = req.headers.get("origin");
  if ((origin && origin !== new URL(req.url).origin) || req.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiError(403, "cross_origin", "Start downloads from this workspace.");
  }
  const { workspace, viewer } = await requireWorkspaceParam(ctx, {
    allowEditorCookie: true, control: true, allowStates: ["running"],
  });
  await limit("user.export", viewer.userId);
  const input = await parseBody(req, requestSchema, { maxBytes: 8192 });
  const repo = await repoOf(workspace);
  if (!repo) throw new ApiError(404, "not_found", "Project not found.");
  const root = workspacePathsFor(workspace, repo)[0];
  const folder = path.relative(root, input.path);
  if (!path.isAbsolute(input.path) || folder === ".." || folder.startsWith("../") || path.isAbsolute(folder) || folder.split("/").includes(".git")) {
    throw new ApiError(400, "invalid_folder", "Choose a folder inside this project.");
  }
  const sandbox = await sandboxApi().get(workspace.sandboxName, { resume: false });
  if (!sandbox || sandbox.status !== "running") throw new ApiError(409, "not_running", "Start the workspace before exporting.");
  const local = localBackendEnabled();
  const script = local ? path.resolve("../../sandbox/image/export-project.py") : "/usr/local/lib/zedspaces/export-project.py";
  const commandEnv = { TMPDIR: local ? path.join(localSandboxDir(workspace.sandboxName), "tmp") : "/tmp" };
  const cleanup = async (file: string) => {
    try {
      const result = await sandbox.run({ cmd: "python3", args: [script, "--cleanup", file], env: commandEnv, timeoutMs: 10_000 });
      if (result.exitCode) console.warn("Export cleanup failed", workspace.id);
    } catch { console.warn("Export cleanup unavailable", workspace.id); }
  };
  const prepared = await withLock(keys.lock(`export:${workspace.id}`), 120_000, async () => {
    const result = await sandbox.run({
      cmd: "python3", args: [script, "--root", workspaceDir(repo), "--folder", folder, ...(input.includeIgnored ? ["--include-ignored"] : [])],
      env: commandEnv, timeoutMs: 100_000,
    });
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); }
    catch { throw new ApiError(502, "export_failed", "The sandbox could not prepare the ZIP. Update the workspace and try again."); }
    if (result.exitCode) {
      const error = z.object({ error: z.string() }).safeParse(parsed);
      throw new ApiError(422, "export_failed", error.success ? error.data.error : "Could not export this folder.");
    }
    return archiveSchema.parse(parsed);
  });
  if (!prepared) throw new ApiError(409, "export_busy", "This workspace is already preparing a download.");
  const file = `/tmp/${prepared.directory}/project.zip`;
  let source: ReadableStream<Uint8Array> | null = null;
  try {
    if (req.signal.aborted) throw new Error("Download canceled");
    source = await sandbox.readFile(file);
    if (!source) throw new ApiError(502, "export_missing", "The prepared ZIP is no longer available.");
  } catch (error) { await cleanup(file); throw error; }
  const reader = source.getReader();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    req.signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    await cleanup(file);
  };
  const abort = () => { void release(); };
  req.signal.addEventListener("abort", abort, { once: true });
  if (req.signal.aborted) abort();
  let delivered = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (delivered !== prepared.bytes) throw new Error("The prepared ZIP changed during download.");
          await release(); controller.close();
        } else {
          delivered += value.byteLength;
          if (delivered > prepared.bytes) throw new Error("The prepared ZIP changed during download.");
          controller.enqueue(value);
        }
      } catch (error) { await release(); controller.error(error); }
    },
    cancel: release,
  });
  const filename = encodeURIComponent(`${path.basename(input.path)}.zip`).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16)}`);
  return new Response(stream, { headers: {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="project.zip"; filename*=UTF-8''${filename}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Zedspaces-Export-Bytes": String(prepared.bytes),
    "X-Zedspaces-Export-Files": String(prepared.files),
    "X-Zedspaces-Export-Skipped": String(prepared.skippedFiles),
  } });
});
