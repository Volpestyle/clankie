import { describe, expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEmailPort,
  EMAIL_PROVIDER_ID,
  textBody,
  type EmailAdapters,
  type FetchedMail,
} from "../src/email.ts";

function fakeAdapters(mailbox: FetchedMail[]): EmailAdapters {
  return {
    async openImap() {
      return {
        exists: async () => mailbox.length,
        fetchRange: async () => mailbox,
        search: async (query) =>
          mailbox.filter((item) => (item.subject ?? "").includes(query)).map((item) => item.uid),
        fetchUids: async (uids) => mailbox.filter((item) => uids.includes(item.uid)),
        close: async () => undefined,
      };
    },
    async sendSmtp(_account, message) {
      return `generated-${message.subject}`;
    },
  };
}

async function harness(mailbox: FetchedMail[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "clankie-email-"));
  const credentials = new FileCredentialStore(join(directory, "creds.json"));
  const settings = new SettingsStore(join(directory, "settings.json"));
  return {
    credentials,
    settings,
    email: createEmailPort({ credentials, settings, adapters: fakeAdapters(mailbox) }),
  };
}

describe("email port", () => {
  it("refuses when the mailbox is not connected", async () => {
    const { email } = await harness();
    await expect(email.list()).resolves.toMatchObject({
      outcome: "refused",
      reason: "credential_unavailable",
    });
  });

  it("lists and reads once host, username, and password are stored", async () => {
    const { credentials, settings, email } = await harness([
      {
        uid: 12,
        from: "sam@example.com",
        to: "me@example.com",
        subject: "Standup notes",
        date: new Date("2026-08-15T12:00:00Z"),
        source: "Subject: Standup notes\n\nWe shipped the connect wizard.",
      },
    ]);
    await credentials.set(EMAIL_PROVIDER_ID, { type: "api", key: "app-password" });
    await settings.update((current) => ({
      ...current,
      email: {
        ...current.email,
        imapHost: "imap.example.com",
        smtpHost: "smtp.example.com",
        username: "me@example.com",
      },
    }));

    const listed = await email.list({ limit: 5 });
    expect(listed).toMatchObject({
      outcome: "ok",
      messages: [{ uid: 12, subject: "Standup notes", from: "sam@example.com" }],
    });
    await expect(email.read(12)).resolves.toMatchObject({
      outcome: "ok",
      message: { uid: 12, text: "We shipped the connect wizard." },
    });
    await expect(
      email.send({ to: "sam@example.com", subject: "Re: notes", text: "got it" }),
    ).resolves.toEqual({
      outcome: "ok",
      messageId: "generated-Re: notes",
    });
  });
});

describe("email body extraction", () => {
  it("prefers the text/plain part of a multipart payload", () => {
    expect(
      textBody(
        [
          "MIME-Version: 1.0",
          "Content-Type: multipart/alternative; boundary=bound",
          "",
          "--bound",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "plain body",
          "--bound",
          "Content-Type: text/html",
          "",
          "<p>html</p>",
          "--bound--",
        ].join("\n"),
      ),
    ).toBe("plain body");
  });
});
