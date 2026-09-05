import { ApiError } from "./api";

/** Public GitHub reads share the unauthenticated IP quota; surface its reset instead of a 500. */
export function publicGithubError(error: unknown, now = Date.now()): unknown {
  const e = error as { status?: number; response?: { headers?: Record<string, string | undefined> } } | null;
  const headers = e?.response?.headers ?? {};
  if (e?.status !== 429 && !(e?.status === 403 && (headers["x-ratelimit-remaining"] === "0" || headers["retry-after"]))) return error;
  const seconds = Number(headers["retry-after"] ?? "0") || Number(headers["x-ratelimit-reset"] ?? "0") - now / 1000;
  const retry = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60;
  return new ApiError(503, "github_rate_limited", "GitHub's public API rate limit was reached. Try again after the limit resets.",
    { retryAfterSec: retry }, { "Retry-After": String(retry) });
}
