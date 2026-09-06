import { describe, expect, it } from "vitest";
import {
  BOOT_STAGE_LABELS,
  bootProgressRatio,
  coversCanvas,
  transitionForBootFailure,
  transitionForBootProgress,
} from "@/app/(editor)/w/[id]/shell-phase";
import { ZS_BOOT_STAGES } from "@/lib/zed-web";

describe("shell phase mapping", () => {
  it("boot_stages_advance_monotonically", () => {
    const ratios = ZS_BOOT_STAGES.map(bootProgressRatio);
    expect(ratios).toEqual([...ratios].sort((a, b) => a - b));
    expect(ratios.at(0)).toBeGreaterThan(0);
    expect(ratios.at(-1)).toBe(1);
    for (const stage of ZS_BOOT_STAGES) expect(BOOT_STAGE_LABELS[stage]).toBeTruthy();
  });

  it("progress_stages_render_the_boot_overlay", () => {
    const transition = transitionForBootProgress("languages", "rust");
    expect(transition.phase).toEqual({ kind: "booting", stage: "languages", detail: "rust" });
    expect(transition.effect).toBeUndefined();
    expect(coversCanvas(transition.phase)).toBe(true);
  });

  it("ready_dissolves_the_overlay", () => {
    const transition = transitionForBootProgress("ready", "");
    expect(transition.phase).toEqual({ kind: "ready" });
    expect(coversCanvas(transition.phase)).toBe(false);
  });

  it("reconnecting_carries_the_attempt", () => {
    expect(transitionForBootProgress("reconnecting", "7").phase).toEqual({ kind: "reconnecting", attempt: 7 });
    expect(transitionForBootProgress("reconnecting", "").phase).toEqual({ kind: "reconnecting", attempt: 1 });
  });

  it("a replaced copy of a tab is terminal without taking over another participant", () => {
    expect(transitionForBootProgress("stopped", "connection_replaced").phase).toMatchObject({ kind: "error", retryable: false });
  });

  it("a stale replica never silently reloads or claims someone took over", () => {
    const transition = transitionForBootFailure("rejoin_required");
    expect(transition.effect).toBeUndefined();
    expect(transition.phase).toMatchObject({ kind: "error", retryable: false, message: expect.stringContaining("Copy any unsynced edits") });
  });

  it("incompatible_server_reloads", () => {
    expect(transitionForBootProgress("stopped", "incompatible_server").effect).toBe("reload");
  });

  it("unauthorized_reauthenticates_and_is_terminal", () => {
    const transition = transitionForBootProgress("stopped", "unauthorized");
    expect(transition.effect).toBe("reauthenticate");
    expect(transition.phase).toMatchObject({ kind: "error", retryable: false });
  });

  it("stopped_codes_end_in_the_stopped_phase_with_the_hinted_reason", () => {
    expect(transitionForBootProgress("stopped", "workspace_stopped").phase).toEqual({
      kind: "stopped",
      reason: "unknown",
    });
    // D23 renumbered the former 4004 to 1001; b7 still names the code `server_stopping`.
    expect(transitionForBootProgress("stopped", "server_stopping", { stopReason: "idle" }).phase).toEqual({
      kind: "stopped",
      reason: "idle",
    });
    expect(transitionForBootFailure("quit").phase).toEqual({ kind: "stopped", reason: "user" });
  });

  // D23 `close_code_detail` names map exactly like b7's legacy names.
  it("d23_close_code_details_map_to_the_same_phases", () => {
    expect(transitionForBootProgress("stopped", "build_mismatch").effect).toBe("reload");
    expect(transitionForBootProgress("stopped", "bad_hello").effect).toBe("reload");
    expect(transitionForBootProgress("stopped", "going_away", { stopReason: "cap" }).phase).toEqual({
      kind: "stopped",
      reason: "cap",
    });
    expect(transitionForBootFailure("unauthorized").effect).toBe("reauthenticate");
  });

  it("reconnect_exhausted_is_a_retryable_error", () => {
    const transition = transitionForBootProgress("stopped", "reconnect_exhausted");
    expect(transition.phase).toMatchObject({ kind: "error", retryable: true, code: "reconnect_exhausted" });
  });

  it("structural_failures_are_not_retryable", () => {
    for (const code of ["bad_config", "bad_assets", "database", "window", "bundle_not_built"]) {
      expect(transitionForBootFailure(code).phase).toMatchObject({ kind: "error", retryable: false, code });
    }
  });

  it("unknown_codes_fall_back_to_a_retryable_error", () => {
    expect(transitionForBootProgress("stopped", "meteor_strike").phase).toMatchObject({
      kind: "error",
      retryable: true,
      code: "meteor_strike",
    });
    expect(transitionForBootProgress("failed", "connect_failed").phase).toMatchObject({
      kind: "error",
      retryable: true,
    });
  });
});
