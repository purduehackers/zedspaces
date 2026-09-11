/** Compare browser-facing headers; Next dev rewrites 127.0.0.1 in request.url. */
export function originMatchesHost(headers: Headers): boolean {
  const origin = headers.get("origin");
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) && url.host === headers.get("host");
  } catch { return false; }
}
