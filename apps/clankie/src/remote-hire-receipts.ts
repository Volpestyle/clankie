import { createHash, randomBytes } from "node:crypto";
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

/**
 * The host program is installed once per version under a content-addressed
 * name, then each operation sends only a small loader and its request. Inlining
 * the whole program on every call outgrew the Windows command line (VUH-1780).
 * The loader hashes the bytes it read and evaluates exactly those bytes; a
 * missing or different file refuses before the program runs, so nothing on the
 * host changed and the service may install and dispatch the same request again.
 */
export const REMOTE_HIRE_RECEIPT_PROGRAM_DIGEST = createHash("sha256")
  .update(REMOTE_HIRE_RECEIPT_PROGRAM)
  .digest("hex");
const PROGRAM_MISSING = "clankie-hire-receipt-program-missing-";
/** Windows caps a command line near 32,767 characters; this guard keeps room for SSH. */
export const REMOTE_HIRE_RECEIPT_COMMAND_BOUND = 30_000;
/** Base64 characters of the compressed program per install call. */
const INSTALL_CHUNK = 1_500;

const PROGRAM_DIRECTORY = `const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");const directory=path.join(os.homedir(),".clankie","hire-receipt-programs");const sha=(bytes)=>crypto.createHash("sha256").update(bytes).digest("hex");`;

const LOADER = `${PROGRAM_DIRECTORY}const [digest,refusal,request]=process.argv.slice(1);let bytes;try{const file=path.join(directory,digest+".js");if(!fs.lstatSync(directory).isDirectory()||!fs.lstatSync(file).isFile())throw 0;bytes=fs.readFileSync(file)}catch{}if(bytes===undefined||sha(bytes)!==digest){process.stderr.write(refusal+"\\n");process.exitCode=3}else Promise.resolve().then(()=>eval("("+bytes.toString("utf8")+")")(JSON.parse(request))).then(value=>process.stdout.write(JSON.stringify(value)+"\\n")).catch(error=>{process.stderr.write(error.message+"\\n");process.exitCode=1})`;

// Parts are content-addressed, written atomically and only ever joined into the
// program file after the joined bytes match the digest.
const INSTALLER = `${PROGRAM_DIRECTORY}const zlib=require("node:zlib");try{const [digest,index,count,chunk]=process.argv.slice(1);if(!/^[0-9a-f]{64}$/.test(digest)||!/^[0-9]+$/.test(index)||!/^[1-9][0-9]*$/.test(count)||+index>=+count||!/^[A-Za-z0-9+/=]+$/.test(chunk))throw new Error("Invalid hire receipt program chunk");fs.mkdirSync(directory,{recursive:true,mode:0o700});const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error("Hire receipt program directory is not a plain directory");const save=(file,data)=>{const temporary=file+"."+crypto.randomUUID()+".tmp";fs.writeFileSync(temporary,data,{flag:"wx",mode:0o600});fs.renameSync(temporary,file)};const part=(i)=>path.join(directory,digest+"."+i+"-of-"+count+".part");save(part(index),chunk);const parts=[];for(let i=0;i<+count;i++){try{parts.push(fs.readFileSync(part(i),"utf8"))}catch{break}}let installed=false;if(parts.length===+count){let bytes;try{bytes=zlib.inflateRawSync(Buffer.from(parts.join(""),"base64"))}catch{}for(let i=0;i<+count;i++)fs.rmSync(part(i),{force:true});if(bytes===undefined||sha(bytes)!==digest)throw new Error("Installed hire receipt program did not match its digest");save(path.join(directory,digest+".js"),bytes);installed=true}process.stdout.write(JSON.stringify({installed})+"\\n")}catch(error){process.stderr.write(error.message+"\\n");process.exitCode=1}`;

function boundedCommand(shell: RemoteHireClaim["target"]["shell"], argv: readonly string[]): string {
  const command = remoteProgramCommand(shell, "node", argv);
  if (shell === "powershell" && command.length > REMOTE_HIRE_RECEIPT_COMMAND_BOUND)
    throw new Error("Remote hire receipt command exceeds the Windows command-line bound; nothing dispatched");
  return command;
}

/** One host operation: the loader, the installed program's digest and the service-authored request. */
export function remoteHireReceiptCommand(
  claim: RemoteHireClaim,
  op: "reserve" | "launch" | "seal" | "recover",
  recovery?: RemoteHireRecovery,
  /** Printed only by the loader's refusal; unique per dispatch so no program output can imitate it. */
  refusal = `${PROGRAM_MISSING}${randomBytes(8).toString("hex")}`,
): string {
  return boundedCommand(claim.target.shell, [
    "-e",
    LOADER,
    REMOTE_HIRE_RECEIPT_PROGRAM_DIGEST,
    refusal,
    JSON.stringify({ op, claim, ...(recovery ? { recovery } : {}) }),
  ]);
}

/** Ordered calls that install this program version on a host; the last one reports `installed`. */
export function remoteHireReceiptInstallCommands(shell: RemoteHireClaim["target"]["shell"]): string[] {
  const compressed = deflateRawSync(Buffer.from(REMOTE_HIRE_RECEIPT_PROGRAM)).toString("base64");
  const count = Math.ceil(compressed.length / INSTALL_CHUNK);
  return Array.from({ length: count }, (_, index) =>
    boundedCommand(shell, [
      "-e",
      INSTALLER,
      REMOTE_HIRE_RECEIPT_PROGRAM_DIGEST,
      String(index),
      String(count),
      compressed.slice(index * INSTALL_CHUNK, (index + 1) * INSTALL_CHUNK),
    ]),
  );
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
    const run = options.shell(fleet);
    const dispatch = (command: string) =>
      run(command, 45_000).then(
        (output) => ({ output }),
        (error: unknown) => {
          const stderr = (error as { stderr?: unknown })?.stderr;
          const detail =
            error instanceof Error && error.name === "HerdrFleetError"
              ? error.message.slice(0, 2000)
              : "Authenticated host operation failed; inspect the original host receipt";
          return {
            error: typeof stderr === "string" && stderr.trim() ? stderr.trim().slice(-2000) : detail,
          };
        },
      );
    const refusal = `${PROGRAM_MISSING}${randomBytes(8).toString("hex")}`;
    const command = remoteHireReceiptCommand(claim, op, recovery, refusal);
    let result = await dispatch(command);
    // Only the loader's own refusal, which precedes the program, admits a second dispatch.
    if ("error" in result && result.error.includes(refusal)) {
      for (const install of remoteHireReceiptInstallCommands(claim.target.shell)) {
        const installed = await dispatch(install);
        if ("error" in installed)
          throw new Error(`Host receipt program install failed; nothing dispatched: ${installed.error}`);
      }
      result = await dispatch(command);
      if ("error" in result && result.error.includes(refusal))
        throw new Error("Host receipt program is not installed; nothing dispatched");
    }
    if ("error" in result) throw new Error(result.error);
    const { output } = result;
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
