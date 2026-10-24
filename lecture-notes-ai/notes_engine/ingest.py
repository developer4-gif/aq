"""YouTube -> transcript ingestion for Lecture Notes AI.

Public surface:
    IngestError, parse_video_id, get_transcript, get_playlist, parse_playlist_id, chunk_transcript
(plus a few small helpers such as format_timestamp that other modules may use).

Fallback chain for get_transcript():
    1. youtube-transcript-api (v1.x instance API): manual captions > auto captions,
       English first, then any language.
    2. yt-dlp subtitle extraction (json3 / vtt).
    3. Only when a Groq key is supplied: yt-dlp audio download + ffmpeg
       (16 kHz mono, chunked well under 24 MB) + Groq Whisper.

Secrets: the Groq key is only ever sent in the Authorization header of the Groq
request; it is never logged and never included in an error message.
"""
from __future__ import annotations

import glob
import html
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from urllib.parse import parse_qs, urlparse

import requests

__all__ = [
    "IngestError",
    "parse_video_id",
    "get_transcript",
    "get_playlist",
    "parse_playlist_id",
    "chunk_transcript",
    "format_timestamp",
]

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

_YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
}
_SHORT_HOSTS = {"youtu.be", "www.youtu.be"}
_PATH_PREFIXES = ("shorts", "embed", "live", "v", "e")

_HTTP_TIMEOUT = 20
GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
GROQ_MODEL = "whisper-large-v3-turbo"
WHISPER_CHUNK_SECONDS = 600          # 10 min of 32 kbps mono mp3 ~ 2.4 MB
WHISPER_MAX_UPLOAD_BYTES = 24 * 1024 * 1024
MAX_AUDIO_BYTES = 600 * 1024 * 1024  # refuse to download absurdly large audio

MARKER_EVERY_SEC = 30

# --------------------------------------------------------------------------- #
# Errors
# --------------------------------------------------------------------------- #


class IngestError(Exception):
    """Raised for any ingestion failure. The message is safe to show to users."""


MSG_INVALID = (
    "That doesn't look like a valid YouTube link. Paste a video URL such as "
    "https://www.youtube.com/watch?v=XXXXXXXXXXX or https://youtu.be/XXXXXXXXXXX."
)
MSG_UNAVAILABLE = (
    "This video is unavailable. It may be private, deleted, members-only or "
    "blocked in your region. Check that the link opens in a normal browser "
    "window while signed out."
)
MSG_AGE = (
    "This video is age-restricted, so YouTube won't release its captions "
    "without a signed-in account. Please pick a video that isn't age-restricted."
)
MSG_BLOCKED = (
    "YouTube is rate-limiting or blocking requests from this computer or "
    "network (IP block), so the transcript can't be fetched right now. Wait a "
    "few minutes and try again, or switch network / disable the VPN."
)
MSG_NO_CAPTIONS = (
    "This video has no usable captions (the creator turned them off or none "
    "exist) and no Groq API key was provided for speech-to-text. Add a free "
    "Groq key in the settings to transcribe the audio, or choose a video that "
    "has captions."
)
MSG_NO_CAPTIONS_WHISPER_FAILED = (
    "This video has no usable captions, and the Groq speech-to-text fallback "
    "failed: {why}"
)
MSG_LIVE = (
    "This video is a live stream or premiere that hasn't finished yet. Try "
    "again once the recording is available."
)

# priority of failure reasons when everything fails (higher wins)
_PRIORITY = {"invalid": 6, "unavailable": 5, "age": 4, "live": 4, "blocked": 3, "nocaps": 1, "other": 0}
_MESSAGES = {
    "invalid": MSG_INVALID,
    "unavailable": MSG_UNAVAILABLE,
    "age": MSG_AGE,
    "live": MSG_LIVE,
    "blocked": MSG_BLOCKED,
    "nocaps": MSG_NO_CAPTIONS,
    "other": "Couldn't fetch the transcript for this video. Please try again in a moment.",
}


class _Fail(Exception):
    """Internal: a single stage failed. kind is a key of _MESSAGES."""

    def __init__(self, kind: str, detail: str = ""):
        super().__init__(detail or kind)
        self.kind = kind
        self.detail = detail


# --------------------------------------------------------------------------- #
# URL parsing (SSRF guard)
# --------------------------------------------------------------------------- #


def parse_video_id(url: str) -> str:
    """Return the 11-char video id for a YouTube URL, or raise IngestError.

    Only real YouTube hosts are accepted; anything else is rejected so the
    backend can never be pointed at an arbitrary server. A bare 11-character
    video id is also accepted.
    """
    if not isinstance(url, str):
        raise IngestError(MSG_INVALID)
    raw = url.strip()
    if not raw or len(raw) > 2048 or any(c in raw for c in "\r\n\t\x00"):
        raise IngestError(MSG_INVALID)
    if VIDEO_ID_RE.match(raw):
        return raw
    if "://" not in raw:
        raw = "https://" + raw.lstrip("/")
    try:
        parsed = urlparse(raw)
        host = (parsed.hostname or "").lower().rstrip(".")
        port = parsed.port  # may raise ValueError
    except ValueError:
        raise IngestError(MSG_INVALID) from None
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
        raise IngestError(MSG_INVALID)
    if port not in (None, 80, 443):
        raise IngestError(MSG_INVALID)

    candidate = None
    segments = [s for s in parsed.path.split("/") if s]
    if host in _SHORT_HOSTS:
        if segments:
            candidate = segments[0]
    elif host in _YOUTUBE_HOSTS:
        if segments and segments[0] == "watch":
            candidate = (parse_qs(parsed.query).get("v") or [None])[0]
        elif len(segments) >= 2 and segments[0] in _PATH_PREFIXES:
            candidate = segments[1]
    else:
        raise IngestError(
            "Only YouTube links are supported (youtube.com or youtu.be). "
            "That link points somewhere else."
        )
    if not candidate or not VIDEO_ID_RE.match(candidate):
        raise IngestError(MSG_INVALID)
    return candidate


