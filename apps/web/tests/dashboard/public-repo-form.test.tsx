import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicRepoForm } from "@/app/(site)/(dashboard)/_components/public-repo-form";
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));
const request = vi.fn();
beforeEach(() => { navigation.push.mockReset(); request.mockReset(); vi.stubGlobal("fetch", request); });
afterEach(() => vi.unstubAllGlobals());

function fill(repo = "https://github.com/octocat/Hello-World.git") {
  fireEvent.change(screen.getByRole("textbox", { name: "Public GitHub repository" }), { target: { value: repo } });
}
function submit() { fireEvent.click(screen.getByRole("button", { name: "Open in Zed" })); }

describe("public repository form", () => {
  it("creates a public clone with optional branch and navigates straight to the editor", async () => {
    request.mockResolvedValue({ ok: true, json: async () => ({ workspace: { id: "ws_created" } }) });
    render(<PublicRepoForm />); fill();
    fireEvent.change(screen.getByRole("textbox", { name: "Branch (optional)" }), { target: { value: "main" } });
    submit();
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/w/ws_created"));
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ repo: { owner: "octocat", name: "Hello-World" }, ref: { branch: "main" } });
    expect(request.mock.calls[0][1].headers["Idempotency-Key"]).toBeTruthy();
  });
  it("keeps the idempotency key across a network retry, but changes it for a new request", async () => {
    request.mockRejectedValue(new Error("Network unavailable"));
    render(<PublicRepoForm />); fill(); submit();
    await screen.findByRole("alert");
    const key = request.mock.calls[0][1].headers["Idempotency-Key"];
    submit(); await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1][1].headers["Idempotency-Key"]).toBe(key);
    await waitFor(() => expect(screen.getByRole("button", { name: "Open in Zed" }).hasAttribute("disabled")).toBe(false));
    fill("zed-industries/zed"); submit();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(request.mock.calls[2][1].headers["Idempotency-Key"]).not.toBe(key);
  });
  it("rejects credential-bearing or non-GitHub URLs before making a request", async () => {
    render(<PublicRepoForm />); fill("https://user:password@github.com/owner/repo"); submit();
    await screen.findByRole("alert"); expect(request).not.toHaveBeenCalled();
  });
});
