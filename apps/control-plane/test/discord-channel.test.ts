import { resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import type { DiscordPresenceChannelTurnRequest, DiscordVoicePresenceNote } from "@clankie/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { createControlPlane } from "../src/app.ts";
import { EveCaptainChannelTurnPort } from "../src/eve-captain-turn.ts";

let doctrine: Awaited<ReturnType<typeof compileDoctrine>>;

beforeAll(async () => {
  doctrine = compileDoctrine([
    await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml")),
  ]);
});

describe("Discord channel control-plane runtime", () => {
  it("authenticates, deduplicates, and submits ambient Discord turns without Linear", async () => {
    let submissions = 0;
    const app = await createControlPlane({
      doctrine,
      authenticateCaptain: (request) =>
        Promise.resolve(
          request.headers.get("authorization") === "Bearer discord-captain"
            ? { captainId: "discord-bridge", steerSourceLane: "discord_text" }
            : undefined,
        ),
      captainChannelTurns: {
        async submit() {
          submissions += 1;
          return {
            state: "settled",
            captainSessionId: "captain-session",
            turnId: "turn-1",
            response: "Hello from Clankie.",
          };
        },
      },
    });
    const request = turnRequest();

    const unauthenticated = await post(app, request);
    const first = await post(app, request, "Bearer discord-captain");
    const duplicate = await post(app, request, "Bearer discord-captain");
    const conflict = await post(
      app,
      { ...request, trigger: { ...request.trigger, body: "different" } },
      "Bearer discord-captain",
    );

    expect(unauthenticated.status).toBe(401);
    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(conflict.status).toBe(409);
    expect(submissions).toBe(1);
  });

  it("opens the explicit discord_presence lane with turn-only untrusted context", async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const port = new EveCaptainChannelTurnPort({
      baseUrl: "http://127.0.0.1:4321",
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
        });
        if (init?.method === "POST") {
          return Response.json(
            { sessionId: "eve-discord", continuationToken: "discord-token" },
            { status: 202 },
          );
        }
        return ndjson([
          { type: "turn.started", data: { turnId: "discord-turn-1" } },
          {
            type: "message.completed",
            data: { turnId: "discord-turn-1", finishReason: "stop", message: "Hello." },
          },
          { type: "session.waiting", data: { turnId: "discord-turn-1" } },
        ]);
      },
    });

    await expect(port.submit({ request: turnRequest() })).resolves.toMatchObject({
      state: "settled",
      turnId: "discord-turn-1",
      response: "Hello.",
    });
    await expect(
      port.submit({ request: { ...turnRequest(), deliveryId: "message-2" } }),
    ).resolves.toMatchObject({
      state: "settled",
    });
    expect(requests[0]?.body).toMatchObject({
      message: expect.stringContaining("ephemeral clientContext"),
      clientContext: {
        channel: {
          kind: "discord-text",
          authority: "ambient",
          channelId: "dm-1",
          actorId: "james",
          metadata: {
            captainLane: "discord_presence",
            captainTargetId: "dm:dm-1",
          },
        },
        identity: {
          presenceSessionId: "discord:dm:dm-1",
          correlationId: "discord-message:message-1",
        },
        thread: {
          source: "discord",
          retention: "turn_only",
          trigger: { id: "message-1", actorId: "james", body: "hello" },
          messages: [
            {
              id: "context-1",
              authorId: "friend",
              body: "earlier",
              createdAt: "2026-07-12T20:00:00.000Z",
            },
          ],
        },
      },
    });
    expect(requests[0]?.body).not.toMatchObject({ message: expect.stringContaining("hello") });
    expect(requests[2]).toMatchObject({ url: "http://127.0.0.1:4321/eve/v1/session" });
    expect(requests[2]?.body).not.toHaveProperty("continuationToken");
  });

  it("a bare wake after a real request composes the prior request as the actionable subject", async () => {
    // The live miss, replayed: "hop in vc and play pokemon" (excluded as
    // unaddressed), then a bare "clankie". The wake's turn must present the
    // prior conversation chronologically and tell him a bare wake points back
    // at it — he answered "yo, what's up?" and made the asker repeat
    // themselves. The composed Eve request is the strongest deterministic
    // boundary there is here; live model compliance is a persona concern.
    const requests: Array<{ url: string; body?: unknown }> = [];
    const port = new EveCaptainChannelTurnPort({
      baseUrl: "http://127.0.0.1:4321",
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
        });
        if (init?.method === "POST") {
          return Response.json({ sessionId: "eve-wake" }, { status: 202 });
        }
        return ndjson([
          { type: "turn.started", data: { turnId: "wake-turn" } },
          {
            type: "message.completed",
            data: { turnId: "wake-turn", finishReason: "stop", message: "On it." },
          },
          { type: "session.waiting", data: { turnId: "wake-turn" } },
        ]);
      },
    });
    const conversation = [
      {
        id: "ctx-ask",
        authorId: "asker-1",
        body: "hop in vc and play pokemon",
        createdAt: "2026-08-02T12:35:00.000Z",
      },
      {
        id: "ctx-other",
        authorId: "bystander",
        body: "good luck with the elite four",
        createdAt: "2026-08-02T12:35:20.000Z",
      },
    ];
    const wake = (contextMessages: typeof conversation, deliveryId: string) => ({
      ...turnRequest(),
      deliveryId,
      trigger: {
        kind: "message" as const,
        id: deliveryId,
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: deliveryId,
        actorId: "asker-1",
        body: "clankie",
        attachments: [],
      },
      contextMessages,
    });

    await port.submit({ request: wake(conversation, "message-wake") });
    await port.submit({ request: wake([], "message-bare") });

    const body = (index: number) => {
      const request = requests[index];
      if (request === undefined) throw new Error(`request ${String(index)} was never captured`);
      return request.body as {
        message: string;
        clientContext: { thread: { trigger: unknown; messages: unknown } };
      };
    };
    // The durable message carries the fixed framing — chronology plus the
    // bare-wake rule — and never any untrusted body.
    expect(body(0).message).toContain("chronological order, oldest first");
    expect(body(0).message).toContain(
      "treat their most recent relevant message there (the latest whose author matches the trigger's actorId) as what they are asking you to act on",
    );
    expect(body(0).message).not.toContain("pokemon");
    // The prior request reaches him inside the turn-only thread context, in
    // order, attributed to the wake's own actor — the actionable subject.
    expect(body(0).clientContext.thread.trigger).toEqual({
      id: "message-wake",
      actorId: "asker-1",
      body: "clankie",
    });
    expect(body(0).clientContext.thread.messages).toEqual(conversation);
    // With no prior conversation there is nothing to point back at, so the
    // framing paragraph is absent rather than describing context that is not
    // there.
    expect(body(2).message).not.toContain("chronological order");
  });

  it("renders the bridge's voice presence note as one neutral thread-context line", async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const port = new EveCaptainChannelTurnPort({
      baseUrl: "http://127.0.0.1:4321",
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
        });
        if (init?.method === "POST") {
          return Response.json({ sessionId: "eve-note" }, { status: 202 });
        }
        return ndjson([
          { type: "turn.started", data: { turnId: "note-turn" } },
          {
            type: "message.completed",
            data: { turnId: "note-turn", finishReason: "stop", message: "I'm in." },
          },
          { type: "session.waiting", data: { turnId: "note-turn" } },
        ]);
      },
    });
    const noted = (voicePresenceNote: DiscordVoicePresenceNote | undefined, deliveryId: string) => ({
      ...turnRequest(),
      deliveryId,
      trigger: {
        kind: "mention" as const,
        id: deliveryId,
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: deliveryId,
        actorId: "james",
        body: "clankie hop in vc",
        attachments: [],
        ...(voicePresenceNote === undefined ? {} : { voicePresenceNote }),
      },
    });

    await port.submit({
      request: noted({ action: "joined", channelId: "voice-1" }, "message-joined"),
    });
    await port.submit({
      request: noted({ action: "join_refused", reason: "authority" }, "message-refused"),
    });
    await port.submit({ request: noted(undefined, "message-plain") });

    const thread = (index: number) => {
      const request = requests[index];
      if (request === undefined) throw new Error(`request ${String(index)} was never captured`);
      return (request.body as { clientContext: { thread: Record<string, unknown> } }).clientContext.thread;
    };
    expect(thread(0).voicePresence).toBe(
      "You just joined voice channel voice-1 in this server. Nobody is opted in until they use " +
        "/clankie voice-consent opt-in, and you only ever hear opted-in participants.",
    );
    expect(thread(2).voicePresence).toBe(
      "You could not join voice: the asker does not hold the voice presence tier here.",
    );
    // An absent note renders nothing at all — not an empty line.
    expect(thread(4)).not.toHaveProperty("voicePresence");
  });

  it("admits voice only from a Discord voice/text bridge identity and preserves text authority", async () => {
    const submitted: DiscordPresenceChannelTurnRequest[] = [];
    const app = await createControlPlane({
      doctrine,
      authenticateCaptain: () =>
        Promise.resolve({ captainId: "discord-voice-bridge", steerSourceLane: "discord_voice" }),
      captainChannelTurns: {
        submit(input) {
          submitted.push(input.request as DiscordPresenceChannelTurnRequest);
          return Promise.resolve({
            state: "settled" as const,
            captainSessionId: "captain-session",
            turnId: "turn-voice",
            response: "Voice reply.",
          });
        },
      },
    });

    const voice = await post(app, voiceTurnRequest(), "Bearer voice");
    const text = await post(app, turnRequest(), "Bearer voice");
    expect(voice.status).toBe(200);
    expect(text.status).toBe(403);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.trigger).toMatchObject({ kind: "voice_event", actorId: "user-1" });
  });

  it("opens a continuing discord_voice lane and injects only control-plane-approved person memory", async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const recalled: unknown[] = [];
    let turn = 0;
    const port = new EveCaptainChannelTurnPort({
      baseUrl: "http://127.0.0.1:4321",
      recallDiscordPerson(identity, options) {
        recalled.push({ identity, options });
        return "## Discord person memory\n- preference: likes Bulbasaur";
      },
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
        });
        if (init?.method === "POST") {
          turn += 1;
          return Response.json(
            { sessionId: "eve-voice", continuationToken: `voice-token-${String(turn)}` },
            { status: 202 },
          );
        }
        return ndjson([
          { type: "turn.started", data: { turnId: `voice-turn-${String(turn)}` } },
          {
            type: "message.completed",
            data: {
              turnId: `voice-turn-${String(turn)}`,
              finishReason: "stop",
              message: "Voice response.",
            },
          },
          { type: "session.waiting", data: { turnId: `voice-turn-${String(turn)}` } },
        ]);
      },
    });

    await port.submit({ request: voiceTurnRequest() });
    await port.submit({ request: { ...voiceTurnRequest(), deliveryId: "utterance-2" } });

    expect(requests[0]).toMatchObject({
      url: "http://127.0.0.1:4321/eve/v1/session",
      body: {
        clientContext: {
          channel: {
            kind: "discord-voice",
            metadata: {
              captainLane: "discord_voice",
              captainTargetId: "guild-1:voice-1",
            },
          },
          thread: {
            source: "discord_voice",
            approvedPersonMemory: {
              trust: "approved_projection",
              subject: { guildId: "guild-1", userId: "user-1" },
              body: "## Discord person memory\n- preference: likes Bulbasaur",
            },
          },
        },
      },
    });
    expect(requests[2]).toMatchObject({
      url: "http://127.0.0.1:4321/eve/v1/session/eve-voice",
      body: { continuationToken: "voice-token-1" },
    });
    expect(recalled).toEqual([
      {
        identity: { guildId: "guild-1", userId: "user-1" },
        options: { channelId: "voice-1", query: "hello group" },
      },
      {
        identity: { guildId: "guild-1", userId: "user-1" },
        options: { channelId: "voice-1", query: "hello group" },
      },
    ]);
  });
});

