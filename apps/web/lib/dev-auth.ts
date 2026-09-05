/** Origin protection for the local process backend, independent of user login. */
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** True for `localhost`, `127.0.0.0/8` and `::1`, with or without a port. */
export function isLoopbackHost(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch {
    return false;
  }
  return LOOPBACK_NAMES.has(hostname) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Why a request must not be answered as the dev user, or `null` when it may.
 *
 * Dev auth authenticates *every* request, so it is only safe for requests no
 * other origin can make. Three checks, all on the raw request headers:
 *
 * - `Host` must be a loopback name. A LAN peer reaches a `next dev` bound to
 *   every interface under the machine's address, and a DNS-rebinding page
 *   under its own name; both are refused.
 * - `Sec-Fetch-Site`, when a browser sends it, must be `none` (a typed URL) or
 *   `same-origin`. `cross-site` is another site's page; `same-site` is another
 *   port on localhost, which is a different origin with the same reach.
 * - `Origin`, when sent (every CORS-mode fetch, form post and server action),
 *   must be the loopback origin itself, i.e. its host equals `Host`.
 *
 * Node's `fetch` and `curl` send none of the fetch-metadata headers and a
 * loopback `Host`, so scripts and the e2e suite pass; a `no-cors` POST from a
 * web page carries `Sec-Fetch-Site: cross-site` and `Origin` and is refused.
 */
export function devRequestRefusal(headers: Headers): string | null {
  const host = headers.get("host");
  if (!isLoopbackHost(host)) return `dev auth answers loopback requests only (Host: ${host ?? "(none)"})`;
  const site = headers.get("sec-fetch-site");
  if (site && site !== "none" && site !== "same-origin") return `dev auth refuses ${site} requests (Sec-Fetch-Site)`;
  const origin = headers.get("origin");
  if (origin !== null) {
    let originHost: string | null = null;
    try {
      const url = new URL(origin);
      originHost = url.protocol === "http:" || url.protocol === "https:" ? url.host : null;
    } catch {
      originHost = null;
    }
    if (originHost === null || originHost !== host) return `dev auth refuses requests from origin ${origin}`;
  }
  return null;
}
