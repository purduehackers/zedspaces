import type {
  ZsBootStage,
  ZsCloseInfo,
  ZsConnectInfo,
  ZsDocumentKind,
  ZsHost,
  ZsLifecycleKind,
  ZsUpdateAction,
} from "@/lib/zed-web";
import { putSettingsDocument, reportClientError, type ApiDeps } from "./api-client";
import { ConnectError } from "./connect-client";
import { downloadProject } from "./download-project";

/**
 * The browser host the shell hands to `start(configJson, assets, host)`
 * (b9 §4.6, CONTRACTS.md §8.4). `keepAlive`, `stop`, `setDirty` and
 * `openExternal` are deliberately absent: b7 declined them (b9 §7 item 6) and
 * the shell implements them itself — the toast's "Keep alive" and the strip's
 * "Stop" button post to the control plane, `beforeunload` asks the wasm side's
 * `has_unsaved_changes()`, and links open through `openExternal()` in
 * `api-client.ts`.
 */

/** What `createHost` needs from the React shell. */
export interface ShellController {
  /** Workspace the page is attached to. */
  readonly workspaceId: string;
  /** Bundle build id, reported with every client error. */
  readonly build: string;
  /** Applies one `bootProgress` event to the overlay. */
  bootProgress(stage: ZsBootStage, detail: string): void;
  /** Applies one lifecycle notice (toasts, the restart countdown). */
  lifecycle(kind: ZsLifecycleKind, seconds: number): void;
  updateAction(action: ZsUpdateAction): void;
  /** Mints a fresh connection; throws {@link ConnectError}. */
  refreshConnectInfo(): Promise<ZsConnectInfo>;
  /** Where a settings document is written (`/api/workspaces/{id}/settings` or `…/keymap`, editor-cookie routes). */
  documentUrl(kind: ZsDocumentKind): string;
  /** Last version the control plane reported for that document, for optimistic concurrency. */
  documentVersion(kind: ZsDocumentKind): number | null;
  /** Records the version returned by a successful write. */
  setDocumentVersion(kind: ZsDocumentKind, version: number | null): void;
  /** Test seam for the document and telemetry requests. */
  deps?: ApiDeps;
}

/** A rejection the wasm side understands (b7 §3.21 maps `code` to `RefreshError`). */
export interface HostRefreshFailure {
  code: "stopped" | "unauthorized" | "unavailable";
  message: string;
}

/** Maps a {@link ConnectError} to the three codes the transport branches on (D2). */
export function refreshFailureFor(err: unknown): HostRefreshFailure {
  if (err instanceof ConnectError) {
    switch (err.code) {
      case "stopped":
      case "deleted":
      case "build_mismatch":
        return { code: "stopped", message: err.message };
      case "unauthorized":
      case "forbidden":
      case "plan_limit":
        return { code: "unauthorized", message: err.message };
      default:
        return { code: "unavailable", message: err.message };
    }
  }
  return { code: "unavailable", message: err instanceof Error ? err.message : String(err) };
}

/**
 * Builds the {@link ZsHost} for one page load. `onClosed` is always present
 * (b7 calls it when it has one) and is telemetry only: the shell branches on
 * the `bootProgress("stopped", <code>)` detail, never on the close code.
 */
export function createHost(shell: ShellController): ZsHost & { onClosed(info: ZsCloseInfo): void } {
  const saves = new Map<ZsDocumentKind, Promise<void>>();

  return {
    bootProgress(stage, detail) {
      shell.bootProgress(stage, detail ?? "");
    },

    async refreshConnectInfo(): Promise<ZsConnectInfo> {
      try {
        return await shell.refreshConnectInfo();
      } catch (err) {
        throw refreshFailureFor(err);
      }
    },

    saveDocument(kind, json) {
      // WasmFs already debounces ordinary edits. A call here may be an authoritative
      // hidden/STOPPING flush, so dispatch immediately instead of adding another timer.
      // Serialize each document's writes so a second flush uses the acknowledged version.
      const write = async () => {
        const saved = await putSettingsDocument(
          shell.documentUrl(kind),
          { content: json, version: shell.documentVersion(kind) },
          shell.deps,
        );
        shell.setDocumentVersion(kind, saved.version);
      };
      const previous = saves.get(kind);
      const save = previous ? previous.then(write, write) : write();
      saves.set(kind, save);
      const clear = () => {
        if (saves.get(kind) === save) saves.delete(kind);
      };
      // Both handlers only release the queue; the original promise still rejects to wasm.
      void save.then(clear, clear);
      return save;
    },

    reportError(kind, message, stack) {
      void reportClientError(shell.workspaceId, shell.build, { kind, message, stack }, shell.deps);
    },

    onLifecycle(kind, seconds) {
      shell.lifecycle(kind, seconds);
    },

    updateAction(action) {
      queueMicrotask(() => shell.updateAction(action));
    },

    downloadProject(path, includeIgnored) {
      return downloadProject(shell.workspaceId, path, includeIgnored, shell.deps);
    },

    onClosed(info) {
      void reportClientError(
        shell.workspaceId,
        shell.build,
        { kind: "close", message: `close ${info.code}: ${info.reason || "(no reason)"}` },
        shell.deps,
      );
    },
  };
}
