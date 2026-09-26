import { createLanguageModel } from "@clankie/model-provider";
import { createModelFreePlayMind, createModelVoice, type ClankieVoice } from "@clankie/play";
import { describe, expect, it } from "vitest";

type PlayView = Parameters<ReturnType<typeof createModelFreePlayMind>["decide"]>[0];
type VoiceView = Parameters<ClankieVoice["decide"]>[0];

/**
 * An OpenAI-compatible provider (OpenRouter, a local runtime) with no
 * structured-output support is asked for `response_format: json_object` and
 * never sees the schema. OpenAI refuses that mode unless a message says
 * "json"; through OpenRouter that failed every gameplay turn on openai/*
 * models (model-eval-2, 2026-09-26). This stub applies OpenAI's rule to the
 * real request the production adapter builds.
 */
function openAiRuleEndpoint(answer: unknown) {
  const requests: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      response_format?: { type?: string };
      messages: Array<{ content: unknown }>;
    };
    requests.push(body);
    const said = JSON.stringify(body.messages.map((message) => message.content));
    if (body.response_format?.type === "json_object" && !/json/iu.test(said)) {
      return Response.json(
        {
          error: {
            message:
              "'messages' must contain the word 'json' in some form, to use 'response_format' of type 'json_object'.",
            type: "invalid_request_error",
            param: "messages",
            code: null,
          },
        },
        { status: 400 },
      );
    }
    const chunk = (delta: object, finish: string | null) =>
      `data: ${JSON.stringify({
        id: "c",
        object: "chat.completion.chunk",
        created: 1,
        model: "openai/gpt-6-luna",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    return new Response(
      chunk({ role: "assistant", content: JSON.stringify(answer) }, null) +
        chunk({}, "stop") +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const model = createLanguageModel({
    provider: {
      id: "openrouter",
      name: "OpenRouter",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      api: "https://openrouter.test/api/v1",
      models: {},
    },
    modelId: "openai/gpt-6-luna",
    credential: { type: "api", key: "test-key" },
    fetchImpl,
  });
  return { model, requests };
}

describe("play minds over an OpenAI-compatible JSON mode", () => {
  it("gets a gameplay decision past OpenAI's json_object rule", async () => {
    const endpoint = openAiRuleEndpoint({
      monologue: "a test pattern",
      intent: "look around",
      notes: null,
      objective: null,
      reply: null,
      speak: null,
      actionKind: "button_press",
      button: "a",
      holdFrames: null,
      repeat: null,
      x: null,
      y: null,
      text: null,
      entryId: null,
      frames: null,
    });
    const mind = createModelFreePlayMind({ model: endpoint.model, maxRetries: 0 });

    await expect(mind.decide(playView())).resolves.toMatchObject({ intent: "look around" });
    expect(endpoint.requests[0]?.response_format).toEqual({ type: "json_object" });
    // The model is told the shape, since json_object mode carries no schema.
    expect(JSON.stringify(endpoint.requests[0]?.messages)).toContain("actionKind");
  });

  it("gets a commentary decision past the same rule", async () => {
    const endpoint = openAiRuleEndpoint({ speak: "four colours, no enemies", reply: null });
    const voice = createModelVoice({ model: endpoint.model, maxRetries: 0 });

    await expect(voice.decide(voiceView())).resolves.toMatchObject({ speak: "four colours, no enemies" });
    expect(JSON.stringify(endpoint.requests[0]?.messages)).toContain("speak");
  });
});

function playView(): PlayView {
  return {
    turn: 1,
    observations: [],
    framePng: null,
    refusedHere: [],
    knownHardFailures: [],
    stalledForTurns: null,
    repeatingForTurns: null,
    recurringForTurns: null,
    objectiveForTurns: null,
    localeForTurns: null,
    retiredObjective: null,
    objectiveRecovery: false,
    verifiedInteractions: [],
    learnedTransitions: [],
    notes: null,
    objective: null,
    interjection: null,
    turnsSinceSpoke: null,
    audience: null,
    history: [],
  };
}

function voiceView(): VoiceView {
  return {
    turn: 1,
    framePng: null,
    monologue: "Four flat colour blocks.",
    effect: "The screen is a test pattern.",
    intent: "Look around.",
    objective: null,
    heard: null,
    turnsSinceSpoke: null,
    audience: null,
    recentlySaid: [],
  } as VoiceView;
}
