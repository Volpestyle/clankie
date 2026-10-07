/**
 * His mailbox as a first-class captain connector, behind one port with two
 * backends: Clankie's own mail service (ADR 0242), and the owner's IMAP/SMTP
 * server, whose password is broker-owned (`email`) and whose host and username
 * live in owner-authored settings.
 */
import type { CredentialStore } from "@clankie/credential-broker";
import type { EmailSettings, SettingsStore } from "@clankie/settings";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { HostedMailRefusal } from "@clankie/protocol/hosted-mail";
import {
  describeHostedRefusal,
  hostedFolder,
  hostedMailParsers,
  type HostedMailbox,
} from "./hosted-mailbox.ts";

export const EMAIL_PROVIDER_ID = "email";

type EmailRefusalReason =
  | "credential_unavailable"
  | "not_configured"
  /** The provider refused the stored sign-in: the owner has to reconnect. */
  | "sign_in_rejected"
  /** Clankie's mail service refused a send at one of its outbound limits; the detail names it. */
  | "limit_reached"
  | "recipient_refused"
  | "provider_error";

type EmailRefusal = {
  readonly outcome: "refused";
  readonly reason: EmailRefusalReason;
  readonly detail: string;
};

type EmailHeader = {
  readonly uid: number;
  readonly folder: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly date?: string;
};

type EmailMessage = EmailHeader & {
  readonly text: string;
};

/**
 * What the owner's connection list shows. `checkedAt` is the last real
 * provider exchange; a probe only runs when that is older than a minute.
 */
type MailboxStatus =
  | { readonly state: "not_connected" }
  | {
      readonly state: "connected" | "sign_in_rejected" | "unavailable";
      readonly address: string;
      readonly checkedAt: string;
    };

