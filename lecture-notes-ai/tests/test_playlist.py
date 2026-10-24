"""Playlist import: notes_engine.ingest.get_playlist + GET /api/playlist. yt-dlp is mocked (no network)."""
import json
import sys
import types

import pytest

from app import server as srv
from notes_engine import ingest
from notes_engine.ingest import IngestError, get_playlist, parse_playlist_id

LIST_ID = "PLZHQObOWTQDPD3MizzM2xVFitgF8hE_ab"
PL_URL = f"https://www.youtube.com/playlist?list={LIST_ID}"


def entry(i, **kw):
    e = {"_type": "url", "id": f"vid{i:08d}"[-11:].replace(" ", "x"), "title": f"Lesson {i}",
         "channel": "3Blue1Brown", "duration": 600 + i}
    e.update(kw)
    return e


def make_info(entries, **kw):
    info = {"_type": "playlist", "id": LIST_ID, "title": "Essence of calculus", "channel": "3Blue1Brown",
            "entries": entries}
    info.update(kw)
    return info


class FakeYDL:
    """Stands in for yt_dlp.YoutubeDL; records the options and URL it was given."""
    info = None
    exc = None
    seen = {}

    def __init__(self, opts):
        FakeYDL.seen["opts"] = opts

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def extract_info(self, url, download=True):
        FakeYDL.seen["url"] = url
        FakeYDL.seen["download"] = download
        if FakeYDL.exc:
            raise FakeYDL.exc
        return FakeYDL.info


@pytest.fixture
def ydl(monkeypatch):
    fake = types.ModuleType("yt_dlp")
    fake.YoutubeDL = FakeYDL
    monkeypatch.setitem(sys.modules, "yt_dlp", fake)
    FakeYDL.info, FakeYDL.exc, FakeYDL.seen = None, None, {}
    return FakeYDL


# ---- URL parsing / validation ---------------------------------------------------
@pytest.mark.parametrize("url", [
    PL_URL,
    f"youtube.com/playlist?list={LIST_ID}",
    f"https://m.youtube.com/playlist?list={LIST_ID}&si=abc",
    f"https://www.youtube.com/watch?v=dQw4w9WgXcQ&list={LIST_ID}&index=3",
    f"https://youtu.be/dQw4w9WgXcQ?list={LIST_ID}",
    f"https://music.youtube.com/playlist?list={LIST_ID}",
    f"https://www.youtube.com/embed/videoseries?list={LIST_ID}",
    f"  {PL_URL}  ",
])
def test_parse_playlist_id_accepts(url):
    assert parse_playlist_id(url) == LIST_ID


@pytest.mark.parametrize("url", [
    "", "   ", None, 123, "not a url",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",                 # video only
    "https://www.youtube.com/playlist",                              # no list
    "https://www.youtube.com/playlist?list=",
    "https://www.youtube.com/playlist?list=short",                   # < 10 chars
    "https://www.youtube.com/playlist?list=" + "A" * 65,             # > 64 chars
    "https://www.youtube.com/playlist?list=PL12345678901;rm -rf",    # bad chars
    "https://www.youtube.com/playlist?list=PL1234567890%0A",
    f"https://www.youtube.com/playlist?list={LIST_ID}&list=PL0123456789",  # ambiguous
    f"https://www.youtube.com/channel/UCabc?list={LIST_ID}",         # wrong path
    f"https://evil.example.com/playlist?list={LIST_ID}",
    f"https://youtube.com.evil.example.com/playlist?list={LIST_ID}",
    f"https://evil.example.com/?u=https://www.youtube.com/playlist?list={LIST_ID}",
    f"ftp://www.youtube.com/playlist?list={LIST_ID}",
    f"https://user:pw@www.youtube.com/playlist?list={LIST_ID}",
    f"https://www.youtube.com:8080/playlist?list={LIST_ID}",
    f"https://youtu.be/short?list={LIST_ID}",
    "x" * 3000,
])
def test_parse_playlist_id_rejects(url):
    with pytest.raises(IngestError):
        parse_playlist_id(url)


