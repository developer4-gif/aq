"""Tests for notes_engine.llm / prompts / notes_schema.  All HTTP is mocked (no real keys)."""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

import pytest
import requests

from notes_engine import llm, notes_schema, prompts  # noqa: E402
from notes_engine.llm import LLMError  # noqa: E402
from notes_engine.notes_schema import validate_notes  # noqa: E402

KEYS = {"gemini": "AIzaSyTESTKEY0123456789abcdefghijk", "groq": "gsk_TESTKEY0123456789abcdefghijkl",
        "xai": "xai-TESTKEY0123456789abcdefghijkl", "huggingface": "hf_TESTKEY0123456789abcdefghijkl"}


# ----------------------------------------------------------------- helpers --
def fake_chunker(transcript, max_chars=12000, overlap_chars=400):
    """Tiny stand-in for ingest.chunk_transcript (tests must not depend on Agent A's module)."""
    chunks, cur, start, last = [], [], None, 0.0
    size = 0
    last_mark = -999.0
    for seg in transcript["segments"]:
        mark = ""
        if seg["start"] - last_mark >= 30:
            m, s = divmod(int(seg["start"]), 60)
            mark = f"[{m:02d}:{s:02d}] "
            last_mark = seg["start"]
        piece = mark + seg["text"] + " "
        if cur and size + len(piece) > max_chars:
            chunks.append({"index": len(chunks), "start": start, "end": last, "text": "".join(cur).strip()})
            cur, size, start = [], 0, None
        if start is None:
            start = seg["start"]
        cur.append(piece)
        size += len(piece)
        last = seg["start"]
    if cur:
        chunks.append({"index": len(chunks), "start": start, "end": last, "text": "".join(cur).strip()})
    return chunks


def make_transcript(minutes=10, chars_per_seg=150):
    segs = []
    for i in range(minutes * 6):
        txt = (f"point {i} about distributed caching and consistency " * 10)[:chars_per_seg]
        segs.append({"start": i * 10.0, "text": txt})
    return {"video_id": "abc123DEF45", "url": "https://www.youtube.com/watch?v=abc123DEF45",
            "title": "Caching 101", "channel": "Some Channel", "duration_sec": minutes * 60,
            "language": "en", "source": "captions", "segments": segs}


def section(i):
    return {"title": f"topic {i}", "subtitle": "sub", "timestamp": f"{i:02d}:00",
            "blocks": [{"type": "paragraph", "text": f"text {i}"},
                       {"type": "definition", "term": f"term{i}", "text": f"def {i}"}],
            "diagram": {"type": "flow", "title": "t", "caption": "c",
                        "nodes": [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}],
                        "edges": [{"from": "a", "to": "b"}]},
            "key_takeaways": ["k1", "k2"], "recall": {"q": f"q{i}?", "a": f"a{i}"}}


FRONT = {"subtitle": "all about caching", "cover": {"summary": "s", "big_idea": "cache it!"},
         "glossary": [{"term": "cache", "definition": "fast store"}],
         "recap": {"title": "the whole picture, recapped", "points": ["p1", "p2"], "diagram": None}}


class FakeResp:
    def __init__(self, status=200, payload=None, text=None, headers=None):
        self.status_code = status
        self._payload = payload
        self.text = text if text is not None else (json.dumps(payload) if payload is not None else "")
        self.headers = headers or {}

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


def ok_payload(provider, text, finish=None):
    if provider == "gemini":
        return {"candidates": [{"content": {"parts": [{"text": text}]}, "finishReason": finish or "STOP"}]}
    return {"choices": [{"message": {"content": text}, "finish_reason": finish or "stop"}]}


class Recorder:
    """Replacement for requests.post; `script` is a list of responses/exceptions or a callable."""

    def __init__(self, script):
        self.script = script
        self.calls = []

    def __call__(self, url, headers=None, json=None, timeout=None, **kw):
        self.calls.append({"url": url, "headers": headers or {}, "json": json, "timeout": timeout})
        if callable(self.script):
            r = self.script(self.calls[-1], len(self.calls) - 1)
        else:
            r = self.script[min(len(self.calls) - 1, len(self.script) - 1)]
        if isinstance(r, BaseException):
            raise r
        return r


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    sleeps = []
    monkeypatch.setattr(llm, "_sleep", lambda s: sleeps.append(s))
    monkeypatch.setattr(llm, "_get_chunker", lambda: fake_chunker)
    monkeypatch.setattr(llm.random, "uniform", lambda a, b: 0.0)
    return sleeps


@pytest.fixture
def sleeps(_env):
    return _env


def install(monkeypatch, script):
    rec = Recorder(script)
    monkeypatch.setattr(llm.requests, "post", rec)
    return rec


def full_notes(n=6):
    return {**FRONT, "sections": [section(i) for i in range(n)]}


def run(provider="gemini", transcript=None, **kw):
    return llm.generate_notes(transcript or make_transcript(5), provider=provider, api_key=KEYS[provider], **kw)


# ------------------------------------------------------- request shapes -----
def test_gemini_request_shape(monkeypatch):
    rec = install(monkeypatch, [FakeResp(200, ok_payload("gemini", json.dumps(full_notes())))])
    notes = run("gemini")
    c = rec.calls[0]
    assert c["url"] == "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
    assert KEYS["gemini"] not in c["url"] and "key=" not in c["url"]
    assert c["headers"]["x-goog-api-key"] == KEYS["gemini"]
    assert "Authorization" not in c["headers"]
    body = c["json"]
    assert body["generationConfig"]["responseMimeType"] == "application/json"
    assert body["generationConfig"]["maxOutputTokens"] == 32768
    assert body["systemInstruction"]["parts"][0]["text"]
    assert body["contents"][0]["role"] == "user"
    assert c["timeout"][0] and c["timeout"][1]
    assert notes["meta"]["model"] == "gemini/gemini-2.5-flash"
    assert len(rec.calls) == 1


def test_gemini_model_prefix_and_older_model_output_cap(monkeypatch):
    rec = install(monkeypatch, [FakeResp(200, ok_payload("gemini", json.dumps(full_notes())))])
    run("gemini", model="models/gemini-2.0-flash")
    assert rec.calls[0]["url"].endswith("/models/gemini-2.0-flash:generateContent")
    assert rec.calls[0]["json"]["generationConfig"]["maxOutputTokens"] == 8192


