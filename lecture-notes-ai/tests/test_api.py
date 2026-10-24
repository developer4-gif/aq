"""API tests with fake ingest / llm / pdf modules (no network, no real keys)."""
import json
import sys
import threading
import time
import types
from pathlib import Path

import pytest


from app import server as srv  # noqa: E402

SECRET = "sk-test-SECRET-1234567890"
GOOD_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"


# ---- fakes following the real module signatures ---------------------------------
class FakeIngestError(Exception):
    pass


class FakeLLMError(Exception):
    pass


class FakePdfError(Exception):
    pass


def make_fakes(*, gate=None, transcript_exc=None, llm_exc=None, pdf_exc=None, html_exc=None):
    calls = {}

    ingest = types.ModuleType("fake_ingest")
    ingest.IngestError = FakeIngestError

    def parse_video_id(url):
        if "youtube.com" not in url and "youtu.be" not in url:
            raise FakeIngestError("That does not look like a YouTube link.")
        return "dQw4w9WgXcQ"

    def get_transcript(url, *, groq_key=None, progress=None):
        calls["groq_key"] = groq_key
        if progress:
            progress("transcript", 0, "starting")
            progress("transcript", 100, "got captions")
        if gate is not None:
            gate.wait(5)
        if transcript_exc:
            raise transcript_exc
        return {"video_id": "dQw4w9WgXcQ", "url": url, "title": "Test Lecture", "channel": "Chan",
                "duration_sec": 3725, "language": "en", "source": "captions",
                "segments": [{"start": 0.0, "text": "hello"}]}

    ingest.parse_video_id = parse_video_id
    ingest.get_transcript = get_transcript

    llm = types.ModuleType("fake_llm")
    llm.LLMError = FakeLLMError
    llm.PROVIDERS = {
        "gemini": {"label": "Gemini", "default_model": "gemini-x", "needs_key": True, "key_hint": "hint g"},
        "groq": {"label": "Groq", "default_model": "llama-x", "needs_key": True, "key_hint": "hint q"},
        "xai": {"label": "xAI Grok", "default_model": "grok-x", "needs_key": True, "key_hint": "hint x"},
        "huggingface": {"label": "HF", "default_model": "hf-x", "needs_key": True, "key_hint": "hint h"},
    }

    def generate_notes(transcript, *, provider, api_key, model=None, progress=None):
        calls["llm"] = {"provider": provider, "api_key": api_key, "model": model}
        if progress:
            progress("notes", 50, "chunk 1/2")
            progress("notes", 100, "final")
        if llm_exc:
            raise llm_exc
        return {"meta": {"title": "Nice Notes", "subtitle": "", "source_url": transcript["url"]},
                "cover": {}, "sections": [], "glossary": [], "recap": {}}

    llm.generate_notes = generate_notes

    pdf = types.ModuleType("fake_pdf")
    pdf.PdfError = FakePdfError

    def render_html(notes):
        if html_exc:
            raise html_exc
        return ("<html><body>notes <style>@font-face{src:url('file:///D:/x/app/static/fonts/Kalam-Regular.ttf')}"
                "</style><script>var x=1;</script><script src=\"evil.js\"></script></body></html>")

    def render_pdf(notes, out_path):
        if pdf_exc:
            raise pdf_exc
        Path(out_path).write_bytes(b"%PDF-1.4 fake")
        return out_path

    pdf.render_html = render_html
    pdf.render_pdf = render_pdf
    return (ingest, llm, pdf), calls


@pytest.fixture
def make_client(tmp_path, monkeypatch):
    for var in ("GEMINI_API_KEY", "GROQ_API_KEY", "XAI_API_KEY", "HF_TOKEN"):
        monkeypatch.delenv(var, raising=False)

    def factory(fakes=None, **cfg):
        config = {"OUTPUT_DIR": tmp_path / "out", "LOAD_DOTENV": False, "RATE_LIMIT": (100, 60)}
        config.update(cfg)
        app = srv.create_app(config)
        state = app.extensions["lna"]
        mods, calls = fakes if fakes else make_fakes()
        monkeypatch.setattr(state, "load_modules", lambda: mods)
        # providers endpoint imports llm lazily; keep it independent of the real module
        return app.test_client(), state, calls

    return factory


