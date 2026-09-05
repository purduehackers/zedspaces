import { handler, json, parseBody } from "@/lib/api";
import { ensureUser, requireViewer } from "@/lib/auth";
import { MAX_DOC_BYTES, readDoc, writeDoc } from "@/lib/settings-docs";
import { putSettingsDocInput } from "@/lib/types";

export const runtime = "nodejs";

/** `GET /api/me/settings` – the user's `settings.json` and its version. */
export const GET = handler(async () => {
  const viewer = await requireViewer();
  return json(await readDoc(viewer.userId, "settings"));
});

/**
 * `PUT /api/me/settings` – stores the document verbatim after checking that it
 * parses as JSONC. A stale `version` fails with `409 version_conflict`.
 */
export const PUT = handler(async (req) => {
  const viewer = await requireViewer();
  await ensureUser(viewer);
  const input = await parseBody(req, putSettingsDocInput, { maxBytes: MAX_DOC_BYTES + 4096 });
  return json(await writeDoc(viewer.userId, "settings", input.content, input.version));
});
