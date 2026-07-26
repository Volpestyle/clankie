import { lstat, readFile } from "node:fs/promises";
import { parseDiscordBridgeReceipt, type DiscordBridgeReceipt } from "@clankie/discord-presence-core";

export interface DiscordLiveProofCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface DiscordLiveProofReport {
  readonly schemaVersion: 1;
  readonly passed: boolean;
  readonly receiptCount: number;
  readonly checks: readonly DiscordLiveProofCheck[];
}

export type DiscordPersonMemoryLiveProofReport = DiscordLiveProofReport;
export type DiscordVoiceLiveProofReport = DiscordLiveProofReport;

export function evaluateDiscordLiveProof(receipts: readonly DiscordBridgeReceipt[]): DiscordLiveProofReport {
  const checks: DiscordLiveProofCheck[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };
  const ready = receipts.find((receipt) => receipt.type === "discord.bridge.ready");
  check("gateway ready", ready !== undefined, ready ? "ready receipt observed" : "no ready receipt");

  const accepted = receipts.find(
    (receipt) =>
      receipt.type === "discord.text.ingress" &&
      (receipt.data.outcome === "accepted" || receipt.data.outcome === "settled"),
  );
  const settled = accepted
    ? receipts.find(
        (receipt) =>
          receipt.type === "discord.text.ingress" &&
          receipt.data.deliveryId === accepted.data.deliveryId &&
          receipt.data.outcome === "settled",
      )
    : undefined;
  const reply = accepted
    ? receipts.find(
        (receipt) =>
          receipt.type === "discord.text.reply" &&
          receipt.data.deliveryId === accepted.data.deliveryId &&
          typeof receipt.data.responseMessageId === "string",
      )
    : undefined;
  check(
    "bounded text round trip",
    accepted !== undefined && settled !== undefined && reply !== undefined,
    reply
      ? "one admitted delivery settled and produced a Discord reply id"
      : "no admitted delivery has both settled ingress and reply receipts",
  );

  const binding = receipts.find((receipt) => receipt.type === "discord.mission.bound");
  const stoppedAfterBinding =
    binding === undefined
      ? undefined
      : receipts
          .slice(receipts.indexOf(binding) + 1)
          .find((receipt) => receipt.type === "discord.bridge.stopped");
  const restored =
    binding === undefined || stoppedAfterBinding === undefined
      ? undefined
      : receipts
          .slice(receipts.indexOf(stoppedAfterBinding) + 1)
          .find(
            (receipt) =>
              receipt.type === "discord.mission.restored" &&
              receipt.data.missionId === binding.data.missionId &&
              receipt.data.threadId === binding.data.threadId &&
              receipt.data.guildId === binding.data.guildId,
          );
  check(
    "mission restart restoration",
    binding !== undefined && stoppedAfterBinding !== undefined && restored !== undefined,
    restored
      ? "the same mission/thread binding was restored after a graceful bridge restart"
      : "no mission binding has a matching stop-and-restore sequence",
  );

  const approvalRefusal = receipts.find((receipt) => receipt.type === "discord.approval.refused");
  check(
    "ambient approval denial",
    approvalRefusal !== undefined,
    approvalRefusal ? "Discord approval refusal receipt observed" : "no Discord approval refusal receipt",
  );

  return {
    schemaVersion: 1,
    passed: checks.every((entry) => entry.ok),
    receiptCount: receipts.length,
    checks,
  };
}

/**
 * Requires an explicit reviewed proposal to become recallable after a real
 * control-plane restart. Matching a generated fact id proves that the
 * approval-only store boundary committed that proposal; differing instance ids
 * prove the fact survived durable event/store replay rather than process RAM.
 */
