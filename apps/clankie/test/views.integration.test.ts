import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { createResourceGovernor, defaultResourcePolicy } from "@clankie/fleet-resources";
import { VIEWS_PATH, VIEW_TTL_DEFAULT_MS, type ViewRender } from "@clankie/protocol";
import { createFleetResourceRuntime } from "../src/fleet-resource-runtime.ts";
import { createViewRoutes } from "../src/view-routes.ts";
import { ViewStore } from "../src/views.ts";
import { createWorkItemsService } from "../src/work-items.ts";
import { formatViewLines, runViewCommand } from "../../tui/src/command/view.ts";

const fixtures = join(import.meta.dirname, "../../../packages/fleet-resources/test/fixtures");
const bearer = "fixture-owner-bearer";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`Condition not reached: ${JSON.stringify(value).slice(0, 2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-views-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const governorDirectory = join(root, "governor");
  const governor = createResourceGovernor({
    directory: governorDirectory,
    probe: async () => ({ loadRatio: 0, availableMemoryMb: 1_000_000 }),
  });
  const resources = await createFleetResourceRuntime({
    governor,
    policy: async () => ({
      ...defaultResourcePolicy(),
      heavySlots: 1,
      maxLoadRatio: 10,
      minAvailableMemoryMb: 0,
    }),
  });
  cleanup.push(() => resources.close());
  const repo = await mkdtemp(join(tmpdir(), "clankie-views-repo-"));
  cleanup.push(() => rm(repo, { recursive: true, force: true }));
  const work = createWorkItemsService({
    stateDirectory: join(root, "work"),
    workspace: () => root,
    run: async () => {
      throw new Error("no git here");
    },
  });
  const routes = createViewRoutes(
    async (request) => {
      const header = request.headers.get("authorization");
      if (!header) return "authentication_required";
      return header === `Bearer ${bearer}` ? true : "forbidden";
    },
    new ViewStore(join(root, "views")),
    { fleetResources: () => resources.status(), listIssues: (request) => work.handle(request, true) },
  );
  const server = serve({ fetch: routes.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
  await once(server, "listening");
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  const host = `http://127.0.0.1:${String(address.port)}`;
  const cli = (args: string[]) =>
    runViewCommand(args, {
      host,
      env: { HOME: root, CLANKIE_OPERATOR_TOKEN: bearer },
      operatorCredentialStore: new FileCredentialStore(join(root, "credentials.json")),
    });
  /** A real heavy holder: a detached process that keeps its permit until released. */
  const hold = (seat: string) => {
    const receipt = join(root, `${seat}.receipt`);
    const release = join(root, `${seat}.release`);
    const child: ChildProcess = spawn(
      process.execPath,
      [
        join(fixtures, "heavy-driver.mjs"),
        governorDirectory,
        seat,
        process.execPath,
        join(fixtures, "heavy-command.mjs"),
        "hold",
        receipt,
        release,
        governorDirectory,
      ],
      { detached: true, stdio: "ignore" },
    );
    const exited = once(child, "exit");
    const free = async () => {
      await writeFile(release, "");
      await exited;
    };
    cleanup.push(async () => {
      if (child.exitCode === null) await free().catch(() => child.kill("SIGKILL"));
    });
    return {
      free,
      started: () =>
        access(receipt).then(
          () => true,
          () => false,
        ),
    };
  };
  return { cli, host, repo, work, resources, hold };
}

