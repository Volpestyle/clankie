import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { SettingsStore } from "@clankie/settings";
import { expect, it } from "vitest";
import { CaptainSeatStartResultSchema } from "@clankie/protocol/captain-seat";
import { CaptainSeats, captainSeatSnapshot } from "../src/captain-seat.ts";
import { createCaptainSeatRoutes } from "../src/captain-seat-routes.ts";
import { createCaptainSeatLauncher } from "../src/captain-seat-launcher.ts";
import { runCaptainSeatCommand } from "../../tui/src/command/captain-seat.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

/** Real HTTP, disk settings, CLI consumer and Herdr socket/process creation.
 * The terminal executable records argv; no vendor sign-in or model turn runs. */
it.skipIf(process.platform !== "darwin")(
  "opens fresh native panes once, retaining uncertain launch outcomes across service restart",
  async () => {
    const root = await mkdtemp("/tmp/captain-seat-");
    const herdr = await isolatedHerdr(join(root, "logs"));
    const settings = new SettingsStore(join(root, "settings.json"));
    await settings.update((current) => ({
      ...current,
      fleet: { ...current.fleet, hire: { harness: "codex" } },
    }));
    // This initial-command fixture is intentionally not a Claude/Codex bridge.
    await mkdir(join(root, "apps/tui/bin"), { recursive: true });
    await writeFile(
      join(root, "apps/tui/bin/clankie.js"),
      `
    const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(join(root, "starts.jsonl"))}, JSON.stringify({
      args: process.argv.slice(2), pane: process.env.HERDR_PANE_ID,
      resourceHolder: process.env.CLANKIE_RESOURCE_HOLDER,
      conversation: process.env.CLANKIE_CONVERSATION_ID,
      url: process.env.CLANKIE_CONTROL_PLANE_URL,
    }) + '\\n');
    setInterval(() => {}, 1000);
  `,
    );
    let conversations = 0;
    let loseReply = false;
    const launcher = createCaptainSeatLauncher({
      repoRoot: root,
      controlPlaneUrl: "http://127.0.0.1:59999",
      binding: async () => ({ runtime: "external", socketPath: herdr.socketPath, session: "default" }),
    });
    const makeSeats = () =>
      new CaptainSeats({
        directory: join(root, "requests"),
        supported: true,
        snapshot: async () => captainSeatSnapshot(await settings.load(), true),
        cwd: async () => root,
        createConversation: async () => `fresh-chat-${++conversations}`,
        appReady: async () => true,
        nativeReady: async () => false,
        launch: async (input, guard) => {
          const pane = await launcher(input, guard);
          if (loseReply) throw Error("fixture lost reply after the real pane was created");
          return pane;
        },
      });
    let seats = makeSeats();
    let app = createCaptainSeatRoutes(
      async (request) =>
        request.headers.get("authorization") === "Bearer owner" ? true : "authentication_required",
      settings,
      seats,
    );
    const server = serve({ fetch: (request) => app.fetch(request), hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No fixture listener");
    const host = `http://127.0.0.1:${address.port}`;
    const options = {
      ownerFetcher: {
        fetch: (path: string, init?: RequestInit) =>
          fetch(`${host}${path}`, {
            ...init,
            headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: "Bearer owner" },
          }),
      },
    };
    const cli = (args: string[]) => runCaptainSeatCommand(args, options);
    const status = async (requestId: string) =>
      CaptainSeatStartResultSchema.parse(await cli(["status", requestId]));
    const until = async (done: () => Promise<boolean>) => {
      for (let i = 0; i < 200; i++) {
        if (await done()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw Error("Fixture did not settle");
    };
    try {
      const originalPanes = (await herdr.cli("pane", "list")).result.panes;
      await expect(
        launcher({ cwd: root, seat: "claude", conversationId: "refused-chat" }, async () => false),
      ).rejects.toThrow("authority_revoked");
      expect((await herdr.cli("pane", "list")).result.panes).toEqual(originalPanes);
      const repoRoot = resolve(import.meta.dirname, "../../..");
      const launchedCli = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          join(repoRoot, "apps/tui/node_modules/tsx/dist/loader.mjs"),
          join(repoRoot, "apps/tui/bin/clankie.ts"),
          "seat",
          "show",
        ],
        {
          env: { ...process.env, CLANKIE_CONTROL_PLANE_URL: host, CLANKIE_OPERATOR_TOKEN: "owner" },
          timeout: 10_000,
        },
      );
      expect(JSON.parse(launchedCli.stdout)).toMatchObject({ seat: "app", supported: true });
      const initial = await cli(["show"]);
      expect(initial).toMatchObject({ seat: "app", supported: true });
      const appId = randomUUID();
      await cli([
        "start",
        "--revision",
        String((initial as { revision: string }).revision),
        "--request",
        appId,
      ]);
      await until(async () => (await status(appId)).outcome === "ready");
      expect((await status(appId)).conversationId).toBe("fresh-chat-1");
      expect((await herdr.cli("pane", "list")).result.panes).toEqual(originalPanes);
      for (const seat of ["claude", "codex"] as const) {
        const before = captainSeatSnapshot(await settings.load(), true);
        const selected = (await cli(["set", seat, "--revision", before.revision])) as { revision: string };
        const requestId = randomUUID();
        if (seat === "codex") loseReply = true;
        await Promise.all([
          cli(["start", "--revision", selected.revision, "--request", requestId]),
          cli(["start", "--revision", selected.revision, "--request", requestId]),
        ]);
        await until(async () => {
          const result = await status(requestId);
          return seat === "codex" ? result.outcome === "uncertain" : !!result.paneId;
        });
        const receipt = await status(requestId);
        expect(receipt.seat).toBe(seat);
        expect(receipt.outcome).toBe(seat === "codex" ? "uncertain" : "starting");
        seats = makeSeats();
        app = createCaptainSeatRoutes(async () => true, settings, seats);
        await cli(["start", "--revision", selected.revision, "--request", requestId]);
        expect(await status(requestId)).toEqual(receipt);
      }
      await until(
        async () =>
          (
            await readFile(join(root, "starts.jsonl"), "utf8").catch((error) => {
              if (error.code === "ENOENT") return "";
              throw error;
            })
          )
            .trim()
            .split("\n").length === 2,
      );
      const starts = (await readFile(join(root, "starts.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(starts.map((entry) => entry.args)).toEqual([
        ["claude", "--conversation", "fresh-chat-2"],
        ["codex", "--conversation", "fresh-chat-3"],
      ]);
      expect(new Set(starts.map((entry) => entry.pane)).size).toBe(2);
      expect(
        starts.every((entry) => entry.resourceHolder === "" && entry.url === "http://127.0.0.1:59999"),
      ).toBe(true);
      const panes = (await herdr.cli("pane", "list")).result.panes;
      expect(panes.length).toBe(originalPanes.length + 2);
      for (const original of originalPanes) {
        const { focused: _focused, ...unchanged } = original;
        expect(panes).toContainEqual(expect.objectContaining(unchanged));
      }
      expect((await settings.load()).fleet.hire).toEqual({ harness: "codex" });
      expect((await readdir(join(root, "requests"))).length).toBe(3);
    } finally {
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await herdr.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("refuses unauthenticated, unsupported, stale and malformed starts before settings or launch effects", async () => {
  const root = await mkdtemp("/tmp/captain-seat-denied-");
  const settings = new SettingsStore(join(root, "settings.json"));
  let authorized: true | "authentication_required" = "authentication_required";
  let effects = 0;
  const makeSeats = (supported: boolean) =>
    new CaptainSeats({
      directory: join(root, "requests"),
      supported,
      snapshot: async () => captainSeatSnapshot(await settings.load(), supported),
      cwd: async () => root,
      appReady: async () => true,
      nativeReady: async () => false,
      createConversation: async () => {
        effects++;
        return "new-chat";
      },
      launch: async () => {
        effects++;
        return "w1:p1";
      },
    });
  const call = (app: ReturnType<typeof createCaptainSeatRoutes>, body: unknown) =>
    app.request("/v1/captain/seat/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const snapshot = captainSeatSnapshot(await settings.load(), true);
    const input = { expectedRevision: snapshot.revision, requestId: randomUUID() };
    const app = createCaptainSeatRoutes(async () => authorized, settings, makeSeats(true));
    expect((await call(app, input)).status).toBe(401);
    authorized = true;
    expect((await call(app, { ...input, expectedRevision: "stale" })).status).toBe(409);
    expect((await call(app, { ...input, machine: "linked-pc" })).status).toBe(400);
    expect((await call(app, { ...input, requestId: "../../escape" })).status).toBe(400);
    const unsupported = createCaptainSeatRoutes(async () => true, settings, makeSeats(false));
    expect((await call(unsupported, input)).status).toBe(403);
    expect(
      (
        await unsupported.request("/v1/captain/seat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ seat: "codex", expectedRevision: snapshot.revision }),
        })
      ).status,
    ).toBe(403);
    expect(effects).toBe(0);
    expect(await readdir(root)).toEqual([]);
    expect(captainSeatSnapshot(await settings.load(), true)).toEqual(snapshot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
