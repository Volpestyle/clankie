import {
  OperatorTerminalTailItemSchema,
  type OperatorConversationServiceRequest,
  type OperatorConversationServiceResult,
  type OperatorTerminalFrame,
} from "@clankie/protocol";
import { SessionRefusal, type Session, type SessionSource } from "./source.ts";
import { renderTerminalText } from "./terminal-text.ts";

// Herdr as a session source: the agents Clankie seats (and any other agent
// pane Herdr shows) on each machine. It speaks Clankie's operator ops, so the
// caller's own device check and allowlist apply: list is the fleet and the
// terminal catalog, read is a terminal tail, send is the agent's persona
// thread (which delivers into the native pane), open is a terminal focus.

const READ_SETTLE_MS = 400;
const READ_DEADLINE_MS = 8_000;

/** Clankie's operator boundary, already bound to the caller's credential. */
export interface HerdrSessionPort {
  /** One operator dispatch. Throws on a refusal. */
  dispatch(request: OperatorConversationServiceRequest): Promise<OperatorConversationServiceResult>;
  /** The terminal-tail NDJSON stream for one observation. */
  terminalTail(request: OperatorConversationServiceRequest, signal: AbortSignal): Promise<Response>;
  /** Turns a failed terminal-tail response into the caller's own refusal. */
  tailRefusal(response: Response): Promise<Error>;
}

export interface HerdrSessionSourceOptions {
  /** Names this client's tail and its sends, so they never mix with the app's. */
  readonly surfaceClientId: string;
  /** What a session on the local fleet reads as its machine. */
  readonly localMachine?: string;
}

export function createHerdrSessionSource(
  port: HerdrSessionPort,
  options: HerdrSessionSourceOptions,
): SessionSource {
  const localMachine = options.localMachine ?? "this Mac";
  return {
    id: "herdr",
    async list() {
      const [fleet, catalog] = await Promise.all([
        port.dispatch({ op: "fleet", schemaVersion: 1, view: "home" }),
        port
          .dispatch({ op: "terminal_catalog", schemaVersion: 1, includeSeatIds: true })
          .catch(() => undefined),
      ]);
      if (fleet.op !== "fleet") throw new Error("The fleet answered with something else.");
      const names = new Map(fleet.snapshot.personas.map((persona) => [persona.personaId, persona.name]));
      const sessions: Session[] = fleet.snapshot.seats.map((seat) => {
        const doing = seat.stance?.note ?? seat.summary;
        const name = names.get(seat.personaId);
        return {
          id: seat.seatId,
          source: "herdr",
          ...(name === undefined ? {} : { name }),
          harness: seat.harness,
          machine: seat.machine ?? seat.fleet ?? localMachine,
          ...(seat.workingDirectory === undefined
            ? {}
            : { project: lastSegment(seat.workingDirectory), workingDirectory: seat.workingDirectory }),
          status: seat.status,
          ...(seat.title.length === 0 ? {} : { title: seat.title }),
          ...(doing === undefined ? {} : { doing }),
          canMessage: true,
        };
      });
      const seated = new Set(sessions.map((session) => session.id));
      // A fleet's seats name the machine it is; its unseated panes say the same.
      const machines = new Map(
        fleet.snapshot.seats.flatMap((seat) =>
          seat.machine === undefined ? [] : [[seat.fleet ?? "default", seat.machine] as const],
        ),
      );
      // Agent panes Clankie hasn't seated (started by hand) can still be read.
      if (catalog?.op === "terminal_catalog")
        for (const terminal of catalog.sessions) {
          if (terminal.agent === undefined || seated.has(terminal.seatId ?? terminal.terminalId)) continue;
          const runtime = terminal.runtime?.id;
          sessions.push({
            id: terminal.terminalId,
            source: "herdr",
            harness: terminal.agent,
            machine:
              machines.get(runtime ?? "default") ??
              (runtime === undefined || runtime === "default" ? localMachine : runtime),
            ...(terminal.label.length === 0 ? {} : { title: terminal.label }),
            canMessage: false,
          });
        }
      return { sessions };
    },

    async read(id, lines) {
      const frames = await oneAtATime(`${options.surfaceClientId}\u0000${id}`, () =>
        tailScreen(port, id, options.surfaceClientId),
      );
      return { id, text: renderTerminalText(frames).split("\n").slice(-lines).join("\n") };
    },

    async send(id, message) {
      const fleet = await port.dispatch({ op: "fleet", schemaVersion: 1, view: "home" });
      if (fleet.op !== "fleet") throw new Error("The fleet answered with something else.");
      const seat = fleet.snapshot.seats.find((candidate) => candidate.seatId === id);
      if (seat === undefined)
        throw new SessionRefusal(
          "That agent isn't one Clankie seats, so it can't be messaged here. List the sessions and pick one that can be messaged.",
        );
      const name =
        fleet.snapshot.personas.find((persona) => persona.personaId === seat.personaId)?.name ?? seat.title;
      // Persona threads are created once and found again after; this is how the app opens a DM.
      const created = await port.dispatch({
        op: "create",
        schemaVersion: 1,
        scope: { kind: "persona", personaId: seat.personaId },
        title: name || "Agent",
      });
      if (created.op !== "create") throw new Error("Couldn't open the agent's thread.");
      let revision = created.conversation.revision;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const sent = await port.dispatch({
          op: "send",
          schemaVersion: 1,
          turn: {
            schemaVersion: 1,
            conversationId: created.conversation.conversationId,
            surfaceClientId: options.surfaceClientId,
            expectedRevision: revision,
            kind: "message",
            message,
          },
        });
        if (sent.op !== "send") throw new Error("The send answered with something else.");
        const result = sent.result;
        if (result.status === "revision_conflict") {
          revision = result.currentRevision;
          continue;
        }
        if (result.status === "accepted" && result.seatDelivery?.state === "queued")
          return {
            id,
            status: "queued",
            detail:
              result.seatDelivery.detail ??
              `${name} is busy, so the message is waiting in its queue and may not be read until its current work ends.`,
          };
        if (result.status === "accepted")
          return { id, status: "delivered", detail: `Sent to ${name}. Read the agent to see it respond.` };
        if (result.status === "seat_offline")
          return {
            id,
            status: "offline",
            detail: `${name} isn't running in a pane right now. Nothing was sent.`,
          };
        if (result.status === "seat_undelivered")
          return { id, status: "not_delivered", detail: `Nothing was sent: ${result.detail}` };
        return {
          id,
          status: "unconfirmed",
          detail: `The message may have reached ${name} but wasn't confirmed. Read the agent before sending it again.`,
        };
      }
      throw new SessionRefusal("The agent's thread kept changing. Try again.");
    },

    async open(id) {
      const focused = await port.dispatch({ op: "terminal_focus", schemaVersion: 1, terminalId: id });
      if (focused.op !== "terminal_focus") throw new Error("Herdr answered with something else.");
      return focused.status === "focused"
        ? { id, status: "opened", detail: "It's in front in Herdr on its machine." }
        : { id, status: "unavailable", detail: "Herdr couldn't bring that pane to the front." };
    },
  };
}

