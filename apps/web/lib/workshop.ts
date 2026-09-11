import { z } from "zod";
import { githubBranch, githubName, githubOwner } from "./github-repo";

export const workshopInput = z.object({ owner: githubOwner, repo: githubName, branch: githubBranch.optional() });
export type Workshop = z.infer<typeof workshopInput>;

export function workshopPath({ owner, repo, branch }: Workshop) {
  return `/new/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${branch ? `?branch=${encodeURIComponent(branch)}` : ""}`;
}

export function workspaceInput({ owner, repo, branch }: Workshop) {
  return { repo: { owner, name: repo }, ...(branch ? { ref: { branch } } : {}) };
}

export function workshopKey({ owner, repo, branch }: Workshop) {
  return JSON.stringify([owner.toLowerCase(), repo.toLowerCase(), branch ?? null]);
}

/** Only local paths can survive the OAuth round trip. */
export function safeReturnPath(value: string | undefined) {
  if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\") ||
      [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return "/workspaces";
  const url = new URL(value, "https://zedspaces.invalid");
  if (url.origin !== "https://zedspaces.invalid" || url.pathname === "/login" || url.pathname.startsWith("/api/")) return "/workspaces";
  return url.pathname + url.search + url.hash;
}
