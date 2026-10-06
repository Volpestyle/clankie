import { afterEach, expect, it, vi } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import type { RuntimeUpdater } from "../../tui/bin/runtime-updater.ts";
import { ProcessHealthSnapshotSchema } from "@clankie/protocol";

const runtime = {
  pid: 1234,
  commit: "a".repeat(40),
  root: "/fixture/pinned",
  instanceId: "11111111-1111-4111-8111-111111111111",
};
const closes: (() => void)[] = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
});

async function health(updater?: RuntimeUpdater) {
  const { app, close } = await createClankieApp({
    captain: createStubCaptain(),
    ...(updater === undefined ? {} : { runtimeUpdater: updater }),
  });
  closes.push(close);
  const response = await app.request("/health");
  expect(response.status).toBe(200);
  const value = await response.json();
  const counters = ProcessHealthSnapshotSchema.parse(value.processHealth);
  expect(counters.pid).toBe(process.pid);
  expect(counters.uptimeMs).toBeGreaterThan(0);
  const { processHealth: _processHealth, ...liveness } = value;
  return liveness;
}

it("publishes only the exact boot identity needed to inspect linked native bridges", async () => {
  const request = vi.fn();
  const boot = { ...runtime, extra: "private runtime field" };
  expect(
    await health({
      runtime: boot,
      status: () => {
        throw new Error("Diagnostic transaction files are unavailable");
      },
      request,
    }),
  ).toEqual({ ok: true, service: "clankie", runtime });
  expect(request).not.toHaveBeenCalled();
});

it("optional missing, failing or malformed runtime identity does not change liveness", async () => {
  const expected = { ok: true, service: "clankie" };
  expect(await health()).toEqual(expected);
  expect(
    await health({
      get runtime(): RuntimeUpdater["runtime"] {
        throw new Error("updater identity unavailable");
      },
      status: () => {
        throw new Error("updater unavailable");
      },
      request: vi.fn(),
    }),
  ).toEqual(expected);
  for (const invalid of [
    { ...runtime, pid: -1 },
    { ...runtime, commit: "secret" },
    { ...runtime, instanceId: "invalid" },
  ])
    expect(
      await health({ runtime: invalid, status: () => ({ runtime: invalid }), request: vi.fn() }),
    ).toEqual(expected);
});
