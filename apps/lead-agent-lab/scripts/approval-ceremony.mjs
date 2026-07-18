/**
 * VUH-698 approval ceremony drill.
 *
 * Boots the real control plane and the pull runner (sim workers) on ephemeral
 * loopback ports with fully isolated state, drives a minimal faithful mission
 * (implementation -> independent verification) to success, then — acting as
 * the lead — requests the final simulated merge as a privileged action. The
 * `github.pr.merge` policy requires human approval, so the request lands as a
 * durable pending approval in the control plane's approval store.
 *
 * Modes:
 *   (default)                interactive ceremony: prints console-attach
 *                            instructions and stays running until the operator
 *                            decides in the `/approvals` inbox.
 *   --auto-decide reject     scripted smoke: denies with a reason through the
 *                            same authenticated operator path the console uses,
 *                            then proves the denial reason returns to the lead.
 *   --auto-decide approve    scripted smoke: approves, then proves the policy
 *                            engine releases the simulated merge connector only
 *                            after the recorded human approval.
 *
 * The doctrine profile is derived at runtime from the frozen
 * doctrine/profiles/self-build-lab.yaml: the only change is an explicit
 * `github.pr.merge` release rule (allow once minHumanApprovals >= 1 and checks
 * passed), mirroring the canonical rule shape in
 * apps/control-plane/test/approvals.test.ts. Nothing under doctrine/ is
 * modified; the derived profile lives in the drill's temporary runtime.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ClankieApiClient } from "@clankie/api-client";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import { SqliteEventStore } from "@clankie/event-store";
import { ActionRequestSchema } from "@clankie/protocol";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const RETRY_IMPLEMENTATION = `export function retry(operation, maxAttempts) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return operation(attempt);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
`;

const MERGE_RELEASE_RULE = {
  id: "human-approved-merge",
  effect: "allow",
  when: { minHumanApprovals: 1, checksPassed: true },
  reason: "A recorded human approval releases the simulated merge connector.",
};

function parseArguments(argv) {
  const options = { mode: "interactive", timeoutMs: 180_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--auto-decide") {
      const value = argv[index + 1];
      if (value !== "reject" && value !== "approve") {
        throw new Error("--auto-decide requires 'reject' or 'approve'");
      }
      options.mode = value;
      index += 1;
    } else if (argument === "--timeout-ms") {
      options.timeoutMs = Number(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  const envTimeout = process.env.CLANKIE_CEREMONY_TIMEOUT_MS;
  if (envTimeout) options.timeoutMs = Number(envTimeout);
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("timeout must be a positive number of milliseconds");
  }
  return options;
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function reservePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolvePromise(port));
      } else {
        rejectPromise(new Error("failed to reserve an ephemeral loopback port"));
      }
    });
  });
}

function baseProcessEnvironment(source) {
  const keys = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TERM",
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "PNPM_HOME",
    "COREPACK_HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
  ];
  const environment = {};
  for (const key of keys) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return environment;
}

/**
 * Pre-existing environment gap, not a runner defect introduced here: the
 * `@xterm/headless` and `@xterm/addon-serialize` packages publish CJS mains
 * without an `exports` map, so `pnpm --filter @clankie/runner start` fails on
 * current Node (`SyntaxError: ... does not provide an export named 'Terminal'`)
 * before any runner code executes. Both packages also ship untouched `.mjs`
 * builds, so the drill injects a scoped resolver hook (NODE_OPTIONS --import)
 * that redirects exactly these two bare specifiers to their ESM builds. The
 * runner source is not modified.
 */
async function writeXtermEsmHooks(root) {
  const hooksPath = join(root, "xterm-esm-hooks.mjs");
  await writeFile(
    hooksPath,
    `import { registerHooks } from "node:module";
const REDIRECTS = new Map([
  ["@xterm/headless", "@xterm/headless/lib-headless/xterm-headless.mjs"],
  ["@xterm/addon-serialize", "@xterm/addon-serialize/lib/addon-serialize.mjs"],
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(REDIRECTS.get(specifier) ?? specifier, context);
  },
});
`,
    "utf8",
  );
  return hooksPath;
}

