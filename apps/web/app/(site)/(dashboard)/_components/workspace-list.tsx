import Link from "next/link";
import type { ReactNode } from "react";
import type { WorkspaceView } from "@/lib/types";
import {
  formatMachine,
  formatRef,
  formatRelative,
  formatRepo,
  STATE_LABELS,
  stateTone,
} from "./format";
import { Badge, buttonClass, EmptyState, TABLE } from "./ui";

/**
 * The workspace list of BUILD-SPEC §7.7: state, repository, branch, machine,
 * region, last active and cost to date. It is a pure component — the page
 * loads the rows through `data.ts` and hands them over — which is what the
 * component test renders.
 */
export function WorkspaceList({
  workspaces,
  now,
}: {
  workspaces: WorkspaceView[];
  /** Reference point for the "last active" column; defaults to now, injected by the tests. */
  now?: number;
}): ReactNode {
  if (workspaces.length === 0) {
    return (
      <EmptyState title="No workspaces yet">
        <p>
          A workspace is a sandbox running your repository with the Zed server inside it.{" "}
          <Link href="/workspaces/new" className="underline underline-offset-2">
            Create your first workspace
          </Link>
          .
        </p>
      </EmptyState>
    );
  }

  return (
    <div className={TABLE.wrapper}>
      <table className={TABLE.table}>
        <caption className="sr-only">Your workspaces</caption>
        <thead>
          <tr>
            <th scope="col" className={TABLE.th}>
              Workspace
            </th>
            <th scope="col" className={TABLE.th}>
              State
            </th>
            <th scope="col" className={TABLE.th}>
              Branch
            </th>
            <th scope="col" className={TABLE.th}>
              Machine
            </th>
            <th scope="col" className={TABLE.th}>
              Last active
            </th>
            <th scope="col" className={TABLE.th}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {workspaces.map((workspace) => (
            <tr key={workspace.id} data-workspace={workspace.id}>
              <td className={TABLE.td}>
                <Link href={`/workspaces/${workspace.id}`} className="font-medium underline-offset-2 hover:underline">
                  {workspace.name}
                </Link>
                <div className="text-xs text-zinc-600 dark:text-zinc-400">{formatRepo(workspace.repo)}</div>
              </td>
              <td className={TABLE.td}>
                <Badge tone={stateTone(workspace.state)}>{STATE_LABELS[workspace.state]}</Badge>
                {workspace.stateReason ? (
                  <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{workspace.stateReason}</div>
                ) : null}
              </td>
              <td className={TABLE.td}>{formatRef(workspace)}</td>
              <td className={TABLE.td}>
                <div>{formatMachine(workspace.machine)}</div>
                <div className="text-xs text-zinc-600 dark:text-zinc-400">{workspace.region}</div>
              </td>
              <td className={TABLE.td}>
                <time dateTime={workspace.lastActiveAt}>{formatRelative(workspace.lastActiveAt, now)}</time>
              </td>
              <td className={TABLE.td}>
                <div className="flex justify-end gap-2">
                  <Link
                    className={buttonClass("primary")}
                    href={`/w/${workspace.id}`}
                    aria-label={`Open ${workspace.name} in the editor`}
                  >
                    Open
                  </Link>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
