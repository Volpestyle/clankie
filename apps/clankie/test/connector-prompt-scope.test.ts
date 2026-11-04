import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ConnectorPromptAnswers } from "../src/app/connector-prompt-answers.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { readPromptScreen, refuseStep } from "../src/captain/prompt-answer-guard.ts";

// What scopes a connected app's prompt answers and key presses (amended ADR 0303 and
// ADR 0323), on the real journals and on the prompt text Claude Code and Codex show.

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const root = async () => {
  const made = await mkdtemp(join(tmpdir(), "connector-prompt-scope-"));
  roots.push(made);
  return made;
};

it("an app's own hire is matched only on its exact pane, seat and session", async () => {
  const path = join(await root(), "owners.json");
  const owners = new HireOwners(path);
  const lead = { conversationId: "lead-1" };
  const session = JSON.stringify(["local", "claude", "s-1"]);
  owners.bind(
    "w1:p1",
    lead,
    "t1",
    owners.intent(lead, { kind: "app", deviceId: "dev-claude" }),
    "o1",
    session,
  );
  owners.bind("w1:p2", lead, "t2", owners.intent(lead, { kind: "owner" }), "o2", "s-2");
  owners.bind("w1:p3", lead, "t3", owners.intent(lead), "o3", "s-3");
  owners.adopt("w1:p4", "t4", "o4", lead);

  // Read back from disk, as a restarted service does.
  const read = new HireOwners(path);
  expect(read.hiredByApp("w1:p1", "t1", "o1", "dev-claude")).toBe(true);
  // Another app, another occupant of the same seat, the seat in another pane.
  expect(read.hiredByApp("w1:p1", "t1", "o1", "dev-grok")).toBe(false);
  expect(read.hiredByApp("w1:p1", "t1", "o-new", "dev-claude")).toBe(false);
  expect(read.hiredByApp("w2:p1", "t1", "o1", "dev-claude")).toBe(false);
  // A hire the owner asked for, one Clankie chose, and a seat only adopted by messaging.
  expect(read.hiredByApp("w1:p2", "t2", "o2", "dev-claude")).toBe(false);
  expect(read.hiredByApp("w1:p3", "t3", "o3", "dev-claude")).toBe(false);
  expect(read.hiredByApp("w1:p4", "t4", "o4", "dev-claude")).toBe(false);
});

it("the switch file is read once at start; an edit on disk afterwards changes nothing", async () => {
  const path = join(await root(), "connector-prompt-answers.json");
  // An older file still loads.
  await writeFile(path, JSON.stringify({ schemaVersion: 1, deviceIds: ["dev-claude"] }));
  const answers = new ConnectorPromptAnswers(path);
  expect(answers.allowed("dev-claude")).toBe(true);

  // Something else rewrites the file while the service runs.
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 2,
      deviceIds: ["dev-claude", "dev-grok"],
      paneGrants: [{ deviceId: "dev-grok", terminalId: "w1:p9" }],
    }),
  );
  expect(answers.allowed("dev-grok")).toBe(false);
  expect(answers.paneGranted("dev-grok", "w1:p9")).toBe(false);

  // The owner's own change writes what the service holds, and the edit is gone.
  expect(answers.setPane("dev-claude", "w1:p2", true)).toBe(true);
  const written = JSON.parse(await readFile(path, "utf8")) as unknown;
  expect(written).toEqual({
    schemaVersion: 2,
    deviceIds: ["dev-claude"],
    paneGrants: [{ deviceId: "dev-claude", terminalId: "w1:p2" }],
  });
  const restarted = new ConnectorPromptAnswers(path);
  expect(restarted.paneGranted("dev-claude", "w1:p2")).toBe(true);
  expect(restarted.paneGranted("dev-claude", "w1:p3")).toBe(false);
  expect(restarted.panes("dev-claude")).toEqual(["w1:p2"]);
  restarted.setPane("dev-claude", "w1:p2", false);
  expect(new ConnectorPromptAnswers(path).paneGranted("dev-claude", "w1:p2")).toBe(false);
});

// Transcribed from Claude Code 2.x and Codex CLI screens: the bottom of each pane, box edges included.
const claudeBash = [
  "╭──────────────────────────────────────────────────────────────╮",
  "│ Bash command                                                 │",
  "│                                                              │",
  "│   pnpm vitest run apps/clankie/test/foo.test.ts              │",
  "│   Run the focused test                                       │",
  "│                                                              │",
  "│ Do you want to proceed?                                      │",
  "│ ❯ 1. Yes                                                     │",
  "│   2. Yes, and don't ask again for pnpm vitest commands in    │",
  "│      /Users/me/dev/app                                       │",
  "│   3. No, and tell Claude what to do differently (esc)        │",
  "╰──────────────────────────────────────────────────────────────╯",
].join("\n");
const claudeEdit = [
  "Edit file",
  "src/app.ts",
  "Do you want to make this edit to app.ts?",
  "❯ 1. Yes",
  "  2. Yes, allow all edits during this session (shift+tab)",
  "  3. No, and tell Claude what to do differently (esc)",
].join("\n");
const codexCommand = [
  "Would you like to run the following command?",
  "",
  "  $ cargo test -p core",
  "",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for this command (a)",
  "  3. No, and tell Codex what to do differently (esc)",
  "",
  "  Press enter to confirm or esc to cancel",
].join("\n");
const claudeIdle = ["⏺ Done. The tests pass.", "", "> ", "  ⏵⏵ accept edits on (shift+tab to cycle)"].join(
  "\n",
);

