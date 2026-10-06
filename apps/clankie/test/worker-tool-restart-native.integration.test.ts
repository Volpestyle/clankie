import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { installPinnedLinks } from "../../tui/bin/pinned-runtime.ts";
import { once } from "node:events";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { expect, it } from "vitest";
import { createRuntimeUpdateRoutes } from "../src/runtime-update-routes.ts";
import { PaneTidy } from "../src/captain/pane-tidy.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";
import { runWorkerToolRestartCommand } from "../../tui/src/command/harness.ts";

// Manual: real owned Herdr namespace; never reaches an existing worker or device.
it.skipIf(process.env.SEAT_REFRESH_NATIVE_TEST !== "1")(
  "restart CLI refuses an unsupported real occupant and unauthorized/malformed requests without closing its pane",
  async () => {
    const logDirectory = resolve(".local/1739", `native-${Date.now()}`);
    const herdr = await isolatedHerdr(logDirectory);
    let closes = 0,
      hires = 0;
    const runner = createHerdrWatchRunner(undefined, async (args) =>
      JSON.stringify(await herdr.cli(...args)),
    );
    const tidy = new PaneTidy(resolve(herdr.root, "tidy.json"), {
      runner,
      provenance: () => "unknown",
      ownerValid: async () => false,
      close: async () => {
        closes++;
        throw new Error("Unsupported occupant must never reach close");
      },
      untrack: () => {},
      hire: async () => {
        hires++;
        throw new Error("Unsupported occupant must never reach hire");
      },
      changed: () => {},
    });
    const token = "restart-test";
    const app = createRuntimeUpdateRoutes({
      authorize: async (request) =>
        request.headers.get("authorization") === `Bearer ${token}`
          ? { current: () => true, guard: async () => {} }
          : undefined,
      restartWorkerTools: (input, authority) =>
        tidy.restart(
          { pane: input.paneId },
          {
            owner: { conversationId: "global-default" },
            current: authority.current,
            authorize: async () => {
              await authority.guard();
              return authority.current();
            },
          },
        ),
    });
    const server = serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP listener");
    const host = `http://127.0.0.1:${address.port}`;
    try {
      const before = await herdr.cli("pane", "process-info", "--pane", herdr.pane);
      expect(
        await runWorkerToolRestartCommand(["restart-tools", "--pane", herdr.pane], {
          host,
          env: { CLANKIE_OPERATOR_TOKEN: token },
        }),
      ).toEqual({ outcome: "failed", reason: "draft_state_unknown" });
      // Use the production atomic installer in an owned prefix, then invoke the
      // actual installed executable against this service's HTTP boundary.
      const prefix = resolve(herdr.root, "installed");
      await installPinnedLinks(resolve(import.meta.dirname, "../../.."), prefix);
      let installedResult: { code?: number; stdout?: string } | undefined;
      try {
        await promisify(execFile)(
          resolve(prefix, ".local/bin/clankie"),
          ["harness", "restart-tools", "--pane", herdr.pane],
          {
            timeout: 30_000,
            env: {
              ...process.env,
              CLANKIE_OPERATOR_TOKEN: token,
              CLANKIE_CONTROL_PLANE_URL: host,
              CLANKIE_SETTINGS_FILE: resolve(herdr.root, "settings.json"),
            },
          },
        );
      } catch (error) {
        installedResult = error as typeof installedResult;
      }
      expect(installedResult?.code).toBe(1);
      expect(JSON.parse(installedResult!.stdout!)).toEqual({
        outcome: "failed",
        reason: "draft_state_unknown",
      });
      await writeFile(resolve(logDirectory, "installed-cli-result.json"), installedResult!.stdout!);
      const denied = await fetch(`${host}/v1/fleet/worker-tool-restart`, {
        method: "POST",
        body: JSON.stringify({ paneId: herdr.pane }),
      });
      expect(denied.status).toBe(403);
      const invalid = await fetch(`${host}/v1/fleet/worker-tool-restart`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ paneId: herdr.pane, replay: true }),
      });
      expect(invalid.status).toBe(400);
      const after = await herdr.cli("pane", "process-info", "--pane", herdr.pane);
      expect(after.result.process_info.shell_pid).toBe(before.result.process_info.shell_pid);
      expect(closes).toBe(0);
      expect(hires).toBe(0);
      expect(tidy.history()).toEqual([]);
    } finally {
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await herdr.close();
    }
  },
);
