import { isIP } from "node:net";
import { z } from "zod";
import { ApiError, handler, parseBody } from "@/lib/api";
import { isInfraPort } from "@/lib/env";
import type { WorkspaceParams } from "@/lib/route-context";
import { connectSandboxProcess } from "@/lib/sandbox-process";

export const runtime = "nodejs";
const text = z.string().refine(value => !value.includes("\0"));
const launchSchema = z.object({
  command: text.min(1).nullable(), arguments: z.array(text).max(512),
  envs: z.record(text, text).refine(value => Object.keys(value).length <= 1024), cwd: text.nullable(),
  connection: z.object({
    host: z.string().refine(value => isIP(value) !== 0 && (value === "127.0.0.1" || value === "::1")),
    port: z.number().int().min(1024).max(65535).refine(port => !isInfraPort(port)),
    timeout: z.number().int().nonnegative().nullable(),
  }).strict().nullable(),
}).strict().refine(value => value.command !== null || value.connection !== null);

/** A short-lived, one-use capability for exactly one adapter launch. */
export const POST = handler<Request, WorkspaceParams>((req, ctx) => connectSandboxProcess(req, ctx, async () => {
  const launch = await parseBody(req, z.string().max(65_536), { maxBytes: 262_144 });
  try { launchSchema.parse(JSON.parse(launch)); }
  catch { throw new ApiError(400, "invalid_debug_config", "Use a sandbox command or a loopback debug adapter connection."); }
  return launch;
}));
