"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { workshopPath, type Workshop } from "@/lib/workshop";
import { buttonClass } from "../../../(dashboard)/_components/ui";

export function StartWorkshop({ workshop, account }: { workshop: Workshop; account: string }) {
  const [error, setError] = useState<string | null>(null);
  const [signInRequired, setSignInRequired] = useState(false);
  const pending = useRef(false);
  const body = JSON.stringify(workshop);
  const start = useCallback(() => {
    if (pending.current) return;
    pending.current = true;
    fetch("/api/workshops", { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(45_000) }).then(async (response) => {
      const result = await response.json().catch(() => null);
      if (response.status === 401) setSignInRequired(true);
      if (!response.ok) throw new Error(result?.error?.message ?? "Couldn’t start your workspace. Try again.");
      if (!result?.workspace?.id) throw new Error("Couldn’t find your workspace. Try again.");
      window.location.replace(`/w/${result.workspace.id}`);
    }).catch((err: unknown) => {
      setError(err instanceof Error && err.name !== "TimeoutError" ? err.message : "That took too long. Check your connection and try again.");
      pending.current = false;
    });
  }, [body]);
  useEffect(() => { void start(); }, [start]);

  return <div className="space-y-4">
    {error ? <>
      <p role="alert" className="rounded border border-danger/30 bg-danger/5 p-4 text-sm text-danger">{error}</p>
      {signInRequired ? <Link className={`${buttonClass("primary")} w-full`} href={`/login?next=${encodeURIComponent(workshopPath(workshop))}`}>Sign in again</Link>
        : <button type="button" className={`${buttonClass("primary")} w-full`} onClick={() => {
          setError(null); setSignInRequired(false); void start();
        }}>Try again</button>}
    </> : <div role="status" className="flex items-center gap-3 rounded border border-gold/25 bg-gold/5 p-4 text-sm">
      <span aria-hidden="true" className="size-4 shrink-0 animate-spin rounded-full border-2 border-gold border-r-transparent" />
      <div><p>Getting your workspace ready…</p><p className="mt-1 text-xs text-muted">We’ll open Zed as soon as it’s ready.</p></div>
    </div>}
    <p className="text-xs text-muted">Signed in as <span className="text-text">{account}</span>. Opening this link again returns to the same workspace.</p>
  </div>;
}
