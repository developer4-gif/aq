"""notes_engine - YouTube lecture -> hand-drawn "field notebook" study notes (PDF + HTML).

Simple API::

    import notes_engine
    result = notes_engine.generate("https://youtu.be/...", "groq", out_dir="out")   # key from $GROQ_API_KEY
    result["pdf_path"], result["html_path"], result["notes"]

Building blocks (re-exported, imported lazily so ``import notes_engine`` stays cheap)::

    parse_video_id(url)                      # validate a YouTube link -> 11-char id
    get_transcript(url)                      # YouTube -> transcript dict
    generate_notes(transcript, provider=..., api_key=...)   # transcript -> validated Notes dict
    validate_notes(raw)                      # coerce messy LLM JSON into the Notes schema
    render_html(notes) / render_pdf(notes, path)
    IngestError, LLMError, PdfError          # user-safe exceptions
    PROVIDERS                                # {id: {label, default_model, key_hint, ...}}
"""
from __future__ import annotations

import importlib
import json
import os
import re
from pathlib import Path

__version__ = "0.1.0"

PACKAGE_DIR = Path(__file__).resolve().parent
STATIC_DIR = PACKAGE_DIR / "static"
FONT_DIR = STATIC_DIR / "fonts"
TEMPLATE_DIR = PACKAGE_DIR / "templates"

# provider id -> environment variable that may hold its key
ENV_KEYS = {
    "gemini": "GEMINI_API_KEY",
    "groq": "GROQ_API_KEY",
    "xai": "XAI_API_KEY",
    "huggingface": "HF_TOKEN",
}

_LAZY = ("ingest", "llm", "pdf", "notes_schema", "prompts")

# name -> submodule that defines it (resolved on first access)
_EXPORTS = {
    "parse_video_id": "ingest", "get_transcript": "ingest", "chunk_transcript": "ingest",
    "IngestError": "ingest",
    "generate_notes": "llm", "LLMError": "llm", "PROVIDERS": "llm",
    "validate_notes": "notes_schema",
    "render_html": "pdf", "render_pdf": "pdf", "PdfError": "pdf",
}

__all__ = ["generate", "render_notes", "ENV_KEYS", "__version__", *_LAZY, *_EXPORTS]


def __getattr__(name: str):  # lazy submodules and re-exports
    if name in _LAZY:
        return importlib.import_module(f"{__name__}.{name}")
    if name in _EXPORTS:
        return getattr(importlib.import_module(f"{__name__}.{_EXPORTS[name]}"), name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__():
    return sorted(set(globals()) | set(__all__))


def _env(name: str) -> str | None:
    v = (os.environ.get(name) or "").strip()
    return v or None


def _scaled(progress, lo: float, hi: float):
    """Map a stage-local progress callback (pct 0-100) into the global range lo..hi."""
    if progress is None:
        return None

    def cb(stage=None, pct=None, message=None, *_a, **_k):
        try:
            p = max(0.0, min(100.0, float(pct if pct is not None else 0)))
            progress(stage or "", int(round(lo + (hi - lo) * p / 100.0)), message or "")
        except Exception:  # a broken callback must never break the pipeline
            pass

    return cb


def render_notes(notes: dict, out_dir: str | Path = ".", basename: str = "notes", *, pdf: bool = True,
                 html: bool = True, json_file: bool = True, pdf_path: str | Path | None = None) -> dict:
    """Write ``<basename>.json`` / ``.html`` / ``.pdf`` for a Notes dict (each can be switched off).

    Returns ``{"json_path", "html_path", "pdf_path", "warning"}`` (None for files not written). A
    missing browser or a failed PDF run does not raise: ``pdf_path`` is then None and ``warning``
    says why; the other files are still written.
    """
    from . import pdf as _pdf

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    res = {"json_path": None, "html_path": None, "pdf_path": None, "warning": None}
    if json_file:
        p = out / f"{basename}.json"
        p.write_text(json.dumps(notes, ensure_ascii=False, indent=2), encoding="utf-8")
        res["json_path"] = str(p)
    if html:
        p = out / f"{basename}.html"
        p.write_text(_pdf.render_html(notes), encoding="utf-8")
        res["html_path"] = str(p)
    if pdf:
        target = Path(pdf_path) if pdf_path else out / f"{basename}.pdf"
        try:
            _pdf.render_pdf(notes, str(target))
            res["pdf_path"] = str(target)
        except _pdf.PdfError as e:
            res["warning"] = str(e)
    return res


def generate(url: str, provider: str, api_key: str | None = None, model: str | None = None,
             groq_key: str | None = None, out_dir: str | Path = ".", progress=None, *,
             basename: str = "notes", pdf_path: str | Path | None = None,
             write_html: bool = True, write_json: bool = True) -> dict:
    """YouTube URL -> study notes. Returns ``dict(notes=..., pdf_path=..., html_path=...)``.

    Keys: ``api_key`` falls back to the provider's environment variable (GROQ_API_KEY, GEMINI_API_KEY,
    XAI_API_KEY, HF_TOKEN). ``groq_key`` (only used to transcribe videos *without captions* via Groq
    Whisper) falls back to GROQ_API_KEY, or to the main key when the provider is groq.

    ``progress(stage, pct, message)`` is called with ``stage`` in ``transcript | notes | pdf`` and a
    global ``pct`` 0-100 (transcript 0-25, notes 25-85, rendering 85-100).

    Also returned: ``json_path`` and ``warning``. If only the PDF step fails (no Edge/Chrome),
    ``pdf_path`` is None and ``warning`` explains why. Raises ``IngestError`` / ``LLMError`` with
    user-safe messages (keys are never included).
    """
    from . import ingest, llm

    env_name = ENV_KEYS.get(provider)
    key = (api_key or "").strip() or (_env(env_name) if env_name else None)
    if not key:
        hint = f" or set {env_name}" if env_name else ""
        raise llm.LLMError(f"No API key for '{provider}'. Pass api_key{hint}.")
    gkey = (groq_key or "").strip() or None
    if gkey is None:
        gkey = key if provider == "groq" else _env("GROQ_API_KEY")

    transcript = ingest.get_transcript(url, groq_key=gkey, progress=_scaled(progress, 0, 25))
    notes = llm.generate_notes(transcript, provider=provider, api_key=key, model=model,
                               progress=_scaled(progress, 25, 85))
    if progress:
        progress("pdf", 85, "Drawing the notebook...")
    files = render_notes(notes, out_dir, basename, html=write_html, json_file=write_json, pdf_path=pdf_path)
    if progress:
        progress("pdf", 100, "Your notebook is ready.")
    return {"notes": notes, "pdf_path": files["pdf_path"], "html_path": files["html_path"],
            "json_path": files["json_path"], "warning": files["warning"]}