def wait_done(client, job_id, timeout=5):
    end = time.time() + timeout
    while time.time() < end:
        data = client.get(f"/api/jobs/{job_id}").get_json()
        if data["status"] in ("done", "error"):
            return data
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def post(client, **body):
    body.setdefault("url", GOOD_URL)
    body.setdefault("provider", "gemini")
    body.setdefault("api_key", SECRET)
    return client.post("/api/jobs", json=body)


# ---- tests -------------------------------------------------------------------
def test_index_and_static_headers(make_client):
    client, _, _ = make_client()
    r = client.get("/")
    assert r.status_code == 200
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["X-Frame-Options"] == "SAMEORIGIN"
    assert "default-src 'self'" in r.headers["Content-Security-Policy"]
    csp = {d.split()[0]: d.split()[1:] for d in r.headers["Content-Security-Policy"].split(";") if d.strip()}
    assert "https://www.youtube-nocookie.com" in csp["frame-src"]
    assert "https://www.youtube.com" in csp["frame-src"]
    assert "'self'" in csp["frame-src"]
    assert csp["script-src"] == ["'self'"]          # the player embed must not loosen script rules
    assert client.get("/app.js").status_code == 200
    assert client.get("/styles.css").status_code == 200
    assert client.get("/nope").status_code == 404


def test_providers_lists_all_and_server_key_flag(make_client, monkeypatch):
    client, _, _ = make_client()
    data = client.get("/api/providers").get_json()
    ids = [p["id"] for p in data["providers"]]
    assert ids == ["gemini", "groq", "xai", "huggingface"]
    assert all(p["server_key"] is False for p in data["providers"])
    monkeypatch.setenv("GROQ_API_KEY", SECRET)
    data = client.get("/api/providers").get_json()
    flags = {p["id"]: p["server_key"] for p in data["providers"]}
    assert flags == {"gemini": False, "groq": True, "xai": False, "huggingface": False}
    assert SECRET not in json.dumps(data)
    for p in data["providers"]:
        assert {"id", "label", "default_model", "key_hint", "server_key"} <= set(p)


def test_full_flow_done(make_client):
    client, state, calls = make_client()
    r = post(client, model="my-model")
    assert r.status_code == 202
    job_id = r.get_json()["job_id"]
    assert len(job_id) == 32
    data = wait_done(client, job_id)
    assert data["status"] == "done", data
    assert data["pct"] == 100 and data["stage"] == "pdf"
    assert data["meta"] == {"title": "Nice Notes", "channel": "Chan", "duration": "1:02:05"}
    assert set(data["links"]) == {"notes_json", "pdf", "html"}
    assert SECRET not in json.dumps(data)
    assert calls["llm"] == {"provider": "gemini", "api_key": SECRET, "model": "my-model"}

    nj = client.get(data["links"]["notes_json"])
    assert nj.status_code == 200 and nj.get_json()["meta"]["title"] == "Nice Notes"
    pdf = client.get(data["links"]["pdf"])
    assert pdf.status_code == 200 and pdf.data.startswith(b"%PDF")
    assert "attachment" in pdf.headers["Content-Disposition"]
    assert pdf.headers["Content-Disposition"].endswith('.pdf"') or ".pdf" in pdf.headers["Content-Disposition"]
    html = client.get(data["links"]["html"])
    assert html.status_code == 200 and html.mimetype == "text/html"
    assert b"file:///" not in html.data and b"/static/fonts/Kalam-Regular.ttf" in html.data
    assert "default-src 'none'" in html.headers["Content-Security-Policy"]
    csp = html.headers["Content-Security-Policy"]
    import base64, hashlib
    want = base64.b64encode(hashlib.sha256(b"var x=1;").digest()).decode()
    assert f"script-src 'sha256-{want}';" in csp  # only the generated inline script may run
    assert "unsafe-inline'" not in csp.split("style-src")[0]
    # the notebook (only) may be framed by the local UI on another port; everything else stays SAMEORIGIN
    assert "frame-ancestors 'self' http://127.0.0.1:* http://localhost:*" in csp
    assert "X-Frame-Options" not in html.headers
    assert html.headers["X-Content-Type-Options"] == "nosniff"
    assert pdf.headers["X-Frame-Options"] == "SAMEORIGIN"
    assert "frame-ancestors 'self'" in nj.headers["Content-Security-Policy"]
    assert "127.0.0.1" not in nj.headers["Content-Security-Policy"]
    # the key never lands on disk
    for f in (state.output_dir / job_id).iterdir():
        assert SECRET.encode() not in f.read_bytes()


