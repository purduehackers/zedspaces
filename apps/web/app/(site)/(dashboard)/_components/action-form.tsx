"use client";

import { useActionState, type FormEvent, type ReactNode } from "react";
import { IDLE_ACTION, type FormAction } from "./action-state";
import { Alert, buttonClass } from "./ui";

/**
 * A `<form>` driven by a server action through `useActionState`: it renders
 * the action's message with `role="alert"`, disables its button while the
 * action runs and can ask for confirmation first. Every mutating control in
 * the dashboard is one of these, so the pages keep working without JavaScript
 * (the confirmation is the only progressive-enhancement-only part).
 */
export function ActionForm({
  action,
  submitLabel,
  pendingLabel,
  variant = "secondary",
  confirm,
  fields,
  children,
  className,
  inline = false,
  disabled = false,
}: {
  action: FormAction;
  submitLabel: string;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "danger";
  /** When set, the submit is confirmed with `window.confirm` first. */
  confirm?: string;
  /** Hidden inputs the action needs (ids, scopes). */
  fields?: Record<string, string | number>;
  children?: ReactNode;
  className?: string;
  /** Lay the controls out in a row instead of a column. */
  inline?: boolean;
  /** Keeps the submit disabled (a live image build already owns the action, b10 §3.12). */
  disabled?: boolean;
}): ReactNode {
  const [state, formAction, pending] = useActionState(action, IDLE_ACTION);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    if (confirm && !window.confirm(confirm)) event.preventDefault();
  }

  return (
    <form
      action={formAction}
      onSubmit={onSubmit}
      aria-busy={pending}
      className={className ?? (inline ? "flex flex-wrap items-end gap-3" : "space-y-3")}
    >
      {Object.entries(fields ?? {}).map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      {children}
      <div className={inline ? "" : "flex items-center gap-3"}>
        <button type="submit" className={buttonClass(variant)} disabled={pending || disabled}>
          {pending ? (pendingLabel ?? `${submitLabel}…`) : submitLabel}
        </button>
      </div>
      {state.status !== "idle" && state.message ? (
        <Alert kind={state.status === "ok" ? "success" : "error"}>{state.message}</Alert>
      ) : null}
    </form>
  );
}
