import { afterEach, expect, it, vi } from "vitest";
import { runLinearCommand } from "../src/command/linear.ts";

const organizationId = "96d2a27b-950b-4a8a-afae-8776605c0ef1";
const issueId = "593644be-7b60-4a77-9b58-7b0dc20be894";
const flags = ["--organization", organizationId, "--issue", issueId];
const env = { CLANKIE_OPERATOR_TOKEN: "fixture" };
afterEach(() => vi.unstubAllGlobals());

it("binds and removes exact issue ownership and hands retained cursors to the service", async () => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture");
    requests.push({ path: new URL(url).pathname, method: init.method!, body: JSON.parse(String(init.body)) });
    return Response.json({ ok: true });
  });
  await runLinearCommand(["work", "bind", ...flags, "--conversation", "lead-conversation"], { env });
  await runLinearCommand(["work", "unbind", ...flags], { env });
  await runLinearCommand(["inbox", "handoff", "000000000042"], { env });
  expect(requests).toEqual([
    {
      path: "/v1/linear/work",
      method: "PUT",
      body: { organizationId, issueId, conversationId: "lead-conversation" },
    },
    { path: "/v1/linear/work", method: "DELETE", body: { organizationId, issueId } },
    { path: "/v1/linear/inbox/handoff", method: "POST", body: { cursor: "000000000042" } },
  ]);
});

it("refuses malformed ownership, duplicate flags and caller-chosen handoff destinations before any request", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  for (const args of [
    ["work", "bind", ...flags],
    ["work", "bind", ...flags, "--conversation", "lead", "--conversation", "other"],
    ["work", "bind", "--organization", organizationId, "--issue", "VUH-1611", "--conversation", "lead"],
    ["work", "bind", ...flags, "--conversation", "lead", "--unknown", "value"],
    ["work", "unbind", ...flags, "--conversation", "lead"],
    ["inbox", "handoff", "42"],
    ["inbox", "handoff", "000000000042", "--conversation", "other"],
  ])
    await expect(runLinearCommand(args, { env })).rejects.toThrow("Usage:");
  expect(fetch).not.toHaveBeenCalled();
});

it("surfaces service refusal without claiming that a binding or handoff succeeded", async () => {
  const fetch = vi.fn(async () => Response.json({ error: "linear_handoff_refused" }, { status: 409 }));
  vi.stubGlobal("fetch", fetch);
  await expect(runLinearCommand(["inbox", "handoff", "000000000042"], { env })).rejects.toThrow(
    "failed: 409",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
