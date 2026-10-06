import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readFleet } from "../src/captain/herdr-census.ts";
import { nativeHerdrRead } from "../src/herdr-native-read.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

it.skipIf(process.platform !== "darwin")(
  "reads the real owned Herdr socket with the CLI result shape and no subprocess fallback",
  async () => {
    const root = join(import.meta.dirname, "../../../.local/orla/native-read");
    await mkdir(root, { recursive: true });
    const herdr = await isolatedHerdr(root);
    const binding = { runtime: "external" as const, socketPath: herdr.socketPath, session: "default" };
    try {
      await herdr.cli(
        "pane",
        "report-agent",
        herdr.pane,
        "--source",
        "native-read-fixture",
        "--agent",
        "codex",
        "--state",
        "idle",
        "--agent-session-id",
        "abcdef00-1234-4567-8901-abcdef123456",
      );
      await herdr.cli(
        "pane",
        "report-agent-session",
        herdr.pane,
        "--source",
        "herdr:codex",
        "--agent",
        "codex",
        "--agent-session-id",
        "abcdef00-1234-4567-8901-abcdef123456",
      );
      for (const args of [
        ["agent", "list"],
        ["agent", "get", herdr.pane],
        ["pane", "list"],
        ["pane", "process-info", "--pane", herdr.pane],
        ["api", "snapshot"],
      ]) {
        const cli = await herdr.cli(...args);
        const reply = JSON.parse((await nativeHerdrRead(binding, args))!);
        expect(reply.result).toEqual(cli.result);
      }
      // A remote census uses the real complete snapshot for both occupants and
      // placement. Each read is fresh; revocation must not recover via agent.list.
      const reads: string[][] = [];
      let available = true;
      const fleets = [
        {
          id: "owned",
          host: "owned-fixture",
          session: "default",
          run: async (args: readonly string[]) => {
            reads.push([...args]);
            return (await nativeHerdrRead(
              available ? binding : { ...binding, socketPath: join(herdr.root, "missing.sock") },
              args,
            ))!;
          },
        },
      ];
      const first = await readFleet({ localAvailable: false, fleets });
      expect(reads).toEqual([["api", "snapshot"]]);
      expect(first.seats.some((seat) => seat.paneId === `owned/${herdr.pane}`)).toBe(true);
      await herdr.cli("agent", "rename", herdr.pane, "fresh-snapshot-name");
      const second = await readFleet({ localAvailable: false, fleets });
      expect(second.seats.find((seat) => seat.paneId === `owned/${herdr.pane}`)?.renamed?.name).toBe(
        "fresh-snapshot-name",
      );
      available = false;
      expect((await readFleet({ localAvailable: false, fleets })).seats).toEqual([]);
      expect(reads).toEqual(Array.from({ length: 3 }, () => ["api", "snapshot"]));
      const runner = createHerdrWatchRunner(
        undefined,
        async () => {
          throw new Error("Subprocess fallback is forbidden in this read fixture");
        },
        undefined,
        { localReadBinding: async () => binding },
      );
      const pane = await runner.get(herdr.pane);
      expect(pane.paneId).toBe(herdr.pane);
      expect((await runner.list!()).some((pane) => pane.paneId === herdr.pane)).toBe(true);
      expect(await runner.resolveTerminal(pane.terminalId)).toBeDefined();
      expect(nativeHerdrRead(binding, ["agent", "wait", herdr.pane])).toBeUndefined();
      expect(nativeHerdrRead(binding, ["pane", "close", herdr.pane])).toBeUndefined();
      expect(nativeHerdrRead(binding, ["pane", "list", "--workspace", "wrong"])).toBeUndefined();
      await expect(runner.get("missing-pane")).rejects.toThrow();
      await expect(
        nativeHerdrRead({ ...binding, socketPath: join(herdr.root, "missing.sock") }, ["pane", "list"]),
      ).rejects.toThrow();
      const unavailable = createHerdrWatchRunner(
        undefined,
        async () => {
          throw new Error("No fallback after binding revocation");
        },
        undefined,
        { localReadBinding: async () => undefined },
      );
      await expect(unavailable.list!()).rejects.toThrow("Herdr execution is unavailable");
    } finally {
      await herdr.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
