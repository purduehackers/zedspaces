import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClass, Card } from "./_components/ui";

/** Shown when a page calls `notFound()`: an unknown id, or one the viewer may not see. */
export default function DashboardNotFound(): ReactNode {
  return (
    <Card title="Not found">
      <div className="space-y-3">
        <p className="text-sm text-muted">
          This page doesn’t exist, or the workspace has been deleted.
        </p>
        <Link href="/workspaces" className={buttonClass("primary")}>
          Back to workspaces
        </Link>
      </div>
    </Card>
  );
}
