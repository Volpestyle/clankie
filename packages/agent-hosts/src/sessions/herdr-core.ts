import { HerdrCoreTerminalSchema } from "@clankie/protocol";
import { SessionRefusal, type Session, type SessionSource } from "./source.ts";
import type { HerdrSessionPort } from "./herdr.ts";

// herdr-core as a session source: the agents the Herdr desktop app runs, in
// its own terminal server beside the terminal Herdr. Clankie's service reads
// the core on its machine (`herdr_core_*` operator ops), so the caller's
// allowlist applies as it does for Herdr, and a read is bound to the live
// agent's own output as a Herdr pane's is (ADR 0307). Read-only: herdr-core's
// only way to message an agent is to paste into its terminal, which ADR 0207
// rules out, so send always refuses.

export interface HerdrCoreSessionSourceOptions {
  /** What a session on this Mac reads as its machine. */
  readonly localMachine?: string;
}

export function createHerdrCoreSessionSource(
  port: Pick<HerdrSessionPort, "dispatch">,
  options: HerdrCoreSessionSourceOptions = {},
): SessionSource {
  const localMachine = options.localMachine ?? "this Mac";
  return {
    id: "herdr-core",
    async list() {
      const listed = await port.dispatch({ op: "herdr_core_list", schemaVersion: 1 });
      if (listed.op !== "herdr_core_list") throw new Error("herdr-core answered with something else.");
      // No core running is an empty list, not a failure: most Macs won't have the app open.
      const sessions = listed.agents.map(
        (agent): Session => ({
          id: agent.terminal,
          source: "herdr-core",
          ...(agent.harness === undefined ? {} : { harness: agent.harness }),
          machine: agent.machine ?? localMachine,
          ...(agent.workingDirectory === undefined
            ? {}
            : { project: lastSegment(agent.workingDirectory), workingDirectory: agent.workingDirectory }),
          ...(agent.status === undefined ? {} : { status: agent.status }),
          ...(agent.title === undefined ? {} : { title: agent.title }),
          canMessage: false,
        }),
      );
      return { sessions };
    },

    async read(id, lines) {
      const read = await port.dispatch({ op: "herdr_core_read", schemaVersion: 1, terminal: terminalOf(id) });
      if (read.op !== "herdr_core_read") throw new Error("herdr-core answered with something else.");
      // The service decides what may be read (ADR 0307); its refusal is final.
      if (read.status !== "read")
        throw new SessionRefusal(
          `That agent can't be read right now: ${read.detail ?? "herdr-core didn't say why."}`,
        );
      return {
        id,
        text: (read.text ?? "").replace(/\n+$/u, "").split("\n").slice(-lines).join("\n"),
        // Only what the agent showed is read; say so when that left the screen out.
        ...(read.detail === undefined ? {} : { note: read.detail }),
      };
    },

    async send() {
      throw new SessionRefusal(
        "Agents in the Herdr desktop app can be read but not messaged from here: herdr-core can only type into their terminal. Nothing was sent.",
      );
    },

    async open(id) {
      const focused = await port.dispatch({
        op: "herdr_core_focus",
        schemaVersion: 1,
        terminal: terminalOf(id),
      });
      if (focused.op !== "herdr_core_focus") throw new Error("herdr-core answered with something else.");
      return focused.status === "focused"
        ? { id, status: "opened", detail: "It's in front in the Herdr app." }
        : { id, status: "unavailable", detail: focused.detail ?? "The Herdr app couldn't show that agent." };
    },
  };
}

/** A terminal address as the list gave it; anything else isn't one of these sessions. */
function terminalOf(id: string): string {
  if (!HerdrCoreTerminalSchema.safeParse(id).success)
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
