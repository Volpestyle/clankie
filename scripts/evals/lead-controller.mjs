/** Explicit manual controller composition; importing does not dispatch or discover credentials. */
import { join } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import {
  createEvalResources,
  createEvalSettings,
} from "../../apps/clankie/src/captain/eval-session-boundary.ts";
import { assertLeadAccountObserver, observerCredential } from "./lead-account-observer.mjs";
import { assertLeadAdmission } from "./lead-admission.mjs";
import { createContainedCodingTools } from "./lead-coding-tools.mjs";
import { assertNativeFleet } from "./lead-native-runtime.mjs";
import { createLeadTransport } from "./lead-provider-transport.mjs";
import { createLeadModelRuntime } from "./lead-model-runtime.mjs";
const { convertResponsesTools } = await import(
  new URL(
    "../../apps/clankie/node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js",
    import.meta.url,
  ).href
);

export async function createLeadController({
  container,
  observer,
  observers,
  admission,
  leadAllocation,
  modelId,
  workerFleet,
  resources,
  summariesPath,
}) {
  assertLeadAdmission(admission, { container });
  assertNativeFleet(workerFleet, { container, admission });
  assertLeadAccountObserver(observer);
  const sources = [...observers];
  admission.assertObservers(sources);
  for (const source of sources) {
    assertLeadAccountObserver(source);
    source.assertReady();
  }
  const ids = sources.map((source) => source.evidence().accountId);
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== admission.accounts.length ||
    admission.accounts.some((id) => !ids.includes(id)) ||
    !sources.includes(observer)
  )
    throw Error("Every distinct selected account requires its ready controller observer");
  if (
    observer.evidence().accountId !== leadAllocation.accountId ||
    observer.evidence().containerId !== container.id ||
    sources.some((source) => source.evidence().containerId !== container.id)
  )
    throw Error("Lead observer account/container mismatch");
  if (
    leadAllocation.hostCwd !== join(container.root, "tasks", "lead") ||
    leadAllocation.containerCwd !== "/eval/tasks/lead" ||
    realpathSync(leadAllocation.hostCwd) !== leadAllocation.hostCwd ||
    !lstatSync(join(leadAllocation.hostCwd, ".git")).isDirectory() ||
    lstatSync(join(leadAllocation.hostCwd, ".git")).isSymbolicLink()
  )
    throw Error("Independent exact lead repository required");
  if (
    !workerFleet?.captainOptions?.nativeLaunchPolicy ||
    !workerFleet.captainOptions.nativeHerdrRunner ||
    workerFleet.slots.some(
      ({ allocation }) =>
        allocation.hostCwd === leadAllocation.hostCwd || !ids.includes(allocation.accountId),
    )
  )
    throw Error("Isolated preallocated native fleet required");
  const expectedSummaries = join(container.root, "control", "lead-summaries.json");
  if (summariesPath !== undefined && summariesPath !== expectedSummaries)
    throw Error("Protected native summaries mapping required");
  const stop = (reason) => admission.close(reason);
  const current = () => {
    admission.assertCurrent();
    for (const source of sources) source.assertReady();
  };
  const admit = async () => {
    await admission.admit();
    current();
  };
  const selectedCredential = () => observerCredential(observer);
  const tools = createContainedCodingTools({
    container,
    cwd: leadAllocation.containerCwd,
    hostCwd: leadAllocation.hostCwd,
    admit,
  });
  const transport = createLeadTransport({
    model: modelId,
    effort: "medium",
    accountId: leadAllocation.accountId,
    selectedCredential,
    admit,
    assertCurrent: current,
    signal: container.signal,
    stop,
  });
  const runtime = await createLeadModelRuntime({ modelId, selectedCredential, transport, admit });
  const snapshot = structuredClone(resources);
  createEvalResources(snapshot);
  await admit();
  const nativeCensusRunner = async (command, args) => {
    if (command !== "herdr" || !['["agent","list"]', '["api","snapshot"]'].includes(JSON.stringify(args)))
      throw Error("Unscoped census command refused");
    const stdout = await container.exec([
      "/usr/bin/env",
      "-i",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "HOME=/eval/control/home",
      "HERDR_SOCKET_PATH=/eval/control/herdr.sock",
      "herdr",
      ...args,
    ]);
    return { stdout, stderr: "" };
  };
  const captainOptions = {
    ...workerFleet.captainOptions,
    nativeCensusRunner,
    nativeSummariesPath: expectedSummaries,
    evalSessionBoundary: {
      runtime,
      resources(cwd) {
        if (cwd !== leadAllocation.hostCwd) throw Error("Unallocated resource workspace");
        return createEvalResources(snapshot);
      },
      settings: createEvalSettings,
      tools({ cwd, systemTools, authored }) {
        if (cwd !== leadAllocation.hostCwd || !systemTools) throw Error("Unallocated lead tool context");
        const names = ["hire_agent", "message_seat", "herdr_watch"];
        const selected = names.map((name) => {
          const matches = authored.filter((tool) => tool.name === name);
          if (matches.length !== 1) throw Error(`Missing exact native tool ${name}`);
          return matches[0];
        });
        const definitions = [...tools, ...selected];
        transport.bindTools(
          convertResponsesTools(definitions, {
            strict: null,
            supportsStrictMode: true,
            supportsOpenAIGrammarTools: false,
          }),
        );
        return { tools: definitions.map((tool) => tool.name), customTools: definitions };
      },
    },
  };
  return Object.freeze({
    captainOptions,
    signal: container.signal,
    close: () => stop("manual lead controller closed"),
    evidence: () => {
      const provider = transport.result(),
        workers = workerFleet.slots.map(({ runtime }) => runtime.evidence());
      const complete =
        provider.usageComplete && workers.every((worker) => !worker.started || worker.ledger.complete);
      const perAccount = {};
      if (complete) {
        for (const event of provider.events)
          if (event.type === "usage")
            perAccount[event.accountId] = (perAccount[event.accountId] ?? 0) + event.usage.total_tokens;
        for (const worker of workers)
          if (worker.started)
            for (const [id, tokens] of Object.entries(worker.ledger.perAccount))
              perAccount[id] = (perAccount[id] ?? 0) + tokens;
      }
      return {
        admission: admission.evidence(),
        accounts: sources.map((source) => source.evidence()),
        provider,
        workers,
        usage: {
          complete,
          perAccount: complete ? perAccount : null,
          totalTokens: complete ? Object.values(perAccount).reduce((sum, tokens) => sum + tokens, 0) : null,
        },
        limitations: [
          "Owner TTY edits/interventions are not measured",
          "Never-started worker allocations are identified separately from started workers with missing counters",
        ],
      };
    },
  });
}
