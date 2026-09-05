"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { parsePublicRepo } from "@/lib/github-repo";
import { buttonClass } from "./ui";

/** Anonymous public clones. A stable idempotency key survives a network-error retry. */
export function PublicRepoForm() {
  const router = useRouter();
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<{ body: string; key: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const body = JSON.stringify({ repo: parsePublicRepo(repo), ...(branch.trim() ? { ref: { branch: branch.trim() } } : {}) });
      if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": attempt.current.key },
        body,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? `Workspace creation failed (HTTP ${response.status})`);
      if (!result.workspace?.id) throw new Error("The server did not return a workspace");
      router.push(`/w/${result.workspace.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the workspace");
      setBusy(false);
    }
  }

  return <form onSubmit={submit} className="space-y-4 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
      <label className="flex-1 space-y-1 text-sm">
        <span className="font-medium">Public GitHub repository</span>
        <input required name="repo" value={repo} onChange={(e) => setRepo(e.target.value)}
          placeholder="https://github.com/octocat/Hello-World" autoComplete="off" disabled={busy}
          className="w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700" />
      </label>
      <label className="space-y-1 text-sm">
        <span className="font-medium">Branch (optional)</span>
        <input name="branch" value={branch} onChange={(e) => setBranch(e.target.value)}
          placeholder="Default branch" maxLength={255} autoComplete="off" disabled={busy}
          className="w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700" />
      </label>
      <button type="submit" disabled={busy} className={buttonClass("primary")}>{busy ? "Creating workspace…" : "Open in Zed"}</button>
    </div>
    <p className="text-xs text-zinc-500">No GitHub credentials needed. Everyone with this URL can use, change, stop, or delete these workspaces. Private repositories and GitHub pushes are not supported.</p>
    {error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
  </form>;
}
