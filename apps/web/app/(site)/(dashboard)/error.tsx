"use client";

import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import { Alert, buttonClass, Card } from "./_components/ui";

/**
 * Error boundary of the dashboard. Server components throw `ApiError`s from
 * the library layer (a missing workspace, a role the viewer lacks, a GitHub
 * outage); this turns them into something recoverable instead of a blank
 * page. The digest is what correlates with the server log.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactNode {
  useEffect(() => {
    console.error("[dashboard]", error);
  }, [error]);

  return (
    <Card title="Something went wrong">
      <div className="space-y-3">
        <Alert kind="error">{error.message || "The page could not be loaded."}</Alert>
        {error.digest ? (
          <p className="text-xs text-muted">Reference: {error.digest}</p>
        ) : null}
        <div className="flex gap-2">
          <button type="button" className={buttonClass("primary")} onClick={reset}>
            Try again
          </button>
          <Link className={buttonClass()} href="/workspaces">
            Back to workspaces
          </Link>
        </div>
      </div>
    </Card>
  );
}