@pytest.mark.parametrize("provider,url,model", [
    ("groq", "https://api.groq.com/openai/v1/chat/completions", "openai/gpt-oss-120b"),
    ("xai", "https://api.x.ai/v1/chat/completions", "grok-4"),
    ("huggingface", "https://router.huggingface.co/v1/chat/completions", "meta-llama/Llama-3.3-70B-Instruct"),
])
def test_openai_compatible_request_shape(monkeypatch, provider, url, model):
    rec = install(monkeypatch, pipeline_script(provider))
    notes = run(provider, transcript=make_transcript(5, 100))
    c = rec.calls[0]
    assert c["url"] == url
    assert c["headers"]["Authorization"] == f"Bearer {KEYS[provider]}"
    b = c["json"]
    assert b["model"] == model
    assert b["response_format"] == {"type": "json_object"}
    assert [m["role"] for m in b["messages"]] == ["system", "user"]
    assert b["max_tokens"] > 0
    assert "JSON" in b["messages"][1]["content"]  # Groq JSON mode requires the word JSON in the prompt
    assert notes["meta"]["model"] == f"{provider}/{model}"
    if provider == "groq":  # reasoning model: effort is pinned low, and the budget leaves room for reasoning
        assert b["reasoning_effort"] == "low"
    else:
        assert "reasoning_effort" not in b


def test_custom_model_is_used(monkeypatch):
    rec = install(monkeypatch, pipeline_script("groq"))
    run("groq", model="llama-3.1-70b-custom", transcript=make_transcript(2, 60))
    assert rec.calls[0]["json"]["model"] == "llama-3.1-70b-custom"


def test_json_mode_rejected_retries_without(monkeypatch):
    script = [FakeResp(400, {"error": {"message": "response_format json_object is not supported by this model"}}),
              FakeResp(200, ok_payload("huggingface", json.dumps(full_notes())))]
    rec = install(monkeypatch, script)
    run("huggingface", transcript=make_transcript(5, 100))
    assert "response_format" in rec.calls[0]["json"]
    assert "response_format" not in rec.calls[1]["json"]


def test_groq_json_validate_failed_uses_failed_generation(monkeypatch):
    err = {"error": {"message": "Failed to generate JSON", "code": "json_validate_failed",
                     "failed_generation": "```json\n" + json.dumps({"topics": [{"heading": "h", "facts": ["f"]}]}) + "\n```"}}
    inner = pipeline_script("groq")
    rec = install(monkeypatch, lambda c, i: FakeResp(400, err) if i == 0 else inner(c, i))
    notes = run("groq", transcript=make_transcript(5, 100))
    assert notes["sections"]
    assert kind_of(rec.calls[0]) == "digest" and kind_of(rec.calls[1]) == "digest"  # call 0 recovered, not re-sent


# ------------------------------------------------------------- key safety ---
@pytest.mark.parametrize("provider", list(KEYS))
@pytest.mark.parametrize("status", [400, 401, 403, 404, 413, 429, 500, 503])
def test_key_never_in_errors(monkeypatch, provider, status):
    key = KEYS[provider]
    payload = {"error": {"message": f"bad request for key {key} Bearer {key}", "status": "X"}}
    if status == 429:
        payload["error"]["message"] += " per day quota exceeded"
    install(monkeypatch, [FakeResp(status, payload, headers={"Retry-After": "1"})])
    with pytest.raises(LLMError) as ei:
        run(provider, transcript=make_transcript(2, 60))
    assert key not in str(ei.value)
    assert key not in repr(ei.value)
    assert "AIza" not in str(ei.value) and "gsk_" not in str(ei.value)
    assert str(ei.value).strip()


def test_key_not_in_error_for_network_failures(monkeypatch):
    install(monkeypatch, [requests.ConnectionError(f"boom {KEYS['gemini']}")])
    with pytest.raises(LLMError) as ei:
        run("gemini")
    assert KEYS["gemini"] not in str(ei.value) and ei.value.__cause__ is None


def test_friendly_messages(monkeypatch):
    install(monkeypatch, [FakeResp(401, {"error": {"message": "invalid"}})])
    with pytest.raises(LLMError, match="rejected the API key"):
        run("groq", transcript=make_transcript(2, 60))
    install(monkeypatch, [FakeResp(404, {"error": {"message": "nope"}})])
    with pytest.raises(LLMError, match="model"):
        run("gemini", model="gemini-nonexistent")
    install(monkeypatch, [FakeResp(429, {"error": {"message": "Quota exceeded for metric ... PerDay"}})])
    with pytest.raises(LLMError, match="(?i)free"):
        run("gemini")


def test_bad_inputs():
    with pytest.raises(LLMError, match="Unknown provider"):
        llm.generate_notes(make_transcript(1), provider="nope", api_key="x")
    with pytest.raises(LLMError, match="No API key"):
        llm.generate_notes(make_transcript(1), provider="groq", api_key="  ")
    with pytest.raises(LLMError, match="transcript is empty"):
        llm.generate_notes({"segments": []}, provider="groq", api_key=KEYS["groq"])
    with pytest.raises(LLMError, match="Invalid Gemini model"):
        llm.generate_notes(make_transcript(1), provider="gemini", api_key=KEYS["gemini"], model="x/../y?z")


# --------------------------------------------------------- retry / backoff --
def test_retry_after_header_honoured(monkeypatch, sleeps):
    good = FakeResp(200, ok_payload("gemini", json.dumps(full_notes())))
    rec = install(monkeypatch, [FakeResp(429, {"error": {"message": "slow down"}}, headers={"Retry-After": "7"}), good])
    run("gemini")
    assert len(rec.calls) == 2
    assert 7 <= sleeps[0] <= 8


def test_exponential_backoff_on_5xx(monkeypatch, sleeps):
    good = FakeResp(200, ok_payload("gemini", json.dumps(full_notes())))
    install(monkeypatch, [FakeResp(503, {}), FakeResp(500, {}), FakeResp(502, {}), good])
    run("gemini")
    assert sleeps == [2.0, 4.0, 8.0]


def test_retry_exhaustion(monkeypatch, sleeps):
    rec = install(monkeypatch, [FakeResp(503, {})])
    with pytest.raises(LLMError, match="(?i)unavailable"):
        run("xai")
    assert len(rec.calls) == llm.MAX_ATTEMPTS


def test_429_exhaustion_mentions_free_tier(monkeypatch):
    install(monkeypatch, [FakeResp(429, {"error": {"message": "rate"}})])
    with pytest.raises(LLMError, match="(?i)free-tier"):
        run("gemini")


