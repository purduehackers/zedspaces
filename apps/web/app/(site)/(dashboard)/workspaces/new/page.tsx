import { PublicRepoForm } from "../../_components/public-repo-form";
import { PageHeader } from "../../_components/ui";
import { requirePageViewer } from "@/lib/auth";

export default async function NewWorkspacePage() {
  await requirePageViewer("/workspaces/new");
  return <div className="max-w-lg space-y-6">
    <PageHeader title="New workspace" description="Clone a public repository and open it in Zed." />
    <PublicRepoForm />
  </div>;
}
