import type { VercelConfig } from "@vercel/config/v1";

/**
 * Project configuration Vercel reads from the built project root (`apps/web`).
 * Per-route `maxDuration` is declared with the Next route-segment export, not
 * through `functions` globs; COOP/COEP/CORP headers live in `next.config.ts`
 * so `next dev` honours them too. This configuration requires Vercel Pro
 * (minute sweep cron). The app itself is deliberately login-free.
 */
export const config: VercelConfig = {
  framework: "nextjs",
  crons: [
    { path: "/api/cron/sweep", schedule: "* * * * *" },
    { path: "/api/cron/gc", schedule: "17 3 * * *" },
  ],
};

export default config;