def test_timeout_is_retried(monkeypatch, sleeps):
    good = FakeResp(200, ok_payload("gemini", json.dumps(full_notes())))
    rec = install(monkeypatch, [requests.Timeout("t"), good])
    run("gemini")
    assert len(rec.calls) == 2 and len(sleeps) == 1


def test_gemini_retry_delay_in_body(monkeypatch, sleeps):
    body = {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED",
                      "details": [{"retryDelay": "12s"}]}}
    good = FakeResp(200, ok_payload("gemini", json.dumps(full_notes())))
    install(monkeypatch, [FakeResp(429, body), good])
    run("gemini")
    assert 12 <= sleeps[0] <= 13


def test_groq_try_again_in_parsed(monkeypatch, sleeps):
    body = {"error": {"message": "Rate limit reached ... tokens per minute (TPM). Please try again in 6.5s."}}
    inner = pipeline_script("groq")
    install(monkeypatch, lambda c, i: FakeResp(429, body) if i == 0 else inner(c, i - 1))
    run("groq", transcript=make_transcript(2, 60))
    assert 6.5 <= sleeps[0] <= 7.5


def test_daily_quota_fails_fast(monkeypatch, sleeps):
    body = {"error": {"message": "Rate limit reached for tokens per day (TPD): Limit 100000. Please try again in 17m3s."}}
    rec = install(monkeypatch, [FakeResp(429, body)])
    with pytest.raises(LLMError, match="(?i)daily"):
        run("groq", transcript=make_transcript(2, 60))
    assert len(rec.calls) == 1 and not sleeps


# ------------------------------------------------------------ JSON repair ---
@pytest.mark.parametrize("text", [
    "```json\n{\"a\": 1}\n```",
    "Sure! Here is the JSON:\n{\"a\": 1}\nHope it helps.",
    "{\"a\": 1,}",
    "{\"a\": [1, 2,],}",
    "```\n{\"a\": \"line1\nline2\"}\n```",
])
def test_parse_json_repairs(text):
    assert isinstance(llm.parse_json(text), dict)


def test_parse_json_handles_braces_in_strings():
    assert llm.parse_json('noise {"a": "x } y {", "b": 2} tail') == {"a": "x } y {", "b": 2}


def test_parse_json_failure():
    with pytest.raises(ValueError):
        llm.parse_json("no json here")
    with pytest.raises(ValueError):
        llm.parse_json("")


def test_salvage_truncated():
    cut = '{"topics":[{"heading":"a","facts":["x","y"]},{"heading":"b","facts":["z","w'
    v = llm.salvage_truncated_json(cut)
    assert v["topics"][0]["heading"] == "a"


def test_fix_json_retry_roundtrip(monkeypatch):
    broken = '{"sections": [ {"title": "x" "blocks": [}'
    rec = install(monkeypatch, [FakeResp(200, ok_payload("gemini", broken)),
                                FakeResp(200, ok_payload("gemini", json.dumps(full_notes())))])
    notes = run("gemini")
    assert len(rec.calls) == 2
    assert "failed to parse" in rec.calls[1]["json"]["contents"][0]["parts"][0]["text"]
    assert len(notes["sections"]) == 6


def test_fenced_output_accepted_without_retry(monkeypatch):
    rec = install(monkeypatch, [FakeResp(200, ok_payload("gemini", "```json\n" + json.dumps(full_notes()) + "\n```"))])
    run("gemini")
    assert len(rec.calls) == 1


def test_malformed_twice_is_llm_error(monkeypatch):
    # single pass fails -> fallback to map-reduce -> digests degrade, batch compose fails -> LLMError
    install(monkeypatch, [FakeResp(200, ok_payload("gemini", "{{{{ not json"))])
    with pytest.raises(LLMError, match="(?i)malformed|json"):
        run("gemini")


# --------------------------------------------------- safety / empty answers --
def test_gemini_prompt_blocked(monkeypatch):
    install(monkeypatch, [FakeResp(200, {"promptFeedback": {"blockReason": "SAFETY"}})])
    with pytest.raises(LLMError, match="(?i)safety"):
        run("gemini")


def test_gemini_finish_reason_safety(monkeypatch):
    install(monkeypatch, [FakeResp(200, {"candidates": [{"finishReason": "SAFETY"}]})])
    with pytest.raises(LLMError, match="(?i)safety"):
        run("gemini")


def test_empty_choices(monkeypatch):
    install(monkeypatch, [FakeResp(200, {"choices": []})])
    with pytest.raises(LLMError, match="(?i)no answer"):
        run("xai")


# ------------------------------------------------------ pipeline behaviour --
def kind_of(call):
    if "systemInstruction" in call["json"]:
        system = call["json"]["systemInstruction"]["parts"][0]["text"]
        user = call["json"]["contents"][0]["parts"][0]["text"]
    else:
        system, user = (m["content"] for m in call["json"]["messages"])
    if system.startswith("You repair"):
        return "fix"
    if system.startswith("You are the first stage"):
        return "digest"
    if "Write the complete field-notebook notes" in user:
        return "single"
    if "This is part" in user:
        return "batch"
    if "OUTLINE:" in user:
        return "final"
    return "?"


def pipeline_script(provider, n_batch_sections=3):
    def script(call, i):
        k = kind_of(call)
        if k == "digest":
            d = {"topics": [{"heading": f"h{i}", "start": "00:10", "facts": [("fact %d " % i) * 60 for _ in range(6)],
                             "terms": [{"term": f"t{i}", "definition": "d"}]}]}
            return FakeResp(200, ok_payload(provider, json.dumps(d)))
        if k == "batch":
            n = i
            return FakeResp(200, ok_payload(provider, json.dumps({"sections": [section(n * 10 + j) for j in range(n_batch_sections)]})))
        if k == "final":
            return FakeResp(200, ok_payload(provider, json.dumps(FRONT)))
        if k == "single":
            return FakeResp(200, ok_payload(provider, json.dumps(full_notes(6))))
        raise AssertionError(k)
    return script


