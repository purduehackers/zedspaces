import Link from "next/link";
import type { ReactNode } from "react";
import { NavLink } from "./_components/nav-link";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col font-sans">
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
          <Link href="/" className="text-sm font-semibold tracking-tight">Zedspaces</Link>
          <nav aria-label="Dashboard" className="flex flex-wrap items-center gap-1">
            <NavLink href="/workspaces">Workspaces</NavLink>
            <NavLink href="/repos">Repositories</NavLink>
            <NavLink href="/settings">Settings</NavLink>
          </nav>
          <span className="ml-auto text-xs text-amber-700 dark:text-amber-400">Shared space · no login</span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-4 py-6">{children}</main>
    </div>
  );
}
