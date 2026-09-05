import { ApiError, bearer } from "./api";
import { requireEnv } from "./env";
import { timingSafeEqualString } from "./ids";

/**
 * Authenticates a Vercel Cron invocation: `Authorization: Bearer
 * ${CRON_SECRET}`, compared in constant time. Throws
 * `ApiError(401, "unauthenticated")` otherwise.
 */
export function requireCronSecret(req: Request): void {
  const { CRON_SECRET } = requireEnv("CRON_SECRET");
  const token = bearer(req);
  if (!token || !timingSafeEqualString(token, CRON_SECRET)) {
    throw new ApiError(401, "unauthenticated", "Cron secret required");
  }
}

/** The `YYYY-MM` before `period` (UTC). */
export function previousPeriod(period: string): string {
  const [year, month] = period.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
