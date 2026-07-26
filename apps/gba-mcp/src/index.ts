import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bootGbaGame, defaultGbaBodyRootDir, createFreePlaySession } from "@clankie/gba-emulator";
import { PossessionLease, parsePossessionHolders } from "./possession.ts";
import { acquireBodyLock, type BodyLock } from "@clankie/gba-emulator";
import path from "node:path";
import { createRequire } from "node:module";
import { createGbaMcpServer } from "./server.ts";

export { createGbaMcpServer } from "./server.ts";
export * from "./tools.ts";
export * from "./possession.ts";
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
  const possession = new PossessionLease({
    allowedHolders: holders,
    onEvent: (event) => {
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

  const server = createGbaMcpServer(
    {
      io: session.io,
      framePng: () => game.framePng(),
      assertMayAct: (token) => {
        possession.assertMayAct(token);
      },
    },
    { possession },
  );
  // The body lock is reclaimed on liveness, so a crash cannot brick the body —
  // but releasing on a clean exit means the next process starts immediately
  // instead of waiting for a stale-holder check.
  const release = (): void => {
    bodyLock?.release();
    bodyLock = null;
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
