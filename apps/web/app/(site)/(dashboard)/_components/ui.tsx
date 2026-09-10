import { cloneElement, isValidElement, type ReactNode } from "react";
import type { Tone } from "./format";

/** Shared button classes, so every action in the dashboard looks the same. */
export const BUTTON = {
  base: "inline-flex min-h-10 items-center justify-center gap-2 rounded border px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
  primary:
    "border-gold bg-gold text-ink hover:border-gold-hover hover:bg-gold-hover",
  secondary:
    "border-line bg-transparent text-text hover:border-muted hover:bg-raised",
  danger:
    "border-danger/40 bg-transparent text-danger hover:bg-danger/10",
} as const;

/** `className` of a button in the given variant. */
export function buttonClass(variant: "primary" | "secondary" | "danger" = "secondary"): string {
  return `${BUTTON.base} ${BUTTON[variant]}`;
}

/** Shared classes of every text input, select and textarea. */
export const FIELD_CLASS =
  "min-h-10 w-full rounded border border-line bg-ink px-3 py-2 text-sm text-text placeholder:text-muted disabled:opacity-50";

/** The title block at the top of a page. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 space-y-3">
        <h1 className="text-3xl font-medium tracking-tight break-words sm:text-4xl">{title}</h1>
        {description ? <p className="max-w-2xl text-sm leading-relaxed text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** A bordered panel; `title` becomes the accessible name of its `<section>`. */
export function Card({
  title,
  description,
  actions,
  children,
}: {
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <section
      aria-label={title}
      className="min-w-0 rounded border border-line bg-panel"
    >
      {title ? (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="space-y-0.5">
            <h2 className="brand-label text-gold">{title}</h2>
            {description ? <p className="mt-2 text-xs leading-relaxed text-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className="p-5">{children}</div>
    </section>
  );
}

const TONE_CLASS: Record<Tone, string> = {
  green: "border-success/25 bg-success/10 text-success",
  amber: "border-gold/25 bg-gold/10 text-gold",
  gray: "border-line bg-raised text-muted",
  red: "border-danger/25 bg-danger/10 text-danger",
  blue: "border-info/25 bg-info/10 text-info",
};

/** A small status pill. */
export function Badge({ tone = "gray", children }: { tone?: Tone; children: ReactNode }): ReactNode {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * A message banner. `error` and `success` carry `role="alert"` so a screen
 * reader announces the result of a form submission.
 */
export function Alert({ kind, children }: { kind: "error" | "success" | "info"; children: ReactNode }): ReactNode {
  const tone: Tone = kind === "error" ? "red" : kind === "success" ? "green" : "blue";
  return (
    <p
      role={kind === "info" ? undefined : "alert"}
      className={`rounded-md border px-3 py-2 text-sm ${TONE_CLASS[tone]}`}
    >
      {children}
    </p>
  );
}

/** What a list shows when it has nothing to show. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }): ReactNode {
  return (
    <div className="rounded border border-dashed border-line px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      {children ? <div className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-muted">{children}</div> : null}
    </div>
  );
}

/**
 * A labelled form control. The label is bound to `htmlFor` (never implicit),
 * and when a `hint` is given the control is pointed at it with
 * `aria-describedby`, so a screen reader reads the constraint with the field.
 */
export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  children: ReactNode;
}): ReactNode {
  const hintId = hint ? `${htmlFor}-hint` : undefined;
  let control = children;
  if (hintId && isValidElement<{ "aria-describedby"?: string }>(children)) {
    const existing = children.props["aria-describedby"];
    control = cloneElement(children, { "aria-describedby": existing ? `${existing} ${hintId}` : hintId });
  }
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </label>
      {control}
      {hint ? (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A `<dl>` row of a definition list; used by the workspace and repo detail pages. */
export function DetailRow({ term, children }: { term: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-2 last:border-b-0">
      <dt className="text-xs text-muted">{term}</dt>
      <dd className="min-w-0 text-sm break-all">{children}</dd>
    </div>
  );
}

/** A skeleton block used by the `loading.tsx` files. */
export function Skeleton({ className = "h-4 w-full" }: { className?: string }): ReactNode {
  return <div aria-hidden="true" className={`animate-pulse rounded bg-raised ${className}`} />;
}