async function createRuntimeLayout() {
  const root = await mkdtemp(join(tmpdir(), "clankie-approval-ceremony-"));
  const layout = {
    root,
    fixtureRepo: join(root, "fixture"),
    worktreeRoot: join(root, "worktrees"),
    runnerState: join(root, "runner-state"),
    runnerArtifacts: join(root, "runner-artifacts"),
    eventStore: join(root, "control-plane", "events.db"),
    memoryStore: join(root, "control-plane", "memory.db"),
    doctrineProfile: join(root, "approval-ceremony-profile.yaml"),
    credentialsFile: join(root, "operator-credentials.json"),
  };
  await Promise.all([
    mkdir(layout.fixtureRepo, { recursive: true }),
    mkdir(layout.worktreeRoot, { recursive: true }),
    mkdir(layout.runnerState, { recursive: true }),
    mkdir(layout.runnerArtifacts, { recursive: true }),
    mkdir(join(root, "control-plane"), { recursive: true }),
  ]);
  return layout;
}

/**
 * Derives the drill doctrine from the frozen self-build-lab profile. The single
 * change is the explicit merge release rule; the base profile bytes under
 * doctrine/ are read, never written.
 */
async function deriveCeremonyDoctrine(layout) {
  const basePath = join(repoRoot, "doctrine/profiles/self-build-lab.yaml");
  const profile = parseYaml(await readFile(basePath, "utf8"));
  profile.id = "approval-ceremony-drill";
  profile.description =
    "VUH-698 approval-ceremony drill profile derived from self-build-lab; adds the human-approved merge release rule.";
  profile.actions["github.pr.merge"] = {
    default: "require_approval",
    rules: [MERGE_RELEASE_RULE],
  };
  await writeFile(layout.doctrineProfile, stringifyYaml(profile), "utf8");
  const compiled = compileDoctrine([await loadDoctrineFile(layout.doctrineProfile)]);
  return { path: layout.doctrineProfile, profileHash: compiled.profileHash };
}

async function createFixtureRepo(destination) {
  const git = (args) => execFileAsync("git", args, { cwd: destination });
  await writeFile(
    join(destination, "README.md"),
    "# Approval ceremony fixture\n\nMinimal candidate repository for the VUH-698 merge-approval drill.\n",
    "utf8",
  );
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "approval-ceremony@clankie.local"]);
  await git(["config", "user.name", "Clankie Approval Ceremony Drill"]);
  await git(["add", "."]);
  await git(["commit", "-m", "Freeze approval ceremony fixture"]);
  return (await git(["rev-parse", "HEAD"])).stdout.trim();
}

function startManagedProcess(spec, secrets) {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.environment,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const rawOutput = [];
  child.stdout?.on("data", (chunk) => rawOutput.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk) => rawOutput.push(chunk.toString("utf8")));
  const managed = {
    spec,
    process: child,
    stopped: false,
    failure: undefined,
    redactedOutput: () => {
      let output = rawOutput.join("");
      for (const secret of secrets) output = output.replaceAll(secret, "[redacted]");
      return output;
    },
    exit: new Promise((resolveExit) => {
      child.once("error", (error) => {
        managed.failure = error;
      });
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    }),
  };
  return managed;
}

function signalProcess(child, signal) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // The process group is already gone.
  }
}

async function stopManagedProcess(managed) {
  if (managed.stopped) return;
  managed.stopped = true;
  if (managed.process.exitCode !== null || managed.process.signalCode !== null) {
    await managed.exit.catch(() => undefined);
    return;
  }
  signalProcess(managed.process, "SIGTERM");
  const exited = await Promise.race([
    managed.exit.then(() => true).catch(() => true),
    delay(5_000).then(() => false),
  ]);
  if (!exited) {
    signalProcess(managed.process, "SIGKILL");
    await managed.exit.catch(() => undefined);
  }
}

function assertProcessesAlive(processes) {
  for (const managed of processes) {
    if (managed.failure) throw new Error(`${managed.spec.name} failed to start: ${managed.failure.message}`);
    if (!managed.stopped && managed.process.exitCode !== null) {
      throw new Error(
        `${managed.spec.name} exited early (code ${managed.process.exitCode}):\n${tail(managed.redactedOutput())}`,
      );
    }
  }
}

