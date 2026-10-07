import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import {
  OperatorConversationServiceRequestSchema,
  OperatorConversationServiceResultSchema,
} from "@clankie/protocol";
import { ConversationStore } from "../../clankie/src/captain/conversations.ts";
import {
  QuestionDraftSchema,
  type QuestionAuthority,
} from "../../clankie/src/captain/conversation-questions.ts";
import { runConversationsCommand } from "../src/command/conversations.ts";
import { ownerUpdateConsoleCommand } from "../src/owner-update-commands.ts";
import { questionConsoleCommand } from "../src/question-commands.ts";
import {
  createCaptainOperatorConversationClient,
  createCaptainRouteClient,
} from "../src/session/operator-conversations.ts";

it("CLI and TUI read the durable owner mailbox over HTTP without answering pending asks", async () => {
  const root = await mkdtemp(join(tmpdir(), "owner-updates-cli-"));
  const turns: string[] = [];
  const store = new ConversationStore(root, async (_id, text) => {
    turns.push(text);
  });
  const token = `clankie_op_${"a".repeat(43)}`;
  const owner: QuestionAuthority = {
    principal: { kind: "operator", id: "owner" },
    current: () => true,
    authorize: async () => true,
  };
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests++;
    if (request.url !== "/operator/v1/dispatch" || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(403).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = OperatorConversationServiceRequestSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString()),
      );
      if (
        input.op !== "owner_update_list" &&
        input.op !== "owner_update_read" &&
        input.op !== "owner_update_dismiss" &&
        input.op !== "input_list"
      )
        throw new Error("Unsupported fixture operation");
      const result = OperatorConversationServiceResultSchema.parse(await store.serve(input, owner));
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server port");
  const host = `http://127.0.0.1:${address.port}`;
  const output: string[] = [];
  const options = {
    host,
    env: { CLANKIE_OPERATOR_TOKEN: token },
    stdout: {
      write: (value: unknown) => {
        output.push(String(value));
        return true;
      },
    },
  };
  const run = async (args: string[]) => {
    output.length = 0;
    const status = await runConversationsCommand(args, options);
    return { status, result: JSON.parse(output.join("")) };
  };
  try {
    const issue = { tracker: "linear", key: "VUH-1809", url: "https://linear.app/vuhlp/issue/VUH-1809" };
    const ask = await store.requestSurfaceQuestion(
      "global-default",
      QuestionDraftSchema.parse({
        purpose: "decision",
        kind: "choice",
        prompt: "Which route?",
        options: [{ label: "Core" }, { label: "App" }],
        recommendation: "Core",
        allowFreeform: false,
        waitingOn: "Shipping",
        issue,
      }),
      { current: () => true },
    );
    const update = await store.mailOwnerUpdate(
      "global-default",
      {
        title: "Mailbox landed",
        body: "Core changes are on main.",
        issue,
        seatId: "worker-mailbox",
        links: [{ label: "Commit", url: "https://github.com/Volpestyle/clankie/commit/ecb1a41d" }],
        media: [{ url: "https://example.com/mail.png", mimeType: "image/png", alt: "Mailbox preview" }],
      },
      "mail-cli",
      { current: () => true },
    );
    const otherConversation = store.roomConversation("discord_presence", "123:456");
    const other = await store.mailOwnerUpdate(
      otherConversation,
      { title: "Another update", body: "Another informational update." },
      "mail-other",
      { current: () => true },
    );
    expect(await run(["updates", "global-default", "--state", "unread"])).toMatchObject({
      status: 0,
      result: { updates: [{ id: update.id, issue, state: "unread" }] },
    });
    const ownerFetcher = createCaptainRouteClient({ host, captainToken: token });
    const client = createCaptainOperatorConversationClient(ownerFetcher, ownerFetcher);
    const updates = ownerUpdateConsoleCommand(client);
    const rendered = await updates("list");
    expect(rendered).toContain("Core changes are on main.");
    expect(rendered).toContain("worker-mailbox");
    expect(rendered).toContain("linear VUH-1809");
    expect(rendered).toContain("Commit: https://github.com/Volpestyle/clankie/commit/ecb1a41d");
    expect(rendered).toContain("Mailbox preview: https://example.com/mail.png");
    expect(await questionConsoleCommand(client, () => "global-default")("list")).toContain(issue.url);
    expect(await run(["read-update", update.id])).toMatchObject({
      status: 0,
      result: { update: { id: update.id, state: "read" } },
    });
    expect(await updates(`dismiss ${update.id}`)).toContain("Mailbox landed (dismissed)");
    expect(await run(["updates"])).toMatchObject({ status: 0, result: { updates: [{ id: other.id }] } });
    expect(await run(["updates", "--state", "dismissed"])).toMatchObject({
      status: 0,
      result: { updates: [{ id: update.id, state: "dismissed" }] },
    });
    expect(await updates(`read ${update.id}`)).toContain("dismissed");
    expect(await client.inputList!({ status: "pending" })).toMatchObject({
      questions: [{ question: { requestId: ask.question!.requestId, status: "pending" } }],
    });
    expect(await run(["dismiss-update", randomUUID()])).toMatchObject({
      status: 1,
      result: { status: "refused", reason: "unknown_update" },
    });
    const before = requests;
    await expect(updates("dismiss replacement")).rejects.toThrow();
    await expect(run(["updates", "--state", "unknown"])).rejects.toThrow();
    await expect(
      runConversationsCommand(["updates"], {
        ...options,
        env: { CLANKIE_CAPTAIN_TOKEN: token },
        operatorCredentialStore: new FileCredentialStore(join(root, "empty-credentials.json")),
      }),
    ).rejects.toThrow("Owner operator credential required");
    const captainOnlyClient = createCaptainOperatorConversationClient(ownerFetcher);
    await expect(ownerUpdateConsoleCommand(captainOnlyClient)("list")).rejects.toThrow(
      "Owner authentication required",
    );
    expect(requests).toBe(before);
    expect(turns).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
