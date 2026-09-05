/**
 * {@link SandboxError} lives in its own module so both `lib/sandbox.ts` (the
 * real driver) and `lib/sandbox-fake.ts` can import it without a cycle.
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
