import Link from "next/link";
import { getViewer } from "@/lib/auth";
import { buttonClass } from "./(dashboard)/_components/ui";
import { SiteShell } from "./_components/site-shell";

export const dynamic = "force-dynamic";

export default async function Home() {
  const viewer = await getViewer();
  return <SiteShell>
    <article className="mx-auto w-full max-w-4xl pb-8">
      <header className="brand-grid -mx-5 space-y-6 border-b border-text px-5 py-10 sm:-mx-8 sm:px-8 sm:py-16">
        <p className="brand-label text-accent">An open-source browser workspace</p>
        <h1 className="max-w-3xl font-display text-6xl leading-[0.95] text-balance sm:text-8xl">Zed, in your browser.</h1>
        <p className="max-w-2xl text-lg leading-relaxed text-muted">A cloud development environment with the Zed editor. Open a public GitHub repository and get a real terminal, language tools, and a sandbox of your own—without setting up a local development environment.</p>
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <Link href={viewer ? "/workspaces" : "/login?next=%2Fworkspaces%2Fnew"} className={buttonClass("primary")}>
            {viewer ? "Your workspaces" : "Open a repository"}
          </Link>
          <a href="https://github.com/purduehackers/zedspaces" className={buttonClass()}>View source</a>
        </div>
        <p className="text-sm text-muted">GitHub sign-in · Public repositories · No permission to push code requested</p>
      </header>

      <section aria-labelledby="how-it-works" className="py-8 sm:py-10">
        <h2 id="how-it-works" className="mb-6 font-display text-4xl">How it works</h2>
        <dl className="grid gap-6 sm:grid-cols-2 sm:gap-10">
          <div>
            <dt className="mb-2 font-medium text-accent">The editor runs in your tab.</dt>
            <dd className="leading-relaxed text-muted">Zed’s Rust UI is compiled to WebAssembly. This is Zed running in the browser, not a separate editor made to look like it.</dd>
          </div>
          <div>
            <dt className="mb-2 font-medium text-accent">Your tools run in a sandbox.</dt>
            <dd className="leading-relaxed text-muted">A Vercel Sandbox runs the remote server, Git, terminals, language servers, debugger adapters, and Jupyter kernels.</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="workspace-tools" className="grid gap-4 border-t border-line py-8 sm:grid-cols-[12rem_1fr] sm:gap-10">
        <h2 id="workspace-tools" className="font-display text-4xl">What’s included</h2>
        <div className="space-y-4 leading-relaxed text-muted">
          <p>Public repo cloning, terminals, language support, extensions, debugging, and an inline REPL. Preview running apps through exposed ports, upload files, or export your project as a ZIP.</p>
          <p>Stop and resume your workspaces. Editor updates download in the background and preserve your files when you restart.</p>
          <p className="text-sm">Workspaces belong to your account. Preview ports are public. Private repositories, AI assistants, and calls aren’t included.</p>
        </div>
      </section>

      <section aria-labelledby="open-source" className="grid gap-4 border-t border-line py-8 sm:grid-cols-[12rem_1fr] sm:gap-10">
        <h2 id="open-source" className="font-display text-4xl">Run your own</h2>
        <div className="space-y-4 leading-relaxed text-muted">
          <p>The web app and sandbox supervisor are MIT licensed; the Zed fork retains its own licenses. The control plane uses Next.js, Drizzle, and SQLite on Turso. Fork the project and deploy it to your own Vercel account.</p>
          <a href="https://github.com/purduehackers/zedspaces#deploy-your-fork" className="inline-block text-text underline decoration-line underline-offset-4 hover:text-accent">Read the setup guide</a>
        </div>
      </section>
    </article>
  </SiteShell>;
}
