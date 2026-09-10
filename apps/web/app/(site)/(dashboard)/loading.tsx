import type { ReactNode } from "react";
import { Skeleton } from "./_components/ui";

/** Shown while a dashboard page's server components resolve. */
export default function DashboardLoading(): ReactNode {
  return (
    <div className="space-y-4" role="status" aria-live="polite" aria-busy="true">
      <p className="brand-label text-gold">Loading your shared space…</p>
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-72" />
      <div className="space-y-2 pt-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}
