#!/usr/bin/env python3
"""Provision guardrails for one EXISTING stopped Minecraft instance.

Run with administrator AWS_PROFILE, explicit account/instance/snapshot/email.
No access keys are created and no instance is started. Preserve the pre-change
snapshot. Guest setup and product broker credentials are separate steps.
"""
import argparse
import json
import subprocess
import time


def aws(service, operation, **kwargs):
    for attempt in range(6):
        result = subprocess.run(
            ['aws', '--region', args.region, service, operation, '--cli-input-json', json.dumps(kwargs), '--output', 'json'],
            capture_output=True, text=True)
        if result.returncode == 0:
            return json.loads(result.stdout) if result.stdout.strip() else {}
        if operation == 'associate-iam-instance-profile' and 'Invalid IAM Instance Profile' in result.stderr and attempt < 5:
            time.sleep(5)
            continue
        raise RuntimeError(f'{service} {operation}: {result.stderr.strip()}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--account', required=True)
    parser.add_argument('--region', default='us-east-1')
    parser.add_argument('--instance', required=True)
    parser.add_argument('--snapshot', required=True)
    parser.add_argument('--email', required=True)
    args = parser.parse_args()
    identity = aws('sts', 'get-caller-identity')
    if identity['Account'] != args.account:
        raise SystemExit('Refusing wrong AWS account')
    instance = aws('ec2', 'describe-instances', InstanceIds=[args.instance])['Reservations'][0]['Instances'][0]
    snapshot = aws('ec2', 'describe-snapshots', SnapshotIds=[args.snapshot])['Snapshots'][0]
    volumes = [m['Ebs']['VolumeId'] for m in instance['BlockDeviceMappings'] if 'Ebs' in m]
    if instance['State']['Name'] != 'stopped' or snapshot['State'] != 'completed' or snapshot['VolumeId'] not in volumes:
        raise SystemExit('Require stopped instance and COMPLETED snapshot of its volume before changes')
    tag = [{'Key': 'clankie:purpose', 'Value': 'minecraft'}]
    role = 'clankie-minecraft-ssm'
    existing_roles = aws('iam', 'list-roles')['Roles']
    if not any(r['RoleName'] == role for r in existing_roles):
        aws('iam', 'create-role', RoleName=role, Tags=tag, AssumeRolePolicyDocument=json.dumps({
            'Version':'2012-10-17', 'Statement':[{'Effect':'Allow','Principal':{'Service':'ec2.amazonaws.com'},'Action':'sts:AssumeRole'}]}))
    aws('iam', 'attach-role-policy', RoleName=role, PolicyArn='arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore')
    profiles = aws('iam', 'list-instance-profiles')['InstanceProfiles']
    profile = next((p for p in profiles if p['InstanceProfileName'] == role), None)
    if profile is None:
        profile = aws('iam', 'create-instance-profile', InstanceProfileName=role, Tags=tag)['InstanceProfile']
    if not any(r['RoleName'] == role for r in profile['Roles']):
        aws('iam', 'add-role-to-instance-profile', InstanceProfileName=role, RoleName=role)
    if not instance.get('IamInstanceProfile'):
        aws('ec2', 'associate-iam-instance-profile', InstanceId=args.instance, IamInstanceProfile={'Name':role})
    elif instance['IamInstanceProfile']['Arn'] != f'arn:aws:iam::{args.account}:instance-profile/{role}':
        raise SystemExit('Existing profile differs; review rather than replace')
    resources = [args.instance, *volumes, *[s['GroupId'] for s in instance['SecurityGroups']]]
    aws('ec2', 'create-tags', Resources=resources, Tags=tag)
    aws('ec2', 'modify-instance-attribute', InstanceId=args.instance, InstanceInitiatedShutdownBehavior={'Value':'stop'})
    if instance['InstanceType'].startswith(('t3.', 't3a.', 't4g.')):
        aws('ec2', 'modify-instance-credit-specification', InstanceCreditSpecifications=[{'InstanceId':args.instance,'CpuCredits':'standard'}])
    for group in instance['SecurityGroups']:
        rules = aws('ec2', 'describe-security-group-rules', Filters=[{'Name':'group-id','Values':[group['GroupId']]}])['SecurityGroupRules']
        remove = [r['SecurityGroupRuleId'] for r in rules if not r['IsEgress'] and r.get('FromPort') == 22 and r.get('ToPort') == 22 and (r.get('CidrIpv4') == '0.0.0.0/0' or r.get('CidrIpv6') == '::/0')]
        if remove:
            aws('ec2', 'revoke-security-group-ingress', GroupId=group['GroupId'], SecurityGroupRuleIds=remove)
    aws('cloudwatch', 'put-metric-alarm', AlarmName=f'clankie-minecraft-idle-{args.instance}',
        AlarmDescription='Stop Minecraft after CPU remains below 5 percent for 30 minutes; guest idle/max uptime remain primary.',
        ActionsEnabled=True, AlarmActions=[f'arn:aws:automate:{args.region}:ec2:stop'],
        Namespace='AWS/EC2', MetricName='CPUUtilization', Dimensions=[{'Name':'InstanceId','Value':args.instance}],
        Statistic='Average', Period=300, EvaluationPeriods=6, DatapointsToAlarm=6,
        Threshold=5, ComparisonOperator='LessThanThreshold', TreatMissingData='missing', Tags=tag)
    aws('cloudwatch', 'tag-resource', ResourceARN=f'arn:aws:cloudwatch:{args.region}:{args.account}:alarm:clankie-minecraft-idle-{args.instance}', Tags=tag)
    activation = aws('ce', 'update-cost-allocation-tags-status', CostAllocationTagsStatus=[{'TagKey':'clankie:purpose','Status':'Active'}])
    if activation.get('Errors'):
        raise SystemExit(f'Cost allocation tag activation incomplete: {activation["Errors"]}')
    name = 'Clankie-Minecraft-Monthly-10USD'
    budget = {'BudgetName':name, 'BudgetLimit':{'Amount':'10','Unit':'USD'},'TimeUnit':'MONTHLY','BudgetType':'COST',
              'CostFilters':{'TagKeyValue':['user:clankie:purpose$minecraft']}}
    existing = aws('budgets', 'describe-budgets', AccountId=args.account)['Budgets']
    if not any(b['BudgetName'] == name for b in existing):
        aws('budgets', 'create-budget', AccountId=args.account, Budget=budget, ResourceTags=tag,
            NotificationsWithSubscribers=[{'Notification':{'NotificationType':kind,'ComparisonOperator':'GREATER_THAN','Threshold':threshold,'ThresholdType':'PERCENTAGE'},
                'Subscribers':[{'SubscriptionType':'EMAIL','Address':args.email}]} for kind,threshold in [('ACTUAL',80),('ACTUAL',100),('FORECASTED',100)]])
    else:
        aws('budgets', 'update-budget', AccountId=args.account, NewBudget=budget)
    actual = aws('budgets', 'describe-budget', AccountId=args.account, BudgetName=name)['Budget']
    if actual['CostFilters'] != budget['CostFilters'] or float(actual['BudgetLimit']['Amount']) != 10:
        raise SystemExit('Budget readback differs')
    notifications = aws('budgets', 'describe-notifications-for-budget', AccountId=args.account, BudgetName=name)['Notifications']
    for kind, threshold in [('ACTUAL',80),('ACTUAL',100),('FORECASTED',100)]:
        notification = next((n for n in notifications if n['NotificationType'] == kind and n['Threshold'] == threshold), None)
        if notification is None:
            raise SystemExit('Existing budget missing required alert; repair subscribers before starting')
        subscribers = aws('budgets', 'describe-subscribers-for-notification', AccountId=args.account, BudgetName=name, Notification=notification)['Subscribers']
        if not any(s['SubscriptionType'] == 'EMAIL' and s['Address'] == args.email for s in subscribers):
            raise SystemExit('Budget missing intended email subscriber')
    print(json.dumps({'account':args.account,'instance':args.instance,'profile':role,'budget':name,'instanceStarted':False}))