def test_progress_is_monotonic_and_mapped(make_client):
    gate = threading.Event()
    client, state, _ = make_client(make_fakes(gate=gate))
    job_id = post(client).get_json()["job_id"]
    # while the transcript is "in flight": 0-25 % range, stage transcript
    for _ in range(100):
        d = client.get(f"/api/jobs/{job_id}").get_json()
        if d["status"] == "running" and d["pct"] >= 25:
            break
        time.sleep(0.02)
    assert d["status"] == "running"
    assert d["stage"] == "transcript" and d["pct"] == 25
    gate.set()
    final = wait_done(client, job_id)
    assert final["pct"] == 100


def test_error_paths_map_to_user_messages(make_client):
    client, _, _ = make_client(make_fakes(transcript_exc=FakeIngestError("This video is private.")))
    d = wait_done(client, post(client).get_json()["job_id"])
    assert d["status"] == "error" and d["error"] == "This video is private."
    assert "links" not in d

    client, _, _ = make_client(make_fakes(llm_exc=FakeLLMError("Rate limit reached, try later.")))
    d = wait_done(client, post(client).get_json()["job_id"])
    assert d["status"] == "error" and d["error"] == "Rate limit reached, try later."


def test_unknown_exception_is_generic_and_redacted(make_client, caplog):
    boom = RuntimeError(f"https://api.example.com/v1?key={SECRET} failed with Bearer {SECRET}")
    client, _, _ = make_client(make_fakes(llm_exc=boom))
    with caplog.at_level("DEBUG", logger="lna"):
        d = wait_done(client, post(client).get_json()["job_id"])
    assert d["status"] == "error"
    assert d["error"] == srv.GENERIC_ERROR
    assert SECRET not in json.dumps(d)
    assert SECRET not in caplog.text
    assert "RuntimeError" in caplog.text


def test_user_safe_error_message_is_redacted_too(make_client):
    client, _, _ = make_client(make_fakes(llm_exc=FakeLLMError(f"bad key {SECRET}")))
    d = wait_done(client, post(client).get_json()["job_id"])
    assert SECRET not in d["error"]


def test_pdf_failure_degrades_to_done_with_warning(make_client):
    client, _, _ = make_client(make_fakes(pdf_exc=FakePdfError("No Edge or Chrome found.")))
    d = wait_done(client, post(client).get_json()["job_id"])
    assert d["status"] == "done"
    assert "pdf" not in d["links"] and "html" in d["links"]
    assert "Edge" in d["warning"]
    assert client.get(f"/api/jobs/{d['job_id']}/notes.pdf").status_code == 404


def test_pdf_and_html_both_fail_is_error(make_client):
    client, _, _ = make_client(make_fakes(pdf_exc=FakePdfError("no browser"), html_exc=ValueError("x")))
    d = wait_done(client, post(client).get_json()["job_id"])
    assert d["status"] == "error"


def test_bad_urls(make_client):
    client, _, _ = make_client()
    for url in ["", "   ", "not a url", "https://evil.example.com/watch?v=dQw4w9WgXcQ", 123, None]:
        r = post(client, url=url)
        assert r.status_code == 400, url
        assert "error" in r.get_json()
    assert post(client, url="x" * 3000).status_code == 400


def test_missing_key_unknown_provider_bad_body(make_client, monkeypatch):
    client, _, calls = make_client()
    r = client.post("/api/jobs", json={"url": GOOD_URL, "provider": "gemini"})
    assert r.status_code == 400 and "GEMINI_API_KEY" in r.get_json()["error"]
    assert post(client, provider="openai").status_code == 400
    assert post(client, provider=None).status_code == 400
    assert post(client, api_key="has space").status_code == 400
    assert post(client, api_key="bad\r\nHeader: x").status_code == 400
    assert post(client, model="bad model; rm").status_code == 400
    assert client.post("/api/jobs", data="not json", content_type="text/plain").status_code == 400
    assert client.post("/api/jobs", json=["list"]).status_code == 400

    # env key used when request has none; request key wins when both exist
    monkeypatch.setenv("GEMINI_API_KEY", "env-key-value")
    r = client.post("/api/jobs", json={"url": GOOD_URL, "provider": "gemini"})
    assert r.status_code == 202
    wait_done(client, r.get_json()["job_id"])
    assert calls["llm"]["api_key"] == "env-key-value"
    r = post(client)
    wait_done(client, r.get_json()["job_id"])
    assert calls["llm"]["api_key"] == SECRET


