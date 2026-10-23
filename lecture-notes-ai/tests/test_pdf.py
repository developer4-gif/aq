"""Tests for app/pdf.py (HTML + PDF rendering of the notes document)."""
import copy
import json
import re
import sys
from pathlib import Path

import pytest

from notes_engine import pdf  # noqa: E402

SAMPLE = Path(__file__).with_name("sample_notes.json")


@pytest.fixture(scope="module")
def notes():
    return json.loads(SAMPLE.read_text(encoding="utf-8"))


def _have_browser() -> bool:
    try:
        pdf._find_browser()
        return True
    except pdf.PdfError:
        return False


needs_browser = pytest.mark.skipif(not _have_browser(), reason="Edge/Chrome not installed")

try:
    import pymupdf  # noqa: F401
except Exception:  # pragma: no cover
    pymupdf = None


# ---------------------------------------------------------------- HTML
def test_html_escapes_everything(notes):
    n = copy.deepcopy(notes)
    n["meta"]["title"] = "A & B <img src=x onerror=alert(1)> “q”"
    n["sections"][0]["subtitle"] = "<b>sub</b>"
    n["sections"][0]["blocks"].append({"type": "code", "language": "<x>", "code": "if a < b && c > d: print('</script>')"})
    n["sections"][0]["blocks"].append({"type": "table", "headers": ["<h>"], "rows": [["<td onclick=1>"]]})
    n["glossary"].append({"term": "<i>t</i>", "definition": "<script>bad()</script>"})
    html = pdf.render_html(n)
    assert "<script>alert" not in html
    assert "<img src=x" not in html
    assert "<td onclick" not in html
    assert "<script>bad()" not in html
    assert "<i>t</i>" not in html
    assert "&lt;script&gt;alert(&#x27;x&#x27;)&lt;/script&gt;" in html  # from the sample paragraph
    assert "A &amp; B &lt;img" in html
    # the only <script> elements are our own: inlined Rough.js + the pagination script
    assert html.count("<script>") == 2 and html.count("</script>") == 2
    # non-ASCII survives
    assert "Café" in html and "नमस्ते" in html


def test_markup_whitelist_only_bold_and_code():
    n = {"meta": {"title": "t"}, "sections": [{"number": 2, "title": "s", "blocks": [
        {"type": "paragraph", "text": "**bold** and `<code>` and <b>raw</b>"}]}]}
    html = pdf.render_html(n)
    assert "<b>bold</b>" in html
    assert "<code>&lt;code&gt;</code>" in html
    assert "&lt;b&gt;raw&lt;/b&gt;" in html


def test_html_deterministic(notes):
    a = pdf.render_html(notes)
    b = pdf.render_html(copy.deepcopy(notes))
    assert a == b
    assert len(a) > 50_000


def test_html_has_fonts_embedded_offline(notes):
    html = pdf.render_html(notes)
    assert html.count("@font-face") >= 6
    assert "data:font/ttf;base64," in html
    assert "http://" not in html.replace("http://www.w3.org/2000/svg", "")
    assert "https://" not in html


TYPES = ["flow", "stack", "compare", "cycle", "tree", "timeline", "mindmap", "sequence"]


@pytest.mark.parametrize("typ", TYPES)
def test_every_diagram_type_renders_deterministically(typ):
    nodes = [{"id": "n%d" % i, "label": "Node number %d with a rather long label" % i, "detail": "some detail text %d" % i} for i in range(8)]
    edges = [{"from": "n%d" % i, "to": "n%d" % (i + 1), "label": "lbl"} for i in range(7)]
    if typ == "mindmap":
        nodes = [{**n, "parent": "n0" if 0 < i < 4 else ("n%d" % (1 + i % 3) if i else "")} for i, n in enumerate(nodes)]
        edges = []
    d = {"type": typ, "title": "T", "caption": "C", "nodes": nodes, "edges": edges}
    r1 = pdf.build_diagram_svg(d)
    r2 = pdf.build_diagram_svg(copy.deepcopy(d))
    assert r1 is not None and r1 == r2
    svg, w, h = r1
    assert svg.startswith("<svg") and h > 40 and w >= 690
    # three layers: plain-svg fallback strokes, Rough.js shape specs (fixed seeds), real text
    assert '<g class="py">' in svg and '<g class="rg">' in svg and '<g class="tx">' in svg
    specs = [json.loads(m) for m in re.findall(r"data-s='([^']*)'", svg)]
    assert specs and all("seed" in sp["o"] and sp["k"] in "relpe" for sp in specs)
    assert "<text" in svg.split('<g class="tx">')[1]


