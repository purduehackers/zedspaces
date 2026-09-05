import { EDITOR_COOKIE, mintEditorCookie } from "@/lib/editor-cookie";

/** Request building and response reading for the route tests. */

/** Origin the tests build absolute URLs against (matches `ZS_CONTROL_URL` in setup). */
export const TEST_ORIGIN = "https://zs.test";

/** Options of {@link req}. */
export interface RequestOptions {
  /** JSON body; strings are sent verbatim so a test can send malformed JSON. */
  body?: unknown;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  /** `Authorization: Bearer <bearer>`. */
  bearer?: string;
}

/** Builds a `Request` for a route handler. */
export function req(method: string, path: string, opts: RequestOptions = {}): Request {
  const headers = new Headers(opts.headers);
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
  if (opts.cookies) {
    const jar = Object.entries(opts.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    headers.set("cookie", jar);
  }
  return new Request(`${TEST_ORIGIN}${path}`, { method, headers, body });
}

/** The `{ params }` context Next hands a dynamic route handler. */
export function ctx<P>(params: P): { params: Promise<P> } {
  return { params: Promise.resolve(params) };
}

/** Parses a JSON response body. */
export async function jsonBody<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** The `{ error: { code, message } }` body of a failed response. */
export async function errorBody(res: Response): Promise<{ code: string; message: string; details?: unknown }> {
  const parsed = (await res.json()) as { error: { code: string; message: string; details?: unknown } };
  return parsed.error;
}

/** A cookie jar carrying a valid `zs_editor` cookie for `(userId, workspaceId)`. */
export async function editorCookieFor(userId: string, workspaceId: string): Promise<Record<string, string>> {
  const { value } = await mintEditorCookie(userId, workspaceId);
  return { [EDITOR_COOKIE]: value };
}

const COOKIE_KEY = "__zsRequestCookies";
type GlobalWithCookies = typeof globalThis & { [COOKIE_KEY]?: Record<string, string> };

/**
 * `next/headers`' `cookies()` only works inside a Next request scope, so route
 * tests install a stand-in:
 *
 * ```ts
 * vi.mock("next/headers", async () => (await import("../helpers/request")).createHeadersMock());
 * ```
 *
 * and call {@link setRequestCookies} with the same jar they pass to {@link req}.
 */
export function createHeadersMock(): Record<string, unknown> {
  return {
    cookies: async () => ({
      get: (name: string) => {
        const value = (globalThis as GlobalWithCookies)[COOKIE_KEY]?.[name];
        return value === undefined ? undefined : { name, value };
      },
    }),
    headers: async () => new Headers(),
  };
}

/** Sets the cookies the mocked `cookies()` sees. */
export function setRequestCookies(jar: Record<string, string>): void {
  (globalThis as GlobalWithCookies)[COOKIE_KEY] = { ...jar };
}

/** Clears the cookies the mocked `cookies()` sees. */
export function clearRequestCookies(): void {
  (globalThis as GlobalWithCookies)[COOKIE_KEY] = {};
}
