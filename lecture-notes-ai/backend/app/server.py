"""Flask server for Lecture Notes AI.

Routes:
    GET  /                          frontend
    GET  /api/providers
    POST /api/jobs
    GET  /api/jobs/<id>
    GET  /api/jobs/<id>/notes.json | notes.pdf | notes.html

The heavy modules (ingest / llm / pdf) are imported lazily inside the worker so
the server starts even when one of them is missing or broken.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import shutil
import threading
import time
import traceback
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, request, send_file, send_from_directory, Response
from flask_cors import CORS

try:  # python-dotenv is in requirements, but never let a missing .env library kill the server
    from dotenv import load_dotenv
except Exception:  # pragma: no cover
    load_dotenv = None

log = logging.getLogger("lna")

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BACKEND_DIR.parent
FRONTEND_DIR = PROJECT_DIR / "frontend"
ENGINE_DIR = PROJECT_DIR / "notes_engine"  # fonts are served from notes_engine/static/fonts
DEFAULT_OUTPUT_DIR = BACKEND_DIR / "output"

JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")
KEY_RE = re.compile(r"^[\x21-\x7e]{1,512}$")  # printable ASCII, no whitespace
MODEL_RE = re.compile(r"^[A-Za-z0-9._:/\-]{1,200}$")
LOCAL_HOST_RE = re.compile(r"^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$", re.I)
LOCAL_ORIGIN_RE = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$", re.I)

# provider id -> env var that may hold a server-side key
ENV_KEYS = {
    "gemini": "GEMINI_API_KEY",
    "groq": "GROQ_API_KEY",
    "xai": "XAI_API_KEY",
    "huggingface": "HF_TOKEN",
}

# Used only if llm.PROVIDERS cannot be imported (so the UI still renders).
FALLBACK_PROVIDERS = {
    "gemini": {"label": "Google Gemini", "default_model": "gemini-2.5-flash",
               "key_hint": "Free key at aistudio.google.com/apikey"},
    "groq": {"label": "Groq", "default_model": "llama-3.3-70b-versatile",
             "key_hint": "Free key at console.groq.com/keys"},
    "xai": {"label": "xAI Grok", "default_model": "grok-4",
            "key_hint": "Key from console.x.ai"},
    "huggingface": {"label": "Hugging Face", "default_model": "meta-llama/Llama-3.3-70B-Instruct",
                    "key_hint": "Token from huggingface.co/settings/tokens"},
}
PROVIDER_ORDER = ["gemini", "groq", "xai", "huggingface"]

GENERIC_ERROR = ("Something went wrong while making your notes. Please try again - "
                 "if it keeps happening, check the server console for details.")

CSP_APP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
           "font-src 'self'; connect-src 'self'; frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com; object-src 'none'; "
           "base-uri 'none'; form-action 'self'; frame-ancestors 'self'")
# The generated notebook page is self-contained (inline CSS, data: fonts/images) but must never run script.
CSP_NOTES = ("default-src 'none'; style-src 'unsafe-inline'; img-src data: 'self'; "
             "font-src data: 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'")
CSP_FILE = "default-src 'none'; frame-ancestors 'self'"


# ----------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------
def _redact(text: str, secrets=()) -> str:
    """Strip anything that looks like a credential from text before it is logged."""
    text = str(text)
    for s in secrets:
        if s and len(s) >= 4:
            text = text.replace(s, "***")
    text = re.sub(r"(?i)((?:api[_-]?key|key|token|access_token|authorization)[\"']?\s*[=:]\s*[\"']?)[^&\s\"',}]+",
                  r"\1***", text)
    text = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._\-]+", r"\1***", text)
    return text


def _fmt_duration(sec) -> str:
    try:
        sec = int(sec)
    except (TypeError, ValueError):
        return ""
    if sec <= 0:
        return ""
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _slug(text: str, fallback: str = "lecture") -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", str(text or "")).strip("-")[:60]
    return s or fallback


def cleanup_old_jobs(output_dir: Path, max_age_sec: int = 24 * 3600) -> int:
    """Delete job folders (uuid-hex names only) older than max_age_sec. Returns count removed."""
    removed = 0
    if not output_dir.is_dir():
        return 0
    now = time.time()
    for child in output_dir.iterdir():
        try:
            if child.is_dir() and JOB_ID_RE.match(child.name) and now - child.stat().st_mtime > max_age_sec:
                shutil.rmtree(child, ignore_errors=True)
                removed += 1
        except OSError:
            continue
    return removed


class State:
    """Process-wide mutable state, kept on app.extensions['lna']."""

    def __init__(self, output_dir: Path, max_active: int, rate_limit: tuple[int, int]):
        self.output_dir = output_dir
        self.max_active = max_active
        self.rate_limit = rate_limit
        self.jobs: dict[str, dict] = {}
        self.lock = threading.Lock()
        self.recent: deque[float] = deque()

    # modules are looked up here so tests can monkeypatch `load_modules`
    def load_modules(self):
        from notes_engine import ingest, llm, pdf  # lazy: server must start even if one is unfinished
        return ingest, llm, pdf

    def load_ingest(self):
        """Just the ingest module (URL validation must work even if llm/pdf are unfinished)."""
        try:
            return self.load_modules()[0]
        except ImportError:
            from notes_engine import ingest
            return ingest

    def active_count(self) -> int:
        return sum(1 for j in self.jobs.values() if j["status"] in ("queued", "running"))

    def rate_limited(self) -> bool:
        n, window = self.rate_limit
        now = time.monotonic()
        while self.recent and now - self.recent[0] > window:
            self.recent.popleft()
        if len(self.recent) >= n:
            return True
        self.recent.append(now)
        return False

    def prune_memory(self, max_age_sec: int = 24 * 3600):
        cutoff = time.time() - max_age_sec
        for jid in [k for k, j in self.jobs.items()
                    if j["status"] in ("done", "error") and j["updated"] < cutoff]:
            self.jobs.pop(jid, None)

    def update(self, job: dict, **fields):
        with self.lock:
            job.update(fields)
            job["updated"] = time.time()

    def public(self, job: dict) -> dict:
        with self.lock:
            out = {k: job[k] for k in ("status", "stage", "pct", "message") if k in job}
            for k in ("error", "meta", "links", "warning"):
                if job.get(k):
                    out[k] = job[k]
            out["job_id"] = job["id"]
        return out


# ----------------------------------------------------------------------------
# worker
# ----------------------------------------------------------------------------
def _safe_progress(state: State, job: dict, lo: float, hi: float, stage: str):
    """Map a module's stage-local progress callback (pct 0-100) into the job's global range."""
    def cb(_stage=None, pct=None, message=None, *_a, **_k):
        try:
            p = max(0.0, min(100.0, float(pct if pct is not None else 0)))
            glob = int(round(lo + (hi - lo) * p / 100.0))
            fields = {"stage": stage}
            if glob > job.get("pct", 0):
                fields["pct"] = glob
            if message:
                fields["message"] = str(message)[:240]
            state.update(job, **fields)
        except Exception:  # a broken progress callback must never kill the job
            pass
    return cb


def _run_job(state: State, job_id: str, url: str, provider: str, api_key: str,
             model: str | None, groq_key: str | None):
    job = state.jobs[job_id]
    secrets = [api_key, groq_key]
    job_dir = state.output_dir / job_id
    try:
        state.update(job, status="running", stage="transcript", pct=1, message="Fetching transcript...")
        try:
            ingest, llm, pdf = state.load_modules()
        except ImportError as e:
            log.error("module import failed: %s", _redact(e, secrets))
            state.update(job, status="error", error="The notes engine is not fully installed yet "
                         f"(missing module: {getattr(e, 'name', None) or 'unknown'}).")
            return
        IngestError = getattr(ingest, "IngestError", ())
        LLMError = getattr(llm, "LLMError", ())
        PdfError = getattr(pdf, "PdfError", ())

        # 1. transcript (0-25 %)
        transcript = ingest.get_transcript(url, groq_key=groq_key,
                                           progress=_safe_progress(state, job, 0, 25, "transcript"))
        meta = {
            "title": str(transcript.get("title") or "Untitled lecture"),
            "channel": str(transcript.get("channel") or ""),
            "duration": _fmt_duration(transcript.get("duration_sec")),
        }
        state.update(job, meta=meta, stage="notes", pct=max(job["pct"], 25),
                     message="Transcript ready. Writing notes...")

        # 2. notes (25-85 %)
        notes = llm.generate_notes(transcript, provider=provider, api_key=api_key, model=model,
                                   progress=_safe_progress(state, job, 25, 85, "notes"))
        job_dir.mkdir(parents=True, exist_ok=True)
        (job_dir / "notes.json").write_text(json.dumps(notes, ensure_ascii=False, indent=2), encoding="utf-8")
        try:  # prefer the notes' own title if the model produced a nicer one
            nt = (notes.get("meta") or {}).get("title")
            if nt:
                meta["title"] = str(nt)
        except AttributeError:
            pass
        state.update(job, meta=meta, stage="pdf", pct=max(job["pct"], 85), message="Drawing the notebook...")

        # 3. html preview + pdf (85-100 %)
        warnings: list[str] = []
        have_html = have_pdf = False
        try:
            html = pdf.render_html(notes)
            (job_dir / "notes.html").write_text(html, encoding="utf-8")
            have_html = True
            state.update(job, pct=max(job["pct"], 92))
        except Exception as e:
            log.error("render_html failed: %s\n%s", _redact(e, secrets),
                      _redact(traceback.format_exc(), secrets))
            warnings.append("The on-screen preview could not be drawn.")
        try:
            pdf.render_pdf(notes, str(job_dir / "notes.pdf"))
            have_pdf = (job_dir / "notes.pdf").is_file()
        except Exception as e:
            if PdfError and isinstance(e, PdfError):
                warnings.append(str(e))
            else:
                warnings.append("The PDF could not be drawn.")
            log.error("render_pdf failed: %s\n%s", _redact(e, secrets),
                      _redact(traceback.format_exc(), secrets))
        if not (have_html or have_pdf):
            state.update(job, status="error", error=warnings[-1] if warnings else GENERIC_ERROR)
            return

        base = f"/api/jobs/{job_id}"
        links = {"notes_json": f"{base}/notes.json"}
        if have_pdf:
            links["pdf"] = f"{base}/notes.pdf"
        if have_html:
            links["html"] = f"{base}/notes.html"
        state.update(job, status="done", stage="pdf", pct=100, message="Your notebook is ready.",
                     links=links, warning=" ".join(warnings) if warnings else None)
    except Exception as e:  # map every failure to a safe message
        user_safe = False
        try:
            ingest_mod, llm_mod, pdf_mod = state.load_modules()
            safe_types = tuple(t for t in (getattr(ingest_mod, "IngestError", None),
                                           getattr(llm_mod, "LLMError", None),
                                           getattr(pdf_mod, "PdfError", None)) if isinstance(t, type))
            user_safe = bool(safe_types) and isinstance(e, safe_types)
        except Exception:
            pass
        if user_safe:
            msg = _redact(str(e), secrets).strip() or GENERIC_ERROR
            log.warning("job %s failed (%s): %s", job_id, type(e).__name__, msg)
        else:
            msg = GENERIC_ERROR
            log.error("job %s crashed: %s: %s\n%s", job_id, type(e).__name__, _redact(e, secrets),
                      _redact(traceback.format_exc(), secrets))
        state.update(job, status="error", error=msg[:600])
    finally:
        # drop references to the keys as soon as possible
        secrets.clear()


# ----------------------------------------------------------------------------
# app factory
# ----------------------------------------------------------------------------
def create_app(config: dict | None = None) -> Flask:
    cfg = {
        "OUTPUT_DIR": DEFAULT_OUTPUT_DIR,
        "MAX_ACTIVE_JOBS": 2,
        "RATE_LIMIT": (10, 60),      # at most 10 new jobs / 60 s
        "MAX_CONTENT_LENGTH": 64 * 1024,
        "CLEANUP_ON_START": True,
        "LOAD_DOTENV": True,
    }
    cfg.update(config or {})

    if cfg["LOAD_DOTENV"] and load_dotenv is not None:
        load_dotenv(BACKEND_DIR / ".env", override=False)

    app = Flask(__name__, static_folder=str(ENGINE_DIR / "static"), static_url_path="/static")
    app.config["MAX_CONTENT_LENGTH"] = cfg["MAX_CONTENT_LENGTH"]
    app.json.ensure_ascii = False

    output_dir = Path(cfg["OUTPUT_DIR"])
    output_dir.mkdir(parents=True, exist_ok=True)
    if cfg["CLEANUP_ON_START"]:
        try:
            n = cleanup_old_jobs(output_dir)
            if n:
                log.info("removed %d old job folder(s)", n)
        except Exception:
            log.warning("cleanup of old jobs failed")

    state = State(output_dir, int(cfg["MAX_ACTIVE_JOBS"]), tuple(cfg["RATE_LIMIT"]))
    app.extensions["lna"] = state

    CORS(app, resources={r"/api/*": {"origins": [LOCAL_ORIGIN_RE]}}, methods=["GET", "POST", "OPTIONS"],
         allow_headers=["Content-Type"], max_age=600)

    # ---- security -----------------------------------------------------------
    @app.before_request
    def _guard():
        # DNS-rebinding guard: only answer to local host names
        if not LOCAL_HOST_RE.match(request.host or ""):
            return jsonify(error="Forbidden host."), 403
        origin = request.headers.get("Origin")
        if origin and request.method == "POST" and not LOCAL_ORIGIN_RE.match(origin):
            return jsonify(error="Forbidden origin."), 403
        return None

    @app.after_request
    def _headers(resp: Response):
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "SAMEORIGIN"
        resp.headers["Referrer-Policy"] = "no-referrer"
        resp.headers["Cross-Origin-Resource-Policy"] = "same-origin"
        resp.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        if "Content-Security-Policy" not in resp.headers:
            if request.path.endswith("/notes.html"):
                resp.headers["Content-Security-Policy"] = CSP_NOTES
            elif request.path.startswith("/api/"):
                resp.headers["Content-Security-Policy"] = CSP_FILE
            else:
                resp.headers["Content-Security-Policy"] = CSP_APP
        if request.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"
        return resp

    # ---- error handlers (JSON for the API) ----------------------------------
    @app.errorhandler(404)
    def _404(_e):
        return jsonify(error="Not found."), 404

    @app.errorhandler(405)
    def _405(_e):
        return jsonify(error="Method not allowed."), 405

    @app.errorhandler(413)
    def _413(_e):
        return jsonify(error="Request too large."), 413

    @app.errorhandler(500)
    def _500(_e):
        return jsonify(error=GENERIC_ERROR), 500

    # ---- frontend -----------------------------------------------------------
    @app.get("/")
    def index():
        return send_from_directory(FRONTEND_DIR, "index.html", max_age=0)

    @app.get("/app.js")
    def frontend_js():
        return send_from_directory(FRONTEND_DIR, "app.js", max_age=0)

    @app.get("/styles.css")
    def frontend_css():
        return send_from_directory(FRONTEND_DIR, "styles.css", max_age=0)

    @app.get("/favicon.ico")
    def favicon():
        return Response(status=204)

    # ---- API ----------------------------------------------------------------
    def provider_table() -> dict:
        table = {}
        try:
            from notes_engine import llm
            for pid, meta in (getattr(llm, "PROVIDERS", None) or {}).items():
                if pid in ENV_KEYS and isinstance(meta, dict):
                    fb = FALLBACK_PROVIDERS[pid]
                    table[pid] = {
                        "label": meta.get("label") or fb["label"],
                        "default_model": meta.get("default_model") or fb["default_model"],
                        "key_hint": meta.get("key_hint") or fb["key_hint"],
                    }
        except Exception:
            table = {}
        for pid in PROVIDER_ORDER:
            table.setdefault(pid, dict(FALLBACK_PROVIDERS[pid]))
        return table

    def server_key(pid: str) -> str:
        return (os.environ.get(ENV_KEYS[pid]) or "").strip()

    @app.get("/api/providers")
    def providers():
        table = provider_table()
        return jsonify(providers=[
            {"id": pid, **table[pid], "server_key": bool(server_key(pid))} for pid in PROVIDER_ORDER
        ])

    def bad(msg: str, code: int = 400):
        return jsonify(error=msg), code

    @app.post("/api/jobs")
    def create_job():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return bad("Send a JSON body with at least a YouTube url and a provider.")

        url = data.get("url")
        if not isinstance(url, str) or not url.strip():
            return bad("Please paste a YouTube link.")
        url = url.strip()
        if len(url) > 2048:
            return bad("That link is too long.")

        provider = data.get("provider")
        table = provider_table()
        if not isinstance(provider, str) or provider not in table:
            return bad("Unknown provider. Choose one of: " + ", ".join(PROVIDER_ORDER) + ".")

        def clean_key(value, label):
            if value is None or value == "":
                return None, None
            if not isinstance(value, str):
                return None, f"The {label} must be text."
            value = value.strip()
            if not value:
                return None, None
            if not KEY_RE.match(value):
                return None, f"The {label} looks invalid (unexpected characters or too long)."
            return value, None

        api_key, err = clean_key(data.get("api_key"), "API key")
        if err:
            return bad(err)
        groq_key, err = clean_key(data.get("groq_key"), "Groq key")
        if err:
            return bad(err)
        api_key = api_key or server_key(provider) or None
        if not api_key:
            return bad(f"No API key for {table[provider]['label']}. Paste one in the form, "
                       f"or put {ENV_KEYS[provider]} in backend/.env.")
        # Whisper fallback key: request > env > the main key when the provider is Groq
        groq_key = groq_key or server_key("groq") or (api_key if provider == "groq" else None) or None

        model = data.get("model")
        if model not in (None, ""):
            if not isinstance(model, str) or not MODEL_RE.match(model.strip()):
                return bad("The model name looks invalid.")
            model = model.strip()
        else:
            model = None

        # validate the URL with ingest's parser (also the SSRF guard)
        try:
            ingest = state.load_ingest()
        except ImportError:
            return bad("The notes engine is not fully installed yet.", 503)
        try:
            ingest.parse_video_id(url)
        except Exception as e:
            if isinstance(e, getattr(ingest, "IngestError", ())):
                return bad(str(e) or "That does not look like a YouTube link.")
            return bad("That does not look like a YouTube link.")

        with state.lock:
            state.prune_memory()
            if state.active_count() >= state.max_active:
                return bad("The server is busy with other lectures right now. "
                           "Please wait a minute and try again.", 429)
            if state.rate_limited():
                return bad("Too many requests - please slow down a little.", 429)
            job_id = uuid.uuid4().hex
            now = time.time()
            job = {"id": job_id, "status": "queued", "stage": "transcript", "pct": 0,
                   "message": "Queued...", "created": now, "updated": now}
            state.jobs[job_id] = job

        t = threading.Thread(target=_run_job, name=f"job-{job_id[:8]}", daemon=True,
                             args=(state, job_id, url, provider, api_key, model, groq_key))
        t.start()
        return jsonify(job_id=job_id), 202

    def valid_job(job_id: str):
        return bool(JOB_ID_RE.match(job_id or ""))

    @app.get("/api/jobs/<job_id>")
    def job_status(job_id):
        if not valid_job(job_id):
            return bad("Job not found.", 404)
        job = state.jobs.get(job_id)
        if job is None:
            return bad("Job not found (the server may have been restarted).", 404)
        return jsonify(state.public(job))

    def job_file(job_id: str, name: str):
        if not valid_job(job_id):
            return None
        job = state.jobs.get(job_id)
        if job is not None and job["status"] != "done":
            return None
        path = (state.output_dir / job_id / name)
        try:
            path = path.resolve()
            if state.output_dir.resolve() not in path.parents or not path.is_file():
                return None
        except OSError:
            return None
        return path

    @app.get("/api/jobs/<job_id>/notes.json")
    def notes_json(job_id):
        path = job_file(job_id, "notes.json")
        if path is None:
            return bad("File not found.", 404)
        resp = send_file(path, mimetype="application/json", max_age=0)
        resp.headers["Content-Disposition"] = 'inline; filename="notes.json"'
        return resp

    @app.get("/api/jobs/<job_id>/notes.pdf")
    def notes_pdf(job_id):
        path = job_file(job_id, "notes.pdf")
        if path is None:
            return bad("File not found.", 404)
        title = (state.jobs.get(job_id) or {}).get("meta", {}).get("title", "")
        return send_file(path, mimetype="application/pdf", as_attachment=True, max_age=0,
                         download_name=f"{_slug(title)}-notebook.pdf")

    @app.get("/api/jobs/<job_id>/notes.html")
    def notes_html(job_id):
        path = job_file(job_id, "notes.html")
        if path is None:
            return bad("File not found.", 404)
        html = path.read_text(encoding="utf-8", errors="replace")
        # file:// font URLs (used for the PDF render) cannot load inside an http page: point them at /static
        html = re.sub(r"file:///[^\"')\s]*?/static/fonts/", "/static/fonts/", html)
        resp = Response(html, mimetype="text/html")
        # The notebook page runs two inline scripts (Rough.js + its own pagination), so allow exactly the inline scripts that
        # are present in the file we generated (by hash) - anything injected later would not match.
        hashes = []
        for m in re.finditer(r"<script(?![^>]*\bsrc\s*=)[^>]*>(.*?)</script>", html, re.S | re.I):
            digest = base64.b64encode(hashlib.sha256(m.group(1).encode("utf-8")).digest()).decode("ascii")
            hashes.append(f"'sha256-{digest}'")
        resp.headers["Content-Security-Policy"] = CSP_NOTES.replace(
            "default-src 'none';", "default-src 'none'; script-src " + (" ".join(hashes) or "'none'") + ";", 1)
        return resp

    return app


# convenience for `flask --app app.server run` style usage
def _default_app() -> Flask:  # pragma: no cover
    return create_app()
