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

it("denies an unavailable native read without erasing the original launch, and checks it afresh", async () => {
  const f = fixture();
  f.registration.bindThread("thread", f.check);
  f.check.mockRejectedValueOnce(new Error("Native inventory read timed out"));
  expect(await f.seats.allows(f.launch.fleet, f.view, f.launch.server)).toBe(false);
  expect(f.seats.server(f.launch.fleet, f.launch.pane)).toEqual(f.launch.server);
  expect(await f.seats.allows(f.launch.fleet, f.view, f.launch.server)).toBe(true);
  expect(f.check).toHaveBeenCalledTimes(2);
  f.check.mockResolvedValueOnce(false);
  expect(await f.seats.allows(f.launch.fleet, f.view, f.launch.server)).toBe(false);
  expect(f.seats.server(f.launch.fleet, f.launch.pane)).toBeUndefined();
  expect(await f.seats.allows(f.launch.fleet, f.view, f.launch.server)).toBe(false);
  expect(f.check).toHaveBeenCalledTimes(3);
});

it("an unavailable read cannot restore a replaced registration or lost link", async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  f.registration.bindThread("thread", () => new Promise((_resolve, denied) => (reject = denied)));
  const pending = f.seats.allows(f.launch.fleet, f.view, f.launch.server);
  f.stop();
  reject(new Error("Link dropped during read"));
  expect(await pending).toBe(false);
  expect(f.seats.server(f.launch.fleet, f.launch.pane)).toBeUndefined();
  expect(await f.seats.allows(f.launch.fleet, f.view, f.launch.server)).toBe(false);
});

it("reports the remote refresh boundary without borrowing config authority or consuming the original thread proof", async () => {
  const f = fixture();
  const request = { revision: "runtime:f6260751" };
  expect(await f.seats.refreshCatalogs(request)).toEqual([
    {
      paneId: "pc/w1:p1",
      revision: request.revision,
      outcome: "failed",
      reason: "original_remote_codex_thread_unbound",
    },
  ]);
  f.registration.bindThread("thread", f.check);
  expect(await f.seats.refreshCatalogs(request)).toEqual([
    {
      paneId: "pc/w1:p1",
      threadId: "thread",
      revision: request.revision,
      outcome: "failed",
      reason: "remote_codex_catalog_refresh_isolated_config_unavailable",
    },
  ]);
  expect(f.check).not.toHaveBeenCalled();
  expect(f.seats.server(f.launch.fleet, f.launch.pane)).toEqual(f.launch.server);
  expect(await f.seats.allows(f.launch.fleet, f.view, f.launch.server)).toBe(true);
  expect(f.check).toHaveBeenCalledTimes(1);
  expect(await f.seats.refreshCatalogs({ ...request, paneId: "other/w1:p1" })).toEqual([]);
  expect(await new RemoteCodexSeats(async () => f.launch.fleet).refreshCatalogs(request)).toEqual([]);
});

it("reports cancellation, changed fleet and lost link without turning an unsupported refresh into authority", async () => {
  const f = fixture();
  f.registration.bindThread("thread", f.check);
  const request = { paneId: "pc/w1:p1", revision: "runtime:f6260751" };
  const signal = AbortSignal.abort(new Error("Owner cancelled"));
  expect(await f.seats.refreshCatalogs({ ...request, signal })).toMatchObject([
    { outcome: "failed", reason: "remote_codex_catalog_refresh_cancelled" },
  ]);
  expect(await f.seats.refreshCatalogs({ ...request, revision: "bad\nrevision" })).toMatchObject([
    { outcome: "failed", reason: "remote_codex_catalog_revision_invalid" },
  ]);
  f.changeFleet();
  expect(await f.seats.refreshCatalogs(request)).toMatchObject([
    { outcome: "failed", reason: "original_remote_codex_fleet_changed" },
  ]);
  f.stop();
  expect(await f.seats.refreshCatalogs(request)).toMatchObject([
    { outcome: "failed", reason: "original_remote_codex_link_unavailable" },
  ]);
  expect(f.check).not.toHaveBeenCalled();
});

it("does not adopt a replacement registration while observing the original refresh boundary", async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seats = new RemoteCodexSeats(async () => {
    await held;
    return f.launch.fleet;
  });
  const original = seats.register(f.launch, () => true);
  original.bindThread("original", f.check);
  const pending = seats.refreshCatalogs({ revision: "runtime:f6260751" });
  const replacement = seats.register(f.launch, () => true);
  replacement.bindThread("replacement", f.check);
  release();
  expect(await pending).toMatchObject([
    {
      paneId: "pc/w1:p1",
      threadId: "original",
      outcome: "failed",
      reason: "original_remote_codex_registration_changed",
    },
  ]);
  expect(await seats.refreshCatalogs({ revision: "runtime:f6260751" })).toMatchObject([
    {
      threadId: "replacement",
      outcome: "failed",
      reason: "remote_codex_catalog_refresh_isolated_config_unavailable",
    },
  ]);
  expect(f.check).not.toHaveBeenCalled();
});