// Clankie keeps one observation per terminal and surface, and a new one
// replaces the last; two reads of the same pane by this surface take turns.
const reading = new Map<string, Promise<unknown>>();

async function oneAtATime<T>(key: string, read: () => Promise<T>): Promise<T> {
  const before = reading.get(key) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(read);
  reading.set(key, mine);
  try {
    return await mine;
  } finally {
    if (reading.get(key) === mine) reading.delete(key);
  }
}

/** The screen as it stands: the first full redraw, and the diffs a moment after it. */
async function tailScreen(
  port: HerdrSessionPort,
  terminalId: string,
  surfaceClientId: string,
): Promise<OperatorTerminalFrame[]> {
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), READ_DEADLINE_MS);
  const frames: OperatorTerminalFrame[] = [];
  let settle: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await port.terminalTail(
      {
        op: "terminal_tail",
        schemaVersion: 1,
        observation: { schemaVersion: 1, terminalId, surfaceClientId },
      },
      abort.signal,
    );
    if (!response.ok || response.body === null) throw await port.tailRefusal(response);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const settled = new Promise<void>((resolve) =>
      abort.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    const read = (async () => {
      let buffered = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffered += chunk.value;
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
          if (line.trim().length === 0) continue;
          const item = OperatorTerminalTailItemSchema.parse(JSON.parse(line));
          if (item.kind === "unavailable") throw new SessionRefusal(unavailableText(item.unavailable.reason));
          if (item.kind === "auth_failure") throw new SessionRefusal("This client can't read that pane.");
          if (item.kind === "reset") {
            frames.length = 0;
            continue;
          }
          // A later redraw keeps the history the first one carried; the renderer resets the screen.
          if (item.frame.full || frames.length > 0) frames.push(item.frame);
          // Counted from the first redraw, not the latest diff: a busy pane never goes quiet.
          if (frames.length > 0 && settle === undefined)
            settle = setTimeout(() => abort.abort(), READ_SETTLE_MS);
        }
      }
    })();
    await Promise.race([
      read.catch((error: unknown) => {
        if (!abort.signal.aborted) throw error;
      }),
      settled,
    ]);
  } catch (error) {
    if (!(abort.signal.aborted && frames.length > 0)) {
      if (abort.signal.aborted)
        throw new SessionRefusal("The pane didn't send its screen in time. Try again.");
      throw error;
    }
  } finally {
    clearTimeout(settle);
    clearTimeout(deadline);
    abort.abort();
  }
  if (frames.length === 0) throw new SessionRefusal("The pane didn't send its screen in time. Try again.");
  return frames;
}

function unavailableText(reason: string): string {
  if (reason === "terminal_unavailable") return "That pane isn't open any more. List the sessions again.";
  if (reason === "herdr_unavailable") return "Herdr isn't reachable on that machine right now.";
  return "The pane can't be read right now.";
}

function lastSegment(path: string): string {
  return (
    path
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .at(-1) ?? path
  );
}
