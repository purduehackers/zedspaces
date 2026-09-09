"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type { ShellWorkspace } from "@/lib/types";
import type { ZsBootStage } from "@/lib/zed-web";
import { BOOT_STAGE_LABELS, bootProgressRatio, type ShellPhase } from "./shell-phase";

// Canvas overlays own browser focus while visible. Dynamic styles use the
// CSSOM because the editor's CSP does not allow inline style attributes.

/** A lifecycle toast (b9 §3.26 bullet 4). */
export interface ShellToast {
  id: string;
  message: string;
  /** Optional inline action, e.g. "Keep alive". */
  action?: { label: string; onClick: () => void };
}

/** Actions the chrome can ask the shell to run. */
export interface ShellActions {
  /** `reconnect()` — a connection from scratch (D2, D30). */
  reconnect: () => void;
  /** `reconnect({ resume: true })` for a stopped workspace. */
  resume: () => void;
  /** Opens a control-plane page in a new tab. */
  openExternal: (url: string) => void;
  downloadDiagnostics: () => void;
}

function stopReasonText(reason: string): string {
  switch (reason) {
    case "idle":
      return "This workspace stopped because it was idle.";
    case "cap":
      return "This workspace stopped when it reached the session limit.";
    case "user":
      return "This workspace was stopped.";
    case "error":
      return "This workspace stopped after an error.";
    default:
      return "This workspace is stopped.";
  }
}

/** The boot progress bar; the ratio reaches the DOM through the CSSOM, never a `style` attribute. */
function BootProgress({ stage }: { stage: ZsBootStage }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const ratio = bootProgressRatio(stage);
  useEffect(() => {
    ref.current?.style.setProperty("--zs-progress", String(ratio));
  }, [ratio]);
  return (
    <div className="zs-progress" data-progress={ratio.toFixed(2)} ref={ref}>
      <div className="zs-progress__bar" />
    </div>
  );
}

function Card({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }): ReactNode {
  return (
    <div className="zs-card" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
      <h1 className="zs-card__title">{title}</h1>
      <div className="zs-card__body">{children}</div>
      {actions ? <div className="zs-card__actions">{actions}</div> : null}
    </div>
  );
}

/** Covers and isolates the editor whenever it cannot accept input. */
export function ShellOverlay({
  phase,
  workspace,
  actions,
}: {
  phase: ShellPhase;
  workspace: ShellWorkspace;
  actions: ShellActions;
}): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  const visible = phase.kind !== "ready";
  useEffect(() => {
    if (!visible || !root.current) return;
    const overlay = root.current;
    const previous = document.activeElement;
    const owned = new Map<HTMLElement, boolean>();
    const focus = () => overlay.querySelector<HTMLElement>("[role=dialog]")?.focus({ preventScroll: true });
    const isolate = () => {
      for (const element of document.querySelectorAll<HTMLElement>("body > canvas, body > [data-gpui-input], body > [data-gpui-a11y]")) {
        if (!owned.has(element)) owned.set(element, element.inert);
        element.inert = true;
      }
      if (!overlay.contains(document.activeElement)) focus();
    };
    isolate();
    // The canvas and its input/accessibility bridges are created during boot.
    const observer = new MutationObserver(isolate);
    observer.observe(document.body, { childList: true });
    const focusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !overlay.contains(event.target)) focus();
    };
    document.addEventListener("focusin", focusIn);
    return () => {
      observer.disconnect();
      document.removeEventListener("focusin", focusIn);
      const restore = overlay.contains(document.activeElement) || document.activeElement === document.body;
      for (const [element, inert] of owned) element.inert = inert;
      if (restore) {
        const target = previous instanceof HTMLElement && previous.isConnected && previous !== document.body
          ? previous : document.querySelector<HTMLElement>("[data-gpui-input]");
        target?.focus({ preventScroll: true });
      }
    };
  }, [visible]);
  return (
    <div ref={root} className="zs-overlay" data-zs="overlay" data-phase={phase.kind} aria-live="polite" onKeyDown={event => {
      if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.shiftKey ? (index <= 0 ? buttons.length - 1 : index - 1) : (index + 1) % buttons.length;
      buttons[next]?.focus();
      event.preventDefault();
    }}>
      {overlayCard(phase, workspace, actions)}
    </div>
  );
}

