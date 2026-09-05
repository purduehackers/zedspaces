/* Placeholder for a real wasm bundle (see ../README.md).
 *
 * It exports the shape of `zed_web.js` that `loader.ts` expects and marks
 * itself with `zsStub`, which the loader turns into the `bundle_not_built`
 * state instead of a blank canvas. Overwrite this directory with a real
 * bundle to boot the editor.
 */

export const zsStub = true;

const NOT_BUILT = "The editor bundle for this build was not produced; see public/editor/README.md.";

function failure() {
  return Object.assign(new Error(NOT_BUILT), { code: "bundle_not_built", message: NOT_BUILT });
}

export default async function init() {
  throw failure();
}

export async function start() {
  throw failure();
}

export async function flush_client_state() {}

export function set_hidden() {}

export function has_unsaved_changes() {
  return false;
}

export function build_id() {
  return "dev-0";
}
