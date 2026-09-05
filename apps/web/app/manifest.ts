import type { MetadataRoute } from "next";

/**
 * PWA manifest (b9 §3.31, BUILD-SPEC §3.6 "PWA"): installable so the editor
 * gets its own window and icon. `start_url` is the dashboard — a workspace URL
 * would pin one workspace into the installed app. Served at
 * `/manifest.webmanifest`, which `proxy.ts` excludes from the Clerk matcher so
 * the browser can fetch it without a session.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Zedspaces",
    short_name: "Zed",
    description: "Zed in the browser, backed by Vercel Sandbox",
    start_url: "/workspaces",
    scope: "/",
    display: "standalone",
    background_color: "#17181c",
    theme_color: "#17181c",
    orientation: "any",
    icons: [
      { src: "/icons/zs.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/zs-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