def _canonical_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #


def format_timestamp(sec: float) -> str:
    """mm:ss, or h:mm:ss from one hour onwards."""
    s = max(0, int(sec))
    h, rem = divmod(s, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


def _progress(cb, stage: str, pct: int, msg: str) -> None:
    if cb is None:
        return
    try:
        cb(stage, int(pct), msg)
    except Exception:
        # A broken progress callback must never break ingestion.
        pass


class _TimeoutSession(requests.Session):
    """requests.Session with a default timeout (youtube-transcript-api sets none)."""

    def request(self, method, url, **kwargs):  # type: ignore[override]
        kwargs.setdefault("timeout", _HTTP_TIMEOUT)
        return super().request(method, url, **kwargs)


# --------------------------------------------------------------------------- #
# Text cleaning
# --------------------------------------------------------------------------- #

_TAG_RE = re.compile(r"<[^>]*>")
_ENTITY_RE = re.compile(r"&(#\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);")
_SOUND_WORDS = (
    r"music|musical|applause|laughter|laughing|laughs|cheering|cheers|silence|noise|"
    r"inaudible|crosstalk|singing|sings|sound|sounds|sfx|foreign|speaking|whistling|"
    r"clapping|audience|background|bell|beep|chuckles|coughs|sighs|gasps|"
    r"upbeat|soft|gentle|dramatic|intro|outro|jingle|chatter|static|buzz"
)
_SOUND_CUE_RE = re.compile(
    r"[\[\(]\s*(?:" + _SOUND_WORDS + r")\b[^\]\)]{0,40}[\]\)]", re.IGNORECASE
)
_MUSIC_NOTE_RE = re.compile(r"[\u266a\u266b\u266c\u2669]+[^\u266a\u266b\u266c\u2669]*[\u266a\u266b\u266c\u2669]*")
_CENSOR_RE = re.compile(r"\[\s*_+\s*\]")
_SPEAKER_RE = re.compile(r"^\s*(?:>>+|-)\s+")
_WS_RE = re.compile(r"\s+")


def clean_text(text: str) -> str:
    """Strip markup, entities, [Music]-style cues and collapse whitespace."""
    if not text:
        return ""
    text = _TAG_RE.sub("", text)
    for _ in range(2):
        if not _ENTITY_RE.search(text):
            break
        text = html.unescape(text)
    text = text.replace("\u00a0", " ").replace("\u200b", "")
    text = _SOUND_CUE_RE.sub(" ", text)
    text = _MUSIC_NOTE_RE.sub(" ", text)
    text = _CENSOR_RE.sub(" ", text)
    text = _WS_RE.sub(" ", text).strip()
    text = _SPEAKER_RE.sub("", text)
    return text.strip()


def _norm_line(s: str) -> str:
    return _WS_RE.sub(" ", s).strip().lower()


def _words(s: str) -> list[str]:
    return s.split()


def _drop_word_overlap(prev: str, new: str) -> str:
    """Remove from the start of `new` any words that already end `prev`.

    Handles rolling auto-captions where each cue repeats the previous cue's
    tail ("so today we" -> "so today we will"). Requires >= 3 overlapping words
    (or the whole new cue being contained) to avoid eating real repetition.
    """
    pw, nw = _words(prev), _words(new)
    if not pw or not nw:
        return new
    pl = [w.lower() for w in pw]
    nl = [w.lower() for w in nw]
    if nl == pl:
        return ""
    if len(nl) >= 3 and len(nl) <= len(pl) and pl[-len(nl):] == nl:
        return ""
    max_k = min(len(pl), len(nl))
    for k in range(max_k, 2, -1):
        if pl[-k:] == nl[:k]:
            return " ".join(nw[k:])
    return new


def _dedupe_cues(cues: list[tuple[float, float, list[str]]]) -> list[tuple[float, float, str]]:
    """cues: (start, duration, [lines]) -> (start, duration, cleaned_text) without rolling dupes."""
    out: list[tuple[float, float, str]] = []
    prev_lines: set[str] = set()
    prev_text = ""
    for start, dur, lines in cues:
        cleaned = [clean_text(l) for l in lines]
        cleaned = [l for l in cleaned if l]
        keys = {_norm_line(l) for l in cleaned}
        fresh = [l for l in cleaned if _norm_line(l) not in prev_lines]
        prev_lines = keys or prev_lines
        text = " ".join(fresh).strip()
        if text:
            text = _drop_word_overlap(prev_text, text).strip()
        if not text:
            continue
        prev_text = text if len(_words(text)) >= 3 else (prev_text + " " + text).strip()
        out.append((float(start), float(dur), text))
    return out


_SENT_END = (".", "?", "!", "\u3002", "\uff1f", "\uff01")


def _merge_cues(cues: list[tuple[float, float, str]]) -> list[dict]:
    """Merge tiny fragments into ~5-15 s segments, preserving time order."""
    cues = sorted(cues, key=lambda c: c[0])
    segments: list[dict] = []
    cur_start = None
    cur_text = ""
    for start, _dur, text in cues:
        if cur_start is not None:
            span = start - cur_start
            ends_sentence = cur_text.endswith(_SENT_END)
            if (
                span >= 15
                or (span >= 5 and ends_sentence)
                or (span >= 10 and len(cur_text) >= 120)
                or len(cur_text) >= 320
            ):
                segments.append({"start": round(cur_start, 2), "text": cur_text})
                cur_start, cur_text = None, ""
        if cur_start is None:
            cur_start, cur_text = start, text
        else:
            cur_text = f"{cur_text} {text}"
    if cur_start is not None and cur_text:
        segments.append({"start": round(cur_start, 2), "text": cur_text})
    return segments


def _build_segments(raw_cues: list[tuple[float, float, list[str]]]) -> list[dict]:
    return _merge_cues(_dedupe_cues(raw_cues))


# --------------------------------------------------------------------------- #
# Metadata
# --------------------------------------------------------------------------- #

_YTDLP_COMMON = {
    "quiet": True,
    "no_warnings": True,
    "noprogress": True,
    "socket_timeout": 20,
    "retries": 2,
    "noplaylist": True,
    "cachedir": False,
}


def _ytdlp_error_kind(msg: str) -> str:
    m = (msg or "").lower()
    if "age" in m and ("confirm your age" in m or "age-restricted" in m or "age restricted" in m
                       or "inappropriate for some users" in m):
        return "age"
    if "private video" in m or "video unavailable" in m or "has been removed" in m \
            or "this video is not available" in m or "members-only" in m or "members only" in m \
            or "join this channel" in m or "terminated" in m or "does not exist" in m \
            or "no longer available" in m or "blocked it in your country" in m \
            or "not made this video available" in m:
        return "unavailable"
    if "live event will begin" in m or "premieres in" in m or "is live" in m:
        return "live"
    if "not a bot" in m or "429" in m or "too many requests" in m or "rate" in m and "limit" in m:
        return "blocked"
    return "other"


def _ytdlp_info(video_id: str, cache: dict | None = None) -> dict:
    """yt-dlp metadata (incl. subtitle URLs). Raises _Fail."""
    if cache is not None and "info" in cache:
        return cache["info"]
    try:
        import yt_dlp
    except ImportError:
        raise _Fail("other", "yt-dlp not installed") from None
    opts = dict(_YTDLP_COMMON, skip_download=True)
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(_canonical_url(video_id), download=False)
    except Exception as e:  # yt_dlp.utils.DownloadError & friends
        raise _Fail(_ytdlp_error_kind(str(e)), str(e)[:300]) from None
    if not isinstance(info, dict):
        raise _Fail("other", "yt-dlp returned no info")
    if cache is not None:
        cache["info"] = info
    return info


def _oembed(video_id: str) -> tuple[str, str]:
    """(title, channel) via YouTube oEmbed. Raises _Fail on any problem."""
    try:
        r = requests.get(
            "https://www.youtube.com/oembed",
            params={"url": _canonical_url(video_id), "format": "json"},
            timeout=_HTTP_TIMEOUT,
        )
    except requests.RequestException as e:
        raise _Fail("other", f"oembed network: {type(e).__name__}") from None
    if r.status_code in (401, 403):
        raise _Fail("other", "oembed not allowed")  # often non-embeddable / age-gated
    if r.status_code == 404:
        raise _Fail("unavailable", "oembed 404")
    if r.status_code != 200:
        raise _Fail("other", f"oembed HTTP {r.status_code}")
    try:
        data = r.json()
    except ValueError:
        raise _Fail("other", "oembed bad json") from None
    title = clean_text(str(data.get("title") or "")) or ""
    channel = clean_text(str(data.get("author_name") or "")) or ""
    if not title:
        raise _Fail("other", "oembed empty")
    return title, channel


def _get_metadata(video_id: str, cache: dict) -> tuple[str, str, int | None]:
    """Return (title, channel, duration_sec|None). Never raises."""
    title = channel = ""
    duration = None
    try:
        title, channel = _oembed(video_id)
    except _Fail:
        pass
    if not title:
        try:
            info = _ytdlp_info(video_id, cache)
            title = clean_text(str(info.get("title") or ""))
            channel = clean_text(str(info.get("channel") or info.get("uploader") or ""))
            d = info.get("duration")
            duration = int(d) if isinstance(d, (int, float)) else None
        except _Fail:
            pass
    return title or f"YouTube video {video_id}", channel or "Unknown channel", duration


# --------------------------------------------------------------------------- #
# Stage 1: youtube-transcript-api
# --------------------------------------------------------------------------- #


def _lang_rank(code: str) -> int:
    c = (code or "").lower()
    if c == "en" or c.startswith("en-") or c.startswith("en_"):
        return 0
    return 1


def _pick_transcript(transcripts) -> object | None:
    """manual > auto, English before other languages -> but English auto beats
    non-English manual only if no English manual exists.

    Order: manual en, auto en, manual other, auto other.
    """
    items = list(transcripts)
    if not items:
        return None

    def key(t):
        return (_lang_rank(t.language_code), 1 if t.is_generated else 0)

    return sorted(items, key=key)[0]


def _classify_api_exception(e: Exception) -> _Fail:
    import youtube_transcript_api as yta

    name = type(e).__name__
    if isinstance(e, yta.AgeRestricted):
        return _Fail("age", name)
    if isinstance(e, (yta.IpBlocked, yta.RequestBlocked)):
        return _Fail("blocked", name)
    if isinstance(e, (yta.VideoUnavailable, yta.InvalidVideoId)):
        return _Fail("unavailable", name)
    if isinstance(e, (yta.TranscriptsDisabled, yta.NoTranscriptFound)):
        return _Fail("nocaps", name)
    if isinstance(e, yta.VideoUnplayable):
        reason = str(getattr(e, "reason", "") or "") + " " + str(e)
        kind = _ytdlp_error_kind(reason)
        return _Fail(kind if kind != "other" else "unavailable", name)
    if isinstance(e, yta.PoTokenRequired):
        return _Fail("blocked", name)
    if isinstance(e, (requests.Timeout, requests.ConnectionError)):
        return _Fail("other", "network error")
    return _Fail("other", f"{name}: {str(e)[:200]}")


def _fetch_via_api(video_id: str) -> tuple[list[dict], str, str, float]:
    """Return (segments, language_code, source, est_duration)."""
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError:
        raise _Fail("other", "youtube-transcript-api not installed") from None

    api = YouTubeTranscriptApi(http_client=_TimeoutSession())
    last_exc: Exception | None = None
    for attempt in range(2):
        try:
            tlist = api.list(video_id)
            chosen = _pick_transcript(tlist)
            if chosen is None:
                raise _Fail("nocaps", "no transcripts listed")
            fetched = chosen.fetch()
            break
        except _Fail:
            raise
        except Exception as e:
            last_exc = e
            fail = _classify_api_exception(e)
            if fail.kind == "other" and attempt == 0:
                time.sleep(1.5)  # one retry for transient failures
                continue
            raise fail from None
    else:  # pragma: no cover - loop always breaks or raises
        raise _classify_api_exception(last_exc or Exception("unknown"))

    cues = []
    est_end = 0.0
    for sn in fetched:
        start = float(sn.start)
        dur = float(getattr(sn, "duration", 0.0) or 0.0)
        cues.append((start, dur, str(sn.text).split("\n")))
        est_end = max(est_end, start + dur)
    segments = _build_segments(cues)
    if not segments:
        raise _Fail("nocaps", "transcript empty after cleaning")
    source = "auto-captions" if fetched.is_generated else "captions"
    return segments, fetched.language_code, source, est_end


# --------------------------------------------------------------------------- #
# Stage 2: yt-dlp subtitles
# --------------------------------------------------------------------------- #

_VTT_TIME_RE = re.compile(
    r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})"
)


