import Link from "next/link";
import type { ReactNode } from "react";
import { NavLink } from "./_components/nav-link";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col font-sans">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-10 focus:bg-ink focus:px-5 focus:py-3">Skip to content</a>
      <header className="border-b border-line">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-8 gap-y-3 px-5 py-4 sm:px-8">
          <div>
            <a href="https://purduehackers.com" className="brand-label block text-muted hover:text-gold">Purdue Hackers /</a>
            <Link href="/" className="brand-wordmark">zedspaces</Link>
          </div>
          <nav aria-label="Dashboard" className="flex flex-wrap items-center gap-1">
            <NavLink href="/workspaces">Workspaces</NavLink>
            <NavLink href="/repos">Repositories</NavLink>
            <NavLink href="/settings">Settings</NavLink>
          </nav>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-5 py-8 sm:px-8">{children}</main>
      <footer className="mx-auto flex w-full max-w-6xl flex-wrap justify-between gap-3 border-t border-line px-5 py-6 text-xs text-muted sm:px-8">
        <span>Shared workspaces. No login required.</span>
        <div className="flex gap-5">
          <a href="https://events.purduehackers.com" className="hover:text-gold">Events ↗</a>
          <a href="https://github.com/purduehackers/zedspaces" className="hover:text-gold">Source ↗</a>
        </div>
      </footer>
    </div>
  );
}
