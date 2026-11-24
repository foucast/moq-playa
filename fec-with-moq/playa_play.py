#!/usr/bin/env python3
"""One headless Playa run: opens the test harness (examples/fec-with-moq/, built into
examples/dist/fec-with-moq/ and served on 127.0.0.1:PORT), plays for SECS seconds, prints one JSON
object with what the page recorded.

    python3 playa_play.py URL NS [--secs 30] [--browser chromium|firefox] [--page-port 8082]
                          [--draft 18] [--hash HEX] [--latency MS] [--log warn] [--cb subscribe]
                          [--fec RUNGS [--deadline MS]]

--fec turns the player's FEC stage on with that many repair rungs (omitted: the stock path).

Stalls are measured from the frames drawn (the harness logs every new canvas draw), not from Playa's
`stall` event: a gap between draws longer than a threshold is a stall, from the first frame to the
end of the run, including a gap the run ends in. Reported at 50 ms (three frame intervals at
60 fps), 100 ms and Playa's own 500 ms, and at 50 and 100 ms again from 2 s after the first frame
(startup gaps settle within that). For an FEC run each stall of 100 ms or more is matched
against the stage's block log: one that a block given up (or missing) explains, i.e. a block that
ended as abandoned/missing from 1 s before the stall to its end, is a loss stall; any other is
listed as unexplained.

Needs Playwright for Python with Chromium and/or Firefox. Firefox gets WebTransport and its
datagrams enabled and autoplay allowed; Chromium gets autoplay without a gesture.
"""
import argparse, json, sys, time
from urllib.parse import quote
from playwright.sync_api import sync_playwright

p = argparse.ArgumentParser()
p.add_argument("url")
p.add_argument("ns")
p.add_argument("--secs", type=float, default=30)
p.add_argument("--browser", default="chromium", choices=("chromium", "firefox"))
p.add_argument("--page-port", type=int, default=8082)
p.add_argument("--draft", type=int, default=18)
p.add_argument("--hash", default="")
p.add_argument("--latency", default="")
p.add_argument("--log", default="warn")
p.add_argument("--cb", default="", help="catalogBootstrap (auto, joining-fetch, strict, subscribe)")
p.add_argument("--fec", default="", help="FEC on, with this many repair rungs")
p.add_argument("--deadline", default="600", help="FEC block deadline, ms")
a = p.parse_args()

with sync_playwright() as pw:
    kw = {"headless": True}
    if a.browser == "firefox":
        kw["firefox_user_prefs"] = {"media.autoplay.default": 0, "network.webtransport.enabled": True,
                                    "network.webtransport.datagrams.enabled": True}
    else:
        kw["args"] = ["--autoplay-policy=no-user-gesture-required"]
    b = getattr(pw, a.browser).launch(**kw)
    pg = b.new_page()
    console = []
    pg.on("console", lambda m: console.append(f"{m.type}: {m.text[:300]}"))
    pg.on("pageerror", lambda e: console.append(f"pageerror: {str(e)[:300]}"))
    q = f"url={quote(a.url, safe='')}&ns={quote(a.ns, safe='')}&v={a.draft}&log={a.log}"
    if a.hash:
        q += f"&hash={a.hash}"
    if a.latency:
        q += f"&latency={a.latency}"
    if a.cb:
        q += f"&cb={a.cb}"
    if a.fec != "":
        q += f"&fec={a.fec}&deadline={a.deadline}"
    pg.goto(f"http://127.0.0.1:{a.page_port}/fec-with-moq/index.html?{q}")
    time.sleep(a.secs)
    # One evaluate: the end time and the snapshot agree (serializing a long run takes ~1 s).
    snap = pg.evaluate("() => ({run: window.playaRun, now: performance.now()})")
    run, run_end_ms = snap["run"], snap["now"]
    out = {"browser": a.browser, "version": b.version, "secs": a.secs, "run": run,
           "console": console[-200:]}
    b.close()

stats = run.get("stats") or []
last = stats[-1] if stats else {}
first_frame = next((s["atMs"] for s in stats if (s.get("framesDecoded") or 0) > 0), None)
out["summary"] = {
    "protocol": [w.get("protocol") for w in run.get("webtransport", [])],
    "wtErrors": [w.get("error") for w in run.get("webtransport", []) if w.get("error")],
    "state": run.get("state"),
    "firstFrameMs": first_frame,
    "framesDecoded": last.get("framesDecoded"),
    "framesRendered": last.get("framesRendered"),
    "framesDropped": last.get("framesDropped"),
    "stallCount": last.get("stallCount"),
    "videoCodec": last.get("videoCodec"),
    "resolution": last.get("resolution"),
    "media": last.get("media"),
    "errors": run.get("errors"),
}
frames = run.get("frames") or []
draws = [f[0] for f in frames]
behind = sorted(f[1] for f in frames if f[1] is not None)
gaps = [(draws[i - 1], draws[i]) for i in range(1, len(draws))]
if draws:
    gaps.append((draws[-1], run_end_ms))                  # the gap the run ends in, if any
def stalls(th, after=0.0):
    g = [(t0, t1) for t0, t1 in gaps if t1 - t0 > th and t0 >= (draws[0] + after if draws else 0)]
    return {"count": len(g), "seconds": round(sum(t1 - t0 for t0, t1 in g) / 1000, 3)}
play_s = (run_end_ms - draws[0]) / 1000 if draws else 0
out["summary"]["frameDraws"] = {
    "frames": len(draws), "firstDrawMs": round(draws[0]) if draws else None, "playS": round(play_s, 1),
    "stall50": stalls(50), "stall100": stalls(100), "stall500": stalls(500),
    # the same after the first 2 s of playback (startup settles there)
    "stall50After2s": stalls(50, 2000), "stall100After2s": stalls(100, 2000),
    "maxGapMs": round(max((t1 - t0 for t0, t1 in gaps), default=0)),
    "behindLiveMedianMs": behind[len(behind) // 2] if behind else None,
}
fec = run.get("fec")
if fec:
    log = fec.get("blockLog") or []
    origin = run.get("timeOrigin") or 0
    lost = [b["atMs"] for b in log if b["outcome"] in ("abandoned", "missing")]
    unexplained = []
    for t0, t1 in gaps:
        if t1 - t0 < 100:
            continue
        w0, w1 = origin + t0 - 1000, origin + t1
        if not any(w0 <= t <= w1 for t in lost):
            unexplained.append({"fromMs": round(t0), "gapMs": round(t1 - t0)})
    keep = ("blocksSeen", "blocksWhole", "blocksRecovered", "blocksAbandoned", "blocksMissing", "blocksSkipped",
            "framesReleased", "framesDropped", "framesDroppedToKey", "sourceSymbols", "sourceLost", "repairSymbols",
            "repairBytes", "endOfGroups", "decodeCount", "decodeMsMax", "decodeFailures")
    out["summary"]["fec"] = {k: fec.get(k) for k in keep}
    out["summary"]["fec"]["stallsUnexplained"] = unexplained
json.dump(out, sys.stdout)
print()