def _parse_json3(data: dict) -> list[tuple[float, float, list[str]]]:
    cues = []
    for ev in data.get("events", []) or []:
        segs = ev.get("segs")
        if not segs:
            continue
        text = "".join(s.get("utf8", "") for s in segs if isinstance(s, dict))
        if not text.strip():
            continue
        start = float(ev.get("tStartMs", 0)) / 1000.0
        dur = float(ev.get("dDurationMs", 0) or 0) / 1000.0
        cues.append((start, dur, text.split("\n")))
    return cues


def _parse_vtt(text: str) -> list[tuple[float, float, list[str]]]:
    cues = []
    blocks = re.split(r"\r?\n\r?\n", text.replace("\ufeff", ""))
    for block in blocks:
        lines = block.splitlines()
        for i, line in enumerate(lines):
            m = _VTT_TIME_RE.search(line)
            if not m:
                continue
            h1, m1, s1, ms1, h2, m2, s2, ms2 = m.groups()
            start = int(h1 or 0) * 3600 + int(m1) * 60 + int(s1) + int(ms1) / 1000
            end = int(h2 or 0) * 3600 + int(m2) * 60 + int(s2) + int(ms2) / 1000
            body = [l for l in lines[i + 1:] if l.strip()]
            if body:
                cues.append((start, max(0.0, end - start), body))
            break
    return cues


