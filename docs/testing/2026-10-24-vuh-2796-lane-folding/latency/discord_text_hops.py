"""Discord text end-to-end latency from bridge receipts, split into hops for Pi room handoffs.
Usage: discord_text_hops.py SINCE CONVERSATIONS_JSON MAIN_ESCALATIONS_JSON
CONVERSATIONS_JSON is `clankie conversations list` output; MAIN_ESCALATIONS_JSON is main_channel_hops.py output.
Discord snowflakes give the exact incoming and reply message times."""
import json, os, sys, hashlib
from datetime import datetime
def t(s): return datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
def sf(x): return ((int(x)>>22)+1420070400000)/1000
since=sys.argv[1]
convs=json.load(open(sys.argv[2]))
rooms={c['scope']['targetId'].split(':')[-1]:c['conversationId'] for c in convs if c['scope'].get('kind')=='room' and not c.get('roomHandoff') and c['scope'].get('lane')=='discord_presence'}
pi={}
for l in open(os.path.expanduser('~/.clankie/captain/turn-settled.jsonl')):
    r=json.loads(l); c=r['conversationId']
    if ':handoff:' in c and (r.get('completedAt') or r.get('failedAt')):
        pi.setdefault(c.split(':handoff:')[1],[]).append(r)
esc=set(r['eid'].replace('discord-main-','')[:32] for r in json.load(open(sys.argv[3])))
main_ch=set(json.load(open(os.path.expanduser('~/.config/clankie/settings.json'))).get('discord',{}).get('mainConversationChannelIds',[]))
hops={}; seen=set(); unmatched=0
def add(k,v): hops.setdefault(k,[]).append(v)
for l in open(os.path.expanduser('~/.local/state/clankie/discord-live-receipts.jsonl')):
    r=json.loads(l)
    if r['type']!='discord.text.reply' or r['occurredAt']<since: continue
    d=r['data']
    if not d.get('responseMessageId') or not d.get('deliveryId','').isdigit() or d['deliveryId'] in seen: continue
    seen.add(d['deliveryId'])
    e2e=sf(d['responseMessageId'])-sf(d['deliveryId'])
    if d['channelId'] in main_ch:
        add('main channel (native lead) e2e',e2e); continue
    room=rooms.get(d['channelId'])
    hid=None
    if room: hid='handoff-'+hashlib.sha256(f"{room}:{d['deliveryId']}".encode()).hexdigest()[:32]
    if hid in pi:
        runs=sorted(pi[hid],key=lambda x:x['acceptedAt']); a=runs[0]; z=runs[-1]
        end=z.get('completedAt') or z.get('failedAt')
        if sf(d['responseMessageId'])-t(end)>300:
            add('excluded: reply held >300s after settle (bridge outage)',e2e); continue
        add('pi handoff e2e',e2e)
        add('pi handoff: ingest+admission (discord msg -> pi accepted)',t(a['acceptedAt'])-sf(d['deliveryId']))
        add('pi handoff: model turn(s)',t(end)-t(a['acceptedAt']))
        add('pi handoff: return (settled -> discord message)',sf(d['responseMessageId'])-t(end))
        add('pi handoff: tool calls',sum(z['toolCount'].values()) if z.get('toolCount') else 0)
        add('pi handoff: context tokens end',z.get('contextTokensEnd') or 0)
    else:
        unmatched+=1; add('other/unmatched e2e',e2e)
import statistics
def pct(v,p):
    v=sorted(v); return v[min(len(v)-1,int(round(p/100*(len(v)-1))))]
for k,v in hops.items():
    print(f"{k:62} n={len(v):4} p50={pct(v,50):9.1f} p90={pct(v,90):9.1f} p95={pct(v,95):9.1f} >300s={sum(1 for x in v if x>300)}")
