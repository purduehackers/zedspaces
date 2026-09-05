#!/usr/bin/env node
// vcr-wait-ready.mjs <repository> <digest> — polls the documented VCR REST endpoint until the
// image reports `ready` (b10 §3.13; BUILD-SPEC risk 7). Needs ZS_VERCEL_TOKEN (or VERCEL_TOKEN),
// VERCEL_PROJECT_ID and VERCEL_TEAM_ID (or VERCEL_ORG_ID). Exits 0 on ready, 1 on unoptimized or
// timeout (default 30 minutes, VCR_READY_BUDGET_MS).
const [repository, digest] = process.argv.slice(2);
if (!repository || !digest) {
  console.error("usage: vcr-wait-ready.mjs <repository> <digest>");
  process.exit(2);
}
const token = process.env.ZS_VERCEL_TOKEN ?? process.env.VERCEL_TOKEN;
const projectId = process.env.VERCEL_PROJECT_ID;
const teamId = process.env.VERCEL_TEAM_ID ?? process.env.VERCEL_ORG_ID;
if (!token || !projectId || !teamId) {
  console.error("ZS_VERCEL_TOKEN/VERCEL_TOKEN, VERCEL_PROJECT_ID and VERCEL_TEAM_ID/VERCEL_ORG_ID are required");
  process.exit(2);
}
const budgetMs = Number(process.env.VCR_READY_BUDGET_MS ?? 30 * 60_000);
const url = `https://api.vercel.com/v1/vcr/repository/${encodeURIComponent(repository)}/images/${encodeURIComponent(digest)}?projectId=${encodeURIComponent(projectId)}&teamId=${encodeURIComponent(teamId)}`;
const deadline = Date.now() + budgetMs;
for (;;) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 404 || res.status === 410) {
    console.log(`${repository}@${digest}: not visible yet`);
  } else if (!res.ok) {
    console.error(`vcr api ${res.status}: ${await res.text()}`);
    process.exit(1);
  } else {
    const body = await res.json();
    const image = body.image ?? body;
    console.log(`${repository}@${digest}: ${image.status ?? "null"}`);
    if (image.status === "ready") process.exit(0);
    if (image.status === "unoptimized") {
      console.error("image is unoptimized (not linux/amd64) and cannot be used in Sandbox");
      process.exit(1);
    }
  }
  if (Date.now() > deadline) {
    console.error("timed out waiting for VCR readiness");
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}
