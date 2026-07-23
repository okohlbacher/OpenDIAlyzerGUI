#!/usr/bin/env python3
"""Bulk-harvest Skyline support threads for a set of queries, dump text to disk."""
import sys, os, re, json
from concurrent.futures import ThreadPoolExecutor
from mine import search, thread_text

QUERIES = json.load(open(sys.argv[1])) if len(sys.argv) > 1 else []
OUT = sys.argv[2] if len(sys.argv) > 2 else "harvest.txt"

allthreads = {}
for q in QUERIES:
    try:
        total, res = search(q)
    except Exception as e:
        print("ERR", q, e); continue
    print(f"# {q}: found {total}, {len(res)} shown", file=sys.stderr)
    for u, t in res:
        allthreads.setdefault(u, t)

print(f"# total unique threads: {len(allthreads)}", file=sys.stderr)


def grab(item):
    u, t = item
    try:
        rid, txt = thread_text(u)
        return u, t, rid, txt
    except Exception as e:
        return u, t, None, f"ERROR {e}"


with ThreadPoolExecutor(max_workers=6) as ex:
    results = list(ex.map(grab, allthreads.items()))

with open(OUT, "w", encoding="utf-8") as f:
    for u, t, rid, txt in results:
        canon = f"https://skyline.ms/announcements/home/support/thread.view?rowId={rid}" if rid else u
        f.write(f"\n\n{'='*100}\nTITLE: {t}\nURL: {canon}\nRAW: {u}\n{'-'*100}\n")
        f.write(txt[:20000])
print("wrote", OUT, len(results), "threads", file=sys.stderr)
