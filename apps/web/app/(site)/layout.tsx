import type { Metadata } from "next";
import type { ReactNode } from "react";
import "../globals.css";

export const metadata: Metadata = {
  title: "Zedspaces",
  description: "Zed in your browser, backed by Vercel Sandboxes. An open-source development environment for public GitHub repositories.",
  icons: { icon: "/icons/zs.svg" },
};

/** Site root. The isolated editor has its own minimal root layout. */
export default function SiteRootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {children}
      </body>
    </html>
  );
}
