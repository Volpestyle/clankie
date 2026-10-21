import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CompanionAppIdentity, TrustedCompanionApp } from "@clankie/protocol/local-companion";

const run = promisify(execFile);

/** The loopback socket a redeem arrived on, recorded by the primary listener. */
export interface LoopbackPorts {
  readonly client: number;
  readonly server: number;
}

export type CompanionAppVerdict =
  | { readonly ok: true; readonly app: CompanionAppIdentity; readonly trusted: TrustedCompanionApp }
  | {
      readonly ok: false;
      readonly reason: "peer_unknown" | "not_signed" | "untrusted";
      readonly app?: CompanionAppIdentity;
    };

/**
 * Only an app whose running code satisfies an owner-trusted requirement may take
 * the same-Mac handoff (VUH-2604). The process is the one holding the client end
 * of this loopback connection; macOS verifies its code dynamically.
 */
export async function verifyCompanionApp(
  ports: LoopbackPorts,
  trusted: readonly TrustedCompanionApp[],
): Promise<CompanionAppVerdict> {
  const pid = await loopbackClientPid(ports);
  if (pid === undefined) return { ok: false, reason: "peer_unknown" };
  const app = await describeRunningCode(pid);
  if (app.cdhash === undefined) return { ok: false, reason: "not_signed", app };
  for (const candidate of trusted) {
    try {
      await run("codesign", ["--verify", "-R", `=${candidate.requirement}`, String(pid)], {
        timeout: 10_000,
      });
      return { ok: true, app, trusted: candidate };
    } catch {
      // allow-swallowed-rejection -- an unsatisfied requirement is the expected refusal; the next one may match
    }
  }
  return { ok: false, reason: "untrusted", app };
}

/** The other process on a loopback connection to this service, or undefined when it cannot be proven. */
async function loopbackClientPid(ports: LoopbackPorts): Promise<number | undefined> {
  let output: string;
  try {
    ({ stdout: output } = await run(
      "lsof",
      ["-nP", "-a", `-iTCP@127.0.0.1:${ports.client}`, "-sTCP:ESTABLISHED", "-Fpn"],
      { timeout: 10_000 },
    ));
  } catch {
    return undefined;
  }
  // -F output: a `p<pid>` line, then `n<local>-><remote>` for each matching socket.
  const owners = new Set<number>();
  let pid: number | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line === `n127.0.0.1:${ports.client}->127.0.0.1:${ports.server}` && pid !== undefined)
      owners.add(pid);
  }
  owners.delete(process.pid);
  return owners.size === 1 ? [...owners][0] : undefined;
}

async function describeRunningCode(pid: number): Promise<CompanionAppIdentity> {
  let details = "";
  try {
    // codesign writes its description to stderr.
    const { stderr } = await run("codesign", ["-dv", "--verbose=4", String(pid)], { timeout: 10_000 });
    details = stderr;
  } catch (error) {
    details = String((error as { stderr?: unknown }).stderr ?? "");
  }
  const field = (name: string) => new RegExp(`^${name}=(.+)$`, "mu").exec(details)?.[1]?.trim();
  const teamId = field("TeamIdentifier");
  const cdhash = field("CDHash")?.toLowerCase();
  return {
    pid,
    ...(field("Identifier") === undefined ? {} : { identifier: field("Identifier")! }),
    ...(teamId === undefined || teamId === "not set" ? {} : { teamId }),
    ...(cdhash === undefined || !/^[a-f0-9]{40,64}$/u.test(cdhash) ? {} : { cdhash }),
    ...(field("Executable") === undefined ? {} : { path: field("Executable")! }),
  };
}
