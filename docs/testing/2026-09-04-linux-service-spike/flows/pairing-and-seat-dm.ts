/**
 * AC3 driver: pair a device and complete one seat DM round trip against the
 * container, using the app's OWN pairing client
 * (clankie-app `apps/mobile/pairingSession.ts`) rather than a reimplementation.
 *
 * Self-contained on purpose. It pairs, sends, and then replays the conversation
 * until the run settles, so the reply is proved in one run with no follow-up
 * step and no bearer written to disk: the device token stays in memory and only
 * ever rides an Authorization header.
 *
 * Usage:
 *   tsx --tsconfig <alias tsconfig> pairing-and-seat-dm.ts \
 *     <offer.json> <pairingSession.ts> [controlPlane] [relay]
 *
 * The client module is passed in rather than imported by path, because
 * `flows/run-spike.sh` extracts it from a recorded clankie-app commit with
 * `git show`. The proof therefore runs against committed app code at a named
 * revision and never reads that repository's working tree, where another lane's
 * in-flight refactor may have moved or deleted the file.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const offer = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as { deepLink: string };
const clientModule = process.argv[3];
if (clientModule === undefined) throw new Error("pass the path to the app's pairingSession module");
const { createLivePairingSession } = (await import(pathToFileURL(clientModule).href)) as {
  createLivePairingSession: (options: {
    controlPlaneUrl: string;
    secureStore: unknown;
    deviceName: string;
    platform: string;
  }) => {
    connectFromPairingUrl(url: string): Promise<void>;
    confirmAccess(): Promise<void>;
    getSnapshot(): unknown;
    getCredential(): {
      deviceId: string;
      deviceToken: string;
      controlPlaneUrl: string;
      relayUrl?: string;
      grants: unknown;
      sessionExpiresAt: string;
    } | null;
  };
};
const CONTROL_PLANE = process.argv[4] ?? "http://127.0.0.1:14310";
const RELAY = process.argv[5] ?? "http://127.0.0.1:14321";
const MESSAGE = "Linux container spike: can you hear me?";
/** The run is settled or this fails; a spike must not hang waiting for a model. */
const SETTLE_TIMEOUT_MS = 60_000;

const memory = new Map<string, string>();
const secureStore = {
  getItemAsync: (key: string) => Promise.resolve(memory.get(key) ?? null),
  setItemAsync: (key: string, value: string) => {
    memory.set(key, value);
    return Promise.resolve();
  },
  deleteItemAsync: (key: string) => {
    memory.delete(key);
    return Promise.resolve();
  },
};