function tail(text, lines = 40) {
  return text.split("\n").slice(-lines).join("\n");
}

async function waitForControlPlane(baseUrl, processes, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    assertProcessesAlive(processes);
    try {
      const response = await fetch(new URL("/health", baseUrl), { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The control plane is still starting.
    }
    await delay(100);
  }
  throw new Error("control_plane_start_timeout");
}

async function waitForMission(client, missionId, predicate, processes, timeoutMs) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    assertProcessesAlive(processes);
    last = await client.getMission(missionId);
    if (predicate(last)) return last;
    if (last.state === "failed") {
      throw new Error(`mission failed before the merge boundary:\n${JSON.stringify(last.tasks, null, 2)}`);
    }
    await delay(250);
  }
  throw new Error(`mission_wait_timeout (last state: ${last?.state ?? "unknown"})`);
}

function buildCeremonyPlan(missionId, profileHash) {
  return {
    missionId,
    goal: "Land the retry helper and reach the human merge-approval boundary.",
    rationale:
      "A minimal faithful mission: a sim implementer lands the change, an independent sim verifier confirms it, then the lead requests the simulated merge as a privileged action.",
    successCriteria: [
      "The sim implementer creates src/retry.mjs inside its declared write scope.",
      "The independent read-only verifier passes the trusted fixture check.",
      "The merge action does not execute until a human approval record exists.",
    ],
    assumptions: ["Sim workers execute scripted behavior; no provider credentials are involved."],
    risks: ["None beyond the isolated temporary runtime."],
    humanDecisionsRequired: ["Approve or reject the final simulated merge in the console."],
    plannedActions: [],
    profileHash,
    tasks: [
      {
        id: "implement-retry",
        title: "Implement the retry helper",
        objective: "Create src/retry.mjs with the bounded retry helper.",
        kind: "implementation",
        role: "implementer",
        executionClass: "runner_visible",
        writeScope: ["src/retry.mjs"],
        successCriteria: ["src/retry.mjs contains the bounded retry helper."],
        evidenceRequirements: ["Runner-authored Git diff and sim session identity."],
        metadata: { sim: { files: { "src/retry.mjs": RETRY_IMPLEMENTATION } } },
      },
      {
        id: "verify-retry",
        title: "Independently verify the retry helper",
        objective:
          "Inspect the candidate without modifying it; the trusted runner check confirms src/retry.mjs exists and is defect-free.",
        kind: "verification",
        role: "verifier",
        dependsOn: ["implement-retry"],
        executionClass: "runner_visible",
        writeScope: [],
        successCriteria: ["The trusted ceremony fixture check passes."],
        evidenceRequirements: ["Runner test_report and read-only Git evidence."],
        metadata: {},
      },
    ],
  };
}

function buildMergeRequest(missionId, profileHash, runToken) {
  return ActionRequestSchema.parse({
    id: `merge-${runToken}`,
    principal: { kind: "captain", id: "captain-main", role: "lead" },
    action: "github.pr.merge",
    resource: {
      type: "pull_request",
      id: "approval-ceremony-fixture",
      repository: "clankie/approval-ceremony-fixture",
    },
    context: {
      missionId,
      risk: "medium",
      checksPassed: true,
      humanApprovals: 0,
      changedLines: RETRY_IMPLEMENTATION.split("\n").length,
      changedPaths: ["src/retry.mjs"],
      profileHash,
    },
  });
}

function logSection(title) {
  console.log(`\n=== ${title} ===`);
}

function describeDecision(decision) {
  return `effect=${decision.effect} matchedPolicyIds=${JSON.stringify(decision.matchedPolicyIds)} reason=${JSON.stringify(decision.reason)}`;
}

async function waitForOperatorDecision(client, approvalId, processes) {
  for (;;) {
    assertProcessesAlive(processes);
    for (const status of ["approved", "denied"]) {
      const records = await client.listApprovals(status);
      const record = records.find((candidate) => candidate.id === approvalId);
      if (record) return record;
    }
    await delay(2_000);
  }
}

