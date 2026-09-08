import { apiErrorBody } from "./api-client";

/** The sandbox produces the archive; browser download delivery stays out of Zed. */
export async function downloadProject(workspaceId: string, path: string, includeIgnored: boolean): Promise<string> {
  const response = await fetch(`/api/workspaces/${workspaceId}/export`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, includeIgnored }), cache: "no-store",
    signal: AbortSignal.timeout(280_000),
  });
  if (!response.ok) throw new Error((await apiErrorBody(response)).message);
  const blob = await response.blob();
  const expected = Number(response.headers.get("X-Zedspaces-Export-Bytes"));
  if (blob.size !== expected) throw new Error("The ZIP download was interrupted. Please try again.");
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${path.split("/").filter(Boolean).at(-1) ?? "project"}.zip`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  const files = Number(response.headers.get("X-Zedspaces-Export-Files"));
  const skipped = Number(response.headers.get("X-Zedspaces-Export-Skipped"));
  return `Download started: ${files} files.${skipped ? ` Skipped ${skipped} links or special files.` : ""}`;
}
