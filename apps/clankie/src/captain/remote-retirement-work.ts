import { z } from "zod";
import { WorktreeReconciliationSchema, type WorktreeReconciliation } from "@clankie/protocol";
import { remoteProgramCommand, type HerdrFleet, type FleetShellRun } from "../herdr-fleet.ts";

/** Read-only host-side Git observations. Never use this machine's Git for a remote pane. */
export function retirementWorkProgram(directories: readonly string[]): string {
  const encoded = Buffer.from(JSON.stringify(directories)).toString("base64");
  return `const {execFileSync}=require('node:child_process');
const {statSync}=require('node:fs');
const paths=JSON.parse(Buffer.from('${encoded}','base64').toString('utf8'));
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
const results=new Map();
for(const path of paths) {
  let root=path;
  const git=(args)=>execFileSync('git',['--no-optional-locks','-C',root,...args],{env,encoding:'utf8',timeout:15000,maxBuffer:4194304,stdio:['ignore','pipe','pipe']});
  try {
    if(!statSync(path).isDirectory()) throw Error('Directory unavailable');
    try {root=git(['rev-parse','--show-toplevel']).trim();}
    catch(error) {if(/not a git repository/i.test(String(error.stderr||''))) continue; throw error;}
    const head=git(['rev-parse','--verify','HEAD^{commit}']).trim();
    const status=git(['status','--porcelain=v1','-z','--no-renames','--untracked-files=normal']);
    let base; try {base=git(['rev-parse','--verify','origin/main^{commit}']).trim();}
    catch {base=git(['rev-parse','--verify','refs/remotes/origin/HEAD^{commit}']).trim();}
    let unlandedCommits=0;
    try {git(['merge-base','--is-ancestor',head,base]);}
    catch(error) {
      if(error.status!==1) throw error;
      unlandedCommits=git(['cherry',base,head]).split('\\n').filter(line=>line.startsWith('+ ')).length;
      unlandedCommits+=Number(git(['rev-list','--count','--merges',base+'..'+head]).trim());
    }
    const dirtyFiles=status.split('\\0').filter(Boolean).length;
    if(git(['rev-parse','HEAD']).trim()!==head || git(['status','--porcelain=v1','-z','--no-renames','--untracked-files=normal'])!==status) throw Error('Worktree changed during observation');
    results.set(root,{path:root,head,dirtyFiles,unlandedCommits,state:dirtyFiles||unlandedCommits?'unreconciled':'reconciled'});
  } catch {results.set(root,{path:root,state:'unknown',reason:'Remote Git observation unavailable or changed'});}
}
process.stdout.write(JSON.stringify([...results.values()].filter(work=>work.state!=='reconciled')));`;
}
export async function remoteRetirementWork(
  fleet: HerdrFleet,
  shell: FleetShellRun,
  directories: readonly string[],
): Promise<WorktreeReconciliation[]> {
  try {
    return z
      .array(WorktreeReconciliationSchema)
      .parse(
        JSON.parse(
          await shell(
            remoteProgramCommand(fleet.ssh.shell, "node", ["-e", retirementWorkProgram(directories)]),
            60_000,
          ),
        ),
      );
  } catch {
    return directories.map((path) => ({
      path,
      state: "unknown",
      reason: "Remote work evidence unavailable",
    }));
  }
}
