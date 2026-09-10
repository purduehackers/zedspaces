import { PublicRepoForm } from "../_components/public-repo-form";
import { buttonClass, Card, EmptyState, PageHeader } from "../_components/ui";
import { dashboardViewer, listRegisteredRepos } from "../data";

export const dynamic = "force-dynamic";

export default async function ReposPage() {
  await dashboardViewer();
  const repos = await listRegisteredRepos();
  return <div className="space-y-6">
    <PageHeader title="Repositories" description="Public GitHub repositories opened in this space." />
    <PublicRepoForm />
    {repos.length ? <Card title="Previously opened">
      <ul className="divide-y divide-line">
        {repos.map((repo) => <li key={repo.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
          <div className="min-w-0 flex-1">
          <a href={`https://github.com/${repo.owner}/${repo.name}`} className="text-sm break-all hover:text-gold">
            {repo.owner}/{repo.name}
          </a>
          <p className="mt-1 text-xs break-all text-muted">{repo.defaultBranch}</p>
          </div>
          <form action={`/new/${repo.owner}/${repo.name}`} method="get">
            <button className={buttonClass()}>New workspace →</button>
          </form>
        </li>)}
      </ul>
    </Card> : <EmptyState title="No repositories yet">Open a public GitHub repository above.</EmptyState>}
  </div>;
}
