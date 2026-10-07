import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { AccountsResponseSchema } from "@clankie/protocol/accounts";
import { SettingsStore } from "@clankie/settings";
import { createAccountRoutes } from "../src/account-routes.ts";
import { createAccounts } from "../src/accounts.ts";
import { createEmailPort, EMAIL_PROVIDER_ID } from "../src/email.ts";

const GOOD = "app-password-current";
const REVOKED = "app-password-revoked";
/** What Gmail answers a revoked app password with, verbatim. */
const GMAIL_REFUSAL = "Invalid credentials (Failure)";

/**
 * A loopback IMAP and SMTP server speaking the wire protocol to the real
 * ImapFlow and nodemailer clients. Only the sign-in decides anything.
 */
async function mailServer(): Promise<{ imapPort: number; smtpPort: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const imap = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write("* OK [CAPABILITY IMAP4rev1] fake ready\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      for (let end = buffer.indexOf("\r\n"); end >= 0; end = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const [tag, command = ""] = line.split(" ");
        const verb = command.toUpperCase();
        if (verb === "CAPABILITY") socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
        else if (verb === "LOGIN")
          socket.write(
            line.includes(GOOD)
              ? `${tag} OK [CAPABILITY IMAP4rev1] signed in\r\n`
              : `${tag} NO [AUTHENTICATIONFAILED] ${GMAIL_REFUSAL}\r\n`,
          );
        else if (verb === "SELECT" || verb === "EXAMINE")
          socket.write(`* 0 EXISTS\r\n* FLAGS (\\Seen)\r\n${tag} OK [READ-WRITE] selected\r\n`);
        else if (verb === "LOGOUT") {
          socket.write(`* BYE bye\r\n${tag} OK done\r\n`);
          socket.end();
        } else socket.write(`${tag} OK done\r\n`);
      }
    });
  });
  const smtp = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write("220 fake ESMTP\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      for (let end = buffer.indexOf("\r\n"); end >= 0; end = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO") socket.write("250-fake\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (verb === "AUTH")
          socket.write("535-5.7.8 Username and Password not accepted.\r\n535 5.7.8 BadCredentials\r\n");
        else if (verb === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else socket.write("250 ok\r\n");
      }
    });
  });
  const listen = (server: Server) =>
    new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
    );
  const [imapPort, smtpPort] = [await listen(imap), await listen(smtp)];
  return {
    imapPort,
    smtpPort,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all([imap, smtp].map((server) => new Promise((resolve) => server.close(resolve))));
    },
  };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

async function setup(password: string | undefined) {
  const server = await mailServer();
  const directory = await mkdtemp(join(tmpdir(), "clankie-mail-signin-"));
  cleanup.push(server.close, () => rm(directory, { recursive: true, force: true }));
  const credentials = new FileCredentialStore(join(directory, "credentials.json"));
  const settings = new SettingsStore(join(directory, "settings.json"));
  if (password !== undefined) await credentials.set(EMAIL_PROVIDER_ID, { type: "api", key: password });
  await settings.update((current) => ({
    ...current,
    email: {
      imapHost: "127.0.0.1",
      imapPort: server.imapPort,
      smtpHost: "127.0.0.1",
      smtpPort: server.smtpPort,
      secure: false,
      username: "clankie.mailbox@example.com",
      fromAddress: "clankie@clankie.bot",
    },
  }));
  const email = createEmailPort({ credentials, settings });
  const routes = createAccountRoutes(
    createAccounts({ store: credentials, mailbox: email, apps: async () => ({ github: {}, linear: {} }) }),
    async () => true,
  );
  const list = async () =>
    AccountsResponseSchema.parse(await (await routes.request("/v1/accounts")).json()).connections.find(
      (connection) => connection.provider === "email",
    );
  return { email, routes, list, credentials };
}

describe("mailbox sign-in", () => {
  it("names a rejected IMAP sign-in and the server's reason, and the connection list shows it", async () => {
    const { email, list } = await setup(REVOKED);
    const refusal = await email.list();
    expect(refusal).toEqual({
      outcome: "refused",
      reason: "sign_in_rejected",
      detail: `mailbox sign-in rejected — reconnect with /connect email (server: [AUTHENTICATIONFAILED] ${GMAIL_REFUSAL})`,
    });
    expect(JSON.stringify(refusal)).not.toContain(REVOKED);
    expect(await list()).toMatchObject({
      provider: "email",
      status: "reconnect_required",
      reason: "sign_in_rejected",
      account: "clankie@clankie.bot",
      lastCheckedAt: expect.any(String),
    });
  });

  it("names a rejected SMTP sign-in", async () => {
    const { email } = await setup(GOOD);
    const sent = await email.send({ to: "owner@example.com", subject: "hi", text: "hello" });
    expect(sent).toMatchObject({ outcome: "refused", reason: "sign_in_rejected" });
    expect(sent).toHaveProperty("detail", expect.stringContaining("Username and Password not accepted"));
  });

  it("lists a working mailbox as connected and an unconnected one as not connected; disconnect forgets it", async () => {
    const { list, routes, credentials } = await setup(GOOD);
    expect(await list()).toMatchObject({ status: "connected", account: "clankie@clankie.bot" });
    const disconnected = await routes.request("/v1/accounts/disconnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "email" }),
    });
    expect(await disconnected.json()).toEqual({ ok: true, revoked: false });
    expect(await credentials.get(EMAIL_PROVIDER_ID)).toBeUndefined();
    expect(await list()).toEqual(expect.objectContaining({ status: "not_connected", scopes: [] }));
  });
});
