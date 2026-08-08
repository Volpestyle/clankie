import { createServer } from "node:http";
import { ClankieApiClient } from "@clankie/api-client";
import { createLogger } from "@clankie/observability";
import { SLACK_WEBHOOK_MAX_BODY_BYTES } from "../../relay/src/slack-webhook-protocol.ts";
import { SlackChannelAdapter } from "./slack-channel-adapter.ts";
import { SlackWebApiReplyTransport } from "./slack-reply-transport.ts";
import { SlackWebhookIngress } from "./slack-webhook-ingress.ts";

const logger = createLogger({ service: "clankie-slack-bridge", version: "0.1.0" });

const api = new ClankieApiClient({
  baseUrl: loopbackUrl(process.env.CLANKIE_API_URL ?? "http://127.0.0.1:4310").toString(),
});
const adapter = new SlackChannelAdapter({
  api,
  identity: {
    profileHash: required("CLANKIE_PROFILE_HASH"),
    appUserId: required("SLACK_APP_USER_ID"),
  },
  reply: new SlackWebApiReplyTransport({ botToken: required("SLACK_BOT_TOKEN") }),
  approvalSurfaceUrl: required("CLANKIE_APPROVAL_SURFACE_URL"),
  evidence: (evidence) => logger.info(evidence, "Slack channel transition"),
});
const ingress = new SlackWebhookIngress({
  signingSecret: required("SLACK_SIGNING_SECRET"),
  adapter,
  evidence: (evidence) => logger.info(evidence, "Slack webhook transition"),
});

// Bound to loopback: Slack reaches this through the same public termination the
// Linear webhook uses, never by exposing the bridge process directly.
const host = "127.0.0.1";
const port = Number(process.env.SLACK_BRIDGE_PORT ?? 4316);
const server = createServer((request, response) => {
  void (async () => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      size += buffer.byteLength;
      if (size > SLACK_WEBHOOK_MAX_BODY_BYTES) {
        response.statusCode = 413;
        response.end();
        return;
      }
      chunks.push(buffer);
    }
    const result = await ingress.handle({
      method: request.method ?? "GET",
      headers: new Headers(
        Object.entries(request.headers).flatMap(([key, value]) =>
          typeof value === "string" ? [[key, value] as [string, string]] : [],
        ),
      ),
      rawBody: Buffer.concat(chunks),
    });
    response.statusCode = result.status;
    // Slack's handshake wants the challenge echoed as the whole body.
    if (result.challenge !== undefined) {
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end(result.challenge);
      return;
    }
    response.end();
  })().catch(() => {
    response.statusCode = 500;
    response.end();
  });
});

const shutdown = (): void => {
  server.close(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

server.listen(port, host, () => {
  logger.info({ host, port, appUserId: required("SLACK_APP_USER_ID") }, "Slack bridge listening");
});

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function loopbackUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("CLANKIE_API_URL must be a loopback HTTP endpoint");
  }
  return url;
}
