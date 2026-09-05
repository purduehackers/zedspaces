/**
 * Running `"use workflow"` bodies as plain async functions.
 *
 * Under the unit config the Workflow code transform is not applied, so the
 * directives are inert string literals and a workflow body is an ordinary
 * function: exactly the orchestration we want to assert. Only `sleep()` needs
 * help — it looks for the runtime's implementation on `globalThis`.
 */
const WORKFLOW_SLEEP = Symbol.for("WORKFLOW_SLEEP");
type GlobalWithSleep = typeof globalThis & { [WORKFLOW_SLEEP]?: (param: unknown) => Promise<void> };

/** Installs a no-op `sleep()` so polling loops run at full speed. */
export function installSleepShim(): void {
  (globalThis as GlobalWithSleep)[WORKFLOW_SLEEP] = async () => {};
}

/** Removes the shim installed by {@link installSleepShim}. */
export function removeSleepShim(): void {
  delete (globalThis as GlobalWithSleep)[WORKFLOW_SLEEP];
}

/** The fake driver's hostname for a sandbox's supervisor health listener (D21: 8448). */
export function healthHostOf(sandboxName: string): string {
  return `${sandboxName}-8448.fake.vercel.run`;
}