function turnRequest(): DiscordPresenceChannelTurnRequest {
  return {
    schemaVersion: 1,
    deliveryId: "message-1",
    identity: {
      presenceSessionId: "discord:dm:dm-1",
      correlationId: "discord-message:message-1",
      profileHash: doctrine.profileHash,
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
    },
    trigger: {
      kind: "dm",
      id: "message-1",
      channelId: "dm-1",
      messageId: "message-1",
      actorId: "james",
      body: "hello",
      attachments: [],
    },
    contextMessages: [
      {
        id: "context-1",
        authorId: "friend",
        body: "earlier",
        createdAt: "2026-07-12T20:00:00.000Z",
      },
    ],
  };
}

function voiceTurnRequest(): DiscordPresenceChannelTurnRequest {
  return {
    schemaVersion: 1,
    deliveryId: "utterance-1",
    identity: {
      presenceSessionId: "discord:voice:guild-1:voice-1",
      correlationId: "discord-voice:utterance-1",
      profileHash: doctrine.profileHash,
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
    },
    trigger: {
      kind: "voice_event",
      id: "utterance-1",
      guildId: "guild-1",
      channelId: "voice-1",
      actorId: "user-1",
      body: "hello group",
      attachments: [],
    },
    contextMessages: [],
  };
}

