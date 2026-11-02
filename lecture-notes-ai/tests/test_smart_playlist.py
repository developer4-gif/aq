"""Smart playlist: verification logic, engine run with a fake LLM client, and the /api/smart routes (no network)."""
import json
import threading
import time
import types

import pytest

from app import server as srv  # noqa: E402
from notes_engine import smart_playlist as sp

SECRET = "AIza-test-SECRET-1234567890"
IDS = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd"]
EXC = {  # excerpts the "model" quotes from
    IDS[0]: "[00:00] A load balancer spreads incoming traffic across many servers. [00:09] It keeps the service available.",
    IDS[1]: "[00:00] Sharding splits a large database into smaller parts called shards.",
    IDS[2]: "[00:00] Python decorators wrap a function to add behaviour.",
    IDS[3]: "",  # no transcript
}


def make_inputs():
    return {"goal": "System Design", "videos": [
        {"id": i, "title": f"Title {n}", "channel": "Chan", "duration_sec": 300, "excerpt": EXC[i]} for n, i in enumerate(IDS)]}


def a1(topics=None):
    t = topics or {
        IDS[0]: [("Load balancing", "spreads incoming traffic across many servers"), ("Availability", "keeps the service available")],
        IDS[1]: [("Sharding", "splits a large database into smaller parts"), ("Invented", "this sentence is not in the transcript")],
    }
    return {"profiles": [{"video_id": v, "level": "beginner", "summary": "s",
                          "topics": [{"name": n, "evidence": e} for n, e in rows], "prerequisites": ["x"]}
                         for v, rows in t.items()]}


# ---- the Result validator (also used on the real run) ----------------------------------------------------------
def validate_result(res, video_ids, known_playlist=None):
    """Asserts `res` matches section 1 of docs/smart-playlist-contract.md."""
    ids = list(video_ids)
    assert set(res) == {"goal", "path_summary", "order", "unplaced", "off_goal", "areas", "suggestions",
                        "video_topics", "checks", "stats"}
    assert isinstance(res["goal"], str) and isinstance(res["path_summary"], str)
    placed = [r["video_id"] for r in res["order"]] + [r["video_id"] for r in res["unplaced"]]
    assert sorted(placed) == sorted(ids), "every video exactly once in order or unplaced"
    for r in res["order"] + res["unplaced"] + res["off_goal"]:
        assert set(r) == {"video_id", "reason"} and r["video_id"] in ids and isinstance(r["reason"], str)
    for a in res["areas"]:
        assert set(a) == {"area", "why", "status", "covered_by", "priority"} and a["area"]
        assert a["status"] in ("covered", "partial", "missing") and a["priority"] in ("high", "medium", "low")
        assert all(v in ids for v in a["covered_by"])
        assert bool(a["covered_by"]) == (a["status"] != "missing")
    n_cands = 0
    for s in res["suggestions"]:
        assert set(s) == {"topic", "reason", "kind", "search_query", "candidates"} and s["topic"] and s["search_query"]
        assert s["kind"] in ("overview", "deep-dive", "practice")
        for c in s["candidates"]:
            assert set(c) == {"id", "title", "channel", "duration_sec", "url"} and len(c["id"]) == 11
            assert 120 <= c["duration_sec"] <= 1500 and c["id"] not in ids
            assert c["url"] == f"https://www.youtube.com/watch?v={c['id']}"
            n_cands += 1
    assert set(res["video_topics"]) == set(ids)
    for t in res["video_topics"].values():
        assert set(t) == {"level", "summary", "topics"} and t["level"] in ("beginner", "intermediate", "advanced")
        assert all(isinstance(x, str) for x in t["topics"])
    assert res["checks"] and all(isinstance(c, str) for c in res["checks"])
    st = res["stats"]
    assert set(st) == {"topics_claimed", "topics_grounded", "videos_readded_to_order", "areas_downgraded_to_missing",
                       "suggestions", "candidates_found"}
    assert st["topics_grounded"] <= st["topics_claimed"]
    assert st["suggestions"] == len(res["suggestions"]) and st["candidates_found"] == n_cands


