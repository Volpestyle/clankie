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
/** The Herdr Clankie ships (scripts/release/herdr.json); a linked machine needs at least this. */
const HERDR_MIN_VERSION = "0.9.3";
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
          .dispatch({ op: "terminal_catalog", schemaVersion: 1, includeSeatIds: true, includeMachines: true })
          // A service from before includeMachines refuses it; its catalog still lists hand-started agents.
          .catch(() => port.dispatch({ op: "terminal_catalog", schemaVersion: 1, includeSeatIds: true }))
          // allow-swallowed-rejection -- without a catalog the list still shows every seated agent.
          .catch(() => undefined),
      ]);
      if (fleet.op !== "fleet") throw new Error("The fleet answered with something else.");
      const names = new Map(fleet.snapshot.personas.map((persona) => [persona.personaId, persona.name]));
      const linked = new Map(
        (catalog?.op === "terminal_catalog" ? (catalog.machines ?? []) : []).map((machine) => [
          machine.id,
          machine,
        ]),
      );
      const sessions: Session[] = fleet.snapshot.seats.map((seat) => {
        // A machine that doesn't answer leaves only what Clankie last saw.
        const answering = seat.fleet === undefined || linked.get(seat.fleet)?.reachable !== false;
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
          status: answering ? seat.status : "unreachable",
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
      const notices = [...linked.values()].flatMap((machine) => {
        const name = machines.get(machine.id) ?? machine.id;
        if (!machine.reachable)
          return [
            `Herdr on ${name} isn't answering, so its agents show what Clankie last saw and can't be read.`,
          ];
        if (machine.herdrVersion !== undefined && olderVersion(machine.herdrVersion, HERDR_MIN_VERSION))
          return [
            `Herdr on ${name} is version ${machine.herdrVersion} and needs at least ${HERDR_MIN_VERSION}.`,
          ];
        return [];
      });
      // A linked machine with nothing running on it is still one Clankie reaches.
      const named = [
        ...new Set([
          ...sessions.map((session) => session.machine),
          ...[...linked.keys()].map((id) => machines.get(id) ?? id),
        ]),
      ];
      return { sessions, machines: named, ...(notices.length === 0 ? {} : { notices }) };
    },

    async read(id, lines) {
      // Herdr reads the screen itself on every machine Clankie reaches, ssh ones included.
      const read = await port
        .dispatch({ op: "terminal_read", schemaVersion: 1, terminalId: id })
        // allow-swallowed-rejection -- a service from before terminal_read refuses it; the tail below reads instead.
        .catch(() => undefined);
      if (read?.op === "terminal_read" && read.status === "read")
        return {
          id,
          text: trimScreen(read.text ?? "")
            .split("\n")
            .slice(-lines)
            .join("\n"),
        };
      // A service without terminal_read still streams this Mac's panes.
      try {
        const frames = await oneAtATime(`${options.surfaceClientId}\u0000${id}`, () =>
          tailScreen(port, id, options.surfaceClientId),
        );
        return { id, text: renderTerminalText(frames).split("\n").slice(-lines).join("\n") };
      } catch (error) {
        if (read?.op === "terminal_read" && read.detail !== undefined && error instanceof SessionRefusal)
          throw new SessionRefusal(`${error.message} (${read.detail})`);
        throw error;
      }
    },

    async start(request) {
      const result = await port.dispatch({
        op: "start_agent",
        schemaVersion: 1,
        ...(request.machine === undefined ? {} : { machine: request.machine }),
        ...(request.workingDirectory === undefined ? {} : { workingDirectory: request.workingDirectory }),
        ...(request.harness === undefined ? {} : { harness: request.harness }),
        ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
      });
      if (result.op !== "start_agent") throw new Error("Clankie answered with something else.");
      return {
        status: result.status,
        places: result.places,
        ...(result.seatId === undefined ? {} : { id: result.seatId }),
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      };
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

    async answer(id, answer) {
      const result = await port.dispatch({
        op: "prompt_answer",
        schemaVersion: 1,
        terminalId: id,
        expect: answer.expect,
        steps: [...answer.steps],
      });
      if (result.op !== "prompt_answer") throw new Error("Clankie answered with something else.");
      return { id, status: result.result.outcome, detail: result.result.message };
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

/** The screen without its trailing blank rows. */
function trimScreen(text: string): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+$/gmu, "")
    .replace(/\n+$/u, "");
}

/** Whether a Herdr version is older than another; an unreadable one is not called old. */
function olderVersion(version: string, minimum: string): boolean {
  const parts = (value: string) => /^v?(\d+)\.(\d+)\.(\d+)/u.exec(value)?.slice(1).map(Number);
  const have = parts(version);
  const need = parts(minimum)!;
  if (have === undefined) return false;
  for (let index = 0; index < 3; index += 1)
    if (have[index] !== need[index]) return have[index]! < need[index]!;
  return false;
}