const step = (label: string, value: unknown): void =>
  console.log(`\n== ${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

interface ConversationEvent {
  readonly type: string;
  readonly cursor: string;
  readonly role?: string;
  readonly text?: string;
  readonly phase?: string;
  readonly runId?: string;
}

async function main(): Promise<void> {
  const session = createLivePairingSession({
    controlPlaneUrl: CONTROL_PLANE,
    secureStore,
    deviceName: "VUH-1053 spike client",
    platform: "macos",
  });

  await session.connectFromPairingUrl(offer.deepLink);
  step("1. connectFromPairingUrl -> snapshot", session.getSnapshot());

  await session.confirmAccess();
  step("2. confirmAccess -> snapshot", session.getSnapshot());

  const credential = session.getCredential();
  if (credential === null) throw new Error("no device credential after confirmAccess");
  step("3. device credential (token never printed or stored)", {
    deviceId: credential.deviceId,
    deviceToken: `<in memory, ${String(credential.deviceToken.length)} chars>`,
    controlPlaneUrl: credential.controlPlaneUrl,
    relayUrl: credential.relayUrl,
    grants: credential.grants,
    sessionExpiresAt: credential.sessionExpiresAt,
  });
  if (credential.relayUrl !== RELAY) {
    throw new Error(`advertised relayUrl ${String(credential.relayUrl)} is not the container's ${RELAY}`);
  }
  console.log("   -> the container's advertised relay origin reached the device unchanged");

  const post = async (path: string, body: unknown): Promise<Response> =>
    await fetch(new URL(path, credential.relayUrl ?? RELAY), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${credential.deviceToken}` },
      body: JSON.stringify(body),
    });

  const dispatch = async (path: string, body: unknown): Promise<{ status: number; json: unknown }> => {
    const response = await post(path, body);
    return { status: response.status, json: await response.json().catch(() => undefined) };
  };

  /**
   * The tail route is a long-lived NDJSON projection: it keeps the connection
   * open for the next change, so reading it to completion would never return.
   * Read for a bounded window, then abort and parse what arrived.
   */
  const tailFrames = async (body: unknown, windowMs = 3_000): Promise<Record<string, unknown>[]> => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), windowMs);
    let text = "";
    try {
      const response = await fetch(new URL("/operator/v1/tail", credential.relayUrl ?? RELAY), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${credential.deviceToken}` },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (!response.ok) throw new Error(`tail answered ${String(response.status)}`);
      const decoder = new TextDecoder();
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        text += decoder.decode(chunk, { stream: true });
      }
    } catch (error) {
      // An abort is how the read window ends; anything else is real.
      if (!(error instanceof Error) || error.name !== "AbortError") throw error;
    } finally {
      clearTimeout(timer);
    }
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  const listed = await dispatch("/operator/v1/dispatch", { op: "list", schemaVersion: 1 });
  step("4. relay dispatch op=list", listed);
  const target = (listed.json as { conversations?: { conversationId: string; revision: number }[] })
    .conversations?.[0];
  if (target === undefined) throw new Error("no conversation to send into");

  const sent = await dispatch("/operator/v1/dispatch", {
    op: "send",
    schemaVersion: 1,
    turn: {
      schemaVersion: 1,
      kind: "message",
      conversationId: target.conversationId,
      surfaceClientId: "vuh-1053-spike",
      expectedRevision: target.revision,
      message: MESSAGE,
    },
  });
  step("5. relay dispatch op=send (the seat DM)", sent);
  const accepted = (sent.json as { result?: { runId?: string } }).result;
  if (accepted?.runId === undefined) throw new Error("the send was not accepted");

  // Replay, never park: waitMs 0 answers immediately, so the flow polls on its
  // own clock and fails loudly instead of hanging if the run never settles.
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let events: ConversationEvent[] = [];
  let settled: ConversationEvent | undefined;
  while (Date.now() < deadline) {
    const frames = await tailFrames({
      op: "tail",
      schemaVersion: 1,
      tail: {
        schemaVersion: 1,
        conversationId: target.conversationId,
        surfaceClientId: "vuh-1053-spike",
        cursor: "000000000000",
        limit: 200,
        waitMs: 0,
      },
    });
    // Each NDJSON line is one `{ kind: "event", event }` frame.
    events = frames
      .filter((frame) => frame.kind === "event")
      .map((frame) => frame.event as ConversationEvent)
      .filter((event) => event.type === "message" || event.type === "turn");
    settled = events.find(
      (event) =>
        event.type === "turn" &&
        event.runId === accepted.runId &&
        (event.phase === "completed" || event.phase === "failed" || event.phase === "cancelled"),
    );
    if (settled !== undefined) break;
    await sleep(1_000);
  }
  if (settled === undefined)
    throw new Error(`run ${accepted.runId} did not settle in ${SETTLE_TIMEOUT_MS}ms`);

  step(
    "6. replayed conversation (op=tail, waitMs 0)",
    events.map((event) =>
      event.type === "message"
        ? `[message] ${String(event.role)}: ${String(event.text)}`
        : `[turn]    ${String(event.phase)}`,
    ),
  );

  const reply = events.filter((event) => event.type === "message" && event.role === "captain").at(-1);
  if (settled.phase !== "completed" || reply === undefined) {
    throw new Error(`run settled ${String(settled.phase)} with no captain reply`);
  }
  step("7. round trip complete", { runId: accepted.runId, reply: reply.text });
}

void main();
