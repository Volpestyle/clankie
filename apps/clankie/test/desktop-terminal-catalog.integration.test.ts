import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { OperatorTerminalObservationResult } from "@clankie/protocol";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parseHerdrTerminalCatalog } from "../src/captain/herdr-census.ts";
import { herdrCoreCall, herdrCoreSocketPath } from "../src/captain/herdr-core.ts";
import { RuntimeTerminals } from "../src/captain/runtime-terminals.ts";

// The Herdr desktop app's terminals in the owner's terminal catalog, end to end against a
// real herdr-core: the layout the app keeps in the core's `herdr-app` document, the names it
// writes as `where` labels, and a watch-only attach for the phone's tail. The test runs its own
// core session, so the owner's app and its terminals are never touched.

const exec = promisify(execFile);
const hc = (process.env.PATH ?? "")
  .split(delimiter)
  .map((dir) => join(dir, "hc"))
  .concat(join(homedir(), ".local", "bin", "hc"))
  .find((path) => existsSync(path));
// Short: the session names the socket twice, and macOS caps a socket path at 103 bytes.
const session = `ckt-${process.pid}`;
const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries({ ...process.env, HC_SESSION: session }).filter(
    ([key]) => !["HC_SOCKET", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"].includes(key),
  ),
);
const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
const socket = herdrCoreSocketPath(env);
let cwd = "";
let go = "";
let agent = "";
let shell = "";

async function run(...args: string[]): Promise<string> {
  return (await exec(hc!, args, { env, cwd })).stdout;
}

async function started(...args: string[]): Promise<string> {
  return (JSON.parse(await run("run", "--bg", "--json", ...args)) as { address: string }).address;
}

const coreIt = it.skipIf(hc === undefined || process.platform === "win32");

beforeAll(async () => {
  if (hc === undefined || process.platform === "win32") return;
  cwd = await mkdtemp(join(tmpdir(), "clankie-desktop-terms-"));
  go = join(cwd, "go");
  // An agent, as hc defines one: a program that reports its status (OSC 7501). It prints its
  // next line once `go` exists.
  agent = await started(
    "--name",
    "agent",
    "--",
    process.execPath,
    "-e",
    `process.stdout.write("hello from the agent\\n");
process.stdout.write("\\x1b]7501;state=idle:app=claude-code\\x1b\\\\");
const fs = require("node:fs");
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(go)})) return;
  clearInterval(timer);
  process.stdout.write("second line after go\\n");
}, 100);
setInterval(() => {}, 1 << 30);`,
  );
  // A program that reports nothing, named by nothing but what it is and where.
  shell = await started("--name", "plain", "--", "sh", "-c", "exec sleep 600");
  await run("wait", "agent");
  // The window's layout, as the desktop app keeps it, and the names it writes.
  await run("label", agent, "clankie.seat=clankie · Review bot", "where=work / 1");
  await herdrCoreCall(socket, "doc.set", {
    name: "herdr-app",
    version: 0,
    value: {
      spaces: [
        {
          id: "sp-work",
          name: "",
          folder: cwd,
          tabs: [
            {
              id: "tb-one",
              name: "",
              root: {
                id: "tb-one",
                type: "row",
                children: [
                  { id: "p-a", type: "block", content: { terminal: agent } },
                  { id: "p-b", type: "block", content: { terminal: shell } },
                ],
              },
            },
          ],
        },
        // A named space and tab, and a pane whose terminal is gone, which isn't listed.
        {
          id: "sp-notes",
          name: "Notes",
          folder: cwd,
          tabs: [
            {
              id: "tb-gone",
              name: "scratch",
              root: { id: "p-gone", type: "block", content: { terminal: "tzz9" } },
            },
          ],
        },
      ],
    },
  });
});

