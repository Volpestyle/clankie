import { expect, it, vi } from "vitest";
import { RemoteCodexSeats, type RemoteCodexLaunch } from "../src/remote-codex-seats.ts";
import type { ProjectProcessProof } from "../src/project-process-proof.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";

function fixture() {
  const launch: RemoteCodexLaunch = {
    fleet: { id: "pc", session: "desktop", ssh: { host: "pc", shell: "powershell" } },
    pane: "w1:p1",
    binding: { session: "desktop", socketPath: "C:\\herdr.sock" },
    shell: { pid: 10, startTime: "2026-10-03T00:00:00.0000001Z" },
    server: { port: 45000, pid: 20, startTime: "2026-10-03T00:00:01.0000001Z", executable: "C:\\codex.exe" },
  };
  let live = true;
  let fleet = launch.fleet;
  const seats = new RemoteCodexSeats(async () => fleet);
  const registration = seats.register(launch, () => live);
  const check = vi.fn(async () => true);
  const view: ProjectProcessProof = {
    fleet: "pc",
    pane: launch.pane,
    binding: launch.binding,
    shell: launch.shell,
    nativeOccupantId: occupantIdForHerdrSession({ source: "herdr:codex", kind: "id", value: "thread" }),
    processes: [{ pid: 30, startTime: "view" }],
  };
  return {
    launch,
    seats,
    registration,
    check,
    view,
    stop: () => {
      live = false;
    },
    changeFleet: () => {
      fleet = { ...fleet, session: "other" };
    },
  };
}
it("requires service registration and a bound sole native thread, with fresh checks", async () => {
  const f = fixture();
  expect(f.seats.server(f.launch.fleet, f.launch.pane)).toBeUndefined();
  expect(await f.seats.allows(f.launch.fleet, f.view, f.launch.server)).toBe(false);
  f.registration.bindThread("thread", f.check);
  expect(await f.seats.allows(f.launch.fleet, f.view, f.launch.server)).toBe(true);
  expect(await f.seats.allows(f.launch.fleet, f.view, f.launch.server)).toBe(true);
  expect(f.check).toHaveBeenCalledTimes(2);
});
it.each([
  "pane",
  "machine",
  "binding",
  "shell",
  "server-reuse",
  "executable",
  "thread",
  "pending",
  "link",
  "fleet",
  "release",
  "switch",
  "second-thread",
])("denies %s mismatch", async (kind) => {
  const f = fixture();
  f.registration.bindThread("thread", f.check);
  let view = f.view;
  let server = f.launch.server;
  if (kind === "pane") view = { ...view, pane: "w1:p2" };
  if (kind === "machine") view = { ...view, fleet: "other" };
  if (kind === "binding") view = { ...view, binding: { ...view.binding, socketPath: "other" } };
  if (kind === "shell") view = { ...view, shell: { ...view.shell, startTime: "reused" } };
  if (kind === "server-reuse") server = { ...server, startTime: "2026-10-03T00:00:01.0000002Z" };
  if (kind === "executable") server = { ...server, executable: "C:\\fake.exe" };
  if (kind === "thread") view = { ...view, nativeOccupantId: "other" };
  if (kind === "pending") view = { ...view, nativeSessionPending: true };
  if (kind === "link") f.stop();
  if (kind === "fleet") f.changeFleet();
  if (kind === "release") f.registration.release();
  if (kind === "switch") f.registration.observeThread("other");
  if (kind === "second-thread") f.check.mockResolvedValue(false);
  expect(await f.seats.allows(f.launch.fleet, view, server)).toBe(false);
});
it("revokes permanently on unexpected thread and refuses stale allocation cleanup", async () => {
  const f = fixture();
  f.registration.bindThread("thread", f.check);
  f.registration.observeThread("other");
  f.registration.bindThread("thread", f.check);
  expect(await f.seats.allows(f.launch.fleet, f.view, f.launch.server)).toBe(false);
  const second = f.seats.register(f.launch, () => true);
  second.bindThread("thread", f.check);
  f.registration.release();
  expect(await f.seats.allows(f.launch.fleet, f.view, f.launch.server)).toBe(true);
});
it("rechecks allocation and link after the protocol observation", async () => {
  const f = fixture();
  f.registration.bindThread("thread", async () => {
    f.stop();
    return true;
  });
  expect(await f.seats.allows(f.launch.fleet, f.view, f.launch.server)).toBe(false);
});
