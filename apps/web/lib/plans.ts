import { env } from "./env";
import type { MachineType } from "./schema";

// Historical 32-vCPU workspaces remain readable; public creation is capped at 8.
export const MACHINES: Record<MachineType, { vcpus: 2 | 4 | 8 | 32; memoryGb: number }> = {
  vcpu2: { vcpus: 2, memoryGb: 4 },
  vcpu4: { vcpus: 4, memoryGb: 8 },
  vcpu8: { vcpus: 8, memoryGb: 16 },
  vcpu32: { vcpus: 32, memoryGb: 64 },
};

export function idleMinutesFor(requested: number | null | undefined): number {
  return Math.min(240, Math.max(5, Math.trunc(requested ?? env().ZS_IDLE_MINUTES_DEFAULT)));
}