afterAll(async () => {
  if (hc === undefined || process.platform === "win32") return;
  await run("server", "stop").catch(() => undefined);
  await rm(join(stateHome, "herdr-core", session), { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

function screen(result: OperatorTerminalObservationResult): string {
  return result.status === "page"
    ? result.frames.map((frame) => Buffer.from(frame.data, "base64").toString("utf8")).join("")
    : "";
}

coreIt("lists the desktop app's terminals by its own names, and the phone watches one live", async () => {
  const terminals = new RuntimeTerminals({ defaultAvailable: () => false, desktopSocket: () => socket });
  try {
    // hc reads a terminal's foreground about twice a second; the agent is one once it's known.
    let catalog = await terminals.catalog({ seatIds: true });
    for (const end = Date.now() + 10_000; Date.now() < end;) {
      if (catalog[0]?.agent !== undefined && catalog[1]?.label.startsWith("sleep")) break;
      await new Promise((done) => setTimeout(done, 100));
      catalog = await terminals.catalog({ seatIds: true });
    }
    expect(catalog).toEqual([
      {
        runtime: { id: "herdr-core", session: "Herdr app" },
        terminalId: `herdr-core/${agent}`,
        label: "clankie · Review bot",
        workspace: { id: "sp-work", label: "work", number: 1 },
        tab: { id: "tb-one", label: "1", number: 1 },
        pane: { id: `herdr-core/${agent}` },
        agent: "claude-code",
        seatId: `herdr-core/${agent}`,
      },
      {
        runtime: { id: "herdr-core", session: "Herdr app" },
        terminalId: `herdr-core/${shell}`,
        label: `sleep · ${basename(cwd)}`,
        workspace: { id: "sp-work", label: "work", number: 1 },
        tab: { id: "tb-one", label: "1", number: 1 },
        pane: { id: `herdr-core/${shell}` },
        seatId: `herdr-core/${shell}`,
      },
    ]);

    const observation = {
      schemaVersion: 1 as const,
      terminalId: `herdr-core/${agent}`,
      surfaceClientId: "phone",
    };
    const first = await terminals.tail(observation);
    expect(first.status).toBe("page");
    if (first.status !== "page") return;
    expect(first.terminalId).toBe(`herdr-core/${agent}`);
    expect(first.frames[0]?.full).toBe(true);
    expect(screen(first)).toContain("hello from the agent");

    await writeFile(go, "");
    let cursor = first.cursor;
    let later = "";
    for (const end = Date.now() + 10_000; Date.now() < end && !later.includes("second line");) {
      const next = await terminals.tail({ ...observation, cursor });
      expect(next.status).toBe("page");
      if (next.status !== "page") return;
      expect(next.frames.every((frame) => !frame.full && frame.terminalId === observation.terminalId)).toBe(
        true,
      );
      later += screen(next);
      cursor = next.cursor;
    }
    expect(later).toContain("second line after go");

    // Watched, never steered: no control lease or input reaches a desktop-app terminal here.
    const control = await terminals.control({
      schemaVersion: 1,
      terminalId: `herdr-core/${agent}`,
      surfaceClientId: "phone",
      action: "request",
    });
    expect(control.status).toBe("unavailable");
    // A terminal the core doesn't have is unavailable, not a hang.
    expect((await terminals.tail({ ...observation, terminalId: "herdr-core/tzz9" })).status).toBe(
      "unavailable",
    );
  } finally {
    terminals.close();
  }
});

it("names a Herdr pane by its own label, else what runs in it and where, never its pane id", () => {
  // `herdr api snapshot` from this Mac on 2026-11-03: a hire's pane carries a label and no
  // title, a plain shell neither.
  const snapshot = JSON.stringify({
    result: {
      snapshot: {
        workspaces: [
          { workspace_id: "w1", label: "~", number: 1 },
          { workspace_id: "w4", label: "clankie-app", number: 2 },
        ],
        tabs: [
          { tab_id: "w1:t1", workspace_id: "w1", label: "1", number: 1 },
          { tab_id: "w4:t1", workspace_id: "w4", label: "clankie", number: 1 },
        ],
        panes: [
          {
            pane_id: "w1:p1",
            tab_id: "w1:t1",
            workspace_id: "w1",
            terminal_id: "term_65f64c246c6241",
            cwd: "/Users/james/dev",
            foreground_cwd: "/Users/james/dev",
            agent_status: "unknown",
          },
          {
            pane_id: "w4:p1",
            tab_id: "w4:t1",
            workspace_id: "w4",
            terminal_id: "term_65f64c246db882",
            label: "clankie · Task: capture three simulator screenshots of…",
            cwd: "/Users/james/dev/clankie-app/.local/wt-clankie-465e2d",
            agent_status: "unknown",
          },
        ],
      },
    },
  });
  expect(parseHerdrTerminalCatalog(snapshot).map((pane) => pane.label)).toEqual([
    "shell · dev",
    "clankie · Task: capture three simulator screenshots of…",
  ]);
});
