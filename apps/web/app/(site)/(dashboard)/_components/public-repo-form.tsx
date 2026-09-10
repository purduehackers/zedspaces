"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { parsePublicRepo } from "@/lib/github-repo";
import { buttonClass, FIELD_CLASS } from "./ui";

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

  return <form onSubmit={submit} aria-busy={busy} className="space-y-5 rounded border border-line border-t-gold bg-panel p-5 sm:p-6">
    <div>
      <h2 className="brand-label text-gold">From repository to workspace</h2>
      <p className="mt-2 text-sm text-muted">Paste a public GitHub repo. We’ll clone it, start a sandbox, and open Zed.</p>
    </div>
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <label className="flex-1 space-y-1 text-sm">
        <span className="font-medium">Public GitHub repository</span>
        <input required name="repo" value={repo} onChange={(e) => setRepo(e.target.value)}
          placeholder="github.com/purduehackers/wack-hacker" autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={busy}
          className={FIELD_CLASS} />
      </label>
      <button type="submit" disabled={busy} className={buttonClass("primary")}>{busy ? "Creating workspace…" : "Open in Zed →"}</button>
    </div>
    <details className="text-sm text-muted">
      <summary className="w-fit hover:text-text">Choose a branch <span className="text-xs">(optional)</span></summary>
      <label className="mt-3 block max-w-sm space-y-1">
        <span>Branch</span>
        <input name="branch" value={branch} onChange={(e) => setBranch(e.target.value)}
          placeholder="Default branch" maxLength={255} autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={busy}
          className={FIELD_CLASS} />
      </label>
    </details>
    <p className="border-t border-line pt-4 text-xs leading-relaxed text-muted">This is a shared space, not a private account. Anyone can edit, stop, or delete these workspaces. Public repos only; don’t add secrets.</p>
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
  </form>;
}