async function post(
  app: Awaited<ReturnType<typeof createControlPlane>>,
  body: unknown,
  authorization?: string,
) {
  return app.request("/v1/captain/channel-turns", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: JSON.stringify(body),
  });
}

describe("showing him an image", () => {
  const imageTurn = (
    overrides: Partial<DiscordPresenceChannelTurnRequest["trigger"]> = {},
  ): DiscordPresenceChannelTurnRequest => {
    const base = turnRequest();
    return {
      ...base,
      deliveryId: "message-image",
      trigger: {
        ...base.trigger,
        id: "message-image",
        messageId: "message-image",
        body: "what is this",
        attachments: [
          {
            id: "att-1",
            url: "https://cdn.discordapp.com/attachments/1/2/shot.png",
            mediaType: "image/png",
            filename: "shot.png",
            byteSize: 64,
          },
        ],
        ...overrides,
      },
    };
  };

  const capture = (
    request: DiscordPresenceChannelTurnRequest,
    options: Partial<ConstructorParameters<typeof EveCaptainChannelTurnPort>[0]> = {},
  ) => {
    const posted: Array<Record<string, unknown>> = [];
    const port = new EveCaptainChannelTurnPort({
      baseUrl: "http://127.0.0.1:4321",
      fetchImpl: (input, init) => {
        if (init?.method === "POST") {
          posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return Promise.resolve(Response.json({ sessionId: "eve-image" }, { status: 202 }));
        }
        return Promise.resolve(
          ndjson([
            { type: "turn.started", data: { turnId: "turn-image" } },
            {
              type: "message.completed",
              data: { turnId: "turn-image", finishReason: "stop", message: "A screenshot." },
            },
            { type: "session.waiting", data: { turnId: "turn-image" } },
          ]),
        );
      },
      ...options,
    });
    return { posted, submit: () => port.submit({ request }) };
  };

  /** The first POSTed turn body, failing loudly rather than reading through an absent one. */
  const firstPost = (posted: ReadonlyArray<Record<string, unknown>>) => {
    const body = posted[0];
    if (body === undefined) throw new Error("no turn was posted to Eve");
    return {
      message: body.message,
      thread: (body.clientContext as { thread: { trigger: Record<string, unknown> } }).thread,
    };
  };

  it("sends the picture to the model as a file part beside the fixed framing", async () => {
    const { posted, submit } = capture(imageTurn(), {
      resolveDiscordAttachments: (attachments) =>
        Promise.resolve(
          attachments.map((attachment) => ({
            id: attachment.id,
            mediaType: attachment.mediaType,
            ...(attachment.filename === undefined ? {} : { filename: attachment.filename }),
            dataUrl: `data:${attachment.mediaType};base64,AAAA`,
          })),
        ),
    });

    await expect(submit()).resolves.toMatchObject({ state: "settled", response: "A screenshot." });

    const message = firstPost(posted).message as Array<Record<string, unknown>>;
    expect(Array.isArray(message)).toBe(true);
    expect(message[0]).toMatchObject({ type: "text" });
    // Images are untrusted content, and the framing says so in fixed text.
    expect(String(message[0]?.text)).toContain("untrusted content");
    expect(message[1]).toEqual({
      type: "file",
      data: "data:image/png;base64,AAAA",
      mediaType: "image/png",
      filename: "shot.png",
    });
    // Bytes never appear in the context envelope, only the shape of what he was shown.
    const { thread } = firstPost(posted);
    expect(thread.trigger).toMatchObject({
      body: "what is this",
      attachments: [{ mediaType: "image/png", filename: "shot.png" }],
    });
    expect(JSON.stringify(thread)).not.toContain("AAAA");
  });

  it("keeps a caption-less image a real turn, with no empty body", async () => {
    const { posted, submit } = capture(imageTurn({ body: undefined }), {
      resolveDiscordAttachments: (attachments) =>
        Promise.resolve(
          attachments.map((attachment) => ({
            id: attachment.id,
            mediaType: attachment.mediaType,
            dataUrl: "data:image/png;base64,AAAA",
          })),
        ),
    });

    await expect(submit()).resolves.toMatchObject({ state: "settled" });

    const { thread } = firstPost(posted);
    expect(thread.trigger.body).toBeUndefined();
    expect(thread.trigger.attachments).toHaveLength(1);
  });

  it("answers anyway when the image cannot be fetched, and says one went unread", async () => {
    const { posted, submit } = capture(imageTurn(), {
      resolveDiscordAttachments: () => Promise.resolve([]),
    });

    await expect(submit()).resolves.toMatchObject({ state: "settled" });

    // Degrades to the plain-string message rather than failing the turn.
    const { message, thread } = firstPost(posted);
    expect(typeof message).toBe("string");
    expect(String(message)).toContain("cannot see");
    expect(thread.trigger.unreadableAttachments).toBe(1);
    expect(thread.trigger.attachments).toBeUndefined();
  });

  it("counts what ingress dropped alongside what the fetch lost", async () => {
    const { posted, submit } = capture(imageTurn({ attachmentsOmitted: 2 }), {
      resolveDiscordAttachments: () => Promise.resolve([]),
    });

    await submit();

    const { thread } = firstPost(posted);
    expect(thread.trigger.unreadableAttachments).toBe(3);
  });

  it("leaves a text-only turn byte-for-byte the plain string it always was", async () => {
    const { posted, submit } = capture(turnRequest(), {
      resolveDiscordAttachments: () => Promise.reject(new Error("must not be called")),
    });

    await expect(submit()).resolves.toMatchObject({ state: "settled" });

    expect(typeof firstPost(posted).message).toBe("string");
  });

  it("refuses a turn carrying neither text nor an image", async () => {
    const { submit } = capture(imageTurn({ body: undefined, attachments: [] }));

    await expect(submit()).rejects.toThrow(/trigger body or at least one attachment/u);
  });
});

