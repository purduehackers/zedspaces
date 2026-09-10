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
  const active = pathname === href || pathname.startsWith(`${href}/`) || (href === "/workspaces" && pathname === "/");
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`brand-label border-b-2 px-3 py-2 transition-colors hover:text-gold ${
        active ? "border-gold text-gold" : "border-transparent text-muted"
      }`}
    >
      {children}
    </Link>
  );
}
