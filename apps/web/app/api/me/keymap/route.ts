import { handler, json, parseBody } from "@/lib/api";
import { ensureUser, requireViewer } from "@/lib/auth";
import { MAX_DOC_BYTES, readDoc, writeDoc } from "@/lib/settings-docs";
import { putSettingsDocInput } from "@/lib/types";

export const runtime = "nodejs";

/** `GET /api/me/keymap` – the user's `keymap.json` and its version. */
export const GET = handler(async () => {
  const viewer = await requireViewer();
  return json(await readDoc(viewer.userId, "keymap"));
});

/**
 * `PUT /api/me/keymap` – stores the document verbatim after checking that it
 * parses as JSONC. A stale `version` fails with `409 version_conflict`.
 */
export const PUT = handler(async (req) => {
  const viewer = await requireViewer();
  await ensureUser(viewer);
  const input = await parseBody(req, putSettingsDocInput, { maxBytes: MAX_DOC_BYTES + 4096 });
  return json(await writeDoc(viewer.userId, "keymap", input.content, input.version));
});