def _pick_ytdlp_track(info: dict) -> tuple[list[dict], str, str] | None:
    """Return (formats, lang, source) for the best subtitle track, or None."""
    subs = info.get("subtitles") or {}
    autos = info.get("automatic_captions") or {}
    video_lang = (info.get("language") or "").lower()

    cands: list[tuple[tuple, str, str, list[dict]]] = []
    for lang, fmts in subs.items():
        if fmts and lang != "live_chat":
            cands.append(((_lang_rank(lang), 0), lang, "captions", fmts))
    for lang, fmts in autos.items():
        if not fmts or lang == "live_chat":
            continue
        base = lang.split("-")[0].lower()
        # Auto tracks list ~100 machine-translated languages; keep the original
        # ("xx-orig" or the video's own language) and English.
        orig = lang.endswith("-orig") or (video_lang and base == video_lang and "-" not in lang)
        if orig or lang.lower() == "en":
            cands.append(((_lang_rank(lang), 1), lang, "auto-captions", fmts))
    if not cands:
        return None
    cands.sort(key=lambda c: c[0])
    _, lang, source, fmts = cands[0]
    return fmts, lang, source


def _fetch_via_ytdlp(video_id: str, cache: dict) -> tuple[list[dict], str, str, float]:
    info = _ytdlp_info(video_id, cache)
    if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming"):
        raise _Fail("live", "live")
    pick = _pick_ytdlp_track(info)
    if pick is None:
        raise _Fail("nocaps", "yt-dlp found no subtitle tracks")
    fmts, lang, source = pick

    by_ext = {f.get("ext"): f for f in fmts if f.get("url")}
    order = ["json3", "vtt", "srv3"]
    chosen = next((by_ext[e] for e in order if e in by_ext and e != "srv3"), None)
    if chosen is None:
        raise _Fail("nocaps", "no json3/vtt subtitle format")
    url = chosen["url"]
    host = (urlparse(url).hostname or "").lower()
    if not (host.endswith(".youtube.com") or host == "youtube.com" or host.endswith(".googlevideo.com")):
        raise _Fail("other", "unexpected subtitle host")
    try:
        r = requests.get(url, timeout=_HTTP_TIMEOUT)
    except requests.RequestException as e:
        raise _Fail("other", f"subtitle download: {type(e).__name__}") from None
    if r.status_code == 429:
        raise _Fail("blocked", "subtitle 429")
    if r.status_code != 200:
        raise _Fail("other", f"subtitle HTTP {r.status_code}")
    try:
        if chosen.get("ext") == "json3":
            cues = _parse_json3(r.json())
        else:
            cues = _parse_vtt(r.content.decode("utf-8", "replace"))
    except ValueError:
        raise _Fail("other", "subtitle parse error") from None
    segments = _build_segments(cues)
    if not segments:
        raise _Fail("nocaps", "subtitles empty after cleaning")
    d = info.get("duration")
    est = float(d) if isinstance(d, (int, float)) else (cues[-1][0] + cues[-1][1] if cues else 0.0)
    cache["duration"] = int(d) if isinstance(d, (int, float)) else None
    return segments, lang, source, est