def test_map_reduce_long_transcript_groq(monkeypatch, sleeps):
    tr = make_transcript(minutes=120, chars_per_seg=160)  # ~115k chars
    rec = install(monkeypatch, pipeline_script("groq"))
    events = []
    notes = llm.generate_notes(tr, provider="groq", api_key=KEYS["groq"],
                               progress=lambda st, pct, msg: events.append((st, pct, msg)))
    kinds = [kind_of(c) for c in rec.calls]
    assert "single" not in kinds
    n_digest, n_batch = kinds.count("digest"), kinds.count("batch")
    assert n_digest >= 10 and n_batch >= 2 and kinds[-1] == "final"
    # ordering: all digests, then batches, then final
    assert kinds == ["digest"] * n_digest + ["batch"] * n_batch + ["final"]
    # every request stays inside Groq's free-tier 12k tokens/min once max_tokens is counted
    for c in rec.calls:
        chars = sum(len(m["content"]) for m in c["json"]["messages"])
        assert chars / llm.CHARS_PER_TOKEN + c["json"]["max_tokens"] < 0.85 * 8000, kind_of(c)  # gpt-oss: 8k TPM
    assert sleeps, "pacer should have slept to respect the tokens-per-minute limit"
    # later batches are told what was already covered
    later = [c for c in rec.calls if kind_of(c) == "batch"][1]
    assert "already written" in later["json"]["messages"][1]["content"]
    # result is validated
    assert [s["number"] for s in notes["sections"]] == list(range(2, 2 + len(notes["sections"])))
    assert notes["cover"]["toc"][0].startswith("2. ")
    assert notes["meta"]["duration"] == "2:00:00" and notes["meta"]["title"] == "Caching 101"
    assert notes["glossary"]
    # progress: all "notes" stage, monotonic non-decreasing, ends at 100
    assert {e[0] for e in events} == {"notes"}
    pcts = [e[1] for e in events]
    assert pcts == sorted(pcts) and pcts[-1] == 100


def test_map_reduce_used_for_long_gemini_when_over_single_limit(monkeypatch):
    tr = make_transcript(minutes=240, chars_per_seg=200)  # ~290k chars > 90k single limit
    rec = install(monkeypatch, pipeline_script("gemini", 5))
    notes = llm.generate_notes(tr, provider="gemini", api_key=KEYS["gemini"])
    kinds = [kind_of(c) for c in rec.calls]
    assert kinds.count("digest") >= 7 and kinds[-1] == "final" and "single" not in kinds
    assert len(notes["sections"]) <= notes_schema.MAX_SECTIONS


def test_single_pass_for_short_video(monkeypatch):
    rec = install(monkeypatch, pipeline_script("gemini"))
    notes = llm.generate_notes(make_transcript(10), provider="gemini", api_key=KEYS["gemini"])
    assert [kind_of(c) for c in rec.calls] == ["single"]
    assert len(notes["sections"]) == 6


def test_single_pass_truncation_falls_back_to_map_reduce(monkeypatch):
    def script(call, i):
        k = kind_of(call)
        if k == "single":
            return FakeResp(200, ok_payload("gemini", '{"sections":[{"title":"x","blo', finish="MAX_TOKENS"))
        return pipeline_script("gemini")(call, i)
    rec = install(monkeypatch, script)
    notes = llm.generate_notes(make_transcript(10), provider="gemini", api_key=KEYS["gemini"])
    kinds = [kind_of(c) for c in rec.calls]
    assert kinds[0] == "single" and "digest" in kinds and kinds[-1] == "final"
    assert notes["sections"]


def test_batch_truncation_splits_input(monkeypatch):
    tr = make_transcript(minutes=60, chars_per_seg=160)
    state = {"trunc": 0}

    def script(call, i):
        k = kind_of(call)
        if k == "batch" and state["trunc"] == 0:
            state["trunc"] = 1
            return FakeResp(200, ok_payload("groq", '{"sections":[{"title":"a"', finish="length"))
        return pipeline_script("groq", 2)(call, i)
    rec = install(monkeypatch, script)
    notes = llm.generate_notes(tr, provider="groq", api_key=KEYS["groq"])
    assert notes["sections"]


def test_digest_failure_degrades_instead_of_aborting(monkeypatch):
    tr = make_transcript(minutes=60, chars_per_seg=160)
    seen = {"d": 0}

    def script(call, i):
        k = kind_of(call)
        if k == "fix":
            return FakeResp(200, ok_payload("xai", "garbage {{"))
        if k == "digest" and seen["d"] < 2:
            seen["d"] += 1
            return FakeResp(200, ok_payload("xai", "garbage {{"))
        return pipeline_script("xai")(call, i)
    install(monkeypatch, script)
    # xai profile has chunk 40k -> force map-reduce via huge transcript
    tr = make_transcript(minutes=300, chars_per_seg=200)
    notes = llm.generate_notes(tr, provider="xai", api_key=KEYS["xai"])
    assert notes["sections"]


def test_final_call_failure_still_returns_notes(monkeypatch):
    tr = make_transcript(minutes=300, chars_per_seg=200)

    def script(call, i):
        k = kind_of(call)
        if k in ("final", "fix"):
            return FakeResp(200, ok_payload("gemini", "nope {{"))
        return pipeline_script("gemini")(call, i)
    install(monkeypatch, script)
    notes = llm.generate_notes(tr, provider="gemini", api_key=KEYS["gemini"])
    assert notes["glossary"]  # derived from definition blocks
    assert notes["recap"]["points"]  # derived from takeaways


def test_auth_error_mid_pipeline_propagates(monkeypatch):
    tr = make_transcript(minutes=300, chars_per_seg=200)

    def script(call, i):
        if i == 2:
            return FakeResp(401, {"error": {"message": "bad"}})
        return pipeline_script("gemini")(call, i)
    install(monkeypatch, script)
    with pytest.raises(LLMError, match="rejected the API key"):
        llm.generate_notes(tr, provider="gemini", api_key=KEYS["gemini"])


def test_progress_callback_errors_ignored(monkeypatch):
    install(monkeypatch, pipeline_script("gemini"))

    def bad(*a):
        raise RuntimeError("ui died")
    llm.generate_notes(make_transcript(10), provider="gemini", api_key=KEYS["gemini"], progress=bad)


def test_pacer_terminates_with_mocked_sleep(sleeps):
    p = llm._Pacer(12000)
    for _ in range(6):
        p.before(5000)
        p.after(5000)
    assert sleeps  # had to wait


# --------------------------------------------------------------- prompts ----
def test_prompt_example_is_valid_and_validates():
    ex = json.loads(prompts.FULL_EXAMPLE_JSON)
    notes = validate_notes(ex, make_transcript(5))
    assert notes["sections"][0]["blocks"] and notes["sections"][0]["diagram"]
    assert json.loads(prompts.SECTION_EXAMPLE_JSON)["sections"]
    assert json.loads(prompts.FRONT_EXAMPLE_JSON)["cover"]


