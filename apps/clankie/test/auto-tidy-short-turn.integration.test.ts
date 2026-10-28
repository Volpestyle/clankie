// VUH-2938: real process/Herdr terminal detection, a scratch HOME, and production
// snapshot parsing. The close seam records attempts; this proof never closes a pane.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createAutoTidy, AUTO_TIDY_PANE_CHECK_MS } from "../src/captain/auto-tidy.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

const exec = promisify(execFile);
const window = 60 * 60_000;

it.skipIf(process.platform !== "darwin")(
  "restarts the idle window for a completed turn between polls and for an acknowledged report",
  async () => {
    const logs = await mkdtemp("/tmp/tidy-short-turn-");
    const herdr = await isolatedHerdr(logs);
    try {
      expect(herdr.env.HOME).toBe(join(herdr.root, "home"));
      expect(herdr.restoredWorkspaceCount).toBe(0);
      const runner = createHerdrWatchRunner(
        undefined,
        async (args) => (await exec("herdr", [...args], { env: herdr.env, timeout: 5_000 })).stdout,
        undefined,
        { localCodexRecovery: false },
      );
      // A minimal real foreground process gives Herdr a native occupant. No harness,
      // updater, credentials or model calls enter the scratch environment.
      const source = join(herdr.root, "occupant.c");
      const binary = join(herdr.root, "claude");
      await writeFile(
        source,
        [
          "#include <stdio.h>",
          "int main(void) { char line[32]; while (fgets(line, sizeof(line), stdin)) {",
          "if (line[0] == 'w') puts(\"\x1b]0;⠋ Claude\x07\");",
          'else puts("\x1b]0;✳ Claude\x07"); fflush(stdout); } }',
        ].join("\n"),
      );
      await exec("cc", [source, "-o", binary], { env: herdr.env, timeout: 10_000 });
      await herdr.cli("pane", "run", herdr.pane, binary);
      await expect
        .poll(
          () =>
            runner.get(herdr.pane).then(
              (agent) => agent.agent,
              () => undefined,
            ),
          { timeout: 5_000, interval: 50 },
        )
        .toBe("claude");
      const report = (state: "idle" | "working") =>
        herdr.cli("pane", "send-text", herdr.pane, state === "working" ? "w\n" : "i\n");
      await herdr.cli(
        "pane",
        "report-agent-session",
        herdr.pane,
        "--source",
        "herdr:claude",
        "--agent",
        "claude",
        "--agent-session-id",
        "scratch-short-turn",
      );
      await report("idle");
      await expect
        .poll(() => runner.get(herdr.pane).then((agent) => agent.status), { timeout: 5_000, interval: 50 })
        .toMatch(/^(idle|done)$/u);
      const initial = await runner.get(herdr.pane);
      expect(initial.status).toMatch(/^(idle|done)$/u);
      expect(initial.session?.value).toBe("scratch-short-turn");
      expect(initial.stateChangeSeq).toBeTypeOf("number");
      let clock = Date.now();
      let reportedAt: string | undefined;
      const attempts: string[] = [];
      let authorizeClose: (() => Promise<boolean>) | undefined;
      const auto = createAutoTidy({
        setting: async () => "1h",
        runner,
        activityAt: () => [reportedAt],
        tidy: {
          keptPane: () => undefined,
          keepVersion: () => 0,
          hasKeptReport: () => true,
          close: async ({ pane }, authority) => {
            authorizeClose = authority.authorize;
            expect(await authorizeClose()).toBe(true);
            attempts.push(pane);
            return { outcome: "failed", reason: "provenance_unknown" };
          },
        },
        provenance: () => ({ conversationId: "scratch-lead" }),
        unreadReports: () => 0, // Already acknowledged: still protects the full window.
        ownerValid: async () => true,
        closed: async () => {},
        checkouts: async () => [],
        prune: async () => {
          throw new Error("No worktrees in this proof");
        },
        stopped: () => false,
        now: () => clock,
      });
      await auto.panes();
      clock += window - AUTO_TIDY_PANE_CHECK_MS;
      await auto.panes();
      const started = Date.now();
      await report("working");

      await expect
        .poll(() => runner.get(herdr.pane).then((agent) => agent.status), { timeout: 5_000, interval: 50 })
        .toBe("working");
      await report("idle");
      await expect
        .poll(() => runner.get(herdr.pane).then((agent) => agent.status), { timeout: 5_000, interval: 50 })
        .toMatch(/^(idle|done)$/u);
      const completed = await runner.get(herdr.pane);
      const turnMs = Date.now() - started;
      expect(turnMs).toBeLessThan(AUTO_TIDY_PANE_CHECK_MS);
      expect(completed.stateChangeSeq).toBeGreaterThan(initial.stateChangeSeq!);
      // No tidy pass saw working. The original idle window now expires.
      clock += AUTO_TIDY_PANE_CHECK_MS;
      await auto.panes();
      expect(attempts).toEqual([]);
      clock += window - 1;
      await auto.panes();
      expect(attempts).toEqual([]);
      // A report without another native state transition must also renew the clock.
      reportedAt = new Date(clock).toISOString();
      clock += 2;
      await auto.panes();
      expect(attempts).toEqual([]);
      clock = Date.parse(reportedAt) + window - 1;
      await auto.panes();
      expect(attempts).toEqual([]);
      clock += 1;
      await auto.panes();
      expect(attempts).toEqual([herdr.pane]);
      // A report arriving during close checks invalidates the existing authority.
      reportedAt = new Date(clock).toISOString();
      expect(await authorizeClose!()).toBe(false);
      expect((await runner.get(herdr.pane)).session?.value).toBe("scratch-short-turn");
    } finally {
      await herdr.close();
      await rm(logs, { recursive: true, force: true });
    }
  },
);
