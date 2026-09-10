import { PublicRepoForm } from "../../_components/public-repo-form";
import { PageHeader } from "../../_components/ui";

export default function NewWorkspacePage() {
  return <div className="max-w-lg space-y-6">
    <PageHeader title="New workspace" description="Clone a public repository and open it in Zed." />
    <PublicRepoForm />
  </div>;
}
