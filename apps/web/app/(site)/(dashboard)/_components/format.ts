import type { MachineType, WorkspaceState } from "@/lib/types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** An absolute UTC timestamp, stable between server render and test. */
export function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/**
 * A short relative age (`"4 min ago"`, `"3 h ago"`, `"2 d ago"`). Anything
 * older than 30 days, and anything in the future, falls back to the date.
 */
export function formatRelative(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never";
  const delta = now - then;
  if (delta < 0) return formatTimestamp(iso);
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} min ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)} h ago`;
  if (delta < 30 * DAY) return `${Math.floor(delta / DAY)} d ago`;
  return formatTimestamp(iso);
}

/** How the workspace list labels each state. */
export const STATE_LABELS: Record<WorkspaceState, string> = {
  creating: "Creating",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  rebuilding: "Rebuilding",
  deleting: "Deleting",
  error: "Error",
};

/** Colour family a state badge uses. */
export type Tone = "green" | "amber" | "gray" | "red" | "blue";

/** The badge tone of a workspace state. */
export function stateTone(state: WorkspaceState): Tone {
  switch (state) {
    case "running":
      return "green";
    case "creating":
    case "rebuilding":
    case "stopping":
      return "amber";
    case "stopped":
      return "gray";
    case "deleting":
    case "error":
      return "red";
  }
}

/** True while a lifecycle workflow owns the workspace, so actions must be disabled. */
export function isBusyState(state: WorkspaceState): boolean {
  return state === "creating" || state === "stopping" || state === "rebuilding" || state === "deleting";
}

/**
 * Display names of the machine types. This is the presentation side of
 * `MACHINES` in `lib/plans.ts` (2 GB of memory per vCPU); it is repeated here
 * because `lib/plans.ts` reaches server-only modules and the machine picker is
 * a client component.
 */
export const MACHINE_LABELS: Record<MachineType, string> = {
  vcpu2: "2 vCPU · 4 GB",
  vcpu4: "4 vCPU · 8 GB",
  vcpu8: "8 vCPU · 16 GB",
  vcpu32: "32 vCPU · 64 GB",
};

/** Human label of a machine type, falling back to the raw value. */
export function formatMachine(machine: MachineType): string {
  return MACHINE_LABELS[machine] ?? machine;
}

/** How a workspace's ref reads in a list: branch, `PR #12` or a short sha. */
export function formatRef(ref: { branch: string | null; pullRequest: number | null; revision: string | null }): string {
  if (ref.pullRequest !== null) return `PR #${ref.pullRequest}`;
  if (ref.branch) return ref.branch;
  if (ref.revision) return ref.revision.slice(0, 7);
  return "—";
}

/** `owner/name` of a repository reference. */
export function formatRepo(repo: { owner: string; name: string }): string {
  return `${repo.owner}/${repo.name}`;
}
