import Link from "next/link";
import type { ReactNode } from "react";
import { getViewer } from "@/lib/auth";
import { NavLink } from "../(dashboard)/_components/nav-link";
import { SignOut } from "./account-actions";

export async function SiteShell({ children }: { children: ReactNode }) {
  const viewer = await getViewer();
  return <div className="flex min-h-full flex-1 flex-col font-sans">
    <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-10 focus:bg-ink focus:px-5 focus:py-3">Skip to content</a>
    <header className="border-b border-text">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-8 gap-y-3 px-5 py-4 sm:px-8">
        <Link href="/" className="flex items-baseline" aria-label="Zedspaces home">
          <span className="brand-wordmark">zedspaces</span>
        </Link>
        {viewer ? <div className="flex flex-wrap items-center gap-4">
          <nav aria-label="Dashboard" className="flex items-center gap-1">
            <NavLink href="/workspaces">Workspaces</NavLink><NavLink href="/settings">Settings</NavLink>
          </nav>
          <div className="flex items-center border-l border-line pl-4">
            <span className="max-w-40 truncate text-sm text-muted" title={viewer.name}>{viewer.name}</span>
            <SignOut />
          </div>
        </div> : <Link href="/login" className="brand-label px-3 py-2 text-text hover:bg-text hover:text-yellow">Sign in</Link>}
      </div>
    </header>
    <main id="main" className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 py-8 sm:px-8">{children}</main>
    <footer className="bg-text text-ink">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap justify-between gap-3 px-5 py-6 font-mono text-sm sm:px-8">
        <span>Built by <a href="https://purduehackers.com" className="text-yellow underline-offset-4 hover:underline">Purdue Hackers</a> and contributors.</span>
        <div className="flex gap-5"><a href="https://github.com/purduehackers/zedspaces#readme" className="hover:text-yellow">README</a><a href="https://github.com/purduehackers/zedspaces" className="hover:text-yellow">Source</a></div>
      </div>
    </footer>
  </div>;
}