def test_prompts_demand_knowledge_only():
    sys_, user = prompts.compose_single_messages({"title": "T"}, "[00:00] hi", 6)
    low = sys_.lower()
    for word in ("subscribe", "sponsor", "faithful", "recall", "diagram", "json"):
        assert word in low
    assert "[00:00] hi" in user
    dsys, duser = prompts.digest_messages("x", 0, 3, {"title": "T"}, 300)
    assert "sponsor" in dsys.lower() and "slice 1 of 3" in duser


def test_target_section_count():
    assert prompts.target_section_count(1800, 0) == 12  # one page per 150 s
    assert prompts.target_section_count(840, 0) == 6
    assert prompts.target_section_count(60, 0) == 6
    assert prompts.target_section_count(7200, 0) == 18
    assert prompts.target_section_count(None, 10 ** 7) == 18


# ----------------------------------------------------------- validate_notes --
def test_validate_messy_input():
    raw = {
        "meta": {"title": "llm title", "model": "x/y"},
        "cover": {"toc": ["99. wrong"], "summary": "  s  "},
        "sections": [
            {"number": 9, "title": "5. First  topic", "timestamp": 75,
             "blocks": [
                 {"type": "text", "text": "hello\nworld"},
                 {"type": "list", "items": "- a\n- b\n\n3) c"},
                 {"type": "tip", "text": "careful"},
                 {"type": "bogus", "text": "dropped"},
                 {"type": "code", "language": "PY", "code": "print(1)\nprint(2)"},
                 {"type": "table", "headers": ["a", "b"], "rows": [["1"], ["2", "3", "4"], []]},
                 {"type": "definition", "term": "", "text": "no term"},
                 {"type": "formula", "text": "E=mc^2"},
                 "bare string paragraph",
                 None, 7,
             ],
             "diagram": {"type": "flowchart", "title": "d",
                         "nodes": [{"id": "A", "label": "x" * 80}, {"id": "A", "label": "Second"}, "Third",
                                   {"label": "L" + "x" * 5}] + [{"id": f"z{i}", "label": "n"} for i in range(10)],
                         "edges": [{"from": "A", "to": "Second"}, {"from": "ghost", "to": "A"},
                                   {"source": "A", "target": "A"}, ["a_2", "A", "lab"]]},
             "key_takeaways": ["one", "two", "three", "four", "five"],
             "recall": {"question": "why?", "answer": "because"},
             "next": "garbage"},
            {"title": "empty section"},  # dropped: nothing usable
            {"title": "Second", "blocks": [{"type": "paragraph", "text": "p"}], "diagram": {"type": "flow", "nodes": [{"label": "only one"}]},
             "key_takeaways": ["kt"]},
        ],
        "glossary": {"cache": "fast", "": "x"},
        "recap": {"points": "a\nb"},
    }
    tr = make_transcript(5)
    n = validate_notes(raw, tr, model="groq/llama")
    s1, s2 = n["sections"]
    assert (s1["number"], s2["number"]) == (2, 3)
    assert s1["title"] == "First topic" and s1["timestamp"] == "01:15"
    assert [b["type"] for b in s1["blocks"]] == ["paragraph", "bullets", "callout", "code", "table", "formula", "paragraph"]
    assert s1["blocks"][1]["items"] == ["a", "b", "c"]
    assert s1["blocks"][2]["style"] == "tip"
    assert s1["blocks"][3]["language"] == "py"
    tbl = s1["blocks"][4]
    assert tbl["rows"] == [["1", ""], ["2", "3"]]
    d = s1["diagram"]
    assert d["type"] == "flow" and len(d["nodes"]) <= 8
    ids = [x["id"] for x in d["nodes"]]
    assert len(set(ids)) == len(ids)
    assert all(len(x["label"]) <= 40 for x in d["nodes"])
    for e in d["edges"]:
        assert e["from"] in ids and e["to"] in ids and e["from"] != e["to"]
    assert any(e.get("label") == "lab" for e in d["edges"])
    assert len(s1["key_takeaways"]) == 4
    assert s1["recall"] == {"q": "why?", "a": "because"}
    assert s1["next"] == "pg. 3: Second"
    assert s2["diagram"] is None  # single node is not a diagram
    assert s2["next"].startswith("pg. 4: ")
    assert s2["recall"]["a"] == "kt"  # derived from takeaway
    assert n["cover"]["toc"] == ["2. First topic", "3. Second"]
    assert n["cover"]["tagline"]
    assert n["glossary"] == [{"term": "cache", "definition": "fast"}]
    assert n["recap"]["points"] == ["a", "b"] and n["recap"]["title"]
    m = n["meta"]
    assert m["title"] == "Caching 101" and m["channel"] == "Some Channel" and m["duration"] == "0:05:00"
    assert m["source_url"] == tr["url"] and m["language"] == "en" and m["model"] == "groq/llama"
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", m["generated_on"])
    json.dumps(n)  # serialisable


def test_validate_unusable():
    for bad in ({}, {"sections": []}, {"sections": [{"title": "x"}]}, [], "not json", None):
        with pytest.raises(ValueError):
            validate_notes(bad)


def test_validate_accepts_wrapped_and_str_and_caps():
    wrapped = {"notes": {"sections": [section(i) for i in range(40)]}}
    n = validate_notes(json.dumps(wrapped))
    assert len(n["sections"]) == notes_schema.MAX_SECTIONS
    assert n["sections"][-1]["next"].startswith(f"pg. {n['sections'][-1]['number'] + 1}:")


def test_validate_diagram_default_edges():
    def mk(t, k=4):
        return validate_notes({"sections": [{"title": "t", "blocks": [{"type": "paragraph", "text": "x"}],
                                             "diagram": {"type": t, "nodes": [{"label": f"n{i}"} for i in range(k)]}}]})["sections"][0]["diagram"]
    assert len(mk("flow")["edges"]) == 3
    assert len(mk("cycle")["edges"]) == 4
    assert all(e["from"] == mk("tree")["nodes"][0]["id"] for e in mk("tree")["edges"])
    assert mk("stack")["edges"] == [] and mk("compare")["edges"] == []


def test_format_duration():
    assert notes_schema.format_duration(5025) == "1:23:45"
    assert notes_schema.format_duration(59) == "0:00:59"
    assert notes_schema.format_duration(None) == ""


