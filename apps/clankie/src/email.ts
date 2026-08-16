/**
 * IMAP/SMTP mailbox as a first-class captain connector. The password is
 * broker-owned (`email`); host and username live in owner-authored settings.
 */
import type { CredentialStore } from "@clankie/credential-broker";
import type { EmailSettings, SettingsStore } from "@clankie/settings";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

export const EMAIL_PROVIDER_ID = "email";

export type EmailRefusalReason = "credential_unavailable" | "not_configured" | "provider_error";

export type EmailRefusal = {
  readonly outcome: "refused";
  readonly reason: EmailRefusalReason;
  readonly detail: string;
};

export type EmailHeader = {
  readonly uid: number;
  readonly folder: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly date?: string;
};

export type EmailMessage = EmailHeader & {
  readonly text: string;
};

export type EmailPort = {
  list(options?: {
    folder?: string;
    limit?: number;
  }): Promise<{ outcome: "ok"; messages: EmailHeader[] } | EmailRefusal>;
  read(uid: number, folder?: string): Promise<{ outcome: "ok"; message: EmailMessage } | EmailRefusal>;
  search(
    query: string,
    options?: { folder?: string; limit?: number },
  ): Promise<{ outcome: "ok"; messages: EmailHeader[] } | EmailRefusal>;
  send(input: {
    to: string;
    subject: string;
    text: string;
  }): Promise<{ outcome: "ok"; messageId: string } | EmailRefusal>;
};

export type ImapSession = {
  exists(): Promise<number>;
  fetchRange(fromSeq: number, envelopeAndSource: boolean): Promise<readonly FetchedMail[]>;
  search(query: string): Promise<readonly number[]>;
  fetchUids(uids: readonly number[], envelopeAndSource: boolean): Promise<readonly FetchedMail[]>;
  close(): Promise<void>;
};

export type FetchedMail = {
  readonly uid: number;
  readonly from?: string;
  readonly to?: string;
  readonly subject?: string;
  readonly date?: Date;
  readonly source?: string;
};

export type EmailAdapters = {
  openImap(account: ConnectedMailbox, folder: string): Promise<ImapSession>;
  sendSmtp(
    account: ConnectedMailbox,
    message: { to: string; subject: string; text: string },
  ): Promise<string>;
};

export type ConnectedMailbox = {
  readonly username: string;
  readonly password: string;
  readonly settings: EmailSettings;
};

const MAX_LIST = 25;
const MAX_BODY_CHARS = 12_000;

