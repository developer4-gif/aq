"""Command line: ``python -m notes_engine URL --provider groq --model X --out notes.pdf [--html] [--json]``

Keys are read from the environment (GROQ_API_KEY, GEMINI_API_KEY, XAI_API_KEY, HF_TOKEN), from a
``.env`` file in the current folder (when python-dotenv is installed), or from --api-key. Keys are
never printed.

Exit codes: 0 ok | 1 unexpected error | 2 bad usage / missing key | 3 transcript (ingest) error |
            4 AI provider error | 5 notes made but the PDF could not be drawn (JSON/HTML saved) | 130 Ctrl+C
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from . import ENV_KEYS, __version__

EXIT_OK, EXIT_ERROR, EXIT_USAGE, EXIT_INGEST, EXIT_LLM, EXIT_NO_PDF, EXIT_INTERRUPT = 0, 1, 2, 3, 4, 5, 130

_secrets: list[str] = []


def _ascii(text) -> str:
    """Console-safe text: hide secrets, replace anything non-ASCII."""
    s = str(text)
    for k in _secrets:
        if k and len(k) >= 4:
            s = s.replace(k, "***")
    return s.encode("ascii", "replace").decode("ascii")


def _say(msg: str = "", stream=None) -> None:
    print(_ascii(msg), file=stream or sys.stdout, flush=True)


class _Progress:
    """One-line ASCII progress bar on stderr (rewritten in place on a terminal, plain lines otherwise)."""

    WIDTH = 24

    def __init__(self, enabled: bool = True):
        self.enabled = enabled
        self.tty = enabled and sys.stderr.isatty()
        self.last_stage = None
        self.last_pct = -1
        self.open_line = False

    def __call__(self, stage: str, pct: int, message: str = "") -> None:
        if not self.enabled:
            return
        pct = max(0, min(100, int(pct)))
        filled = pct * self.WIDTH // 100
        bar = "#" * filled + "-" * (self.WIDTH - filled)
        text = _ascii(f"[{bar}] {pct:3d}% {stage:<10} {message}")
        if self.tty:
            cols = max(40, (os.get_terminal_size(sys.stderr.fileno()).columns if sys.stderr.isatty() else 80) - 1)
            sys.stderr.write("\r" + text[:cols].ljust(cols))
            sys.stderr.flush()
            self.open_line = True
        elif stage != self.last_stage or pct - self.last_pct >= 10 or pct == 100:
            _say(text, sys.stderr)
        self.last_stage, self.last_pct = stage, pct

    def finish(self) -> None:
        if self.tty and self.open_line:
            sys.stderr.write("\n")
            sys.stderr.flush()
            self.open_line = False


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="notes_engine",
        description="Turn a YouTube lecture into hand-drawn 'field notebook' study notes (PDF).",
        epilog="Keys come from the environment (GROQ_API_KEY, GEMINI_API_KEY, XAI_API_KEY, HF_TOKEN) "
               "or a .env file; --api-key works too but may be saved in your shell history.",
    )
    p.add_argument("url", nargs="?", help="YouTube video link (watch, youtu.be, shorts, embed ...)")
    p.add_argument("--provider", "-p", default="groq", choices=sorted(ENV_KEYS),
                   help="AI provider (default: groq)")
    p.add_argument("--model", "-m", help="model name (default: the provider's default model)")
    p.add_argument("--out", "-o", default="notes.pdf",
                   help="output PDF path (default: notes.pdf); a folder name puts notes.pdf inside it")
    p.add_argument("--html", action="store_true", help="also save <out>.html next to the PDF")
    p.add_argument("--json", action="store_true", help="also save <out>.json (the structured notes)")
    p.add_argument("--api-key", help="API key for the provider (prefer the environment variable)")
    p.add_argument("--groq-key", help="Groq key used to transcribe videos that have no captions "
                                      "(default: $GROQ_API_KEY, or the main key with --provider groq)")
    p.add_argument("--quiet", "-q", action="store_true", help="no progress line")
    p.add_argument("--list-providers", action="store_true", help="show providers, default models and key links")
    p.add_argument("--version", action="version", version=f"lecture-notes-ai {__version__}")
    return p


def _out_paths(out: str) -> tuple[Path, str, Path]:
    """--out -> (folder, basename, pdf path)."""
    p = Path(out)
    if p.suffix.lower() == ".pdf":
        return (p.parent if str(p.parent) else Path(".")), p.stem, p
    if p.suffix and not p.is_dir():
        raise ValueError(f"--out must end in .pdf (or be a folder), got '{out}'")
    return p, "notes", p / "notes.pdf"


def _load_dotenv() -> None:
    try:
        from dotenv import find_dotenv, load_dotenv
        load_dotenv(find_dotenv(usecwd=True), override=False)
    except Exception:  # python-dotenv is optional
        pass


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):  # never crash on an odd console encoding
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass
    parser = _build_parser()
    args = parser.parse_args(argv)
    _load_dotenv()

    from . import generate, ingest, llm  # lazy: keeps --help fast

    if args.list_providers:
        for pid, info in llm.PROVIDERS.items():
            _say(f"{pid:<12} {info['label']:<14} default model: {info['default_model']}")
            _say(f"{'':<12} {info['key_hint']}   (env: {ENV_KEYS.get(pid, '-')})")
        return EXIT_OK
    if not args.url:
        parser.print_usage(sys.stderr)
        _say("error: a YouTube URL is required", sys.stderr)
        return EXIT_USAGE

    env_name = ENV_KEYS[args.provider]
    key = (args.api_key or os.environ.get(env_name) or "").strip()
    groq_key = (args.groq_key or "").strip() or None
    _secrets.extend(k for k in (key, groq_key, os.environ.get("GROQ_API_KEY")) if k)
    if not key:
        _say(f"error: no API key for '{args.provider}'. Set {env_name} (or put it in a .env file), "
             "or pass --api-key. Free keys: run with --list-providers.", sys.stderr)
        return EXIT_USAGE
    try:
        out_dir, basename, pdf_path = _out_paths(args.out)
        ingest.parse_video_id(args.url)  # fail fast on a bad link, before any network use
    except (ValueError, ingest.IngestError) as e:
        _say(f"error: {e}", sys.stderr)
        return EXIT_USAGE

    progress = _Progress(enabled=not args.quiet)
    try:
        result = generate(args.url, args.provider, key, args.model, groq_key, out_dir, progress,
                          basename=basename, pdf_path=pdf_path,
                          write_html=args.html, write_json=args.json)
    except KeyboardInterrupt:
        progress.finish()
        _say("interrupted", sys.stderr)
        return EXIT_INTERRUPT
    except ingest.IngestError as e:
        progress.finish()
        _say(f"transcript error: {e}", sys.stderr)
        return EXIT_INGEST
    except llm.LLMError as e:
        progress.finish()
        _say(f"AI provider error: {e}", sys.stderr)
        return EXIT_LLM
    except Exception as e:  # noqa: BLE001 - never dump a traceback that could contain a key
        progress.finish()
        _say(f"unexpected error ({type(e).__name__}): {e}", sys.stderr)
        return EXIT_ERROR
    progress.finish()

    title = (result["notes"].get("meta") or {}).get("title") or "lecture"
    if result["pdf_path"]:
        _say(f"Done: {title}")
        _say(f"  pdf : {result['pdf_path']}")
        for label, k in (("html", "html_path"), ("json", "json_path")):
            if result.get(k):
                _say(f"  {label}: {result[k]}")
        return EXIT_OK

    # notes exist but no PDF: keep the work by saving the JSON and HTML preview
    from . import render_notes
    saved = render_notes(result["notes"], out_dir, basename, pdf=False)
    _say(f"warning: notes were written but the PDF could not be drawn. {result.get('warning') or ''}".rstrip(),
         sys.stderr)
    _say(f"  saved: {saved['html_path']}  {saved['json_path']}", sys.stderr)
    return EXIT_NO_PDF


if __name__ == "__main__":
    sys.exit(main())
