import { redirect } from "next/navigation";
import { getViewer } from "@/lib/auth";
import { SignIn } from "./_components/account-actions";
import { SiteShell } from "./_components/site-shell";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (await getViewer()) redirect("/workspaces");
  return <SiteShell>
    <div className="my-auto grid gap-10 py-10 md:grid-cols-[1.2fr_1fr] md:gap-16 md:py-20">
      <div className="space-y-6">
        <p className="brand-label text-gold">Purdue Hackers workshops</p>
        <h1 className="max-w-xl text-4xl leading-tight font-medium tracking-tight text-balance sm:text-5xl">Show up.<br />Start making.</h1>
        <p className="max-w-md text-base leading-relaxed text-muted">Your workshop repo, a terminal, and Zed—all in your browser. No local setup.</p>
      </div>
      <section aria-labelledby="get-started" className="self-center rounded-lg border border-line border-t-gold bg-panel p-6 sm:p-8">
        <p className="brand-label mb-4 text-gold">Get started</p>
        <h2 id="get-started" className="text-xl font-medium">Here for a workshop?</h2>
        <p className="mt-2 mb-6 text-sm leading-relaxed text-muted">Open the repo link from your organizer. We’ll make a workspace for your GitHub account.</p>
        <div className="border-t border-line pt-6">
          <p className="mb-4 text-sm text-muted">Already started? Pick up where you left off.</p>
          <SignIn />
        </div>
      </section>
    </div>
  </SiteShell>;
}
