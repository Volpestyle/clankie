import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";

const fake = vi.hoisted(() => ({
  session: undefined as unknown,
  start: vi.fn(async () => {}),
  materialize: vi.fn(async () => ({ note: "attached", paths: [] })),
  images: vi.fn(async () => ({ note: "attached", images: [] })),
}));
vi.mock("../src/owner-attachments.ts", () => ({
  materializeOwnerAttachments: fake.materialize,
  modelImagesForOwnerAttachments: fake.images,
}));
vi.mock("../src/captain/model.ts", () => ({
  createCaptainModelRuntime: async () => ({
    runtime: {},
    resolveRoute: async () => ({
      selection: { model: { id: "fake", provider: "fake", contextWindow: 1000 }, thinkingLevel: "off" },
    }),
  }),
}));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
  createAgentSession: async () => {
    await fake.start();
    return { session: fake.session };
  },
  DefaultResourceLoader: class {
    async reload() {}
    getSkills() {
      return { skills: [] };
    }
  },
}));
vi.mock("../src/captain/lane-tools.ts", () => ({ laneAuthoredTools: () => [], buildLaneToolBank: () => [] }));

it.each(["seat attachment", "model images", "session startup"])(
  "closing during %s preparation cannot dispatch after shutdown",
  async (boundary) => {
    const root = mkdtempSync(join(tmpdir(), "seat-admission-close-"));
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.start.mockClear();
    fake.materialize.mockClear();
    fake.images.mockClear();
    if (boundary === "seat attachment")
      fake.materialize.mockImplementationOnce(async () => {
        entered();
        await gate;
        return { note: "attached", paths: [] };
      });
    if (boundary === "model images")
      fake.images.mockImplementationOnce(async () => {
        entered();
        await gate;
        return { note: "attached", images: [] };
      });
    if (boundary === "session startup")
      fake.start.mockImplementationOnce(async () => {
        entered();
        await gate;
      });
    const prompt = vi.fn(async () => {});
    fake.session = {
      isStreaming: false,
      state: { messages: [] },
      model: { id: "fake", provider: "fake", contextWindow: 1000 },
      thinkingLevel: "off",
      bindExtensions: async () => {},
      subscribe: () => () => {},
      getContextUsage: () => undefined,
      abort: async () => {},
      dispose: () => {},
      prompt,
      resourceLoader: { getSkills: () => ({ skills: [] }) },
    };
    const unused = async (): Promise<never> => {
      throw new Error("unused attachment operation");
    };
    const captain = createCaptain({ herdrAvailable: () => false } as CaptainDeps, {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      settings: new SettingsStore(join(root, "settings.json")),
      personaImages: async () => ({ images: [], hash: "fixture", files: [] }),
      deliveredFiles: {
        publish: unused,
        removeConversation: async () => {},
        beginUpload: unused,
        appendUpload: unused,
        commitUpload: unused,
        attachment: async () => ({
          path: join(root, "fixture.png"),
          file: {
            artifactId: "a".repeat(48),
            filename: "fixture.png",
            mediaType: "image/png",
            byteCount: 1,
            sha256: "a".repeat(64),
          },
        }),
      },
    });
    try {
      const poll = boundary === "seat attachment" ? captain.pollSeatEvents(1000) : undefined;
      const sent = await captain.serveOperatorConversation({
        schemaVersion: 1,
        op: "send",
        turn: {
          schemaVersion: 1,
          kind: "message",
          conversationId: "global-default",
          surfaceClientId: "app",
          expectedRevision: 0,
          message: "Look at this",
          attachments: [{ artifactId: "a".repeat(48) }],
        },
      });
      expect(sent).toMatchObject({ op: "send", result: { status: "accepted" } });
      await waiting;
      const closed = captain.close();
      release();
      await closed;
      if (poll) expect(await poll).toEqual([]);
      expect(prompt).not.toHaveBeenCalled();
      if (boundary === "seat attachment") expect(fake.start).not.toHaveBeenCalled();
      const turns = new ConversationJournal(join(root, "conversations"))
        .read("global-default")
        .filter((event) => event.type === "turn");
      expect(turns).toMatchObject([
        { phase: "accepted" },
        { phase: "failed", reasonCode: "service_restarted" },
      ]);
    } finally {
      release();
      await captain.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("a closed outbox refuses new polls and deliveries", async () => {
  const outbox = new SeatOutbox();
  outbox.close();
  expect(await outbox.poll(1000)).toEqual([]);
  expect(outbox.bound()).toBe(false);
  await expect(
    outbox.deliver({
      kind: "escalation",
      conversationId: "c",
      source: "app",
      content: "late",
      wantsReply: true,
    }),
  ).rejects.toThrow("service link was interrupted");
});