# --------------------------------------------------------------------------- #
# Stage 3: Groq Whisper
# --------------------------------------------------------------------------- #


def _find_ffmpeg() -> str | None:
    env = (os.environ.get("FFMPEG_PATH") or "").strip()
    if env and os.path.isfile(env):
        return env
    return shutil.which("ffmpeg")


def _download_audio(video_id: str, out_dir: str, cache: dict) -> str:
    import yt_dlp

    opts = dict(
        _YTDLP_COMMON,
        format="bestaudio[abr<=160]/bestaudio/best",
        outtmpl=os.path.join(out_dir, "audio.%(ext)s"),
        max_filesize=MAX_AUDIO_BYTES,
        skip_download=False,
    )
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(_canonical_url(video_id), download=True)
        if isinstance(info, dict) and "info" not in cache:
            cache["info"] = info
    except Exception as e:
        raise _Fail(_ytdlp_error_kind(str(e)), str(e)[:300]) from None
    files = [f for f in glob.glob(os.path.join(out_dir, "audio.*")) if not f.endswith(".part")]
    if not files:
        raise _Fail("other", "audio download produced no file (maybe too large)")
    return files[0]


def _split_audio(ffmpeg: str, src: str, out_dir: str) -> list[str]:
    pattern = os.path.join(out_dir, "chunk_%04d.mp3")
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", src,
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k",
        "-f", "segment", "-segment_time", str(WHISPER_CHUNK_SECONDS),
        "-reset_timestamps", "1", pattern,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=1800)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise _Fail("other", f"ffmpeg failed: {type(e).__name__}") from None
    if proc.returncode != 0:
        raise _Fail("other", "ffmpeg failed: " + proc.stderr.decode("utf-8", "replace")[-200:])
    chunks = sorted(glob.glob(os.path.join(out_dir, "chunk_*.mp3")))
    if not chunks:
        raise _Fail("other", "ffmpeg produced no audio chunks")
    for c in chunks:
        if os.path.getsize(c) > WHISPER_MAX_UPLOAD_BYTES:
            raise _Fail("other", "audio chunk too large for Groq upload")
    return chunks


_WHISPER_LANGS = {
    "english": "en", "hindi": "hi", "spanish": "es", "french": "fr", "german": "de",
    "portuguese": "pt", "italian": "it", "russian": "ru", "japanese": "ja", "korean": "ko",
    "chinese": "zh", "arabic": "ar", "turkish": "tr", "dutch": "nl", "polish": "pl",
    "indonesian": "id", "tamil": "ta", "telugu": "te", "marathi": "mr", "bengali": "bn",
    "urdu": "ur", "gujarati": "gu", "ukrainian": "uk", "vietnamese": "vi", "thai": "th",
}


def _groq_transcribe_chunk(path: str, groq_key: str) -> tuple[list[dict], str]:
    """Return (segments, language_code) for one audio chunk."""
    headers = {"Authorization": f"Bearer {groq_key}"}
    last = "unknown error"
    for attempt in range(4):
        try:
            with open(path, "rb") as fh:
                r = requests.post(
                    GROQ_URL,
                    headers=headers,
                    files={"file": (os.path.basename(path), fh, "audio/mpeg")},
                    data={"model": GROQ_MODEL, "response_format": "verbose_json", "temperature": "0"},
                    timeout=300,
                )
        except requests.RequestException as e:
            last = f"network error ({type(e).__name__})"
            time.sleep(2 * (attempt + 1))
            continue
        if r.status_code == 200:
            try:
                data = r.json()
                lang = str(data.get("language") or "").lower()
                return data.get("segments") or [], _WHISPER_LANGS.get(lang, lang)
            except ValueError:
                last = "invalid response from Groq"
                continue
        if r.status_code in (401, 403):
            raise _Fail("other", "the Groq API key was rejected (check that it is correct)")
        if r.status_code == 429 or r.status_code >= 500:
            last = "Groq rate limit reached" if r.status_code == 429 else f"Groq server error {r.status_code}"
            try:
                wait = float(r.headers.get("retry-after", 0)) or 5 * (attempt + 1)
            except ValueError:
                wait = 5 * (attempt + 1)
            time.sleep(min(wait, 30))
            continue
        last = f"Groq returned HTTP {r.status_code}"
        break
    raise _Fail("other", last)


