"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { parsePublicRepo } from "@/lib/github-repo";
import { workshopPath } from "@/lib/workshop";
import { buttonClass, FIELD_CLASS } from "./ui";

/** Personal public clones. A stable idempotency key survives a network-error retry. */
export function PublicRepoForm({ modal = false }: { modal?: boolean }) {
  const router = useRouter();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const repoInput = useRef<HTMLInputElement>(null);
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<{ body: string; key: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    let parsedRepo;
    try {
      parsedRepo = parsePublicRepo(repo);
    } catch {
      setError("Enter a public GitHub URL or a repository in owner/repo format.");
      repoInput.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const body = JSON.stringify({ repo: parsedRepo, ...(branch.trim() ? { ref: { branch: branch.trim() } } : {}) });
      if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": attempt.current.key },
        body,
      });
      const result = await response.json();
      if (response.status === 401) {
        router.push(`/login?next=${encodeURIComponent(workshopPath({ owner: parsedRepo.owner, repo: parsedRepo.name, branch: branch.trim() || undefined }))}`);
        return;
      }
      if (!response.ok) throw new Error(result.error?.message ?? "Couldn’t create the workspace. Try again.");
      if (!result.workspace?.id) throw new Error("The server didn’t return a workspace. Try again.");
      router.push(`/w/${result.workspace.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn’t create the workspace. Check your connection and try again.");
      setBusy(false);
    }
  }

  const form = <form onSubmit={submit} aria-busy={busy} className="space-y-5">
    <label className="block space-y-2 text-sm">
      <span className="font-medium">GitHub repository</span>
      <input ref={repoInput} required name="repo" value={repo} onChange={(e) => setRepo(e.target.value)}
        placeholder="github.com/owner/repo…" autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={busy}
        aria-describedby={`${id}-privacy${error ? ` ${id}-error` : ""}`} className={FIELD_CLASS} />
    </label>
    {error && <p id={`${id}-error`} role="alert" className="text-sm break-words text-danger">{error}</p>}
    <details className="text-sm text-muted">
      <summary className="w-fit hover:text-text">Choose a branch <span className="text-xs">(optional)</span></summary>
      <label className="mt-3 block space-y-2">
        <span>Branch</span>
        <input name="branch" value={branch} onChange={(e) => setBranch(e.target.value)}
          placeholder="Default branch…" maxLength={255} autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={busy}
          className={FIELD_CLASS} />
      </label>
    </details>
    <p id={`${id}-privacy`} className="text-sm leading-relaxed text-muted">Clones a public repo into your own sandbox. Changes stay in your workspace; they aren’t pushed to GitHub.</p>
    <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
      {modal && <button type="button" disabled={busy} onClick={() => dialog.current?.close()} className={buttonClass()}>Cancel</button>}
      <button type="submit" disabled={busy} className={buttonClass("primary")}>
        {busy && <span aria-hidden="true" className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" />}
        <span aria-live="polite">{busy ? "Creating workspace…" : "Create workspace"}</span>
      </button>
    </div>
  </form>;

  if (!modal) return form;

  return <>
    <button type="button" className={buttonClass("primary")} aria-haspopup="dialog" onClick={(event) => {
      // Safari does not focus clicked buttons; establish the dialog's return target.
      event.currentTarget.focus();
      dialog.current?.showModal();
      if (window.matchMedia("(min-width: 640px) and (pointer: fine)").matches) repoInput.current?.focus();
      else heading.current?.focus();
    }}>New workspace</button>
    <dialog ref={dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
      onCancel={(event) => { if (busy) event.preventDefault(); }}
      className="repo-dialog m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto overscroll-contain rounded-lg border border-line bg-panel p-6 text-text backdrop:bg-black/65">
      <div className="mb-6 space-y-2">
        <h2 ref={heading} id={`${id}-title`} tabIndex={-1} className="text-xl font-medium tracking-tight">New workspace</h2>
        <p id={`${id}-description`} className="text-sm text-muted">Clone a public repository and open it in Zed.</p>
      </div>
      {form}
    </dialog>
  </>;
}
