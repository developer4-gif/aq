"""Tests for notes_engine.ingest. Network is mocked except the optional live test.

Run:   python -m pytest tests/test_ingest.py -q
Live:  LNA_LIVE=1 python -m pytest tests/test_ingest.py -q -k live
"""
import os
import sys
from types import SimpleNamespace
from unittest import mock

import pytest

from notes_engine import ingest  # noqa: E402
from notes_engine.ingest import IngestError, chunk_transcript, parse_video_id  # noqa: E402

VID = "dQw4w9WgXcQ"


# --------------------------------------------------------------------------- #
# parse_video_id
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "url",
    [
        f"https://www.youtube.com/watch?v={VID}",
        f"http://youtube.com/watch?v={VID}&t=42s&list=PL123",
        f"https://www.youtube.com/watch?feature=share&v={VID}",
        f"https://m.youtube.com/watch?v={VID}",
        f"https://music.youtube.com/watch?v={VID}",
        f"https://youtu.be/{VID}",
        f"https://youtu.be/{VID}?t=10",
        f"youtu.be/{VID}",
        f"www.youtube.com/watch?v={VID}",
        f"https://www.youtube.com/shorts/{VID}",
        f"https://www.youtube.com/embed/{VID}",
        f"https://www.youtube-nocookie.com/embed/{VID}",
        f"https://www.youtube.com/live/{VID}?feature=share",
        f"https://www.youtube.com/v/{VID}",
        f"  https://www.youtube.com/watch?v={VID}  ",
        f"HTTPS://WWW.YOUTUBE.COM/watch?v={VID}",
        VID,
    ],
)
def test_parse_ok(url):
    assert parse_video_id(url) == VID


def test_parse_id_with_dash_underscore():
    assert parse_video_id("https://youtu.be/a-b_c-d_e-f") == "a-b_c-d_e-f"


@pytest.mark.parametrize(
    "url",
    [
        "",
        "   ",
        "not a url",
        None,
        123,
        "https://www.youtube.com/",
        "https://www.youtube.com/watch",
        "https://www.youtube.com/watch?v=short",
        f"https://www.youtube.com/watch?v={VID}extra",
        "https://www.youtube.com/watch?v=" + "a" * 11 + "'; DROP",
        "https://www.youtube.com/playlist?list=PL1234567890A",
        "https://www.youtube.com/channel/UC1234567890",
        f"https://evil.com/watch?v={VID}",
        f"https://youtube.com.evil.com/watch?v={VID}",
        f"https://evilyoutube.com/watch?v={VID}",
        f"https://notyoutu.be/{VID}",
        f"https://youtube.com@evil.com/watch?v={VID}",
        f"https://evil.com/?u=https://www.youtube.com/watch?v={VID}",
        f"https://evil.com#@www.youtube.com/watch?v={VID}",
        f"ftp://www.youtube.com/watch?v={VID}",
        f"file:///etc/passwd?v={VID}",
        f"http://127.0.0.1/watch?v={VID}",
        f"http://localhost:5055/watch?v={VID}",
        f"http://169.254.169.254/latest/meta-data/{VID}",
        f"https://www.youtube.com:8080/watch?v={VID}",
        f"https://user:pw@www.youtube.com/watch?v={VID}",
        f"https://www.youtube.com/watch?v={VID}\nHost: evil.com",
        "javascript:alert(1)",
    ],
)
def test_parse_rejects(url):
    with pytest.raises(IngestError):
        parse_video_id(url)


def test_parse_non_youtube_message_is_friendly():
    with pytest.raises(IngestError) as ei:
        parse_video_id("https://vimeo.com/12345678901")
    assert "YouTube" in str(ei.value)


# --------------------------------------------------------------------------- #
# cleaning
# --------------------------------------------------------------------------- #