def _fetch_via_whisper(video_id: str, groq_key: str, cache: dict, progress) -> tuple[list[dict], str, str, float]:
    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        raise _Fail("other", "ffmpeg was not found on this computer")
    tmp = tempfile.mkdtemp(prefix="lna_audio_")
    try:
        _progress(progress, "transcript", 40, "No captions found - downloading audio for speech-to-text...")
        audio = _download_audio(video_id, tmp, cache)
        _progress(progress, "transcript", 55, "Preparing audio...")
        chunks = _split_audio(ffmpeg, audio, tmp)
        cues: list[tuple[float, float, list[str]]] = []
        language = ""
        n = len(chunks)
        for i, ch in enumerate(chunks):
            _progress(progress, "transcript", 60 + int(35 * i / n), f"Transcribing audio {i + 1}/{n}...")
            offset = i * WHISPER_CHUNK_SECONDS
            segs, lang = _groq_transcribe_chunk(ch, groq_key)
            language = language or lang
            for seg in segs:
                if float(seg.get("no_speech_prob", 0) or 0) > 0.9:
                    continue
                s = float(seg.get("start", 0)) + offset
                e = float(seg.get("end", 0)) + offset
                cues.append((s, max(0.0, e - s), [str(seg.get("text", ""))]))
        segments = _build_segments(cues)
        if not segments:
            raise _Fail("other", "no speech was detected in the audio")
        est = max((c[0] + c[1] for c in cues), default=0.0)
        return segments, language or "en", "whisper", est
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# --------------------------------------------------------------------------- #
# Public: get_transcript
# --------------------------------------------------------------------------- #


def get_transcript(url: str, *, groq_key: str | None = None, progress=None) -> dict:
    """Fetch and clean the transcript for a YouTube video. Raises IngestError."""
    video_id = parse_video_id(url)
    _progress(progress, "transcript", 3, "Checking the video link...")
    cache: dict = {}
    groq_key = (groq_key or "").strip() or None

    _progress(progress, "transcript", 8, "Looking up the video title...")
    title, channel, duration = _get_metadata(video_id, cache)

    failures: list[_Fail] = []
    result = None

    stages = [
        ("api", 15, "Fetching captions from YouTube...", lambda: _fetch_via_api(video_id)),
        ("ytdlp", 30, "Trying another way to fetch captions...", lambda: _fetch_via_ytdlp(video_id, cache)),
    ]
    for name, pct, msg, fn in stages:
        _progress(progress, "transcript", pct, msg)
        try:
            result = fn()
            break
        except _Fail as f:
            failures.append(f)
            # Private/unavailable videos won't get better with another method.
            if f.kind in ("unavailable", "invalid", "live"):
                break
        except Exception as e:  # defensive: never leak raw library errors
            failures.append(_Fail("other", f"{type(e).__name__}: {str(e)[:200]}"))

    whisper_fail: _Fail | None = None
    hard = any(f.kind in ("unavailable", "invalid", "live") for f in failures)
    if result is None and groq_key and not hard:
        try:
            result = _fetch_via_whisper(video_id, groq_key, cache, progress)
        except _Fail as f:
            whisper_fail = f
        except Exception as e:
            whisper_fail = _Fail("other", f"{type(e).__name__}")

    if result is None:
        raise IngestError(_final_message(failures, whisper_fail, bool(groq_key)))

    segments, language, source, est_end = result
    if duration is None:
        duration = cache.get("duration")
    if duration is None and est_end:
        duration = int(round(est_end))
    _progress(progress, "transcript", 100, f"Transcript ready ({len(segments)} segments).")
    return {
        "video_id": video_id,
        "url": _canonical_url(video_id),
        "title": title,
        "channel": channel,
        "duration_sec": duration,
        "language": language or "en",
        "source": source,
        "segments": segments,
    }


def _final_message(failures: list[_Fail], whisper_fail: _Fail | None, had_key: bool) -> str:
    kinds = [f.kind for f in failures]
    best = max(kinds, key=lambda k: _PRIORITY.get(k, 0)) if kinds else "other"
    if whisper_fail is not None and best in ("nocaps", "other", "blocked"):
        why = whisper_fail.detail or "unknown error"
        # whisper details are produced by this module (no secrets); trim for safety
        return MSG_NO_CAPTIONS_WHISPER_FAILED.format(why=why[:200])
    if best == "nocaps" and had_key:
        return MSG_NO_CAPTIONS_WHISPER_FAILED.format(why="could not transcribe the audio.")
    return _MESSAGES.get(best, _MESSAGES["other"])


# --------------------------------------------------------------------------- #
# Public: get_playlist (YouTube playlist -> list of videos, metadata only)
# --------------------------------------------------------------------------- #

PLAYLIST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{10,64}$")
PLAYLIST_LIMIT = 200
_PLAYLIST_SLACK = 25  # extra raw entries fetched so skipped (private/deleted) ones don't eat the cap

MSG_NOT_PLAYLIST = (
    "That doesn't look like a YouTube playlist link. Paste a link such as "
    "https://www.youtube.com/playlist?list=PLxxxxxxxxxxxx (or a video link that contains &list=...)."
)
MSG_PLAYLIST_MIX = (
    "That is a YouTube Mix (an auto-generated radio playlist). Mixes are different for every viewer, "
    "so they can't be imported. Open a real playlist and paste its link."
)
MSG_PLAYLIST_PRIVATE = (
    "This playlist is private (or needs a signed-in account), so it can't be imported. "
    "Ask the owner to set it to Unlisted or Public, then try again."
)
MSG_PLAYLIST_NOT_FOUND = (
    "YouTube couldn't find that playlist. It may be private or deleted, or the link may be wrong."
)
MSG_PLAYLIST_BLOCKED = (
    "YouTube is rate-limiting requests from this computer or network right now. "
    "Wait a few minutes and try again, or switch network / disable the VPN."
)
MSG_PLAYLIST_OTHER = "Couldn't read that playlist from YouTube. Please try again in a moment."


