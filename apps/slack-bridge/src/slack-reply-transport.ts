import type { SlackReplyTransport } from "./slack-channel-adapter.ts";

const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";

export interface SlackWebApiReplyTransportOptions {
  /** Bot token. Held only by this transport; it never reaches the adapter. */
  readonly botToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly endpoint?: string;
}

/**
 * Posts into the originating thread over Slack's Web API.
 *
 * Slack answers a failed call with HTTP 200 and `ok: false`, so status alone is
 * not evidence of delivery — the body is checked. The failure carries Slack's
 * error slug and never the token or message text.
 */
export class SlackWebApiReplyTransport implements SlackReplyTransport {
  private readonly options: SlackWebApiReplyTransportOptions;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: SlackWebApiReplyTransportOptions) {
    if (!options.botToken) throw new Error("Slack reply transport requires a bot token");
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async postMessage(input: { channelId: string; threadTs: string; text: string }): Promise<void> {
    const response = await this.fetchImpl(this.options.endpoint ?? SLACK_POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: input.channelId,
        thread_ts: input.threadTs,
        text: input.text,
      }),
    });
    if (!response.ok) throw new Error(`slack_post_message_http_${String(response.status)}`);
    const body = (await response.json()) as { ok?: boolean; error?: string };
    if (body.ok !== true) {
      throw new Error(`slack_post_message_failed_${(body.error ?? "unknown").slice(0, 64)}`);
    }
  }
}
