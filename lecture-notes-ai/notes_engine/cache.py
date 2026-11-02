"""Small disk cache for the notes engine: transcripts and accepted LLM answers.

Off unless ``LNA_CACHE_DIR`` names a directory (``backend/run.py`` switches it on), so the library and its
tests stay free of side effects.  Entries are JSON files ``<dir>/<namespace>/<key>.json`` written atomically;
a missing, unreadable or corrupt file is simply a miss.  Once the cache is bigger than ``LNA_CACHE_MAX_MB``
(default 300) the least recently used files are deleted.  Keys are hashes or validated ids, and API keys are
never part of a key or a value.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Any

ENV_DIR = "LNA_CACHE_DIR"
ENV_MAX_MB = "LNA_CACHE_MAX_MB"
DEFAULT_MAX_MB = 300.0
_SAFE = re.compile(r"[A-Za-z0-9_-]{1,128}")


def _root() -> Path | None:
    d = os.environ.get(ENV_DIR, "").strip()
    return Path(d) if d else None


def make_key(*parts: Any) -> str:
    """Stable hex key for any JSON-able parts (prompts, model name, limits...)."""
    blob = json.dumps(parts, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _path(namespace: str, key: str) -> Path | None:
    root = _root()
    if root is None or not _SAFE.fullmatch(namespace) or not _SAFE.fullmatch(key):
        return None
    return root / namespace / f"{key}.json"


def get(namespace: str, key: str, max_age_sec: float | None = None) -> Any | None:
    """The stored value, or None (disabled, missing, corrupt, expired)."""
    p = _path(namespace, key)
    if p is None:
        return None
    try:
        with p.open("r", encoding="utf-8") as f:
            entry = json.load(f)
        saved, value = float(entry["t"]), entry["v"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if max_age_sec is not None and time.time() - saved > max_age_sec:
        return None
    try:
        os.utime(p)  # recently used files are evicted last
    except OSError:
        pass
    return value


def put(namespace: str, key: str, value: Any) -> None:
    """Store a JSON-able value.  Never raises: a cache must not break a job (disk full, odd value...)."""
    p = _path(namespace, key)
    if p is None:
        return
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=p.parent, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"t": time.time(), "v": value}, f, ensure_ascii=False)
            os.replace(tmp, p)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except (OSError, TypeError, ValueError):
        return
    _evict()


def _evict() -> None:
    root = _root()
    if root is None:
        return
    try:
        limit = float(os.environ.get(ENV_MAX_MB, DEFAULT_MAX_MB)) * 1024 * 1024
    except ValueError:
        limit = DEFAULT_MAX_MB * 1024 * 1024
    files: list[tuple[float, int, Path]] = []
    total = 0
    try:
        for f in root.glob("*/*.json"):
            try:
                st = f.stat()
            except OSError:
                continue
            files.append((st.st_mtime, st.st_size, f))
            total += st.st_size
    except OSError:
        return
    if total <= limit:
        return
    files.sort(key=lambda x: x[0])  # least recently used first
    for _m, size, f in files:
        if total <= limit * 0.9:
            break
        try:
            f.unlink()
            total -= size
        except OSError:
            pass