it("reads real permission prompts: their safe options stay answerable, the persistent ones don't", () => {
  for (const screen of [claudeBash, claudeEdit, codexCommand]) {
    const read = readPromptScreen(screen);
    expect(read.risky).toBeUndefined();
    expect(read.menu).toBe(true);
    expect(read.options.map((option) => option.persistent)).toEqual([false, true, false]);
    expect(refuseStep(screen, { text: "1" })).toBeUndefined();
    expect(refuseStep(screen, { key: "1" })).toBeUndefined();
    expect(refuseStep(screen, { key: "enter" })).toBeUndefined();
    expect(refuseStep(screen, { key: "esc" })).toBeUndefined();
    expect(refuseStep(screen, { text: "3" })).toBeUndefined();
    expect(refuseStep(screen, { text: "2" })).toContain("approves more than this one prompt");
    expect(refuseStep(screen, { key: "2" })).toContain("approves more than this one prompt");
    expect(refuseStep(screen, { key: "down" })).toContain("pick an option by its number");
    expect(refuseStep(screen, { key: "shift+tab" })).toContain("shift+tab");
    expect(refuseStep(screen, { key: "a" })).toContain("pick by number");
  }
  // With the pointer moved onto the persistent option, enter is refused.
  expect(
    refuseStep(claudeEdit.replace("❯ 1. Yes", "  1. Yes").replace("  2.", "❯ 2."), { key: "enter" }),
  ).toContain("enter would pick");
  // The mode footer of an idle pane is not a question; typing into its input is refused.
  expect(readPromptScreen(claudeIdle).risky).toBeUndefined();
  expect(refuseStep(claudeIdle, { key: "enter" })).toBeUndefined();
  expect(refuseStep(claudeIdle, { key: "ctrl+c" })).toBeUndefined();
  expect(refuseStep(claudeIdle, { key: "l" })).toContain("a letter is only pressed");
  expect(refuseStep(claudeIdle, { key: "shift+tab" })).toContain("shift+tab");
  expect(refuseStep(claudeIdle, { key: "alt+m" })).toContain("alt with a letter");
});

it("refuses the screens and typed text that are the owner's to answer", () => {
  const bash = (command: string) =>
    claudeBash.replace("pnpm vitest run apps/clankie/test/foo.test.ts", command);
  expect(refuseStep(bash("rm -rf node_modules dist"), { text: "1" })).toContain("rm -rf");
  expect(refuseStep(bash("rm -r -f build"), { text: "1" })).toContain("rm -rf");
  expect(refuseStep(bash("git push --force origin main"), { text: "1" })).toContain("force-pushes");
  expect(refuseStep(bash("git push -f origin main"), { text: "1" })).toContain("force-pushes");
  expect(refuseStep(bash("git push origin +main"), { text: "1" })).toContain("force-pushes");
  expect(refuseStep(bash("security find-generic-password -s npm"), { text: "1" })).toContain("password");
  expect(refuseStep(bash("cat ~/.aws/credentials"), { text: "1" })).toContain("password, token, key");
  // Ordinary commands that look alike are not refused.
  expect(refuseStep(bash("rm build/out.txt"), { text: "1" })).toBeUndefined();
  expect(refuseStep(bash("git push origin main"), { text: "1" })).toBeUndefined();
  expect(refuseStep(bash("git push --set-upstream origin feature"), { text: "1" })).toBeUndefined();

  const bypass = [
    "WARNING: Claude Code running in Bypass Permissions mode",
    "By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.",
    "❯ 1. No, exit",
    "  2. Yes, I accept",
  ].join("\n");
  expect(refuseStep(bypass, { text: "2" })).toContain("permission mode");
  expect(refuseStep(bypass, { key: "enter" })).toContain("permission mode");
  expect(refuseStep("Allow always for this project? (y/n)", { key: "y" })).toContain(
    "more than this one prompt",
  );
  expect(refuseStep("Enter your password:", { text: "hunter2" })).toContain("password");
  expect(refuseStep("Paste your API key to continue:", { text: "sk-1" })).toContain("token, key");
  expect(refuseStep("Confirm purchase of 1,000 credits?\n❯ 1. Yes\n  2. No", { text: "1" })).toContain(
    "spends money",
  );

  // Text typed at a question: not a command, a mode or a persistent approval.
  const question = "Which layout should the page use?\n❯ 1. Grid\n  2. Stack\n  3. Type something";
  expect(refuseStep(question, { text: "Grid, but two columns" })).toBeUndefined();
  expect(refuseStep(question, { text: "/permissions" })).toContain("command");
  expect(refuseStep(question, { text: "!rm -rf ~" })).toContain("command");
  expect(refuseStep(question, { text: "yes, and don't ask again" })).toContain("owner must answer");
  expect(refuseStep(question, { text: "9" })).toContain("no option");
  expect(refuseStep("Overwrite README.md? (y/n)", { key: "y" })).toBeUndefined();
  expect(refuseStep("Overwrite README.md? (y/n)", { key: "x" })).toContain("only y or n");
});
