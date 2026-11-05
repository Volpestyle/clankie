import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { paneInputLine } from "../src/captain/pane-draft.ts";

const exec = promisify(execFile);
const screen = (harness: string) =>
  readFileSync(new URL(`./fixtures/pane-draft/${harness}-empty.ansi`, import.meta.url), "utf8");
const plain = (value: string) => value.replaceAll(/\u001b\[[0-9;]*m/gu, "");

test("captured native composers survive Herdr's real styled visible-read boundary without pane input", async () => {
  const root = await mkdtemp("/tmp/input-read-");
  let server: ReturnType<typeof spawn> | undefined;
  try {
    const launcher = join(root, "fixture");
    await writeFile(
      launcher,
      `#!${process.execPath}
import { readFileSync } from "node:fs";
const screen = readFileSync("screen.ansi", "utf8");
const rows = screen.split("\\n");
process.stdout.write("\\x1b[2J\\x1b[H" + "\\r\\n".repeat(40 - rows.length) + rows.join("\\r\\n"));
setInterval(() => {}, 60000);
`,
    );
    await chmod(launcher, 0o755);
    const config = join(root, "config.toml");
    await writeFile(
      config,
      `onboarding=false\n[terminal]\ndefault_shell=${JSON.stringify(launcher)}\nshell_mode="non_login"\n[update]\nversion_check=false\nmanifest_check=false\n`,
    );
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      NODE_ENV: "test",
      HERDR_CONFIG_PATH: config,
      HERDR_SOCKET_PATH: join(root, "server.sock"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CACHE_HOME: join(root, "cache"),
    };
    server = spawn("herdr", ["server"], { env, stdio: "ignore" });
    await expect.poll(() => existsSync(env.HERDR_SOCKET_PATH), { timeout: 10_000 }).toBe(true);
    const calls: string[][] = [];
    const run = async (args: readonly string[]) => {
      // This fixture has no route for send, focus, scroll, agent-start or keys.
      expect(["workspace create", "pane list", "pane read"]).toContain(args.slice(0, 2).join(" "));
      calls.push([...args]);
      return (await exec("herdr", [...args], { env, timeout: 10_000 })).stdout;
    };
    const runner = createHerdrWatchRunner(() => true, run, undefined, { localCodexRecovery: false });
    for (const harness of ["pi", "grok", "opencode"]) {
      const cwd = join(root, harness);
      await mkdir(cwd);
      await writeFile(join(cwd, "screen.ansi"), screen(harness));
      await run(["workspace", "create", "--cwd", cwd, "--label", "fixture", "--no-focus"]);
      const roster = JSON.parse(await run(["pane", "list"]));
      const pane = roster.result.panes.find(
        (value: { cwd: string }) => value.cwd === cwd || value.cwd === `/private${cwd}`,
      );
      expect(pane).toBeDefined();
      await expect
        .poll(async () => paneInputLine(harness, await runner.readPane!(pane.pane_id, "visible", "ansi")), {
          timeout: 10_000,
        })
        .toMatchObject({ state: "empty" });
      expect(paneInputLine(harness, await runner.readPane!(pane.pane_id, "visible", "text"))).toEqual({
        state: "unknown",
      });
    }
    expect(
      calls.filter((args) => args[0] === "pane" && args[1] === "read").every((args) => args[4] === "visible"),
    ).toBe(true);
  } finally {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise<void>((resolve) => server!.once("exit", () => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);

test.each(["pi", "grok", "opencode"])(
  "%s keeps plain, malformed and incomplete captures unknown",
  (harness) => {
    const ansi = screen(harness);
    expect(paneInputLine(harness, plain(ansi))).toEqual({ state: "unknown" });
    expect(paneInputLine(harness, `\u001b[H${ansi}`)).toEqual({ state: "unknown" });
    expect(paneInputLine(harness, ansi.replace(/[─▀╯]/gu, " "))).toEqual({ state: "unknown" });
    expect(paneInputLine(harness, "\u001b[0m")).toEqual({ state: "unknown" });
  },
);

test("Pi reads a draft, including a typed rule, instead of mistaking it for the frame", () => {
  const ansi = screen("pi");
  const rows = ansi.split("\n");
  rows[1] = "\u001b[0mReview the fixture";
  expect(paneInputLine("pi", rows.join("\n"))).toEqual({
    state: "draft",
    text: "Review the fixture",
    typed: true,
  });
  rows[1] = "\u001b[0m────────────";
  expect(paneInputLine("pi", rows.join("\n"))).toEqual({ state: "draft", text: "────────────", typed: true });
  rows[0] = rows[0]!.replace("────────", "── ↑ 2 more ──");
  expect(paneInputLine("pi", rows.join("\n"))).toEqual({ state: "unknown" });
});

test("Grok retains input and wrapped lines inside the frame, including dim text", () => {
  const rows = screen("grok").split("\n");
  rows[1] = rows[1]!.replace("❯ ", "❯ \u001b[2mReview the fixture\u001b[22m");
  // Replace padding rather than widening the terminal row.
  rows[1] = rows[1]!.replace(" ".repeat(18), "");
  expect(paneInputLine("grok", rows.join("\n"))).toEqual({
    state: "draft",
    text: "Review the fixture",
    typed: true,
  });
});

test("OpenCode distinguishes a native ghost from the same words typed normally or dimmed by its leader key", () => {
  const ansi = screen("opencode");
  const words = 'Ask anything… "What is the tech stack of this project?"';
  expect(paneInputLine("opencode", ansi)).toEqual({ state: "empty", text: words, typed: false });
  const typed = ansi.replace(
    `\u001b[38;2;128;128;128m\u001b[48;2;30;30;30m${words}`,
    `\u001b[38;2;238;238;238m\u001b[48;2;30;30;30m${words}`,
  );
  expect(paneInputLine("opencode", typed)).toEqual({ state: "draft", text: words, typed: true });
  const leader = ansi.replaceAll("\u001b[38;2;238;238;238m", "\u001b[38;2;128;128;128m");
  expect(paneInputLine("opencode", leader).state).not.toBe("empty");
  const rows = ansi.split("\n");
  rows.splice(1, 0, rows[1]!.replace(words, "Review the fixture"), rows[0]!);
  expect(paneInputLine("opencode", rows.join("\n")).state).not.toBe("empty");
});
