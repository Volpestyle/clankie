import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
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
