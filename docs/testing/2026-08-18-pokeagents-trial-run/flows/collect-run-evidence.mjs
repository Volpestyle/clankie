#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const flowDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(flowDir, "../../../..");
const playJournalPath = path.resolve(process.argv[2] ?? "");
const evidenceDir = path.resolve(process.argv[3] ?? path.join(flowDir, "../evidence"));

if (!existsSync(playJournalPath)) {
  throw new Error("usage: collect-run-evidence.mjs <gba-play-journal.jsonl> [evidence-dir]");
}

mkdirSync(evidenceDir, { recursive: true });
const sourceHashes = {};
const playEntries = readJsonl(playJournalPath);
const header = playEntries.find((entry) => entry.kind === "header");
const summary = playEntries.findLast((entry) => entry.kind === "summary");
if (header === undefined || summary === undefined) throw new Error("play journal has no header or summary");

const runId = String(header.runId);
const worldProvenance = playEntries.find((entry) => entry.evidence?.decision?.provenance?.body === "world")
  ?.evidence?.decision?.provenance;
const environmentSessionId = String(worldProvenance?.sessionId ?? header.environmentSessionId);
const startedAt = String(header.startedAt);
const endedAt = String(summary.at);
const knownPrivateValues = privateValues(playEntries);

sourceHashes.playJournal = sourceIdentity(playJournalPath);
archiveScreenshots(playEntries);
writeJsonl(
  "01-play-journal.jsonl",
  playEntries.map((entry) => sanitize(entry, knownPrivateValues)),
);

const stateRoot = process.env.CLANKIE_STATE?.trim() || path.join(homedir(), ".clankie");
const stateHome = process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state");
const eventPath = process.env.CLANKIE_EVENT_LOG?.trim() || path.join(stateRoot, "events.jsonl");
const receiptPath =
  process.env.DISCORD_BRIDGE_RECEIPT_PATH?.trim() ||
  path.join(stateHome, "clankie", "discord-live-receipts.jsonl");
const serviceLogPath = path.join(stateHome, "clankie", "clankie.log");

const lifecycle = readJsonl(eventPath).filter((entry) => entry.data?.sessionId === runId);
sourceHashes.lifecycleEvents = sourceIdentity(eventPath);
writeJsonl(
  "02-lifecycle-events.jsonl",
  lifecycle.map((entry) => sanitize(entry, knownPrivateValues)),
);

const deliveryIds = new Set(
  playEntries
    .map((entry) => entry.speechDeliveryId)
    .filter((value) => typeof value === "string" && value.length > 0),
);
const allReceipts = readJsonl(receiptPath);
const directlyJoined = allReceipts.filter((entry) => deliveryIds.has(entry.data?.deliveryId));
const stayIds = new Set(
  directlyJoined.map((entry) => entry.data?.stayId).filter((value) => typeof value === "string"),
);
const voiceReceipts = allReceipts.filter((entry) => {
  if (deliveryIds.has(entry.data?.deliveryId)) return true;
  const at = Date.parse(String(entry.occurredAt ?? ""));
  return (
    stayIds.has(entry.data?.stayId) &&
    at >= Date.parse(startedAt) &&
    at <= Date.parse(endedAt) &&
    String(entry.type ?? "").startsWith("discord.voice.")
  );
});
sourceHashes.voiceReceipts = sourceIdentity(receiptPath);
writeJsonl(
  "03-voice-receipts.jsonl",
  voiceReceipts.map((entry) => sanitize(entry, knownPrivateValues)),
);

const serviceEvents = readJsonLines(serviceLogPath).filter((entry) => {
  if (entry.sessionId === runId) return true;
  const at = Date.parse(String(entry.time ?? ""));
  if (at < Date.parse(startedAt) - 90_000 || at > Date.parse(endedAt) + 10_000) return false;
  return [
    "embodiment play host started",
    "clankie listening",
    "clankie shutdown requested",
    "clankie shutdown settled",
  ].includes(entry.msg);
});
sourceHashes.serviceLog = sourceIdentity(serviceLogPath);
writeJsonl(
  "04-service-events.jsonl",
  serviceEvents.map((entry) => sanitize(entry, knownPrivateValues)),
);

const worldJournalPath = findFile(path.join(homedir(), ".pokeagent-mmo", "world", "players"), (file) =>
  file.endsWith(`-${environmentSessionId}.jsonl`),
);
if (worldJournalPath === null) throw new Error(`no PokeAgents journal found for ${environmentSessionId}`);
const worldEntries = readJsonl(worldJournalPath);
sourceHashes.worldJournal = sourceIdentity(worldJournalPath);
writeJsonl(
  "05-world-action-journal.jsonl",
  worldEntries.map((entry) => sanitize(entry, knownPrivateValues)),
);