def validate_usage(u):
    assert set(u) == {"calls", "total_tokens", "wall_seconds", "api_seconds", "waiting_seconds"}
    assert u["calls"] >= 1 and all(u[k] >= 0 for k in u)


# ---- pure verification --------------------------------------------------------------------------------------------
def test_grounding():
    ex = EXC[IDS[0]]
    assert sp._is_grounded("Spreads incoming TRAFFIC across many servers!", ex)      # case / punctuation tolerant
    assert not sp._is_grounded("spreads traffic across servers", ex)                 # not a verbatim quote
    assert not sp._is_grounded("traffic", ex)                                        # one word proves nothing
    assert not sp._is_grounded("anything at all", "")


def test_excerpt_windows():
    segs = [{"start": i * 5, "text": "word " * 20} for i in range(100)]
    ex = sp._excerpt(segs)
    assert ex.count(" ... ") == 2 and len(ex) <= sp.WINDOW_CHARS * 3 + 2 * len(" ... ")
    assert sp._excerpt(segs[:2]).startswith("[00:00]")


def test_verify_drops_unsupported_topics_and_fills_video_topics():
    res = sp.verify(make_inputs(), a1(), {}, {})
    assert res["stats"]["topics_claimed"] == 4 and res["stats"]["topics_grounded"] == 3
    assert res["video_topics"][IDS[1]]["topics"] == ["Sharding"]
    assert res["video_topics"][IDS[2]]["topics"] == [] and res["video_topics"][IDS[2]]["level"] == "intermediate"
    assert any("1 unsupported topic" in c for c in res["checks"])
    assert any("No transcript could be fetched for 1" in c for c in res["checks"])     # IDS[3] has no excerpt
    assert any("no profile for 2" in c for c in res["checks"])


def test_verify_order_is_a_permutation():
    a2 = {"order": [{"video_id": IDS[1], "reason": "r"}, {"video_id": IDS[1], "reason": "dup"},
                    {"video_id": "zzzzzzzzzzz", "reason": "unknown id"}, {"video_id": IDS[0], "reason": "r"}],
          "unplaced": [{"video_id": IDS[1], "reason": "already in order"}, {"video_id": IDS[2], "reason": "off topic"}],
          "path_summary": " Start with sharding. "}
    res = sp.verify(make_inputs(), a1(), a2, {})
    assert [r["video_id"] for r in res["order"]] == [IDS[1], IDS[0], IDS[3]]        # IDS[3] re-added at the end
    assert [r["video_id"] for r in res["unplaced"]] == [IDS[2]]
    assert res["stats"]["videos_readded_to_order"] == 1 and res["path_summary"] == "Start with sharding."
    validate_result(res, IDS)


def test_verify_covered_needs_a_real_citation():
    a3 = {"areas": [
        {"area": "Caching", "why": "w", "status": "covered", "covered_by": ["nope"], "priority": "high"},       # invented id
        {"area": "Sharding", "why": "w", "status": "covered", "covered_by": [IDS[1], IDS[1], "nope"], "priority": "bogus"},
        {"area": "Replication", "why": "w", "status": "partial", "covered_by": [], "priority": "low"},
        {"area": "Queues", "why": "w", "status": "missing", "covered_by": [IDS[0]], "priority": "low"},        # missing cites nothing
        {"area": "", "why": "no name", "status": "missing"}, "junk",
    ], "off_goal": [{"video_id": IDS[2], "reason": "python"}, {"video_id": "nope", "reason": "x"}]}
    res = sp.verify(make_inputs(), a1(), {}, a3)
    got = {a["area"]: a for a in res["areas"]}
    assert list(got) == ["Caching", "Sharding", "Replication", "Queues"]
    assert got["Caching"]["status"] == "missing" and got["Caching"]["covered_by"] == []
    assert got["Sharding"]["status"] == "covered" and got["Sharding"]["covered_by"] == [IDS[1]]
    assert got["Sharding"]["priority"] == "medium"
    assert got["Replication"]["status"] == "missing" and got["Queues"]["covered_by"] == []
    assert res["stats"]["areas_downgraded_to_missing"] == 2
    assert res["off_goal"] == [{"video_id": IDS[2], "reason": "python"}]


