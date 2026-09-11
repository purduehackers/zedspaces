import Link from "next/link";
import { getViewer } from "@/lib/auth";
import { buttonClass } from "./(dashboard)/_components/ui";
import { SiteShell } from "./_components/site-shell";

export const dynamic = "force-dynamic";

export default async function Home() {
  const viewer = await getViewer();
  return <SiteShell reading>
    <article className="project-readme">
      <h1>Zedspaces</h1>
      <p>Zedspaces runs the <a href="https://zed.dev">Zed editor</a> in your browser. A <a href="https://vercel.com/docs/vercel-sandbox">Vercel Sandbox</a>, an isolated Linux environment, runs your development tools.</p>

      <section aria-labelledby="open-a-repository">
        <h2 id="open-a-repository">Open a repository</h2>
        <p>Sign in with GitHub and choose a public repository. Zedspaces clones it into a workspace owned by your account.</p>
        <Link href={viewer ? "/workspaces" : "/login?next=%2Fworkspaces%2Fnew"} className={buttonClass("primary")}>
          {viewer ? "Your workspaces" : "Open a repository"}
        </Link>
        <p>To open a repository directly, replace <code>repo_owner</code> and <code>repo_name</code> in this path:</p>
        <pre><code className="language-text">/new/repo_owner/repo_name</code></pre>
        <p>Add <code>?branch=branch_name</code> to choose a branch. Reopening the same link returns to your existing workspace.</p>
      </section>

      <section aria-labelledby="supported-features">
        <h2 id="supported-features">Supported features</h2>
        <p>The browser workspace includes:</p>
        <ul>
          <li><strong>Editor</strong>: syntax highlighting, language servers, and extensions</li>
          <li><strong>Tools</strong>: terminals, debugging, and interactive code execution with Jupyter kernels</li>
          <li><strong>Files</strong>: uploads, project exports as ZIP archives, and app previews</li>
          <li><strong>Workspaces</strong>: stop, resume, and editor updates that preserve your files</li>
        </ul>
      </section>

      <section aria-labelledby="access-and-limits">
        <h2 id="access-and-limits">Access and limits</h2>
        <p>You can clone public repositories only. GitHub sign-in doesn’t grant permission to push code, and Zedspaces doesn’t push your edits.</p>
        <p>Your workspace belongs to your account, but app previews are public. Don’t expose secrets through preview ports.</p>
        <p>Calls and built-in coding assistants aren’t included. Accessibility support is incomplete.</p>
      </section>

      <section aria-labelledby="self-hosting">
        <h2 id="self-hosting">Self-hosting</h2>
        <p>The web app runs on Next.js and stores data in SQLite on Turso. Production workspaces run on Vercel Sandboxes.</p>
        <p>For local use, <code>pnpm dev:docker</code> runs workspaces in Docker containers with a local SQLite database. See the <a href="https://github.com/purduehackers/zedspaces#run-locally-with-docker">Docker setup instructions</a>.</p>
        <p>See the <a href="https://github.com/purduehackers/zedspaces#deploy-your-fork">deployment instructions</a> or browse the <a href="https://github.com/purduehackers/zedspaces">source code</a>.</p>
      </section>
    </article>
  </SiteShell>;
}
