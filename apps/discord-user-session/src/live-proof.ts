import type { DiscordBridgeReceipt } from "@clankie/discord-presence-core";
import { VOX_IPC_PROTOCOL_VERSION } from "@clankie/vox-client";

interface StreamWatchLiveProofCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface StreamWatchLiveProofReport {
  readonly schemaVersion: 1;
  readonly passed: boolean;
  readonly receiptCount: number;
  readonly checks: readonly StreamWatchLiveProofCheck[];
}

/** Requires one current-process watch with role transport, positive DAVE, and a decoded still. */
export function evaluateStreamWatchLiveProof(
  receipts: readonly DiscordBridgeReceipt[],
): StreamWatchLiveProofReport {
  const checks: StreamWatchLiveProofCheck[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };
  const ready = latestReady(receipts);
  check(
    "user session ready",
    ready.valid,
    ready.valid ? "fresh gateway and exact Vox protocol receipt observed" : ready.detail,
  );

  const connected = findAfterReady(receipts, ready, "discord.stream.watch_connected");
  check(
    "stream watch connected",
    connected !== undefined,
    connected ? "OP20 credentials reached the shared Vox child" : "no matching watch_connected receipt",
  );

  const roleReady = hasPositiveRoleReadiness(connected);
  check(
    "stream watch DAVE ready",
    roleReady,
    roleReady
      ? `transport and DAVE protocol ${String(connected?.data.daveProtocolVersion)} ready`
      : "matching stream-watch transport and positive DAVE readiness were not both observed",
  );

  const decoderReady = connected?.data.decoder === "ready";
  check(
    "shared Vox decoder present",
    decoderReady,
    decoderReady ? "decoder=ready" : "the shared Vox child was missing or did not report ready",
  );

  const connectedIndex = connected === undefined ? -1 : receipts.indexOf(connected);
  const frame = receipts.find((receipt, index) => {
    if (receipt.type !== "discord.stream.frame" || index <= connectedIndex) return false;
    if (receipt.data.readyId !== ready.id || receipt.occurredAt < (connected?.occurredAt ?? "")) return false;
    const connectedUser = connected?.data.userId;
    const frameUser = receipt.data.userId;
    return typeof connectedUser === "string" && typeof frameUser === "string" && frameUser === connectedUser;
  });
  const hasGeometry =
    frame !== undefined && typeof frame.data.width === "number" && typeof frame.data.height === "number";
  check(
    "decoded still",
    hasGeometry,
    hasGeometry
      ? `still ${String(frame.data.width)}x${String(frame.data.height)} from ${String(frame.data.userId ?? "unknown")}`
      : "no matching decoded still receipt after watch_connected",
  );

  return report(receipts, checks);
}

/** Content-free proof that this process reached an encrypted Go Live publish transport. */
export function evaluateStreamPublishLiveProof(
  receipts: readonly DiscordBridgeReceipt[],
): StreamWatchLiveProofReport {
  const checks: StreamWatchLiveProofCheck[] = [];
  const ready = latestReady(receipts);
  checks.push({
    name: "user session ready",
    ok: ready.valid,
    detail: ready.valid ? "fresh gateway and exact Vox protocol receipt observed" : ready.detail,
  });
  const started = findAfterReady(receipts, ready, "discord.stream.publish_started");
  checks.push({
    name: "stream publish started",
    ok: started !== undefined,
    detail:
      started === undefined
        ? "no matching publish_started receipt after the fresh Vox-ready receipt"
        : "matching publish receipt followed the fresh Vox-ready receipt",
  });
  const opcodesAccepted = started?.data.op18Accepted === true && started.data.op22Accepted === true;
  checks.push({
    name: "publish opcodes accepted",
    ok: opcodesAccepted,
    detail: opcodesAccepted ? "Discord accepted OP18 and OP22" : "OP18 and OP22 acceptance was not proven",
  });
  const roleReady = hasPositiveRoleReadiness(started);
  checks.push({
    name: "stream publish DAVE ready",
    ok: roleReady,
    detail: roleReady
      ? `transport and DAVE protocol ${String(started?.data.daveProtocolVersion)} ready`
      : "matching stream-publish transport and positive DAVE readiness were not both observed",
  });
  const mediaStarted =
    started?.data.mediaStarted === true &&
    positiveInteger(started.data.connectionGeneration) &&
    positiveInteger(started.data.sourceGeneration);
  checks.push({
    name: "first H264 accepted",
    ok: mediaStarted,
    detail: mediaStarted
      ? `Vox accepted first H264 media for connection ${String(started?.data.connectionGeneration)} source ${String(started?.data.sourceGeneration)}`
      : "no matching stream_publish_media_started evidence",
  });
  return report(receipts, checks);
}

function latestReady(receipts: readonly DiscordBridgeReceipt[]): {
  readonly index: number;
  readonly id?: string;
  readonly occurredAt?: string;
  readonly valid: boolean;
  readonly detail: string;
} {
  const index = receipts.findLastIndex((receipt) => receipt.type === "discord.user_session.ready");
  const receipt = receipts[index];
  if (receipt === undefined) return { index, valid: false, detail: "no ready receipt" };
  const id = receipt.data.readyId;
  const valid =
    receipt.data.mediaOwner === "vox" &&
    receipt.data.voxProcessReady === true &&
    receipt.data.protocolVersion === VOX_IPC_PROTOCOL_VERSION &&
    typeof id === "string" &&
    id.length > 0 &&
    Number.isInteger(receipt.data.readySequence) &&
    Number(receipt.data.readySequence) > 0 &&
    validTimestamp(receipt.data.gatewayReadyAt) &&
    validTimestamp(receipt.data.voxProcessReadyAt);
  return {
    index,
    ...(typeof id === "string" ? { id } : {}),
    occurredAt: receipt.occurredAt,
    valid,
    detail: valid ? "ready" : "latest ready receipt lacks exact Vox/gateway migration proof",
  };
}

function findAfterReady(
  receipts: readonly DiscordBridgeReceipt[],
  ready: ReturnType<typeof latestReady>,
  type: "discord.stream.watch_connected" | "discord.stream.publish_started",
): DiscordBridgeReceipt | undefined {
  if (!ready.valid) return undefined;
  return receipts.findLast(
    (receipt, index) =>
      index > ready.index &&
      receipt.type === type &&
      receipt.data.readyId === ready.id &&
      receipt.occurredAt >= (ready.occurredAt ?? ""),
  );
}

function hasPositiveRoleReadiness(receipt: DiscordBridgeReceipt | undefined): boolean {
  return (
    receipt?.data.transportReady === true &&
    receipt.data.daveReady === true &&
    typeof receipt.data.daveProtocolVersion === "number" &&
    receipt.data.daveProtocolVersion > 0
  );
}

function validTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function report(
  receipts: readonly DiscordBridgeReceipt[],
  checks: readonly StreamWatchLiveProofCheck[],
): StreamWatchLiveProofReport {
  return {
    schemaVersion: 1,
    passed: checks.every((entry) => entry.ok),
    receiptCount: receipts.length,
    checks,
  };
}