def test_mindmap_tree_is_always_valid():
    nodes = [{"id": c, "label": c} for c in "abcdefg"]
    # cycle, missing parent, deep chain, self parent
    for parents in (["", "a", "b", "c", "d", "e", "f"], ["b", "a", "zz", "c", "d", "e", "e"], ["a"] * 7):
        d = {"type": "mindmap", "title": "", "nodes": [{**n, "parent": p} for n, p in zip(nodes, parents)], "edges": []}
        dg = pdf._clean_diagram(d)
        root, par, depth = pdf._mindmap_tree(dg)
        assert len(par) == 6 and root not in par and max(depth.values()) <= 2
        assert pdf.build_diagram_svg(d) is not None


def test_sequence_keeps_repeated_and_self_messages():
    d = {"type": "sequence", "title": "t", "nodes": [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}],
         "edges": [{"from": "a", "to": "b", "label": "1"}, {"from": "a", "to": "b", "label": "2"}, {"from": "b", "to": "b", "label": "self"},
                   {"from": "b", "to": "a", "label": "back"}]}
    dg = pdf._clean_diagram(d)
    assert [e["label"] for e in dg["edges"]] == ["1", "2", "self", "back"]
    assert pdf._clean_diagram({**d, "nodes": d["nodes"][:1]})["type"] == "flow"


def test_rough_is_inlined_and_runs_before_pagination(notes):
    html = pdf.render_html(notes)
    assert "var rough=" in html and html.index("var rough=") < html.index("Lecture Notes AI - measured pagination")
    assert "roughify(srcEl)" in html
    assert html.count("class=\"rj\"") > 100


def test_without_rough_file_the_plain_svg_strokes_remain(notes, monkeypatch):
    monkeypatch.setattr(pdf, "_rough_js", lambda: "")
    html = pdf.render_html(notes)
    assert html.count("<script>") == 1 and "var rough=" not in html
    assert '<g class="py">' in html  # fallback strokes are still there


@needs_browser
def test_pdf_diagrams_are_drawn_by_rough(tmp_path, notes):
    n = {"meta": {"title": "t"}, "sections": [{"number": 2, "title": "s", "blocks": [], "diagram": notes["sections"][1]["diagram"]}]}
    hp = tmp_path / "d.html"
    hp.write_text(pdf.render_html(n, for_print=True), encoding="utf-8")
    exe = pdf._find_browser()
    import subprocess
    out = subprocess.run([exe, "--headless=new", "--disable-gpu", "--no-first-run", "--user-data-dir=" + str(tmp_path / "prof"),
                          "--virtual-time-budget=8000", "--dump-dom", hp.as_uri()], capture_output=True, timeout=120).stdout.decode("utf-8", "replace")
    m = re.search(r'data-rough="(\d+)"', out)
    assert m and int(m.group(1)) >= 1 and 'data-paginated="1"' in out
    assert "rough-on" in out and 'class="rough"' in out


def test_diagram_handles_garbage():
    assert pdf.build_diagram_svg(None) is None
    assert pdf.build_diagram_svg({"nodes": []}) is None
    d = {"type": "weird", "nodes": [{"id": "a", "label": "x"}, {"id": "a", "label": "y"}, "z", 5],
         "edges": [{"from": "a", "to": "zzz"}, {"from": "a", "to": "a"}, "bad"]}
    assert pdf.build_diagram_svg(d) is not None
    # cyclic tree / flow with back-edges must not recurse forever
    cyc = {"type": "tree", "nodes": [{"id": "a", "label": "a"}, {"id": "b", "label": "b"}],
           "edges": [{"from": "a", "to": "b"}, {"from": "b", "to": "a"}]}
    assert pdf.build_diagram_svg(cyc) is not None
    cyc["type"] = "flow"
    assert pdf.build_diagram_svg(cyc) is not None


@pytest.mark.parametrize("notes_in", [
    {},
    {"meta": {"title": "Only a title"}},
    {"meta": None, "cover": 5, "sections": None, "glossary": "x", "recap": []},
    {"sections": [None, 5, "x", {}, {"blocks": [1, None, {"type": "zzz"}, {"type": "table"}, {"type": "code"}, {"type": "bullets", "items": "abc"}]}]},
    {"meta": {"title": "x" * 400}, "sections": [{"title": "y" * 300, "number": "3a", "blocks": [{"type": "paragraph", "text": "w" * 5000}]}]},
])
def test_minimal_and_garbage_notes_do_not_crash_html(notes_in):
    html = pdf.render_html(notes_in)
    assert html.startswith("<!DOCTYPE html>")
    assert 'class="page cover"' in html