it("creates a temporary view over live fleet resources and tracker issues, follows the heavy queue, and pins and expires it", async () => {
  const f = await fixture();
  await f.work.handle(
    { action: "create", repo: f.repo, title: "Board the heavy queue", status: "todo" },
    true,
  );
  await f.work.handle({ action: "create", repo: f.repo, title: "Already shipped", status: "done" }, true);
  await f.resources.refresh();

  const spec = {
    title: "Heavy queue",
    sources: {
      fleet: { kind: "fleet_resources" },
      open: { kind: "tracker_issues", repo: f.repo, status: ["todo", "in_progress"] },
    },
    panels: [
      { source: "fleet", show: "capacity" },
      { title: "Waiting", source: "fleet", show: "queue", resource: "heavy" },
      { title: "Running", source: "fleet", show: "leases", resource: "heavy" },
      { source: "open", show: "issues" },
    ],
    refreshSeconds: 2,
  };
  const created = (await f.cli(["create", JSON.stringify(spec)])) as {
    view: ViewRender["view"];
    render: ViewRender;
  };
  // Temporary by default: 24 hours, not pinned.
  expect(created.view).toMatchObject({ pinned: false, spec: { title: "Heavy queue" } });
  expect(created.view.expiresAtMs! - created.view.createdAtMs).toBe(VIEW_TTL_DEFAULT_MS);
  expect(created.render.sources.open).toMatchObject({
    state: "ok",
    kind: "tracker_issues",
    items: [{ title: "Board the heavy queue", status: "todo" }],
  });
  expect(created.render.sources.fleet).toMatchObject({
    state: "ok",
    snapshot: { capacity: { heavySlots: 1, used: 0 }, leases: [], queue: [] },
  });

  // The queue moves: one real holder runs, a second waits behind it.
  const first = f.hold("seat-first");
  await eventually(first.started, Boolean);
  const second = f.hold("seat-second");
  const show = async () => {
    await f.resources.refresh();
    return (await f.cli(["show", created.view.id])) as ViewRender;
  };
  const fleet = (render: ViewRender) => {
    const data = render.sources.fleet;
    if (data?.state !== "ok" || data.kind !== "fleet_resources") throw new Error("fleet source unavailable");
    return data.snapshot;
  };
  const busy = await eventually(show, (render) => fleet(render).queue.length === 1);
  expect(fleet(busy).leases).toEqual([expect.objectContaining({ kind: "heavy", seatId: "seat-first" })]);
  expect(fleet(busy).queue).toEqual([expect.objectContaining({ kind: "heavy", seatId: "seat-second" })]);
  const busyText = formatViewLines(busy).join("\n");
  expect(busyText).toContain("1 waiting");
  expect(busyText).toMatch(/Waiting\n\s*1\. heavy\s+\S+\s+seat seat-second/u);

  await first.free();
  const moved = await eventually(
    show,
    (render) => fleet(render).queue.length === 0 && fleet(render).leases[0]?.seatId === "seat-second",
  );
  expect(formatViewLines(moved).join("\n")).toContain("Nothing waiting.");
  await second.free();
  await eventually(show, (render) => fleet(render).leases.length === 0);

  // Private to the owner: no bearer, no view.
  expect((await fetch(`${f.host}${VIEWS_PATH}`)).status).toBe(401);

  // Pinned views do not expire; unpinning makes it temporary again; expire retires it.
  expect(await f.cli(["pin", created.view.id])).toMatchObject({ view: { pinned: true, expiresAtMs: null } });
  const unpinned = (await f.cli(["unpin", created.view.id, "--ttl", "3d"])) as { view: ViewRender["view"] };
  expect(unpinned.view.pinned).toBe(false);
  expect(unpinned.view.expiresAtMs! - unpinned.view.updatedAtMs).toBe(72 * 3_600_000);
  expect(await f.cli(["list"])).toMatchObject({ views: [{ id: created.view.id }] });
  expect(await f.cli(["expire", created.view.id])).toEqual({ expired: created.view.id });
  expect(await f.cli(["list"])).toEqual({ views: [] });
  await expect(f.cli(["show", created.view.id])).rejects.toThrow(`No live view ${created.view.id}`);

  // A spec whose panel names a missing source is refused before anything is kept.
  await expect(
    f.cli(["create", JSON.stringify({ ...spec, panels: [{ source: "nope", show: "queue" }] })]),
  ).rejects.toThrow(/No source named nope/u);
});
