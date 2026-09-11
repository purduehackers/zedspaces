import Link from "next/link";
import type { ReactNode } from "react";
import { getViewer } from "@/lib/auth";
import { NavLink } from "../(dashboard)/_components/nav-link";
import { SignOut } from "./account-actions";

export async function SiteShell({ children }: { children: ReactNode }) {
  const viewer = await getViewer();
  return <div className="flex min-h-full flex-1 flex-col font-sans">
    <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-10 focus:bg-ink focus:px-5 focus:py-3">Skip to content</a>
    <header className="border-b border-line">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-8 gap-y-3 px-5 py-4 sm:px-8">
        <Link href="/" className="flex items-baseline gap-3" aria-label="Purdue Hackers Zedspaces home">
          <span className="brand-wordmark">zedspaces</span><span className="brand-label hidden text-muted sm:inline">by Purdue Hackers</span>
        </Link>
        {viewer ? <div className="flex flex-wrap items-center gap-4">
          <nav aria-label="Dashboard" className="flex items-center gap-1">
            <NavLink href="/workspaces">Workspaces</NavLink><NavLink href="/settings">Settings</NavLink>
          </nav>
          <div className="flex items-center border-l border-line pl-4">
            <span className="max-w-40 truncate text-sm text-muted" title={viewer.name}>{viewer.name}</span>
            <SignOut />
          </div>
        </div> : <Link href="/login" className="rounded px-3 py-2 text-sm text-muted hover:bg-raised hover:text-text">Sign in</Link>}
      </div>
    </header>
    <main id="main" className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 py-8 sm:px-8">{children}</main>
    <footer className="mx-auto flex w-full max-w-6xl flex-wrap justify-between gap-3 border-t border-line px-5 py-5 text-xs text-muted sm:px-8">
      <a href="https://purduehackers.com" className="hover:text-gold">A place to learn by making.</a>
      <div className="flex gap-5"><a href="https://events.purduehackers.com" className="hover:text-gold">Workshops ↗</a><a href="https://github.com/purduehackers/zedspaces" className="hover:text-gold">Source ↗</a></div>
    </footer>
  </div>;
}
