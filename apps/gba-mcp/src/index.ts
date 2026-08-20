import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  bootGbaGame,
  createFreePlaySession,
  listGbaCheckpoints,
  readGbaCheckpoint,
  writeGbaCheckpoint,
  type GbaCheckpointReceipt,
  type GbaCheckpointSummary,
} from "@clankie/gba-emulator";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGbaMcpServer } from "./server.ts";

const HARNESS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function checkpointNamespace(harnessId: string | undefined): string {
  if (harnessId === undefined) {
    throw new Error("GBA_MCP_HARNESS_ID is required when GBA_MCP_CHECKPOINT_DIR is set");
  }
  if (!HARNESS_ID_PATTERN.test(harnessId)) {
    throw new Error("GBA_MCP_HARNESS_ID must be 1-64 ASCII letters, digits, dots, underscores, or hyphens");
  }
  return `gba-mcp-${createHash("sha256").update(harnessId).digest("hex")}`;
}

export interface GbaMcpHarness {
  server: ReturnType<typeof createGbaMcpServer>;
  runtimeParent: string;
  checkpointDir: string;
  sessionId: string;
  close: () => Promise<void>;
  forceCleanup: () => void;
}

export async function createGbaMcpHarness(
  env: NodeJS.ProcessEnv = process.env,
  temporaryRoot = tmpdir(),
  bootGame: typeof bootGbaGame = bootGbaGame,
): Promise<GbaMcpHarness> {
  const runtimeParent = await mkdtemp(path.join(temporaryRoot, "gba-mcp-"));
  let openedSession: Awaited<ReturnType<typeof createFreePlaySession>> | undefined;
  try {
    const require = createRequire(import.meta.url);
    const emulatorPackage = path.dirname(require.resolve("@clankie/gba-emulator/package.json"));
    const repoRoot = path.resolve(emulatorPackage, "../..");
    const configured = (name: string): string | undefined => {
      const value = env[name];
      return value === undefined || value.length === 0 ? undefined : value;
    };
    const romPath = configured("GBA_MCP_ROM_PATH");
    const savestatePath = configured("GBA_MCP_SAVESTATE_PATH");
    const scenarioPath = configured("GBA_MCP_SCENARIO_PATH");
    const checkpointRoot = configured("GBA_MCP_CHECKPOINT_DIR");
    const checkpointDir =
      checkpointRoot === undefined
        ? path.join(runtimeParent, "checkpoints")
        : path.join(checkpointRoot, checkpointNamespace(configured("GBA_MCP_HARNESS_ID")));
    const game = await bootGame({
      env: {},
      discoverDefaultPaths: false,
      ...(romPath === undefined ? {} : { romPath }),
      ...(savestatePath === undefined ? {} : { savestatePath }),
      ...(scenarioPath === undefined ? {} : { scenarioPath }),
      fixturesDir: path.join(emulatorPackage, "fixtures"),
      doubleScenarioPath: path.join(
        repoRoot,
        "scenarios/emulator/verdant-path-trainer-battle/v1/scenario.json",
      ),
    });
    const session = await createFreePlaySession({
      rootDir: runtimeParent,
      characterId: "gba-mcp-harness",
      holderId: "gba-mcp-harness",
      scenario: game.scenario,
      fixtureSha256: game.fixtureSha256,
      ...(game.coreFactory === undefined ? {} : { coreFactory: game.coreFactory }),
    });
    openedSession = session;
    await mkdir(checkpointDir, { recursive: true, mode: 0o700 });
    const summarize = (receipt: GbaCheckpointReceipt): GbaCheckpointSummary => ({
      checkpointId: receipt.checkpointId,
      label: receipt.label,
      capturedAt: receipt.capturedAt,
      position: receipt.position,
    });
    const currentPosition = (): { mapId: string; x: number; y: number } | null => {
      try {
        const observation = session.io.observe("overworld");
        return observation.kind === "overworld" ? observation.data.position : null;
      } catch {
        return null;
      }
    };
    const checkpoints = game.checkpoints;
    const server = createGbaMcpServer({
      io: session.io,
      framePng: (anchor) => game.framePng(undefined, anchor),
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
              session.resetAfterStateLoad();
              return summarize(read.receipt);
            },
            listCheckpoints: () => listGbaCheckpoints(checkpointDir).map(summarize),
          }),
    });
    let closePromise: Promise<void> | undefined;
    const forceCleanup = (): void => rmSync(runtimeParent, { recursive: true, force: true });
    return {
      server,
      runtimeParent,
      checkpointDir,
      sessionId: session.sessionId,
      forceCleanup,
      close: () =>
        (closePromise ??= (async () => {
          try {
            await server.close();
          } finally {
            try {
              await session.close();
            } finally {
              await rm(runtimeParent, { recursive: true, force: true });
            }
          }
        })()),
    };
  } catch (error) {
    try {
      await openedSession?.close();
    } finally {
      await rm(runtimeParent, { recursive: true, force: true });
    }
    throw error;
  }
}

async function runStdio(): Promise<void> {
  const harness = await createGbaMcpHarness();
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (exitCode?: number): Promise<void> => {
    shutdownPromise ??= harness.close();
    if (exitCode !== undefined) {
      const fallback = setTimeout(() => {
        harness.forceCleanup();
        process.exit(exitCode);
      }, 5_000);
      fallback.unref();
      void shutdownPromise.finally(() => {
        clearTimeout(fallback);
        process.exit(exitCode);
      });
    }
    return shutdownPromise;
  };
  process.once("exit", harness.forceCleanup);
  process.once("SIGINT", () => void shutdown(130));
  process.once("SIGTERM", () => void shutdown(143));
  process.stdin.once("end", () => void shutdown());

  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = resolve;
  });
  try {
    await harness.server.connect(transport);
    process.stderr.write(`gba emulator harness ready (${harness.sessionId})\n`);
    await closed;
  } finally {
    await shutdown();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runStdio().catch((error: unknown) => {
    process.stderr.write(
      `gba emulator harness failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
