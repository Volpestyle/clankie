import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256 } from "../src/core-double.ts";
import { MgbaFireRedCore } from "../src/firered-core.ts";
import { RealGbaRouteScenarioSchema, runRealGbaScenario } from "../src/real-scenario.ts";
import { writeFramebufferPng } from "./png-writer.ts";

/**
 * ROM-gated real-core scenario run with captured evidence. Executes the
 * selected FireRed scenario TWICE against two freshly
 * instantiated cores and requires byte-identical report, decision trace, and
 * event trace. A runtime no-network tripwire wraps the entire run: any
 * fetch/socket/dns attempt fails the run. Artifacts (report, traces, semantic
 * events, screenshot PNG, receipt) are written to the receipt directory —
 * never into the repository, and never containing ROM or savestate bytes.
 *
 * By default this selects the repository's frozen bedroom route. Set
 * `CLANKIE_GBA_SCENARIO_PATH` to an operator-local, schema-valid scenario
 * whose goal is `trainer_battle_won` to prove party/bag menus, dialog, and a
 * state-derived trainer battle without storing ROM or savestate bytes.
 *
 * Usage:
 *   CLANKIE_GBA_ROM_PATH=… CLANKIE_GBA_SAVESTATE_PATH=… CLANKIE_GBA_RECEIPT_DIR=… \
 *     pnpm --filter @clankie/gba-emulator exec tsx scripts/run-real-scenario.ts
 */

// ── No-network tripwire: the emulation loop must perform ZERO network I/O. ──
let networkAttempts = 0;
const trap =
  (name: string) =>
  (..._args: unknown[]): never => {
    networkAttempts += 1;
    throw new Error(`NETWORK BLOCKED: ${name}`);
  };
(globalThis as { fetch: unknown }).fetch = trap("fetch");
const net = (await import("node:net")).default;
const dns = (await import("node:dns")).default;
(net.Socket.prototype as { connect: unknown }).connect = trap("net.Socket.connect");
(dns as unknown as { lookup: unknown }).lookup = trap("dns.lookup");

const romPath = process.env["CLANKIE_GBA_ROM_PATH"];
const savestatePath = process.env["CLANKIE_GBA_SAVESTATE_PATH"];
const receiptDir = process.env["CLANKIE_GBA_RECEIPT_DIR"];
const scenarioPath =
  process.env["CLANKIE_GBA_SCENARIO_PATH"] ??
  path.resolve(import.meta.dirname, "../fixtures/firered-bedroom-route/v1/scenario.json");
if (!romPath || !savestatePath || !receiptDir) {
  console.error("Set CLANKIE_GBA_ROM_PATH, CLANKIE_GBA_SAVESTATE_PATH, and CLANKIE_GBA_RECEIPT_DIR");
  process.exit(2);
}
mkdirSync(receiptDir, { recursive: true });

const fixtureBytes = readFileSync(scenarioPath);
const fixtureSha256 = sha256(fixtureBytes);
const scenario = RealGbaRouteScenarioSchema.parse(JSON.parse(fixtureBytes.toString("utf8")));
const romBytes = readFileSync(romPath);
const savestateBytes = readFileSync(savestatePath);

async function runOnce() {
  const core = await MgbaFireRedCore.create({
    coreId: scenario.coreId,
    romBytes,
    savestateBytes,
    romSha256: scenario.romSha256,
    savestateSha256: scenario.savestateSha256,
    coreWasmSha256: scenario.coreWasmSha256,
    mapId: scenario.map.mapId,
  });
  const rootDir = mkdtempSync(path.join(tmpdir(), "gba-real-run-"));
  const result = await runRealGbaScenario({
    rootDir,
    scenario,
    fixtureSha256,
    core,
    coreIdentity: core.identity(),
  });
  return { core, result };
}

const first = await runOnce();
const second = await runOnce();

const bytesOf = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const deterministic =
  bytesOf(first.result.report) === bytesOf(second.result.report) &&
  bytesOf(first.result.decisionTrace) === bytesOf(second.result.decisionTrace) &&
  bytesOf(first.result.trace) === bytesOf(second.result.trace);

const reportBytes = bytesOf(first.result.report);
const decisionBytes = bytesOf(first.result.decisionTrace);
const traceBytes = bytesOf(first.result.trace);
const semanticBytes = bytesOf(first.result.semanticEvents);
writeFileSync(path.join(receiptDir, "report.json"), reportBytes);
writeFileSync(path.join(receiptDir, "decisions.json"), decisionBytes);
writeFileSync(path.join(receiptDir, "events.json"), traceBytes);
writeFileSync(path.join(receiptDir, "semantic-events.json"), semanticBytes);
const screenshotPath = path.join(receiptDir, "final-frame.png");
writeFramebufferPng(first.core.framebufferSnapshot(), screenshotPath);

const receipt = {
  scenarioId: scenario.scenarioId,
  scenarioVersion: scenario.scenarioVersion,
  fixtureSha256,
  identity: first.core.identity(),
  result: first.result.report.result,
  halt: first.result.report.halt,
  checks: first.result.report.checks,
  finalState: first.result.report.finalState,
  determinism: {
    byteIdenticalReport: deterministic,
    reportSha256: sha256(reportBytes),
    decisionTraceSha256: sha256(decisionBytes),
    eventTraceSha256: sha256(traceBytes),
    secondRunReportSha256: sha256(bytesOf(second.result.report)),
  },
  noNetwork: { attempts: networkAttempts },
  artifacts: {
    reportSha256: sha256(reportBytes),
    decisionsSha256: sha256(decisionBytes),
    eventsSha256: sha256(traceBytes),
    semanticEventsSha256: sha256(semanticBytes),
    screenshotSha256: sha256(readFileSync(screenshotPath)),
  },
};
writeFileSync(path.join(receiptDir, "run-receipt.json"), bytesOf(receipt));
console.log(JSON.stringify(receipt, null, 2));

const passed = first.result.report.result === "passed" && deterministic && networkAttempts === 0;
process.exit(passed ? 0 : 1);
