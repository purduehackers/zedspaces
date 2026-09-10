import { PublicRepoForm } from "../_components/public-repo-form";
import { EmptyState, PageHeader } from "../_components/ui";
import { dashboardViewer, listRegisteredRepos } from "../data";

export const dynamic = "force-dynamic";

export default async function ReposPage() {
  await dashboardViewer();
  const repos = await listRegisteredRepos();
  return <div className="space-y-6">
    <PageHeader title="Repositories" description="Public repositories opened in Zedspaces." actions={<PublicRepoForm modal />} />
    {repos.length ? <div className="table-scroll" tabIndex={0} role="region" aria-label="Repository list">
      <table className="data-table min-w-[32rem]">
        <caption className="sr-only">Previously opened repositories</caption>
        <thead><tr><th scope="col">Repository</th><th scope="col">Default branch</th><th scope="col" className="text-right">Actions</th></tr></thead>
        <tbody>{repos.map((repo) => <tr key={repo.id}>
          <th scope="row" className="w-full font-medium">
            <a href={`https://github.com/${repo.owner}/${repo.name}`} className="table-name" title={`${repo.owner}/${repo.name}`} translate="no">{repo.owner}/{repo.name}</a>
          </th>
          <td><span className="block max-w-44 truncate" title={repo.defaultBranch} translate="no">{repo.defaultBranch}</span></td>
          <td className="text-right whitespace-nowrap">
            <form action={`/new/${repo.owner}/${repo.name}`} method="get">
              <button className="table-action rounded border border-line px-3 hover:border-muted hover:bg-raised" aria-label={`Create workspace from ${repo.owner}/${repo.name}`}>New workspace</button>
            </form>
          </td>
        </tr>)}</tbody>
      </table>
    </div> : <EmptyState title="No repositories yet">Select New workspace to open a public GitHub repository.</EmptyState>}
  </div>;
}