def test_other_host_message_and_special_lists():
    with pytest.raises(IngestError, match="Only YouTube links"):
        parse_playlist_id(f"https://evil.example.com/playlist?list={LIST_ID}")
    with pytest.raises(IngestError, match="private"):
        parse_playlist_id("https://www.youtube.com/playlist?list=WL")      # Watch later
    with pytest.raises(IngestError, match="Mix"):
        parse_playlist_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ")


def test_invalid_url_never_reaches_yt_dlp(ydl):
    with pytest.raises(IngestError):
        get_playlist("https://evil.example.com/playlist?list=" + LIST_ID)
    assert ydl.seen == {}


# ---- get_playlist: response shape ------------------------------------------------
def test_get_playlist_shape_and_options(ydl):
    ydl.info = make_info([entry(1), entry(2, channel=None, uploader="Grant", duration=None)])
    r = get_playlist(f"https://www.youtube.com/watch?v=dQw4w9WgXcQ&list={LIST_ID}")
    assert r["id"] == LIST_ID and r["title"] == "Essence of calculus" and r["channel"] == "3Blue1Brown"
    assert r["count"] == 2 and r["truncated"] is False and r["skipped"] == 0
    assert set(r["videos"][0]) == {"id", "title", "channel", "duration_sec"}
    assert r["videos"][0]["duration_sec"] == 601
    assert r["videos"][1]["channel"] == "Grant" and r["videos"][1]["duration_sec"] is None
    json.dumps(r)
    # only the canonical playlist URL is fetched, flat, without downloading
    assert ydl.seen["url"] == PL_URL
    assert ydl.seen["download"] is False
    o = ydl.seen["opts"]
    assert o["extract_flat"] == "in_playlist" and o["quiet"] is True and o["skip_download"] is True
    assert o["socket_timeout"] > 0 and o["playlistend"] >= 200


def test_skips_private_deleted_invalid_and_duplicates(ydl):
    ydl.info = make_info([
        entry(1),
        entry(2, title="[Private video]"),
        entry(3, title="[Deleted video]"),
        entry(4, id="bad id"),
        {"id": None, "title": "x"},
        "garbage",
        entry(5, availability="private"),
        entry(1),                                  # duplicate id
        entry(6, title="  Two\n lines\x00 "),
    ])
    r = get_playlist(PL_URL)
    assert [v["title"] for v in r["videos"]] == ["Lesson 1", "Two lines"]
    assert r["count"] == 2 and r["skipped"] == 6
    assert "\n" not in r["videos"][1]["title"] and "\x00" not in r["videos"][1]["title"]


def test_truncation_at_limit(ydl):
    ydl.info = make_info([entry(i) for i in range(1, 8)])
    r = get_playlist(PL_URL, limit=5)
    assert r["count"] == 5 and len(r["videos"]) == 5 and r["truncated"] is True
    assert r["videos"][-1]["title"] == "Lesson 5"
    r = get_playlist(PL_URL, limit=7)
    assert r["count"] == 7 and r["truncated"] is False


def test_truncation_when_fetch_cap_reached(ydl):
    # yt-dlp stops at playlistend: a full raw page means there may be more
    n = 5 + ingest._PLAYLIST_SLACK
    ydl.info = make_info([entry(i) for i in range(1, n + 1)])
    r = get_playlist(PL_URL, limit=5)
    assert r["count"] == 5 and r["truncated"] is True
    assert ydl.seen["opts"]["playlistend"] == n


def test_default_limit_is_200(ydl):
    ydl.info = make_info([entry(i) for i in range(1, 230)])
    r = get_playlist(PL_URL)
    assert r["count"] == 200 and r["truncated"] is True