/** Prints the audit evidence the lead cites: identity, timestamp, doctrine hash. */
async function printAuditEvidence(eventStorePath, approvalId, profileHash) {
  const store = new SqliteEventStore(eventStorePath);
  try {
    const chain = await store.verify();
    if (!chain.valid) throw new Error(chain.error ?? "event chain verification failed");
    const stored = await store.readAll();
    const approvalEvents = stored
      .map((entry) => ({ hash: entry.hash, sequence: entry.sequence, ...entry.event }))
      .filter(
        (event) =>
          (event.type === "approval.requested" || event.type === "approval.decided") &&
          event.data?.approval?.id === approvalId,
      );
    logSection("Audit evidence (hash-chained event store)");
    console.log(`event store: ${eventStorePath} (chain verified: ${chain.count} events)`);
    console.log(`approval events for ${approvalId}: ${approvalEvents.length}`);
    for (const event of approvalEvents) {
      const approval = event.data.approval;
      console.log(`\n  event type:      ${event.type} (sequence ${event.sequence}, chain hash ${event.hash.slice(0, 12)}…)`);
      console.log(`  event id:        ${event.id}`);
      console.log(`  occurredAt:      ${event.occurredAt}  <- event timestamp`);
      console.log(`  missionId:       ${event.missionId}`);
      console.log(`  correlationId:   ${event.correlationId}`);
      console.log(`  profileHash:     ${event.profileHash}  <- doctrine hash`);
      console.log(`  approval.status: ${approval.status}`);
      if (approval.decidedBy) {
        console.log(`  decidedBy:       ${approval.decidedBy}  <- approval identity`);
        console.log(`  decidedAt:       ${approval.decidedAt}  <- decision timestamp`);
        console.log(`  reason:          ${JSON.stringify(approval.reason)}`);
      }
    }
    const decided = approvalEvents.find((event) => event.type === "approval.decided");
    const requested = approvalEvents.find((event) => event.type === "approval.requested");
    if (!requested) throw new Error("audit log is missing the approval.requested event");
    if (!decided) throw new Error("audit log is missing the approval.decided event");
    const record = decided.data.approval;
    if (!record.decidedBy || !record.decidedAt) {
      throw new Error("approval.decided is missing identity or timestamp fields");
    }
    if (decided.profileHash !== profileHash || record.profileHash !== profileHash) {
      throw new Error("approval.decided does not carry the expected doctrine hash");
    }
    console.log(
      "\nEvidence fields: approval.decided -> data.approval.decidedBy (identity), data.approval.decidedAt / occurredAt (timestamps), profileHash on both the event envelope and the approval record (doctrine hash).",
    );
  } finally {
    store.close();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const layout = await createRuntimeLayout();
  const xtermHooks = await writeXtermEsmHooks(layout.root);
  const doctrine = await deriveCeremonyDoctrine(layout);
  const baseCommit = await createFixtureRepo(layout.fixtureRepo);
  const runToken = randomBytes(8).toString("hex");
  const runnerToken = randomBytes(32).toString("hex");
  const captainToken = randomBytes(32).toString("hex");
  const operatorToken = `clankie_op_${randomBytes(32).toString("base64url")}`;
  const operatorId = process.env.CLANKIE_OPERATOR_ID ?? "local-operator";
  const secrets = [runnerToken, captainToken, operatorToken];

  const [controlPort, transcriptPort] = [await reservePort(), await reservePort()];
  const baseUrl = `http://127.0.0.1:${controlPort}`;
  const common = baseProcessEnvironment(process.env);
  const processes = [];

  logSection("Approval ceremony drill (VUH-698)");
  console.log(`mode: ${options.mode === "interactive" ? "interactive ceremony" : `auto-decide ${options.mode}`}`);
  console.log(`runtime root: ${layout.root}`);
  console.log(`derived doctrine profile: ${doctrine.path}`);
  console.log(`doctrine profileHash: ${doctrine.profileHash}`);
  console.log(`control plane: ${baseUrl} (ephemeral; ports 4310/4313/4321/8082 untouched)`);

  const cleanup = async () => {
    for (const managed of processes) await stopManagedProcess(managed);
  };
  const abort = async (signal) => {
    console.error(`\nReceived ${signal}; stopping the drill runtime.`);
    await cleanup();
    process.exit(130);
  };
  process.on("SIGINT", () => void abort("SIGINT"));
  process.on("SIGTERM", () => void abort("SIGTERM"));

  try {
    processes.push(
      startManagedProcess(
        {
          name: "control-plane",
          command: "pnpm",
          args: ["--filter", "@clankie/control-plane", "start"],
          cwd: repoRoot,
          environment: {
            ...common,
            PORT: String(controlPort),
            CLANKIE_EVENT_STORE: layout.eventStore,
            CLANKIE_MEMORY_STORE: layout.memoryStore,
            CLANKIE_REPO_PATH: layout.fixtureRepo,
            CLANKIE_DOCTRINE: doctrine.path,
            CLANKIE_RUNNER_TOKEN: runnerToken,
            CLANKIE_CAPTAIN_TOKEN: captainToken,
            CLANKIE_OPERATOR_TOKEN: operatorToken,
            CLANKIE_OPERATOR_ID: operatorId,
            CLANKIE_CREDENTIALS_FILE: layout.credentialsFile,
            CLANKIE_RUNNER_ID: "approval-ceremony-runner",
            CLANKIE_WORKER_TRANSCRIPT_URL: `http://127.0.0.1:${transcriptPort}`,
          },
        },
        secrets,
      ),
    );
    await waitForControlPlane(baseUrl, processes, options.timeoutMs);
    console.log("control plane is healthy");

    processes.push(
      startManagedProcess(
        {
          // Spawned via the workspace tsx binary rather than `pnpm --filter`
          // so the NODE_OPTIONS module hook reaches only the runner process,
          // not pnpm itself (whose pnpmfile probing breaks under import hooks).
          name: "runner",
          command: join(repoRoot, "node_modules/.bin/tsx"),
          args: ["src/index.ts"],
          cwd: join(repoRoot, "apps/runner"),
          environment: {
            ...common,
            NODE_OPTIONS: [common.NODE_OPTIONS, `--import ${xtermHooks}`].filter(Boolean).join(" "),
            CLANKIE_SIM_WORKERS: "1",
            CLANKIE_CONTROL_PLANE_URL: baseUrl,
            CLANKIE_REPO_PATH: layout.fixtureRepo,
            CLANKIE_BASE_REF: baseCommit,
            CLANKIE_WORKTREE_ROOT: layout.worktreeRoot,
            CLANKIE_RUNNER_STATE: layout.runnerState,
            CLANKIE_ARTIFACT_ROOT: layout.runnerArtifacts,
            CLANKIE_RUNNER_TOKEN: runnerToken,
            CLANKIE_RUNNER_ID: "approval-ceremony-runner",
            CLANKIE_WORKER_TRANSCRIPT_PORT: String(transcriptPort),
            CLANKIE_VERIFICATION_CHECKS: JSON.stringify([
              {
                id: "ceremony-fixture-check",
                command: process.execPath,
                args: [
                  "-e",
                  'const c = require("node:fs").readFileSync("src/retry.mjs", "utf8"); process.exit(c.includes("DEFECT") ? 7 : 0);',
                ],
              },
            ]),
          },
        },
        secrets,
      ),
    );

    const client = new ClankieApiClient({ baseUrl, captainToken, operatorToken });

    logSection("Driving the mission to the merge boundary");
    const created = await client.createMission({
      goal: "Reach the human merge-approval boundary with sim workers.",
      context: { drill: "vuh-698-approval-ceremony", runToken },
    });
    console.log(`missionId: ${created.missionId}`);
    await client.proposePlan(created.missionId, buildCeremonyPlan(created.missionId, doctrine.profileHash));
    await client.startMission(created.missionId);
    await waitForMission(
      client,
      created.missionId,
      (mission) => mission.state === "succeeded",
      processes,
      options.timeoutMs,
    );
    console.log("mission succeeded: implementation landed and independently verified by sim workers");

    const mergeRequest = buildMergeRequest(created.missionId, doctrine.profileHash, runToken);
    const initialDecision = await client.requestAction(mergeRequest);
    console.log(`lead requested privileged merge ${mergeRequest.id}: ${describeDecision(initialDecision)}`);
    if (initialDecision.effect !== "require_approval") {
      throw new Error(`expected require_approval for the merge request, got ${initialDecision.effect}`);
    }

    const pending = await client.listApprovals("pending");
    const approval = pending.find((candidate) => candidate.id === mergeRequest.id);
    if (!approval) throw new Error("the pending merge approval is not visible in the operator inbox");
    console.log(`pending approval visible in operator inbox: ${approval.id} (requestedAt ${approval.requestedAt})`);

    const preApproval = await client.requestAction(mergeRequest);
    if (preApproval.effect !== "require_approval") {
      throw new Error(`the connector boundary leaked before approval: ${describeDecision(preApproval)}`);
    }
    console.log("connector boundary holds: re-requesting before any decision still returns require_approval");

    let record;
    if (options.mode === "interactive") {
      logSection("Attach the console and decide");
      console.log("The drill stays running until you decide in the console. In another terminal:\n");
      console.log(`  export CLANKIE_CONTROL_PLANE_URL=${baseUrl}`);
      console.log(`  export CLANKIE_OPERATOR_TOKEN=${operatorToken}`);
      console.log(`  export CLANKIE_EVENT_STORE=${layout.eventStore}`);
      console.log("  pnpm --filter @clankie/tui dev    # or the `clankie` binary with the same environment\n");
      console.log("Then open the /approvals inbox, review the plan/evidence/policy rationale, and approve or");
      console.log("reject with a reason. (The operator token above is ephemeral to this drill runtime.)");
      console.log("\nEvidence will be recorded as approval.requested / approval.decided events carrying");
      console.log("decidedBy (identity), decidedAt + occurredAt (timestamps), and profileHash (doctrine hash).");
      record = await waitForOperatorDecision(client, mergeRequest.id, processes);
    } else {
      const decision = options.mode === "approve" ? "approve" : "deny";
      const reason =
        options.mode === "approve"
          ? "Reviewed the plan, evidence, and policy rationale; the simulated merge may proceed."
          : "Rejecting the simulated merge: the evidence bundle needs another verification pass.";
      logSection(`Auto-deciding via the authenticated operator path (${decision})`);
      record = await client.decideApproval(mergeRequest.id, { decision, reason });
    }

    logSection("Decision outcome");
    console.log(`approval ${record.id}: status=${record.status} decidedBy=${record.decidedBy} decidedAt=${record.decidedAt}`);
    console.log(`operator reason: ${JSON.stringify(record.reason)}`);

    const postDecision = await client.requestAction(mergeRequest);
    if (record.status === "denied") {
      if (postDecision.effect !== "deny" || !postDecision.reason.includes(record.reason ?? "")) {
        throw new Error(`the denial did not return to the lead with the reason: ${describeDecision(postDecision)}`);
      }
      console.log("\nRejection path: the merge task returns to the lead with the human's reason attached —");
      console.log(`  ${describeDecision(postDecision)}`);
      console.log("The lead must replan (new evidence, new approval request); no connector executed.");
    } else {
      if (postDecision.effect !== "allow") {
        throw new Error(`approval did not release the merge connector: ${describeDecision(postDecision)}`);
      }
      console.log("\nApproval path: the policy engine releases the merge only after the recorded human approval —");
      console.log(`  ${describeDecision(postDecision)}`);
      console.log("privileged connector: simulated merge executed for clankie/approval-ceremony-fixture (no real remote).");
    }

    await cleanup();
    await printAuditEvidence(layout.eventStore, mergeRequest.id, doctrine.profileHash);

    logSection("Drill complete");
    console.log(`outcome: ${record.status}`);
    console.log(`runtime retained for inspection: ${layout.root}`);
    process.exit(0);
  } catch (error) {
    await cleanup();
    console.error(`\nDrill failed: ${error instanceof Error ? error.message : String(error)}`);
    for (const managed of processes) {
      const output = tail(managed.redactedOutput());
      if (output.trim().length > 0) {
        console.error(`\n--- ${managed.spec.name} output (redacted tail) ---\n${output}`);
      }
    }
    console.error(`runtime retained for inspection: ${layout.root}`);
    process.exit(1);
  }
}

await main();