# ---------------------------------------------------------------- PDF
def _check_pdf(path):
    doc = pymupdf.open(path)
    n = len(doc)
    pages = []
    for i, pg in enumerate(doc):
        txt = pg.get_text()
        m = re.findall(r"pg\.\s*(\d+)\s*/\s*(\d+)", txt)
        pages.append((txt, m, pg))
    return doc, n, pages


@pytest.fixture(scope="module")
def sample_pdf(tmp_path_factory, notes):
    if not _have_browser() or pymupdf is None:
        pytest.skip("no browser / pymupdf")
    out = tmp_path_factory.mktemp("pdf") / "sample.pdf"
    assert pdf.render_pdf(notes, str(out)) == str(out)
    return out


@needs_browser
def test_pdf_multi_page_and_numbering(sample_pdf):
    doc, n, pages = _check_pdf(str(sample_pdf))
    assert n > 8
    for i, (txt, m, pg) in enumerate(pages, 1):
        assert m, "page %d has no 'pg. N / M'" % i
        assert (int(m[-1][0]), int(m[-1][1])) == (i, n)
        assert abs(pg.rect.width - 595) < 2 and abs(pg.rect.height - 842) < 2  # A4
    doc.close()


@needs_browser
def test_pdf_overflowing_section_continues_without_clipping(sample_pdf):
    doc, n, pages = _check_pdf(str(sample_pdf))
    cont = [i for i, (t, _, _) in enumerate(pages, 1) if "continued" in t]
    assert len(cont) >= 2
    assert any("training & the loss loop" in pages[i - 1][0] for i in cont)
    full = "\n".join(t for t, _, _ in pages)
    # first and last pieces of the long section are present (nothing lost to clipping)
    assert "Language models are trained" in full
    assert "Fine-tuning adapts a pre-trained model" in full
    assert "optimizer.zero_grad(set_to_none=True)" in full
    assert "serving" in full and "latency" in full
    for i, (t, m, pg) in enumerate(pages, 1):
        for x0, y0, x1, y1, word, *_ in pg.get_text("words"):
            assert y1 <= pg.rect.height + 0.5 and x1 <= pg.rect.width + 0.5
        # below the content area (1046px = 784pt) only footer / "next ->" lines may exist
        for blk in pg.get_text("dict")["blocks"]:
            for line in blk.get("lines", []):
                if line["bbox"][1] > 786:
                    ltxt = "".join(sp["text"] for sp in line["spans"])
                    assert re.search(r"notebook|pg\.|next|field notes", ltxt), (i, ltxt)
    doc.close()


@needs_browser
def test_pdf_fonts_and_content(sample_pdf):
    doc = pymupdf.open(str(sample_pdf))
    fonts = {f[3] for p in range(len(doc)) for f in doc.get_page_fonts(p)}
    joined = " ".join(fonts)
    for name in ("Kalam", "PatrickHand", "Caveat", "JetBrainsMono"):
        assert name in joined, name
    full = "\n".join(p.get_text() for p in doc)
    assert "recall question" in full and "next" in full and "glossary" in full
    assert "Transformers & Attention" in full
    assert "<script>alert('x')</script>" in full  # shown literally
    doc.close()


@needs_browser
def test_pdf_deterministic_text(sample_pdf, notes, tmp_path):
    out2 = tmp_path / "again.pdf"
    pdf.render_pdf(notes, str(out2))
    a, b = pymupdf.open(str(sample_pdf)), pymupdf.open(str(out2))
    assert len(a) == len(b)
    for pa, pb in zip(a, b):
        assert pa.get_text("words") == pb.get_text("words")
    a.close()
    b.close()


@needs_browser
@pytest.mark.parametrize("notes_in", [
    {},
    {"meta": {"title": "Tiny & <small>"}, "sections": [{"number": 2, "title": "one", "blocks": [{"type": "paragraph", "text": "hi"}]}]},
])
def test_pdf_minimal_notes(tmp_path, notes_in):
    out = tmp_path / "min.pdf"
    pdf.render_pdf(notes_in, str(out))
    doc, n, pages = _check_pdf(str(out))
    assert n >= 1
    assert pages[-1][1][-1] == (str(n), str(n))
    doc.close()