def test_clean_text_strips_sound_cues_and_entities():
    assert ingest.clean_text("[Music] hello &amp; welcome [Applause]") == "hello & welcome"
    assert ingest.clean_text("it&#39;s  fine\nreally") == "it's fine really"
    assert ingest.clean_text("(music) now (Laughter) go") == "now go"
    assert ingest.clean_text("&amp;#39;quoted&amp;#39;") == "'quoted'"
    assert ingest.clean_text("<c>tag</c><00:00:01.000> ed") == "tag ed"
    assert ingest.clean_text(">> speaker said") == "speaker said"
    assert ingest.clean_text("♪ la la la ♪ text") == "text"
    assert ingest.clean_text("a [ __ ] b") == "a b"


def test_clean_text_keeps_real_brackets():
    assert ingest.clean_text("the set [1, 2, 3] has size three") == "the set [1, 2, 3] has size three"
    assert ingest.clean_text("array[i] = 5") == "array[i] = 5"


def test_dedupe_rolling_vtt_style_lines():
    cues = [
        (0.0, 2.0, ["so today we are going to"]),
        (2.0, 0.01, ["so today we are going to"]),
        (2.01, 2.0, ["so today we are going to", "talk about graphs"]),
        (4.0, 0.01, ["talk about graphs"]),
        (4.01, 2.0, ["talk about graphs", "and trees"]),
    ]
    out = ingest._dedupe_cues(cues)
    assert " ".join(t for _, _, t in out) == "so today we are going to talk about graphs and trees"


def test_dedupe_word_overlap_prefix_growth():
    cues = [
        (0.0, 1.0, ["we will now look at"]),
        (1.0, 1.0, ["we will now look at binary search trees"]),
        (2.0, 1.0, ["binary search trees and their uses"]),
    ]
    out = ingest._dedupe_cues(cues)
    assert " ".join(t for _, _, t in out) == "we will now look at binary search trees and their uses"


def test_dedupe_keeps_legit_repetition():
    cues = [(0.0, 1.0, ["very very"]), (1.0, 1.0, ["very good"])]
    out = ingest._dedupe_cues(cues)
    assert " ".join(t for _, _, t in out) == "very very very good"


def test_dedupe_drops_cues_that_are_only_noise():
    cues = [(0.0, 1.0, ["[Music]"]), (1.0, 1.0, ["hello there"]), (2.0, 1.0, ["[Applause]"])]
    out = ingest._dedupe_cues(cues)
    assert [t for _, _, t in out] == ["hello there"]


def test_merge_fragments_into_segments():
    cues = [(float(i), 1.0, f"word{i}") for i in range(40)]
    segs = ingest._merge_cues(cues)
    assert segs == sorted(segs, key=lambda s: s["start"])
    assert 2 <= len(segs) <= 5  # ~15 s each without punctuation
    assert all(set(s) == {"start", "text"} for s in segs)
    assert " ".join(s["text"] for s in segs) == " ".join(f"word{i}" for i in range(40))


def test_merge_breaks_on_sentence_end_after_5s():
    cues = [(0.0, 2.0, "First sentence here."), (3.0, 2.0, "more"), (6.0, 2.0, "next one starts.")]
    # 'more' joins the first segment (3 s < 5 s); at 6 s the segment ends in "more" (no
    # sentence end) so it keeps growing until the 15 s cap.
    assert [s["start"] for s in ingest._merge_cues(cues)] == [0.0]
    cues = [(0.0, 2.0, "First sentence here."), (6.0, 2.0, "next one starts.")]
    segs = ingest._merge_cues(cues)
    assert [s["start"] for s in segs] == [0.0, 6.0]


def test_parse_json3():
    data = {
        "events": [
            {"tStartMs": 0, "dDurationMs": 1000, "segs": [{"utf8": "hello "}, {"utf8": "world"}]},
            {"tStartMs": 1000, "dDurationMs": 10, "segs": [{"utf8": "\n"}]},
            {"tStartMs": 2000, "dDurationMs": 1000},
            {"tStartMs": 3000, "dDurationMs": 1000, "segs": [{"utf8": "bye"}]},
        ]
    }
    cues = ingest._parse_json3(data)
    assert [(c[0], c[2]) for c in cues] == [(0.0, ["hello world"]), (3.0, ["bye"])]


