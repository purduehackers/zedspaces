import { describe, expect, it } from "vitest";
import { idleMinutesFor, MACHINES } from "@/lib/plans";

describe("workspace sizing", () => {
  it("assigns 2 GiB per vCPU", () => {
    for (const machine of Object.values(MACHINES)) expect(machine.memoryGb).toBe(machine.vcpus * 2);
  });
  it("clamps idle minutes and supplies the default", () => {
    expect(idleMinutesFor(undefined)).toBe(30);
    expect(idleMinutesFor(1)).toBe(5);
    expect(idleMinutesFor(900)).toBe(240);
    expect(idleMinutesFor(45.8)).toBe(45);
  });
});