def test_verify_suggestions_are_cleaned():
    a3 = {"suggestions": [{"topic": f"T{i}", "reason": "r", "kind": "weird", "search_query": f"q{i}"} for i in range(9)]
          + [{"topic": "no query", "search_query": ""}]}
    res = sp.verify(make_inputs(), a1(), {}, a3)
    assert len(res["suggestions"]) == sp.MAX_SUGGESTIONS
    assert res["suggestions"][0]["kind"] == "overview" and res["suggestions"][0]["candidates"] == []


def test_verify_survives_garbage():
    res = sp.verify(make_inputs(), {"profiles": "x"}, {"order": "x", "unplaced": [1, None]}, {"areas": {"a": 1}, "suggestions": 5})
    validate_result(res, IDS)


# ---- candidates ----------------------------------------------------------------------------------------------------
def test_search_youtube_filters(monkeypatch):
    entries = [{"id": "x" * 11, "duration": 600, "title": "ok", "channel": "C"},
               {"id": IDS[0], "duration": 600, "title": "already in playlist"},
               {"id": "y" * 11, "duration": 60, "title": "too short"},
               {"id": "z" * 11, "duration": 4000, "title": "too long"},
               {"id": "w" * 11, "duration": None, "title": "live"},
               {"id": "bad", "duration": 600, "title": "bad id"},
               {"id": "v" * 11, "duration": 300.0, "title": "also ok", "uploader": "U"},
               {"id": "u" * 11, "duration": 300, "title": "over the limit"}]

    class FakeYDL:
        def __init__(self, opts): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def extract_info(self, q, download=False): return {"entries": entries}

    import yt_dlp
    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeYDL)
    got = sp._search_youtube("q", {IDS[0]})
    assert [c["id"] for c in got] == ["x" * 11, "v" * 11]
    assert got[1]["duration_sec"] == 300 and got[1]["channel"] == "U" and got[0]["url"].endswith("x" * 11)


def test_add_candidates_never_offers_a_video_twice(monkeypatch):
    c = lambda i: {"id": i * 11, "title": "t", "channel": "c", "duration_sec": 300, "url": "u"}
    monkeypatch.setattr(sp, "_search_youtube", lambda q, ex, limit=2: [c("a" if q == "q1" else "b"), c("m")])
    res = {"suggestions": [{"search_query": "q1", "candidates": []}, {"search_query": "q2", "candidates": []}],
           "stats": {"candidates_found": 0}, "checks": []}
    sp._add_candidates(res, {"p" * 11})
    assert [[x["id"][0] for x in s["candidates"]] for s in res["suggestions"]] == [["a", "m"], ["b"]]
    assert res["stats"]["candidates_found"] == 3 and "3 real YouTube candidates" in res["checks"][0]


# ---- analyze() with a fake LLM client -----------------------------------------------------------------------------
class FakeClient:
    """Stands in for llm._Client: ask_json answers per agent and goes through _post so the usage meter sees it."""
    instances = []

    def __init__(self, provider, key, model):
        self.provider, self.key, self.model = provider, key, model
        self.prompts = []
        FakeClient.instances.append(self)

    def _post(self, url, headers, body):
        return {"usageMetadata": {"totalTokenCount": 100}}

    def ask_json(self, messages, max_tokens, temperature=0.3):
        self._post("u", {}, {})
        system, user = messages
        self.prompts.append(user)
        if system == sp.SYS_1:
            vids = [i for i in IDS if f"video_id: {i}" in user]
            if self.provider == "groq":
                assert len(vids) <= 2
            return a1({i: [("Topic", "spreads incoming traffic across many servers")] for i in vids if EXC[i]})
        if system == sp.SYS_2:
            return {"order": [{"video_id": i, "reason": "r"} for i in reversed(IDS[:2])],
                    "unplaced": [{"video_id": IDS[2], "reason": "off topic"}], "path_summary": "sum"}
        return {"areas": [{"area": "LB", "why": "w", "status": "covered", "covered_by": [IDS[0]], "priority": "high"}],
                "suggestions": [{"topic": "Caching", "reason": "r", "kind": "overview", "search_query": "caching"}],
                "off_goal": [{"video_id": IDS[2], "reason": "python"}]}