def test_parse_vtt():
    vtt = (
        "WEBVTT\nKind: captions\nLanguage: en\n\n"
        "00:00:01.000 --> 00:00:03.000 align:start position:0%\nhello<00:00:01.500><c> there</c>\n\n"
        "00:03.000 --> 00:05.500\nsecond line\n\n"
    )
    cues = ingest._parse_vtt(vtt)
    assert cues[0][0] == 1.0 and cues[0][2] == ["hello<00:00:01.500><c> there</c>"]
    assert cues[1][0] == 3.0 and cues[1][1] == 2.5
    segs = ingest._build_segments(cues)
    assert segs[0]["text"] == "hello there second line"


# --------------------------------------------------------------------------- #
# chunk_transcript
# --------------------------------------------------------------------------- #


def _transcript(n=400, step=10.0, words=14):
    segs = [
        {"start": i * step, "text": " ".join(f"w{i}x{j}" for j in range(words)) + "."}
        for i in range(n)
    ]
    return {"segments": segs, "duration_sec": int(n * step)}


def test_chunk_basic_markers_and_limits():
    t = _transcript()
    chunks = chunk_transcript(t, max_chars=3000, overlap_chars=300)
    assert len(chunks) > 3
    for i, c in enumerate(chunks):
        assert c["index"] == i
        assert len(c["text"]) <= 3000
        assert c["text"].startswith("[")
        assert c["start"] < c["end"]
    # every segment is present in at least one chunk
    joined = " ".join(c["text"] for c in chunks)
    for s in t["segments"]:
        assert s["text"].split()[0] in joined
    assert [c["start"] for c in chunks] == sorted(c["start"] for c in chunks)


def test_chunk_markers_every_30s_and_format():
    t = _transcript(n=30, step=10.0)
    c = chunk_transcript(t, max_chars=100000)[0]
    markers = ingest.re.findall(r"\[(\d+:\d{2}(?::\d{2})?)\]", c["text"])
    assert markers[:4] == ["00:00", "00:30", "01:00", "01:30"]
    assert len(markers) == 10  # one per 30 s over 300 s


def test_chunk_hour_marker_format():
    t = {"segments": [{"start": 3599.0, "text": "before"}, {"start": 3725.0, "text": "after"}]}
    c = chunk_transcript(t)[0]
    assert "[59:59] before" in c["text"]
    assert "[1:02:05] after" in c["text"]


def test_chunk_overlap_repeats_tail():
    t = _transcript(n=200)
    chunks = chunk_transcript(t, max_chars=2000, overlap_chars=400)
    assert len(chunks) >= 3
    a, b = chunks[0], chunks[1]
    # last segment's text of chunk 0 must reappear at the start of chunk 1
    assert b["start"] < a["end"]
    assert b["start"] > a["start"]
    tail_word = a["text"].split()[-1]
    assert tail_word in b["text"]


def test_chunk_no_overlap_when_zero():
    t = _transcript(n=100)
    chunks = chunk_transcript(t, max_chars=2000, overlap_chars=0)
    assert chunks[1]["start"] >= chunks[0]["end"] - 1e-9


def test_chunk_small_and_empty():
    assert chunk_transcript({"segments": []}) == []
    one = chunk_transcript({"segments": [{"start": 5, "text": "only one"}], "duration_sec": 60})
    assert len(one) == 1 and one[0]["text"] == "[00:05] only one"
    assert one[0]["end"] == 60.0


def test_chunk_huge_single_segment_is_split():
    t = {"segments": [{"start": 0.0, "text": "word " * 5000}]}
    chunks = chunk_transcript(t, max_chars=1000, overlap_chars=100)
    assert len(chunks) > 5
    assert all(len(c["text"]) <= 1000 for c in chunks)


def test_chunk_terminates_with_overlap_bigger_than_segments():
    t = _transcript(n=50, words=3)
    chunks = chunk_transcript(t, max_chars=300, overlap_chars=10000)
    assert 1 <= len(chunks) < 500


# --------------------------------------------------------------------------- #
# get_transcript fallback ordering (all network mocked)
# --------------------------------------------------------------------------- #

OK_RESULT = ([{"start": 0.0, "text": "hello world"}], "en", "captions", 30.0)


