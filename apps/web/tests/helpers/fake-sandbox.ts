/**
 * Test-facing view of the in-memory sandbox driver. The implementation lives
 * in `lib/sandbox-fake.ts` because `sandboxApi()` selects it from the
 * environment (`ZS_SANDBOX_DRIVER=fake`) and must be reachable from production
 * code paths under test.
 */
export {
  fakeSandbox,
  fakeSandboxApi,
  fakeDomain,
  type FakeCall,
  type FakeCommand,
  type FakeSandboxControl,
  type FakeSandboxRecord,
} from "@/lib/sandbox-fake";

import { fakeSandbox } from "@/lib/sandbox-fake";
import type { HealthProbe } from "@/lib/types";

/** A `HealthProbe` with sensible defaults, overridable field by field. */
export function health(patch: Partial<HealthProbe> = {}): HealthProbe {
  const status = patch.status ?? "ready";
  const serverRunning = patch.serverRunning ?? true;
  return {
    ready: (status === "ready" || status === "degraded") && serverRunning,
    status,
    phase: patch.phase ?? "ready",
    build: patch.build ?? "test-0",
    manifestBuild: patch.manifestBuild ?? "test-0",
    resumed: patch.resumed ?? false,
    busy: patch.busy ?? false,
    serverRunning,
    serverCrashLoop: patch.serverCrashLoop ?? false,
    serverRestarts: patch.serverRestarts ?? 0,
    uptimeSecs: patch.uptimeSecs ?? 12,
  };
}

/** Empties the fake driver's state between tests. */
export function resetFakeSandbox(): void {
  fakeSandbox().reset();
}
