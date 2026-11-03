"""Run the notes-provider evaluation end to end (resumable).

  .venv\\Scripts\\python demo\\notes_eval\\run_eval.py                       # everything
  .venv\\Scripts\\python demo\\notes_eval\\run_eval.py --dry-run             # show what would run / be skipped
  .venv\\Scripts\\python demo\\notes_eval\\run_eval.py --contestants groq --videos zjkBMFhNj_g --runs 2
  .venv\\Scripts\\python demo\\notes_eval\\run_eval.py --judge-only          # no generation, judge + aggregate

Every generation run is written to out/runs/<contestant>/<video>/<n>.json and every judgement to
out/judgements/; reruns skip anything already on disk (use --retry-failed to redo failed runs).
Generations run strictly one at a time (RAM is tight).
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import time

import common as C


def log(msg: str) -> None:
    print(f"[{dt.datetime.now():%H:%M:%S}] {msg}", flush=True)


def fetch_transcripts(videos: list[str], dry: bool) -> dict[str, dict]:
    from notes_engine import ingest
    out = {}
    for vid in videos:
        p = C.TRANSCRIPTS / f"{vid}.json"
        t = C.read_json(p)
        if isinstance(t, dict) and t.get("segments"):
            out[vid] = t
            continue
        if dry:
            log(f"would fetch transcript {vid}")
            continue
        log(f"fetching transcript {vid}")
        os.environ["LNA_CACHE_DIR"] = str(C.ROOT / "backend" / ".cache")   # reuse the app's transcript cache
        try:
            t = ingest.get_transcript(f"https://www.youtube.com/watch?v={vid}")
        finally:
            os.environ.pop("LNA_CACHE_DIR", None)  # generation must NOT hit the engine's digest cache
        C.write_json(p, t)
        out[vid] = t
    return out


def generate(cid: str, vid: str, n: int, transcript: dict) -> dict:
    from notes_engine import llm
    from notes_engine.notes_schema import validate_notes
    c = C.CONTESTANTS[cid]
    C.install_meter()
    C.METER.reset()
    C.METER.active = True
    rec = {"contestant": cid, "provider": c["provider"], "model": C.model_of(cid), "video": vid, "run": n,
           "started": dt.datetime.now().isoformat(timespec="seconds")}
    t0 = time.perf_counter()
    try:
        k = C.key(c["env"])
        if not k:
            raise llm.LLMError(f"No API key ({c['env']}) found.")
        notes = llm.generate_notes(transcript, provider=c["provider"], api_key=k, model=c["model"])
        rec["status"] = "success"
        rec["notes"] = notes
        try:
            validate_notes(notes, transcript)
            rec["schema_valid"] = True
        except Exception:  # noqa: BLE001
            rec["schema_valid"] = False
    except Exception as e:  # noqa: BLE001
        msg = C.scrub(str(e) or type(e).__name__)
        rec.update(status="error", error=msg, error_type=C.classify_error(msg), schema_valid=False)
    finally:
        C.METER.active = False
    m = C.METER
    rec["latency_sec"] = round(time.perf_counter() - t0, 2)
    rec["timing"] = {
        "http_requests": m.requests, "http_statuses": m.statuses, "http_sec": round(m.http_sec, 2),
        "sleep_sec": round(m.sleep_sec, 2), "ok_responses": m.ok_responses,
        "usage_reported_responses": m.usage_reported,
        "prompt_tokens": m.prompt_tokens if m.usage_reported else None,
        "output_tokens": m.output_tokens if m.usage_reported else None,
    }
    return rec


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", nargs="*", default=list(C.VIDEOS))
    ap.add_argument("--contestants", nargs="*", default=list(C.CONTESTANTS))
    ap.add_argument("--runs", type=int, default=2)
    ap.add_argument("--judge-only", action="store_true")
    ap.add_argument("--no-judge", action="store_true")
    ap.add_argument("--retry-failed", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    for v in a.videos:
        assert v in C.VIDEOS, f"unknown video {v}"
    for c in a.contestants:
        assert c in C.CONTESTANTS, f"unknown contestant {c}"

    ts = fetch_transcripts(a.videos, a.dry_run)
    quota_dead: set[str] = set()   # contestants that hit a hard daily quota this session
    if not a.judge_only:
        for n in range(1, a.runs + 1):          # run 1 for everything first, so a quota hit only costs run 2
            for vid in a.videos:
                for cid in a.contestants:
                    p = C.run_path(cid, vid, n)
                    old = C.read_json(p)
                    if isinstance(old, dict) and (old.get("status") == "success" or not a.retry_failed):
                        continue
                    if a.dry_run:
                        log(f"would run {cid} {vid} #{n}")
                        continue
                    if vid not in ts:
                        continue
                    if cid in quota_dead:
                        rec = {"contestant": cid, "provider": C.CONTESTANTS[cid]["provider"], "model": C.model_of(cid),
                               "video": vid, "run": n, "status": "skipped", "error_type": "quota_daily",
                               "error": "Not attempted: this contestant hit a hard daily quota earlier in the session.",
                               "latency_sec": None, "schema_valid": False, "timing": {}}
                        C.write_json(p, rec)
                        continue
                    log(f"generate {cid} {vid} #{n} ...")
                    rec = generate(cid, vid, n, ts[vid])
                    C.write_json(p, rec)
                    log(f"  -> {rec['status']} {rec['latency_sec']}s {rec.get('error_type', '')} {rec.get('error', '')[:120]}")
                    if rec.get("error_type") == "quota_daily":
                        quota_dead.add(cid)
    if a.no_judge:
        return
    import evaluate
    evaluate.judge_all(ts, a.videos, a.contestants, a.runs, dry=a.dry_run, log=log)
    if a.dry_run:
        return
    evaluate.aggregate()
    import build_data
    build_data.main()


if __name__ == "__main__":
    main()
