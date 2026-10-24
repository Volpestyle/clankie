"""Pi-executed turn durations from turn-settled.jsonl by lane. Usage: pi_turns.py TURN_SETTLED_JSONL SINCE"""
import json, sys, statistics as st
from datetime import datetime
def t(s): return datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
since = sys.argv[2] if len(sys.argv)>2 else '2026-09-24'
rows={}
for line in open(sys.argv[1]):
    r=json.loads(line)
    if r['acceptedAt']<since: continue
    end=r.get('completedAt') or r.get('failedAt')
    if not end: continue
    c=r['conversationId']; lane=r['lane']
    if lane=='operator':
        k='console/operator ' + ('global-default' if c=='global-default' else 'linear-inbox' if c=='linear-inbox' else 'side conv')
    elif lane=='discord_presence':
        k='discord text ' + ('pi handoff child' if ':handoff:' in c else 'system lane' if c.endswith(':authority:system') else 'room turn')
    else: k=lane
    k+=' ['+r['outcome']+']'
    rows.setdefault(k,[]).append(t(end)-t(r['acceptedAt']))
def pct(v,p):
    v=sorted(v); i=min(len(v)-1, max(0,int(round(p/100*(len(v)-1))))); return v[i]
print(f"{'class':55} {'n':>5} {'p50 s':>8} {'p95 s':>8} {'max s':>8}")
for k in sorted(rows):
    v=rows[k]; print(f"{k:55} {len(v):5} {pct(v,50):8.1f} {pct(v,95):8.1f} {max(v):8.1f}")
