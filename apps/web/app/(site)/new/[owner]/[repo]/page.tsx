import { notFound } from "next/navigation";
import Link from "next/link";
import { getViewer } from "@/lib/auth";
import { workshopInput, workshopPath } from "@/lib/workshop";
import { SignIn } from "../../../_components/account-actions";
import { SiteShell } from "../../../_components/site-shell";
import { StartWorkshop } from "./start-workshop";

export const dynamic = "force-dynamic";
export default async function WorkshopPage({ params, searchParams }: {
  params: Promise<{ owner: string; repo: string }>;
  searchParams: Promise<{ branch?: string; authError?: string }>;
}) {
  const query = await searchParams;
  const input = workshopInput.safeParse({ ...await params, branch: query.branch });
  if (!input.success) notFound();
  const workshop = input.data;
  const viewer = await getViewer();
  return <SiteShell><section aria-labelledby="workshop-title" className="mx-auto my-auto w-full max-w-lg py-8 sm:py-12">
    <p className="brand-label mb-5 text-gold">Open a repository</p>
    <h1 id="workshop-title" className="text-3xl font-medium tracking-tight text-balance">Open this repo in Zed.</h1>
    <p className="mt-3 text-base leading-relaxed text-muted">Clone it into your own sandbox and start coding in your browser.</p>
    <div className="my-7 rounded-lg border border-line bg-panel px-5 py-4">
      <p className="text-xs text-muted">Public GitHub repository</p>
      <a href={`https://github.com/${encodeURIComponent(workshop.owner)}/${encodeURIComponent(workshop.repo)}`} className="mt-1 block break-all text-lg font-medium hover:text-gold" target="_blank" rel="noreferrer" translate="no">{workshop.owner}<span className="mx-1 text-muted">/</span>{workshop.repo} <span className="text-sm text-muted" aria-hidden="true">↗</span></a>
      {workshop.branch && <p className="mt-2 break-all text-xs text-muted" translate="no">Branch: {workshop.branch}</p>}
    </div>
    {viewer ? <StartWorkshop workshop={workshop} account={viewer.name} /> : <div className="space-y-4">
      {query.authError && <p role="alert" className="text-sm text-danger">GitHub sign-in wasn’t completed. Try again to start your workspace.</p>}
      <SignIn returnTo={workshopPath(workshop)} label="Sign in with GitHub to start" />
      <p className="text-xs leading-relaxed text-muted">We’ll clone this public repo into a workspace for your account. No access to private repos or permission to push code is requested.</p>
    </div>}
    <Link href="/workspaces" className="mt-8 inline-block text-sm text-muted hover:text-gold">← Your workspaces</Link>
  </section></SiteShell>;
}
