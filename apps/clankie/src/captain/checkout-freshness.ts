import { remoteProgramCommand, type HerdrFleet, type FleetShellRun } from "../herdr-fleet.ts";
import { hireWorktreeSlug, hireWorktreeStart, type HireCheckoutFreshness } from "@clankie/settings";
import { redactSensitiveText } from "@clankie/observability";

function diagnostic(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(text.replace(/\b(?:https?|ssh):\/\/[^\s"'`]+/giu, "[redacted-url]")).slice(
    0,
    2_000,
  );
}

/**
 * Runs on the enrolled machine; local filesystem facts cannot verify a PC checkout. With a
 * worktree slug, a start checkout the hire must not take over is left exactly as it is and the
 * hire gets `<start>/.local/wt-<slug>-<hex>`, a new branch from fetched origin/main.
 */
export function remoteCheckoutProgram(
  path: string,
  paneDirectories: string[] | null = [],
  worktreeSlug = "",
): string {
  if (worktreeSlug && !/^[a-z0-9-]{1,24}$/u.test(worktreeSlug)) throw Error("Malformed worktree slug");
  const encoded = Buffer.from(path).toString("base64");
  const census = Buffer.from(JSON.stringify(paneDirectories ?? null)).toString("base64");
  return `const {execFileSync}=require('node:child_process');
const {statSync,realpathSync,mkdirSync,appendFileSync}=require('node:fs');
const {relative,isAbsolute,join,sep,dirname}=require('node:path');
const {homedir}=require('node:os');
const panes=JSON.parse(Buffer.from('${census}','base64').toString('utf8'));
const path=Buffer.from('${encoded}','base64').toString('utf8');
const slug='${worktreeSlug}';
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
const git=(args,at=path)=>execFileSync('git',['--no-optional-locks','-C',at,...args],{env,encoding:'utf8',timeout:60000,maxBuffer:4194304,stdio:['ignore','pipe','pipe']});
const contains=(parent,child)=>{const rel=relative(parent,child);return !rel || (!isAbsolute(rel) && rel!=='..' && !rel.startsWith('..'+sep));};
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
    const canonical=realpathSync(root);
    const managed=()=>{
      for(const name of ['pinned','runtimes','updates']) {
        const target=join(homedir(),'.clankie',name);
        const targets=[target];
        try {targets.push(realpathSync(target));} catch {}
        if(targets.some(entry=>contains(entry,canonical)||contains(canonical,entry))) throw Error('Managed runtime checkout');
      }
    };
    const leave=(why,refusal=why)=>{
      if(!slug) return {outcome:'refused',path:root,head,remoteMain,reason:refusal};
      try {
        managed();
        const tag=slug+'-'+require('node:crypto').randomBytes(3).toString('hex');
        const dir=join(root,'.local','wt-'+tag), branch='clankie/'+tag;
        try {git(['check-ignore','-q','.local/']);}
        catch(error) {
          if(error.status!==1) throw error;
          const exclude=git(['rev-parse','--path-format=absolute','--git-path','info/exclude']).trim();
          mkdirSync(dirname(exclude),{recursive:true});
          appendFileSync(exclude,'\\n# Clankie hire worktrees\\n/.local/\\n');
        }
        mkdirSync(join(root,'.local'),{recursive:true});
        git(['-c','core.hooksPath=/dev/null','worktree','add','--no-track','-b',branch,dir,remoteMain]);
        const made=git(['rev-parse','HEAD'],dir).trim();
        if(made!==remoteMain || git(['status','--porcelain=v1','-z','--untracked-files=normal'],dir)) throw Error('The new worktree is not a clean origin/main');
        const place=relative(canonical,realpathSync(path));
        let cwd=dir;
        if(place && !isAbsolute(place) && !place.startsWith('..')) try {if(statSync(join(dir,place)).isDirectory()) cwd=join(dir,place);} catch {}
        return {outcome:'worktree',path:dir,workingDirectory:cwd,branch,start:root,startReason:why,head:made,remoteMain};
      } catch(error) {
        return {outcome:'refused',path:root,head,remoteMain,reason:why+'; a worktree from origin/main could not be made: '+String(error.stderr||error.message||error).trim().slice(0,2000)};
      }
    };
    const dirty=git(['status','--porcelain=v1','-z','--no-renames','--untracked-files=normal']).split('\\0').filter(Boolean).map(entry=>entry.slice(3));
    if(dirty.length) result=leave('Start checkout has uncommitted changes in '+dirty.length+(dirty.length===1?' file':' files'),'Start checkout is dirty: '+dirty.slice(0,20).map(file=>JSON.stringify(file)).join(', ')+(dirty.length>20?' (more files omitted)':'')+'; preserve it and create a clean worktree from origin/main');
    else {
      try {git(['merge-base','--is-ancestor',remoteMain,head]);result={outcome:'fresh',path:root,head,remoteMain};}
      catch {
        let diverged=false;
        try {git(['merge-base','--is-ancestor',head,remoteMain]);} catch(error) {if(!slug||error.status!==1) throw error; diverged=true;}
        const advance=()=>{
          if(panes===null) throw Error('Live checkout census unavailable');
          managed();
          for(const directory of panes) {
            let resolved;
            try {resolved=realpathSync(directory);} catch(error) {throw Error('Live pane checkout unavailable: '+JSON.stringify(directory)+': '+error.message);}
            if(contains(canonical,resolved)) throw Error('Start checkout belongs to a live pane: '+JSON.stringify(directory));
          }
          if(git(['rev-parse','HEAD']).trim()!==head || git(['status','--porcelain=v1','-z','--untracked-files=normal'])) throw Error('Checkout changed');
          git(['-c','core.hooksPath=/dev/null','-c','merge.autoStash=false','merge','--ff-only','--no-autostash','--no-overwrite-ignore',remoteMain]);
          head=git(['rev-parse','HEAD']).trim();
          git(['merge-base','--is-ancestor',remoteMain,head]);
          if(git(['status','--porcelain=v1','-z','--untracked-files=normal'])) throw Error('Checkout changed during fast-forward');
          return {outcome:'fresh',path:root,head,remoteMain};
        };
        if(diverged) result=leave('Start checkout has commits that origin/main does not');
        else if(!slug) result=advance();
        else try {result=advance();} catch(error) {
          if(error.message==='Managed runtime checkout') throw error;
          result=leave('Start checkout was not advanced: '+String(error.stderr||error.message||error).trim().split('\\n')[0].slice(0,500));
        }
      }
    }
  }
} catch(error) { result={outcome:'refused',path,reason:'Cannot verify fresh origin/main on the remote machine: '+String(error.stderr||error.message||error).trim().slice(0,2000)}; }
process.stdout.write(JSON.stringify(result));`;
}
export async function verifyRemoteHireCheckout(
  fleet: HerdrFleet,
  shell: FleetShellRun,
  path: string,
  paneDirectories: string[] | null = [],
  worktreeName?: string,
): Promise<HireCheckoutFreshness> {
  try {
    const slug = worktreeName === undefined ? "" : hireWorktreeSlug(worktreeName);
    const raw = await shell(
      remoteProgramCommand(fleet.ssh.shell, "node", [
        "-e",
        remoteCheckoutProgram(path, paneDirectories, slug),
      ]),
      75_000,
    );
    const result = JSON.parse(raw) as HireCheckoutFreshness;
    // The PC answers with its own separators; compare as that machine would.
    const normal = (value: string | undefined) =>
      fleet.ssh.shell === "posix"
        ? (value ?? "").replace(/\/+$/u, "")
        : (value ?? "").replaceAll("/", "\\").replace(/\\+$/u, "").toLowerCase();
    const sha = (value: string | undefined) => /^[a-f0-9]{40,64}$/u.test(value ?? "");
    if (
      !["fresh", "worktree", "not-repository", "refused"].includes(result.outcome) ||
      typeof result.path !== "string" ||
      ((result.outcome === "fresh" || result.outcome === "worktree") &&
        (!sha(result.head) || !sha(result.remoteMain))) ||
      (result.outcome === "worktree" &&
        (!slug ||
          result.head !== result.remoteMain ||
          typeof result.start !== "string" ||
          typeof result.startReason !== "string" ||
          typeof result.workingDirectory !== "string" ||
          !result.branch?.startsWith(`clankie/${slug}-`) ||
          normal(hireWorktreeStart(result.path)) !== normal(result.start) ||
          !(
            normal(result.workingDirectory) === normal(result.path) ||
            normal(result.workingDirectory).startsWith(
              `${normal(result.path)}${fleet.ssh.shell === "posix" ? "/" : "\\"}`,
            )
          )))
    )
      throw Error("Malformed freshness observation");
    return result.outcome === "refused" && result.reason
      ? { ...result, reason: diagnostic(result.reason) }
      : result;
  } catch (error) {
    return {
      outcome: "refused",
      path,
      reason: `Remote checkout freshness unavailable; no hire was started: ${diagnostic(error)}`,
    };
  }
}
