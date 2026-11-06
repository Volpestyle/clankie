import { RexBlockSchema } from "@clankie/protocol";
import { SessionRefusal, type Session, type SessionSource } from "./source.ts";
import type { HerdrSessionPort } from "./herdr.ts";
import { screenLines } from "./terminal-text.ts";

// Rex (Superlogical, beta, macOS) as a session source (#963, ADR 0363): agents in the Rex
// server on Clankie's Mac, as the `rex_*` operator ops answer them, so the caller's own
// device check applies. List is the blocks with a live agent in them (a program reporting
// its status, not a shell in front); read is bound to that agent's own output (ADR 0307);
// send is one paste and Enter, refused while the agent waits on a prompt, and never retried
// as typing; keys and close are the ops' own. Open never brings Rex forward: Clankie never
// steals focus. A missing, stopped or unsupported Rex lists nothing; only an unsupported or
// remote one says why.

export interface RexSessionSourceOptions {
  /** What a session on this Mac reads as its machine. */
  readonly localMachine?: string;
}

/** Rex's own words onto Clankie's: idle, working, done, blocked; an error is blocked on the owner. */
const STATUS: Readonly<Record<string, string>> = {
  idle: "idle",
  working: "working",
  done: "done",
  blocked: "blocked",
  error: "blocked",
};

export function createRexSessionSource(
  port: Pick<HerdrSessionPort, "dispatch">,
  options: RexSessionSourceOptions = {},
): SessionSource {
  const localMachine = options.localMachine ?? "this Mac";
  return {
    id: "rex",
    async list() {
      const listed = await port.dispatch({ op: "rex_list", schemaVersion: 1 });
      if (listed.op !== "rex_list") throw new Error("Rex answered with something else.");
      // No Rex here, or none running, is an empty list: most Macs won't have it.
      const notices =
        listed.status === "unavailable" &&
        (listed.reason === "unsupported" || listed.reason === "remote") &&
        listed.detail !== undefined
          ? [`Rex agents aren't listed: ${listed.detail}`]
          : [];
      const sessions = listed.agents.map((agent): Session => {
        // An error is blocked on the owner; what it said, or that it errored, stays in `doing`.
        const doing =
          agent.doing ?? (agent.status === "error" ? "Reported an error and stopped." : undefined);
        return {
          id: agent.block,
          source: "rex",
          ...(agent.harness === undefined ? {} : { harness: agent.harness }),
          machine: localMachine,
          ...(agent.workingDirectory === undefined
            ? {}
            : { project: lastSegment(agent.workingDirectory), workingDirectory: agent.workingDirectory }),
          status: STATUS[agent.status] ?? agent.status,
          ...(agent.title === undefined ? {} : { title: agent.title }),
          ...(doing === undefined ? {} : { doing }),
          // A message goes in as a paste only while it isn't waiting on a prompt.
          canMessage: agent.status !== "blocked" && agent.status !== "error",
        };
      });
      return { sessions, ...(notices.length === 0 ? {} : { notices }) };
    },

    async read(id, lines) {
      const read = await port.dispatch({ op: "rex_read", schemaVersion: 1, block: blockOf(id) });
      if (read.op !== "rex_read") throw new Error("Rex answered with something else.");
      // The service decides what may be read (ADR 0307); its refusal is final.
      if (read.status !== "read")
        throw new SessionRefusal(
          `That agent can't be read right now: ${read.detail ?? "Rex didn't say why."}`,
        );
      return {
        id,
        text: screenLines(read.text ?? "", lines),
        ...(read.detail === undefined ? {} : { note: read.detail }),
      };
    },

    async send(id, message, images) {
      if (images !== undefined && images.length > 0)
        return {
          id,
          status: "not_delivered",
          detail: "Agents in Rex take text only from here; nothing was sent.",
        };
      const sent = await port.dispatch({
        op: "rex_send",
        schemaVersion: 1,
        block: blockOf(id),
        text: message,
      });
      if (sent.op !== "rex_send") throw new Error("Rex answered with something else.");
      return { id, status: sent.status, detail: sent.detail };
    },

    async press(id, keys) {
      const pressed = await port.dispatch({
        op: "rex_keys",
        schemaVersion: 1,
        block: blockOf(id),
        keys: [...keys],
      });
      if (pressed.op !== "rex_keys") throw new Error("Rex answered with something else.");
      return { id, status: pressed.result.outcome, detail: pressed.result.message };
    },

    async close(id) {
      const closed = await port.dispatch({ op: "rex_close", schemaVersion: 1, block: blockOf(id) });
      if (closed.op !== "rex_close") throw new Error("Rex answered with something else.");
      return { id, status: closed.status, detail: closed.detail };
    },

    async open(id) {
      blockOf(id);
      return {
        id,
        status: "unavailable",
        detail: "Clankie never brings Rex to the front. It's in Rex on this Mac; switch to it there.",
      };
    },
  };
}

/** A block id as the list gave it; anything else isn't one of these sessions. */
function blockOf(id: string): string {
  if (!RexBlockSchema.safeParse(id).success)
    throw new SessionRefusal(
      "That isn't a session id from the list. List the sessions and use one of those ids.",
    );
  return id;
}

function lastSegment(path: string): string {
  return (
    path
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .at(-1) ?? path
  );
}
