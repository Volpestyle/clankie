import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import {
  OperatorConversationServiceResultSchema,
  parseProtocolResponse,
  type FeedListResult,
  type OperatorConversationServiceRequest,
} from "@clankie/protocol";
import { createClankieApp } from "../src/app.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { routeHerdrFleets } from "../src/captain/herdr-fleet-runner.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { createPanePromptAsks, PANE_PROMPT_ORIGIN } from "../src/captain/pane-prompt-asks.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createPromptAnswerer } from "../src/captain/prompt-answer.ts";

const exec = promisify(execFile);

// #149: an agent the owner opened by hand, with no lead and no hooks, shows a
// permission menu; Herdr marks its pane blocked. Its question reaches the owner's
// feed over the service's HTTP API, and the owner's answer there presses the keys
// that pick that option, under answer_prompt's checks. Real Herdr, the real routed
// runner, the real conversation store and service app; only `claude` is a stand-in
// that draws Claude Code's menu, takes arrow keys and enter, and records its pick.
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const OWNER = `clankie_op_${"f".repeat(43)}`;

const standIn = `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
process.title = "claude";
writeFileSync(process.env.STAND_IN_PID, String(process.pid));
execFileSync("herdr", ["pane", "report-agent", process.env.HERDR_PANE_ID, "--source", "herdr:claude",
  "--agent", "claude", "--state", "idle", "--agent-session-id", "6b1f3c2a-1d4e-4f5a-8b9c-0d1e2f3a4b5c"]);
const menus = {
  push: { title: "Bash command", detail: "git push origin main", question: "Do you want to proceed?",
    options: ["Yes", "Yes, and don't ask again for git push commands", "No, and tell Claude what to do differently (esc)"] },
  edit: { title: "Edit file", detail: "notes.md", question: "Do you want to make this edit to notes.md?",
    options: ["Yes", "No"] },
};
let menu = menus.push;
let selected = 0;
let open = true;
const draw = () => {
  const rows = ["\\x1b[2J\\x1b[H────────────────────────────────", " " + menu.title, "", "   " + menu.detail, "",
    " " + menu.question,
    ...menu.options.map((label, index) => (index === selected ? " ❯ " : "   ") + (index + 1) + ". " + label),
    "", " Esc to cancel", ""];
  process.stdout.write(rows.join("\\n"));
};
process.stdin.setRawMode(true);
process.stdin.on("data", (chunk) => {
  if (!open) return;
  const keys = chunk.toString("latin1");
  appendFileSync(process.env.STAND_IN_KEYS, JSON.stringify(keys) + "\\n");
  if (keys === "\\x1b[B") selected = Math.min(selected + 1, menu.options.length - 1);
  else if (keys === "\\x1b[A") selected = Math.max(selected - 1, 0);
  else if (keys === "\\r") {
    open = false;
    appendFileSync(process.env.STAND_IN_CHOICE, menu.question + " => " + menu.options[selected] + "\\n");
    process.stdout.write("\\x1b[2J\\x1b[H● Picked " + menu.options[selected] + "\\n\\n> \\n");
    return;
  }
  draw();
});
// The agent moves on to another question on its own, as one does after the owner answers at the keyboard.
process.on("SIGHUP", () => {
  menu = menus.push;
  selected = 0;
  open = true;
  draw();
});
process.on("SIGUSR2", () => {
  menu = menus.edit;
  selected = 0;
  open = true;
  draw();
});
draw();
`;

