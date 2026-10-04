import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const helper = fileURLToPath(new URL("../../../scripts/evals/lead-native-claude-launch.py", import.meta.url));
function fixture(source: string) {
  return execFileSync(
    "python3",
    [
      "-I",
      "-c",
      `import sys,pathlib,types,unittest.mock as mock
m={"__name__":"fixture"}
exec(compile(pathlib.Path(sys.argv[1]).read_text(),sys.argv[1],"exec"),m)
${source}`,
      helper,
    ],
    { encoding: "utf8", timeout: 5000 },
  ).trim();
}
it("pins the info-fd child with an original pidfd, refusing unavailable or exited handles", () => {
  expect(
    fixture(`
for mode in ['live','unavailable','exited','wrong-parent']:
 def opened(pid,flags):
  assert (pid,flags)==(42,0)
  if mode=='unavailable':raise OSError('not supported')
  return 90
 with mock.patch.object(m['os'],'pidfd_open',create=True,side_effect=opened), mock.patch.object(m['os'],'close') as close, mock.patch.object(m['select'],'select',return_value=([90] if mode=='exited' else [],[],[])), mock.patch.dict(m,{'row':lambda pid:{'pid':pid,'parent':8 if mode=='wrong-parent' else 7,'startTicks':'11'}}):
  try:result=m['pin_child'](42,7)
  except (OSError,ValueError):assert mode!='live'
  else:assert mode=='live' and result==(90,{'pid':42,'parent':7,'startTicks':'11'})
  assert close.call_count==(1 if mode in ['exited','wrong-parent'] else 0)
print('ok')`),
  ).toBe("ok");
});
it("never releases a signaled original handle, changed child or exited original launcher", () => {
  expect(
    fixture(`
initial={'pid':42,'startTicks':'11'};launcher={'pid':7,'startTicks':'9'}
for mode in ['live','exited','child-reused','launcher-exited','launcher-reused']:
 child=types.SimpleNamespace(pid=7,poll=lambda:0 if mode=='launcher-exited' else None)
 def row(pid):
  value=dict(initial if pid==42 else launcher)
  if mode==('child-reused' if pid==42 else 'launcher-reused'):value['startTicks']='100'
  return value
 with mock.patch.dict(m,{'row':row}), mock.patch.object(m['select'],'select',return_value=([90] if mode=='exited' else [],[],[])), mock.patch.object(m['os'],'write') as write:
  try:m['release_child'](child,42,initial,launcher,90,91)
  except ValueError:assert mode!='live'
  else:assert mode=='live'
  assert write.call_count==(1 if mode=='live' else 0)
print('ok')`),
  ).toBe("ok");
});
it("rejects exit before or during native observation even when PID and start ticks still match", () => {
  expect(
    fixture(`
row={'pid':42,'startTicks':'11','tty':3,'group':7,'foreground':7}
for mode in ['live','exited-before','exited-after','background','reused']:
 process={**row,'foreground':8 if mode=='background' else 7,'startTicks':'99' if mode=='reused' else '11'}
 capture=types.SimpleNamespace(verify_process=mock.Mock(return_value={'pid':42,'startTicks':'11'}))
 calls=[([90] if mode=='exited-before' else [],[],[]),([90] if mode=='exited-after' else [],[],[])]
 with mock.patch.dict(m,{'row':lambda pid:process}), mock.patch.object(m['select'],'select',side_effect=calls), mock.patch.object(m['os'],'readlink',return_value='ns:42'):
  try:result=m['observe'](capture,{},42,row,90)
  except ValueError:assert mode!='live'
  else:assert mode=='live' and result['root']['pid']==42
  if mode=='exited-before':capture.verify_process.assert_not_called()
print('ok')`),
  ).toBe("ok");
});

it("checks pidfd open and signal support before any native child can be created", () => {
  expect(
    fixture(`
for mode in ['live','open-unavailable','signal-unavailable']:
 def opened(pid,flags):
  if mode=='open-unavailable':raise OSError('unavailable')
  return 90
 def signaled(fd,number):
  assert (fd,number)==(90,0)
  if mode=='signal-unavailable':raise OSError('unavailable')
 with mock.patch.object(m['os'],'pidfd_open',create=True,side_effect=opened), mock.patch.object(m['signal'],'pidfd_send_signal',create=True,side_effect=signaled), mock.patch.object(m['select'],'select',return_value=([],[],[])), mock.patch.object(m['os'],'close') as close:
  try:m['require_pidfd']()
  except OSError:assert mode!='live'
  else:assert mode=='live'
  assert close.call_count==(0 if mode=='open-unavailable' else 1)
print('ok')`),
  ).toBe("ok");
});
it("kills the original native handle and observes exit before closing the EOF-sensitive gate", () => {
  expect(
    fixture(`
calls=[]
child=types.SimpleNamespace(poll=lambda:None,kill=lambda:calls.append('launcher-kill'),wait=lambda timeout:calls.append('launcher-exit'))
def select(read,write,error,timeout):
 calls.append('native-exit-check' if timeout else 'native-live-check')
 return ([90] if timeout else [],[],[])
with mock.patch.object(m['select'],'select',side_effect=select), mock.patch.object(m['signal'],'pidfd_send_signal',create=True,side_effect=lambda fd,number:calls.append('native-kill')), mock.patch.object(m['os'],'close',side_effect=lambda fd:calls.append('close-'+str(fd))):
 m['terminate_owned'](child,90,[80,81,90],None)
assert calls==['native-live-check','native-kill','native-exit-check','launcher-kill','launcher-exit','close-80','close-81','close-90'],calls
print('ok')`),
  ).toBe("ok");
});
it("holds every gate descriptor until exact containment stop when identity or termination is uncertain", () => {
  expect(
    fixture(`
class Parked(Exception):pass
for mode in ['no-identity','kill-refused','kill-timeout','launcher-timeout']:
 calls=[]
 def park(stream):
  calls.append('park-until-container-stop')
  raise Parked()
 def kill(fd,number):
  if mode=='kill-refused':raise PermissionError('refused')
 def select(read,write,error,timeout):return ([90] if timeout and mode!='kill-timeout' else [],[],[])
 def wait(timeout):
  if mode=='launcher-timeout':raise TimeoutError('uncertain')
 child=types.SimpleNamespace(poll=lambda:None,kill=lambda:None,wait=wait)
 with mock.patch.dict(m,{'await_containment_stop':park}), mock.patch.object(m['select'],'select',side_effect=select), mock.patch.object(m['signal'],'pidfd_send_signal',create=True,side_effect=kill), mock.patch.object(m['os'],'close') as close:
  try:m['terminate_owned'](child,None if mode=='no-identity' else 90,[80,81,90],None)
  except Parked:pass
  else:raise AssertionError('uncertain native teardown reported success')
  close.assert_not_called()
  assert calls==['park-until-container-stop']
print('ok')`),
  ).toBe("ok");
});