def test_empty_playlist_and_fallbacks(ydl):
    ydl.info = make_info([], title="", channel=None)
    r = get_playlist(PL_URL)
    assert r["count"] == 0 and r["videos"] == [] and r["title"] == "YouTube playlist" and r["truncated"] is False
    ydl.info = make_info([entry(1)], channel=None)
    assert get_playlist(PL_URL)["channel"] == "3Blue1Brown"          # from the first video


def test_missing_video_channel_falls_back_to_playlist_owner(ydl):
    ydl.info = make_info([entry(1, channel=None), entry(2, channel="Guest")])
    r = get_playlist(PL_URL)
    assert [v["channel"] for v in r["videos"]] == ["3Blue1Brown", "Guest"]


def test_long_text_is_capped(ydl):
    ydl.info = make_info([entry(1, title="T" * 900)], title="P" * 900)
    r = get_playlist(PL_URL)
    assert len(r["title"]) <= 150 and len(r["videos"][0]["title"]) <= 200


# ---- get_playlist: errors ---------------------------------------------------------
@pytest.mark.parametrize("raw, needle, status", [
    ("ERROR: [youtube:tab] PL...: The playlist does not exist.", "couldn't find", 404),
    ("ERROR: This playlist is private", "private", 403),
    ("Sign in to confirm your age. This playlist is private.", "private", 403),
    ("ERROR: unable to download: HTTP Error 429: Too Many Requests", "rate-limiting", 503),
    ("Sign in to confirm you're not a bot", "rate-limiting", 503),
    ("something weird with a key=SECRET123 token", "try again", 502),
])
def test_error_mapping(ydl, raw, needle, status):
    ydl.exc = RuntimeError(raw)
    with pytest.raises(IngestError) as ei:
        get_playlist(PL_URL)
    assert needle in str(ei.value).lower()
    assert ei.value.status == status
    assert "SECRET123" not in str(ei.value) and "ERROR:" not in str(ei.value)   # never echo raw library text


def test_non_dict_or_missing_entries_is_not_found(ydl):
    ydl.info = None
    with pytest.raises(IngestError, match="couldn't find"):
        get_playlist(PL_URL)
    ydl.info = {"title": "x"}
    with pytest.raises(IngestError, match="couldn't find"):
        get_playlist(PL_URL)


# ---- endpoint -----------------------------------------------------------------------
@pytest.fixture
def client(tmp_path):
    def factory(**cfg):
        config = {"OUTPUT_DIR": tmp_path / "out", "LOAD_DOTENV": False, "RATE_LIMIT": (100, 60)}
        config.update(cfg)
        return srv.create_app(config).test_client()
    return factory


def test_endpoint_ok(client, ydl):
    ydl.info = make_info([entry(1), entry(2)])
    c = client()
    r = c.get("/api/playlist", query_string={"url": PL_URL})
    assert r.status_code == 200 and r.mimetype == "application/json"
    d = r.get_json()
    assert d["id"] == LIST_ID and d["count"] == 2 and len(d["videos"]) == 2
    assert set(d) >= {"id", "title", "channel", "count", "videos", "truncated"}
    assert r.headers["Cache-Control"] == "no-store"
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert len(r.data) < 100_000


def test_endpoint_size_is_sane_at_cap(client, ydl):
    ydl.info = make_info([entry(i, title="T" * 300) for i in range(1, 400)])
    r = client().get("/api/playlist", query_string={"url": PL_URL})
    assert r.status_code == 200 and r.get_json()["count"] == 200 and len(r.data) < 100_000


