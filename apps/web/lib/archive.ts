/**
 * Naming of the rebuild tarball in the blob store (D9, b9 §4.7).
 *
 * This module deliberately has no imports: the rebuild step runs inside the
 * Workflow step bundle without needing control-plane clients.
 */

/**
 * `rebuild/<workspace>/<unix ms>-<sha256>.tgz`, or `rebuild/<workspace>/<unix
 * ms>.tgz` when no digest could be computed. The digest travels in the
 * pathname because `workspaces` keeps only the pathname column (b9 §4.1); a
 * missing digest means "do not verify", never a fake one.
 */
export function blobPathnameFor(workspaceId: string, at: number, sha256: string | null): string {
  return sha256 ? `rebuild/${workspaceId}/${at}-${sha256}.tgz` : `rebuild/${workspaceId}/${at}.tgz`;
}

/** The sha256 encoded into a {@link blobPathnameFor} pathname, or `null`. */
export function sha256FromBlobPathname(pathname: string): string | null {
  const match = /-([0-9a-f]{64})\.tgz$/.exec(pathname);
  return match ? match[1] : null;
}
