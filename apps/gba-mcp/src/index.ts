import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RenderedSurfaceOverlaySchema } from "@clankie/interactive-environment";
import {
  bootGbaGame,
  defaultGbaBodyRootDir,
  defaultGbaCheckpointDir,
  createFreePlaySession,
  listGbaCheckpoints,
  readGbaCheckpoint,
  writeGbaCheckpoint,
  type GbaCheckpointReceipt,
} from "@clankie/gba-emulator";
import { PossessionLease, parsePossessionHolders } from "./possession.ts";
import { createPossessionEventLog } from "./possession-log.ts";
import { acquireBodyLock, type BodyLock } from "@clankie/gba-emulator";
import type { GbaCheckpointSummary } from "./tools.ts";
import { createBrokeredActivityFrameSink } from "@clankie/rendered-surface-client";
import { createBrokeredPossessorVoiceClient } from "@clankie/possessor-voice";
import { createHash } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { createGbaMcpServer } from "./server.ts";

export { createGbaMcpServer } from "./server.ts";
export * from "./tools.ts";
export * from "./possession.ts";
export * from "./possession-log.ts";
export * from "./speech.ts";

/**
 * stdio entrypoint, which is what a coding harness attaches to.
 *
 * ROM-gated exactly like the free-play CLI, through the same loader: with a ROM
 * and savestate this is the real game behind the pinned core; without them it is
 * the deterministic double, so the tools are explorable with no copyrighted
 * bytes.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const require = createRequire(import.meta.url);
  const emulatorPackage = path.dirname(require.resolve("@clankie/gba-emulator/package.json"));
  const repoRoot = path.resolve(emulatorPackage, "../..");

  const game = await bootGbaGame({
    fixturesDir: path.join(emulatorPackage, "fixtures"),
    doubleScenarioPath: path.join(
      repoRoot,
      "scenarios/emulator/verdant-path-trainer-battle/v1/scenario.json",
    ),
  });

  const bodyRoot = defaultGbaBodyRootDir();
  const session = await createFreePlaySession({
    rootDir: bodyRoot,
    holderId: "gba-mcp",
    scenario: game.scenario,
    fixtureSha256: game.fixtureSha256,
    // Starting this server is not driving the body. Clients launch stdio
    // servers freely — `claude mcp list`, every session, every retry — so
    // locking at startup means the first one wins and the rest fail to
    // connect at all. The lock is taken when someone possesses him, below.
    acquireBody: false,
    ...(game.coreFactory === undefined ? {} : { coreFactory: game.coreFactory }),
  });

  // Deny-by-default: unset means possession is unavailable and only observation
  // works. A possessor is its own principal class, never the ambient or voice
  // tier (ADR 0050's precedent for adding a tier).
  const holders = parsePossessionHolders(process.env["CLANKIE_GBA_POSSESSION_HOLDERS"]);
  // Possession is what takes the body, so possession is what takes the lock.
  // Observation needs neither (ADR 0053), which is what lets several servers
  // coexist while only one of them can ever drive.
  let bodyLock: BodyLock | null = null;
  // Durable beside body.lock, because this process's stderr dies with the
  // harness that launched it. Best-effort: recording observes the lease, it
  // never gates it.
  const possessionLog = createPossessionEventLog({
    rootDir: bodyRoot,
    onError: (error) => {
      process.stderr.write(`possession event log append failed: ${String(error)}\n`);
    },
  });
  const possession = new PossessionLease({
    allowedHolders: holders,
    onEvent: (event) => {
      possessionLog.append(event);
      process.stderr.write(
        `possession ${event.type}: ${event.holderId}${event.reason === undefined ? "" : ` (${event.reason})`}\n`,
      );
    },
    onHeldChange: (held) => {
      if (held && bodyLock === null) {
        // Throws BodyBusyError if another process is driving. Refusing here is
        // right: it refuses the possession, not the server's existence.
        const holderId = possession.current()?.holderId ?? "unknown";
        bodyLock = acquireBodyLock({ rootDir: bodyRoot, holderId: `gba-mcp:${holderId}` });
      } else if (!held && bodyLock !== null) {
        bodyLock.release();
        bodyLock = null;
      }
    },
  });

  // So a person can watch an agent play. Without this the only viewer of an
  // MCP-driven session is the agent itself, because `gba_emulator_observe`
  // returns the frame to the caller and nowhere else. Optional and best-effort:
  // no activity server running means no sink, and play continues unwatched
  // rather than failing.
  const sink = await createBrokeredActivityFrameSink({
    url: process.env["CLANKIE_ACTIVITY_PRODUCER_URL"] ?? "ws://127.0.0.1:4322/producer",
  });
  if (sink === undefined) {
    process.stderr.write("no activity producer credential; nobody can watch this session\n");
  }

  // So a possessor can commentate what it is playing. Optional and best-effort
  // for the same reason the sink is: no bridge, no voice, and the tools refuse
  // with a reason rather than the server failing to start.
  const possessorVoiceUrl = process.env["CLANKIE_POSSESSOR_VOICE_URL"];
  const voice = await createBrokeredPossessorVoiceClient(
    possessorVoiceUrl === undefined ? {} : { url: possessorVoiceUrl },
  );
  if (voice === undefined) {
    process.stderr.write("no possessor voice credential; he plays without commentating\n");
  }
  let sequence = 0;
  // Watch the action as it happens, at hardware speed. Publishing only after an
  // action made the character teleport a tile; pacing keeps the emulator from
  // finishing the whole step in a few milliseconds and then freezing.
  const smooth = process.env["CLANKIE_GBA_SMOOTH"] !== "0";
  const publish = (): void => {
    if (sink === undefined) return;
    const png = game.framePng();
    if (png === null) return;
    sequence += 1;
    const bytes = Buffer.from(png);
    sink.publishFrame({
      schemaVersion: 1,
      surface: "gba_emulator",
      sequence,
      frame: sequence,
      width: 240 * 3,
      height: 160 * 3,
      encoding: "png",
      data: bytes.toString("base64"),
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      capturedAt: new Date().toISOString(),
    });
  };

  if (sink !== undefined && smooth) {
    game.observeFrames(
      () => {
        publish();
      },
      { pace: true },
    );
  }

  // The sidebar beside the canvas. Same shared sequence as the frames, same
  // bounded-text rules as the resident mind's turns (ADR 0049).
  const publishThought = (monologue: string): void => {
    if (sink === undefined) return;
    sequence += 1;
    sink.publishOverlay(
      RenderedSurfaceOverlaySchema.parse({
        schemaVersion: 1,
        surface: "gba_emulator",
        sequence,
        objective: null,
        intent: null,
        monologue: monologue.slice(0, 256),
        effect: null,
        updatedAt: new Date().toISOString(),
      }),
    );
  };

  // Progress that outlives this process: minted checkpoints, never a mutation
  // of the pinned identity (ADR 0060). Absent on the deterministic double.
  const checkpoints = game.checkpoints;
  const checkpointDir = defaultGbaCheckpointDir();
  const currentPosition = (): { mapId: string; x: number; y: number } | null => {
    try {
      const observed = session.io.observe("overworld") as {
        data?: { position?: { mapId: string; x: number; y: number } };
      };
      return observed.data?.position ?? null;
    } catch {
      return null;
    }
  };
  const summarize = (receipt: GbaCheckpointReceipt): GbaCheckpointSummary => ({
    checkpointId: receipt.checkpointId,
    label: receipt.label,
    capturedAt: receipt.capturedAt,
    position: receipt.position,
  });

  const server = createGbaMcpServer(
    {
      io: session.io,
      framePng: () => {
        // Every observation is also a chance to refresh what a watcher sees.
        publish();
        return game.framePng();
      },
      assertMayAct: (token) => {
        possession.assertMayAct(token);
        // Publish after the action lands, so the viewer shows the result.
        queueMicrotask(publish);
      },
      publishThought,
      ...(checkpoints === undefined
        ? {}
        : {
            saveCheckpoint: (label: string | undefined) =>
              summarize(
                writeGbaCheckpoint({
                  rootDir: checkpointDir,
                  capability: checkpoints,
                  position: currentPosition(),
                  label,
                }).receipt,
              ),
            loadCheckpoint: (checkpointId: string) => {
              const read = readGbaCheckpoint({
                rootDir: checkpointDir,
                checkpointId,
                identity: checkpoints.identity,
              });
              checkpoints.loadState(read.savestateBytes);
              // The screen changed out from under every watcher too.
              queueMicrotask(publish);
              return summarize(read.receipt);
            },
            listCheckpoints: () => listGbaCheckpoints(checkpointDir).map(summarize),
          }),
    },
    {
      possession,
      // Speaking and hearing are the bridge's to grant (ADR 0064): a possessor
      // holds no gateway, so it reports to the process that does and lets the
      // persona compose the words. Absent credential or absent bridge means
      // both stay denied with a reason, and play continues in silence.
      ...(voice === undefined ? {} : { speech: voice, hearing: voice }),
    },
  );
  // The body lock is reclaimed on liveness, so a crash cannot brick the body —
  // but releasing on a clean exit means the next process starts immediately
  // instead of waiting for a stale-holder check.
  const release = (): void => {
    bodyLock?.release();
    bodyLock = null;
    sink?.close();
    voice?.close();
    session.close();
  };
  process.once("exit", release);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      release();
      process.exit(0);
    });
  }

  // stdout is the transport, so anything printed there corrupts the protocol.
  process.stderr.write(`clankie gba mcp ready (${game.real ? "real ROM" : "deterministic core double"})\n`);
  await server.connect(new StdioServerTransport());
}
