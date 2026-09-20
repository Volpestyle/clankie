import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const archiveDirectory = join(repository, "docs/testing/2026-09-20-delivered-files-live");
const deliverablesDirectory = join(archiveDirectory, "evidence/deliverables");
const evidenceDirectory = join(archiveDirectory, "evidence");
const resultPath = join(evidenceDirectory, "live-result.json");
const hostPort = Number(process.env.VUH1105_HOST_PORT ?? "4395");
const relayPort = Number(process.env.VUH1105_RELAY_PORT ?? "4396");
const simulators = (process.env.VUH1105_SIMULATOR_UDID ?? "").split(",").filter(Boolean);
const holdForSimulator = simulators.length > 0;
const controlOrigin = `http://127.0.0.1:${hostPort}`;
const relayOrigin = `http://127.0.0.1:${relayPort}`;
const files = [
  [
    "delivered-files-acceptance-report.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [
    "delivered-files-evidence-matrix.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  [
    "delivered-files-workflow.pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  ["delivered-files-site-bundle.zip", "application/zip"],
];

await mkdir(evidenceDirectory, { recursive: true });
const { resolveOperatorCredential, resolveCaptainCredential } = await import(
  join(repository, "packages/credential-broker/src/index.ts")
);
const operator = await resolveOperatorCredential({ env: process.env });
const captain = await resolveCaptainCredential({ env: process.env });
assert.ok(operator?.token, "canonical operator credential is unavailable");
assert.ok(captain?.token, "canonical captain credential is unavailable");

const root = await mkdtemp(join(tmpdir(), "clankie-vuh1105-"));
const workspace = join(root, "workspace");
await mkdir(workspace, { recursive: true });
for (const [filename] of files)
  await copyFile(join(deliverablesDirectory, filename), join(workspace, filename));
await mkdir(join(root, "config/clankie"), { recursive: true });
await writeFile(
  join(root, "config/clankie/settings.json"),
  `${JSON.stringify({ schemaVersion: 1, captain: { workingDirectory: workspace } }, null, 2)}\n`,
  { mode: 0o600 },
);

const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_DATA_HOME: join(root, "data"),
  CLANKIE_STATE: join(root, "body"),
  CLANKIE_SETTINGS_FILE: join(root, "config/clankie/settings.json"),
  CLANKIE_OPERATOR_TOKEN: operator.token,
  CLANKIE_CAPTAIN_TOKEN: captain.token,
  CLANKIE_CONTROL_PLANE_URL: controlOrigin,
  CLANKIE_CAPTAIN_URL: controlOrigin,
  CLANKIE_RELAY_URL: relayOrigin,
  CLANKIE_RELAY_PORT: String(relayPort),
  CLANKIE_RELAY_HOST: "127.0.0.1",
  CLANKIE_BROWSER_ENABLED: "false",
  CLANKIE_TLDRAW_ENABLED: "false",
  PORT: String(hostPort),
};
for (const name of Object.keys(env)) {
  if (name.startsWith("HERDR_") || name.startsWith("HERD_LEAD_")) delete env[name];
}
delete env.CLANKIE_CREDENTIALS_FILE;

const tsx = join(repository, "node_modules/.bin/tsx");
const cli = join(repository, "apps/tui/bin/clankie.ts");
let service;
let relay;
const serviceLogPath = join(evidenceDirectory, "service.log");
const relayLogPath = join(evidenceDirectory, "relay.log");
const serviceLog = openSync(serviceLogPath, "w", 0o600);
const relayLog = openSync(relayLogPath, "w", 0o600);
const report = {
  schemaVersion: 1,
  date: new Date().toISOString(),
  scope:
    "Current source service and relay with fresh ports, fresh state, canonical broker credentials only in child-process memory",
  hostPort,
  relayPort,
  checks: [],
  artifacts: [],
  refusals: {},
};

function command(args, options = {}) {
  const result = spawnSync(tsx, [cli, ...args], {
    cwd: workspace,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (options.expectFailure) {
    assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly succeeded`);
    return { status: result.status };
  }
  if (result.status !== 0) {
    throw new Error(`CLI ${args[0]} exited ${result.status}: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout);
}

async function jsonRequest(origin, path, body, bearer) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const responseBody = await response.json().catch(() => undefined);
  return { status: response.status, body: responseBody };
}

async function download(origin, conversationId, artifactId, bearer) {
  const response = await fetch(`${origin}/operator/v1/artifacts/download`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify({ schemaVersion: 1, conversationId, artifactId }),
    signal: AbortSignal.timeout(30_000),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function startService() {
  return spawn(tsx, [join(repository, "apps/clankie/src/index.ts")], {
    cwd: workspace,
    env,
    stdio: ["ignore", serviceLog, serviceLog],
  });
}

function startRelay() {
  return spawn(tsx, [join(repository, "apps/relay/src/index.ts")], {
    cwd: workspace,
    env,
    stdio: ["ignore", relayLog, relayLog],
  });
}

async function waitHealthy(origin, process, label) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`${label} exited ${process.exitCode}`);
    try {
      if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_000) })).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`${label} did not become healthy`);
}

async function stop(process) {
  if (process === undefined || process.exitCode !== null) return;
  process.kill("SIGTERM");
  for (let attempt = 0; attempt < 200 && process.exitCode === null; attempt += 1) await sleep(50);
  if (process.exitCode === null) process.kill("SIGKILL");
}