function overlayCard(phase: ShellPhase, workspace: ShellWorkspace, actions: ShellActions): ReactNode {
  switch (phase.kind) {
    case "ready":
      return null;

    case "graphics":
      return (
        <Card title={phase.failed ? "Browser graphics stopped" : "Recovering browser graphics"} actions={phase.failed ? <>
          <button type="button" className="zs-button zs-button--primary" onClick={actions.reconnect}>Reconnect</button>
          <button type="button" className="zs-button" onClick={actions.downloadDiagnostics}>Download diagnostics</button>
        </> : undefined}>
          {phase.failed
            ? "The graphics device could not recover. The editor state is still in this tab. Download diagnostics before reconnecting; unsaved edits may be lost on reload."
            : "Rebuilding graphics resources. Your files, unsaved edits, and workspace connection stay in place."}
        </Card>
      );

    case "booting":
      return (
        <Card title={`Opening ${workspace.name}`}>
          <p className="zs-card__body">{BOOT_STAGE_LABELS[phase.stage]}</p>
          {phase.detail ? <p className="zs-card__hint zs-code">{phase.detail}</p> : null}
          <BootProgress stage={phase.stage} />
        </Card>
      );

    case "reconnecting":
      return (
        <Card title="Reconnecting">
          <p className="zs-card__body">
            The connection dropped. Attempt {phase.attempt} of 20; your work stays on the server.
          </p>
        </Card>
      );

    case "restarting":
      return (
        <Card title="Restarting the workspace">
          <p className="zs-card__body">
            This session reached its time limit and restarts in {phase.secondsLeft}s. Unsaved changes are kept.
          </p>
        </Card>
      );

    case "stopped":
      return (
        <Card
          title="Workspace stopped"
          actions={
            <>
              <button type="button" className="zs-button zs-button--primary" onClick={actions.resume}>
                Resume
              </button>
              <button
                type="button"
                className="zs-button"
                onClick={() => actions.openExternal(`/workspaces/${workspace.id}`)}
              >
                Open dashboard
              </button>
            </>
          }
        >
          <p className="zs-card__body">
            {stopReasonText(phase.reason)} Resuming starts the sandbox again and reopens your files.
          </p>
        </Card>
      );

    case "unsupported-browser":
      return (
        <Card title="This browser cannot run the editor" actions={
          <button type="button" className="zs-button" onClick={actions.downloadDiagnostics}>Download diagnostics</button>
        }>
          <p className="zs-card__body">
            The editor needs cross-origin isolation (SharedArrayBuffer). Use a current Chrome, Edge, Firefox or Safari
            and make sure the page is loaded over HTTPS.
          </p>
        </Card>
      );

    case "error":
      return (
        <Card
          title="Something went wrong"
          actions={
            <>
              {phase.retryable && (
                <button type="button" className="zs-button zs-button--primary" onClick={actions.reconnect}>
                  Reconnect
                </button>
              )}
              <button type="button" className="zs-button" onClick={actions.downloadDiagnostics}>Download diagnostics</button>
            </>
          }
        >
          <p className="zs-card__body">{phase.message}</p>
          {phase.code ? <p className="zs-card__hint zs-code">{phase.code}</p> : null}
          {phase.code === "bundle_missing" ? (
            <p className="zs-card__hint">
              No editor bundle is present for build <span className="zs-code">{workspace.clientBuild}</span>. See{" "}
              the repository README for build instructions.
            </p>
          ) : null}
        </Card>
      );
  }
}

/** Lifecycle toasts (idle stop, session cap, resumed). */
export function LifecycleToasts({ toasts }: { toasts: ShellToast[] }): ReactNode {
  if (toasts.length === 0) return null;
  return (
    <div className="zs-toasts" data-zs="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div className="zs-toast" key={toast.id}>
          <span className="zs-toast__text">{toast.message}</span>
          {toast.action ? (
            <button type="button" className="zs-button" onClick={toast.action.onClick}>
              {toast.action.label}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