def test_groq_key_forwarded_for_whisper(make_client, monkeypatch):
    client, _, calls = make_client()
    wait_done(client, post(client, groq_key="gsk_abc").get_json()["job_id"])
    assert calls["groq_key"] == "gsk_abc"
    wait_done(client, post(client).get_json()["job_id"])
    assert calls["groq_key"] is None
    wait_done(client, post(client, provider="groq").get_json()["job_id"])
    assert calls["groq_key"] == SECRET  # groq provider key doubles as the whisper key


def test_job_id_validation_and_404s(make_client):
    client, state, _ = make_client()
    bad_ids = ["abc", "../../etc/passwd", "..%2f..%2fsecret", "g" * 32, "A" * 32, "0" * 31, "0" * 33]
    for jid in bad_ids:
        assert client.get(f"/api/jobs/{jid}").status_code == 404
        for f in ("notes.json", "notes.pdf", "notes.html"):
            assert client.get(f"/api/jobs/{jid}/{f}").status_code == 404
    unknown = "0" * 32
    assert client.get(f"/api/jobs/{unknown}").status_code == 404
    assert client.get(f"/api/jobs/{unknown}/notes.pdf").status_code == 404
    assert client.get("/api/jobs/" + unknown + "/other.txt").status_code == 404


def test_files_not_served_before_done(make_client):
    gate = threading.Event()
    client, state, _ = make_client(make_fakes(gate=gate))
    job_id = post(client).get_json()["job_id"]
    (state.output_dir / job_id).mkdir(parents=True, exist_ok=True)
    (state.output_dir / job_id / "notes.json").write_text("{}")
    assert client.get(f"/api/jobs/{job_id}/notes.json").status_code == 404
    gate.set()
    wait_done(client, job_id)


def test_concurrency_limit(make_client):
    gate = threading.Event()
    client, _, _ = make_client(make_fakes(gate=gate), MAX_ACTIVE_JOBS=2)
    ids = [post(client).get_json()["job_id"] for _ in range(2)]
    r = post(client)
    assert r.status_code == 429
    gate.set()
    for i in ids:
        wait_done(client, i)
    assert post(client).status_code == 202


def test_rate_limit(make_client):
    client, _, _ = make_client(RATE_LIMIT=(2, 60))
    assert post(client).status_code == 202
    assert post(client).status_code == 202
    assert post(client).status_code == 429


def test_request_too_large(make_client):
    client, _, _ = make_client()
    r = client.post("/api/jobs", data=b"x" * (200 * 1024), content_type="application/json")
    assert r.status_code == 413


def test_host_and_origin_guards(make_client):
    client, _, _ = make_client()
    assert client.get("/api/providers", headers={"Host": "evil.com"}).status_code == 403
    assert client.get("/api/providers", headers={"Host": "127.0.0.1:5055"}).status_code == 200
    r = client.post("/api/jobs", json={"url": GOOD_URL, "provider": "gemini", "api_key": SECRET},
                    headers={"Origin": "https://evil.com"})
    assert r.status_code == 403


def test_cors_only_for_localhost(make_client):
    client, _, _ = make_client()
    ok = client.get("/api/providers", headers={"Origin": "http://localhost:3000"})
    assert ok.headers.get("Access-Control-Allow-Origin") == "http://localhost:3000"
    bad = client.get("/api/providers", headers={"Origin": "https://evil.com"})
    assert "Access-Control-Allow-Origin" not in bad.headers


def test_cleanup_old_jobs(tmp_path):
    out = tmp_path / "out"
    old, fresh, other = "a" * 32, "b" * 32, "keepme"
    for name in (old, fresh, other):
        (out / name).mkdir(parents=True)
        (out / name / "notes.json").write_text("{}")
    import os
    past = time.time() - 48 * 3600
    os.utime(out / old, (past, past))
    os.utime(out / other, (past, past))
    srv.create_app({"OUTPUT_DIR": out, "LOAD_DOTENV": False})
    assert not (out / old).exists()
    assert (out / fresh).exists()
    assert (out / other).exists()  # non-job folders are never touched


def test_missing_modules_gives_friendly_error(make_client, monkeypatch):
    client, state, _ = make_client()

    def boom():
        raise ImportError("no pdf", name="notes_engine.pdf")

    monkeypatch.setattr(state, "load_modules", boom)
    monkeypatch.setattr(state, "load_ingest", boom)
    r = post(client)
    assert r.status_code == 503
