import { remoteProgramCommand, type HerdrFleet, type FleetShellRun } from "../herdr-fleet.ts";
import type { HireCheckoutFreshness } from "@clankie/settings";

/** Runs on the enrolled machine; local filesystem facts cannot verify a PC checkout. */
export function remoteCheckoutProgram(path: string): string {
  const encoded = Buffer.from(path).toString("base64");
  return `const {execFileSync}=require('node:child_process');
const {statSync}=require('node:fs');
const path=Buffer.from('${encoded}','base64').toString('utf8');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
const git=(args)=>execFileSync('git',['--no-optional-locks','-C',path,...args],{env,encoding:'utf8',timeout:60000,maxBuffer:4194304,stdio:['ignore','pipe','pipe']});
let result;
try {
  if(!statSync(path).isDirectory()) throw Error('Start directory unavailable');
  let root;
  try { root=git(['rev-parse','--show-toplevel']).trim(); }
  catch(error) { if(!/not a git repository/i.test(String(error.stderr||''))) throw error; result={outcome:'not-repository',path}; }
  if(root) {
    git(['fetch','--no-tags','origin','+refs/heads/main:refs/remotes/origin/main']);
    const remoteMain=git(['rev-parse','--verify','origin/main^{commit}']).trim();
    const head=git(['rev-parse','HEAD']).trim();
    const dirty=git(['status','--porcelain=v1','-z','--no-renames','--untracked-files=normal']).split('\\0').filter(Boolean).map(entry=>entry.slice(3));
    if(dirty.length) result={outcome:'refused',path:root,head,remoteMain,reason:'Start checkout is dirty: '+dirty.slice(0,20).map(file=>JSON.stringify(file)).join(', ')+(dirty.length>20?' (more files omitted)':'')+'; preserve it and create a clean worktree from origin/main'};
    else {
      try {git(['merge-base','--is-ancestor',remoteMain,head]);result={outcome:'fresh',path:root,head,remoteMain};}
      catch {result={outcome:'refused',path:root,head,remoteMain,reason:'Start checkout does not contain fetched origin/main'};}
    }
  }
} catch { result={outcome:'refused',path,reason:'Cannot verify fresh origin/main on the remote machine'}; }
process.stdout.write(JSON.stringify(result));`;
}
export async function verifyRemoteHireCheckout(
  fleet: HerdrFleet,
  shell: FleetShellRun,
  path: string,
): Promise<HireCheckoutFreshness> {
  try {
    const raw = await shell(
      remoteProgramCommand(fleet.ssh.shell, "node", ["-e", remoteCheckoutProgram(path)]),
      75_000,
    );
    const result = JSON.parse(raw) as HireCheckoutFreshness;
    if (
      !["fresh", "not-repository", "refused"].includes(result.outcome) ||
      typeof result.path !== "string" ||
      (result.outcome === "fresh" &&
        (!/^[a-f0-9]{40,64}$/u.test(result.head ?? "") ||
          !/^[a-f0-9]{40,64}$/u.test(result.remoteMain ?? "")))
    )
      throw Error("Malformed freshness observation");
    return result;
  } catch {
    return { outcome: "refused", path, reason: "Remote checkout freshness unavailable; no hire was started" };
  }
}