@pytest.fixture
def patched():
    """Patch metadata + all stages; returns call-order list."""
    order = []
    with mock.patch.object(ingest, "_get_metadata", return_value=("T", "C", None)):
        yield order


def _stage(order, name, result=None, fail=None):
    def fn(*a, **k):
        order.append(name)
        if fail:
            raise fail
        return result

    return fn


def test_api_success_skips_other_stages(patched):
    with mock.patch.object(ingest, "_fetch_via_api", _stage(patched, "api", OK_RESULT)), \
         mock.patch.object(ingest, "_fetch_via_ytdlp", _stage(patched, "ytdlp", OK_RESULT)), \
         mock.patch.object(ingest, "_fetch_via_whisper", _stage(patched, "whisper", OK_RESULT)):
        t = ingest.get_transcript(f"https://youtu.be/{VID}", groq_key="k")
    assert patched == ["api"]
    assert t["video_id"] == VID and t["source"] == "captions" and t["title"] == "T"
    assert t["channel"] == "C" and t["duration_sec"] == 30
    assert t["url"] == f"https://www.youtube.com/watch?v={VID}"
    assert t["segments"][0] == {"start": 0.0, "text": "hello world"}


def test_falls_back_api_then_ytdlp(patched):
    with mock.patch.object(ingest, "_fetch_via_api", _stage(patched, "api", fail=ingest._Fail("blocked"))), \
         mock.patch.object(ingest, "_fetch_via_ytdlp", _stage(patched, "ytdlp", OK_RESULT)), \
         mock.patch.object(ingest, "_fetch_via_whisper", _stage(patched, "whisper", OK_RESULT)):
        ingest.get_transcript(f"https://youtu.be/{VID}", groq_key="k")
    assert patched == ["api", "ytdlp"]


def test_falls_back_to_whisper_only_with_key(patched):
    kw = dict(
        _fetch_via_api=_stage(patched, "api", fail=ingest._Fail("nocaps")),
        _fetch_via_ytdlp=_stage(patched, "ytdlp", fail=ingest._Fail("nocaps")),
        _fetch_via_whisper=_stage(patched, "whisper", ([{"start": 0, "text": "x"}], "en", "whisper", 5.0)),
    )
    with mock.patch.multiple(ingest, **kw):
        t = ingest.get_transcript(f"https://youtu.be/{VID}", groq_key="gsk_secret")
    assert patched == ["api", "ytdlp", "whisper"]
    assert t["source"] == "whisper"


def test_no_key_no_captions_friendly_error(patched):
    with mock.patch.object(ingest, "_fetch_via_api", _stage(patched, "api", fail=ingest._Fail("nocaps"))), \
         mock.patch.object(ingest, "_fetch_via_ytdlp", _stage(patched, "ytdlp", fail=ingest._Fail("nocaps"))), \
         mock.patch.object(ingest, "_fetch_via_whisper", _stage(patched, "whisper", OK_RESULT)):
        with pytest.raises(IngestError) as ei:
            ingest.get_transcript(f"https://youtu.be/{VID}")
    assert patched == ["api", "ytdlp"]
    assert "Groq" in str(ei.value) and "captions" in str(ei.value)


def test_unavailable_short_circuits(patched):
    with mock.patch.object(ingest, "_fetch_via_api", _stage(patched, "api", fail=ingest._Fail("unavailable"))), \
         mock.patch.object(ingest, "_fetch_via_ytdlp", _stage(patched, "ytdlp", OK_RESULT)), \
         mock.patch.object(ingest, "_fetch_via_whisper", _stage(patched, "whisper", OK_RESULT)):
        with pytest.raises(IngestError) as ei:
            ingest.get_transcript(f"https://youtu.be/{VID}", groq_key="k")
    assert patched == ["api"]
    assert "private" in str(ei.value).lower()


def test_age_restricted_message(patched):
    with mock.patch.object(ingest, "_fetch_via_api", _stage(patched, "api", fail=ingest._Fail("age"))), \
         mock.patch.object(ingest, "_fetch_via_ytdlp", _stage(patched, "ytdlp", fail=ingest._Fail("age"))):
        with pytest.raises(IngestError) as ei:
            ingest.get_transcript(f"https://youtu.be/{VID}")
    assert "age-restricted" in str(ei.value)


