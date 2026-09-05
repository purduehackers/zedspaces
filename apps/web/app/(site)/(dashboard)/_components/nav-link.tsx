"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * A navigation link that marks itself `aria-current="page"` when the route it
 * points at is the one being shown.
 */
export function NavLink({ href, children }: { href: string; children: ReactNode }): ReactNode {
  const pathname = usePathname();
  const active = pathname === href || (href !== "/workspaces" && pathname?.startsWith(`${href}/`)) === true;
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-md px-2 py-1 text-sm transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
        active ? "bg-zinc-100 font-medium dark:bg-zinc-800" : "text-zinc-600 dark:text-zinc-400"
      }`}
    >
      {children}
    </Link>
  );
}
