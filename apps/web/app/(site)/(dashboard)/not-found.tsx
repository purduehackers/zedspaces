import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClass, Card } from "./_components/ui";

/** Shown when a page calls `notFound()`: an unknown id, or one the viewer may not see. */
export default function DashboardNotFound(): ReactNode {
  return (
    <Card title="Not found">
      <div className="space-y-3">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          This page does not exist, or your account cannot see it.
        </p>
        <Link href="/workspaces" className={buttonClass("primary")}>
          Back to workspaces
        </Link>
      </div>
    </Card>
  );
}
