import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { scratchMediaFetch } from "../src/media-extension.ts";
import {
  cleanups,
  privateService,
  type ChatMessage,
  type ScriptedReply,
} from "./fixtures/durable-pi-room-service.ts";

// ADR 0284 (#368): media generation across a real restart. The real service, Pi,
// journal, media generator and shell run in a scratch child; its image provider is a
// loopback stand-in reached through the CLANKIE_TEST_MEDIA_API seam, and its model is
// scripted, so nothing here reaches a paid provider.
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

const PIXELS = Buffer.from("loopback-picture");

/** OpenAI's image endpoint on loopback; `hold` accepts a request and never answers it. */
async function imageProvider(options: { hold?: boolean } = {}) {
  const requests: string[] = [];
  const headers: Record<string, string | string[] | undefined>[] = [];
  let arrived!: () => void;
  const first = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const server = createServer(async (request, response) => {
    for await (const _chunk of request);
    requests.push(`${request.method} ${request.url}`);
    headers.push(request.headers);
    arrived();
    if (options.hold === true) return;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: PIXELS.toString("base64") }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing loopback address");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return { url: `http://127.0.0.1:${address.port}`, requests, headers, first };
}

const toolResults = (messages: readonly ChatMessage[]) =>
  messages.filter((message) => message.role === "tool");

async function mediaService(
  provider: { url: string },
  reply: (
    messages: readonly ChatMessage[],
    context: { requestId: string; script: string; root: string },
  ) => ScriptedReply,
) {
  return privateService({
    config: { image_model: "openai/gpt-image-2" },
    env: { CLANKIE_TEST_MEDIA_API: provider.url, OPENAI_API_KEY: "loopback-fixture" },
    reply,
  });
}

it("a picture made before the restart still attaches to the resumed turn's reply, made once", async () => {
  const provider = await imageProvider();
  const f = await mediaService(provider, (messages, { requestId, script }) => {
    const tools = toolResults(messages);
    if (tools.length === 0) return { call: { name: "generate_image", args: { prompt: "a treasure map" } } };
    if (tools.length === 1) return { call: { name: "bash", args: { command: `exec node '${script}'` } } };
    return { text: `${requestId} drew it` };
  });
  await f.start();
  await f.presence();
  expect((await f.post()).status).toBe(202);
  await f.until(async () => ((await f.effects()).length === 1 ? true : undefined));
  const image = (await f.journal()).steps.find((step) => step.input.name === "generate_image");
  const output = image?.output as { content: { text: string }[] } | undefined;
  if (output === undefined) throw new Error("generate_image has no saved outcome");
  const made = JSON.parse(output.content[0]!.text) as {
    outcome: string;
    artifactRef: string;
  };
  expect(made.outcome).toBe("ok");
  await f.stop("SIGKILL");
  await f.stopTool();

  await f.start();
  await f.presence();
  expect((await f.post()).status).toBe(202);
  const result = await f.settled();
  expect(result).toMatchObject({ state: "settled", media: { artifactRef: made.artifactRef } });
  // Made once, before the restart; the resumed turn took it from the journal.
  expect(provider.requests).toEqual(["POST /v1/images/generations"]);
  // The seam carried no credential: the service's provider key never reached the stand-in.
  expect(provider.headers[0]).not.toHaveProperty("authorization");
  expect(await f.effects()).toHaveLength(1);
}, 240_000);

it("a picture interrupted mid-render by the restart surfaces as possibly ran and is never requested again", async () => {
  const provider = await imageProvider({ hold: true });
  const f = await mediaService(provider, (messages, { requestId }) => {
    const tools = toolResults(messages);
    if (tools.length === 0) return { call: { name: "generate_image", args: { prompt: "a treasure map" } } };
    const last = JSON.stringify(tools.at(-1)?.content ?? "");
    return { text: `${requestId} picture: ${last.includes("possibly ran") ? "possibly ran" : "finished"}` };
  });
  await f.start();
  await f.presence();
  expect((await f.post()).status).toBe(202);
  await provider.first;
  expect((await f.journal()).steps.find((step) => step.input.name === "generate_image")).toMatchObject({
    replay: "never",
  });
  await f.stop("SIGKILL");

  await f.start();
  await f.presence();
  expect((await f.post()).status).toBe(202);
  const result = await f.settled();
  expect(result).toMatchObject({ state: "settled" });
  expect(result).not.toHaveProperty("media");
  expect(JSON.stringify(result)).toContain("picture: possibly ran");
  expect(provider.requests).toEqual(["POST /v1/images/generations"]);
}, 240_000);

it("honours the media test seam only in a scratch test run, and only for a loopback address", async () => {
  const scratch = { CLANKIE_SCRATCH: "1", NODE_ENV: "test" };
  expect(scratchMediaFetch({ CLANKIE_TEST_MEDIA_API: "http://127.0.0.1:9" })).toBeUndefined();
  expect(
    scratchMediaFetch({ CLANKIE_TEST_MEDIA_API: "http://127.0.0.1:9", NODE_ENV: "test" }),
  ).toBeUndefined();
  expect(
    scratchMediaFetch({
      CLANKIE_TEST_MEDIA_API: "http://127.0.0.1:9",
      CLANKIE_SCRATCH: "1",
      NODE_ENV: "production",
    }),
  ).toBeUndefined();
  expect(scratchMediaFetch(scratch)).toBeUndefined();
  for (const target of [
    "https://127.0.0.1:9",
    "http://api.openai.com",
    "http://10.0.0.2:9",
    "http://127.0.0.1.example.com",
    "http://localhost:9",
  ])
    expect(() => scratchMediaFetch({ ...scratch, CLANKIE_TEST_MEDIA_API: target }), target).toThrow(
      /plain http on 127\.0\.0\.1 or \[::1\]/u,
    );
  const provider = await imageProvider();
  const fetch = scratchMediaFetch({ ...scratch, CLANKIE_TEST_MEDIA_API: provider.url })!;
  await (
    await fetch("https://api.openai.com/v1/images/generations?x=1&key=query-secret", {
      method: "POST",
      body: "{}",
      headers: {
        authorization: "Bearer header-secret",
        "x-goog-api-key": "goog-secret",
        "content-type": "application/json",
      },
    })
  ).json();
  expect(provider.requests).toEqual(["POST /v1/images/generations?x=1"]);
  // Credentials are stripped by construction; the rest of the request goes through.
  expect(provider.headers[0]).not.toHaveProperty("authorization");
  expect(provider.headers[0]).not.toHaveProperty("x-goog-api-key");
  expect(provider.headers[0]).toMatchObject({ "content-type": "application/json" });
  expect(JSON.stringify(provider.headers)).not.toContain("secret");
});