def test_sample_output_fixture_is_valid_and_idempotent():
    p = Path(__file__).with_name("sample_llm_output.json")
    if not p.exists():
        pytest.skip("sample_llm_output.json not generated")
    data = json.loads(p.read_text(encoding="utf-8"))
    again = validate_notes(data, None)
    for k in ("cover", "sections", "glossary", "recap"):
        assert again[k] == data[k], k
    assert {s["diagram"]["type"] for s in data["sections"] if s["diagram"]} >= {"flow", "tree", "stack", "compare", "cycle", "timeline", "mindmap", "sequence"}


# ------------------------------------------------- reasoning models / coverage --
def user_text(call):
    if "messages" in call["json"]:
        return call["json"]["messages"][1]["content"]
    return call["json"]["contents"][0]["parts"][0]["text"]


def test_groq_model_profiles():
    g = llm._profile("groq", "openai/gpt-oss-120b")
    assert g["tpm"] == 8000 and g["reasoning_effort"] == "low" and g["reasoning_reserve"] >= 1000
    assert g["max_sections_per_call"] == 2
    assert llm._profile("groq", "openai/gpt-oss-20b")["tpm"] == 8000
    q = llm._profile("groq", "qwen/qwen3.8-27b")
    assert q["tpm"] == 6000 and q["reasoning_effort"] == "none"
    assert llm._profile("xai", "grok-4")["reasoning_effort"] is None
    assert llm.PROVIDERS["groq"]["default_model"] == "openai/gpt-oss-120b"


def test_reasoning_effort_rejected_is_dropped(monkeypatch):
    inner = pipeline_script("groq")

    def script(call, i):
        if i == 0:
            assert call["json"]["reasoning_effort"] == "low"
            return FakeResp(400, {"error": {"message": "reasoning_effort is not supported by this model"}})
        assert "reasoning_effort" not in call["json"]
        return inner(call, i)
    install(monkeypatch, script)
    assert run("groq", transcript=make_transcript(5, 100))["sections"]


def test_think_blocks_stripped(monkeypatch):
    d = {"topics": [{"heading": "h", "facts": ["f"]}]}
    inner = pipeline_script("groq")
    install(monkeypatch, lambda c, i: FakeResp(200, ok_payload("groq", "<think>hmm {not json}</think>" + json.dumps(d)))
            if kind_of(c) == "digest" else inner(c, i))
    assert run("groq", model="qwen/qwen3.8-27b", transcript=make_transcript(5, 100))["sections"]


def test_short_gpt_oss_lecture_gets_one_page_per_slice(monkeypatch):
    """14-min video, target 6 sections: gpt-oss writes only 1 section per call unless pushed.
    Coverage must still reach >= 70 % of the target via slice-wise composition + strict retry."""
    tr = make_transcript(minutes=14, chars_per_seg=150)
    target = prompts.target_section_count(840, 0)
    assert target == 6
    stricts = []

    def script(call, i):
        k = kind_of(call)
        if k == "batch":
            u = user_text(call)
            strict = "previous answer contained only" in u
            stricts.append(strict)
            n = int(re.search(r"NEVER fewer than (\d+)", u).group(1))
            return FakeResp(200, ok_payload("groq", json.dumps({"sections": [section(i * 10 + j) for j in range(n if strict else 1)]})))
        return pipeline_script("groq")(call, i)
    rec = install(monkeypatch, script)
    notes = run("groq", transcript=tr)
    kinds = [kind_of(c) for c in rec.calls]
    assert kinds.count("digest") >= 3          # slices shrunk so each compose call has <= 2 sections to write
    assert any(stricts) and not all(stricts)
    assert len(notes["sections"]) >= 5         # >= 70 % of 6
    # all requests (prompt + max_tokens incl. reasoning room) stay inside 85 % of the 8k TPM limit
    for c in rec.calls:
        chars = sum(len(m["content"]) for m in c["json"]["messages"])
        assert chars / llm.CHARS_PER_TOKEN + c["json"]["max_tokens"] < 0.85 * 8000, kind_of(c)
        assert c["json"]["reasoning_effort"] == "low"


def test_batches_cover_whole_lecture_in_order(monkeypatch):
    tr = make_transcript(minutes=14, chars_per_seg=150)
    seen = []

    def script(call, i):
        if kind_of(call) == "batch":
            u = user_text(call)
            seen.append(re.search(r"part (\d+) of (\d+)", u).groups())
            n = int(re.search(r"NEVER fewer than (\d+)", u).group(1))
            return FakeResp(200, ok_payload("groq", json.dumps({"sections": [section(i * 10 + j) for j in range(n)]})))
        return pipeline_script("groq")(call, i)
    install(monkeypatch, script)
    notes = run("groq", transcript=tr)
    assert len(seen) >= 3 and seen[0][0] == "1" and seen[-1][0] == seen[-1][1]
    assert len(notes["sections"]) >= 6


def test_single_pass_undercoverage_falls_back_to_slices(monkeypatch):
    tr = make_transcript(minutes=14, chars_per_seg=150)  # target 6

    def script(call, i):
        if kind_of(call) == "single":
            return FakeResp(200, ok_payload("gemini", json.dumps(full_notes(3))))  # 3 < 70 % of 6
        if kind_of(call) == "batch":
            n = int(re.search(r"NEVER fewer than (\d+)", user_text(call)).group(1))
            return FakeResp(200, ok_payload("gemini", json.dumps({"sections": [section(i * 10 + j) for j in range(n)]})))
        return pipeline_script("gemini")(call, i)
    rec = install(monkeypatch, script)
    events = []
    notes = llm.generate_notes(tr, provider="gemini", api_key=KEYS["gemini"],
                               progress=lambda *a: events.append(a))
    kinds = [kind_of(c) for c in rec.calls]
    assert kinds[0] == "single" and "digest" in kinds and "batch" in kinds
    assert len(notes["sections"]) >= 5
    assert any("slice by slice" in e[2] for e in events)


def test_single_pass_prompt_demands_count():
    _, user = prompts.compose_single_messages({"title": "T"}, "[00:00] x", 6)
    assert "never fewer than 6" in user and "2.5 minutes" in user


