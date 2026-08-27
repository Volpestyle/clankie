import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { MgbaCoreIdentity } from "./mgba-core.ts";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const IdentitySchema = z
  .object({
    romSha256: Sha256Schema,
    savestateSha256: Sha256Schema,
    coreWasmSha256: Sha256Schema,
  })
  .strict();
const CheckSchema = z
  .object({
    identityVerified: z.boolean(),
    targetLocationReached: z.boolean(),
    partyMenuObserved: z.boolean(),
    inventoryMenuObserved: z.boolean(),
    trainerBattleWon: z.boolean(),
    decisionsStateDerived: z.boolean(),
    authoritativeStateCertain: z.boolean(),
    evidenceBounded: z.boolean(),
    inputsWithinBounds: z.boolean(),
  })
  .strict();
const ArtifactHashesSchema = z
  .object({
    reportSha256: Sha256Schema,
    decisionsSha256: Sha256Schema,
    eventsSha256: Sha256Schema,
    semanticEventsSha256: Sha256Schema,
    screenshotSha256: Sha256Schema,
  })
  .strict();
const FireRedLiveReceiptSchema = z
  .object({
    scenarioId: z.literal("firered-oaks-lab-rival"),
    scenarioVersion: z.literal(1),
    fixtureSha256: Sha256Schema,
    identity: IdentitySchema,
    result: z.enum(["passed", "failed"]),
    halt: z.string().min(1).max(64),
    checks: CheckSchema,
    finalState: z
      .object({
        position: z
          .object({
            mapId: z.string().min(1).max(128),
            x: z.number().int(),
            y: z.number().int(),
          })
          .strict(),
        facing: z.enum(["north", "south", "east", "west"]),
        frame: z.number().int().nonnegative(),
        inputCount: z.number().int().nonnegative(),
        battleResult: z.string().min(1).max(64),
      })
      .strict(),
    determinism: z
      .object({
        byteIdenticalReport: z.boolean(),
        reportSha256: Sha256Schema,
        decisionTraceSha256: Sha256Schema,
        eventTraceSha256: Sha256Schema,
        secondRunReportSha256: Sha256Schema,
      })
      .strict(),
    noNetwork: z.object({ attempts: z.number().int().nonnegative() }).strict(),
    artifacts: ArtifactHashesSchema,
  })
  .strict();

export interface FireRedLiveProofReport {
  readonly schemaVersion: 1;
  readonly passed: boolean;
  readonly checks: readonly { readonly name: string; readonly ok: boolean }[];
  readonly identity: MgbaCoreIdentity & {
    readonly scenarioId: "firered-oaks-lab-rival";
    readonly fixtureSha256: string;
  };
}

const ARTIFACTS = {
  reportSha256: "report.json",
  decisionsSha256: "decisions.json",
  eventsSha256: "events.json",
  semanticEventsSha256: "semantic-events.json",
  screenshotSha256: "final-frame.png",
} as const;

/** Verifies the content-free receipt and recomputes every referenced artifact hash. */
export async function evaluateFireRedLiveReceipt(path: string): Promise<FireRedLiveProofReport> {
  const receiptBytes = await readRegularFile(path, 256 * 1024);
  const receipt = FireRedLiveReceiptSchema.parse(JSON.parse(receiptBytes.toString("utf8")));
  const artifactChecks = await Promise.all(
    Object.entries(ARTIFACTS).map(async ([hashField, name]) => {
      const bytes = await readRegularFile(join(dirname(path), name), 20 * 1024 * 1024);
      return {
        name: `artifact ${name}`,
        ok: sha256(bytes) === receipt.artifacts[hashField as keyof typeof ARTIFACTS],
      };
    }),
  );
  const checks = [
    { name: "scenario passed", ok: receipt.result === "passed" && receipt.halt === "battle_won" },
    { name: "all gameplay checks", ok: Object.values(receipt.checks).every(Boolean) },
    {
      name: "two fresh cores deterministic",
      ok:
        receipt.determinism.byteIdenticalReport &&
        receipt.determinism.reportSha256 === receipt.determinism.secondRunReportSha256 &&
        receipt.determinism.reportSha256 === receipt.artifacts.reportSha256 &&
        receipt.determinism.decisionTraceSha256 === receipt.artifacts.decisionsSha256 &&
        receipt.determinism.eventTraceSha256 === receipt.artifacts.eventsSha256,
    },
    { name: "no network", ok: receipt.noNetwork.attempts === 0 },
    ...artifactChecks,
  ];
  return {
    schemaVersion: 1,
    passed: checks.every((check) => check.ok),
    checks,
    identity: {
      scenarioId: receipt.scenarioId,
      fixtureSha256: receipt.fixtureSha256,
      ...receipt.identity,
    },
  };
}

async function readRegularFile(path: string, maximumBytes: number): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`FireRed live evidence must be a regular file: ${path}`);
  }
  if (metadata.size === 0 || metadata.size > maximumBytes) {
    throw new Error(`FireRed live evidence has an invalid size: ${path}`);
  }
  return readFile(path);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