class PlaylistError(IngestError):
    """IngestError with an HTTP status hint for the API layer (message is user-safe)."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def parse_playlist_id(url: str) -> str:
    """Return the playlist id of a YouTube playlist link, or raise IngestError.

    Accepted: youtube.com/playlist?list=ID, youtube.com/watch?v=VID&list=ID,
    youtu.be/VID?list=ID (and embed/videoseries?list=ID). Only real YouTube hosts
    are accepted (same SSRF guard as parse_video_id) and the id must match
    PLAYLIST_ID_RE exactly.
    """
    if not isinstance(url, str):
        raise PlaylistError(MSG_NOT_PLAYLIST)
    raw = url.strip()
    if not raw or len(raw) > 2048 or any(c in raw for c in "\r\n\t\x00"):
        raise PlaylistError(MSG_NOT_PLAYLIST)
    if "://" not in raw:
        raw = "https://" + raw.lstrip("/")
    try:
        parsed = urlparse(raw)
        host = (parsed.hostname or "").lower().rstrip(".")
        port = parsed.port  # may raise ValueError
    except ValueError:
        raise PlaylistError(MSG_NOT_PLAYLIST) from None
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
        raise PlaylistError(MSG_NOT_PLAYLIST)
    if port not in (None, 80, 443):
        raise PlaylistError(MSG_NOT_PLAYLIST)

    segments = [s for s in parsed.path.split("/") if s]
    if host in _SHORT_HOSTS:
        if len(segments) != 1 or not VIDEO_ID_RE.match(segments[0]):
            raise PlaylistError(MSG_NOT_PLAYLIST)
    elif host in _YOUTUBE_HOSTS:
        ok = (segments == ["playlist"] or segments == ["watch"]
              or segments == ["embed", "videoseries"])
        if not ok:
            raise PlaylistError(MSG_NOT_PLAYLIST)
    else:
        raise PlaylistError(
            "Only YouTube links are supported (youtube.com or youtu.be). "
            "That link points somewhere else."
        )
    ids = parse_qs(parsed.query).get("list") or []
    if len(ids) != 1:
        raise PlaylistError(MSG_NOT_PLAYLIST)
    list_id = ids[0]
    if list_id in ("WL", "LL"):  # Watch later / Liked videos: always private
        raise PlaylistError(MSG_PLAYLIST_PRIVATE)
    if not PLAYLIST_ID_RE.fullmatch(list_id):  # fullmatch: "$" alone would accept a trailing newline
        raise PlaylistError(MSG_NOT_PLAYLIST)
    if list_id.startswith("RD"):  # auto-generated Mix / radio
        raise PlaylistError(MSG_PLAYLIST_MIX)
    return list_id


def _playlist_error(msg: str) -> PlaylistError:
    """Map a yt-dlp failure to a friendly PlaylistError (never echoes raw library text)."""
    m = (msg or "").lower()
    if "private" in m or "sign in" in m and "not a bot" not in m or "log in" in m or "members-only" in m:
        return PlaylistError(MSG_PLAYLIST_PRIVATE, 403)
    if ("does not exist" in m or "not found" in m or "404" in m or "unavailable" in m
            or "been removed" in m or "terminated" in m or "no longer available" in m
            or "not a valid" in m or "invalid" in m):
        return PlaylistError(MSG_PLAYLIST_NOT_FOUND, 404)
    if "not a bot" in m or "429" in m or "too many requests" in m or ("rate" in m and "limit" in m):
        return PlaylistError(MSG_PLAYLIST_BLOCKED, 503)
    return PlaylistError(MSG_PLAYLIST_OTHER, 502)


_CTRL_RE = re.compile(r"[\x00-\x1f\x7f​‪-‮⁦-⁩]")
_DEAD_TITLES = {"[private video]", "[deleted video]", "private video", "deleted video"}


def _plain(text, limit: int) -> str:
    """Single-line, control-character-free text capped at `limit` characters."""
    s = _CTRL_RE.sub(" ", str(text or ""))
    return _WS_RE.sub(" ", s).strip()[:limit]


def _playlist_entry(e) -> dict | None:
    """Normalise one flat yt-dlp entry; None for private/deleted/invalid ones."""
    if not isinstance(e, dict):
        return None
    vid = e.get("id")
    if not isinstance(vid, str) or not VIDEO_ID_RE.match(vid):
        return None
    title = _plain(e.get("title"), 200)
    if not title or title.lower() in _DEAD_TITLES:
        return None
    if str(e.get("availability") or "").lower() in ("private", "needs_auth", "premium_only", "subscriber_only"):
        return None
    d = e.get("duration")
    dur = int(d) if isinstance(d, (int, float)) and not isinstance(d, bool) and 0 < d < 10 * 24 * 3600 else None
    return {
        "id": vid,
        "title": title,
        "channel": _plain(e.get("channel") or e.get("uploader"), 120),
        "duration_sec": dur,
    }


def _ytdlp_playlist(list_id: str, raw_limit: int) -> dict:
    """Flat yt-dlp listing of a playlist (no per-video requests, no download)."""
    try:
        import yt_dlp
    except ImportError:
        raise PlaylistError(MSG_PLAYLIST_OTHER, 503) from None
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "skip_download": True,
        "extract_flat": "in_playlist",
        "socket_timeout": 20,
        "retries": 2,
        "extractor_retries": 1,
        "cachedir": False,
        "playlistend": raw_limit,
        "ignoreerrors": False,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/playlist?list={list_id}", download=False)
    except Exception as e:  # yt_dlp.utils.DownloadError & friends
        raise _playlist_error(str(e)) from None
    if not isinstance(info, dict):
        raise PlaylistError(MSG_PLAYLIST_NOT_FOUND, 404)
    return info


def get_playlist(url: str, limit: int = PLAYLIST_LIMIT) -> dict:
    """List the videos of a public/unlisted YouTube playlist (metadata only).

    Returns {id, title, channel, count, videos:[{id, title, channel, duration_sec}],
    truncated, skipped}. Private/deleted entries are skipped (counted in `skipped`);
    at most `limit` videos are returned (`truncated` is True when more exist).
    Raises IngestError (PlaylistError) with a user-safe message.
    """
    list_id = parse_playlist_id(url)
    try:
        limit = max(1, min(int(limit), 1000))
    except (TypeError, ValueError):
        limit = PLAYLIST_LIMIT
    raw_limit = limit + _PLAYLIST_SLACK
    info = _ytdlp_playlist(list_id, raw_limit)

    entries = info.get("entries")
    if entries is None:
        raise PlaylistError(MSG_PLAYLIST_NOT_FOUND, 404)
    videos: list[dict] = []
    seen: set[str] = set()
    skipped = 0
    raw_count = 0
    for e in entries:
        raw_count += 1
        v = _playlist_entry(e)
        if v is None:
            skipped += 1
            continue
        if v["id"] in seen:
            continue
        seen.add(v["id"])
        videos.append(v)
    truncated = len(videos) > limit or (raw_count >= raw_limit and len(videos) >= limit)
    videos = videos[:limit]

    title = _plain(info.get("title"), 150) or "YouTube playlist"
    channel = _plain(info.get("channel") or info.get("uploader"), 120)
    if not channel and videos:  # fall back to the first video's channel
        channel = videos[0]["channel"]
    # YouTube's playlist page omits the per-video channel for the playlist owner's own videos
    for v in videos:
        if not v["channel"]:
            v["channel"] = channel
    return {
        "id": list_id,
        "title": title,
        "channel": channel,
        "count": len(videos),
        "videos": videos,
        "truncated": bool(truncated),
        "skipped": skipped,
    }


# --------------------------------------------------------------------------- #
# Public: chunk_transcript
# --------------------------------------------------------------------------- #


def _split_long_text(text: str, limit: int) -> list[str]:
    """Split text on whitespace into pieces no longer than `limit` characters."""
    if len(text) <= limit:
        return [text]
    pieces, cur = [], ""
    for w in text.split():
        while len(w) > limit:  # absurdly long token
            if cur:
                pieces.append(cur)
                cur = ""
            pieces.append(w[:limit])
            w = w[limit:]
        if cur and len(cur) + 1 + len(w) > limit:
            pieces.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}" if cur else w
    if cur:
        pieces.append(cur)
    return pieces


def _render_chunk(segs: list[tuple[float, str]]) -> str:
    """Join segments, inserting a [mm:ss] marker at the first segment and then
    whenever >= MARKER_EVERY_SEC has passed since the previous marker."""
    parts: list[str] = []
    last_marker = None
    for start, text in segs:
        if last_marker is None or start - last_marker >= MARKER_EVERY_SEC:
            parts.append(f"[{format_timestamp(start)}]")
            last_marker = start
        parts.append(text)
    return " ".join(parts)


def _seg_cost(text: str) -> int:
    return len(text) + 1


def chunk_transcript(transcript: dict, max_chars: int = 12000, overlap_chars: int = 400) -> list[dict]:
    """Split a transcript into LLM-sized chunks with inline [mm:ss] markers.

    Each chunk is self-contained (starts with a marker). Consecutive chunks
    overlap by up to `overlap_chars` of trailing text. `index` is 0-based.
    """
    raw = transcript.get("segments") or []
    max_chars = max(300, int(max_chars))
    overlap_chars = max(0, min(int(overlap_chars), max_chars // 3))
    marker_budget = 12  # room for a leading "[h:mm:ss] "
    piece_limit = max(100, max_chars // 2 - marker_budget)

    segs: list[tuple[float, str]] = []
    for s in raw:
        text = clean_text(str(s.get("text", "")))
        if not text:
            continue
        for piece in _split_long_text(text, piece_limit):
            segs.append((float(s.get("start", 0.0)), piece))
    if not segs:
        return []
    segs.sort(key=lambda x: x[0])

    def fill(first: int) -> int:
        """Greedy: index one past the last segment that fits max_chars."""
        used, k, last_marker = 0, first, None
        while k < n:
            start, text = segs[k]
            cost = _seg_cost(text)
            marker = last_marker is None or start - last_marker >= MARKER_EVERY_SEC
            if marker:
                cost += len(format_timestamp(start)) + 3
            if used + cost > max_chars and k > first:
                break
            used += cost
            if marker:
                last_marker = start
            k += 1
        return k

    chunks_idx: list[tuple[int, int]] = []  # (first_seg_idx, last_seg_idx_exclusive)
    i = 0
    n = len(segs)
    while i < n:
        first = i
        if chunks_idx:
            prev_start, prev_end = chunks_idx[-1]
            acc, j = 0, prev_end
            while j > prev_start + 1:  # never re-start at the previous chunk's first segment
                c = _seg_cost(segs[j - 1][1])
                if acc + c > overlap_chars:
                    break
                acc += c
                j -= 1
            first = j
        k = fill(first)
        if k <= i:  # overlap left no room for new text: drop the overlap
            first = i
            k = fill(first)
        chunks_idx.append((first, k))
        i = k

    out = []
    for idx, (a, b) in enumerate(chunks_idx):
        part = segs[a:b]
        end_t = segs[b][0] if b < n else None
        if end_t is None:
            dur = transcript.get("duration_sec")
            end_t = float(dur) if isinstance(dur, (int, float)) and dur >= part[-1][0] else part[-1][0] + 10.0
        out.append(
            {
                "index": idx,
                "start": float(part[0][0]),
                "end": float(end_t),
                "text": _render_chunk(part),
            }
        )
    return out