def test_blocked_message(patched):
    with mock.patch.object(ingest, "_fetch_via_api", _stage(patched, "api", fail=ingest._Fail("blocked"))), \
         mock.patch.object(ingest, "_fetch_via_ytdlp", _stage(patched, "ytdlp", fail=ingest._Fail("other"))):
        with pytest.raises(IngestError) as ei:
            ingest.get_transcript(f"https://youtu.be/{VID}")
    assert "rate-limiting" in str(ei.value) or "blocking" in str(ei.value)


def test_whisper_failure_message_has_no_key(patched):
    key = "gsk_SUPERSECRET123"
    with mock.patch.object(ingest, "_fetch_via_api", _stage(patched, "api", fail=ingest._Fail("nocaps"))), \
         mock.patch.object(ingest, "_fetch_via_ytdlp", _stage(patched, "ytdlp", fail=ingest._Fail("nocaps"))), \
         mock.patch.object(ingest, "_fetch_via_whisper",
                           _stage(patched, "whisper", fail=ingest._Fail("other", "the Groq API key was rejected"))):
        with pytest.raises(IngestError) as ei:
            ingest.get_transcript(f"https://youtu.be/{VID}", groq_key=key)
    assert key not in str(ei.value)
    assert "rejected" in str(ei.value)


def test_invalid_url_raises_before_network():
    with mock.patch.object(ingest, "_get_metadata", side_effect=AssertionError("network used")):
        with pytest.raises(IngestError):
            ingest.get_transcript("https://evil.com/watch?v=" + VID)


def test_progress_callback_stage_and_robustness(patched):
    seen = []
    with mock.patch.object(ingest, "_fetch_via_api", _stage(patched, "api", OK_RESULT)):
        ingest.get_transcript(f"https://youtu.be/{VID}", progress=lambda s, p, m: seen.append((s, p, m)))
    assert seen and all(s == "transcript" for s, _, _ in seen)
    pcts = [p for _, p, _ in seen]
    assert pcts == sorted(pcts) and pcts[-1] == 100
    assert all(isinstance(m, str) for _, _, m in seen)

    def boom(*a):
        raise RuntimeError("ui died")

    with mock.patch.object(ingest, "_fetch_via_api", _stage(patched, "api", OK_RESULT)):
        assert ingest.get_transcript(f"https://youtu.be/{VID}", progress=boom)["segments"]


def test_unexpected_exception_does_not_leak(patched):
    with mock.patch.object(ingest, "_fetch_via_api", side_effect=RuntimeError("secret internals")), \
         mock.patch.object(ingest, "_fetch_via_ytdlp", side_effect=KeyError("zzz")):
        with pytest.raises(IngestError) as ei:
            ingest.get_transcript(f"https://youtu.be/{VID}")
    assert "secret internals" not in str(ei.value)


# --------------------------------------------------------------------------- #
# stage internals with fakes
# --------------------------------------------------------------------------- #


def _fake_transcript(lang, generated, snippets):
    fetched = SimpleNamespace(
        language_code=lang,
        is_generated=generated,
        __iter__=None,
    )

    class F(list):
        language_code = lang
        is_generated = generated

    f = F(SimpleNamespace(text=t, start=s, duration=d) for s, d, t in snippets)
    return SimpleNamespace(language_code=lang, is_generated=generated, fetch=lambda: f)


def test_pick_transcript_preference():
    manual_de = _fake_transcript("de", False, [])
    auto_en = _fake_transcript("en", True, [])
    manual_en = _fake_transcript("en", False, [])
    auto_fr = _fake_transcript("fr", True, [])
    pick = ingest._pick_transcript
    assert pick([auto_fr, manual_de, auto_en, manual_en]) is manual_en
    assert pick([auto_fr, manual_de, auto_en]) is auto_en
    assert pick([auto_fr, manual_de]) is manual_de
    assert pick([auto_fr]) is auto_fr
    assert pick([]) is None
    assert pick([_fake_transcript("en-GB", True, []), manual_de]).language_code == "en-GB"