export type EmailPort = {
  status(): Promise<MailboxStatus>;
  /** Forgets the stored sign-in; host settings stay for a reconnect. */
  disconnect(): Promise<void>;
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

type ImapSession = {
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

type ConnectedMailbox = {
  readonly username: string;
  readonly password: string;
  readonly settings: EmailSettings;
};

const MAX_LIST = 25;
const MAX_BODY_CHARS = 12_000;
const STATUS_FRESH_MS = 60_000;
const SIGN_IN_REJECTED = "mailbox sign-in rejected — reconnect with /connect email";

export function createEmailPort(options: {
  credentials: CredentialStore;
  settings: SettingsStore;
  adapters?: EmailAdapters;
  /** Clankie's mail service, when this install can reach it (hosted body or signed-in account). */
  hosted?: HostedMailbox;
  now?: () => number;
}): EmailPort {
  const imap = createImapPort(options);
  const hosted = options.hosted === undefined ? undefined : createHostedPort(options.hosted, options);
  async function backend(): Promise<EmailPort> {
    const email = (await options.settings.load()).email;
    if (email.provider === "imap" || hosted === undefined) return imap;
    if (email.provider === "clankie") return hosted;
    // Unset: the owner's own server when one is configured, his Clankie address otherwise.
    if (email.imapHost !== undefined && email.username !== undefined) return imap;
    return (await options.hosted!.available()) ? hosted : imap;
  }
  return {
    status: async () => (await backend()).status(),
    disconnect: async () => (await backend()).disconnect(),
    list: async (input) => (await backend()).list(input),
    read: async (uid, folder) => (await backend()).read(uid, folder),
    search: async (query, input) => (await backend()).search(query, input),
    send: async (input) => (await backend()).send(input),
  };
}

function createHostedPort(
  mailbox: HostedMailbox,
  options: { settings: SettingsStore; now?: () => number },
): EmailPort {
  const now = options.now ?? Date.now;
  let observed:
    | { readonly address?: string; readonly status: MailboxStatus; readonly at: number }
    | undefined;

  function refuse(refusal: Parameters<typeof describeHostedRefusal>[0]): EmailRefusal {
    return { outcome: "refused", ...describeHostedRefusal(refusal) };
  }

  async function call<T extends { readonly ok: true; readonly address: string }>(
    schema: {
      safeParse(value: unknown): { success: true; data: T | HostedMailRefusal } | { success: false };
    },
    request: Parameters<HostedMailbox["request"]>[0],
  ): Promise<T | EmailRefusal> {
    let answer: unknown;
    try {
      answer = await mailbox.request(request);
    } catch (error) {
      return remember({
        outcome: "refused",
        reason: "provider_error",
        detail: `the mail service could not be reached (${error instanceof Error ? error.message : String(error)})`,
      });
    }
    const parsed = schema.safeParse(answer);
    if (!parsed.success)
      return remember({
        outcome: "refused",
        reason: "provider_error",
        detail: "the mail service answered unexpectedly",
      });
    const result = parsed.data;
    if (!result.ok) {
      const refusal = refuse(result);
      // A limit, a refused recipient or a missing message is about the request, not the mailbox.
      return result.refusal === "limit_reached" ||
        result.refusal === "recipient_suppressed" ||
        result.refusal === "not_found"
        ? refusal
        : remember(refusal);
    }
    observed = {
      address: result.address,
      status: { state: "connected", address: result.address, checkedAt: new Date(now()).toISOString() },
      at: now(),
    };
    await recordAddress(options.settings, result.address);
    return result;
  }

  function remember(refusal: EmailRefusal): EmailRefusal {
    const address = observed?.address;
    observed = {
      ...(address === undefined ? {} : { address }),
      status:
        refusal.reason === "not_configured"
          ? { state: "not_connected" }
          : {
              state: refusal.reason === "sign_in_rejected" ? "sign_in_rejected" : "unavailable",
              address: address ?? "",
              checkedAt: new Date(now()).toISOString(),
            },
      at: now(),
    };
    return refusal;
  }

  const folderOf = (input: string | undefined): "INBOX" | "Sent" | EmailRefusal =>
    hostedFolder(input?.trim() || "INBOX") ?? {
      outcome: "refused",
      reason: "provider_error",
      detail: "his Clankie mailbox has two folders: INBOX and Sent",
    };

  return {
    async status() {
      if (observed === undefined || now() - observed.at > STATUS_FRESH_MS)
        await call(hostedMailParsers.status, { op: "status" });
      return observed?.status ?? { state: "not_connected" };
    },
    async disconnect() {
      // The address belongs to the account; choosing IMAP is how an owner stops using it.
      await options.settings.update((current) => ({
        ...current,
        email: { ...current.email, provider: "imap" },
      }));
      observed = undefined;
    },
    async list(input = {}) {
      const folder = folderOf(input.folder);
      if (typeof folder !== "string") return folder;
      const result = await call(hostedMailParsers.list, {
        op: "list",
        folder,
        limit: clampLimit(input.limit),
      });
      return "outcome" in result ? result : { outcome: "ok", messages: result.messages.map(hostedHeader) };
    },
    async read(uid, folderInput) {
      const folder = folderOf(folderInput);
      if (typeof folder !== "string") return folder;
      const result = await call(hostedMailParsers.read, { op: "read", uid, folder });
      if ("outcome" in result)
        return result.detail === "no such message"
          ? { ...result, detail: `no message uid ${String(uid)}` }
          : result;
      const { text, ...header } = result.message;
      return {
        outcome: "ok",
        message: {
          ...hostedHeader(header),
          text: text.length <= MAX_BODY_CHARS ? text : `${text.slice(0, MAX_BODY_CHARS)}\n… truncated`,
        },
      };
    },
    async search(query, input = {}) {
      const folder = folderOf(input.folder);
      if (typeof folder !== "string") return folder;
      const result = await call(hostedMailParsers.search, {
        op: "search",
        query,
        folder,
        limit: clampLimit(input.limit),
      });
      return "outcome" in result ? result : { outcome: "ok", messages: result.messages.map(hostedHeader) };
    },
    async send(input) {
      const result = await call(hostedMailParsers.send, { op: "send", ...input });
      return "outcome" in result ? result : { outcome: "ok", messageId: result.messageId };
    },
  };
}

function hostedHeader(header: {
  uid: number;
  folder: string;
  from: string;
  to: string;
  subject: string;
  date?: string | undefined;
}): EmailHeader {
  const { date, ...rest } = header;
  return date === undefined ? rest : { ...rest, date };
}

/**
 * The service assigns his address; the captain prompt states it from settings
 * (ADR 0127), so the first answer that carries it writes it there once. An
 * address the owner set for an IMAP mailbox is never replaced.
 */
async function recordAddress(settings: SettingsStore, address: string): Promise<void> {
  const email = (await settings.load()).email;
  if (email.fromAddress === address) return;
  if (email.provider === "imap" || (email.provider === undefined && email.fromAddress !== undefined)) return;
  await settings.update((current) => ({
    ...current,
    email: { ...current.email, provider: "clankie", fromAddress: address },
  }));
}

function createImapPort(options: {
  credentials: CredentialStore;
  settings: SettingsStore;
  adapters?: EmailAdapters;
  now?: () => number;
}): EmailPort {
  const adapters = options.adapters ?? defaultEmailAdapters();
  const now = options.now ?? Date.now;
  let observed:
    | {
        readonly username: string;
        readonly ok: boolean;
        readonly reason?: EmailRefusalReason;
        readonly at: number;
      }
    | undefined;

  function observe<T>(account: ConnectedMailbox, result: T | EmailRefusal): T | EmailRefusal {
    const refusal =
      typeof result === "object" && result !== null && "outcome" in result && result.outcome === "refused"
        ? (result as EmailRefusal)
        : undefined;
    // A missing uid is the message, not the mailbox.
    if (refusal?.reason === "provider_error" && refusal.detail.startsWith("no message uid")) return result;
    observed = {
      username: account.username,
      ok: refusal === undefined,
      ...(refusal === undefined ? {} : { reason: refusal.reason }),
      at: now(),
    };
    return result;
  }

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
      return observe(account, refuseProvider(error));
    }
    try {
      return observe(account, await use(session, account));
    } catch (error) {
      return observe(account, refuseProvider(error));
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  return {
    async disconnect() {
      observed = undefined;
      await options.credentials.delete(EMAIL_PROVIDER_ID);
    },

    async status() {
      const account = await connected();
      if ("outcome" in account) return { state: "not_connected" };
      if (
        observed === undefined ||
        observed.username !== account.username ||
        now() - observed.at > STATUS_FRESH_MS
      ) {
        await withImap("INBOX", async () => ({ outcome: "ok" as const }));
      }
      const last = observed;
      const address = account.settings.fromAddress ?? account.username;
      if (last === undefined)
        return { state: "unavailable", address, checkedAt: new Date(now()).toISOString() };
      return {
        state: last.ok
          ? "connected"
          : last.reason === "sign_in_rejected"
            ? "sign_in_rejected"
            : "unavailable",
        address,
        checkedAt: new Date(last.at).toISOString(),
      };
    },

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
        return observe(account, { outcome: "ok" as const, messageId });
      } catch (error) {
        return observe(account, refuseProvider(error));
      }
    },
  };
}

