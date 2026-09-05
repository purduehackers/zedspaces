/**
 * The result shape every dashboard server action returns to `useActionState`
 * (b9 §3.27: the pages act through server actions that call the same `lib/*`
 * functions as the route handlers). It lives in its own module so client
 * components can import the type without pulling in `actions.ts`, which
 * reaches the database.
 */

/** What a form shows after a submit. */
export interface ActionState {
  status: "idle" | "ok" | "error";
  /** Human-readable result; `null` before the first submit. */
  message: string | null;
}

/** The state a form starts in. */
export const IDLE_ACTION: ActionState = { status: "idle", message: null };

/** A server action bound to `useActionState`. */
export type FormAction = (state: ActionState, form: FormData) => Promise<ActionState>;

/** Shorthand for a successful action result. */
export function ok(message: string): ActionState {
  return { status: "ok", message };
}

/** Shorthand for a failed action result. */
export function failed(message: string): ActionState {
  return { status: "error", message };
}
