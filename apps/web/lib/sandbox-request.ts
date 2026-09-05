import { ApiError, clientIp, type RouteCtx } from "./api";
import { SANDBOX_NAME_RE } from "./ids";
import { limit, type LimitName } from "./ratelimit";
import { requireSandbox, type SandboxPrincipal } from "./sandbox-auth";

export interface SandboxParams { name: string }
export interface SandboxPortParams extends SandboxParams { port: string }

export function assertSandboxName(name: string): string {
  if (!SANDBOX_NAME_RE.test(name)) throw new ApiError(400, "invalid_sandbox_name", "Invalid workspace sandbox name");
  return name;
}

// Authenticate before charging the VM's budget. Bad tokens spend the caller's
// IP budget, so knowing a sandbox name cannot exhaust its supervisor's quota.
export async function requireSandboxNamed(req: Request, name: string, budget: LimitName): Promise<SandboxPrincipal> {
  let principal: SandboxPrincipal;
  try { principal = await requireSandbox(req, name); }
  catch (error) {
    if (error instanceof ApiError && error.status === 401) await limit("sandbox.auth-failures", clientIp(req) ?? "unknown");
    throw error;
  }
  await limit(budget, principal.sandboxName);
  return principal;
}

export async function requireSandboxParam(req: Request, ctx: RouteCtx<SandboxParams>, budget: LimitName): Promise<SandboxPrincipal> {
  return requireSandboxNamed(req, assertSandboxName((await ctx.params).name), budget);
}