const gameDir = path.dirname(path.dirname(worldJournalPath));
const checkpointReceipts = findFiles(path.join(gameDir, "checkpoints"), (file) =>
  file.endsWith("receipt.json"),
)
  .map((file) => ({ file, value: JSON.parse(readFileSync(file, "utf8")) }))
  .filter(({ value }) => value.sessionId === environmentSessionId);
for (const { file } of checkpointReceipts)
  sourceHashes[`checkpoint:${path.basename(path.dirname(file))}`] = sourceIdentity(file);
writeJsonl(
  "06-world-checkpoint-receipts.jsonl",
  checkpointReceipts.map(({ value }) => sanitize(value, knownPrivateValues)),
);

const captainTurnPath = findFile(path.join(stateRoot, "captain", "turns"), (file) => {
  if (!file.endsWith(".jsonl")) return false;
  return readFileSync(file, "utf8").includes(runId);
});
if (captainTurnPath !== null) {
  sourceHashes.captainLaunchTurn = sourceIdentity(captainTurnPath);
  writeJson("07-captain-launch.json", captainLaunch(captainTurnPath, knownPrivateValues));
}

const evaluation = JSON.parse(
  execFileSync(
    "pnpm",
    [
      "--filter",
      "@clankie/gba-emulator",
      "exec",
      "tsx",
      "scripts/evaluate-free-play-journal.ts",
      playJournalPath,
      "--events",
      eventPath,
      "--voice-receipts",
      receiptPath,
    ],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  ),
);
writeJson("08-evaluation-summary.json", { run: evaluation.run, aggregate: evaluation.aggregate });

const turns = playEntries.filter((entry) => entry.kind === "turn");
const tsv = [
  ["turn", "at", "objective", "objectiveRetired", "intent", "action", "outcome", "effect", "advice"],
  ...turns.map((entry) => [
    entry.turn.turn,
    entry.at,
    entry.turn.objective ?? "",
    entry.turn.objectiveRetired ?? "",
    entry.turn.intent ?? "",
    entry.turn.action === null ? "" : JSON.stringify(entry.turn.action),
    entry.turn.outcome,
    entry.turn.effect ?? "",
    entry.turn.effectAdvice ?? "",
  ]),
]
  .map((row) => row.map(tsvCell).join("\t"))
  .join("\n");
writeFileSync(path.join(evidenceDir, "09-turn-timeline.tsv"), `${tsv}\n`);

writeJson("10-capture-environment.json", {
  capturedAt: new Date().toISOString(),
  run: { runId, environmentSessionId, startedAt, endedAt },
  sourcePaths: Object.fromEntries(
    Object.entries({ playJournalPath, eventPath, receiptPath, serviceLogPath, worldJournalPath }).map(
      ([key, value]) => [key, scrubPath(value)],
    ),
  ),
  sourceRepositories: {
    clankie: gitState(repoRoot),
    pokeagents: gitState(path.join(homedir(), "dev", "pokeagents")),
  },
  toolchain: {
    node: process.version,
    pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
  },
  caveat:
    "The journals do not identify the exact source revision. These repository states were captured later and do not prove what uncommitted source the processes ran.",
});

const evidenceFiles = findFiles(evidenceDir, (file) => path.basename(file) !== "manifest.json").map((file) =>
  sourceIdentity(file, path.relative(evidenceDir, file).split(path.sep).join(path.posix.sep)),
);
writeJson("manifest.json", {
  schemaVersion: 1,
  runId,
  generatedAt: new Date().toISOString(),
  evidence: evidenceFiles,
  sources: sourceHashes,
  exclusions: [
    "ROM, cartridge save, savestate, checkpoint state bytes, and unreferenced framebuffer bytes",
    "credentials, session tokens, watch links, and current service-state files",
    "full Discord room history and full voice transcript text; voice evidence is content-free and limited to the run's active stay",
    "generated voice wording and PCM, which are not durably recorded by policy",
  ],
});

