import { PublicRepoForm } from "../_components/public-repo-form";
import { Card, EmptyState, PageHeader } from "../_components/ui";
import { dashboardViewer, listRegisteredRepos } from "../data";

export const dynamic = "force-dynamic";

export default async function ReposPage() {
  await dashboardViewer();
  const repos = await listRegisteredRepos();
  return <div className="space-y-6">
    <PageHeader title="Repositories" description="Public GitHub repositories opened in this space." />
    <PublicRepoForm />
    {repos.length ? <Card title="Previously opened">
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {repos.map((repo) => <li key={repo.id} className="flex items-center justify-between gap-4 py-3">
          <a href={`https://github.com/${repo.owner}/${repo.name}`} className="underline underline-offset-2">
            {repo.owner}/{repo.name}
          </a>
          <span className="text-sm text-zinc-500">{repo.defaultBranch}</span>
          <form action={`/new/${repo.owner}/${repo.name}`} method="get">
            <button className="rounded border px-3 py-1 text-sm">Open workspace</button>
          </form>
        </li>)}
      </ul>
    </Card> : <EmptyState title="No repositories yet">Open a public GitHub repository above.</EmptyState>}
  </div>;
}