test("a hand-opened agent's menu reaches the feed and the owner's answer there picks it", async () => {
  // Short path: macOS socket limit.
  const root = await mkdtemp("/tmp/pane-prompt-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["config", "bin", "work", "state", "data", "cache"])
    await mkdir(join(root, directory), { recursive: true });
  await writeFile(
    join(root, "config/config.toml"),
    'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\n[update]\nversion_check = false\nmanifest_check = false\n',
  );
  await writeFile(join(root, "bin/claude"), standIn);
  await chmod(join(root, "bin/claude"), 0o755);
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
  const runner = routeHerdrFleets(
    createHerdrWatchRunner(() => true, herdr, undefined, { localCodexRecovery: false }),
    new Map(),
  );

  // The owner's conversation and the service app that serves his feed.
  // What Clankie hears in his own conversation: each turn's message.
  const turns: string[] = [];
  const store = new ConversationStore(join(root, "conversations"), async (_id, message) => {
    turns.push(message);
  });
  cleanups.push(() => store.close());
  const made = await store.serve({
    op: "create",
    schemaVersion: 1,
    scope: { kind: "workspace", workspaceId: join(root, "work") },
    title: "Clankie",
  });
  if (made.op !== "create") throw new Error("unexpected create result");
  const owner = made.conversation.conversationId;
  const notes: string[] = [];
  const led = new Set<string>();
  const answer = createPromptAnswerer({
    paneAddress: async (terminalId) => terminalId,
    runner,
    ownerAskPending: () => false,
    record: (_app, text) => notes.push(text),
    watching: async () => false,
  });
  const asks = createPanePromptAsks({
    agents: async () =>
      (await runner.list!()).map((agent) => ({
        terminalId: agent.terminalId,
        paneId: agent.paneId,
        agent: agent.agent,
        status: agent.status,
        name: agent.name ?? agent.terminalId,
        ...(agent.workingDirectory ? { workingDirectory: agent.workingDirectory } : {}),
        led: led.has(agent.terminalId),
      })),
    bindPane: (terminalId) => runner.bindPane!(terminalId),
    ask: (draft, origin) =>
      store.requestSurfaceQuestion(owner, draft, {
        current: () => true,
        publicationId: origin,
        exactPublication: true,
      }),
    cancel: (requestId, reason) => store.withdrawAsk(owner, requestId, reason),
    pending: () => store.pendingAsks(owner, PANE_PROMPT_ORIGIN),
    answer: (input) => answer({ app: "Your feed", owner: true, current: () => true, ...input }),
  });
  store.paneAnswer = asks;
  const service = await createClankieApp({
    captain: createStubCaptain({
      serveOperatorConversation: (request, authority) =>
        store.serve(request as Parameters<typeof store.serve>[0], authority),
    }),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === `Bearer ${OWNER}` ? { operatorId: "owner" } : undefined,
  });
  cleanups.push(() => service.close());
  const post = async (body: OperatorConversationServiceRequest | Record<string, unknown>) => {
    const response = await service.app.request("/operator/v1/dispatch", {
      method: "POST",
      headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return parseProtocolResponse(OperatorConversationServiceResultSchema, await response.json());
  };
  const feed = async () => {
    const result = await post({ op: "feed_list", schemaVersion: 1 });
    if (result.op !== "feed_list" || result.result.outcome !== "ready") throw new Error("unexpected feed");
    return (result.result as Extract<FeedListResult, { outcome: "ready" }>).items.flatMap((item) =>
      item.kind === "check" && item.check ? [item.check] : [],
    );
  };
  const reply = async ({ question, revision }: Awaited<ReturnType<typeof feed>>[number], label: string) =>
    post({
      op: "input_answer",
      schemaVersion: 1,
      conversationId: question.conversationId,
      requestId: question.requestId,
      incarnationId: question.incarnationId,
      expectedRevision: revision,
      answer: {
        kind: "choice",
        optionId: question.options.find((option) => option.label === label)!.optionId,
      },
    });

  // The owner opens Claude Code by hand in a tab; it stops on a permission menu.
  const keys = join(root, "keys.jsonl");
  const choice = join(root, "choice.txt");
  const paneId = await runner.createTab!({ cwd: join(root, "work"), label: "by hand" });
  await herdr([
    "pane",
    "run",
    paneId,
    `STAND_IN_PID=${join(root, "stand-in.pid")} STAND_IN_KEYS=${keys} STAND_IN_CHOICE=${choice} ${join(root, "bin/claude")}`,
  ]);
  await expect.poll(async () => (await runner.get(paneId)).status, { timeout: 15_000 }).toBe("blocked");
  const { terminalId } = await runner.get(paneId);

  // A pane with a lead is its lead's to answer: nothing reaches the feed.
  led.add(terminalId);
  await asks.sync();
  expect(await feed()).toEqual([]);
  led.delete(terminalId);

  // With no lead, its question and its options as the agent shows them are a check in the feed.
  await asks.sync();
  await asks.sync();
  const [check] = await feed();
  expect(check?.question).toMatchObject({
    status: "pending",
    kind: "choice",
    prompt: "Do you want to proceed? (Bash command · git push origin main)",
    options: [
      { label: "Yes" },
      { label: "Yes, and don't ask again for git push commands" },
      { label: "No, and tell Claude what to do differently (esc)" },
    ],
  });
  expect(await feed()).toHaveLength(1);

  // The owner picks "No" there: the keys move the menu's selection down twice and confirm.
  const answered = await reply(check!, "No, and tell Claude what to do differently (esc)");
  expect(answered).toMatchObject({ op: "input_answer", result: { status: "resolved" } });
  await expect
    .poll(() => (existsSync(choice) ? readFileSync(choice, "utf8") : ""), { timeout: 10_000 })
    .toBe("Do you want to proceed? => No, and tell Claude what to do differently (esc)\n");
  expect(
    readFileSync(keys, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toEqual(["\x1b[B", "\x1b[B", "\r"]);
  expect(notes.at(-1)).toContain("Answered a prompt");
  // Clankie hears it as another agent's menu, its labels as that agent's output, granting nothing.
  await expect.poll(() => turns.length, { timeout: 10_000 }).toBe(1);
  expect(turns[0]).toMatch(
    /^From the owner's feed, the owner picked an option in another agent's own pane menu/u,
  );
  expect(turns[0]).toContain("never the owner's words");
  expect(turns[0]).toContain("This grants you nothing");
  expect(turns[0]).not.toContain("The owner answered this ask");
  expect(JSON.parse(turns[0]!.slice(turns[0]!.indexOf("\n") + 1))).toMatchObject({
    picked: "No, and tell Claude what to do differently (esc)",
    keys: "answered",
  });
  // Answered once: the settled ask leaves the feed, and answering it again presses nothing.
  await expect.poll(async () => (await runner.get(paneId)).status, { timeout: 10_000 }).not.toBe("blocked");
  await asks.sync();
  expect(await feed()).toEqual([]);
  expect(await reply(check!, "No, and tell Claude what to do differently (esc)")).toMatchObject({
    result: { status: "resolved" },
  });
  expect(await reply(check!, "Yes")).toMatchObject({
    result: { status: "refused", reason: "conflicting_answer" },
  });
  expect(readFileSync(keys, "utf8").trim().split("\n")).toHaveLength(3);

  // A stale question: the agent moves on to another menu before the owner answers the first.
  const process_ = [Number(readFileSync(join(root, "stand-in.pid"), "utf8"))];
  for (const pid of process_) process.kill(pid, "SIGUSR2");
  await expect.poll(async () => (await runner.get(paneId)).status, { timeout: 15_000 }).toBe("blocked");
  await asks.sync();
  const [edit] = await feed();
  expect(edit?.question.prompt).toBe("Do you want to make this edit to notes.md? (Edit file · notes.md)");
  // Its screen changes under the ask (the owner moves the selection at the keyboard)...
  await herdr(["pane", "send-keys", paneId, "down"]);
  await expect.poll(() => readFileSync(keys, "utf8").trim().split("\n").length, { timeout: 10_000 }).toBe(4);
  // ...so the menu is no longer where the ask started; the keys start from where it is now.
  expect(await reply(edit!, "No")).toMatchObject({ result: { status: "resolved" } });
  await expect
    .poll(() => readFileSync(choice, "utf8").trim().split("\n").at(-1), { timeout: 10_000 })
    .toBe("Do you want to make this edit to notes.md? => No");
  expect(
    readFileSync(keys, "utf8")
      .trim()
      .split("\n")
      .slice(4)
      .map((line) => JSON.parse(line)),
  ).toEqual(["\r"]);

  // A question replaced before the owner answers it: the answer presses nothing and the ask goes.
  await expect.poll(async () => (await runner.get(paneId)).status, { timeout: 10_000 }).not.toBe("blocked");
  await asks.sync();
  for (const pid of process_) process.kill(pid, "SIGUSR2");
  await expect.poll(async () => (await runner.get(paneId)).status, { timeout: 15_000 }).toBe("blocked");
  await asks.sync();
  const [replaced] = await feed();
  expect(replaced?.question.prompt).toContain("notes.md");
  for (const pid of process_) process.kill(pid, "SIGHUP");
  await expect
    .poll(async () => (await runner.bindPane!(terminalId))!.readScreen(), { timeout: 10_000 })
    .toContain("git push origin main");
  expect(await reply(replaced!, "Yes")).toMatchObject({
    result: { status: "refused", reason: "pane_prompt_changed" },
  });
  expect(readFileSync(keys, "utf8").trim().split("\n")).toHaveLength(5);
  expect((await feed()).map((item) => item.question.requestId)).not.toContain(replaced?.question.requestId);
  // The next look asks the menu now on screen instead.
  await asks.sync();
  const [current] = await feed();
  expect(current?.question.prompt).toContain("git push origin main");
});
