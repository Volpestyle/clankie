import { z } from "zod";
import { WorktreeReconciliationSchema, type WorktreeReconciliation } from "@clankie/protocol";
import { remoteProgramCommand, type HerdrFleet, type FleetShellRun } from "../herdr-fleet.ts";
import type { WorktreeHoldOptions } from "./worktree-decisions.ts";

/** Read-only host-side Git observations. Never use this machine's Git for a remote pane. */
export function retirementWorkProgram(
  directories: readonly string[],
  options: WorktreeHoldOptions = {},
): string {
  const encoded = Buffer.from(JSON.stringify(directories)).toString("base64");
  return `const {execFileSync}=require('node:child_process');
const {statSync}=require('node:fs');
const paths=JSON.parse(Buffer.from('${encoded}','base64').toString('utf8'));
const requireProof=${options.requireProof === true};
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
const results=new Map();
if(requireProof&&!paths.length) results.set('',{path:'(worker directory unavailable)',state:'unknown',reason:'No verified worker work directory'});
for(const path of paths) {
  let root=path;
  const git=(args)=>execFileSync('git',['--no-optional-locks','-C',root,...args],{env,encoding:'utf8',timeout:15000,maxBuffer:4194304,stdio:['ignore','pipe','pipe']});
  try {
    if(!statSync(path).isDirectory()) throw Error('Directory unavailable');
    try {root=git(['rev-parse','--show-toplevel']).trim();}
    catch(error) {if(!requireProof&&/not a git repository/i.test(String(error.stderr||''))) continue; throw error;}
    const head=git(['rev-parse','--verify','HEAD^{commit}']).trim();
    const status=git(['status','--porcelain=v1','-z','--no-renames','--untracked-files=normal']);
    let base;
    if(requireProof) {
      const advertised=git(['ls-remote','--exit-code','--heads','--','origin','refs/heads/main']).trim().split(/\\s+/);
      if(advertised.length!==2||advertised[1]!=='refs/heads/main'||!(/^[a-f0-9]{40,64}$/).test(advertised[0])) throw Error('Main landing proof unavailable');
      base=advertised[0];
    } else {
      try {base=git(['rev-parse','--verify','origin/main^{commit}']).trim();}
      catch {base=git(['rev-parse','--verify','refs/remotes/origin/HEAD^{commit}']).trim();}
    }
    let unlandedCommits=0;
    try {git(['merge-base','--is-ancestor',head,base]);}
    catch(error) {
      if(error.status!==1) throw error;
      unlandedCommits=requireProof?Number(git(['rev-list','--count',base+'..'+head]).trim()):git(['cherry',base,head]).split('\\n').filter(line=>line.startsWith('+ ')).length;
      if(!requireProof) unlandedCommits+=Number(git(['rev-list','--count','--merges',base+'..'+head]).trim());
    }
    const dirtyFiles=status.split('\\0').filter(Boolean).length;
    if(git(['rev-parse','HEAD']).trim()!==head || git(['status','--porcelain=v1','-z','--no-renames','--untracked-files=normal'])!==status) throw Error('Worktree changed during observation');
    results.set(root,{path:root,head,dirtyFiles,unlandedCommits,state:dirtyFiles||unlandedCommits?'unreconciled':'reconciled'});
  } catch {results.set(root,{path:root,state:'unknown',reason:'Remote Git observation unavailable or changed'});}
}
process.stdout.write(JSON.stringify([...results.values()].filter(work=>requireProof||work.state!=='reconciled')));`;
}
export async function remoteRetirementWork(
  fleet: HerdrFleet,
  shell: FleetShellRun,
  directories: readonly string[],
  options: WorktreeHoldOptions = {},
): Promise<WorktreeReconciliation[]> {
  try {
    return z
      .array(WorktreeReconciliationSchema)
      .parse(
        JSON.parse(
          await shell(
            remoteProgramCommand(fleet.ssh.shell, "node", [
              "-e",
              retirementWorkProgram(directories, options),
            ]),
            60_000,
          ),
        ),
      );
  } catch {
    return (
      directories.length ? directories : options.requireProof ? ["(worker directory unavailable)"] : []
    ).map((path) => ({
      path,
      state: "unknown",
      reason: "Remote work evidence unavailable",
    }));
  }
}
