"""Owner main-channel escalations in the native lead: ingest, lead-busy queue, think, deliver. Usage: main_channel_hops.py TRANSCRIPT_JSONL SINCE OUT_JSON"""
import json, sys, re, glob, os
from datetime import datetime, timezone
def t(s): return datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
since=sys.argv[2]
esc={}  # event_id -> dict
pending_reply={}  # tool_use id -> event_id
order=[]
for line in open(sys.argv[1], errors='ignore'):
    if '"timestamp":"2026-' not in line: continue
    if 'discord-main' not in line and 'clankie-cli' not in line and '"tool_result"' not in line: continue
    try: r=json.loads(line)
    except: continue
    ts=r.get('timestamp')
    if not ts or ts<since or r.get('isSidechain'): continue
    c=r.get('message',{}).get('content')
    if r['type']=='user' and isinstance(c,str) and c.startswith('<channel') and 'kind="escalation"' in c:
        eid=re.search(r'event_id="([^"]+)"',c).group(1); ca=re.search(r'created_at="([^"]+)"',c).group(1)
        if eid not in esc: esc[eid]={'eid':eid,'created':ca,'inserted':ts}; order.append(eid)
    elif r['type']=='assistant' and isinstance(c,list):
        batch=[x for x in c if x.get('type')=='tool_use']
        for x in batch:
            if x.get('name','').endswith('__reply'):
                eid=(x.get('input') or {}).get('event_id')
                if eid in esc and 'reply_call' not in esc[eid]:
                    esc[eid]['reply_call']=ts; pending_reply[x['id']]=eid
    elif r['type']=='user' and isinstance(c,list):
        for x in c:
            if x.get('type')=='tool_result' and x.get('tool_use_id') in pending_reply:
                esc[pending_reply.pop(x['tool_use_id'])]['reply_done']=ts
# join snowflakes from retained handoffs
hand={}
for d in glob.glob(os.path.expanduser('~/.clankie/captain/conversations/handoff-*/meta.json')):
    m=json.load(open(d)); h=m.get('roomHandoff') or {}
    did=h.get('deliveryId')
    if did and did.isdigit(): hand[os.path.basename(os.path.dirname(d))[8:]]=((int(did)>>22)+1420070400000)/1000
rows=[]
for e in order:
    x=esc[e]; hid=e.replace('discord-main-','')[:32]
    r={'eid':e,'queue':t(x['inserted'])-t(x['created'])}
    if hid in hand: r['ingest']=t(x['created'])-hand[hid]
    if 'reply_call' in x: r['think']=t(x['reply_call'])-t(x['inserted'])
    if 'reply_done' in x: r['deliver']=t(x['reply_done'])-t(x['reply_call'])
    if 'reply_done' in x and hid in hand: r['total']=t(x['reply_done'])-hand[hid]
    elif 'reply_done' in x: r['total_from_created']=t(x['reply_done'])-t(x['created'])
    rows.append(r)
def pct(v,p):
    v=sorted(v); return v[min(len(v)-1,int(round(p/100*(len(v)-1))))] if v else float('nan')
print('escalations', len(rows), 'with reply', sum('reply_done' in esc[e] for e in order))
for k in ['ingest','queue','think','deliver','total','total_from_created']:
    v=[r[k] for r in rows if k in r]
    print(f"{k:20} n={len(v):3} p50={pct(v,50):7.1f}s p95={pct(v,95):7.1f}s max={max(v) if v else float('nan'):7.1f}s")
json.dump(rows,open(sys.argv[3],'w'),indent=0)
