# Table of a bench results.jsonl (one or more files): latency to the overlay and to the Log, CPU.
import json, sys, collections
rows = [json.loads(l) for f in sys.argv[1:] for l in open(f) if l.strip()]
print(f"{'label':14} {'engine':9} {'scenario':18} {'pub':>6} {'ovl p50':>7} {'ovl p90':>7} {'log p50':>7} {'log p90':>7} {'log max':>7} {'app%':>6} {'busy':>5} {'looks/s':>7} {'reads/s':>7} {'obs ms':>6} {'req':>4}")
for r in rows:
    o = r.get('overlayLatency') or {}
    print(f"{r['label'][:14]:14} {r['engine']:9} {r['scenario'][:18]:18} {str(r['published'])+'/'+str(r['lines']):>6} {str(o.get('p50')):>7} {str(o.get('p90')):>7} {str(r['latency']['p50']):>7} {str(r['latency']['p90']):>7} {str(r['latency']['max']):>7} {r['appCpuPct']:>6} {r['systemBusyCores']:>5} {r['looksPerS']:>7} {r['readsPerS']:>7} {str(r['observerMs']['p50']):>6} {r['requests']:>4}")
