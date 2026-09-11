import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./editor.css";

/**
 * The editor document links the PWA manifest (b9 §3.31) so the browser offers
 * "install"; it carries no `next/font` and no analytics.
 */
export const metadata: Metadata = {
  title: "Zedspaces",
  icons: { icon: "/icons/zs.svg" },
  manifest: "/manifest.webmanifest",
};

/**
 * Isolated root for `/w/*`: no analytics, next/font, or site CSS.
 * Fonts come from the asset tarball. The page checks the account session.
 */
export default function EditorRootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