export function evaluateDiscordPersonMemoryLiveProof(
  receipts: readonly DiscordBridgeReceipt[],
): DiscordPersonMemoryLiveProofReport {
  const checks: DiscordLiveProofCheck[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };
  const proposal = receipts.find(
    (receipt) =>
      receipt.type === "discord.person-memory.proposed" &&
      typeof receipt.data.proposalId === "string" &&
      typeof receipt.data.factId === "string" &&
      typeof receipt.data.approvalId === "string" &&
      typeof receipt.data.controlPlaneInstanceId === "string",
  );
  check(
    "reviewed proposal delivered",
    proposal !== undefined,
    proposal
      ? "Discord delivered a proposal acknowledgement with an operator approval id"
      : "no complete person-memory proposal receipt",
  );

  const recalled =
    proposal === undefined
      ? undefined
      : receipts
          .slice(receipts.indexOf(proposal) + 1)
          .find(
            (receipt) =>
              receipt.type === "discord.person-memory.recalled" &&
              receipt.data.guildId === proposal.data.guildId &&
              receipt.data.userId === proposal.data.userId &&
              receipt.data.factId === proposal.data.factId,
          );
  check(
    "approved fact recalled",
    recalled !== undefined,
    recalled
      ? "the exact proposed fact id became visible through governed Discord recall"
      : "the proposed fact id has not been recalled from Discord",
  );

  const restarted =
    proposal !== undefined &&
    recalled !== undefined &&
    recalled.data.controlPlaneInstanceId !== proposal.data.controlPlaneInstanceId;
  check(
    "control-plane restart durability",
    restarted,
    restarted
      ? "the approved fact was recalled from a different control-plane process instance"
      : "matching proposal/recall evidence across different control-plane instances is absent",
  );

  return {
    schemaVersion: 1,
    passed: checks.every((entry) => entry.ok),
    receiptCount: receipts.length,
    checks,
  };
}