/**
 * A picture he made during the turn rides the result (ADR 0085), harvested from
 * the turn's own tool results rather than from anything the model wrote. These
 * cover the property that matters: the harvest reads what the control plane
 * actually did, so nothing he says can put an artifact on his reply.
 */
describe("media he made during the turn", () => {
  const artifactRef = `sha256:${"a".repeat(64)}:generated/made.png`;

  const submitWith = async (events: readonly unknown[]) => {
    const port = new EveCaptainChannelTurnPort({
      baseUrl: "http://127.0.0.1:4321",
      fetchImpl: (_input, init) =>
        init?.method === "POST"
          ? Promise.resolve(Response.json({ sessionId: "eve-media" }, { status: 202 }))
          : Promise.resolve(
              ndjson([
                { type: "turn.started", data: { turnId: "turn-media" } },
                ...events,
                {
                  type: "message.completed",
                  data: { turnId: "turn-media", finishReason: "stop", message: "Here you go." },
                },
                { type: "session.completed", data: { turnId: "turn-media" } },
              ]),
            ),
    });
    return port.submit({ request: turnRequest() });
  };

  const toolResult = (overrides: Record<string, unknown> = {}, output?: unknown) => ({
    type: "action.result",
    data: {
      turnId: "turn-media",
      status: "completed",
      result: {
        kind: "tool-result",
        callId: "call-1",
        toolName: "generate_image",
        output: output ?? { outcome: "ok", artifactRef, filename: "made.png" },
        ...overrides,
      },
    },
  });

  it("carries a generated picture on the settled result", async () => {
    await expect(submitWith([toolResult()])).resolves.toMatchObject({
      state: "settled",
      media: { artifactRef, filename: "made.png" },
    });
  });

  it("carries the last one when he tried more than once", async () => {
    const second = `sha256:${"b".repeat(64)}:generated/second.png`;
    await expect(
      submitWith([
        toolResult(),
        toolResult({ callId: "call-2" }, { outcome: "ok", artifactRef: second, filename: "second.png" }),
      ]),
    ).resolves.toMatchObject({ media: { artifactRef: second } });
  });

  it("carries nothing from a refused generation", async () => {
    const result = await submitWith([
      toolResult({}, { outcome: "refused", reason: "credential_unavailable" }),
    ]);
    expect(result).toMatchObject({ state: "settled" });
    expect(result).not.toHaveProperty("media");
  });

  it("carries nothing from a failed tool call", async () => {
    const events = [toolResult()] as Array<{ data: Record<string, unknown> }>;
    events[0]!.data.status = "failed";
    expect(await submitWith(events)).not.toHaveProperty("media");
  });

  it("ignores a reference that is not generated media", async () => {
    const result = await submitWith([
      toolResult({}, { outcome: "ok", artifactRef: `sha256:${"a".repeat(64)}:browser/shot.png` }),
    ]);
    expect(result).not.toHaveProperty("media");
  });

  it("ignores a tool that is not the media generator", async () => {
    const result = await submitWith([toolResult({ toolName: "call_browser_tool" })]);
    expect(result).not.toHaveProperty("media");
  });
});

function ndjson(events: readonly unknown[]): Response {
  return new Response(events.map((event) => JSON.stringify(event)).join("\n"));
}
