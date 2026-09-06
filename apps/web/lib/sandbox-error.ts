/**
 * Shared sandbox failures for the Vercel and local adapters.
 */

/** Failure classes the sandbox driver distinguishes (b9 §3.16). */
export type SandboxErrorCode =
  | "image_not_ready"
  | "not_found"
  | "snapshot_expired"
  | "snapshot_region_mismatch"
  | "quota"
  | "unknown";

/** A platform failure with the retry decision already made. */
export class SandboxError extends Error {
  constructor(
    public readonly code: SandboxErrorCode,
    public readonly retryable: boolean,
    message?: string,
    public readonly status?: number,
  ) {
    super(message ?? code);
    this.name = "SandboxError";
  }
}
