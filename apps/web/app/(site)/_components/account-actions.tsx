"use client";

import { createAuthClient } from "better-auth/react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { buttonClass } from "../(dashboard)/_components/ui";

const auth = createAuthClient();

export function SignIn({ returnTo = "/workspaces", label = "Continue with GitHub" }: { returnTo?: string; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function signIn() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const errorURL = new URL(returnTo.startsWith("/new/") ? returnTo : `/login?next=${encodeURIComponent(returnTo)}`, window.location.origin);
      errorURL.searchParams.set("authError", "1");
      const result = await auth.signIn.social({ provider: "github", callbackURL: returnTo, errorCallbackURL: errorURL.pathname + errorURL.search });
      if (result.error) throw new Error("Couldn’t connect to GitHub. Try again in a moment.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn’t connect to GitHub. Check your connection and try again.");
      setBusy(false);
    }
  }
  return <div className="space-y-3">
    <button type="button" onClick={signIn} disabled={busy} className={`${buttonClass("primary")} w-full`}>
      <GitHubIcon /><span>{busy ? "Connecting to GitHub…" : label}</span>
    </button>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </div>;
}

export function SignOut() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return <div className="flex items-center gap-2">
    {failed && <span role="alert" className="text-xs text-danger">Try again</span>}
    <button type="button" disabled={busy} className="brand-label px-3 py-2 text-text hover:bg-raised hover:text-yellow disabled:opacity-50" onClick={async () => {
      setBusy(true);
      setFailed(false);
      try {
        const result = await auth.signOut();
        if (result.error) throw new Error();
        router.replace("/");
        router.refresh();
      } catch { setFailed(true); setBusy(false); }
    }}>{busy ? "Signing out…" : "Sign out"}</button>
  </div>;
}

function GitHubIcon() {
  return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-4 shrink-0"><path d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.68.08-.68 1.13.08 1.72 1.16 1.72 1.16 1 1.71 2.62 1.22 3.26.93.1-.73.39-1.22.71-1.5-2.5-.28-5.13-1.25-5.13-5.56 0-1.23.44-2.23 1.16-3.02-.12-.28-.5-1.43.11-2.98 0 0 .95-.3 3.1 1.15a10.78 10.78 0 0 1 5.64 0c2.15-1.45 3.1-1.15 3.1-1.15.61 1.55.23 2.7.11 2.98.72.79 1.16 1.79 1.16 3.02 0 4.32-2.63 5.28-5.14 5.56.4.35.76 1.03.76 2.08v3.09c0 .3.2.65.77.54A11.25 11.25 0 0 0 12 .75Z" /></svg>;
}
