"""Shared paths, contestants, key loading and instrumentation for the notes-provider evaluation.

API keys are read from backend/.env into memory only. They are never printed, logged or written.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent                      # lecture-notes-ai/
OUT = HERE / "out"
TRANSCRIPTS = OUT / "transcripts"
GOLD = OUT / "gold"
RUNS = OUT / "runs"
JUDGE = OUT / "judgements"
DEV_UI = Path(r"D:\AQspace\aq-api\dev-ui")
sys.path.insert(0, str(ROOT))

VIDEOS = {
    "WUvTyaaNkzM": "3Blue1Brown - Essence of calculus (17m)",
    "aircAruvnKk": "3Blue1Brown - Neural networks ch.1 (18m)",
    "IqQFaj3oO0Q": "Piyush Garg - Harness Engineering (14m)",
    "zjkBMFhNj_g": "Andrej Karpathy - Intro to LLMs (60m)",
}

# id -> provider, model (None = engine default), env var holding the key
CONTESTANTS = {
    "gemini": {"provider": "gemini", "model": None, "env": "GEMINI_API_KEY"},
    "groq": {"provider": "groq", "model": None, "env": "GROQ_API_KEY"},
    "nvidia-super": {"provider": "nvidia", "model": "nvidia/nemotron-3.5-super-vl-120b-a12b", "env": "NVIDIA_API_KEY"},
    "nvidia-lightning": {"provider": "nvidia", "model": "nvidia/nemotron-3.5-lightning-30b-a3b", "env": "NVIDIA_API_KEY"},
}
UNAVAILABLE = {
    "colab": "Colab Qwen3-8B: not available (no GPU session running)",
    "huggingface": "Hugging Face Inference: not available (no credits)",
}
JUDGE_PROVIDER = "gemini"


def model_of(cid: str) -> str:
    from notes_engine.llm import PROVIDERS
    c = CONTESTANTS[cid]
    return c["model"] or PROVIDERS[c["provider"]]["default_model"]


def judge_model() -> str:
    from notes_engine.llm import PROVIDERS
    return PROVIDERS[JUDGE_PROVIDER]["default_model"]


_KEYS: dict[str, str] = {}


def key(env: str) -> str:
    """Key from the process env or backend/.env (key names are whitespace-stripped). Never printed."""
    if not _KEYS:
        try:
            from dotenv import dotenv_values
            for k, v in dotenv_values(ROOT / "backend" / ".env").items():
                if k and v:
                    _KEYS[k.strip()] = v.strip().strip("\"'")
        except Exception:  # noqa: BLE001
            pass
    return (os.environ.get(env) or _KEYS.get(env) or "").strip()


def read_json(p: Path) -> Any:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None


def write_json(p: Path, obj: Any) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, p)


def run_path(cid: str, vid: str, n: int) -> Path:
    return RUNS / cid / vid / f"{n}.json"


def transcript_text(t: dict) -> str:
    return "\n".join(str(s.get("text", "")) for s in t.get("segments", []))


_SKIP_KEYS = {"number", "next", "timestamp", "id", "type", "style", "language", "toc", "meta"}


def _strings(v: Any, out: list[str]) -> None:
    if isinstance(v, str):
        if v.strip():
            out.append(v.strip())
    elif isinstance(v, list):
        for x in v:
            _strings(x, out)
    elif isinstance(v, dict):
        for k, x in v.items():
            if k not in _SKIP_KEYS:
                _strings(x, out)


def notes_text(notes: dict) -> str:
    """Readable plain text of everything the notes say (titles, blocks, takeaways, diagrams, glossary, recap)."""
    parts: list[str] = []
    cov = notes.get("cover") or {}
    for k in ("summary", "big_idea"):
        if cov.get(k):
            parts.append(str(cov[k]))
    for s in notes.get("sections") or []:
        parts.append("## " + str(s.get("title", "")))
        rest = {k: v for k, v in s.items() if k != "title"}
        buf: list[str] = []
        _strings(rest, buf)
        parts.extend(buf)
    for g in notes.get("glossary") or []:
        parts.append(f"{g.get('term')}: {g.get('definition')}")
    buf = []
    _strings(notes.get("recap") or {}, buf)
    parts.extend(buf)
    return "\n".join(parts)


# ------------------------------------------------------------------ instrumentation ----
class Meter:
    """Counts HTTP requests, statuses, request time, provider-reported token usage and engine sleeps."""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.active = False
        self.requests = 0
        self.statuses: dict[str, int] = {}
        self.http_sec = 0.0
        self.sleep_sec = 0.0
        self.prompt_tokens = 0
        self.output_tokens = 0
        self.usage_reported = 0      # responses that carried usage
        self.ok_responses = 0


METER = Meter()
_installed = False


def install_meter() -> None:
    """Wrap notes_engine.llm's sleep and requests.post (in-process monkeypatch; engine files are untouched)."""
    global _installed
    if _installed:
        return
    from notes_engine import llm
    orig_sleep = llm._sleep
    orig_post = llm.requests.post

    def sleep(sec: float) -> None:
        if METER.active:
            METER.sleep_sec += max(0.0, sec)
        orig_sleep(sec)

    def post(*a, **kw):
        t0 = time.perf_counter()
        try:
            resp = orig_post(*a, **kw)
        except Exception as e:
            if METER.active:
                METER.requests += 1
                METER.http_sec += time.perf_counter() - t0
                n = type(e).__name__
                METER.statuses[n] = METER.statuses.get(n, 0) + 1
            raise
        if METER.active:
            METER.requests += 1
            METER.http_sec += time.perf_counter() - t0
            sc = str(resp.status_code)
            METER.statuses[sc] = METER.statuses.get(sc, 0) + 1
            if resp.status_code == 200:
                METER.ok_responses += 1
                try:
                    d = resp.json()
                except Exception:  # noqa: BLE001
                    d = None
                if isinstance(d, dict):
                    u = d.get("usageMetadata")
                    if isinstance(u, dict):
                        METER.usage_reported += 1
                        METER.prompt_tokens += int(u.get("promptTokenCount") or 0)
                        METER.output_tokens += int(u.get("candidatesTokenCount") or 0) + int(u.get("thoughtsTokenCount") or 0)
                    u = d.get("usage")
                    if isinstance(u, dict):
                        METER.usage_reported += 1
                        METER.prompt_tokens += int(u.get("prompt_tokens") or 0)
                        METER.output_tokens += int(u.get("completion_tokens") or 0)
        return resp

    llm._sleep = sleep
    llm.requests.post = post
    _installed = True


def classify_error(msg: str) -> str:
    m = (msg or "").lower()
    if "daily quota" in m:
        return "quota_daily"
    if "quota" in m or "rate limit" in m or "limit (asks to wait" in m:
        return "quota_429"
    if "timeout" in m or "network error" in m or "could not reach" in m:
        return "timeout"
    if "json" in m or "could not be turned into notes" in m:
        return "invalid_json"
    if "http 401" in m or "http 403" in m or "http 404" in m or "no api key" in m:
        return "config"
    if "overloaded" in m or "temporarily unavailable" in m:
        return "server_5xx"
    return "other"


def scrub(s: str) -> str:
    s = re.sub(r"(AIza[0-9A-Za-z_\-]{20,}|gsk_[A-Za-z0-9]{20,}|nvapi-[A-Za-z0-9_\-]{20,}|hf_[A-Za-z0-9]{20,}"
               r"|xai-[A-Za-z0-9]{20,}|Bearer\s+\S+)", "[redacted]", s or "")
    for v in _KEYS.values():
        if len(v) >= 12:
            s = s.replace(v, "[redacted]")
    return s[:500]