export function createEmailPort(options: {
  credentials: CredentialStore;
  settings: SettingsStore;
  adapters?: EmailAdapters;
}): EmailPort {
  const adapters = options.adapters ?? defaultEmailAdapters();

  async function connected(): Promise<ConnectedMailbox | EmailRefusal> {
    const stored = await options.credentials.get(EMAIL_PROVIDER_ID);
    if (stored?.type !== "api" || stored.key.trim().length === 0) {
      return {
        outcome: "refused",
        reason: "credential_unavailable",
        detail: "no mailbox password stored — connect it with /connect email",
      };
    }
    const settings = await options.settings.load();
    if (settings.email.imapHost === undefined || settings.email.username === undefined) {
      return {
        outcome: "refused",
        reason: "not_configured",
        detail: "mailbox host or username is missing — finish /connect email",
      };
    }
    return { username: settings.email.username, password: stored.key, settings: settings.email };
  }

  async function withImap<T>(
    folder: string,
    use: (session: ImapSession, account: ConnectedMailbox) => Promise<T | EmailRefusal>,
  ): Promise<T | EmailRefusal> {
    const account = await connected();
    if ("outcome" in account) return account;
    let session: ImapSession;
    try {
      session = await adapters.openImap(account, folder);
    } catch (error) {
      return refuseProvider(error);
    }
    try {
      return await use(session, account);
    } catch (error) {
      return refuseProvider(error);
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  return {
    async list(input = {}) {
      const folder = input.folder?.trim() || "INBOX";
      const limit = clampLimit(input.limit);
      return withImap(folder, async (session) => {
        const exists = await session.exists();
        if (exists === 0) return { outcome: "ok" as const, messages: [] };
        const fromSeq = Math.max(1, exists - limit + 1);
        const fetched = await session.fetchRange(fromSeq, false);
        return { outcome: "ok" as const, messages: fetched.map((item) => toHeader(item, folder)).reverse() };
      });
    },

    async read(uid, folderInput) {
      const folder = folderInput?.trim() || "INBOX";
      return withImap(folder, async (session) => {
        const fetched = await session.fetchUids([uid], true);
        const item = fetched[0];
        if (item === undefined) {
          return {
            outcome: "refused" as const,
            reason: "provider_error" as const,
            detail: `no message uid ${String(uid)}`,
          };
        }
        return {
          outcome: "ok" as const,
          message: { ...toHeader(item, folder), text: textBody(item.source) },
        };
      });
    },

    async search(query, input = {}) {
      const folder = input.folder?.trim() || "INBOX";
      const limit = clampLimit(input.limit);
      return withImap(folder, async (session) => {
        const uids = await session.search(query);
        const selected = uids.slice(-limit);
        if (selected.length === 0) return { outcome: "ok" as const, messages: [] };
        const fetched = await session.fetchUids(selected, false);
        return { outcome: "ok" as const, messages: fetched.map((item) => toHeader(item, folder)).reverse() };
      });
    },

    async send(input) {
      const account = await connected();
      if ("outcome" in account) return account;
      if (account.settings.smtpHost === undefined) {
        return {
          outcome: "refused",
          reason: "not_configured",
          detail: "SMTP host is missing — finish /connect email",
        };
      }
      try {
        const messageId = await adapters.sendSmtp(account, input);
        return { outcome: "ok", messageId };
      } catch (error) {
        return refuseProvider(error);
      }
    },
  };
}

export function defaultEmailAdapters(): EmailAdapters {
  return {
    async openImap(account, folder) {
      const client = new ImapFlow({
        host: account.settings.imapHost ?? "",
        port: account.settings.imapPort,
        secure: account.settings.secure,
        auth: { user: account.username, pass: account.password },
        logger: false,
      });
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      return {
        async exists() {
          const mailbox = client.mailbox;
          return mailbox === false ? 0 : mailbox.exists;
        },
        async fetchRange(fromSeq, envelopeAndSource) {
          const items: FetchedMail[] = [];
          for await (const message of client.fetch(`${String(fromSeq)}:*`, fetchQuery(envelopeAndSource))) {
            items.push(fromImapMessage(message));
          }
          return items;
        },
        async search(query) {
          const found = await client.search({ text: query }, { uid: true });
          return found === false ? [] : found;
        },
        async fetchUids(uids, envelopeAndSource) {
          if (uids.length === 0) return [];
          const items: FetchedMail[] = [];
          for await (const message of client.fetch(uids.join(","), fetchQuery(envelopeAndSource), {
            uid: true,
          })) {
            items.push(fromImapMessage(message));
          }
          return items;
        },
        async close() {
          lock.release();
          await client.logout().catch(() => undefined);
        },
      };
    },
    async sendSmtp(account, message) {
      const transport = nodemailer.createTransport({
        host: account.settings.smtpHost,
        port: account.settings.smtpPort,
        secure: account.settings.smtpPort === 465,
        auth: { user: account.username, pass: account.password },
      });
      try {
        const info = await transport.sendMail({
          from: account.username,
          to: message.to,
          subject: message.subject,
          text: message.text,
        });
        return typeof info.messageId === "string" && info.messageId.length > 0 ? info.messageId : "sent";
      } finally {
        transport.close();
      }
    },
  };
}

function fetchQuery(envelopeAndSource: boolean): { envelope: true; uid: true; source?: true } {
  return envelopeAndSource ? { envelope: true, uid: true, source: true } : { envelope: true, uid: true };
}

function fromImapMessage(message: {
  uid: number;
  envelope?: {
    from?: readonly { address?: string; name?: string }[];
    to?: readonly { address?: string; name?: string }[];
    subject?: string;
    date?: Date;
  };
  source?: Buffer | string;
}): FetchedMail {
  const from = formatAddresses(message.envelope?.from);
  const to = formatAddresses(message.envelope?.to);
  const subject = message.envelope?.subject;
  const date = message.envelope?.date;
  const source = message.source === undefined ? undefined : message.source.toString("utf8");
  return {
    uid: message.uid,
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(subject === undefined ? {} : { subject }),
    ...(date === undefined ? {} : { date }),
    ...(source === undefined ? {} : { source }),
  };
}

function formatAddresses(
  addresses: readonly { address?: string; name?: string }[] | undefined,
): string | undefined {
  if (addresses === undefined || addresses.length === 0) return undefined;
  return addresses
    .map((entry) => {
      if (entry.address === undefined) return entry.name;
      return entry.name === undefined || entry.name.length === 0
        ? entry.address
        : `${entry.name} <${entry.address}>`;
    })
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(", ");
}

function toHeader(item: FetchedMail, folder: string): EmailHeader {
  return {
    uid: item.uid,
    folder,
    from: item.from ?? "",
    to: item.to ?? "",
    subject: item.subject ?? "(no subject)",
    ...(item.date === undefined ? {} : { date: item.date.toISOString() }),
  };
}

export function textBody(source: string | undefined): string {
  if (source === undefined || source.length === 0) return "";
  const separated = source.split(/\r?\n\r?\n/u);
  const body = separated.length > 1 ? separated.slice(1).join("\n\n") : source;
  const plain = extractPlainPart(body);
  return plain.length <= MAX_BODY_CHARS ? plain : `${plain.slice(0, MAX_BODY_CHARS)}\n… truncated`;
}

function extractPlainPart(body: string): string {
  const boundary = /^--([^\s]+)/mu.exec(body)?.[1];
  if (boundary === undefined) return body.trim();
  const parts = body.split(`--${boundary}`);
  for (const part of parts) {
    if (!/content-type:\s*text\/plain/iu.test(part)) continue;
    const split = part.split(/\r?\n\r?\n/u);
    if (split.length > 1) return split.slice(1).join("\n\n").trim();
  }
  return body.trim();
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 10;
  return Math.min(Math.max(limit, 1), MAX_LIST);
}

function refuseProvider(error: unknown): EmailRefusal {
  return {
    outcome: "refused",
    reason: "provider_error",
    detail: error instanceof Error ? error.message : String(error),
  };
}