def test_fetch_via_api_uses_instance_api_and_cleans():
    snippets = [
        (0.0, 3.0, "[Music]"),
        (3.0, 4.0, "hello &amp; welcome"),
        (7.0, 5.0, "to the lecture."),
    ]
    tr = _fake_transcript("en", True, snippets)
    fake_api = mock.MagicMock()
    fake_api.list.return_value = [tr]
    with mock.patch("youtube_transcript_api.YouTubeTranscriptApi", return_value=fake_api) as cls:
        segs, lang, source, est = ingest._fetch_via_api(VID)
    cls.assert_called_once()
    fake_api.list.assert_called_once_with(VID)
    assert (lang, source) == ("en", "auto-captions")
    assert segs == [{"start": 3.0, "text": "hello & welcome to the lecture."}]
    assert est == 12.0


def test_classify_api_exceptions():
    import youtube_transcript_api as yta

    def mk(cls):
        return cls.__new__(cls)

    for cls, kind in [
        (yta.AgeRestricted, "age"),
        (yta.IpBlocked, "blocked"),
        (yta.RequestBlocked, "blocked"),
        (yta.VideoUnavailable, "unavailable"),
        (yta.InvalidVideoId, "unavailable"),
        (yta.TranscriptsDisabled, "nocaps"),
        (yta.NoTranscriptFound, "nocaps"),
    ]:
        assert ingest._classify_api_exception(mk(cls)).kind == kind, cls


def test_ytdlp_track_selection_skips_translated_autos():
    info = {
        "language": "en",
        "subtitles": {},
        "automatic_captions": {
            "af": [{"ext": "json3", "url": "u1"}],
            "en-orig": [{"ext": "json3", "url": "u2"}],
            "en": [{"ext": "json3", "url": "u3"}],
            "fr": [{"ext": "json3", "url": "u4"}],
        },
    }
    fmts, lang, source = ingest._pick_ytdlp_track(info)
    assert source == "auto-captions" and lang in ("en-orig", "en")
    info["subtitles"] = {"en": [{"ext": "vtt", "url": "m"}], "de": [{"ext": "vtt", "url": "d"}]}
    fmts, lang, source = ingest._pick_ytdlp_track(info)
    assert (lang, source) == ("en", "captions")
    assert ingest._pick_ytdlp_track({"subtitles": {}, "automatic_captions": {"af": [{"url": "x"}]}}) is None


def test_ytdlp_stage_parses_json3_from_mock_http():
    info = {
        "duration": 120,
        "language": "en",
        "subtitles": {},
        "automatic_captions": {
            "en-orig": [
                {"ext": "vtt", "url": "https://www.youtube.com/api/timedtext?x=1&fmt=vtt"},
                {"ext": "json3", "url": "https://www.youtube.com/api/timedtext?x=1&fmt=json3"},
            ]
        },
    }
    payload = {"events": [{"tStartMs": 0, "dDurationMs": 2000, "segs": [{"utf8": "hi there"}]}]}
    resp = SimpleNamespace(status_code=200, json=lambda: payload, content=b"")
    cache = {}
    with mock.patch.object(ingest, "_ytdlp_info", return_value=info), \
         mock.patch.object(ingest.requests, "get", return_value=resp) as g:
        segs, lang, source, est = ingest._fetch_via_ytdlp(VID, cache)
    assert "json3" in g.call_args[0][0]
    assert segs == [{"start": 0.0, "text": "hi there"}] and source == "auto-captions" and est == 120.0
    assert cache["duration"] == 120


def test_ytdlp_stage_rejects_foreign_subtitle_host():
    info = {"subtitles": {"en": [{"ext": "json3", "url": "http://169.254.169.254/x"}]}, "automatic_captions": {}}
    with mock.patch.object(ingest, "_ytdlp_info", return_value=info), \
         mock.patch.object(ingest.requests, "get", side_effect=AssertionError("must not fetch")):
        with pytest.raises(ingest._Fail):
            ingest._fetch_via_ytdlp(VID, {})


