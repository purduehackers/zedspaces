import { ApiError, handler, json, parseBody } from "@/lib/api";
import { ensureUser, requireViewer } from "@/lib/auth";
import { readDotfiles, writeDotfiles } from "@/lib/settings-docs";
import { putDotfilesInput } from "@/lib/types";

export const runtime = "nodejs";

/** `GET /api/me/dotfiles` – the dotfiles repository a workspace installs at boot. */
export const GET = handler(async () => {
  const viewer = await requireViewer();
  return json(await readDotfiles(viewer.userId));
});

/**
 * `PUT /api/me/dotfiles` – sets the dotfiles repository and install command.
 * Only `https://` GitHub URLs are accepted: the supervisor clones them with the
 * owner's OAuth token through the git credential helper, and an `ssh://` or
 * `file://` URL would either fail or reach outside the sandbox's intent.
 */
export const PUT = handler(async (req) => {
  const viewer = await requireViewer();
  await ensureUser(viewer);
  const input = await parseBody(req, putDotfilesInput);
  if (input.repoUrl !== null) assertHttpsRepoUrl(input.repoUrl);
  return json(await writeDotfiles(viewer.userId, input));
});

function assertHttpsRepoUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(400, "invalid_body", "The dotfiles repository must be an absolute URL");
  }
  if (url.protocol !== "https:") {
    throw new ApiError(400, "invalid_body", "The dotfiles repository must be an https URL");
  }
}
