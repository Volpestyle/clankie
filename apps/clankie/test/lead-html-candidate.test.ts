import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

// Only the original trampoline helpers run. The runner is a Python fake; no
// candidate code, native sandbox command, container or benchmark is executed.
const fixture = String.raw`
import importlib.util,json,os,subprocess,tempfile,pathlib,sys
spec=importlib.util.spec_from_file_location('candidate_boundary','scripts/evals/lead-html-candidate.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
mode=sys.argv[1]
with tempfile.TemporaryDirectory() as root:
 root=str(pathlib.Path(root).resolve())
 source=pathlib.Path(root)/'input.html';source.write_text('original')
 runtime={'python':'/usr/bin/python3','pythonSha256':'a'*64,'bwrapSha256':'b'*64,'mounts':[{'path':'/usr'},{'path':'/bin','link':'usr/bin'},{'path':'/lib','link':'usr/lib'}]}
 calls=[]
 def run(argv,**kwargs):
  calls.append({'argv':argv,'environment':kwargs['env']})
  private=pathlib.Path(argv[argv.index('--bind')+1])/source.name
  if mode=='timeout':raise subprocess.TimeoutExpired('fake-boundary',1)
  if mode=='symlink':private.unlink();private.symlink_to(source)
  elif mode=='oversized':private.write_bytes(b'x'*(module.MAX_BYTES+1))
  else:private.write_text('filtered')
  return subprocess.CompletedProcess(argv,0)
 try:
  code=module.run_filter(str(source),runtime,runner=run,temporary_root=root)
  result={'code':code,'content':source.read_text(),'calls':calls}
 except Exception as error:
  result={'error':str(error),'content':source.read_text(),'calls':calls}
 print(json.dumps(result))
`;
function run(mode: string) {
  return JSON.parse(execFileSync("python3", ["-I", "-c", fixture, mode], { encoding: "utf8" }));
}
it("preserves input argv and copies back a regular private result with no grader/log mounts", () => {
  const result = run("rewrite");
  expect(result).toMatchObject({ code: 0, content: "filtered" });
  const call = result.calls[0];
  expect(call.environment).toEqual({});
  expect(call.argv).toEqual(
    expect.arrayContaining([
      "--unshare-all",
      "--disable-userns",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
      "--proc",
    ]),
  );
  expect(call.argv).not.toContain("/tests");
  expect(call.argv).not.toContain("/logs");
  expect(call.argv.at(-2)).toBe("/app/filter.py");
  expect(call.argv.at(-1)).toMatch(/\/input\.html$/);
});
it("never copies back symlink/oversized output or output from uncertain termination", () => {
  for (const mode of ["symlink", "oversized", "timeout"]) {
    expect(run(mode)).toMatchObject({ error: expect.any(String), content: "original" });
  }
});
