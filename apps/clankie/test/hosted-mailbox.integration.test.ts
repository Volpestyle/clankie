import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLANKIE_ACCOUNT_PROVIDER_ID, FileCredentialStore } from "@clankie/credential-broker";
import { AccountsResponseSchema } from "@clankie/protocol/accounts";
import { HOSTED_MAIL_ACCOUNT_PATH, HostedMailRequestSchema } from "@clankie/protocol/hosted-mail";
import { SettingsStore } from "@clankie/settings";
import { createAccountRoutes } from "../src/account-routes.ts";
import { createAccounts } from "../src/accounts.ts";
import { createEmailPort } from "../src/email.ts";
import { accountMailbox } from "../src/hosted-mailbox.ts";

const TOKEN = "account-access-token";
const ADDRESS = "clankie-3f9a02bc@clankie.bot";

/**
 * Clankie's mail service as the fleet answers it (the contract in
 * @clankie/protocol/hosted-mail), on loopback: one inbox message, an hourly
 * limit of one send, and the account bearer it requires.
 */
async function mailService(): Promise<{ url: string; requests: unknown[]; close: () => Promise<void> }> {
  const requests: unknown[] = [];
  let sent = 0;
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += String(chunk)));
    request.on("end", () => {
      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.url !== HOSTED_MAIL_ACCOUNT_PATH) return reply(404, { error: "not_found" });
      if (request.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: "unauthorized" });
      const parsed = HostedMailRequestSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return reply(400, { ok: false, refusal: "malformed" });
      requests.push(parsed.data);
      const inbox = {
        uid: 1_791_000_000_000_001,
        folder: "INBOX",
        from: "Sam <sam@example.com>",
        to: ADDRESS,
        subject: "Welcome",
        date: "2026-10-06T12:00:00.000Z",
      };
      const ok = (fields: object) => reply(200, { ok: true, address: ADDRESS, ...fields });
      switch (parsed.data.op) {
        case "status":
          return ok({ limits: { sendsPerHour: 1, sendsPerDay: 30, recipientsPerDay: 10 } });
        case "list":
        case "search":
          return ok({ messages: [inbox] });
        case "read":
          return parsed.data.uid === inbox.uid
            ? ok({ message: { ...inbox, text: "Glad you have an address." } })
            : reply(404, { ok: false, refusal: "not_found" });
        case "send":
          if (sent++ === 0) return ok({ messageId: "ses-message-1" });
          return reply(429, {
            ok: false,
            refusal: "limit_reached",
            limit: { name: "sends_per_hour", max: 1, retryAt: "2026-10-06T13:00:00.000Z" },
          });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

async function setup(options: { signedIn: boolean; token?: string }) {
  const service = await mailService();
  const directory = await mkdtemp(join(tmpdir(), "clankie-hosted-mail-"));
  cleanup.push(service.close, () => rm(directory, { recursive: true, force: true }));
  const credentials = new FileCredentialStore(join(directory, "credentials.json"));
  const settings = new SettingsStore(join(directory, "settings.json"));
  if (options.signedIn)
    await credentials.set(CLANKIE_ACCOUNT_PROVIDER_ID, {
      type: "oauth",
      access: options.token ?? TOKEN,
      refresh: "refresh",
      expires: Date.now() + 3_600_000,
      accountId: "acct-1",
    });
  const email = createEmailPort({
    credentials,
    settings,
    hosted: accountMailbox({
      gatewayUrl: async () => service.url,
      signedIn: async () => (await credentials.get(CLANKIE_ACCOUNT_PROVIDER_ID))?.type === "oauth",
      token: async () => {
        const stored = await credentials.get(CLANKIE_ACCOUNT_PROVIDER_ID);
        if (stored?.type !== "oauth") throw new Error("not signed in");
        return { token: stored.access, accountId: "acct-1", expiresAt: stored.expires };
      },
    }),
  });
  const routes = createAccountRoutes(
    createAccounts({ store: credentials, mailbox: email, apps: async () => ({ github: {}, linear: {} }) }),
    async () => true,
  );
  const row = async () =>
    AccountsResponseSchema.parse(await (await routes.request("/v1/accounts")).json()).connections.find(
      (connection) => connection.provider === "email",
    );
  return { email, settings, service, row };
}

describe("his Clankie mailbox", () => {
  it("works with no mail setup on a signed-in install: reads, sends, records his address, names the limit", async () => {
    const { email, settings, service, row } = await setup({ signedIn: true });
    expect(await row()).toMatchObject({ provider: "email", status: "connected", account: ADDRESS });
    // The captain states his address from settings; the first answer wrote it there.
    expect((await settings.load()).email).toMatchObject({ provider: "clankie", fromAddress: ADDRESS });

    await expect(email.list()).resolves.toMatchObject({
      outcome: "ok",
      messages: [{ subject: "Welcome", from: "Sam <sam@example.com>" }],
    });
    await expect(email.read(1_791_000_000_000_001)).resolves.toMatchObject({
      outcome: "ok",
      message: { text: "Glad you have an address." },
    });
    await expect(email.read(7)).resolves.toMatchObject({ outcome: "refused", detail: "no message uid 7" });
    await expect(email.list({ folder: "Archive" })).resolves.toMatchObject({ outcome: "refused" });

    await expect(email.send({ to: "sam@example.com", subject: "Hi", text: "Hello" })).resolves.toEqual({
      outcome: "ok",
      messageId: "ses-message-1",
    });
    await expect(email.send({ to: "sam@example.com", subject: "Again", text: "Hello" })).resolves.toEqual({
      outcome: "refused",
      reason: "limit_reached",
      detail:
        "hourly send limit (1 messages an hour) reached; the next send can go after 2026-10-06T13:00:00.000Z",
    });
    // A limit is about the send; the mailbox is still connected.
    expect(await row()).toMatchObject({ status: "connected" });
    expect(service.requests.map((request) => (request as { op: string }).op)).toContain("send");
  });

  it("is not connected without a Clankie account, and a lapsed sign-in says so", async () => {
    const signedOut = await setup({ signedIn: false });
    expect(await signedOut.row()).toMatchObject({ status: "not_connected" });
    await expect(signedOut.email.list()).resolves.toMatchObject({
      outcome: "refused",
      reason: "credential_unavailable",
    });

    const lapsed = await setup({ signedIn: true, token: "expired-token" });
    await expect(lapsed.email.list()).resolves.toMatchObject({
      outcome: "refused",
      reason: "sign_in_rejected",
    });
    expect(await lapsed.row()).toMatchObject({ status: "reconnect_required", reason: "sign_in_rejected" });
  });

  it("leaves an owner's own IMAP mailbox in charge when one is configured", async () => {
    const { email, settings, service } = await setup({ signedIn: true });
    await settings.update((current) => ({
      ...current,
      email: { ...current.email, imapHost: "imap.example.com", username: "owner@example.com" },
    }));
    await expect(email.list()).resolves.toMatchObject({
      outcome: "refused",
      reason: "credential_unavailable",
    });
    expect(service.requests).toEqual([]);
  });
});
