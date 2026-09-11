import type { Metadata } from "next";
import { Space_Grotesk } from "next/font/google";
import type { ReactNode } from "react";
import "../globals.css";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Zedspaces",
  description: "Zed in your browser, backed by Vercel Sandboxes. An open-source development environment for public GitHub repositories.",
  icons: { icon: "/icons/zs.svg" },
};

/** Site root. The isolated editor has its own minimal root layout. */
export default function SiteRootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${spaceGrotesk.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        {children}
      </body>
    </html>
  );
}
