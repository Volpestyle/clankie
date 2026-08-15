import { lstat, readFile } from "node:fs/promises";
import { parseDiscordBridgeReceipt, type DiscordBridgeReceipt } from "@clankie/discord-presence-core";

export interface StreamWatchLiveProofCheck {
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

export async function readUserSessionReceipts(path: string): Promise<readonly DiscordBridgeReceipt[]> {
  try {
    await lstat(path);
  } catch {
    return [];
  }
  const raw = await readFile(path, "utf8");
  const receipts: DiscordBridgeReceipt[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      receipts.push(parseDiscordBridgeReceipt(JSON.parse(line)));
    } catch {
      // A torn tail line must not fail the gate.
    }
  }
  return receipts;
}

/**
 * Live Discord evidence that he watched a share and decoded a still.
 *
 * Deterministic tests cannot substitute: this reads receipts written only
 * after a real user-session process joined a real Go Live stream.
 */
export function evaluateStreamWatchLiveProof(
  receipts: readonly DiscordBridgeReceipt[],
): StreamWatchLiveProofReport {
  const checks: StreamWatchLiveProofCheck[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  const ready = receipts.find((receipt) => receipt.type === "discord.user_session.ready");
  check("user session ready", ready !== undefined, ready ? "ready receipt observed" : "no ready receipt");

  const connected = receipts.find((receipt) => receipt.type === "discord.stream.watch_connected");
  check(
    "stream watch connected",
    connected !== undefined,
    connected ? "OP20 credentials reached ClankVox" : "no watch_connected receipt",
  );

  const decoderReady = connected?.data.decoder === "ready";
  check(
    "ClankVox decoder present",
    decoderReady,
    decoderReady ? "decoder=ready" : "ClankVox was missing or did not report ready",
  );

  const frame = receipts.find((receipt) => {
    if (receipt.type !== "discord.stream.frame") return false;
    if (connected !== undefined && receipt.occurredAt < connected.occurredAt) return false;
    const connectedUser = connected?.data.userId;
    const frameUser = receipt.data.userId;
    if (typeof connectedUser === "string" && typeof frameUser === "string") {
      return frameUser === connectedUser;
    }
    return true;
  });
  const hasGeometry =
    frame !== undefined && typeof frame.data.width === "number" && typeof frame.data.height === "number";
  check(
    "decoded still",
    hasGeometry,
    hasGeometry
      ? `still ${String(frame.data.width)}x${String(frame.data.height)} from ${String(frame.data.userId ?? "unknown")}`
      : "no decoded still receipt after watch_connected",
  );

  return {
    schemaVersion: 1,
    passed: checks.every((entry) => entry.ok),
    receiptCount: receipts.length,
    checks,
  };
}
