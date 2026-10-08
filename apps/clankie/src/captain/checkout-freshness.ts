import { remoteProgramCommand, type HerdrFleet, type FleetShellRun } from "../herdr-fleet.ts";
import type { HireCheckoutFreshness } from "@clankie/settings";

/** Runs on the enrolled machine; local filesystem facts cannot verify a PC checkout. */
export function remoteCheckoutProgram(path: string, paneDirectories: string[] | null = []): string {
  const encoded = Buffer.from(path).toString("base64");
  const census = Buffer.from(JSON.stringify(paneDirectories ?? null)).toString("base64");
  return `const {execFileSync}=require('node:child_process');
const {statSync,realpathSync}=require('node:fs');
const {relative,isAbsolute,join,sep}=require('node:path');
const {homedir}=require('node:os');
const panes=JSON.parse(Buffer.from('${census}','base64').toString('utf8'));
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
    let head=git(['rev-parse','HEAD']).trim();
    const dirty=git(['status','--porcelain=v1','-z','--no-renames','--untracked-files=normal']).split('\\0').filter(Boolean).map(entry=>entry.slice(3));
    if(dirty.length) result={outcome:'refused',path:root,head,remoteMain,reason:'Start checkout is dirty: '+dirty.slice(0,20).map(file=>JSON.stringify(file)).join(', ')+(dirty.length>20?' (more files omitted)':'')+'; preserve it and create a clean worktree from origin/main'};
    else {
      try {git(['merge-base','--is-ancestor',remoteMain,head]);result={outcome:'fresh',path:root,head,remoteMain};}
      catch {
        git(['merge-base','--is-ancestor',head,remoteMain]);
        if(panes===null) throw Error('Live checkout census unavailable');
        const canonical=realpathSync(root);
        const contains=(parent,child)=>{const rel=relative(parent,child);return !rel || (!isAbsolute(rel) && rel!=='..' && !rel.startsWith('..'+sep));};
        for(const name of ['pinned','runtimes','updates']) {
          const managed=join(homedir(),'.clankie',name);
          const targets=[managed];
          try {targets.push(realpathSync(managed));} catch {}
          if(targets.some(target=>contains(target,canonical)||contains(canonical,target))) throw Error('Managed runtime checkout');
        }
        for(const directory of panes) {
          if(contains(canonical,realpathSync(directory))) throw Error('Start checkout belongs to a live pane');
        }
        if(git(['rev-parse','HEAD']).trim()!==head || git(['status','--porcelain=v1','-z','--untracked-files=normal'])) throw Error('Checkout changed');
        git(['-c','core.hooksPath=/dev/null','-c','merge.autoStash=false','merge','--ff-only','--no-autostash','--no-overwrite-ignore',remoteMain]);
        head=git(['rev-parse','HEAD']).trim();
        git(['merge-base','--is-ancestor',remoteMain,head]);
        if(git(['status','--porcelain=v1','-z','--untracked-files=normal'])) throw Error('Checkout changed during fast-forward');
        result={outcome:'fresh',path:root,head,remoteMain};
      }
    }
  }
} catch { result={outcome:'refused',path,reason:'Cannot verify fresh origin/main on the remote machine'}; }
process.stdout.write(JSON.stringify(result));`;
}
export async function verifyRemoteHireCheckout(
  fleet: HerdrFleet,
  shell: FleetShellRun,
  path: string,
  paneDirectories: string[] | null = [],
): Promise<HireCheckoutFreshness> {
  try {
    const raw = await shell(
      remoteProgramCommand(fleet.ssh.shell, "node", ["-e", remoteCheckoutProgram(path, paneDirectories)]),
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
