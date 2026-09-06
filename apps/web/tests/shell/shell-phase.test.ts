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

  // b9 §3.26 bullet 4 / CONTRACTS.md §8.4: the `stopped` detail code is the contract.
  it("taken_over_offers_take_back", () => {
    const transition = transitionForBootProgress("stopped", "taken_over");
    expect(transition.phase).toEqual({ kind: "taken-over" });
  });

  it("session_busy_asks_for_a_takeover", () => {
    expect(transitionForBootProgress("stopped", "session_busy").phase).toEqual({ kind: "takeover-required" });
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
    expect(transitionForBootProgress("stopped", "superseded").phase).toEqual({ kind: "taken-over" });
    expect(transitionForBootProgress("stopped", "session_active").phase).toEqual({ kind: "takeover-required" });
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
