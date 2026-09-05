import { PublicRepoForm } from "../../_components/public-repo-form";
import { PageHeader } from "../../_components/ui";

export default function NewWorkspacePage() {
  return <div className="space-y-6">
    <PageHeader title="Open a public repository" description="A Vercel Sandbox runs your repository; Zed runs in this browser tab." />
    <PublicRepoForm />
  </div>;
}
