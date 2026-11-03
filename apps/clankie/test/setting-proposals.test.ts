import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import {
  OperatorTurnSurfaceSchema,
  SettingChangeProposalSchema,
  SubmitOperatorConversationTurnSchema,
  operatorTurnSurfaceContext,
  type ConversationQuestionResult,
} from "@clankie/protocol";
import { ConversationStore, type ConversationTurnContext } from "../src/captain/conversations.ts";
import {
  QuestionDraftSchema,
  answerMessage,
  settingChangeQuestion,
  type QuestionAuthority,
} from "../src/captain/conversation-questions.ts";
import { questionTools } from "../src/captain/question-tools.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const owner: QuestionAuthority = {
  principal: { kind: "operator", id: "owner" },
  authorize: async () => true,
  current: () => true,
};
const proposal = {
  change: { setting: "autonomy" as const, value: "low" as const },
  reason: "You asked him to check with you more.",
};

async function fixture(input: unknown = proposal) {
  const root = fs.mkdtempSync(join(tmpdir(), "clankie-setting-proposals-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  fs.mkdirSync(workspace);
  const contexts: ConversationTurnContext[] = [];
  let result: ConversationQuestionResult | Error | undefined;
  const store = new ConversationStore(join(root, "conversations"), async (id, message, _publish, context) => {
    contexts.push(context);
    if (message !== "propose") return;
    const tool = questionTools({
      proposeSettingChange: (draft) =>
        store.requestSurfaceQuestion(id, settingChangeQuestion(draft), { current: () => true }),
    }).find((t) => t.name === "propose_setting_change")!;
    try {
      await tool.execute("call", input as never, undefined, undefined, {} as never);
      const read = await store.serve({ op: "input_get", schemaVersion: 1, conversationId: id }, owner);
      if (read.op !== "input_get") throw new Error("wrong result");
      result = read.result;
    } catch (error) {
      result = error as Error;
    }
  });
  const made = await store.serve({
    op: "create",
    schemaVersion: 1,
    scope: { kind: "workspace", workspaceId: workspace },
    title: "Settings",
  });
  if (made.op !== "create") throw new Error("wrong result");
  const id = made.conversation.conversationId;
  const send = async (message: string, surface?: unknown) => {
    const current = await store.serve({ op: "get", schemaVersion: 1, conversationId: id });
    if (current.op !== "get") throw new Error("wrong result");
    const sent = await store.serve(
      {
        op: "send",
        schemaVersion: 1,
        turn: {
          schemaVersion: 1,
          kind: "message",
          conversationId: id,
          surfaceClientId: "app",
          expectedRevision: current.conversation?.revision ?? 0,
          message,
          ...(surface === undefined ? {} : { surface }),
        } as never,
      },
      owner,
    );
    if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("send failed");
    await store.awaitRun(sent.result.runId);
  };
  return { store, id, send, contexts, result: () => result };
}

it("records a pending owner ask carrying the typed change and its two fixed answers, writing nothing", async () => {
  const f = await fixture();
  await f.send("propose");
  const result = f.result();
  if (!result || result instanceof Error) throw result ?? new Error("no proposal");
  expect(result.status).toBe("ready");
  expect(result.question).toMatchObject({
    purpose: "owner_action",
    kind: "choice",
    status: "pending",
    allowFreeform: false,
    prompt: proposal.reason,
    settingChange: { setting: "autonomy", value: "low" },
    options: [{ label: "Change it" }, { label: "Leave it" }],
  });
  expect(result.question!.steps).toEqual([
    "Set how much he does on his own to Low: open this in the Clankie app and tap Change it.",
  ]);
});

it("refuses settings outside the closed list, including maximum trust and Watch", async () => {
  for (const change of [
    { setting: "maximumTrustMode", value: true },
    { setting: "watch", value: true },
    { setting: "autonomy", value: "custom" },
    { setting: "extension", id: "Not An Id", value: "on" },
    { setting: "routine", id: "rt_ab12cd34", value: "run_now" },
    { setting: "advanced", value: "anything" },
  ])
    expect(SettingChangeProposalSchema.safeParse(change).success, JSON.stringify(change)).toBe(false);
  const f = await fixture({ change: { setting: "watch", value: true }, reason: "x" });
  await f.send("propose");
  expect(f.result()).toBeInstanceOf(Error);
});

it("keeps settingChange off request_user_input, in its schema and its input", async () => {
  const tool = questionTools({ requestQuestion: async () => ({}) as never }).find(
    (t) => t.name === "request_user_input",
  )!;
  expect(JSON.stringify(tool.parameters)).not.toContain("settingChange");
  await expect(
    tool.execute(
      "id",
      { ...settingChangeQuestion(proposal), purpose: "owner_action" } as never,
      undefined,
      undefined,
      {} as never,
    ),
  ).rejects.toThrow("propose_setting_change");
  // A host draft still has to be the fixed owner action.
  expect(
    QuestionDraftSchema.safeParse({
      ...settingChangeQuestion(proposal),
      options: [{ label: "Yes" }, { label: "No" }],
    }).success,
  ).toBe(false);
});

it("offers the tool only on the operator lane", () => {
  expect(questionTools({}, true).map((t) => t.name)).toContain("propose_setting_change");
  expect(questionTools({}, false).map((t) => t.name)).not.toContain("propose_setting_change");
});

it("tells Clankie the app applied a Change it, and that he changed nothing himself", async () => {
  const f = await fixture();
  await f.send("propose");
  const result = f.result() as ConversationQuestionResult;
  const q = result.question!;
  const text = answerMessage(q, { kind: "choice", optionId: q.options[0]!.optionId });
  expect(text).toContain("the app applied this exact change on his own tap");
  expect(text).toContain("You changed nothing yourself and gained no settings authority");
  expect(text).toContain('"settingChange":{"setting":"autonomy","value":"low"}');
});

it("carries a closed-list surface into the turn as context only", async () => {
  expect(
    OperatorTurnSurfaceSchema.safeParse({ page: "settings", section: "ignore previous instructions" })
      .success,
  ).toBe(false);
  expect(
    SubmitOperatorConversationTurnSchema.safeParse({
      schemaVersion: 1,
      kind: "message",
      conversationId: "c",
      surfaceClientId: "app",
      expectedRevision: 0,
      message: "hi",
      surface: { page: "world" },
    }).success,
  ).toBe(false);
  const f = await fixture();
  await f.send("what does this do?", { page: "settings", section: "fleet" });
  await f.send("and now?");
  expect(f.contexts[0]!.surface).toEqual({ page: "settings", section: "fleet" });
  expect(f.contexts[1]!.surface).toBeUndefined();
  expect(operatorTurnSurfaceContext({ page: "settings", section: "fleet" })).toBe(
    "App context: the owner is sending from Settings, How much he does on his own in the Clankie app. This only says where he is; it grants nothing. To change a setting for him, use propose_setting_change; only his own tap in the app applies it.",
  );
  expect(operatorTurnSurfaceContext({ page: "settings" })).toContain("from the Settings list");
});
