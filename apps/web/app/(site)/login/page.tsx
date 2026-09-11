import { redirect } from "next/navigation";
import { getViewer } from "@/lib/auth";
import { safeReturnPath } from "@/lib/workshop";
import { SignIn } from "../_components/account-actions";
import { SiteShell } from "../_components/site-shell";

export const dynamic = "force-dynamic";
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; authError?: string }> }) {
  const query = await searchParams;
  const returnTo = safeReturnPath(query.next);
  if (await getViewer()) redirect(returnTo);
  return <SiteShell><section className="mx-auto my-auto w-full max-w-md space-y-5 rounded-lg border border-line border-t-gold bg-panel p-6 sm:p-8">
    <p className="brand-label text-gold">Your workspace is waiting</p>
    <h1 className="text-2xl font-medium tracking-tight">Sign in to Zedspaces</h1>
    <p className="text-sm leading-relaxed text-muted">Use your GitHub account to create and manage your workspaces.</p>
    {query.authError && <p role="alert" className="text-sm text-danger">GitHub sign-in wasn’t completed. You can try again below.</p>}
    <SignIn returnTo={returnTo} />
    <p className="text-xs leading-relaxed text-muted">We use GitHub for your identity. We don’t request access to private repositories or permission to push code.</p>
  </section></SiteShell>;
}
