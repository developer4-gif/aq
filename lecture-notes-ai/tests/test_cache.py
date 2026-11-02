"""Disk cache: unit behaviour, and its use for transcripts, digests and composed sections."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from notes_engine import cache, ingest, llm  # noqa: E402

SECRET = "gsk_TESTSECRET0123456789abcdefghijkl"
VIDEO = "dQw4w9WgXcQ"


@pytest.fixture
def cdir(tmp_path, monkeypatch):
    d = tmp_path / "cache"
    monkeypatch.setenv("LNA_CACHE_DIR", str(d))
    monkeypatch.delenv("LNA_CACHE_MAX_MB", raising=False)
    return d


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    monkeypatch.setattr(llm, "_sleep", lambda s: None)


# ------------------------------------------------------------------ unit ----
def test_disabled_without_env(monkeypatch, tmp_path):
    monkeypatch.delenv("LNA_CACHE_DIR", raising=False)
    cache.put("ns", "k1", {"a": 1})
    assert cache.get("ns", "k1") is None


def test_roundtrip_and_overwrite(cdir):
    cache.put("ns", "k1", {"a": [1, 2], "b": "ü"})
    assert cache.get("ns", "k1") == {"a": [1, 2], "b": "ü"}
    cache.put("ns", "k1", {"a": 2})
    assert cache.get("ns", "k1") == {"a": 2}
    assert cache.get("ns", "other") is None
    assert cache.get("other", "k1") is None


def test_falsy_values_are_stored(cdir):
    cache.put("ns", "zero", 0)
    cache.put("ns", "empty", [])
    assert cache.get("ns", "zero") == 0
    assert cache.get("ns", "empty") == []


def test_corrupt_and_wrong_shape_files_are_misses(cdir):
    cache.put("ns", "k1", 1)
    p = cdir / "ns" / "k1.json"
    p.write_text("{not json", encoding="utf-8")
    assert cache.get("ns", "k1") is None
    p.write_text("[1, 2, 3]", encoding="utf-8")  # valid JSON, not an entry
    assert cache.get("ns", "k1") is None
    p.write_bytes(b"\xff\xfe\x00")
    assert cache.get("ns", "k1") is None


def test_unsafe_names_are_ignored(cdir):
    for ns, key in [("../x", "k"), ("ns", "../escape"), ("ns", "a/b"), ("", "k"), ("ns", ""), ("ns", "k" * 200)]:
        cache.put(ns, key, 1)
        assert cache.get(ns, key) is None
    assert not (cdir.parent / "escape.json").exists()
    assert not cdir.exists() or not list(cdir.rglob("*.json"))


def test_expiry(cdir):
    cache.put("ns", "k1", 1)
    p = cdir / "ns" / "k1.json"
    entry = json.loads(p.read_text(encoding="utf-8"))
    entry["t"] -= 10 * 86400
    p.write_text(json.dumps(entry), encoding="utf-8")
    assert cache.get("ns", "k1", max_age_sec=5 * 86400) is None
    assert cache.get("ns", "k1", max_age_sec=20 * 86400) == 1
    assert cache.get("ns", "k1") == 1


def test_put_never_raises_on_unserialisable_value(cdir):
    cache.put("ns", "k1", {"x": object()})  # default=str is for keys only: values must be JSON-able
    assert cache.get("ns", "k1") is None
    assert not list((cdir / "ns").glob("*.tmp"))  # no half-written leftovers


def test_make_key_is_stable_and_sensitive():
    a = cache.make_key("digest", 1, "groq", "m", ("sys", "user"), 2000)
    assert a == cache.make_key("digest", 1, "groq", "m", ("sys", "user"), 2000)
    assert a != cache.make_key("digest", 1, "groq", "m", ("sys", "user2"), 2000)
    assert a != cache.make_key("digest", 2, "groq", "m", ("sys", "user"), 2000)
    assert len(a) == 64


def test_eviction_removes_least_recently_used(cdir, monkeypatch):
    monkeypatch.setenv("LNA_CACHE_MAX_MB", "0.002")  # ~2 KB
    blob = "x" * 600
    for i, name in enumerate(["old", "mid", "new"]):
        cache.put("ns", name, blob)
        os.utime(cdir / "ns" / f"{name}.json", (1000 + i, 1000 + i))
    assert cache.get("ns", "old") == blob  # a read refreshes it, so "mid" is now the oldest
    cache.put("ns", "newest", blob)
    left = {p.stem for p in (cdir / "ns").glob("*.json")}
    assert "newest" in left and "mid" not in left


# ------------------------------------------------------------ transcripts ----
def _transcript_patches(monkeypatch, calls):
    segs = [{"start": 0.0, "text": "hello world"}, {"start": 5.0, "text": "second line"}]

    def fetch(video_id):
        calls.append(video_id)
        return segs, "en", "captions", 12.0

    monkeypatch.setattr(ingest, "_get_metadata", lambda vid, c: ("Title", "Chan", 600))
    monkeypatch.setattr(ingest, "_fetch_via_api", fetch)


def test_transcript_is_fetched_once(cdir, monkeypatch):
    calls: list[str] = []
    _transcript_patches(monkeypatch, calls)
    first = ingest.get_transcript(f"https://youtu.be/{VIDEO}", groq_key=SECRET)
    second = ingest.get_transcript(f"https://www.youtube.com/watch?v={VIDEO}", groq_key=SECRET)
    assert calls == [VIDEO]
    assert second == first and second["video_id"] == VIDEO
    assert SECRET not in "".join(p.read_text(encoding="utf-8") for p in cdir.rglob("*.json"))


def test_transcript_cache_reports_progress_and_respects_age(cdir, monkeypatch):
    calls: list[str] = []
    _transcript_patches(monkeypatch, calls)
    ingest.get_transcript(f"https://youtu.be/{VIDEO}")
    seen: list[tuple] = []
    ingest.get_transcript(f"https://youtu.be/{VIDEO}", progress=lambda *a: seen.append(a))
    assert seen[-1][1] == 100 and "saved earlier" in seen[-1][2]
    p = cdir / "transcript" / f"{VIDEO}.json"
    entry = json.loads(p.read_text(encoding="utf-8"))
    entry["t"] -= (ingest.TRANSCRIPT_CACHE_DAYS + 1) * 86400
    p.write_text(json.dumps(entry), encoding="utf-8")
    ingest.get_transcript(f"https://youtu.be/{VIDEO}")
    assert calls == [VIDEO, VIDEO]  # expired entry -> fetched again


def test_transcript_cache_off_by_default(monkeypatch):
    monkeypatch.delenv("LNA_CACHE_DIR", raising=False)
    calls: list[str] = []
    _transcript_patches(monkeypatch, calls)
    ingest.get_transcript(f"https://youtu.be/{VIDEO}")
    ingest.get_transcript(f"https://youtu.be/{VIDEO}")
    assert calls == [VIDEO, VIDEO]


# ---------------------------------------------------------------- digests ----
DIGEST = {"topics": [{"start": "00:10", "heading": "Caching", "facts": ["a cache stores recent results"]}]}
META = {"title": "T", "channel": "C", "duration": "10:00"}


def _client(monkeypatch, replies):
    client = llm._Client("groq", SECRET, "openai/gpt-oss-120b")
    seen: list[tuple] = []

    def complete(system, user, max_tokens, temperature=0.3):
        seen.append((system, user))
        r = replies[min(len(seen) - 1, len(replies) - 1)]
        return (r if isinstance(r, str) else json.dumps(r)), False

    monkeypatch.setattr(client, "complete", complete)
    return client, seen


def test_digest_is_reused_on_the_second_run(cdir, monkeypatch):
    client, seen = _client(monkeypatch, [DIGEST])
    chunks = [{"text": "[00:10] a cache stores recent results", "start": 10}]
    first = llm._digest_chunks(client, chunks, META, lambda *a: None)
    n = len(seen)
    second = llm._digest_chunks(client, chunks, META, lambda *a: None)
    assert first == second and "a cache stores recent results" in first[0]
    assert len(seen) == n  # served from the cache: no model call
    assert SECRET not in "".join(p.read_text(encoding="utf-8") for p in cdir.rglob("*.json"))


def test_digest_depends_on_text_and_model(cdir, monkeypatch):
    client, seen = _client(monkeypatch, [DIGEST])
    llm._digest_chunks(client, [{"text": "[00:10] one", "start": 10}], META, lambda *a: None)
    n = len(seen)
    llm._digest_chunks(client, [{"text": "[00:10] two", "start": 10}], META, lambda *a: None)
    assert len(seen) > n
    other = llm._Client("groq", SECRET, "another-model")
    monkeypatch.setattr(other, "complete", client.complete)
    n = len(seen)
    llm._digest_chunks(other, [{"text": "[00:10] one", "start": 10}], META, lambda *a: None)
    assert len(seen) > n


def test_degraded_digest_is_not_cached(cdir, monkeypatch):
    client, seen = _client(monkeypatch, ["this is not json at all"])
    chunks = [{"text": "[00:10] raw text of the slice", "start": 10}]
    first = llm._digest_chunks(client, chunks, META, lambda *a: None)
    assert first and "raw text of the slice" in first[0]  # fallback: the raw slice head
    n = len(seen)
    llm._digest_chunks(client, chunks, META, lambda *a: None)
    assert len(seen) > n  # asked the model again instead of replaying the fallback
    assert not list(cdir.rglob("digest/*.json"))


# --------------------------------------------------------------- compose ----
def _sample_sections():
    p = Path(__file__).with_name("sample_llm_output.json")
    if not p.exists():
        pytest.skip("sample_llm_output.json not generated")
    return json.loads(p.read_text(encoding="utf-8"))["sections"][:3]


def test_accepted_compose_is_reused(cdir, monkeypatch):
    sections = _sample_sections()
    client, seen = _client(monkeypatch, [{"sections": sections}])
    args = (client, META, ["## [00:10] topic\n- fact"], 3, 6, [], 1, 1)
    first = llm._compose_covered(*args)
    n = len(seen)
    second = llm._compose_covered(*args)
    assert second == first and len(seen) == n


def test_short_compose_answer_is_not_cached(cdir, monkeypatch):
    sections = _sample_sections()
    client, seen = _client(monkeypatch, [{"sections": sections[:1]}])  # 1 of the 3 asked for: below 70 %
    args = (client, META, ["## [00:10] topic\n- fact"], 3, 6, [], 1, 1)
    llm._compose_covered(*args)
    n = len(seen)
    llm._compose_covered(*args)
    assert len(seen) > n
    assert not list(cdir.rglob("compose/*.json"))
