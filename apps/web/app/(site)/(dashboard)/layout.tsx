import Link from "next/link";
import type { ReactNode } from "react";
import { NavLink } from "./_components/nav-link";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col font-sans">
      <header className="border-b border-line">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-8 gap-y-5 px-5 py-6 sm:px-8">
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
      <main className="mx-auto w-full max-w-6xl flex-1 space-y-8 px-5 py-10 sm:px-8 sm:py-14">{children}</main>
      <footer className="mx-auto flex w-full max-w-6xl flex-wrap justify-between gap-3 border-t border-line px-5 py-6 text-xs text-muted sm:px-8">
        <span>Built for building together. No login, just a link.</span>
        <div className="flex gap-5">
          <a href="https://events.purduehackers.com" className="hover:text-gold">Meet the hackers ↗</a>
          <a href="https://github.com/purduehackers/zedspaces" className="hover:text-gold">Source ↗</a>
        </div>
      </footer>
    </div>
  );
}
