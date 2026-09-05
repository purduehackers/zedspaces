"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type { ShellWorkspace } from "@/lib/types";
import type { ZsBootStage } from "@/lib/zed-web";
import { BOOT_STAGE_LABELS, bootProgressRatio, offersReconnect, type ShellPhase } from "./shell-phase";

/**
 * Presentational chrome of the editor shell (b9 §3.26 bullets 4, 5 and 9).
 * These components hold no state and perform no I/O, which is what the
 * component tests exercise. No component emits a `style` attribute: the CSP
 * has no `'unsafe-inline'` for styles, so the one dynamic value is written
 * through the CSSOM in an effect.
 */

/** A lifecycle toast (b9 §3.26 bullet 4). */
export interface ShellToast {
  id: string;
  message: string;
  /** Optional inline action, e.g. "Keep alive". */
  action?: { label: string; onClick: () => void };
}

/** Actions the chrome can ask the shell to run. */
export interface ShellActions {
  /** `POST /stop`. */
  stop: () => void;
  /** `reconnect()` — a connection from scratch (D2, D30). */
  reconnect: () => void;
  /** `reconnect({ resume: true })` for a stopped workspace. */
  resume: () => void;
  /** `reconnect({ takeover: true })`. */
  takeover: () => void;
  /** Opens a control-plane page in a new tab. */
  openExternal: (url: string) => void;
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

/** Short status the top strip shows next to the workspace name. */
export function phaseSummary(phase: ShellPhase): string {
  switch (phase.kind) {
    case "booting":
      return BOOT_STAGE_LABELS[phase.stage];
    case "ready":
      return "Connected";
    case "reconnecting":
      return `Reconnecting (attempt ${phase.attempt})`;
    case "stopped":
      return "Stopped";
    case "takeover-required":
      return "Open in another tab";
    case "taken-over":
      return "Taken over";
    case "restarting":
      return `Restarting in ${phase.secondsLeft}s`;
    case "unsupported-browser":
      return "Unsupported browser";
    case "error":
      return "Disconnected";
  }
}

/** The floating strip above the canvas: identity plus the out-of-canvas actions. */
export function TopStrip({
  workspace,
  phase,
  actions,
  busy,
}: {
  workspace: ShellWorkspace;
  phase: ShellPhase;
  actions: ShellActions;
  busy: boolean;
}): ReactNode {
  const branch = workspace.branch ? `${workspace.repo}@${workspace.branch}` : workspace.repo;
  return (
    <header className="zs-strip" data-zs="strip">
      <div className="zs-strip__meta">
        <span className="zs-strip__name">{workspace.name}</span>
        <span className="zs-strip__detail">
          {branch} · {workspace.machine} · {workspace.region} · {phaseSummary(phase)}
        </span>
      </div>
      <div className="zs-strip__actions">
        {offersReconnect(phase) ? (
          <button
            type="button"
            className="zs-button zs-button--primary"
            onClick={phase.kind === "stopped" ? actions.resume : actions.reconnect}
            disabled={busy}
          >
            {phase.kind === "stopped" ? "Resume" : "Reconnect"}
          </button>
        ) : null}
        <button type="button" className="zs-button zs-button--danger" onClick={actions.stop} disabled={busy}>
          Stop
        </button>
        <a
          className="zs-button"
          href={`/workspaces/${workspace.id}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Settings
        </a>
        <a className="zs-button" href={`zed://zs/w/${workspace.id}`}>
          Open in desktop
        </a>
      </div>
    </header>
  );
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
    <div className="zs-card" role="dialog" aria-modal="true" aria-label={title}>
      <h1 className="zs-card__title">{title}</h1>
      <div className="zs-card__body">{children}</div>
      {actions ? <div className="zs-card__actions">{actions}</div> : null}
    </div>
  );
}

/**
 * The overlay that covers the canvas in every phase except `ready`. The
 * `data-phase` attribute is the hook the end-to-end tests key on.
 */
export function ShellOverlay({
  phase,
  workspace,
  actions,
  busy,
}: {
  phase: ShellPhase;
  workspace: ShellWorkspace;
  actions: ShellActions;
  busy: boolean;
}): ReactNode {
  return (
    <div className="zs-overlay" data-zs="overlay" data-phase={phase.kind} aria-live="polite">
      {overlayCard(phase, workspace, actions, busy)}
    </div>
  );
}

function overlayCard(phase: ShellPhase, workspace: ShellWorkspace, actions: ShellActions, busy: boolean): ReactNode {
  switch (phase.kind) {
    case "ready":
      return null;

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
              <button type="button" className="zs-button zs-button--primary" onClick={actions.resume} disabled={busy}>
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

    case "takeover-required":
      return (
        <Card
          title="Already open somewhere else"
          actions={
            <button type="button" className="zs-button zs-button--primary" onClick={actions.takeover} disabled={busy}>
              Take over
            </button>
          }
        >
          <p className="zs-card__body">
            Another tab or device is holding this workspace. Taking over closes that session.
          </p>
        </Card>
      );

    case "taken-over":
      return (
        <Card
          title="Taken over"
          actions={
            <button type="button" className="zs-button zs-button--primary" onClick={actions.takeover} disabled={busy}>
              Take back
            </button>
          }
        >
          <p className="zs-card__body">Another session took this workspace over. This tab is no longer connected.</p>
        </Card>
      );

    case "unsupported-browser":
      return (
        <Card title="This browser cannot run the editor">
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
            phase.retryable ? (
              <button type="button" className="zs-button zs-button--primary" onClick={actions.reconnect} disabled={busy}>
                Reconnect
              </button>
            ) : undefined
          }
        >
          <p className="zs-card__body">{phase.message}</p>
          {phase.code ? <p className="zs-card__hint zs-code">{phase.code}</p> : null}
          {phase.code === "bundle_not_built" || phase.code === "bundle_missing" ? (
            <p className="zs-card__hint">
              No editor bundle is present for build <span className="zs-code">{workspace.clientBuild}</span>. See{" "}
              <span className="zs-code">public/editor/README.md</span>.
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
