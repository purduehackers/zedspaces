"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-renders the surrounding server component on an interval while a
 * workspace is mid-lifecycle (creating, stopping, rebuilding, deleting), so
 * the state badge and the boot phase follow the workflow without a manual
 * reload. It renders nothing.
 */
export function AutoRefresh({ intervalMs = 5000, enabled = true }: { intervalMs?: number; enabled?: boolean }): null {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs, enabled]);
  return null;
}
