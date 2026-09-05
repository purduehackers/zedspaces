import { z } from "zod";

export const githubOwner = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/, "Invalid GitHub owner");
export const githubName = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.-]+$/, "Invalid GitHub repository")
  .refine((s) => s !== "." && s !== "..", "Invalid GitHub repository");

/** Only github.com HTTPS URLs or owner/repo, never arbitrary clone hosts or credentials. */
export function parsePublicRepo(value: string): { owner: string; name: string } {
  let path = value.trim();
  if (path.startsWith("https://")) {
    const url = new URL(path);
    if (url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) {
      throw new Error("Use a public github.com repository URL");
    }
    path = url.pathname.replace(/^\//, "").replace(/\/$/, "");
  }
  const parts = path.replace(/\.git$/, "").split("/");
  if (parts.length !== 2) throw new Error("Enter owner/repo or https://github.com/owner/repo");
  return { owner: githubOwner.parse(parts[0]), name: githubName.parse(parts[1]) };
}