function readJsonl(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readJsonLines(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function writeJson(name, value) {
  writeFileSync(path.join(evidenceDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(name, values) {
  writeFileSync(path.join(evidenceDir, name), `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

function sourceIdentity(file, displayPath = scrubPath(file)) {
  const bytes = readFileSync(file);
  return {
    path: displayPath,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function archiveScreenshots(entries) {
  const journalRoot = path.dirname(playJournalPath);
  for (const entry of entries) {
    const screenshot = entry.screenshot;
    if (screenshot === undefined) continue;
    const relativePath = String(screenshot.path);
    if (!/^\.screenshots\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.png$/u.test(relativePath)) {
      throw new Error(`unsafe screenshot path: ${relativePath}`);
    }
    const source = path.resolve(journalRoot, relativePath);
    if (!within(journalRoot, source)) throw new Error(`screenshot escaped journal root: ${relativePath}`);
    const identity = sourceIdentity(source);
    if (identity.bytes !== screenshot.byteLength || identity.sha256 !== screenshot.sha256) {
      throw new Error(`screenshot identity mismatch: ${relativePath}`);
    }
    const destination = path.join(evidenceDir, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    sourceHashes[`screenshot:${path.basename(relativePath)}`] = identity;
  }
}

function within(root, target) {
  const relativePath = path.relative(root, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function privateValues(entries) {
  const replacements = new Map();
  for (const entry of entries) {
    const raw = entry.turn?.interjection;
    if (typeof raw !== "string") continue;
    try {
      const heard = JSON.parse(raw);
      if (typeof heard.speakerId === "string") replacements.set(heard.speakerId, "<operator-id>");
      if (typeof heard.displayName === "string") replacements.set(heard.displayName, "<operator>");
    } catch {
      // An opaque interjection stays opaque; the selected trace contains only validated JSON today.
    }
  }
  return replacements;
}

function sanitize(value, replacements, key = "") {
  if (Array.isArray(value)) return value.map((item) => sanitize(item, replacements));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, sanitize(child, replacements, childKey)]),
    );
  }
  if (typeof value !== "string") return value;
  if (["speakerId", "requestedBy", "userId", "actorId"].includes(key)) return "<operator-id>";
  if (key === "displayName") return "<operator>";
  if (key === "playerId") return "<player-id>";
  if (key === "guildId") return "<guild-id>";
  if (key === "channelId") return "<channel-id>";
  if (key === "interjection") {
    try {
      return JSON.stringify(sanitize(JSON.parse(value), replacements));
    } catch {
      return "<redacted-interjection>";
    }
  }
  let result = scrubPath(value);
  for (const [privateValue, replacement] of replacements) {
    result = result.replaceAll(privateValue, replacement);
  }
  return result;
}

function scrubPath(value) {
  return String(value)
    .replaceAll(homedir(), "${HOME}")
    .replace(/(\.pokeagent-mmo\/world\/players\/)[^/]+/gu, "$1<player>")
    .replace(/(\.clankie\/captain\/turns\/)[^/]+/gu, "$1<lane-target>");
}

function findFile(root, predicate) {
  return findFiles(root, predicate)[0] ?? null;
}

function findFiles(root, predicate) {
  if (!existsSync(root)) return [];
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(file, predicate));
    else if (predicate(file)) found.push(file);
  }
  return found.sort();
}

function captainLaunch(file, replacements) {
  const entries = readJsonl(file);
  const events = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message?.role === "user") {
      events.push({
        at: entry.timestamp,
        role: "user",
        text: "[redacted operator request to join and play]",
      });
      continue;
    }
    if (message?.role === "assistant") {
      for (const part of message.content ?? []) {
        if (part.type === "text") events.push({ at: entry.timestamp, role: "assistant", text: part.text });
        if (part.type === "toolCall") {
          events.push({
            at: entry.timestamp,
            role: "assistant",
            tool: part.name,
            arguments:
              part.name === "pokeagent_join_mmo" ? { environmentId: part.arguments?.environmentId } : {},
          });
        }
      }
      continue;
    }
    if (message?.role !== "toolResult" || message.toolName === "get_self_state") continue;
    const text = (message.content ?? []).find((part) => part.type === "text")?.text;
    let parsed = null;
    try {
      parsed = JSON.parse(text ?? "null");
    } catch {
      parsed = null;
    }
    events.push({
      at: entry.timestamp,
      role: "toolResult",
      tool: message.toolName,
      result: sanitize(safeToolResult(message.toolName, parsed), replacements),
    });
  }
  return { source: scrubPath(file), events };
}

function safeToolResult(tool, result) {
  if (result === null || typeof result !== "object") return { outcome: "unavailable" };
  if (tool === "pokeagent_observe") {
    return {
      outcome: result.outcome,
      snapshot: result.snapshot
        ? {
            surface: result.snapshot.surface,
            sessionId: result.snapshot.sessionId,
            environmentId: result.snapshot.environmentId,
            sequence: result.snapshot.sequence,
            observedAt: result.snapshot.observedAt,
            selfAuthored: result.snapshot.selfAuthored,
            runnerObserved: result.snapshot.runnerObserved,
          }
        : null,
      still: result.still,
    };
  }
  const safeKeys = [
    "ok",
    "action",
    "reason",
    "message",
    "sessionId",
    "environmentId",
    "actorCanBeHeard",
    "transcriptLoggingEnabled",
    "remembered",
  ];
  return Object.fromEntries(safeKeys.filter((key) => key in result).map((key) => [key, result[key]]));
}

function gitState(root) {
  if (!existsSync(root)) return null;
  const run = (args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  return {
    path: scrubPath(root),
    head: run(["rev-parse", "HEAD"]),
    status: run(["status", "--short"]).split("\n").filter(Boolean),
  };
}

function tsvCell(value) {
  return String(value ?? "")
    .replaceAll("\t", " ")
    .replaceAll("\n", "\\n");
}
