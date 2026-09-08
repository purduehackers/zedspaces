import type { MetadataRoute } from "next";

/**
 * Installable PWA. Start at the dashboard instead of pinning one workspace.
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