@pytest.fixture
def fake_engine(monkeypatch):
    FakeClient.instances.clear()
    monkeypatch.setattr(sp, "_Client", FakeClient)
    seen = []

    def get_transcript(url, **kw):
        vid = url.rsplit("=", 1)[1]
        seen.append(vid)
        if not EXC[vid]:
            raise sp.ingest.IngestError("no captions")
        return {"segments": [{"start": 0.0, "text": EXC[vid].replace("[00:00] ", "")}]}

    monkeypatch.setattr(sp.ingest, "get_transcript", get_transcript)
    monkeypatch.setattr(sp, "_search_youtube", lambda q, ex, limit=2: [
        {"id": "q" * 11, "title": "t", "channel": "c", "duration_sec": 300, "url": "https://www.youtube.com/watch?v=" + "q" * 11}])
    return seen


def test_analyze_end_to_end(fake_engine):
    videos = [{"id": i, "title": f"T {i}", "channel": "C", "duration_sec": 300} for i in IDS]
    stages = []
    out = sp.analyze("  System   Design ", videos + videos[:1], "gemini", SECRET, progress=lambda s, p, m: stages.append((s, p)))
    res = out["result"]
    validate_result(res, IDS)
    validate_usage(out["usage"])
    assert res["goal"] == "System Design"
    assert out["usage"]["calls"] == 3 and out["usage"]["total_tokens"] == 300       # one profiler batch of 4, sequencer, gap analyst
    assert sorted(fake_engine) == sorted(IDS)                                       # each transcript fetched once
    assert FakeClient.instances[0].model == "gemini-3.5-flash-lite"
    assert any("No transcript" in c for c in res["checks"])
    assert res["suggestions"][0]["candidates"][0]["id"] == "q" * 11
    names = [s for s, _ in stages]
    assert names == sorted(names, key=["transcripts", "profiling", "ordering", "gaps", "checking", "candidates"].index)
    assert {"transcripts", "profiling", "ordering", "gaps", "checking", "candidates"} <= set(names)
    assert all(0 <= p <= 100 for _, p in stages)
    assert "(transcript unavailable" in FakeClient.instances[0].prompts[0]


def test_analyze_groq_uses_small_batches(fake_engine):
    videos = [{"id": i, "title": "T", "channel": "C", "duration_sec": 300} for i in IDS]
    out = sp.analyze("Goal", videos, "groq", SECRET, model="models/x")
    assert out["usage"]["calls"] == 2 + 2                                           # two profiler batches + sequencer + gaps
    assert FakeClient.instances[0].model == "models/x"                              # prefix only stripped for gemini


def test_analyze_rejects_bad_input(fake_engine):
    v = [{"id": i, "title": "T", "channel": "C", "duration_sec": 1} for i in IDS]
    with pytest.raises(sp.LLMError):
        sp.analyze("g", v, "nope", SECRET)
    with pytest.raises(sp.LLMError):
        sp.analyze("g", v[:1], "gemini", SECRET)
    with pytest.raises(sp.LLMError):
        sp.analyze("", v, "gemini", SECRET)
    with pytest.raises(sp.LLMError):
        sp.analyze("g", v, "gemini", "")
    with pytest.raises(sp.LLMError):
        sp.analyze("g", v, "gemini", SECRET, model="bad model!")


def test_profiler_halves_the_batch_when_truncated():
    class C:
        def __init__(self): self.sizes = []
        def ask_json(self, messages, max_tokens, temperature=0.3):
            n = messages[1].count("--- video_id:")
            self.sizes.append(n)
            if n > 1:
                raise sp._OutputTruncated("cut")
            return {"profiles": [{"video_id": messages[1].split("video_id: ")[1][:11], "topics": []}]}
    c = C()
    vids = [{"id": i, "title": "T", "channel": "", "duration_sec": 0, "excerpt": "x"} for i in IDS]
    got = sp._ask_profiles(c, "g", vids)
    assert [p["video_id"] for p in got] == IDS and c.sizes == [4, 2, 1, 1, 2, 1, 1]


