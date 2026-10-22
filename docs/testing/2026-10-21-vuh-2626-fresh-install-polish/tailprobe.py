# tailprobe.py ROOT — park a durable tail on the scratch service, restart it, print the tail's HTTP answer.
import json, os, subprocess, sys, threading, time, urllib.request, urllib.error
root = sys.argv[1]
env = {}
for line in open(os.path.join(root, 'stack.env')):
    k, v = line.strip().split('=', 1); env[k] = v.strip("'")
creds = json.load(open(env['CLANKIE_CREDENTIALS_FILE']))
creds = creds.get('credentials', creds)
token = creds['clankie_captain']['key']
url = env['CLANKIE_CONTROL_PLANE_URL'] + '/operator/v1/dispatch'
def call(body, timeout=60):
    req = urllib.request.Request(url, json.dumps(body).encode(), {'content-type': 'application/json', 'authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, e.read().decode()[:300]
status, listed = call({'op': 'list', 'schemaVersion': 1})
conversation = next(c for c in listed['conversations'] if c.get('isDefault'))['conversationId']
cursor = None
while True:
    body = {'schemaVersion': 1, 'conversationId': conversation, 'surfaceClientId': 'tailprobe', 'limit': 100}
    if cursor: body['cursor'] = cursor
    status, page = call({'op': 'replay', 'schemaVersion': 1, 'replay': body}); page = page.get('result', page)
    if page.get('events'): cursor = page['events'][-1]['cursor']
    if not page.get('hasMore'): break
    cursor = page.get('nextCursor', cursor)
result = {}
def tail():
    body = {'schemaVersion': 1, 'conversationId': conversation, 'surfaceClientId': 'tailprobe', 'limit': 100, 'waitMs': 20000}
    if cursor: body['cursor'] = cursor
    t = time.time(); result['answer'] = call({'op': 'tail', 'schemaVersion': 1, 'tail': body}, timeout=120); result['after'] = round(time.time() - t, 2)
th = threading.Thread(target=tail); th.start(); time.sleep(2)
print('tail parked:', th.is_alive(), flush=True)
cli = os.path.join(env['HOME'], '.local/bin/clankie')
restart = subprocess.run([cli, 'restart', 'clankie'], env=env, cwd=env['HOME'], capture_output=True, text=True)
th.join(timeout=60)
print('restart exit:', restart.returncode)
print('tail answer after', result.get('after'), 's:', result.get('answer'))
