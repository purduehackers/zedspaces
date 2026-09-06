/**
 * Build-id comparison shared by the workflows and the routes. Kept free of
 * imports so the workflow bundle can use it without pulling the database or
 * token code into the deterministic workflow VM.
 */

/**
 * b1's `builds_compatible`: exact match unless either side is a dev build
 * (`"dev"` prefix or no build id at all) (CONTRACTS.md §1.1).
 */
export function buildsCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return true;
  if (a === b) return true;
  return a.startsWith("dev") || b.startsWith("dev");
}

/** Browser, server and sandbox image move together as one release. */
export interface EditorRelease {
  imageRef: string;
  serverBuild: string;
  clientBuild: string;
}

export function sameRelease(a: EditorRelease, b: EditorRelease): boolean {
  return a.imageRef === b.imageRef && a.serverBuild === b.serverBuild && a.clientBuild === b.clientBuild;
}