def test_ytdlp_error_kinds():
    k = ingest._ytdlp_error_kind
    assert k("ERROR: [youtube] x: Private video. Sign in if you've been granted access") == "unavailable"
    assert k("Sign in to confirm your age. This video may be inappropriate for some users.") == "age"
    assert k("Sign in to confirm you're not a bot") == "blocked"
    assert k("HTTP Error 429: Too Many Requests") == "blocked"
    assert k("something odd") == "other"


def test_oembed_parsing_and_status():
    ok = SimpleNamespace(status_code=200, json=lambda: {"title": "A &amp; B", "author_name": "Chan"})
    with mock.patch.object(ingest.requests, "get", return_value=ok) as g:
        assert ingest._oembed(VID) == ("A & B", "Chan")
    assert g.call_args[0][0] == "https://www.youtube.com/oembed"
    nf = SimpleNamespace(status_code=404, json=lambda: {})
    with mock.patch.object(ingest.requests, "get", return_value=nf):
        with pytest.raises(ingest._Fail):
            ingest._oembed(VID)


def test_metadata_falls_back_to_ytdlp():
    with mock.patch.object(ingest, "_oembed", side_effect=ingest._Fail("other")), \
         mock.patch.object(ingest, "_ytdlp_info",
                           return_value={"title": "Lec 1", "channel": "MIT", "duration": 3600}):
        assert ingest._get_metadata(VID, {}) == ("Lec 1", "MIT", 3600)
    with mock.patch.object(ingest, "_oembed", side_effect=ingest._Fail("other")), \
         mock.patch.object(ingest, "_ytdlp_info", side_effect=ingest._Fail("other")):
        title, channel, dur = ingest._get_metadata(VID, {})
        assert VID in title and channel and dur is None


def test_groq_chunk_handles_errors_without_leaking_key(tmp_path):
    f = tmp_path / "c.mp3"
    f.write_bytes(b"x")
    key = "gsk_TOPSECRET"
    bad = SimpleNamespace(status_code=401, headers={}, json=lambda: {})
    with mock.patch.object(ingest.requests, "post", return_value=bad):
        with pytest.raises(ingest._Fail) as ei:
            ingest._groq_transcribe_chunk(str(f), key)
    assert key not in str(ei.value) and key not in ei.value.detail
    good = SimpleNamespace(
        status_code=200, headers={},
        json=lambda: {"language": "hindi", "segments": [{"start": 0, "end": 1, "text": "namaste"}]},
    )
    with mock.patch.object(ingest.requests, "post", return_value=good) as p:
        segs, lang = ingest._groq_transcribe_chunk(str(f), key)
    assert lang == "hi" and segs[0]["text"] == "namaste"
    assert p.call_args[0][0] == ingest.GROQ_URL
    assert p.call_args[1]["data"]["model"] == "whisper-large-v3-turbo"


# --------------------------------------------------------------------------- #
# live test (real network; opt-out with LNA_OFFLINE=1)
# --------------------------------------------------------------------------- #

LIVE_VIDEOS = [
    "https://www.youtube.com/watch?v=aircAruvnKk",  # 3Blue1Brown - neural networks (manual captions)
    "https://youtu.be/rfscVS0vtbw",                  # freeCodeCamp - Python course
]


@pytest.mark.skipif(os.environ.get("LNA_OFFLINE") == "1", reason="offline")
@pytest.mark.parametrize("url", LIVE_VIDEOS[:1])
def test_live_real_video(url):
    try:
        t = ingest.get_transcript(url)
    except IngestError as e:
        if "blocking" in str(e) or "rate-limiting" in str(e):
            pytest.skip(f"YouTube blocked this IP: {e}")
        raise
    assert t["video_id"] == parse_video_id(url)
    assert t["title"] and "3Blue1Brown" in t["channel"]
    assert t["source"] in ("captions", "auto-captions")
    assert len(t["segments"]) > 20
    starts = [s["start"] for s in t["segments"]]
    assert starts == sorted(starts)
    assert not any("[Music]" in s["text"] for s in t["segments"])
    chunks = chunk_transcript(t, max_chars=4000)
    assert chunks and chunks[0]["text"].startswith("[00:")