# ---- routes ----------------------------------------------------------------------------------------------------
def fake_smart_module(gate=None, exc=None):
    mod = types.ModuleType("fake_smart")
    mod.calls = []

    class LLMError(Exception):
        pass

    mod.LLMError = LLMError

    def analyze(goal, videos, provider, api_key, model=None, progress=None):
        mod.calls.append({"goal": goal, "videos": videos, "provider": provider, "api_key": api_key, "model": model})
        progress("profiling", 40, "halfway")
        if gate is not None:
            gate.wait(5)
        if exc:
            raise exc(f"boom {api_key}")
        return {"result": {"goal": goal}, "usage": {"calls": 1}}

    mod.analyze = analyze
    return mod


@pytest.fixture
def smart_client(tmp_path, monkeypatch):
    for var in ("GEMINI_API_KEY", "GROQ_API_KEY", "XAI_API_KEY", "HF_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("GEMINI_API_KEY", SECRET)

    def factory(mod=None, **cfg):
        config = {"OUTPUT_DIR": tmp_path / "out", "LOAD_DOTENV": False, "RATE_LIMIT": (100, 60)}
        config.update(cfg)
        app = srv.create_app(config)
        state = app.extensions["lna"]
        mod = mod or fake_smart_module()
        monkeypatch.setattr(state, "load_smart", lambda: mod)
        return app.test_client(), state, mod

    return factory


def body(**over):
    b = {"goal": "System Design", "provider": "gemini",
         "videos": [{"id": i, "title": f"T{n}", "channel": "C", "duration_sec": 100} for n, i in enumerate(IDS)]}
    b.update(over)
    return b


def wait_smart(client, job_id, timeout=5):
    end = time.time() + timeout
    while time.time() < end:
        data = client.get(f"/api/smart/{job_id}").get_json()
        if data["status"] in ("done", "error"):
            return data
        time.sleep(0.02)
    raise AssertionError("smart job did not finish")


def test_smart_full_flow(smart_client):
    client, _, mod = smart_client()
    r = client.post("/api/smart", json=body(goal="  Learn   things ", model="gemini-x"))
    assert r.status_code == 202
    job_id = r.get_json()["job_id"]
    assert len(job_id) == 32
    data = wait_smart(client, job_id)
    assert data["status"] == "done" and data["pct"] == 100 and data["model"] == "gemini-x"
    assert data["result"] == {"goal": "Learn things"} and data["usage"] == {"calls": 1}
    assert data["stage"] == "profiling" and "error" not in data
    assert mod.calls[0]["api_key"] == SECRET and mod.calls[0]["model"] == "gemini-x" and len(mod.calls[0]["videos"]) == 4
    assert SECRET not in json.dumps(data)


def test_smart_status_reports_running_and_default_model(smart_client):
    gate = threading.Event()
    client, _, _ = smart_client(fake_smart_module(gate=gate))
    job_id = client.post("/api/smart", json=body()).get_json()["job_id"]
    time.sleep(0.2)
    data = client.get(f"/api/smart/{job_id}").get_json()
    assert data["status"] == "running" and data["stage"] == "profiling" and data["pct"] == 40 and "result" not in data
    assert data["model"] == "gemini-3.5-flash-lite"            # the model the worker will use, not what was asked
    gate.set()
    assert wait_smart(client, job_id)["status"] == "done"


@pytest.mark.parametrize("over", [
    {"goal": ""}, {"goal": "x" * 121}, {"goal": 5}, {"videos": None}, {"videos": body()["videos"][:1]},
    {"videos": body()["videos"] * 6},
    {"videos": [{"id": "short", "title": "t"}] * 2}, {"videos": [{"id": "a" * 11, "title": 5}, {"id": "b" * 11, "title": "t"}]},
    {"videos": [{"id": "a" * 11, "title": "t", "duration_sec": -1}, {"id": "b" * 11, "title": "t"}]},
    {"videos": [{"id": "a" * 11, "title": "t"}, {"id": "a" * 11, "title": "same video twice"}]},
    {"provider": "nope"}, {"provider": None}, {"model": "bad model!"}, {"model": 5},
])
def test_smart_validation(smart_client, over):
    client, state, _ = smart_client()
    r = client.post("/api/smart", json=body(**over))
    assert r.status_code == 400 and isinstance(r.get_json()["error"], str)
    assert not state.smart_jobs


def test_smart_needs_json_and_a_server_key(smart_client, monkeypatch):
    client, _, _ = smart_client()
    assert client.post("/api/smart", data="x", content_type="text/plain").status_code == 400
    monkeypatch.delenv("GEMINI_API_KEY")
    r = client.post("/api/smart", json=body(api_key="AIzaFromTheBrowser"))           # a key in the body is ignored
    assert r.status_code == 400 and "GEMINI_API_KEY" in r.get_json()["error"]


def test_smart_busy_and_rate_limit(smart_client):
    gate = threading.Event()
    client, state, _ = smart_client(fake_smart_module(gate=gate), MAX_ACTIVE_JOBS=1)
    assert client.post("/api/smart", json=body()).status_code == 202
    r = client.post("/api/smart", json=body())
    assert r.status_code == 429 and "busy" in r.get_json()["error"]
    gate.set()
    client2, _, _ = smart_client(RATE_LIMIT=(1, 60))
    assert client2.post("/api/smart", json=body()).status_code == 202
    assert client2.post("/api/smart", json=body()).status_code == 429


def test_smart_503_when_engine_missing(smart_client):
    client, state, _ = smart_client()

    def missing():
        raise ImportError("no engine")
    state.load_smart = missing
    assert client.post("/api/smart", json=body()).status_code == 503


def test_smart_error_is_safe_and_redacted(smart_client):
    mod = fake_smart_module()
    mod.analyze = lambda *a, **k: (_ for _ in ()).throw(mod.LLMError(f"Gemini rejected {a[3]}"))
    client, _, _ = smart_client(mod)
    data = wait_smart(client, client.post("/api/smart", json=body()).get_json()["job_id"])
    assert data["status"] == "error" and "Gemini rejected" in data["error"] and SECRET not in json.dumps(data)

    mod2 = fake_smart_module()
    mod2.analyze = lambda *a, **k: (_ for _ in ()).throw(RuntimeError(f"internal {a[3]}"))
    client2, _, _ = smart_client(mod2)
    data = wait_smart(client2, client2.post("/api/smart", json=body()).get_json()["job_id"])
    assert data["status"] == "error" and data["error"] == srv.GENERIC_ERROR and SECRET not in json.dumps(data)


def test_smart_unknown_job_and_isolated_from_notes_jobs(smart_client):
    client, state, _ = smart_client()
    assert client.get("/api/smart/" + "0" * 32).status_code == 404
    assert client.get("/api/smart/not-a-job").status_code == 404
    job_id = client.post("/api/smart", json=body()).get_json()["job_id"]
    wait_smart(client, job_id)
    assert client.get(f"/api/jobs/{job_id}").status_code == 404                      # separate stores
    r = client.get(f"/api/smart/{job_id}")
    assert r.headers["Cache-Control"] == "no-store" and "default-src 'none'" in r.headers["Content-Security-Policy"]


def test_smart_jobs_are_pruned_like_notes_jobs(smart_client):
    client, state, _ = smart_client()
    job_id = client.post("/api/smart", json=body()).get_json()["job_id"]
    wait_smart(client, job_id)
    state.smart_jobs[job_id]["updated"] = time.time() - 25 * 3600
    state.prune_memory()
    assert job_id not in state.smart_jobs


def test_smart_origin_guard(smart_client):
    client, _, _ = smart_client()
    r = client.post("/api/smart", json=body(), headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