try {
  service = startService();
  relay = startRelay();
  await Promise.all([
    waitHealthy(controlOrigin, service, "service"),
    waitHealthy(relayOrigin, relay, "relay"),
  ]);
  report.checks.push("fresh isolated service and relay became healthy");

  const list = await jsonRequest(
    controlOrigin,
    "/operator/v1/dispatch",
    { schemaVersion: 1, op: "list" },
    captain.token,
  );
  assert.equal(list.status, 200);
  const conversation = list.body.conversations.find((entry) => entry.isDefault) ?? list.body.conversations[0];
  assert.ok(conversation?.conversationId);
  report.conversationId = conversation.conversationId;

  for (const [filename, mediaType] of files) {
    const source = await readFile(join(workspace, filename));
    const published = command([
      "file",
      "publish",
      "--conversation",
      conversation.conversationId,
      filename,
      "--name",
      filename,
      "--type",
      mediaType,
    ]);
    assert.equal(published.byteCount, source.byteLength);
    assert.equal(published.sha256, digest(source));
    report.artifacts.push({
      filename,
      mediaType,
      sourceBytes: source.byteLength,
      sourceSha256: digest(source),
      published,
    });
  }
  assert.equal(report.artifacts.length, 4);
  report.checks.push("four sourced artifacts published through the CLI into one conversation");

  const replay = await jsonRequest(
    controlOrigin,
    "/operator/v1/dispatch",
    {
      op: "replay",
      schemaVersion: 1,
      replay: {
        schemaVersion: 1,
        conversationId: conversation.conversationId,
        surfaceClientId: "vuh1105-proof",
      },
    },
    captain.token,
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.body.result.events.filter((event) => event.type === "file").length, 4);
  report.checks.push("conversation replay returned the four published file events");

  const offer = command(["pair", "--json"]);
  const redeemed = await jsonRequest(
    controlOrigin,
    "/v1/pairing/redeem",
    {
      code: offer.code,
      device: { name: "VUH-1105 isolated relay proof", platform: "ios" },
    },
    operator.token,
  );
  assert.equal(redeemed.status, 200);
  const paired = await jsonRequest(
    controlOrigin,
    "/v1/pairing/complete",
    {
      completionToken: redeemed.body.completionToken,
      acceptedGrants: redeemed.body.offeredGrants,
    },
    operator.token,
  );
  assert.equal(paired.status, 200);
  assert.ok(paired.body.deviceToken);
  const deviceToken = paired.body.deviceToken;
  const deviceId = paired.body.deviceId;

  for (const artifact of report.artifacts) {
    const fetched = await download(
      relayOrigin,
      conversation.conversationId,
      artifact.published.artifactId,
      deviceToken,
    );
    assert.equal(fetched.status, 200);
    assert.equal(fetched.contentType, artifact.mediaType);
    assert.equal(fetched.bytes.byteLength, artifact.sourceBytes);
    assert.equal(digest(fetched.bytes), artifact.sourceSha256);
  }
  report.checks.push(
    "authenticated relay retrieval returned the exact four published byte streams and content types",
  );

  const unauthenticated = await download(
    relayOrigin,
    conversation.conversationId,
    report.artifacts[0].published.artifactId,
  );
  assert.notEqual(unauthenticated.status, 200);
  report.refusals.missingAuthorization = unauthenticated.status;
  const unrelated = await download(
    relayOrigin,
    "unrelated-conversation",
    report.artifacts[0].published.artifactId,
    deviceToken,
  );
  assert.equal(unrelated.status, 404);
  report.refusals.unrelatedConversation = unrelated.status;
  const pathEscape = command(
    ["file", "publish", "--conversation", conversation.conversationId, "/etc/hosts"],
    { expectFailure: true },
  );
  report.refusals.pathEscapeExit = pathEscape.status;
  report.checks.push(
    "missing authorization, unrelated conversation, and outside-workspace publication were refused",
  );

  await stop(service);
  service = startService();
  await waitHealthy(controlOrigin, service, "restarted service");
  for (const artifact of report.artifacts) {
    const fetched = await download(
      relayOrigin,
      conversation.conversationId,
      artifact.published.artifactId,
      deviceToken,
    );
    assert.equal(fetched.status, 200);
    assert.equal(digest(fetched.bytes), artifact.sourceSha256);
  }
  report.checks.push(
    "the same device retrieved all four exact byte streams after a service restart with retained state",
  );

  const revoked = command(["devices", "revoke", deviceId, "--json"]);
  assert.equal(revoked.ok, true);
  const afterRevocation = await download(
    relayOrigin,
    conversation.conversationId,
    report.artifacts[0].published.artifactId,
    deviceToken,
  );
  assert.notEqual(afterRevocation.status, 200);
  report.refusals.revokedDevice = afterRevocation.status;
  report.checks.push("revoked device retrieval was refused on its next relay request");

  report.outcome = "passed";
  report.simulatorPairingPrepared = holdForSimulator;
  await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });

  if (holdForSimulator) {
    for (const simulator of simulators) {
      const appOffer = command(["pair", "--json"]);
      const opened = spawnSync("xcrun", ["simctl", "openurl", simulator, appOffer.deepLink], {
        encoding: "utf8",
        timeout: 30_000,
      });
      if (opened.status !== 0) throw new Error(`simulator pairing link failed: ${opened.stderr.trim()}`);
    }
    console.log(
      JSON.stringify({
        outcome: "passed",
        state: "holding_for_simulator",
        conversationId: conversation.conversationId,
        artifactCount: report.artifacts.length,
        result: resultPath,
      }),
    );
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  } else {
    console.log(JSON.stringify({ outcome: "passed", result: resultPath }));
  }
} catch (error) {
  report.outcome = "failed";
  report.failure = error instanceof Error ? error.message : String(error);
  await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  console.error(JSON.stringify({ outcome: "failed", failure: report.failure }));
  process.exitCode = 1;
} finally {
  await stop(relay);
  await stop(service);
  closeSync(serviceLog);
  closeSync(relayLog);
  await rm(root, { recursive: true, force: true });
}