@pytest.mark.parametrize("params", [
    {}, {"url": ""}, {"url": "   "}, {"url": "nope"},
    {"url": "https://evil.example.com/playlist?list=" + LIST_ID},
    {"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
    {"url": "https://www.youtube.com/playlist?list=short"},
    {"url": "x" * 3000},
])
def test_endpoint_bad_input(client, ydl, params):
    r = client().get("/api/playlist", query_string=params)
    assert r.status_code == 400 and r.get_json()["error"]
    assert ydl.seen == {}                      # never reached yt-dlp


def test_endpoint_error_statuses_and_messages(client, ydl):
    c = client()
    ydl.exc = RuntimeError("The playlist does not exist.")
    r = c.get("/api/playlist", query_string={"url": PL_URL})
    assert r.status_code == 404 and "couldn't find" in r.get_json()["error"].lower()
    ydl.exc = RuntimeError("This playlist is private")
    assert c.get("/api/playlist", query_string={"url": PL_URL}).status_code == 403
    ydl.exc = RuntimeError("HTTP Error 429")
    assert c.get("/api/playlist", query_string={"url": PL_URL}).status_code == 503


def test_endpoint_unexpected_exception_is_generic_and_redacted(client, monkeypatch, caplog):
    secret = "sk-test-SECRET-1234567890"

    def boom(url, limit=200):
        raise ValueError(f"https://x.example/?key={secret} Bearer {secret}")

    monkeypatch.setattr(ingest, "get_playlist", boom)
    with caplog.at_level("DEBUG", logger="lna"):
        r = client().get("/api/playlist", query_string={"url": PL_URL})
    assert r.status_code == 502
    assert secret not in r.get_data(as_text=True) and secret not in caplog.text


def test_endpoint_rate_limit_is_its_own_bucket(client, ydl):
    ydl.info = make_info([entry(1)])
    c = client(RATE_LIMIT=(2, 60))
    q = {"url": PL_URL}
    assert c.get("/api/playlist", query_string=q).status_code == 200
    assert c.get("/api/playlist", query_string=q).status_code == 200
    assert c.get("/api/playlist", query_string=q).status_code == 429
    # note jobs have their own budget: playlist lookups did not use it
    app_state = c.application.extensions["lna"]
    assert len(app_state.recent) == 0


def test_endpoint_invalid_urls_do_not_use_rate_limit(client, ydl):
    ydl.info = make_info([entry(1)])
    c = client(RATE_LIMIT=(1, 60))
    for _ in range(5):
        assert c.get("/api/playlist", query_string={"url": "nope"}).status_code == 400
    assert c.get("/api/playlist", query_string={"url": PL_URL}).status_code == 200


def test_endpoint_busy_when_slots_taken(client, ydl):
    c = client()
    state = c.application.extensions["lna"]
    assert state.playlist_slots.acquire(blocking=False) and state.playlist_slots.acquire(blocking=False)
    try:
        r = c.get("/api/playlist", query_string={"url": PL_URL})
        assert r.status_code == 429
    finally:
        state.playlist_slots.release()
        state.playlist_slots.release()


def test_endpoint_host_origin_cors(client, ydl):
    ydl.info = make_info([entry(1)])
    c = client()
    q = {"url": PL_URL}
    assert c.get("/api/playlist", query_string=q, headers={"Host": "evil.com"}).status_code == 403
    assert c.get("/api/playlist", query_string=q, headers={"Host": "127.0.0.1:5055"}).status_code == 200
    assert c.get("/api/playlist", query_string=q, headers={"Origin": "https://evil.com"}).status_code == 403
    ok = c.get("/api/playlist", query_string=q, headers={"Origin": "http://127.0.0.1:5173"})
    assert ok.status_code == 200
    assert ok.headers.get("Access-Control-Allow-Origin") == "http://127.0.0.1:5173"
    assert c.post("/api/playlist", json={}).status_code == 405


def test_endpoint_missing_ingest_module(client, monkeypatch):
    c = client()
    state = c.application.extensions["lna"]

    def boom():
        raise ImportError("x", name="notes_engine.ingest")

    monkeypatch.setattr(state, "load_ingest", boom)
    assert c.get("/api/playlist", query_string={"url": PL_URL}).status_code == 503
