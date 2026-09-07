import { z } from "zod";
import { handler, parseBody } from "@/lib/api";
import type { WorkspaceParams } from "@/lib/route-context";
import { connectSandboxProcess } from "@/lib/sandbox-process";

export const runtime = "nodejs";
const path = z.string().min(1).max(4096).refine(value => value.startsWith("/") && !value.includes("\0"));
const kernelSchema = z.object({ python: path.nullable(), cwd: path }).strict();
const bundledPython = "/opt/zedspaces/repl/bin/python";

export const POST = handler<Request, WorkspaceParams>((req, ctx) => connectSandboxProcess(req, ctx, async () => {
  const { python, cwd } = await parseBody(req, kernelSchema, { maxBytes: 32_768 });
  return JSON.stringify({
    command: bundledPython,
    arguments: ["/usr/local/lib/zedspaces/kernel.py", python ?? bundledPython],
    envs: {}, cwd, connection: null,
  });
}));
