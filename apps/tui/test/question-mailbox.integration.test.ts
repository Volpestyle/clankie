import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  OperatorConversationServiceRequestSchema,
  OperatorConversationServiceResultSchema,
  type ConversationQuestionResult,
} from "@clankie/protocol";
import { ConversationStore } from "../../clankie/src/captain/conversations.ts";
import {
  QuestionDraftSchema,
  type QuestionAuthority,
} from "../../clankie/src/captain/conversation-questions.ts";
import {
  createCaptainOperatorConversationClient,
  createCaptainRouteClient,
} from "../src/session/operator-conversations.ts";
import { questionConsoleCommand } from "../src/question-commands.ts";
import type { SetupFlow } from "../src/shell/setup-flow.ts";

it("the mailbox sends verification, send-back reasons and free text to their source over the real API, fencing changed asks", async () => {
  const root = await mkdtemp(join(tmpdir(), "question-mailbox-"));
  const messages: { id: string; text: string }[] = [];
  const store = new ConversationStore(join(root, "conversations"), async (id, text) => {
    messages.push({ id, text });
  });
  const owner: QuestionAuthority = {
    principal: { kind: "operator", id: "owner" },
    current: () => true,
    authorize: async () => true,
  };
  const requests: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      if (req.url !== "/operator/v1/dispatch" || req.headers.authorization !== "Bearer fixture-owner") {
        res.writeHead(403).end();
        return;
      }
      const bytes: Buffer[] = [];
      for await (const chunk of req) bytes.push(Buffer.from(chunk));
      const input = OperatorConversationServiceRequestSchema.parse(
        JSON.parse(Buffer.concat(bytes).toString()),
      );
      requests.push(input);
      if (
        input.op !== "list" &&
        input.op !== "input_list" &&
        input.op !== "input_get" &&
        input.op !== "input_answer" &&
        input.op !== "input_cancel"
      )
        throw new Error("Unsupported scratch operation");
      const result = OperatorConversationServiceResultSchema.parse(await store.serve(input, owner));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const fetcher = createCaptainRouteClient({
    host: `http://127.0.0.1:${address.port}`,
    captainToken: "fixture-owner",
  });
  const client = createCaptainOperatorConversationClient(fetcher, fetcher);
  const make = async (title: string) => {
    const workspace = join(root, title);
    await mkdir(workspace);
    const result = await store.serve({
      op: "create",
      schemaVersion: 1,
      title,
      scope: { kind: "workspace", workspaceId: workspace },
    });
    if (result.op !== "create") throw new Error("Not create");
    return result.conversation.conversationId;
  };
  const verify = (id: string, prompt = "Check the new route") =>
    store.requestSurfaceQuestion(
      id,
      QuestionDraftSchema.parse({
        purpose: "verify",
        kind: "choice",
        prompt,
        options: [{ label: "It works" }, { label: "Send it back" }],
        allowFreeform: true,
        waitingOn: "Owner verification",
        recommendation: "Try both routes",
        steps: ["Open the route"],
        issue: { tracker: "linear", key: "VUH-2150", url: "https://linear.app/vuhlp/issue/VUH-2150" },
      }),
      { current: () => true },
    );
  let picks: string[] = [],
    texts: string[] = [],
    change: (() => Promise<void>) | undefined;
  const menus: string[] = [];
  const flow: SetupFlow = {
    begin() {},
    end() {},
    setStatus() {},
    renderLine() {},
    readSecret: async () => undefined,
    waitForInterrupt: () => ({ promise: Promise.resolve(), dispose() {} }),
    async readSelect(options) {
      menus.push(JSON.stringify(options));
      if (change && options.message.startsWith("Check")) {
        const fn = change;
        change = undefined;
        await fn();
      }
      return picks.shift();
    },
    async readText(options) {
      const value = texts.shift();
      expect(value && options.validate?.(value)).toBeUndefined();
      menus.push(options.message);
      return value;
    },
  };
  try {
    const a = await make("KH2 lead"),
      b = await make("App lead");
    const qa = await verify(a);
    const qb = await store.requestSurfaceQuestion(
      b,
      QuestionDraftSchema.parse({
        purpose: "owner_action",
        kind: "text",
        prompt: "Describe the layout",
        allowFreeform: true,
        waitingOn: "Layout feedback",
        steps: ["Look at the layout"],
      }),
      { current: () => true },
    );
    const command = questionConsoleCommand(client, () => "global-default");
    picks = [qa.question!.requestId, qa.question!.options[0]!.optionId];
    expect(await command("", flow)).toContain("Answer sent to KH2 lead");
    expect(menus.join("\n")).toContain("App lead");
    expect(menus.join("\n")).toContain("Owner verification");
    expect(menus.join("\n")).toContain("Try both routes");
    picks = [qb.question!.requestId];
    texts = ["Keep the full layout"];
    expect(await command("", flow)).toContain("Answer sent to App lead");
    expect((await client.inputGet!(b, qb.question!.requestId)).question?.answer).toEqual({
      kind: "text",
      text: "Keep the full layout",
    });
    const back = await verify(a);
    picks = [back.question!.requestId, back.question!.options[1]!.optionId];
    texts = ["The second route clips"];
    await command("", flow);
    expect((await client.inputGet!(a, back.question!.requestId)).question?.answer).toEqual({
      kind: "text",
      text: "The second route clips",
    });
    expect(menus.join("\n")).toContain("Reason to send back");
    const stale = await verify(a);
    let replacement: ConversationQuestionResult | undefined;
    picks = [stale.question!.requestId, stale.question!.options[0]!.optionId];
    change = async () => {
      replacement = await verify(a, "Check the replacement route");
      const live = await client.inputGet!(a, stale.question!.requestId);
      const sent = await store.serve(
        {
          op: "send",
          schemaVersion: 1,
          turn: {
            schemaVersion: 1,
            kind: "message",
            conversationId: a,
            surfaceClientId: "fixture",
            expectedRevision: live.revision!,
            message: "A new owner message",
          },
        },
        owner,
      );
      if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("send failed");
      await store.awaitRun(sent.result.runId);
    };
    await expect(command("", flow)).rejects.toThrow("conversation changed");
    expect((await client.inputGet!(a, replacement!.question!.requestId)).question?.status).toBe("pending");
    const answerWrites = requests.filter((r) => (r as { op: string }).op === "input_answer");
    expect(answerWrites).toHaveLength(4);
    expect(answerWrites.at(-1)).toMatchObject({
      requestId: stale.question!.requestId,
      incarnationId: stale.question!.incarnationId,
    });
    expect(requests).toContainEqual(
      expect.objectContaining({ op: "input_get", conversationId: a, requestId: stale.question!.requestId }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(messages.some((m) => m.id === a && m.text.includes("It works"))).toBe(true);
    expect(messages.some((m) => m.id === b && m.text.includes("Keep the full layout"))).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
});
