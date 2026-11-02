import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import type { OperatorFleetSeat } from "@clankie/protocol";
import type { HerdrFleet } from "../src/herdr-fleet.ts";
import { createRemoteHerdrRunner, routeHerdrFleets } from "../src/captain/herdr-fleet-runner.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import {
  createOperatorService,
  type CreateOperatorServiceContext,
} from "../src/captain/captain-operator-service.ts";
import { RuntimeTerminals } from "../src/captain/runtime-terminals.ts";

const exec = promisify(execFile);

// #298: a quiet hire (waiting on CI) must still show its last screen to its lead, on this Mac
// and over the linked-PC read path, while an agent the owner started by hand keeps ADR 0307's
// cut. Real Herdr, real local and remote runners and the real operator service; only `codex`
// is a stand-in that reports itself to Herdr as Codex does, prints, then goes quiet. The PC's
// ssh transport is stood in by running the same argv against this Herdr.
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("a quiet Clankie hire shows its last screen locally and on a PC; an owner's agent keeps the cut", async () => {
  // Short path: macOS socket limit.
  const root = await mkdtemp("/tmp/quiet-read-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(join(root, "work"), { recursive: true });
  await writeFile(
    join(root, "config/config.toml"),
    'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\n[update]\nversion_check = false\nmanifest_check = false\n',
  );
  await writeFile(
    join(root, "bin/codex"),
    `#!${process.execPath}
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
execFileSync("herdr", ["pane", "report-agent", process.env.HERDR_PANE_ID, "--source", "herdr:codex",
  "--agent", "codex", "--state", "idle", "--agent-session-id", randomUUID()]);
process.stdout.write("Codex: fixing #298\\nPR opened as a draft\\nWaiting on CI\\n");
setInterval(() => {}, 1 << 30);
`,
  );
  await chmod(join(root, "bin/codex"), 0o755);
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_"))),
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    HOME: join(root, "work"),
    HERDR_SOCKET_PATH: join(root, "herdr.sock"),
    HERDR_CONFIG_PATH: join(root, "config/config.toml"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    SHELL: "/bin/sh",
  };
  const server = spawn("herdr", ["server"], { env, stdio: "ignore" });
  cleanups.push(async () => {
    await exec("herdr", ["server", "stop"], { env }).catch(() => server.kill("SIGKILL"));
  });
  await expect.poll(() => existsSync(env.HERDR_SOCKET_PATH!), { timeout: 10_000 }).toBe(true);
  const herdr = async (args: readonly string[]) =>
    (await exec("herdr", [...args], { env, timeout: 15_000 })).stdout;

  const local = createHerdrWatchRunner(() => true, herdr, undefined, { localCodexRecovery: false });
  const pc: HerdrFleet = { id: "pc", session: "default", ssh: { host: "pc", shell: "posix" } };
  const runner = routeHerdrFleets(
    local,
    new Map([["pc", createRemoteHerdrRunner(pc, async (args) => herdr(args), { pollMs: 0 })]]),
  );

  // Clankie's hire: a tab he opens, then the harness launched at its prompt. (hire_agent uses
  // `herdr agent start`, which waits on real Codex's readiness the stand-in doesn't draw.)
  const hirePane = await runner.createTab!({ cwd: join(root, "work"), label: "quiet hire" });
  await runner.runInPane!(hirePane, ["codex"]);
  // The owner's own agent: shell work, then Codex, in a tab Clankie didn't hire into.
  const ownerPane = await runner.createTab!({ cwd: join(root, "work"), label: "owner" });
  await runner.runInPane!(ownerPane, ["sh", "-c", "echo TOKEN=owner-secret; exec codex"]);

  const settled = async (paneId: string) => {
    let text = "";
    await expect
      .poll(
        async () => {
          const pane = await runner.get(paneId);
          text = await runner.readPane!(paneId, "recent-unwrapped", "text");
          return pane.agent === "codex" && pane.session !== undefined && text.includes("Waiting on CI");
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    return runner.get(paneId);
  };
  const hire = await settled(hirePane);
  const owner = await settled(ownerPane);
  const seat = (terminalId: string, session: NonNullable<typeof hire.session>, hired: boolean) =>
    ({
      seatId: terminalId,
      occupantId: occupantIdForHerdrSession(session),
      personaId: "persona-quiet",
      harness: "codex",
      status: "idle",
      title: "quiet hire",
      owner: { conversationId: "global-default", hired },
    }) as unknown as OperatorFleetSeat;
  const serve = createOperatorService({
    deps: { herdrAvailable: () => true, fleets: { list: [pc], run: () => herdr, remoteWorkspace: async () => false } },
    shutdown: new AbortController(),
    personas: { ready: async () => {} },
    settingsStore: {},
    terminals: new RuntimeTerminals({ defaultAvailable: () => false }),
    herdrRunner: runner,
    // The fleet roster's hire claims, as the census projects them from hire-owners.
    liveSeats: [
      seat(hire.terminalId, hire.session!, true),
      seat(`pc/${hire.terminalId}`, hire.session!, true),
      // Adopted by messaging, never hired: still the owner's pane.
      seat(owner.terminalId, owner.session!, false),
    ],
  } as unknown as CreateOperatorServiceContext);
  const read = (terminalId: string) => serve({ op: "terminal_read", schemaVersion: 1, terminalId });

  // The hire printed, then went quiet: its very first read, here and over the PC path, shows
  // its last screen with nothing held back.
  for (const terminalId of [hire.terminalId, `pc/${hire.terminalId}`]) {
    const answer = await read(terminalId);
    expect(answer).toMatchObject({ status: "read", text: expect.stringContaining("Waiting on CI") });
    expect(answer).not.toHaveProperty("detail");
    // Still quiet on a second read: the screen stays readable.
    expect(await read(terminalId)).toMatchObject({ text: expect.stringContaining("PR opened as a draft") });
  }

  // The owner's agent: its first screen, with the shell work above it, stays held back and says so.
  for (const terminalId of [owner.terminalId, `pc/${owner.terminalId}`]) {
    const answer = await read(terminalId);
    expect(answer).toMatchObject({
      status: "read",
      text: "",
      detail: "Earlier screen hidden until this agent prints something new.",
    });
    expect(JSON.stringify(answer)).not.toContain("owner-secret");
  }
}, 60_000);
