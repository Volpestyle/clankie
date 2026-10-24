"""Native lead seat turn durations by trigger from its Claude transcript. Usage: lead_turns.py TRANSCRIPT_JSONL SINCE OUT_JSON"""
import json, sys, re
from datetime import datetime
def t(s): return datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
since=sys.argv[2]
turns=[]; cur=None
def trig(c):
    if isinstance(c,list):
        if any(x.get('type')=='tool_result' for x in c): return None
        c=' '.join(x.get('text','') for x in c if isinstance(x,dict))
    if not isinstance(c,str): return None
    m=re.search(r'<channel source="([^"]+)" kind="([^"]+)" conversation="[^"]*" source="([^"]+)"',c)
    if m:
        return 'channel:'+m.group(2)+':'+re.sub(r'[-:][0-9a-f]{6,}.*','',m.group(3))
    if c.startswith('<task-notification>'): return 'task-notification'
    if '<command-name>' in c or c.startswith('<local-command'): return None
    return 'owner-typed'
for line in open(sys.argv[1], errors='ignore'):
    if '"timestamp":"2026-' not in line: continue
    try: r=json.loads(line)
    except: continue
    ts=r.get('timestamp')
    if not ts or ts<since or r.get('isSidechain'): continue
    if r['type']=='user' and (not r.get('isMeta') or (r.get('origin') or {}).get('kind')=='channel'):
        k=trig(r.get('message',{}).get('content'))
        if k and cur is None: cur={'k':k,'start':ts,'reply':None,'tools':0,'text':None}
        elif k and cur is not None: cur.setdefault('extra',[]).append(k)
    elif r['type']=='assistant' and cur is not None:
        for x in r.get('message',{}).get('content',[]) or []:
            if x.get('type')=='text' and cur['text'] is None and x.get('text','').strip(): cur['text']=ts
            if x.get('type')=='tool_use':
                cur['tools']+=1
                if cur['reply'] is None and x.get('name','').endswith('__reply'): cur['reply']=ts
    elif r['type']=='system' and r.get('subtype')=='turn_duration' and cur is not None:
        cur['end']=ts; cur['dur']=r['durationMs']/1000; turns.append(cur); cur=None
def pct(v,p):
    v=sorted(v); return v[min(len(v)-1,int(round(p/100*(len(v)-1))))] if v else float('nan')
by={}
for x in turns: by.setdefault(x['k'],[]).append(x)
print(f"{'trigger':45} {'n':>4} {'turn p50':>9} {'turn p95':>9} {'1st out p50':>9} {'1st out p95':>9} {'tools p50':>9}")
for k,v in sorted(by.items(), key=lambda kv:-len(kv[1])):
    d=[x['dur'] for x in v]; rp=[t(x['reply'] or x['text'])-t(x['start']) for x in v if (x['reply'] or x['text'])]
    print(f"{k:45} {len(v):4} {pct(d,50):9.1f} {pct(d,95):9.1f} {pct(rp,50):9.1f} {pct(rp,95):9.1f} {pct([x['tools'] for x in v],50):9}")
json.dump(turns, open(sys.argv[3],'w'))
