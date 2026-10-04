import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ComputerInventorySchema,
  ComputerReceiptSchema,
  ComputerScreenshotSchema,
} from "../../../packages/interactive-environment/src/computer.ts";

// Explicit fixture bookkeeping and independent grading; no UI, model or computer API calls.
if (process.env.CI) throw new Error("Windows native fixture checks are explicit and excluded from CI");
const source = fileURLToPath(new URL(".", import.meta.url));
const frozenHash = "8d44789376f0333f2fd53c703cb9d661b28be4555448c35afd280013e8bf9e35";
const manifestBytes = await readFile(join(source, "manifest.json"));
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
if (digest(manifestBytes) !== frozenHash) throw new Error("Frozen Windows fixture manifest changed");
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const [verb, rawDirectory, caseId, receiptPath] = process.argv.slice(2);
if (!rawDirectory)
  throw new Error("Usage: check.ts prepare|checkpoint|receipt|grade DIRECTORY [W1..W8] [RECEIPT_JSON]");
const directory = resolve(rawDirectory);
async function json(name: string): Promise<any> {
  const bytes = await readFile(join(directory, name));
  if (bytes.length > 2 * 1024 * 1024) throw new Error("Fixture evidence exceeds 2 MiB");
  return JSON.parse(bytes.toString("utf8"));
}
async function save(name: string, value: unknown) {
  await writeFile(join(directory, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
if (verb === "prepare") {
  await mkdir(directory, { mode: 0o700 });
  for (const name of ["Fixture.cs", "build.ps1", "manifest.json"])
    await copyFile(join(source, name), join(directory, name));
  await save("fixture.json", {
    schemaVersion: 1,
    manifestSha256: frozenHash,
    fixtureSourceSha256: digest(await readFile(join(source, "Fixture.cs"))),
  });
  process.stdout.write(JSON.stringify({ directory, launchesApp: false }) + "\n");
} else {
  const prepared = await json("fixture.json");
  if (
    prepared.manifestSha256 !== frozenHash ||
    digest(await readFile(join(directory, "manifest.json"))) !== frozenHash ||
    digest(await readFile(join(directory, "Fixture.cs"))) !== prepared.fixtureSourceSha256
  )
    throw new Error("Wrong fixture revision");
  if (verb === "checkpoint" || verb === "receipt") {
    if (!manifest.cases.some((entry: { id: string }) => entry.id === caseId))
      throw new Error("Unknown fixed case");
    if (verb === "checkpoint") await save(`${caseId}.state.json`, await json("state.json"));
    else {
      if (!receiptPath) throw new Error("Use the actual computer endpoint's receipt file");
      const receipt = ComputerReceiptSchema.parse(JSON.parse(await readFile(resolve(receiptPath), "utf8")));
      if (!receipt.bodyId.startsWith("windows:")) throw new Error("Not a Windows computer receipt");
      await save(`${caseId}.receipt.json`, receipt);
    }
  } else if (verb === "grade") {
    const cases: { id: string; outcome: "passed" | "failed" | "unavailable"; detail: string }[] = [];
    const requestIds = new Set<string>();
    let observedBodyId: string | undefined;
    for (const { id } of manifest.cases) {
      try {
        let passed = false;
        if (id === "W1") {
          const inventory = ComputerInventorySchema.parse(await json("W1.inventory.json"));
          const metadata = ComputerScreenshotSchema.parse(await json("W1.screenshot.json"));
          const png = await readFile(join(directory, "W1.png"));
          observedBodyId = inventory.bodyId;
          passed =
            metadata.bodyId.startsWith("windows:") &&
            inventory.bodyId === metadata.bodyId &&
            inventory.windows.some(
              (window) =>
                window.appId === metadata.target.appId &&
                window.windowId === metadata.target.windowId &&
                window.title === manifest.title,
            ) &&
            png.length >= 24 &&
            png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" &&
            png.readUInt32BE(16) === metadata.width &&
            png.readUInt32BE(20) === metadata.height &&
            digest(png) === metadata.sha256;
        } else {
          const state = await json(`${id}.state.json`);
          if (state.schemaVersion !== 1 || state.title !== manifest.title || !Array.isArray(state.events))
            throw new Error("Wrong native fixture state");
          if (id === "W8") {
            const before = await json("W8.before.state.json");
            const revoked = await json("W8.revocation.json");
            const refused = await json("W8.refusal.json");
            const status = await json("W8.status.json");
            passed =
              revoked.outcome === "revoked" &&
              refused.status === 409 &&
              refused.body?.error === "computer_request_refused" &&
              status.bodyId === observedBodyId &&
              status.lease?.state === "recovery_required" &&
              JSON.stringify(before) === JSON.stringify(state);
          } else {
            const receipt = ComputerReceiptSchema.parse(await json(`${id}.receipt.json`));
            passed =
              receipt.bodyId === observedBodyId &&
              !requestIds.has(receipt.requestId) &&
              receipt.outcome === "confirmed" &&
              receipt.inputs.length > 0 &&
              receipt.inputs.every((input) => input.outcome === "confirmed");
            requestIds.add(receipt.requestId);
            if (id === "W2")
              passed &&=
                state.text === manifest.text &&
                state.events.some((event: any) => event.kind === "text" && event.value === manifest.text);
            if (id === "W3")
              passed &&=
                state.focused === "apply" &&
                state.events.some((event: any) => event.kind === "focus" && event.value === "apply");
            if (id === "W4")
              passed &&=
                state.applies === 1 &&
                state.applied === manifest.text &&
                state.events.filter((event: any) => event.kind === "apply").length === 1;
            if (id === "W5")
              passed &&=
                state.scroll > 0 &&
                state.events.some((event: any) => event.kind === "scroll" && event.value > 0);
            if (id === "W6")
              passed &&=
                JSON.stringify(state.order) === JSON.stringify(["gamma", "alpha", "beta"]) &&
                state.events.some((event: any) => event.kind === "drag");
            if (id === "W7") {
              const inventory = ComputerInventorySchema.parse(await json("W7.inventory.json"));
              const rejected = await json("W7.refusal.json");
              passed &&=
                state.secondary === 1 &&
                inventory.windows.some((window) => window.title === "Clankie Windows Fixture secondary") &&
                rejected.status === 409;
            }
          }
        }
        cases.push({
          id,
          outcome: passed ? "passed" : "failed",
          detail: passed
            ? "real fixture state and host evidence agree"
            : "fixture state or host evidence does not establish success",
        });
      } catch (error) {
        cases.push({
          id,
          outcome: "unavailable",
          detail: error instanceof Error ? error.message : "missing proof",
        });
      }
    }
    const result = { fixture: manifest.fixture, manifestSha256: frozenHash, cases, releaseProved: false };
    await save("grade.json", result);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (cases.some((entry) => entry.outcome !== "passed")) process.exitCode = 1;
  } else throw new Error("Unknown explicit fixture command");
}