function defaultEmailAdapters(): EmailAdapters {
  return {
    async openImap(account, folder) {
      const client = new ImapFlow({
        host: account.settings.imapHost ?? "",
        port: account.settings.imapPort,
        secure: account.settings.secure,
        auth: { user: account.username, pass: account.password },
        logger: false,
      });
      // ImapFlow emits socket timeouts and resets as 'error' events; with no
      // listener Node treats one as fatal and the whole service exits. The
      // pending command still rejects, so this read fails on its own.
      client.on("error", () => undefined);
      let lock: Awaited<ReturnType<typeof client.getMailboxLock>>;
      try {
        await client.connect();
        lock = await client.getMailboxLock(folder);
      } catch (error) {
        client.close();
        throw error;
      }
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
          // Who he is, not what he signed in as. The provider still has to
          // accept the alias — Gmail wants it verified under "Send mail as" —
          // and rewrites the header to the authenticated user when it does not.
          from: account.settings.fromAddress ?? account.username,
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

/**
 * ImapFlow reports every NO as "Command failed" and keeps what the server said
 * on the error; nodemailer marks a refused SMTP login `EAUTH`. Both name the
 * fix, so the refusal carries them. The server text is the provider's own
 * reply to the login, never the password it was sent.
 */
function refuseProvider(error: unknown): EmailRefusal {
  if (!(error instanceof Error))
    return { outcome: "refused", reason: "provider_error", detail: String(error) };
  const fields = error as Error & {
    authenticationFailed?: unknown;
    responseText?: unknown;
    serverResponseCode?: unknown;
    code?: unknown;
    response?: unknown;
  };
  const said =
    typeof fields.responseText === "string" && fields.responseText.trim().length > 0
      ? fields.responseText.trim()
      : fields.code === "EAUTH" && typeof fields.response === "string"
        ? fields.response.trim()
        : undefined;
  if (fields.authenticationFailed === true || fields.code === "EAUTH") {
    const code = typeof fields.serverResponseCode === "string" ? `[${fields.serverResponseCode}] ` : "";
    return {
      outcome: "refused",
      reason: "sign_in_rejected",
      detail: said === undefined ? SIGN_IN_REJECTED : `${SIGN_IN_REJECTED} (server: ${code}${said})`,
    };
  }
  return {
    outcome: "refused",
    reason: "provider_error",
    detail: said === undefined || error.message.includes(said) ? error.message : `${error.message}: ${said}`,
  };
}
