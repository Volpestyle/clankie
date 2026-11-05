/**
 * Clankie's signed-in Chrome serves DevTools only on a pipe (#245). Any process
 * running as the owner can reach a remote debugging port, so the browser has no
 * port: this module holds the pipe and lends it to Clankie's own clients through
 * a loopback WebSocket whose path carries a token minted in memory. A token never
 * reaches argv, the environment or a file. A credential seal revokes every token
 * but the broker's, closing those clients and their sessions.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { WebSocketServer, type WebSocket } from "ws";
import { chromeExecutable } from "./browser-public-web.ts";

export interface PipedChrome {
  /** A new browser-level endpoint for one of Clankie's own clients. */
  mint(): string;
  /** Revoke every endpoint except `keep`: their clients and CDP sessions end before this resolves. */
  revokeExcept(keep: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

/** Methods no Clankie client uses that would outlive a revoked client or open a new way in. */
const DENIED = new Set(["Target.exposeDevToolsProtocol", "Tethering.bind", "Target.setRemoteLocations"]);

interface Client {
  socket: WebSocket;
  token: string;
  /** This client's own browser-target session; its child sessions end with it. */
  root?: string;
  sessions: Set<string>;
  queued: string[];
}
type CdpMessage = {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
};

/**
 * Chrome's own password manager and form autofill are off in this profile: the
 * broker types values for the owner, and Chrome must neither offer to save them
 * nor keep a username as a form suggestion.
 */
async function disableCredentialSaving(profileDir: string) {
  const directory = join(profileDir, "Default");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "Preferences");
  let prefs: Record<string, unknown> = {};
  try {
    prefs = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    // A missing or unreadable file is one Chrome would start over from anyway.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const section = (key: string) =>
    typeof prefs[key] === "object" && prefs[key] !== null ? (prefs[key] as Record<string, unknown>) : {};
  prefs.credentials_enable_service = false;
  prefs.profile = { ...section("profile"), password_manager_enabled: false };
  prefs.autofill = { ...section("autofill"), profile_enabled: false, credit_card_enabled: false };
  await writeFile(path, JSON.stringify(prefs), { mode: 0o600 });
}

export async function launchPipedChrome(options: {
  profileDir: string;
  headless: boolean;
  executablePath?: string | undefined;
}): Promise<PipedChrome> {
  const executable = await chromeExecutable(options.executablePath);
  await mkdir(options.profileDir, { recursive: true, mode: 0o700 });
  await disableCredentialSaving(options.profileDir);
  const child = spawn(
    executable,
    [
      `--user-data-dir=${options.profileDir}`,
      "--remote-debugging-pipe",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1440,900",
      ...(options.headless ? ["--headless=new"] : []),
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  const toChrome = child.stdio[3] as NodeJS.WritableStream;
  const fromChrome = child.stdio[4] as NodeJS.ReadableStream;
  let exited = false;
  const exit = new Promise<void>((resolve) =>
    child.once("exit", () => {
      exited = true;
      resolve();
    }),
  );
  let launchError: Error | undefined;
  child.on("error", (error) => {
    launchError = error;
  });

  const tokens = new Set<string>();
  const clients = new Set<Client>();
  const owners = new Map<string, Client>();
  const pending = new Map<
    number,
    | { client: Client; id: number; sessionId: string | undefined }
    | { resolve(result: Record<string, unknown>): void; reject(error: Error): void }
  >();
  let nextId = 0;
  const write = (message: CdpMessage) => toChrome.write(`${JSON.stringify(message)}\0`);
  const command = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (exited) return reject(new Error("Chrome exited"));
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      write({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    });
  const deliver = (client: Client, message: CdpMessage) => {
    if (client.socket.readyState === client.socket.OPEN) client.socket.send(JSON.stringify(message));
  };
  const adopt = (client: Client, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !clients.has(client)) return;
    client.sessions.add(sessionId);
    owners.set(sessionId, client);
  };
  /** End a client: its socket, then its browser session, which ends its child sessions in Chrome. */
  async function drop(client: Client) {
    if (!clients.delete(client)) return;
    client.socket.terminate();
    for (const sessionId of client.sessions) owners.delete(sessionId);
    for (const [id, entry] of pending) if ("client" in entry && entry.client === client) pending.delete(id);
    // allow-swallowed-rejection -- an exited Chrome has no sessions left to end.
    if (client.root) await command("Target.detachFromTarget", { sessionId: client.root }).catch(() => {});
  }

  let buffer = "";
  // A UTF-8 character can straddle two reads.
  const decoder = new StringDecoder("utf8");
  fromChrome.on("data", (bytes: Buffer) => {
    buffer += decoder.write(bytes);
    for (let end = buffer.indexOf("\0"); end >= 0; end = buffer.indexOf("\0")) {
      const message = JSON.parse(buffer.slice(0, end)) as CdpMessage;
      buffer = buffer.slice(end + 1);
      if (message.id !== undefined) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (!entry) continue;
        if (!("client" in entry)) {
          if (message.error) entry.reject(new Error(`CDP ${JSON.stringify(message.error)}`));
          else entry.resolve(message.result ?? {});
          continue;
        }
        adopt(entry.client, message.result?.sessionId);
        const reply: CdpMessage = { ...message, id: entry.id };
        if (entry.sessionId === undefined) delete reply.sessionId;
        else reply.sessionId = entry.sessionId;
        deliver(entry.client, reply);
        continue;
      }
      const client = message.sessionId === undefined ? undefined : owners.get(message.sessionId);
      if (!client) {
        // A root event: a client's browser session ending under it ends the client.
        if (message.method === "Target.detachedFromTarget") {
          const gone = owners.get(String(message.params?.sessionId));
          if (gone && gone.root === message.params?.sessionId) void drop(gone);
        }
        continue;
      }
      if (message.method === "Target.attachedToTarget") adopt(client, message.params?.sessionId);
      if (message.method === "Target.detachedFromTarget") {
        const sessionId = String(message.params?.sessionId);
        client.sessions.delete(sessionId);
        owners.delete(sessionId);
      }
      const event = { ...message };
      if (event.sessionId === client.root) delete event.sessionId;
      deliver(client, event);
    }
  });
  void exit.then(() => {
    for (const entry of pending.values()) if (!("client" in entry)) entry.reject(new Error("Chrome exited"));
    pending.clear();
    for (const client of clients) client.socket.terminate();
    clients.clear();
    owners.clear();
  });

  function relay(client: Client, raw: string) {
    let message: CdpMessage;
    try {
      message = JSON.parse(raw) as CdpMessage;
    } catch {
      return void drop(client);
    }
    if (typeof message.id !== "number" || typeof message.method !== "string") return void drop(client);
    const sessionId = message.sessionId ?? client.root!;
    const id = message.id;
    const refuse = (text: string) =>
      deliver(client, {
        id,
        error: { code: -32000, message: text },
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      });
    if (!client.sessions.has(sessionId)) return refuse("Session with given id not found.");
    if (DENIED.has(message.method)) return refuse(`${message.method} is not available in Clankie's browser.`);
    const relayed = ++nextId;
    pending.set(relayed, { client, id, sessionId: message.sessionId });
    write({ ...message, id: relayed, sessionId });
  }

  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    verifyClient: ({ req }: { req: IncomingMessage }) => {
      const port = (server.address() as AddressInfo).port;
      const token = /^\/devtools\/browser\/([0-9a-f]{64})$/u.exec(req.url ?? "")?.[1];
      // A web page sends an Origin; a rebound DNS name sends another Host.
      return (
        token !== undefined &&
        tokens.has(token) &&
        req.headers.origin === undefined &&
        req.headers.host === `127.0.0.1:${port}`
      );
    },
  });
  server.on("connection", (socket, req) => {
    const token = /([0-9a-f]{64})$/u.exec(req.url ?? "")![1]!;
    const client: Client = { socket, token, sessions: new Set(), queued: [] };
    clients.add(client);
    socket.on("message", (data) => {
      const raw = String(data);
      if (client.root) relay(client, raw);
      else client.queued.push(raw);
    });
    socket.on("close", () => void drop(client));
    void command("Target.attachToBrowserTarget").then(
      ({ sessionId }) => {
        client.root = String(sessionId);
        // Dropped or revoked while attaching: the new session ends unused.
        if (!clients.has(client))
          // allow-swallowed-rejection -- an exited Chrome has no session left to end.
          return void command("Target.detachFromTarget", { sessionId: client.root }).catch(() => {});
        adopt(client, client.root);
        if (!tokens.has(token)) return void drop(client);
        for (const raw of client.queued.splice(0)) relay(client, raw);
      },
      () => void drop(client),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      for (const client of clients) client.socket.terminate();
      tokens.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!exited) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
        await exit;
        clearTimeout(timer);
      }
    })());
  try {
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (launchError) throw launchError;
      if (exited) throw new Error("Chrome exited before serving DevTools on its pipe.");
      const ready = await Promise.race([
        command("Browser.getVersion").then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
      ]);
      if (ready) break;
      if (Date.now() > deadline) throw new Error("Chrome did not serve DevTools within 15000 ms.");
    }
  } catch (error) {
    await close();
    throw error;
  }
  const port = (server.address() as AddressInfo).port;
  return {
    mint() {
      const token = randomBytes(32).toString("hex");
      tokens.add(token);
      return `ws://127.0.0.1:${port}/devtools/browser/${token}`;
    },
    async revokeExcept(keep) {
      const kept = new Set(keep.map((endpoint) => endpoint.slice(endpoint.lastIndexOf("/") + 1)));
      for (const token of tokens) if (!kept.has(token)) tokens.delete(token);
      await Promise.all([...clients].filter((client) => !kept.has(client.token)).map(drop));
    },
    close,
  };
}
