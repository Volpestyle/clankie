#!/usr/bin/env python3
"""Build/upload/install the guest in a bounded SSM test run; ALWAYS stop EC2.
Administrator provisioning only. No credentials included in artifacts or SSM.
"""
import argparse, json, os, pathlib, subprocess, tarfile, tempfile, time, uuid
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--account',required=True); p.add_argument('--instance',required=True); p.add_argument('--region',default='us-east-1')
a=p.parse_args()
def aws(service, operation, **kw):
 r=subprocess.run(['aws','--region',a.region,service,operation,'--cli-input-json',json.dumps(kw),'--output','json'],capture_output=True,text=True)
 if r.returncode: raise RuntimeError(f'{service} {operation}: {r.stderr}')
 return json.loads(r.stdout) if r.stdout.strip() else {}
if aws('sts','get-caller-identity')['Account'] != a.account:
 raise SystemExit('Wrong account')
def require_stopped_target():
 reservations=aws('ec2','describe-instances',InstanceIds=[a.instance])['Reservations']
 if len(reservations) != 1 or reservations[0].get('OwnerId') != a.account:
  raise SystemExit('Target instance owner does not match requested account')
 instances=reservations[0]['Instances']
 if len(instances) != 1 or instances[0]['InstanceId'] != a.instance or instances[0]['State']['Name'] != 'stopped':
  raise SystemExit('Deployment requires the exact target instance to be stopped')
require_stopped_target()
alarm=aws('cloudwatch','describe-alarms',AlarmNames=[f'clankie-minecraft-idle-{a.instance}'])['MetricAlarms']
if not (alarm and alarm[0]['ActionsEnabled'] and f'arn:aws:automate:{a.region}:ec2:stop' in alarm[0]['AlarmActions']):
 raise SystemExit('Stop alarm required')
root=pathlib.Path(__file__).resolve().parents[4]
bucket=f'clankie-minecraft-install-{a.account}-{uuid.uuid4().hex[:8]}'
with tempfile.TemporaryDirectory() as tmp:
 bundle=pathlib.Path(tmp)/'aws-guest.mjs'
 subprocess.run([str(root/'node_modules/.bin/esbuild'),str(root/'integrations/minecraft-mcp/src/aws-guest.ts'),'--bundle','--platform=node','--format=esm','--target=node24','--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',f'--outfile={bundle}'],check=True)
 archive=pathlib.Path(tmp)/'guest.tar.gz'
 with tarfile.open(archive,'w:gz') as tf:
  tf.add(bundle,arcname='aws-guest.mjs');tf.add(pathlib.Path(__file__).with_name('install-guest.sh'),arcname='install-guest.sh')
 aws('s3api','create-bucket',Bucket=bucket,**({} if a.region=='us-east-1' else {'CreateBucketConfiguration':{'LocationConstraint':a.region}}))
 start_attempted=False
 try:
  aws('s3api','put-public-access-block',Bucket=bucket,PublicAccessBlockConfiguration={k:True for k in ['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets']})
  aws('s3api','put-bucket-tagging',Bucket=bucket,Tagging={'TagSet':[{'Key':'clankie:purpose','Value':'minecraft'}]})
  aws('s3api','put-bucket-lifecycle-configuration',Bucket=bucket,LifecycleConfiguration={'Rules':[{'ID':'expire-installer','Status':'Enabled','Filter':{'Prefix':''},'Expiration':{'Days':1}}]})
  subprocess.run(['aws','--region',a.region,'s3api','put-object','--bucket',bucket,'--key','guest.tar.gz','--body',str(archive),'--server-side-encryption','AES256','--tagging','clankie%3Apurpose=minecraft'],check=True,capture_output=True)
  url=subprocess.check_output(['aws','--region',a.region,'s3','presign',f's3://{bucket}/guest.tar.gz','--expires-in','900'],text=True).strip()
  # Recheck after artifact preparation: another operator may have started it.
  require_stopped_target()
  start_attempted=True
  started=aws('ec2','start-instances',InstanceIds=[a.instance])['StartingInstances']
  if len(started) != 1 or started[0]['InstanceId'] != a.instance or started[0]['PreviousState']['Name'] != 'stopped':
   start_attempted=False
   raise RuntimeError('Instance start raced another operator; refusing to stop their run')
  deadline=time.monotonic()+180
  while time.monotonic()<deadline:
   info=aws('ssm','describe-instance-information',Filters=[{'Key':'InstanceIds','Values':[a.instance]}])['InstanceInformationList']
   if info and info[0]['PingStatus']=='Online':break
   time.sleep(5)
  else:raise RuntimeError('SSM did not become online')
  command=f"set -eu\nshutdown -h +20\nmkdir -p /opt/clankie-minecraft\ncurl --fail --silent --show-error '{url}' -o /tmp/clankie-guest.tar.gz\ntar -xzf /tmp/clankie-guest.tar.gz -C /opt/clankie-minecraft\nrm /tmp/clankie-guest.tar.gz\nbash /opt/clankie-minecraft/install-guest.sh\n/usr/local/bin/node --version\njava -version\nfree -m\nsystemctl list-timers --all | grep clankie"
  cid=aws('ssm','send-command',InstanceIds=[a.instance],DocumentName='AWS-RunShellScript',Parameters={'commands':[command],'executionTimeout':['900']})['Command']['CommandId']
  print('Installation command:',cid,flush=True)
  deadline=time.monotonic()+950
  while time.monotonic()<deadline:
   try: result=aws('ssm','get-command-invocation',CommandId=cid,InstanceId=a.instance)
   except RuntimeError:time.sleep(3);continue
   if result['Status'] not in ['Pending','InProgress','Delayed']:
    print(json.dumps({'Status':result['Status'],'outputTail':result.get('StandardOutputContent','')[-2000:],'errorTail':result.get('StandardErrorContent','')[-1000:]}),flush=True)
    if result['Status']!='Success':raise RuntimeError('Guest installation failed')
    break
   time.sleep(5)
  else:raise RuntimeError('Guest installation deadline')
 finally:
  if start_attempted:
   aws('ec2','stop-instances',InstanceIds=[a.instance])
   subprocess.run(['aws','--region',a.region,'ec2','wait','instance-stopped','--instance-ids',a.instance],check=True)
   print('Verified EC2 STOPPED',flush=True)
  aws('s3api','delete-object',Bucket=bucket,Key='guest.tar.gz')
  aws('s3api','delete-bucket',Bucket=bucket)
  print('Deleted temporary installer bucket',bucket,flush=True)