def test_final_prompt_fits_groq_budget(monkeypatch):
    client = llm._Client("groq", KEYS["groq"], "openai/gpt-oss-120b")
    outline = [{"title": "t" * 60, "subtitle": "s" * 60, "key_takeaways": ["k" * 200, "k" * 200, "k" * 200]}
               for _ in range(18)]
    terms = [f"term{i}: " + "d" * 140 for i in range(40)]
    sysm, user = llm._final_messages_fit(client, {"title": "T"}, outline, terms)
    est = (len(sysm) + len(user)) / llm.CHARS_PER_TOKEN + client.profile["final_out"]
    assert est < 0.85 * 8000


# ------------------------------------------------------ mindmap / sequence ----
def dg(d):
    """Coerce one diagram through the public entry point (a section needs some content to survive)."""
    return validate_notes({"sections": [{"title": "t", "blocks": [{"type": "paragraph", "text": "x"}],
                                         "diagram": d}]})["sections"][0]["diagram"]


def mm(nodes, **kw):
    return dg({"type": "mindmap", "nodes": nodes, **kw})


def parents(d):
    return {n["id"]: n.get("parent") for n in d["nodes"]}


def depth_of(d, nid):
    p, n = parents(d), 0
    while p[nid]:
        nid, n = p[nid], n + 1
    return n


@pytest.mark.parametrize("alias,canon", [
    ("mind map", "mindmap"), ("mind-map", "mindmap"), ("Mind_Map", "mindmap"), ("mindmap", "mindmap"),
    ("sequence diagram", "sequence"), ("Sequence-Diagram", "sequence"), ("sequence", "sequence"),
    ("flowchart", "flow"), ("process", "flow"),
])
def test_diagram_type_aliases(alias, canon):
    nodes = [{"id": "a", "label": "A"}, {"id": "b", "label": "B", "parent": "a"}]
    edges = [{"from": "a", "to": "b", "label": "x"}]
    assert dg({"type": alias, "nodes": nodes, "edges": edges})["type"] == canon


def test_mindmap_parent_fields_and_edges_output_empty():
    d = mm([{"id": "r", "label": "Root"}, {"id": "a", "label": "A", "parent": "r", "detail": "d"},
            {"id": "b", "label": "B", "parent": "r"}, {"id": "a1", "label": "A1", "parent": "a"}],
           edges=[{"from": "r", "to": "a"}])
    assert d["type"] == "mindmap" and d["edges"] == []
    assert parents(d) == {"r": None, "a": "r", "b": "r", "a1": "a"}
    assert "parent" not in d["nodes"][0] and d["nodes"][1]["detail"] == "d"


def test_mindmap_parent_by_label():
    d = mm([{"id": "r", "label": "Root"}, {"label": "Leaf one", "parent": "Root"}, {"label": "Leaf two", "parent": "r"}])
    assert sorted(v for v in parents(d).values() if v) == ["r", "r"]


def test_mindmap_nested_children():
    d = mm([{"label": "Caching", "children": [
        {"label": "Where", "children": ["browser", {"label": "CDN"}]},
        "Eviction", {"label": "Policies", "children": [{"label": "LRU"}]}]}])
    p = {n["label"]: n.get("parent") for n in d["nodes"]}
    ids = {n["label"]: n["id"] for n in d["nodes"]}
    assert d["nodes"][0]["label"] == "Caching" and p["Caching"] is None
    assert p["Where"] == p["Eviction"] == p["Policies"] == ids["Caching"]
    assert p["browser"] == p["CDN"] == ids["Where"] and p["LRU"] == ids["Policies"]
    assert max(depth_of(d, i) for i in ids.values()) == 2


def test_mindmap_single_root_dict_and_root_key():
    d = dg({"type": "mindmap", "nodes": {"label": "R", "children": ["a", "b"]}})
    assert len(d["nodes"]) == 3
    d = dg({"type": "mindmap", "root": {"label": "R", "children": ["a"]}})
    assert len(d["nodes"]) == 2


def test_mindmap_from_edges_only():
    d = mm([{"id": "r", "label": "R"}, {"id": "a", "label": "A"}, {"id": "b", "label": "B"}, {"id": "c", "label": "C"}],
           edges=[["r", "a"], ["r", "b"], {"source": "a", "target": "c"}])
    assert parents(d) == {"r": None, "a": "r", "b": "r", "c": "a"}


def test_mindmap_depth_cap_reparents_to_depth1_ancestor():
    d = mm([{"id": "r", "label": "R"}, {"id": "a", "label": "A", "parent": "r"}, {"id": "b", "label": "B", "parent": "a"},
            {"id": "c", "label": "C", "parent": "b"}, {"id": "e", "label": "E", "parent": "c"}])
    assert parents(d)["b"] == "a" and parents(d)["c"] == "a" and parents(d)["e"] == "a"
    assert all(depth_of(d, n["id"]) <= 2 for n in d["nodes"])


def test_mindmap_node_cap_is_ten():
    d = mm([{"id": "r", "label": "R"}] + [{"id": f"n{i}", "label": f"N{i}", "parent": "r"} for i in range(20)])
    assert len(d["nodes"]) == notes_schema.MAX_MINDMAP_NODES == 10
    assert len(dg({"type": "flow", "nodes": [{"label": f"n{i}"} for i in range(20)]})["nodes"]) == 8  # others keep 8


def test_mindmap_nested_cap_keeps_top_level_branches():
    d = mm([{"label": "R", "children": [{"label": f"b{i}", "children": [f"b{i}x", f"b{i}y"]} for i in range(5)]}])
    labels = [n["label"] for n in d["nodes"]]
    assert len(labels) == 10 and all(f"b{i}" in labels for i in range(5))  # breadth first


def test_mindmap_unknown_parent_orphans_attach_to_root():
    d = mm([{"id": "r", "label": "R"}, {"id": "a", "label": "A", "parent": "ghost"}, {"id": "b", "label": "B"}])
    assert parents(d) == {"r": None, "a": "r", "b": "r"}


def test_mindmap_no_root_cycle_first_node_becomes_root():
    d = mm([{"id": "x", "label": "X", "parent": "y"}, {"id": "y", "label": "Y", "parent": "x"},
            {"id": "z", "label": "Z", "parent": "z"}])
    assert d["nodes"][0]["id"] == "x" and parents(d)["x"] is None
    assert sum(1 for v in parents(d).values() if v is None) == 1
    assert all(depth_of(d, n["id"]) <= 2 for n in d["nodes"])


