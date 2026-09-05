import { describe, expect, it } from "vitest";
import { publicGithubError } from "@/lib/github-api-error";
describe("anonymous GitHub rate limits", () => {
  it("preserves ordinary errors including missing/private repositories", () => {
    const error = { status: 404 };
    expect(publicGithubError(error)).toBe(error);
  });
  it("reports primary and secondary limits with Retry-After and no request credentials", () => {
    const primary = publicGithubError({ status: 403, response: { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "120" } } }, 100_000);
    expect(primary).toMatchObject({ status: 503, code: "github_rate_limited", headers: { "Retry-After": "20" } });
    const secondary = publicGithubError({ status: 429, response: { headers: { "retry-after": "45" } } });
    expect(secondary).toMatchObject({ headers: { "Retry-After": "45" } });
  });
});
