import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { deflateRawSync } from "node:zlib";
import {
  HireNoLaunchEvidenceSchema,
  HireRecoveryEvidenceSchema,
  type HireRecoveryEvidence,
  type HireNoLaunchEvidence,
} from "@clankie/protocol";
import { remoteProgramCommand, type FleetShellRun, type HerdrFleet } from "./herdr-fleet.ts";
import { REMOTE_HIRE_RECEIPT_PROGRAM } from "./remote-hire-receipt-program.ts";

export interface RemoteHireClaim {
  receiptId: string;
  receiptKey: string;
  fingerprint: string;
  target: HireNoLaunchEvidence["target"];
  nonce: string;
}
export interface RemoteHireRecovery {
  disposition: "delivered" | "abandoned" | "abandoned-unknown";
  paneId?: string;
  cwd: string;
  harness: string;
  beforeIds?: string[];
  message?: { receiptId: string; seatId: string; binding?: string };
}
export interface RemoteHireReceipts {
  claim(
    fleet: string,
    receipt: Omit<RemoteHireClaim, "target" | "nonce">,
  ): Promise<RemoteHireClaim | undefined>;
  reserve(claim: RemoteHireClaim): Promise<void>;
  launch(claim: RemoteHireClaim): Promise<void>;
  seal(claim: RemoteHireClaim): Promise<HireNoLaunchEvidence>;
  recover(claim: RemoteHireClaim, recovery: RemoteHireRecovery): Promise<HireRecoveryEvidence>;
}

/** Self-contained host program. Only service-authored arguments cross configured SSH. */

export function remoteHireReceiptCommand(
  claim: RemoteHireClaim,
  op: "reserve" | "launch" | "seal" | "recover",
  recovery?: RemoteHireRecovery,
): string {
  const script = `Promise.resolve().then(()=>(${REMOTE_HIRE_RECEIPT_PROGRAM})(${JSON.stringify({ op, claim, ...(recovery ? { recovery } : {}) })})).then(value=>process.stdout.write(JSON.stringify(value)+'\\n')).catch(error=>{process.stderr.write(error.message+'\\n');process.exitCode=1})`;
  const compressed = deflateRawSync(Buffer.from(script)).toString("base64");
  const command = remoteProgramCommand(claim.target.shell, "node", [
    "-e",
    `eval(require('node:zlib').inflateRawSync(Buffer.from('${compressed}','base64')).toString())`,
  ]);
  if (claim.target.shell === "powershell" && command.length > 30_000)
    throw new Error("Remote hire receipt command exceeds the Windows command-line bound; nothing dispatched");
  return command;
}

export function createRemoteHireReceipts(options: {
  fleet(id: string): Promise<HerdrFleet | undefined>;
  /** Only an explicitly known named local runtime may omit the SSH reservation. */
  local?(id: string): Promise<boolean>;
  shell(fleet: HerdrFleet): FleetShellRun;
}): RemoteHireReceipts {
  const target = (fleet: HerdrFleet): RemoteHireClaim["target"] => ({
    fleet: fleet.id,
    host: fleet.ssh.host,
    session: fleet.session,
    shell: fleet.ssh.shell,
  });
  const operation = async (
    claim: RemoteHireClaim,
    op: "reserve" | "launch" | "seal" | "recover",
    recovery?: RemoteHireRecovery,
  ) => {
    const fleet = await options.fleet(claim.target.fleet);
    if (!fleet || !isDeepStrictEqual(target(fleet), claim.target))
      throw new Error("Original remote hire target changed or disconnected");
    const output = await options
      .shell(fleet)(remoteHireReceiptCommand(claim, op, recovery), 45_000)
      .catch((error: unknown) => {
        const stderr = (error as { stderr?: unknown })?.stderr;
        const detail =
          error instanceof Error && error.name === "HerdrFleetError"
            ? error.message.slice(0, 2000)
            : "Authenticated host operation failed; inspect the original host receipt";
        throw new Error(typeof stderr === "string" && stderr.trim() ? stderr.trim().slice(-2000) : detail);
      });
    const current = await options.fleet(claim.target.fleet);
    if (!current || !isDeepStrictEqual(target(current), claim.target))
      throw new Error("Remote hire target changed during observation");
    return JSON.parse(output) as unknown;
  };
  return {
    async claim(id, receipt) {
      const fleet = await options.fleet(id);
      if (!fleet) {
        if (await options.local?.(id)) return undefined;
        throw new Error("Original remote hire target is unavailable; nothing dispatched");
      }
      return { ...receipt, target: target(fleet), nonce: randomBytes(32).toString("hex") };
    },
    async reserve(claim) {
      if (((await operation(claim, "reserve")) as { reserved?: unknown })?.reserved !== true)
        throw new Error("Host reservation was not acknowledged");
    },
    async launch(claim) {
      if (((await operation(claim, "launch")) as { launchCommitted?: unknown })?.launchCommitted !== true)
        throw new Error("Host launch barrier was not acknowledged");
    },
    async recover(claim, recovery) {
      const proof = HireRecoveryEvidenceSchema.parse(await operation(claim, "recover", recovery));
      if (
        proof.receiptId !== claim.receiptId ||
        proof.receiptKey !== claim.receiptKey ||
        proof.fingerprint !== claim.fingerprint ||
        !isDeepStrictEqual(proof.target, claim.target) ||
        proof.disposition !== recovery.disposition ||
        (recovery.disposition === "abandoned-unknown"
          ? !("outcome" in proof.allocation) ||
            recovery.paneId !== undefined ||
            recovery.message !== undefined
          : !("paneId" in proof.allocation) || proof.allocation.paneId !== recovery.paneId) ||
        (recovery.message &&
          (proof.delivery?.receiptId !== recovery.message.receiptId ||
            proof.delivery.seatId !== recovery.message.seatId))
      )
        throw new Error("Host recovery did not match the original receipt");
      return proof;
    },
    async seal(claim) {
      const proof = HireNoLaunchEvidenceSchema.parse(await operation(claim, "seal"));
      if (
        proof.receiptId !== claim.receiptId ||
        proof.receiptKey !== claim.receiptKey ||
        proof.fingerprint !== claim.fingerprint ||
        !isDeepStrictEqual(proof.target, claim.target)
      )
        throw new Error("Host settlement did not match original receipt");
      return proof;
    },
  };
}
