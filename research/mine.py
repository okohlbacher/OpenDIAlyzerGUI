#!/usr/bin/env python3
"""Harvest Skyline support board threads via LabKey search."""
import re, sys, json, os, html, urllib.parse, subprocess, time

BASE = "https://skyline.ms"
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
os.makedirs(CACHE, exist_ok=True)


def get(url):
    key = re.sub(r'[^A-Za-z0-9]', '_', url)[-180:]
    p = os.path.join(CACHE, key + ".html")
    if os.path.exists(p) and os.path.getsize(p) > 500:
        return open(p, encoding='utf-8', errors='replace').read()
    r = subprocess.run(["curl", "-sS", "--compressed", "-m", "60", "-A",
                        "Mozilla/5.0 (research)", url],
                       capture_output=True, text=True)
    t = r.stdout
    open(p, "w", encoding='utf-8').write(t)
    time.sleep(0.4)
    return t


def search(q, container="home/support"):
    """Return list of (url, title) from LabKey search."""
    url = f"{BASE}/search/{container}/search.view?q={urllib.parse.quote(q)}&limit=100"
    h = get(url)
    n = re.findall(r'Found\s+([\d,]+)\s+result', h)
    total = n[0] if n else "?"
    out = []
    for m in re.finditer(
            r'href="(/home/support/announcements-thread\.view\?[^"]+)"[^>]*>(.{0,200}?)</a>', h):
        u = html.unescape(m.group(1))
        t = html.unescape(re.sub(r'<[^>]+>', '', m.group(2))).strip()
        out.append((BASE + u, t))
    # dedupe by entityId
    seen, res = set(), []
    for u, t in out:
        eid = re.findall(r'entityId=([0-9a-f-]+)', u)
        k = eid[0] if eid else u
        if k in seen:
            continue
        seen.add(k)
        res.append((u, t))
    return total, res


def thread_text(url):
    h = get(url)
    # strip scripts/styles
    h = re.sub(r'(?is)<script.*?</script>', ' ', h)
    h = re.sub(r'(?is)<style.*?</style>', ' ', h)
    # canonical rowId comes from the print/respond links, not from body text
    rid = (re.findall(r'print\.view\?[^"\']*rowId=(\d+)', h)
           or re.findall(r'(?:respond|update|thread)\.view\?[^"\']*rowId=(\d+)', h))
    body = h
    m = re.search(r'(?is)<div[^>]*class="[^"]*labkey-announcement', h)
    if m:
        body = h[m.start():]
    txt = re.sub(r'(?is)<br\s*/?>', '\n', body)
    txt = re.sub(r'(?is)</(p|div|tr|li|h\d)>', '\n', txt)
    txt = re.sub(r'<[^>]+>', ' ', txt)
    txt = html.unescape(txt)
    txt = re.sub(r'[ \t\xa0]+', ' ', txt)
    txt = re.sub(r'\n\s*\n\s*\n+', '\n\n', txt)
    return (rid[0] if rid else None), txt.strip()


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "search":
        for q in sys.argv[2:]:
            total, res = search(q)
            print(f"\n########## QUERY: {q}  (Found {total})")
            for u, t in res:
                print(f"  {t}\n     {u}")
    elif mode == "thread":
        for u in sys.argv[2:]:
            rid, txt = thread_text(u)
            print(f"\n########## {u}  rowId={rid}")
            print(txt[:9000])