def test_mindmap_several_roots_first_wins_and_root_moves_first():
    d = mm([{"id": "a", "label": "A"}, {"id": "b", "label": "B"}, {"id": "c", "label": "C", "parent": "b"}])
    assert parents(d) == {"a": None, "b": "a", "c": "b"}
    d = mm([{"id": "k", "label": "K", "parent": "r"}, {"id": "r", "label": "R"}])  # lone root not listed first
    assert d["nodes"][0]["id"] == "r" and parents(d) == {"r": None, "k": "r"}


def test_mindmap_too_few_nodes_dropped():
    assert dg({"type": "mindmap", "nodes": [{"label": "alone"}]}) is None
    assert dg({"type": "mindmap", "nodes": "nope"}) is None


def test_mindmap_duplicate_labels_get_unique_ids():
    d = mm([{"label": "R"}, {"label": "same", "parent": "R"}, {"label": "same", "parent": "R"}])
    ids = [n["id"] for n in d["nodes"]]
    assert len(set(ids)) == 3


def test_sequence_basic_order_and_self_message():
    d = dg({"type": "sequence", "nodes": [{"id": "c", "label": "Client"}, {"id": "s", "label": "Server"}],
            "edges": [{"from": "c", "to": "s", "label": "login"}, {"from": "s", "to": "s", "label": "hash pw"},
                      {"from": "s", "to": "c", "label": "token"}, {"from": "c", "to": "s", "label": "login"}]})
    assert [(e["from"], e["to"], e["label"]) for e in d["edges"]] == [
        ("c", "s", "login"), ("s", "s", "hash pw"), ("s", "c", "token"), ("c", "s", "login")]  # order + repeats kept


def test_self_edges_still_dropped_for_other_types():
    for t in ("flow", "cycle", "tree", "stack", "compare", "timeline"):
        d = dg({"type": t, "nodes": [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}],
                "edges": [{"from": "a", "to": "a"}, {"from": "a", "to": "b"}]})
        assert all(e["from"] != e["to"] for e in d["edges"]), t


def test_sequence_label_defaults_and_aliases():
    d = dg({"type": "sequence", "nodes": ["A", "B"],
            "edges": [{"from": "A", "to": "B"}, {"from": "B", "to": "A", "message": "ack"}, ["A", "B", "ping"],
                      {"source": "A", "target": "B", "label": "  "}]})
    assert [e["label"] for e in d["edges"]] == ["calls", "ack", "ping", "calls"]


def test_sequence_unknown_actor_autoadded_when_room():
    d = dg({"type": "sequence", "nodes": ["Client", "Server"],
            "edges": [{"from": "Client", "to": "Server", "label": "q"}, {"from": "Server", "to": "Database", "label": "sql"},
                      {"from": "Database", "to": "Server", "label": "rows"}]})
    assert [n["label"] for n in d["nodes"]] == ["Client", "Server", "Database"]
    ids = [n["id"] for n in d["nodes"]]
    assert all(e["from"] in ids and e["to"] in ids for e in d["edges"]) and len(d["edges"]) == 3
    assert d["edges"][1]["to"] == "database" == d["edges"][2]["from"]


def test_sequence_unknown_actor_dropped_when_full_and_no_partial_actor():
    d = dg({"type": "sequence", "nodes": ["a", "b", "c", "d"],
            "edges": [["a", "e", "x"], ["a", "f", "y"], ["a", "b", "z"]]})
    assert [n["label"] for n in d["nodes"]] == ["a", "b", "c", "d", "e"]  # 5th actor added, 6th refused
    assert [e["label"] for e in d["edges"]] == ["x", "z"]
    d = dg({"type": "sequence", "nodes": ["a", "b", "c", "d", "e"], "edges": [["a", "zz", "x"], ["a", "b", "ok"]]})
    assert len(d["nodes"]) == 5 and [e["label"] for e in d["edges"]] == ["ok"]


def test_sequence_caps_actors_and_messages():
    d = dg({"type": "sequence", "nodes": [f"actor{i}" for i in range(9)],
            "edges": [{"from": f"actor{i % 5}", "to": f"actor{(i + 1) % 5}", "label": f"m{i}"} for i in range(15)]})
    assert len(d["nodes"]) == notes_schema.MAX_SEQ_ACTORS == 5
    assert [e["label"] for e in d["edges"]] == [f"m{i}" for i in range(8)]


def test_sequence_empty_endpoints_dropped_and_fallback_edges():
    d = dg({"type": "sequence", "nodes": ["a", "b"],
            "edges": [{"from": "", "to": "b", "label": "x"}, {"from": "a", "label": "y"}, "junk", None]})
    assert d["edges"] == [{"from": "a", "to": "b", "label": "calls"}]  # nothing valid -> default wiring
    assert dg({"type": "sequence", "nodes": ["only"], "edges": []}) is None


def test_sequence_actors_from_edges_when_nodes_missing():
    d = dg({"type": "sequence", "edges": [["Browser", "API", "GET /x"], ["API", "Browser", "200"]]})
    assert [n["label"] for n in d["nodes"]] == ["Browser", "API"] and len(d["edges"]) == 2


@pytest.mark.parametrize("diagram", [
    {"type": "mind map", "title": "t", "nodes": [{"label": "R", "children": [{"label": "a", "children": [
        {"label": "b", "children": ["c"]}]}, "d"]}]},
    {"type": "mindmap", "nodes": [{"id": "x", "label": "X", "parent": "y"}, {"id": "y", "label": "Y", "parent": "x"}]},
    {"type": "mindmap", "nodes": [{"id": "r", "label": "R"}, {"id": "a", "label": "A"}], "edges": [["r", "a"]]},
    {"type": "sequence diagram", "nodes": ["a", "b"], "edges": [["a", "a", "s"], ["a", "c", "t"], ["c", "b"]]},
])
def test_new_diagram_types_roundtrip_idempotent(diagram):
    once = dg(diagram)
    assert once and dg(once) == once
    assert json.loads(json.dumps(once)) == once


def test_prompts_describe_all_eight_diagram_types():
    low = prompts.RULES
    for t in ("flow", "stack", "compare", "cycle", "tree", "timeline", "mindmap", "sequence"):
        assert t in low
    assert "topic overview" in low and "request/response" in low
    assert "mindmap" in prompts.DIGEST_SHAPE and "sequence" in prompts.DIGEST_SHAPE
    assert set(notes_schema.DIAGRAM_TYPES) == {"flow", "stack", "compare", "cycle", "tree", "timeline", "mindmap", "sequence"}
