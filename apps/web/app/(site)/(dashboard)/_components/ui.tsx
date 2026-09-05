import { cloneElement, isValidElement, type ReactNode } from "react";
import type { Tone } from "./format";

/**
 * The dashboard's presentational primitives (BUILD-SPEC §7.7). They hold no
 * state and perform no I/O, so server components and client components can
 * both render them and the component tests need no runtime. Styling is
 * Tailwind 4 utilities over the `--background`/`--foreground` tokens of
 * `app/globals.css`, with a `dark:` variant for every colour.
 */

/** Shared button classes, so every action in the dashboard looks the same. */
export const BUTTON = {
  base: "inline-flex items-center justify-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600",
  primary:
    "border-transparent bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white",
  secondary:
    "border-zinc-300 bg-transparent text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800",
  danger:
    "border-red-300 bg-transparent text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950",
} as const;

/** `className` of a button in the given variant. */
export function buttonClass(variant: "primary" | "secondary" | "danger" = "secondary"): string {
  return `${BUTTON.base} ${BUTTON[variant]}`;
}

/** Shared classes of every text input, select and textarea. */
export const FIELD_CLASS =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 shadow-xs placeholder:text-zinc-400 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-600 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

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
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-zinc-200 pb-4 dark:border-zinc-800">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-sm text-zinc-600 dark:text-zinc-400">{description}</p> : null}
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
      className="rounded-lg border border-zinc-200 bg-white/60 dark:border-zinc-800 dark:bg-zinc-900/40"
    >
      {title ? (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="space-y-0.5">
            <h2 className="text-sm font-semibold">{title}</h2>
            {description ? <p className="text-xs text-zinc-600 dark:text-zinc-400">{description}</p> : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

const TONE_CLASS: Record<Tone, string> = {
  green: "border-green-300 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300",
  amber: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
  gray: "border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  red: "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
  blue: "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300",
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
    <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
      <p className="text-sm font-medium">{title}</p>
      {children ? <div className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{children}</div> : null}
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
        <p id={hintId} className="text-xs text-zinc-600 dark:text-zinc-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A `<dl>` row of a definition list; used by the workspace and repo detail pages. */
export function DetailRow({ term, children }: { term: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-zinc-100 py-1.5 last:border-b-0 dark:border-zinc-800">
      <dt className="text-xs text-zinc-600 dark:text-zinc-400">{term}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/** Table classes shared by the list pages, so every table scrolls the same way. */
export const TABLE = {
  wrapper: "overflow-x-auto",
  table: "w-full min-w-[40rem] border-collapse text-left text-sm",
  th: "border-b border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-600 dark:border-zinc-800 dark:text-zinc-400",
  td: "border-b border-zinc-100 px-3 py-2 align-middle dark:border-zinc-800",
} as const;

/** A skeleton block used by the `loading.tsx` files. */
export function Skeleton({ className = "h-4 w-full" }: { className?: string }): ReactNode {
  return <div aria-hidden="true" className={`animate-pulse rounded bg-zinc-200 dark:bg-zinc-800 ${className}`} />;
}
