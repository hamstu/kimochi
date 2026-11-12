# Per-line timeline from a bench trace file: what happened between a line finishing and the Log.
import json, sys
d = json.load(open(sys.argv[1]))
lines = [t for t in d['truth'] if t['kind'] == 'line']
for k, t in enumerate(lines):
    c = t['completeAt']; end = lines[k+1]['shownAt'] if k+1 < len(lines) else c + 6000
    print(f"\n--- line {t['i']} ({len(t['text'])} chars) shown {t['shownAt']-c:+d} complete 0")
    for r in d['trace']:
        if not (c - 700 <= r['at'] < end): continue
        rel = r['at'] - c
        if r['kind'] == 'first-pass':
            print(f"  {rel:+6d} look obs={r.get('observerMs')} rt={r.get('roundTripMs')} rel={r.get('relation')} chars={r.get('chars')} gap={r.get('completionGapMs')}")
        elif r['kind'] == 'decision':
            e = r['event']; print(f"  {rel:+6d}   decision {e.get('type')} {e.get('reason') or ''} interval={round(r.get('intervalMs',0))} confirming={r.get('confirming')}")
        elif r['kind'] in ('second-pass-end', 'apply-end'):
            print(f"  {rel:+6d}   {r['kind']} {r.get('durationMs')}")
    for e in d['events']:
        if e.get('event') == 'line' and c - 700 <= e.get('at', 0) < end:
            print(f"  {e['at']-c:+6d}   LOG LINE")
