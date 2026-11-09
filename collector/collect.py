"""Snapshot live library occupancy for Ontario universities.

Run every 15 minutes (GitHub Actions). Appends one row per library/space to
  <out>/<university>/<YYYY-MM>.csv
and rewrites <out>/latest.json with the newest snapshot and per-source status.

Stdlib only. Each source is independent: one failing never blocks the others.
"""

from __future__ import annotations

import csv
import html
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone

UA = "OntarioLibraryTracker/1.0 (+https://github.com/eitanzur/library-tracker)"
CSV_FIELDS = ["t", "library", "space", "pct", "people", "cap", "flag"]


def get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def row(library, space="", pct=None, people=None, cap=None, flag=""):
    if pct is None and people is not None and cap:
        pct = 100 * people / cap
    return {
        "library": library,
        "space": space,
        "pct": None if pct is None else round(float(pct), 1),
        "people": people,
        "cap": cap,
        "flag": flag,
    }


def text(s: str) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", s)).split())


# --- Sources -----------------------------------------------------------------


def queens():
    """Server-rendered '% capacity' cards. Values under 25% are masked as '< 25%'."""
    page = get("https://library.queensu.ca/use-the-library/locations")
    out = []
    # Each card: '... See all hours for <Name>" ... Capacity is at <strong>X</strong>'
    cards = re.split(r'aria-label="See all hours for ', page)[1:]
    for card in cards:
        name = html.unescape(card.split('"', 1)[0])
        m = re.search(r"Capacity is at\s*<strong>(.*?)</strong>", card[:4000], re.S)
        if not m:
            continue  # location has no sensor (e.g. Archives)
        val = text(m.group(1))
        num = re.search(r"([\d.]+)\s*%", val)
        if "<" in val or "less than" in val:
            out.append(row(name, pct=None, flag="<25"))
        elif num:
            out.append(row(name, pct=float(num.group(1))))
    return out


def waterloo():
    """Waitz JSON: people + capacity per building and per floor/zone."""
    data = json.loads(get("https://waitz.io/live/waterloo"))["data"]
    out = []
    for b in data:
        flag = "" if b.get("isOpen") else "closed"
        out.append(row(b["name"], people=b.get("people"), cap=b.get("capacity"),
                       pct=100 * b["percentage"] if b.get("percentage") is not None else None,
                       flag=flag))
        for s in b.get("subLocs") or []:
            sflag = "" if s.get("isOpen") else "closed"
            out.append(row(b["name"], s["name"], people=s.get("people"), cap=s.get("capacity"),
                           pct=100 * s["percentage"] if s.get("percentage") is not None else None,
                           flag=sflag))
    return out


def ottawa():
    """Occuspace numbers rendered into the uOttawa study-space page, per floor/zone."""
    page = get("https://www.uottawa.ca/library/study-space")
    out = []
    sections = re.split(r'<h2 class="headline headline--2">', page)[1:]
    for sec in sections:
        lib = text(sec.split("</h2>", 1)[0])
        for m in re.finditer(
            r'location-name">(.*?)</div>.*?aria-valuenow="([\d.]+)"', sec, re.S
        ):
            out.append(row(lib, text(m.group(1)), pct=float(m.group(2))))
    return out


def guelph():
    """SafeSpace door counters for McLaughlin Library (live count / max capacity)."""
    h = "e81c82f9"
    people = int(float(get(f"https://display.safespace.io/value/live/{h}").strip()))
    cap = json.loads(get(f"https://display.safespace.io/entity/space/hash/{h}"))["space"]["maxCapacity"]
    return [row("McLaughlin Library", people=people, cap=cap)]


SOURCES = {
    "queens": ("Queen's University", queens),
    "waterloo": ("University of Waterloo", waterloo),
    "ottawa": ("University of Ottawa", ottawa),
    "guelph": ("University of Guelph", guelph),
}


# --- Main --------------------------------------------------------------------


MIN_GAP = 10 * 60  # skip if the last snapshot is newer than this (two triggers may fire)


def main(out_dir: str) -> int:
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    t = int(now.timestamp())
    try:
        with open(os.path.join(out_dir, "latest.json"), encoding="utf-8") as f:
            last = json.load(f).get("t", 0)
        if t - last < MIN_GAP and not os.environ.get("FORCE"):
            print(f"skip: last snapshot {t - last}s ago")
            return 0
    except (OSError, ValueError):
        pass
    month = now.strftime("%Y-%m")
    latest = {"t": t, "universities": {}}
    failures = 0

    for key, (name, fn) in SOURCES.items():
        entry = {"name": name, "ok": False, "rows": [], "error": None}
        try:
            rows = fn()
            if not rows:
                raise RuntimeError("no rows parsed (page layout may have changed)")
            entry.update(ok=True, rows=rows)
            path = os.path.join(out_dir, key, f"{month}.csv")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            new = not os.path.exists(path)
            with open(path, "a", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
                if new:
                    w.writeheader()
                for r in rows:
                    w.writerow({"t": t, **{k: ("" if v is None else v) for k, v in r.items()}})
        except Exception as e:  # noqa: BLE001 - keep other sources running
            failures += 1
            entry["error"] = f"{type(e).__name__}: {e}"[:300]
        latest["universities"][key] = entry
        status = f"{len(entry['rows'])} rows" if entry["ok"] else entry["error"]
        print(f"{key:10} {status}")

    with open(os.path.join(out_dir, "latest.json"), "w", encoding="utf-8") as f:
        json.dump(latest, f, ensure_ascii=False, separators=(",", ":"))
    # Fail the run only if every source failed (likely a network problem).
    return 1 if failures == len(SOURCES) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "data"))
