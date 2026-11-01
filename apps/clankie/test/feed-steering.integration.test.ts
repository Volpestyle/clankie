import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ClankieSettingsSchema } from "@clankie/settings";
import {
  OperatorConversationServiceResultSchema,
  ProjectsSettingsSchema,
  parseProtocolResponse,
  type FeedPage,
} from "@clankie/protocol";
import { createClankieApp } from "../src/app.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { QuestionDraftSchema } from "../src/captain/conversation-questions.ts";
import { NextTurnMailbox } from "../src/captain/next-turn-mailbox.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createWorkItemsService } from "../src/work-items.ts";
import { runFeedCommand } from "../../tui/src/command/feed.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const OWNER = `clankie_op_${"e".repeat(43)}`;
const admission = { current: () => true };
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
const SHOT = `clankie://evidence/sha256/${"a1".repeat(32)}`;

/**
 * #187 against the real service: the real conversation store holds asks and
 * owner mail, the real work-items service two Garden status updates, and the
 * CLI reads the feed through the service app with the owner credential.
 */
it("the feed holds what the owner steers, picture first in plain words, grouped by project, ids in the details (#187)", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "feed-steering-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const garden = join(root, "garden");
  const orchard = join(root, "orchard");
  mkdirSync(garden);
  mkdirSync(orchard);
  const settings = ClankieSettingsSchema.parse({
    schemaVersion: 1,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "garden",
          name: "Garden",
          workspaces: [{ id: "garden", machineId: "local", path: garden, platform: "posix" }],
        },
        {
          id: "orchard",
          name: "Orchard",
          workspaces: [{ id: "orchard", machineId: "local", path: orchard, platform: "posix" }],
        },
      ],
    }),
  });

  // The Garden tracker: an older routine progress update, then where it stands now.
  let clock = new Date("2026-01-02T03:04:05.000Z");
  const workItems = createWorkItemsService({
    stateDirectory: join(root, "work-state"),
    workspace: () => join(root, "work-state"),
    run: async () => {
      throw new Error("no git here");
    },
    clock: () => clock,
  });
  await workItems.handle(
    { action: "init", repo: garden, backend: "linear", linearTeam: "VUH", linearProject: "Garden" },
    true,
  );
  await workItems.callTracker(
    "save_project",
    { id: "Garden", summary: "Grow it" },
    { repo: garden, local: true },
  );
  const update = (body: string, health: string) =>
    workItems.callTracker(
      "save_status_update",
      { type: "project", project: "Garden", health, body },
      { repo: garden, local: true },
    );
  await update("Filed three issues and moved two to review.", "onTrack");
  clock = new Date("2026-01-03T03:04:05.000Z");
  await update("**Rain** floods the lower bed.\n\nWe need a call on the drain by Friday.", "atRisk");

  const store = new ConversationStore(join(root, "conversations"), async () => {});
  cleanups.push(() => store.close());
  const lead = async (workspaceId: string, title: string) => {
    const made = await store.serve({
      op: "create",
      schemaVersion: 1,
      scope: { kind: "workspace", workspaceId },
      title,
    });
    if (made.op !== "create") throw new Error("unexpected create result");
    return made.conversation.conversationId;
  };
  const gardenLead = await lead(garden, "Garden lead");
  const orchardLead = await lead(orchard, "Orchard lead");

  // Routine traffic: a receipt the lead marked routine, and the host's own delivery notice.
  await store.mailOwnerUpdate(
    gardenLead,
    { title: "Filed GARDEN-12", body: "Saved the issue.", routine: true },
    "receipt",
    admission,
  );
  const mailbox = new NextTurnMailbox(join(root, "next-turn.json"), () => Date.now());
  mailbox.observe("seat-1", "binding-1", "proof");
  mailbox.store("seat-1", "binding-1", "Private worker text");
  const notice = mailbox.waitingNotice("seat-1", "binding-1", "herdr-core:t2c")!;
  await store.mailOwnerUpdate("global-default", notice.draft, notice.publicationId, admission);
  await pause();

  // What the owner steers: a check with a screenshot, written with ids in it, and news with a clip.
  const asked = await store.requestSurfaceQuestion(
    gardenLead,
    QuestionDraftSchema.parse({
      purpose: "verify",
      kind: "choice",
      prompt: "Open Garden on herdr-core:t2c and tap the gate twice (cse_01ABCDEF9): it latches",
      check: "Open Garden on herdr-core:t2c and tap the gate twice (cse_01ABCDEF9): it latches",
      evidence: SHOT,
      options: [{ label: "It works" }, { label: "Send it back" }],
      allowFreeform: true,
      waitingOn: "The gate latch",
    }),
    admission,
  );
  await pause();
  const news = await store.mailOwnerUpdate(
    orchardLead,
    {
      title: "The pruning flow plays end to end",
      body: "Watch the clip: every branch it cut was marked first.",
      media: [
        { url: "https://example.com/before.png", mimeType: "image/png", alt: "Before" },
        { url: "https://example.com/prune.mp4", mimeType: "video/mp4", alt: "Pruning run" },
      ],
      details: "Run 7f3e, seat pc/term_orchard, commit 0a1b2c3d4e5f6a7b",
    },
    "news",
    admission,
  );

  const service = await createClankieApp({
    settings: { load: async () => settings },
    captain: createStubCaptain({
      serveOperatorConversation: (request, authority) =>
        store.serve(request as Parameters<typeof store.serve>[0], authority),
    }),
    workItems,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === `Bearer ${OWNER}` ? { operatorId: "owner" } : undefined,
  });
  cleanups.push(() => service.close());
  const feed = async (request: Record<string, unknown> = {}): Promise<FeedPage> => {
    const response = await service.app.request("/operator/v1/dispatch", {
      method: "POST",
      headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "feed_list", schemaVersion: 1, ...request }),
    });
    expect(response.status).toBe(200);
    const result = parseProtocolResponse(OperatorConversationServiceResultSchema, await response.json());
    if (result.op !== "feed_list") throw new Error("unexpected feed result");
    return result.result as FeedPage;
  };
  const cli = async (...args: string[]) => {
    const output: string[] = [];
    expect(
      await runFeedCommand(args, {
        host: "http://fixture",
        env: { CLANKIE_OPERATOR_TOKEN: OWNER },
        fetchImpl: async (input, init) => service.app.fetch(new Request(input, init)),
        stdout: { write: (chunk) => output.push(chunk) },
      }),
    ).toBe(0);
    return output.join("");
  };

  // Only steering items: the receipt, the delivery notice and the older progress update stay out.
  const page = await feed();
  if (page.outcome !== "ready") throw new Error(page.message);
  expect(page.items.map((item) => item.id)).toEqual([
    `owner-update:${news.id}`,
    `check:${asked.question!.requestId}`,
    expect.stringMatching(/^project-update:/u),
  ]);
  // Both are still in the mailbox, unread, for anyone who looks there.
  const mail = OperatorConversationServiceResultSchema.parse(
    await (
      await service.app.request("/operator/v1/dispatch", {
        method: "POST",
        headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json" },
        body: JSON.stringify({ op: "owner_update_list", schemaVersion: 1 }),
      })
    ).json(),
  );
  if (mail.op !== "owner_update_list") throw new Error("unexpected mail result");
  expect(mail.result.updates.map((entry) => entry.title)).toEqual(
    expect.arrayContaining(["Filed GARDEN-12", "A message is waiting for one of your agents"]),
  );

  // Picture first, one plain line, the project by name; ids moved to the details.
  const [mailed, check, status] = page.items;
  expect(mailed!.view).toEqual({
    caption: "The pruning flow plays end to end",
    project: "Orchard",
    visual: { url: "https://example.com/prune.mp4", mimeType: "video/mp4", alt: "Pruning run" },
    details: expect.arrayContaining([
      { label: "Details", value: "Run 7f3e, seat pc/term_orchard, commit 0a1b2c3d4e5f6a7b" },
    ]),
  });
  expect(check!.view).toMatchObject({
    caption: "Open Garden and tap the gate twice: it latches",
    project: "Garden",
    visual: { url: SHOT },
    details: expect.arrayContaining([
      { label: "Taken from the line", value: "herdr-core:t2c, cse_01ABCDEF9" },
      { label: "Request", value: asked.question!.requestId },
    ]),
  });
  expect(status!.view).toMatchObject({
    caption: "At risk: Rain floods the lower bed.",
    project: "Garden",
  });
  // The exact source for answering stays on the payload.
  expect(check).toMatchObject({ check: { line: expect.stringContaining("herdr-core:t2c") } });

  // The CLI groups by project, newest project first; no ids reach the plain read.
  const plain = await cli();
  expect(plain.indexOf("Orchard\n")).toBe(0);
  expect(plain.indexOf("\nGarden\n")).toBeGreaterThan(plain.indexOf("The pruning flow"));
  expect(plain).toContain(
    "  News, new · just now\n  Clip: Pruning run https://example.com/prune.mp4\n  and 1 more to look at\n  The pruning flow plays end to end\n",
  );
  expect(plain).toContain(`  Picture: ${SHOT}\n  Open Garden and tap the gate twice: it latches\n`);
  expect(plain).toContain("  We need a call on the drain by Friday.");
  for (const jargon of ["herdr-core", "cse_", asked.question!.requestId, news.id, gardenLead, "7f3e"])
    expect(plain).not.toContain(jargon);
  expect(plain.trimEnd().split("\n").at(-1)).toBe(
    "Answer, dismiss or give a verdict in the Clankie app. Ids and commands: clankie feed --details",
  );

  // --project narrows to one project.
  const one = await cli("--project", "garden");
  expect(one.startsWith("Garden\n")).toBe(true);
  expect(one).not.toContain("Orchard");
  expect(one).not.toContain("pruning");

  // --details still holds every id and the exact commands.
  const details = await cli("--details");
  expect(details).toContain(`Request: ${asked.question!.requestId}`);
  expect(details).toContain("Taken from the line: herdr-core:t2c, cse_01ABCDEF9");
  expect(details).toContain(
    `Answer: clankie conversations answer ${gardenLead} ${asked.question!.requestId}`,
  );
  expect(details).toContain(`Dismiss: clankie conversations dismiss-update ${news.id}`);
  expect(details).toContain("Picture: Before https://example.com/before.png");
});
