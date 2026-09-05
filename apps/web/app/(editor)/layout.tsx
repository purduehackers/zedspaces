import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./editor.css";

/**
 * The editor document links the PWA manifest (b9 §3.31) so the browser offers
 * "install"; it carries no `next/font` and no analytics.
 */
export const metadata: Metadata = {
  title: "Zed Codespaces",
  manifest: "/manifest.webmanifest",
};

/**
 * Root layout #2 for `/w/*`: no ClerkProvider, no analytics, no next/font
 * (fonts come from the asset tarball) and no globals.css (b9 §3.26). The
 * editor page authenticates with the `zs_editor` cookie minted by proxy.ts.
 */
export default function EditorRootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
