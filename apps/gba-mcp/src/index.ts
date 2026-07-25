import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bootGbaGame, createFreePlaySession } from "@clankie/gba-emulator";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createGbaMcpServer } from "./server.ts";

export { createGbaMcpServer } from "./server.ts";
export * from "./tools.ts";

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

  const session = await createFreePlaySession({
    rootDir: mkdtempSync(path.join(tmpdir(), "gba-mcp-")),
    scenario: game.scenario,
    fixtureSha256: game.fixtureSha256,
    ...(game.coreFactory === undefined ? {} : { coreFactory: game.coreFactory }),
  });

  const server = createGbaMcpServer({ io: session.io, framePng: () => game.framePng() });
  // stdout is the transport, so anything printed there corrupts the protocol.
  process.stderr.write(`clankie gba mcp ready (${game.real ? "real ROM" : "deterministic core double"})\n`);
  await server.connect(new StdioServerTransport());
}