/** Requires one DAVE session with three explicitly consented, speaker-attributed human round trips. */
export function evaluateDiscordVoiceLiveProof(
  receipts: readonly DiscordBridgeReceipt[],
): DiscordVoiceLiveProofReport {
  const checks: DiscordLiveProofCheck[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };
  const joined = receipts.find(
    (receipt) =>
      receipt.type === "discord.voice.joined" &&
      typeof receipt.data.guildId === "string" &&
      typeof receipt.data.channelId === "string" &&
      typeof receipt.data.daveProtocolVersion === "number" &&
      receipt.data.daveProtocolVersion > 0,
  );
  check(
    "DAVE voice session",
    joined !== undefined,
    joined ? "official-bot voice joined with a positive DAVE protocol version" : "no DAVE-ready join receipt",
  );
  const sessionReceipts =
    joined === undefined
      ? []
      : receipts.slice(receipts.indexOf(joined) + 1).filter((receipt) => {
          if (
            receipt.type === "discord.voice.left" &&
            receipt.data.guildId === joined.data.guildId &&
            receipt.data.channelId === joined.data.channelId
          ) {
            return true;
          }
          return (
            receipt.data.guildId === joined.data.guildId && receipt.data.channelId === joined.data.channelId
          );
        });
  const leftIndex = sessionReceipts.findIndex((receipt) => receipt.type === "discord.voice.left");
  const activeReceipts = leftIndex < 0 ? sessionReceipts : sessionReceipts.slice(0, leftIndex);
  const consented = new Set(
    activeReceipts
      .filter(
        (receipt) =>
          receipt.type === "discord.voice.consent" &&
          receipt.data.consented === true &&
          typeof receipt.data.userId === "string",
      )
      .map((receipt) => String(receipt.data.userId)),
  );
  check(
    "three explicit participants",
    consented.size >= 3,
    `${String(consented.size)} unique participant consent receipt(s) observed`,
  );
  const utterances = activeReceipts.filter(
    (receipt) =>
      receipt.type === "discord.voice.utterance" &&
      typeof receipt.data.userId === "string" &&
      typeof receipt.data.deliveryId === "string",
  );
  const speakers = new Set(utterances.map((receipt) => String(receipt.data.userId)));
  check(
    "three attributed speakers",
    speakers.size >= 3 && [...speakers].every((userId) => consented.has(userId)),
    `${String(speakers.size)} unique explicitly consented speaker(s) produced bounded utterances`,
  );
  const respondedSpeakers = new Set(
    utterances
      .filter((utterance) =>
        activeReceipts.some(
          (receipt) =>
            receipt.type === "discord.voice.response" &&
            receipt.data.deliveryId === utterance.data.deliveryId &&
            typeof receipt.data.turnId === "string",
        ),
      )
      .map((utterance) => String(utterance.data.userId)),
  );
  const failures = activeReceipts.filter((receipt) => receipt.type === "discord.voice.failed");
  check(
    "speech round trips",
    respondedSpeakers.size >= 3 && failures.length === 0,
    `${String(respondedSpeakers.size)} speaker(s) received a spoken response; ${String(failures.length)} failure receipt(s)`,
  );
  const overlap = activeReceipts.find((receipt) => receipt.type === "discord.voice.overlap");
  const interruption = activeReceipts.find((receipt) => receipt.type === "discord.voice.interrupted");
  check(
    "overlap and barge-in",
    overlap !== undefined && interruption !== undefined,
    overlap !== undefined && interruption !== undefined
      ? "simultaneous speaker capture and synthesized-response interruption were both observed"
      : "a matching overlap and interruption receipt pair is absent",
  );
  check(
    "clean leave",
    leftIndex >= 0,
    leftIndex >= 0 ? "voice session ended with an explicit leave receipt" : "no matching leave receipt",
  );
  const mainLeaveReceipt = leftIndex < 0 ? undefined : sessionReceipts[leftIndex];
  const mainLeaveGlobalIndex = mainLeaveReceipt === undefined ? -1 : receipts.indexOf(mainLeaveReceipt);
  const rejoined =
    mainLeaveGlobalIndex < 0
      ? undefined
      : receipts
          .slice(mainLeaveGlobalIndex + 1)
          .find(
            (receipt) =>
              receipt.type === "discord.voice.joined" &&
              receipt.data.guildId === joined?.data.guildId &&
              receipt.data.channelId === joined?.data.channelId &&
              typeof receipt.data.daveProtocolVersion === "number" &&
              receipt.data.daveProtocolVersion > 0,
          );
  const rejoinIndex = rejoined === undefined ? -1 : receipts.indexOf(rejoined);
  const reconnectedLeave =
    rejoinIndex < 0
      ? undefined
      : receipts
          .slice(rejoinIndex + 1)
          .find(
            (receipt) =>
              receipt.type === "discord.voice.left" &&
              receipt.data.guildId === joined?.data.guildId &&
              receipt.data.channelId === joined?.data.channelId,
          );
  check(
    "DAVE reconnect",
    rejoined !== undefined && reconnectedLeave !== undefined,
    rejoined !== undefined && reconnectedLeave !== undefined
      ? "the same allowlisted channel rejoined with DAVE and stopped cleanly"
      : "no complete leave/rejoin/leave DAVE recovery sequence",
  );

  return {
    schemaVersion: 1,
    passed: checks.every((entry) => entry.ok),
    receiptCount: receipts.length,
    checks,
  };
}

export async function readDiscordLiveReceipts(
  path: string,
  maximumBytes = 10 * 1024 * 1024,
): Promise<DiscordBridgeReceipt[]> {
  let target;
  try {
    target = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!target.isFile() || target.isSymbolicLink()) {
    throw new Error(`Discord receipt path must be a regular file, not a symlink: ${path}`);
  }
  if (target.size > maximumBytes) {
    throw new Error(`Discord receipt file exceeds the ${maximumBytes.toString()} byte proof limit`);
  }
  const raw = await readFile(path, "utf8");
  return raw
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => parseDiscordBridgeReceipt(JSON.parse(line)));
}
