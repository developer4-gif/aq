"""Notes dict -> hand-drawn "field notebook" HTML -> A4 PDF (headless Edge / Chrome).

Public API:
    render_html(notes: dict) -> str
    render_pdf(notes: dict, out_path: str) -> str
    class PdfError(Exception)

Design notes
- All text coming from the notes is escaped with html.escape (only a tiny whitelist of markup
  -- **bold** and `code` -- is re-introduced *after* escaping).
- Diagrams (flow, stack, compare, cycle, tree, timeline, mindmap, sequence): layout is computed here in
  Python (deterministic; text measured with the bundled fonts via PyMuPDF so nothing overflows). Each
  SVG carries plain Python strokes (fallback), shape specs with fixed seeds that templates/notebook.js
  hands to the inlined Rough.js (templates/vendor/rough.js) BEFORE pagination, and real <text>.
- Pagination is measured in the browser (templates/notebook.js): items are poured into fixed A4
  page boxes; lists / tables / code / long paragraphs are split across pages, headers are kept with
  their first block, every page gets rings, footer and "pg. N / M" (M known after pagination, so the
  numbering is always right).
"""
from __future__ import annotations

import base64
import datetime as _dt
import hashlib
import json
import html as _html
import math
import os
import random
import re
import shutil
import subprocess
import tempfile
import uuid
from functools import lru_cache
from pathlib import Path

__all__ = ["render_html", "render_pdf", "PdfError"]

APP_DIR = Path(__file__).resolve().parent
FONT_DIR = APP_DIR / "static" / "fonts"
TPL_DIR = APP_DIR / "templates"


class PdfError(Exception):
    """Raised when the PDF cannot be produced (message is user-safe)."""


# ----------------------------------------------------------------------------------------------
# small helpers
# ----------------------------------------------------------------------------------------------
def e(x) -> str:
    return _html.escape("" if x is None else str(x), quote=True)


def _s(x, default: str = "") -> str:
    """Coerce anything to a clean single string."""
    if x is None:
        return default
    if isinstance(x, (list, tuple)):
        x = " ".join(str(i) for i in x)
    s = str(x).replace("\r\n", "\n").replace("\r", "\n")
    s = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", s)
    return s.strip()


def _list(x) -> list:
    return x if isinstance(x, list) else []


def _dict(x) -> dict:
    return x if isinstance(x, dict) else {}


_BOLD = re.compile(r"\*\*(.+?)\*\*", re.S)
_CODE = re.compile(r"`([^`\n]+)`")


def rich(text) -> str:
    """Escape, then allow **bold** and `code` only."""
    s = e(_s(text))
    s = _CODE.sub(lambda m: "<code>" + m.group(1) + "</code>", s)
    s = _BOLD.sub(lambda m: "<b>" + m.group(1) + "</b>", s)
    return s.replace("\n", "<br>")


def plain(text) -> str:
    """Strip our tiny markup for places where only text is wanted (SVG)."""
    s = _s(text)
    s = _BOLD.sub(lambda m: m.group(1), s)
    s = _CODE.sub(lambda m: m.group(1), s)
    return re.sub(r"\s+", " ", s)


def _seed(*parts) -> int:
    h = hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8", "replace")).digest()
    return int.from_bytes(h[:8], "big")


# ----------------------------------------------------------------------------------------------
# fonts: base64 @font-face + measuring
# ----------------------------------------------------------------------------------------------
_FACES = [
    # css family, file, weight
    ("NB Kalam", "Kalam-Regular.ttf", "400"),
    ("NB Kalam", "Kalam-Bold.ttf", "700"),
    ("NB Kalam Light", "Kalam-Light.ttf", "100 900"),
    ("NB Patrick", "PatrickHand-Regular.ttf", "400"),
    ("NB Caveat", "Caveat-Regular.ttf", "400"),
    ("NB Mono", "JetBrainsMono-Regular.ttf", "400"),
]


@lru_cache(maxsize=1)
def _font_css() -> str:
    out = []
    for fam, fn, wt in _FACES:
        p = FONT_DIR / fn
        if not p.exists():
            continue
        b64 = base64.b64encode(p.read_bytes()).decode("ascii")
        out.append(
            "@font-face{font-family:'%s';src:url(data:font/ttf;base64,%s) format('truetype');"
            "font-weight:%s;font-style:normal;font-display:block}" % (fam, b64, wt)
        )
    return "\n".join(out)


_MEASURE_FILES = {
    "kb": "Kalam-Bold.ttf", "kr": "Kalam-Regular.ttf", "kl": "Kalam-Light.ttf",
    "ph": "PatrickHand-Regular.ttf", "cv": "Caveat-Regular.ttf", "mono": "JetBrainsMono-Regular.ttf",
}
_font_cache: dict = {}


def _mfont(face: str):
    if face not in _font_cache:
        try:
            import pymupdf  # type: ignore
            _font_cache[face] = pymupdf.Font(fontfile=str(FONT_DIR / _MEASURE_FILES[face]))
        except Exception:  # pragma: no cover - fall back to heuristics
            _font_cache[face] = None
    return _font_cache[face]


def tw(text: str, size: float, face: str) -> float:
    """Text width in px (slightly pessimistic)."""
    f = _mfont(face)
    if f is None:
        return len(text) * size * 0.56
    try:
        return f.text_length(text, size) * 1.03 + 0.5
    except Exception:  # pragma: no cover
        return len(text) * size * 0.56


def wrap_text(text: str, maxw: float, size: float, face: str, max_lines: int | None = None) -> list[str]:
    words = _s(text).split()
    lines: list[str] = []
    cur = ""
    for w in words:
        # break words that are wider than a line
        while tw(w, size, face) > maxw and len(w) > 1:
            k = len(w)
            while k > 1 and tw(w[:k], size, face) > maxw:
                k -= 1
            if cur:
                lines.append(cur)
                cur = ""
            lines.append(w[:k])
            w = w[k:]
        t = (cur + " " + w).strip()
        if cur and tw(t, size, face) > maxw:
            lines.append(cur)
            cur = w
        else:
            cur = t
    if cur:
        lines.append(cur)
    if max_lines and len(lines) > max_lines:
        lines = lines[:max_lines]
        last = lines[-1]
        while last and tw(last + "\u2026", size, face) > maxw:
            last = last[:-1]
        lines[-1] = last.rstrip() + "\u2026"
    return lines or [""]


def trunc(text: str, n: int) -> str:
    t = plain(text)
    return t if len(t) <= n else t[: n - 1].rstrip() + "\u2026"


# ----------------------------------------------------------------------------------------------
# sketchy SVG toolkit (seeded)
#
# Every diagram is emitted as three SVG groups:
#   <g class="py"> plain Python-drawn jittery strokes - the no-JavaScript fallback
#   <g class="rg"> machine-readable shape specs (<g class="rj" data-s='{json}'>) that notebook.js hands
#                  to Rough.js; when it succeeds the drawn result replaces "py" (svg gets "rough-on")
#   <g class="tx"> the real <text> labels (always visible, crisp, selectable)
# Layout (positions, sizes, wrapped text, edge routes) is always computed here, deterministically;
# Rough.js only draws strokes, using one fixed seed per shape.
# ----------------------------------------------------------------------------------------------
INK = "#2b2622"
CARD = "#fffdf6"
PAPER = "#f6f1e3"
# (paper-ish base fill, outline colour, highlighter hachure colour or None)
TINTS = [
    ("#fffdf6", INK, None),
    ("#fdeeea", "#b03a2e", "#ee9d92"),   # 1 pink
    ("#eef7ee", "#2e7d4f", "#79c48e"),   # 2 green
    ("#eef3fb", "#2f5f8f", "#8db6e2"),   # 3 blue
    ("#fff8d6", "#9c7d0b", "#f3d63b"),   # 4 yellow
]
_RJ_MOD = 2147483646


def _f(v: float) -> str:
    return ("%.1f" % v).rstrip("0").rstrip(".")


def _r1(v) -> float:
    return round(float(v), 1)


class Sketch:
    def __init__(self, seed: int):
        self.r = random.Random(seed)
        self.seed = seed % _RJ_MOD
        self.parts: list[str] = []   # python fallback strokes
        self.rj: list[dict] = []     # rough.js shape specs
        self.tx: list[str] = []      # text (always visible)
        self._n = 0

    def j(self, a: float) -> float:
        return self.r.uniform(-a, a)

    def _spec(self, kind: str, a: list, op=None, **o) -> None:
        self._n += 1
        o.setdefault("seed", (self.seed + self._n * 7919) % _RJ_MOD + 1)
        spec = {"k": kind, "a": [v if isinstance(v, str) else _r1(v) for v in a], "o": o}
        if op:
            spec["op"] = op
        self.rj.append(spec)

    # --- primitives
    def line_d(self, x1, y1, x2, y2, amp=1.3, over=0.0) -> str:
        dx, dy = x2 - x1, y2 - y1
        ln = math.hypot(dx, dy) or 1.0
        ux, uy = dx / ln, dy / ln
        o1 = self.r.uniform(0, over)
        o2 = self.r.uniform(0, over)
        x1, y1, x2, y2 = x1 - ux * o1, y1 - uy * o1, x2 + ux * o2, y2 + uy * o2
        nx, ny = -uy, ux
        bow = self.j(amp * (1.0 + min(ln, 300) / 150.0))
        mx, my = (x1 + x2) / 2 + nx * bow, (y1 + y2) / 2 + ny * bow
        return "M%s %sQ%s %s %s %s" % (_f(x1 + self.j(.6)), _f(y1 + self.j(.6)), _f(mx), _f(my), _f(x2 + self.j(.6)), _f(y2 + self.j(.6)))

    def rect(self, x, y, w, h, fill=CARD, stroke=INK, sw=2.2, double=True, dash=None, shadow=False, hl=None,
             hl_style="hachure", rough=True):
        """Box. ``fill`` is the pale base, ``hl`` an optional highlighter-hachure colour (Rough.js only)."""
        out = []
        j = 1.4
        pts = [(x + self.j(j), y + self.j(j)), (x + w + self.j(j), y + self.j(j)),
               (x + w + self.j(j), y + h + self.j(j)), (x + self.j(j), y + h + self.j(j))]
        if shadow:
            out.append('<path d="M%s %sL%s %sL%s %sL%s %sZ" fill="rgba(43,38,34,.16)" stroke="none"/>' % (
                _f(pts[0][0] + 4), _f(pts[0][1] + 4), _f(pts[1][0] + 4), _f(pts[1][1] + 4),
                _f(pts[2][0] + 4), _f(pts[2][1] + 4), _f(pts[3][0] + 4), _f(pts[3][1] + 4)))
        if fill and fill != "none":
            out.append('<path d="M%s %sL%s %sL%s %sL%s %sZ" fill="%s" stroke="none"/>' % (
                _f(pts[0][0]), _f(pts[0][1]), _f(pts[1][0]), _f(pts[1][1]), _f(pts[2][0]), _f(pts[2][1]), _f(pts[3][0]), _f(pts[3][1]), fill))
        passes = 2 if double else 1
        for k in range(passes):
            d = ""
            ps = pts if k == 0 else [(px + self.j(1.6), py + self.j(1.6)) for px, py in pts]
            for i in range(4):
                a, b = ps[i], ps[(i + 1) % 4]
                d += self.line_d(a[0], a[1], b[0], b[1], amp=0.9, over=4.0 if k == 0 else 3.0)
            extra = ' stroke-dasharray="%s"' % dash if dash else ""
            out.append('<path d="%s" fill="none" stroke="%s" stroke-width="%s" stroke-linecap="round" stroke-linejoin="round"%s%s/>' % (
                d, stroke, _f(sw if k == 0 else sw * 0.55), ' opacity=".8"' if k else "", extra))
        self.parts.append("".join(out))
        if not rough:
            return
        box = [x, y, w, h]
        if shadow:
            self._spec("r", [x + 4, y + 4, w, h], fill="rgba(43,38,34,.16)", fillStyle="solid", stroke="none", roughness=0.6)
        if fill and fill != "none":
            self._spec("r", box, fill=fill, fillStyle="solid", stroke="none", roughness=0.6)
        if hl:
            self._spec("r", box, op=0.5, fill=hl, fillStyle=hl_style, fillWeight=4.2, hachureGap=8,
                       hachureAngle=-38, stroke="none", roughness=1.0)
        o = dict(stroke=stroke, strokeWidth=_r1(sw), roughness=1.15, bowing=1.1, disableMultiStroke=not double)
        if dash:
            o["strokeLineDash"] = [float(v) for v in str(dash).split()]
        self._spec("r", box, **o)

    def ellipse(self, cx, cy, w, h, fill=CARD, stroke=INK, sw=2.2, hl=None, hl_style="hachure"):
        r = self.r
        rx, ry = w / 2, h / 2
        for k in range(2):
            n = 28
            off = r.uniform(0, 6.28)
            pts = []
            for i in range(n + 3):
                a = off + 2 * math.pi * i / n
                m = 1 + r.uniform(-.015, .015) + (k * r.uniform(-.02, .02))
                pts.append((cx + math.cos(a) * rx * m, cy + math.sin(a) * ry * m))
            d_k = "M%s %s" % (_f(pts[0][0]), _f(pts[0][1])) + "".join("L%s %s" % (_f(px), _f(py)) for px, py in pts[1:])
            if k == 0 and fill and fill != "none":
                self.parts.append('<path d="%sZ" fill="%s" stroke="none"/>' % (d_k, fill))
            self.parts.append('<path d="%s" fill="none" stroke="%s" stroke-width="%s" stroke-linecap="round" stroke-linejoin="round"%s/>' % (
                d_k, stroke, _f(sw if k == 0 else sw * .55), ' opacity=".8"' if k else ""))
        box = [cx, cy, w, h]
        if fill and fill != "none":
            self._spec("e", box, fill=fill, fillStyle="solid", stroke="none", roughness=0.6)
        if hl:
            self._spec("e", box, op=0.5, fill=hl, fillStyle=hl_style, fillWeight=4.2, hachureGap=8,
                       hachureAngle=-38, stroke="none", roughness=1.0)
        self._spec("e", box, stroke=stroke, strokeWidth=_r1(sw), roughness=1.15, bowing=1.1)

    @staticmethod
    def _py_path(d, stroke, sw, dash=None, opacity=None) -> str:
        extra = ' stroke-dasharray="%s"' % dash if dash else ""
        op = ' opacity="%s"' % opacity if opacity else ""
        return '<path d="%s" fill="none" stroke="%s" stroke-width="%s" stroke-linecap="round" stroke-linejoin="round"%s%s/>' % (d, stroke, _f(sw), extra, op)

    @staticmethod
    def _dash(dash) -> dict:
        return {"strokeLineDash": [float(v) for v in str(dash).split()]} if dash else {}

    def line(self, x1, y1, x2, y2, stroke=INK, sw=2.2, dash=None, amp=1.3, opacity=None):
        self.parts.append(self._py_path(self.line_d(x1, y1, x2, y2, amp=amp), stroke, sw, dash, opacity))
        self._spec("l", [x1, y1, x2, y2], op=opacity, stroke=stroke, strokeWidth=_r1(sw), roughness=1.0, bowing=1.0,
                   **self._dash(dash))

    def path(self, d, stroke=INK, sw=2.2, dash=None, opacity=None, rd=None):
        """Stroke an SVG path. ``d`` is the python fallback; ``rd`` (default ``d``) is what Rough.js redraws."""
        self.parts.append(self._py_path(d, stroke, sw, dash, opacity))
        self._spec("p", [rd or d], op=opacity, stroke=stroke, strokeWidth=_r1(sw), roughness=1.0, bowing=1.0,
                   **self._dash(dash))

    def head(self, x, y, ang, stroke=INK, sw=2.2, size=11):
        d = ""
        for sgn in (-1, 1):
            a = ang + math.pi + sgn * math.radians(27 + self.j(4))
            ln = size + self.j(1.5)
            ex, ey = x + math.cos(a) * ln, y + math.sin(a) * ln
            d += "M%s %sL%s %s" % (_f(x), _f(y), _f(ex), _f(ey))
            self._spec("l", [x, y, ex, ey], stroke=stroke, strokeWidth=_r1(sw), roughness=0.55, bowing=0.6)
        self.parts.append(self._py_path(d, stroke, sw))

    def arrow(self, pts, stroke=INK, sw=2.2, dash=None, curve=True):
        """pts: list of (x, y); drawn as smooth-ish polyline with arrow head at the end."""
        if len(pts) == 2:
            (x1, y1), (x2, y2) = pts
            self.line(x1, y1, x2, y2, stroke, sw, dash, amp=1.6)
            self.head(x2, y2, math.atan2(y2 - y1, x2 - x1), stroke, sw)
            return
        # polyline with rounded corners
        d = "M%s %s" % (_f(pts[0][0]), _f(pts[0][1]))
        rad = 12
        for i in range(1, len(pts) - 1):
            p0, p1, p2 = pts[i - 1], pts[i], pts[i + 1]
            l1 = math.hypot(p1[0] - p0[0], p1[1] - p0[1]) or 1
            l2 = math.hypot(p2[0] - p1[0], p2[1] - p1[1]) or 1
            r = min(rad, l1 / 2, l2 / 2)
            a = (p1[0] + (p0[0] - p1[0]) / l1 * r, p1[1] + (p0[1] - p1[1]) / l1 * r)
            b = (p1[0] + (p2[0] - p1[0]) / l2 * r, p1[1] + (p2[1] - p1[1]) / l2 * r)
            d += "L%s %sQ%s %s %s %s" % (_f(a[0]), _f(a[1]), _f(p1[0]), _f(p1[1]), _f(b[0]), _f(b[1]))
        d += "L%s %s" % (_f(pts[-1][0]), _f(pts[-1][1]))
        self.path(d, stroke, sw, dash)
        x2, y2 = pts[-1]
        x1, y1 = pts[-2]
        self.head(x2, y2, math.atan2(y2 - y1, x2 - x1), stroke, sw)

    def bezier_arrow(self, p0, c1, c2, p3, stroke=INK, sw=2.2, dash=None, head=True):
        d = "M%s %sC%s %s %s %s %s %s" % (_f(p0[0]), _f(p0[1]), _f(c1[0]), _f(c1[1]), _f(c2[0]), _f(c2[1]), _f(p3[0]), _f(p3[1]))
        self.path(d, stroke, sw, dash)
        if head:
            self.head(p3[0], p3[1], math.atan2(p3[1] - c2[1], p3[0] - c2[0]), stroke, sw)

    def text(self, x, y, s, size, cls, anchor="middle", fill=INK, extra=""):
        self.tx.append('<text x="%s" y="%s" font-size="%s" class="%s" text-anchor="%s" fill="%s"%s>%s</text>' % (
            _f(x), _f(y), _f(size), cls, anchor, fill, extra, e(s)))

    def label(self, cx, cy, lines, size=15, cls="cv", fill="#2f5f8f", bg=PAPER):
        """Edge label centred on (cx, cy) with paper-coloured backing."""
        lh = size * 1.05
        w = max(tw(l, size, "cv") for l in lines) + 8
        h = lh * len(lines) + 2
        self.parts.append('<rect x="%s" y="%s" width="%s" height="%s" rx="4" fill="%s" opacity=".92"/>' % (
            _f(cx - w / 2), _f(cy - h / 2), _f(w), _f(h), bg))
        self._spec("r", [cx - w / 2, cy - h / 2, w, h], op=0.94, fill=bg, fillStyle="solid", stroke="none", roughness=0)
        for i, l in enumerate(lines):
            self.text(cx, cy - h / 2 + lh * (i + 0.8) + 1, l, size, cls, "middle", fill)

    def out(self) -> str:
        """Diagram markup: python fallback strokes + Rough.js specs + text."""
        rj = "".join("<g class=\"rj\" data-s='%s'/>" % json.dumps(s, separators=(",", ":")) for s in self.rj)
        return '<g class="py">%s</g><g class="rg">%s</g><g class="tx">%s</g>' % ("".join(self.parts), rj, "".join(self.tx))

    def out_plain(self) -> str:
        """Strokes + text only (page furniture that is never redrawn by Rough.js)."""
        return "".join(self.parts) + "".join(self.tx)


# ----------------------------------------------------------------------------------------------
# diagrams
# ----------------------------------------------------------------------------------------------
MAX_NODES = 8
MAX_NODES_BY_TYPE = {"mindmap": 10, "sequence": 5}
MAX_SEQ_MESSAGES = 8
DIAGRAM_TYPES = ("flow", "stack", "compare", "cycle", "tree", "timeline", "mindmap", "sequence")
LBL_SIZE, LBL_LH = 16.5, 19.5
DET_SIZE, DET_LH = 13.6, 16.2


def _clean_diagram(d) -> dict | None:
    if not isinstance(d, dict):
        return None
    typ = _s(d.get("type")).lower()
    if typ not in DIAGRAM_TYPES:
        typ = "flow"
    nodes, seen = [], set()
    for i, n in enumerate(_list(d.get("nodes"))[: MAX_NODES_BY_TYPE.get(typ, MAX_NODES)]):
        if isinstance(n, str):
            n = {"label": n}
        if not isinstance(n, dict):
            continue
        label = trunc(n.get("label", ""), 60)
        if not label:
            continue
        nid = _s(n.get("id")) or "n%d" % i
        if nid in seen:
            nid = "%s_%d" % (nid, i)
        seen.add(nid)
        nodes.append({"id": nid, "label": label, "detail": trunc(n.get("detail", ""), 140), "parent": _s(n.get("parent"))})
    if not nodes:
        return None
    if typ == "sequence" and len(nodes) < 2:  # a lifeline diagram needs at least two actors
        typ = "flow"
    ids = {n["id"] for n in nodes}
    edges, es = [], set()
    for ed in _list(d.get("edges")):
        if not isinstance(ed, dict):
            continue
        a, b = _s(ed.get("from")), _s(ed.get("to"))
        if typ == "sequence":  # ordered messages: repeats and self-calls are meaningful
            if a in ids and b in ids and len(edges) < MAX_SEQ_MESSAGES:
                edges.append({"from": a, "to": b, "label": trunc(ed.get("label", ""), 40)})
        elif a in ids and b in ids and a != b and (a, b) not in es:
            es.add((a, b))
            edges.append({"from": a, "to": b, "label": trunc(ed.get("label", ""), 28)})
    return {"type": typ, "title": trunc(d.get("title", ""), 80), "caption": trunc(d.get("caption", ""), 200),
            "nodes": nodes, "edges": edges}


def _node_box(n: dict, bw: float, center=True, max_label=2, max_det=3, pad=10) -> dict:
    lw = bw - 2 * pad
    ll = wrap_text(n["label"], lw, LBL_SIZE, "kb", max_label)
    dl = wrap_text(n["detail"], lw, DET_SIZE, "ph", max_det) if n["detail"] else []
    h = pad + len(ll) * LBL_LH + (len(dl) * DET_LH + 3 if dl else 0) + pad - 1
    return {"ll": ll, "dl": dl, "h": max(h, 40)}


def _draw_node(sk: Sketch, n: dict, x, y, w, h, tint=0, shadow=False):
    fill, stroke, hl = TINTS[tint % len(TINTS)]
    sk.rect(x, y, w, h, fill=fill, stroke=stroke, shadow=shadow, hl=hl)
    ty = y + 10 + LBL_LH * 0.78
    for l in n["_ll"]:
        sk.text(x + w / 2, ty, l, LBL_SIZE, "kb", "middle", INK)
        ty += LBL_LH
    if n["_dl"]:
        ty += 1
        for l in n["_dl"]:
            sk.text(x + w / 2, ty, l, DET_SIZE, "ph", "middle", "#3d362f")
            ty += DET_LH


def _label_lines(text: str, maxw: float) -> list[str]:
    return wrap_text(text, maxw, 15, "cv", 3) if text else []


def _intersect_rect(cx, cy, w, h, tx, ty, pad=5):
    """Point where the ray from rect centre to (tx,ty) leaves the (padded) rect."""
    dx, dy = tx - cx, ty - cy
    if dx == 0 and dy == 0:
        return cx, cy
    hw, hh = w / 2 + pad, h / 2 + pad
    s = min(hw / abs(dx) if dx else 1e9, hh / abs(dy) if dy else 1e9)
    return cx + dx * s, cy + dy * s


def _layout_flow(dg: dict, W: float):
    nodes, edges = dg["nodes"], list(dg["edges"])
    n = len(nodes)
    idx = {nd["id"]: i for i, nd in enumerate(nodes)}
    if not edges:
        edges = [{"from": nodes[i]["id"], "to": nodes[i + 1]["id"], "label": ""} for i in range(n - 1)]
    # longest-path layering; edges that point backwards are drawn as arcs
    layer = [0] * n
    for _ in range(n):
        ch = False
        for ed in edges:
            a, b = idx[ed["from"]], idx[ed["to"]]
            if layer[b] < layer[a] + 1 and layer[a] + 1 < n:
                layer[b] = layer[a] + 1
                ch = True
        if not ch:
            break
    fwd, back = [], []
    for ed in edges:
        (fwd if layer[idx[ed["to"]]] > layer[idx[ed["from"]]] else back).append(ed)
    # compact empty layers
    used = sorted(set(layer))
    remap = {l: i for i, l in enumerate(used)}
    layer = [remap[l] for l in layer]
    nl = len(used)
    groups = [[] for _ in range(nl)]
    for i in range(n):
        groups[layer[i]].append(i)
    # order inside layer by mean index of predecessors (stable barycentre)
    pos = {}
    for li in range(nl):
        if li > 0:
            def key(i):
                preds = [pos[idx[ed["from"]]] for ed in fwd if idx[ed["to"]] == i and idx[ed["from"]] in pos]
                return (sum(preds) / len(preds)) if preds else i
            groups[li].sort(key=key)
        for k, i in enumerate(groups[li]):
            pos[i] = k - (len(groups[li]) - 1) / 2.0
    # gap between consecutive layers (room for edge labels)
    def gap_after(li):
        lab = [ed["label"] for ed in fwd if ed["label"] and layer[idx[ed["from"]]] == li and layer[idx[ed["to"]]] == li + 1]
        if not lab:
            return 46
        wmax = max(sum(tw(w, 15, "cv") for w in [l]) for l in lab)
        two = max(max((tw(x, 15, "cv") for x in _label_lines(l, 80)), default=0) for l in lab)
        return max(46, min(wmax, max(two, 60)) + 22)

    gaps = [gap_after(li) for li in range(max(nl - 1, 0))]
    MARGIN = 0
    # choose layers per row
    best = None
    for k in range(nl, 0, -1):
        rows = math.ceil(nl / k)
        side = 34 if rows > 1 else MARGIN
        worst = 0
        for r in range(rows):
            ls = list(range(r * k, min((r + 1) * k, nl)))
            worst = max(worst, sum(gaps[l] for l in ls[:-1]))
        bw = min(196, (W - 2 * side - worst) / k)
        if bw >= 118 or k == 1:
            best = (k, rows, side, bw)
            break
    k, rows, side, bw = best
    bw = max(bw, 110)
    for nd in nodes:
        nd["_box"] = _node_box(nd, bw, max_label=2, max_det=3)
        nd["_ll"], nd["_dl"] = nd["_box"]["ll"], nd["_box"]["dl"]
    bh = max(nd["_box"]["h"] for nd in nodes)
    vgap = 22
    # row geometry
    row_stack = []
    for r in range(rows):
        ls = range(r * k, min((r + 1) * k, nl))
        row_stack.append(max(len(groups[l]) for l in ls))
    # gutter above rows for skip edges
    def is_skip(ed):
        return layer[idx[ed["to"]]] - layer[idx[ed["from"]]] > 1 and layer[idx[ed["to"]]] // k == layer[idx[ed["from"]]] // k
    skips = [ed for ed in fwd if is_skip(ed)]
    cross = [ed for ed in fwd if layer[idx[ed["to"]]] // k != layer[idx[ed["from"]]] // k]
    top = 10 + (12 * len(skips) + 8 if skips else 0)
    rowgap = 58 + (10 * len(cross))
    row_y, y = [], top
    for r in range(rows):
        row_y.append(y)
        y += row_stack[r] * bh + (row_stack[r] - 1) * vgap + rowgap
    H = y - rowgap + 14 + (24 if back else 0)
    # x of each layer
    layer_x = {}
    for r in range(rows):
        ls = list(range(r * k, min((r + 1) * k, nl)))
        total = len(ls) * bw + sum(gaps[l] for l in ls[:-1])
        x0 = side + (W - 2 * side - total) / 2
        xs, x = {}, x0
        for l in ls:
            xs[l] = x
            x += bw + (gaps[l] if l < nl - 1 else 0)
        if r % 2 == 1:  # snake: mirror
            for l in ls:
                xs[l] = W - xs[l] - bw
        layer_x.update(xs)
    geo = {}
    for li in range(nl):
        r = li // k
        stack = len(groups[li])
        block = stack * bh + (stack - 1) * vgap
        rowh = row_stack[r] * bh + (row_stack[r] - 1) * vgap
        y0 = row_y[r] + (rowh - block) / 2
        for si, i in enumerate(groups[li]):
            geo[i] = (layer_x[li], y0 + si * (bh + vgap), bw, bh)
    return dict(nodes=nodes, edges=edges, fwd=fwd, back=back, geo=geo, layer=layer, idx=idx, k=k, rows=rows, W=W, H=H,
                skips=skips, row_y=row_y, bh=bh, groups=groups, cross=cross, row_stack=row_stack, vgap=vgap, rowgap=rowgap)


def _svg_flow(dg: dict, W: float) -> tuple[str, float, float]:
    L = _layout_flow(dg, W)
    sk = Sketch(_seed("flow", dg["title"], *[n["label"] for n in dg["nodes"]]))
    geo, idx, layer, k = L["geo"], L["idx"], L["layer"], L["k"]
    for i, nd in enumerate(L["nodes"]):
        x, y, w, h = geo[i]
        _draw_node(sk, nd, x, y, w, h, tint=(4, 2, 3, 1)[layer[i] % 4], shadow=False)
    skip_i = 0
    cross_i = 0
    for ed in L["fwd"]:
        a, b = idx[ed["from"]], idx[ed["to"]]
        ax, ay, aw, ah = geo[a]
        bx, by, bw_, bh_ = geo[b]
        la, lb = layer[a], layer[b]
        ra, rb = la // k, lb // k
        lab = _label_lines(ed["label"], 80)
        if ra == rb and lb == la + 1:
            fwd_dir = (bx > ax)
            p0 = (ax + aw + 3, ay + ah / 2) if fwd_dir else (ax - 3, ay + ah / 2)
            p3 = (bx - 6, by + bh_ / 2) if fwd_dir else (bx + bw_ + 6, by + bh_ / 2)
            sk.arrow([p0, p3])
            if lab:
                sk.label((p0[0] + p3[0]) / 2, (p0[1] + p3[1]) / 2 - 12 - (len(lab) - 1) * 6, lab)
        elif ra == rb:  # skip edge in same row: over the top
            gy = L["row_y"][ra] - 10 - 12 * skip_i
            skip_i += 1
            p0 = (ax + aw / 2, ay - 3)
            p3 = (bx + bw_ / 2, by - 7)
            sk.arrow([p0, (p0[0], gy), (p3[0], gy), p3])
            if lab:
                sk.label((p0[0] + p3[0]) / 2, gy, lab)
        else:  # crosses to the next row: via the channel between rows
            chan = L["row_y"][ra] + L["row_stack"][ra] * L["bh"] + (L["row_stack"][ra] - 1) * L["vgap"] + 24 + 10 * cross_i
            cross_i += 1
            p0 = (ax + aw / 2, ay + ah + 3)
            p3 = (bx + bw_ / 2, by - 7)
            if abs(p0[0] - p3[0]) < 2:
                sk.arrow([p0, p3])
            else:
                sk.arrow([p0, (p0[0], chan), (p3[0], chan), p3])
            if lab:
                sk.label(p0[0] + 8 + max(tw(x, 15, "cv") for x in lab) / 2, chan if abs(p0[0] - p3[0]) >= 2 else (p0[1] + p3[1]) / 2, lab)
    for ed in L["back"]:  # arcs underneath
        a, b = idx[ed["from"]], idx[ed["to"]]
        ax, ay, aw, ah = geo[a]
        bx, by, bw_, bh_ = geo[b]
        yb = L["H"] - 6
        sk.bezier_arrow((ax + aw / 2, ay + ah + 3), (ax + aw / 2, yb + 10), (bx + bw_ / 2, yb + 10), (bx + bw_ / 2, by + bh_ + 7), dash="6 5")
    return sk.out(), W, L["H"]


def _svg_stack(dg: dict, W: float) -> tuple[str, float, float]:
    sk = Sketch(_seed("stack", dg["title"], *[n["label"] for n in dg["nodes"]]))
    nodes = dg["nodes"]
    fx, fw = 4, W - 8
    ix, iw = 24, W - 48
    tpad = 16
    y = 12
    title_h = 0
    if dg["title"]:
        title_h = 36
    y0 = y + title_h + 10
    heights, runs_list = [], []
    for i, nd in enumerate(nodes):
        runs = [("%d. %s" % (i + 1, nd["label"]), "kb", LBL_SIZE - 1.5)]
        if nd["detail"]:
            runs += [(" \u2014 " + nd["detail"], "ph", 14.4)]
        words = []
        for txt, face, size in runs:
            for wd in re.split(r"(?<=\s)|(?<=\u2014 )", txt):
                if wd:
                    words.append((wd, face, size))
        lines, cur, cw = [], [], 0.0
        maxw = iw - 2 * tpad
        for wd, face, size in words:
            ww = tw(wd, size, face)
            if cur and cw + ww > maxw:
                lines.append(cur)
                cur, cw = [], 0.0
            cur.append((wd, face, size))
            cw += ww
        if cur:
            lines.append(cur)
        runs_list.append(lines[:3])
        heights.append(max(46, 20 + len(lines[:3]) * 19))
    total = sum(heights) + 18 * (len(nodes) - 1)
    H = y0 + total + 22
    sk.rect(fx, 6, fw, H - 12, fill="#faf6e9", stroke=INK, sw=2.6, double=True, hl="#e9dfc2", hl_style="zigzag")
    if dg["title"]:
        sk.text(ix + 4, y + 30, dg["title"], 20, "kb", "start", INK)
    yy = y0
    for i, nd in enumerate(nodes):
        h = heights[i]
        tf, ts_, thl = TINTS[(4, 2, 3)[i % 3]]
        sk.rect(ix, yy, iw, h, fill=CARD, stroke=INK, sw=2.2, hl=thl)
        ly = yy + h / 2 - (len(runs_list[i]) - 1) * 9.5 + 5.5
        for line in runs_list[i]:
            spans = "".join('<tspan class="%s" font-size="%s">%s</tspan>' % (face, _f(size), e(wd)) for wd, face, size in line)
            sk.tx.append('<text x="%s" y="%s" fill="%s" xml:space="preserve">%s</text>' % (_f(ix + tpad), _f(ly), INK, spans))
            ly += 19
        if i < len(nodes) - 1:
            cx = ix + iw / 2
            sk.arrow([(cx, yy + h + 1), (cx + sk.j(1), yy + h + 17)], sw=2.0)
        yy += h + 18
    return sk.out(), W, H


def _svg_compare(dg: dict, W: float) -> tuple[str, float, float]:
    sk = Sketch(_seed("cmp", dg["title"], *[n["label"] for n in dg["nodes"]]))
    nodes = dg["nodes"]
    n = len(nodes)
    cols = n if n <= 3 else (2 if n == 4 else 3)
    rows = math.ceil(n / cols)
    idx = {nd["id"]: i for i, nd in enumerate(nodes)}
    edges = dg["edges"] or []
    edge_map = {}
    for ed in edges:
        a, b = idx[ed["from"]], idx[ed["to"]]
        if a // cols == b // cols and b == a + 1:
            edge_map[a] = ed
    gaps = []
    for c in range(cols - 1):
        lab = [edge_map[i]["label"] for i in range(n) if i % cols == c and i in edge_map and edge_map[i]["label"]]
        has = any(i % cols == c and i in edge_map for i in range(n))
        w = max([tw(l, 15, "cv") for l in lab], default=0)
        gaps.append(max(30, (50 if has else 0) + min(w, 74)) if has else 26)
    bw = (W - sum(gaps)) / cols
    # sizes
    for nd in nodes:
        lw = bw - 22
        nd["_ll"] = wrap_text(nd["label"], lw, 17.5, "kb", 2)
        nd["_dl"] = wrap_text(nd["detail"], lw, 14.4, "ph", 6) if nd["detail"] else []
        nd["_h"] = 18 + len(nd["_ll"]) * 21 + (len(nd["_dl"]) * 17.5 + 8 if nd["_dl"] else 0) + 6
    row_h = []
    for r in range(rows):
        row_h.append(max(nd["_h"] for i, nd in enumerate(nodes) if i // cols == r))
    vgap = 32
    H = 14 + sum(row_h) + vgap * (rows - 1) + 14
    pal = [1, 2, 3, 4, 0]
    ry = 12
    cx_of = {}
    for r in range(rows):
        x = 0.0
        for c in range(cols):
            i = r * cols + c
            if i >= n:
                break
            nd = nodes[i]
            fill, stroke, hl = TINTS[pal[i % len(pal)]]
            sk.rect(x + 3, ry, bw - 6, row_h[r], fill=fill, stroke=stroke, sw=2.3, hl=hl)
            ty = ry + 14 + 17.5 * 0.8
            for l in nd["_ll"]:
                sk.text(x + bw / 2, ty, l, 17.5, "kb", "middle", INK)
                ty += 21
            ty += 3
            for l in nd["_dl"]:
                sk.text(x + bw / 2, ty + 5, l, 14.4, "ph", "middle", "#3d362f")
                ty += 17.5
            cx_of[i] = (x, ry, bw, row_h[r])
            if c < cols - 1:
                x += bw + gaps[c]
        ry += row_h[r] + vgap
    for i, ed in edge_map.items():
        x, y, w, h = cx_of[i]
        x2 = cx_of[i + 1][0]
        ym = y + min(h, cx_of[i + 1][3]) / 2
        sk.arrow([(x + w - 2, ym), (x2 + 6, ym)], dash="7 5")
        if ed["label"]:
            lines = _label_lines(ed["label"], 72)
            sk.label((x + w + x2) / 2, ym - 14 - (len(lines) - 1) * 6, lines)
    return sk.out(), W, H


def _svg_cycle(dg: dict, W: float) -> tuple[str, float, float]:
    sk = Sketch(_seed("cycle", dg["title"], *[n["label"] for n in dg["nodes"]]))
    nodes = dg["nodes"]
    n = len(nodes)
    idx = {nd["id"]: i for i, nd in enumerate(nodes)}
    edges = dg["edges"] or [{"from": nodes[i]["id"], "to": nodes[(i + 1) % n]["id"], "label": ""} for i in range(n)] if n > 1 else []
    bw = 168 if n <= 6 else 150
    for nd in nodes:
        b = _node_box(nd, bw, max_label=2, max_det=2)
        nd["_ll"], nd["_dl"], nd["_h"] = b["ll"], b["dl"], b["h"]
    bh = max(nd["_h"] for nd in nodes)
    rx = (W - bw) / 2 - 14
    ry = max(bh * 1.35, 80)
    def centers(ry_):
        out = []
        for i in range(n):
            a = -math.pi / 2 + 2 * math.pi * i / n
            out.append((W / 2 + rx * math.cos(a), ry_ * math.sin(a)))
        return out
    def ok(cs):
        for i in range(n):
            for j in range(i + 1, n):
                if abs(cs[i][0] - cs[j][0]) < bw + 34 and abs(cs[i][1] - cs[j][1]) < bh + 28:
                    return False
        return True
    while ry < 280 and not ok(centers(ry)):
        ry += 8
    cs = centers(ry)
    top = bh / 2 + 14
    cs = [(x, y + ry + top) for x, y in cs]
    H = 2 * ry + bh + 28
    cx0, cy0 = W / 2, ry + top
    for i, nd in enumerate(nodes):
        x, y = cs[i]
        _draw_node(sk, nd, x - bw / 2, y - bh / 2, bw, bh, tint=(4, 2, 3, 1)[i % 4])
    for ed in edges:
        a, b = idx[ed["from"]], idx[ed["to"]]
        (ax, ay), (bx, by) = cs[a], cs[b]
        p0 = _intersect_rect(ax, ay, bw, bh, bx, by, pad=6)
        p3 = _intersect_rect(bx, by, bw, bh, ax, ay, pad=8)
        mx, my = (p0[0] + p3[0]) / 2, (p0[1] + p3[1]) / 2
        vx, vy = mx - cx0, my - cy0
        vl = math.hypot(vx, vy) or 1
        off = 22
        c = (mx + vx / vl * off, my + vy / vl * off)
        d = "M%s %sQ%s %s %s %s" % (_f(p0[0]), _f(p0[1]), _f(c[0]), _f(c[1]), _f(p3[0]), _f(p3[1]))
        sk.path(d)
        sk.head(p3[0], p3[1], math.atan2(p3[1] - c[1], p3[0] - c[0]))
        if ed["label"]:
            lines = _label_lines(ed["label"], 90)
            sk.label(c[0] + vx / vl * 16, c[1] + vy / vl * 8, lines)
    # centre doodle: circular arrow glyph text
    if dg["title"] and n >= 3:
        lines = wrap_text(dg["title"], max(120, 2 * rx - bw - 40), 20, "kb", 2)
        ty = cy0 - (len(lines) - 1) * 12 + 6
        for l in lines:
            sk.text(cx0, ty, l, 20, "kb", "middle", "#8d8372")
            ty += 24
    return sk.out(), W, H


def _svg_tree(dg: dict, W: float) -> tuple[str, float, float]:
    sk = Sketch(_seed("tree", dg["title"], *[n["label"] for n in dg["nodes"]]))
    nodes = dg["nodes"]
    n = len(nodes)
    idx = {nd["id"]: i for i, nd in enumerate(nodes)}
    parent = {}
    elabel = {}
    for ed in dg["edges"]:
        a, b = idx[ed["from"]], idx[ed["to"]]
        elabel[(a, b)] = ed["label"]
        if b not in parent and a != b:
            parent[b] = a
    # break cycles
    for i in range(n):
        seen, p = {i}, parent.get(i)
        while p is not None:
            if p in seen:
                parent.pop(i, None)
                break
            seen.add(p)
            p = parent.get(p)
    roots = [i for i in range(n) if i not in parent]
    if not dg["edges"]:
        roots = [0]
        for i in range(1, n):
            parent[i] = 0
    children = {i: [] for i in range(n)}
    for c, p in parent.items():
        children[p].append(c)
    for p in children:
        children[p].sort()
    # depth
    depth = {}
    def dfs_depth(i, d):
        depth[i] = d
        for c in children[i]:
            dfs_depth(c, d + 1)
    for r in roots:
        dfs_depth(r, 0)
    maxd = max(depth.values())
    # leaf slots
    slot = {}
    counter = [0]
    def assign(i):
        if not children[i]:
            slot[i] = float(counter[0])
            counter[0] += 1
        else:
            for c in children[i]:
                assign(c)
            slot[i] = (slot[children[i][0]] + slot[children[i][-1]]) / 2
    for r in roots:
        assign(r)
    nslots = max(counter[0], 1)
    gap = 18
    bw = min(176, max(96, (W - gap * (nslots - 1)) / nslots))
    natural = nslots * bw + (nslots - 1) * gap
    VW = max(W, natural)
    for nd in nodes:
        b = _node_box(nd, bw, max_label=3, max_det=3, pad=8)
        nd["_ll"], nd["_dl"], nd["_h"] = b["ll"], b["dl"], b["h"]
    level_h = [max([nodes[i]["_h"] for i in range(n) if depth[i] == d] or [40]) for d in range(maxd + 1)]
    vgap = 56
    ys, y = [], 8
    for d in range(maxd + 1):
        ys.append(y)
        y += level_h[d] + vgap
    H = y - vgap + 12
    def cx(i):
        return (VW - natural) / 2 + bw / 2 + slot[i] * (bw + gap)
    for i, nd in enumerate(nodes):
        _draw_node(sk, nd, cx(i) - bw / 2, ys[depth[i]], bw, level_h[depth[i]], tint=(4, 2, 3)[min(depth[i], 2)])
    for c, p in parent.items():
        x1, y1 = cx(p), ys[depth[p]] + level_h[depth[p]] + 3
        x2, y2 = cx(c), ys[depth[c]] - 7
        mid = (y1 + y2) / 2
        sk.bezier_arrow((x1, y1), (x1, mid + 4), (x2, mid - 4), (x2, y2))
        lab = elabel.get((p, c))
        if lab:
            sk.label((x1 + x2) / 2 + 4, mid, _label_lines(lab, 90))
    return sk.out(), VW, H


def _svg_timeline(dg: dict, W: float) -> tuple[str, float, float]:
    sk = Sketch(_seed("tl", dg["title"], *[n["label"] for n in dg["nodes"]]))
    nodes = dg["nodes"]
    n = len(nodes)
    per = min(n, 4) if n <= 4 else math.ceil(n / math.ceil(n / 4))
    rows = math.ceil(n / per)
    colw = (W - 20) / per
    for nd in nodes:
        nd["_ll"] = wrap_text(nd["label"], colw - 14, 20, "kb", 2)
        nd["_dl"] = wrap_text(nd["detail"], colw - 14, 14.4, "ph", 4) if nd["detail"] else []
        nd["_h"] = len(nd["_ll"]) * 23 + (len(nd["_dl"]) * 17 + 4 if nd["_dl"] else 0)
    y = 16
    for r in range(rows):
        items = nodes[r * per:(r + 1) * per]
        ly = y + 14
        x_start, x_end = 6, W - 6
        sk.arrow([(x_start, ly), (x_end, ly)], sw=2.6)
        for c, nd in enumerate(items):
            cx = 10 + colw * (c + 0.5)
            # sketchy dot
            rr = 7.5
            sk.ellipse(cx, ly, 2 * rr, 2 * rr, fill="#fff8d6", stroke=INK, sw=2.4, hl=TINTS[4][2], hl_style="solid")
            ty = ly + 22 + 20 * 0.62
            for l in nd["_ll"]:
                sk.text(cx, ty, l, 20, "kb", "middle", INK)
                ty += 23
            for l in nd["_dl"]:
                sk.text(cx, ty + 4, l, 14.4, "ph", "middle", "#3d362f")
                ty += 17
        rh = max(nd["_h"] for nd in items)
        y = ly + 22 + rh + 22
    H = y - 6
    return sk.out(), W, H


def _text_box(sk: Sketch, ll, dl, cx, y, pad, lsize, llh, dsize, dlh, lcls="kb", color=INK):
    """Draw wrapped label (+ optional detail) lines centred on cx starting at the top edge y."""
    ty = y + pad + llh * 0.78
    for l in ll:
        sk.text(cx, ty, l, lsize, lcls, "middle", color)
        ty += llh
    if dl:
        ty += 1
        for l in dl:
            sk.text(cx, ty, l, dsize, "ph", "middle", "#3d362f")
            ty += dlh


def _mm_box(nd: dict, bw: float, lsize, llh, dsize, dlh, max_label, max_det, pad=8) -> dict:
    lw = bw - 2 * pad
    ll = wrap_text(nd["label"], lw, lsize, "kb", max_label)
    dl = wrap_text(nd["detail"], lw, dsize, "ph", max_det) if nd["detail"] else []
    h = pad + len(ll) * llh + (len(dl) * dlh + 3 if dl else 0) + pad - 1
    return {"ll": ll, "dl": dl, "h": max(h, 36)}


def _mindmap_tree(dg: dict):
    """-> (root, parent{child: parent}, depth{node: 0|1|2}); always a valid tree of depth <= 2."""
    nodes = dg["nodes"]
    n = len(nodes)
    idx = {nd["id"]: i for i, nd in enumerate(nodes)}
    par: dict[int, int] = {}
    for i, nd in enumerate(nodes):
        p = idx.get(nd.get("parent", ""))
        if p is not None and p != i:
            par[i] = p
    roots = [i for i in range(n) if i not in par]
    root = roots[0] if roots else 0
    par.pop(root, None)
    if not par and dg["edges"]:  # no parent fields: fall back to the edges (first incoming edge wins)
        for ed in dg["edges"]:
            a, b = idx[ed["from"]], idx[ed["to"]]
            if b != root and b not in par and a != b:
                par[b] = a
    for i in range(n):  # everything must reach the root (orphans / cycles hang off the root)
        if i == root:
            continue
        seen, p, ok = {i}, par.get(i), False
        while p is not None:
            if p == root:
                ok = True
                break
            if p in seen:
                break
            seen.add(p)
            p = par.get(p)
        if not ok:
            par[i] = root

    def chain(i):
        out = []
        while i != root:
            out.append(i)
            i = par[i]
        return out  # i, parent(i), ... (excluding root)

    for i in range(n):
        c = chain(i) if i != root else []
        if len(c) > 2:  # too deep: lift to depth 2 (child of the depth-1 ancestor)
            par[i] = c[-1]
    depth = {root: 0}
    for i in range(n):
        if i != root:
            depth[i] = len(chain(i))
    return root, par, depth


def _svg_mindmap(dg: dict, W: float) -> tuple[str, float, float]:
    sk = Sketch(_seed("mind", dg["title"], *[n["label"] for n in dg["nodes"]]))
    nodes = dg["nodes"]
    n = len(nodes)
    root, par, depth = _mindmap_tree(dg)
    kids = {i: [] for i in range(n)}
    for c in sorted(par):
        kids[par[c]].append(c)
    l1 = kids[root]
    has_l2 = any(kids[i] for i in l1)
    if has_l2:
        rw, w1, w2, g0, g1 = 150.0, 118.0, 108.0, 22.0, 18.0
    else:
        rw, g0 = 176.0, 46.0
        w1 = min(210.0, (W - rw - 2 * g0) / 2)
        w2, g1 = 0.0, 0.0
    # root ellipse sized for its text (a rectangle of text must fit inside the ellipse)
    rb = _mm_box(nodes[root], rw * 0.80, 18.5, 22, 13.4, 16, 3, 2, pad=2)
    th = len(rb["ll"]) * 22 + (len(rb["dl"]) * 16 + 3 if rb["dl"] else 0)
    rh = max(80.0, th / 0.72 + 10)
    box = {}
    for i in l1:
        box[i] = _mm_box(nodes[i], w1, 16.5, 19.5, 13.4, 15.5, 3, 2, pad=10)
        box[i]["h"] = max(box[i]["h"], 46)
        for c in kids[i]:
            box[c] = _mm_box(nodes[c], w2, 14.6, 17, 12.6, 14.5, 3, 2, pad=8)
            box[c]["h"] = max(box[c]["h"], 38)
    kgap, ggap = 12.0, 24.0

    def gh(i):
        ks = kids[i]
        kh = sum(box[c]["h"] for c in ks) + kgap * max(len(ks) - 1, 0)
        return max(box[i]["h"], kh)

    sides = {1: [], -1: []}
    tot = {1: 0.0, -1: 0.0}
    for i in l1:  # greedy balance by height; ties go right
        s = 1 if tot[1] <= tot[-1] else -1
        sides[s].append(i)
        tot[s] += gh(i) + ggap
    H = max(max(tot.values()) - ggap if l1 else 0, rh) + 24
    cx0, cy0 = W / 2, H / 2
    pos: dict[int, tuple] = {}  # node -> (x, y, w, h)
    for s, lst in sides.items():
        total = sum(gh(i) for i in lst) + ggap * max(len(lst) - 1, 0)
        y = cy0 - total / 2
        for i in lst:
            g = gh(i)
            yc = y + g / 2
            x1 = cx0 + s * (rw / 2 + g0) - (w1 if s < 0 else 0)
            pos[i] = (x1, yc - box[i]["h"] / 2, w1, box[i]["h"])
            ks = kids[i]
            if ks:
                kh = sum(box[c]["h"] for c in ks) + kgap * (len(ks) - 1)
                yy = yc - kh / 2
                x2 = (x1 + w1 + g1) if s > 0 else (x1 - g1 - w2)
                for c in ks:
                    pos[c] = (x2, yy, w2, box[c]["h"])
                    yy += box[c]["h"] + kgap
            y += g + ggap
    palette = (2, 3, 1, 4)
    tint_of = {}
    for k, i in enumerate(l1):
        tint_of[i] = palette[k % 4]
        for c in kids[i]:
            tint_of[c] = palette[k % 4]
    # edges first (under the boxes)
    for i in l1:
        x, y, w, h = pos[i]
        s = 1 if x > cx0 else -1
        ty = y + h / 2
        dx, dy = ((x - cx0) if s > 0 else (x + w - cx0)), ty - cy0
        t = 1.0 / math.sqrt((dx / (rw / 2)) ** 2 + (dy / (rh / 2)) ** 2) if dx or dy else 1.0
        t = min(t, 1.0)
        p0 = (cx0 + dx * t * 0.97, cy0 + dy * t * 0.97)
        p3 = (x - 2 if s > 0 else x + w + 2, ty)
        span = abs(p3[0] - p0[0])
        stroke = TINTS[tint_of[i]][1]
        sk.bezier_arrow(p0, (p0[0] + s * span * 0.55, p0[1]), (p3[0] - s * span * 0.45, p3[1]), p3, stroke=stroke, sw=2.8, head=False)
        for c in kids[i]:
            cx_, cy_, cw_, ch_ = pos[c]
            q0 = (x + w + 2, ty) if s > 0 else (x - 2, ty)
            q3 = (cx_ - 2 if s > 0 else cx_ + cw_ + 2, cy_ + ch_ / 2)
            sp2 = abs(q3[0] - q0[0])
            sk.bezier_arrow(q0, (q0[0] + s * sp2 * 0.5, q0[1]), (q3[0] - s * sp2 * 0.5, q3[1]), q3, stroke=stroke, sw=2.1, head=False)
    # root
    sk.ellipse(cx0, cy0, rw, rh, fill=TINTS[4][0], stroke=TINTS[4][1], sw=3.0, hl=TINTS[4][2])
    _text_box(sk, rb["ll"], rb["dl"], cx0, cy0 - th / 2 - 2, 0, 18.5, 22, 13.4, 16)
    for i in l1:
        x, y, w, h = pos[i]
        f, st, hl = TINTS[tint_of[i]]
        sk.rect(x, y, w, h, fill=f, stroke=st, sw=2.5, hl=hl)
        _text_box(sk, box[i]["ll"], box[i]["dl"], x + w / 2, y + (h - len(box[i]["ll"]) * 19.5 - (len(box[i]["dl"]) * 15.5 + 3 if box[i]["dl"] else 0)) / 2 - 10 + 10, 0, 16.5, 19.5, 13.4, 15.5)
        for c in kids[i]:
            x, y, w, h = pos[c]
            sk.rect(x, y, w, h, fill=f, stroke=st, sw=1.9, hl=None)
            _text_box(sk, box[c]["ll"], box[c]["dl"], x + w / 2, y + (h - len(box[c]["ll"]) * 17 - (len(box[c]["dl"]) * 14.5 + 3 if box[c]["dl"] else 0)) / 2, 0, 14.6, 17, 12.6, 14.5)
    return sk.out(), W, H


def _svg_sequence(dg: dict, W: float) -> tuple[str, float, float]:
    sk = Sketch(_seed("seq", dg["title"], *[n["label"] for n in dg["nodes"]]))
    actors = dg["nodes"]
    n = len(actors)
    idx = {a["id"]: i for i, a in enumerate(actors)}
    msgs = [m for m in dg["edges"] if m["from"] in idx and m["to"] in idx][:8]
    if not msgs:  # no messages given: chain the actors left to right
        msgs = [{"from": actors[i]["id"], "to": actors[i + 1]["id"], "label": ""} for i in range(n - 1)]
    bw = min(158.0, (W - 8) / n - 12)
    boxes = [_node_box(a, bw, max_label=2, max_det=2) for a in actors]
    ah = max(b["h"] for b in boxes)
    step = (W - 8 - bw) / (n - 1) if n > 1 else 0
    cx = [4 + bw / 2 + i * step for i in range(n)]
    y0 = 6.0
    rows, cursor = [], y0 + ah + 12
    for m in msgs:
        a, b = idx[m["from"]], idx[m["to"]]
        if a == b:  # self-call: a small loop beside the lifeline
            right = (cx[a + 1] if a + 1 < n else W - 2) - cx[a] - 58
            left = cx[a] - (cx[a - 1] if a > 0 else 2) - 58
            side = 1 if right >= left else -1
            avail = max(60.0, max(right, left))
            lines = wrap_text(m["label"], avail, 15, "cv", 4) if m["label"] else []
            lh = len(lines) * 15.75 + 2
            rows.append(dict(a=a, b=b, self=True, side=side, lines=lines, y=cursor + 4))
            cursor += max(30.0, lh) + 22
        else:
            avail = max(64.0, abs(cx[a] - cx[b]) - 22)
            lines = wrap_text(m["label"], avail, 15, "cv", 3) if m["label"] else []
            lh = len(lines) * 15.75 + 2 if lines else 0
            ay = cursor + lh + 16
            rows.append(dict(a=a, b=b, self=False, lines=lines, lh=lh, y=ay))
            cursor = ay + 18
    life_end = cursor + 2
    H = life_end + 10
    for i, a in enumerate(actors):  # actors + lifelines (under the messages)
        tf, ts_, thl = TINTS[(4, 2, 3, 1)[i % 4]]
        x = cx[i] - bw / 2
        sk.line(cx[i], y0 + ah + 2, cx[i], life_end, stroke="#7d7466", sw=1.7, dash="7 6", amp=0.8)
        sk.line(cx[i] - 7, life_end + 1, cx[i] + 7, life_end + 1, stroke="#7d7466", sw=1.7, amp=0.4)
        sk.rect(x, y0, bw, ah, fill=tf, stroke=ts_, sw=2.4, hl=thl)
        _text_box(sk, boxes[i]["ll"], boxes[i]["dl"], cx[i], y0, 10, LBL_SIZE, LBL_LH, DET_SIZE, DET_LH)
    for r in rows:
        a, b = r["a"], r["b"]
        if r["self"]:
            s, y, x = r["side"], r["y"], cx[a]
            sk.arrow([(x + s * 3, y), (x + s * 40, y), (x + s * 40, y + 20), (x + s * 7, y + 20)], sw=2.1)
            if r["lines"]:
                wmax = max(tw(l, 15, "cv") for l in r["lines"]) + 8
                sk.label(x + s * (48 + wmax / 2), y + 10, r["lines"])
            continue
        s = 1 if cx[b] > cx[a] else -1
        y = r["y"]
        sk.arrow([(cx[a] + s * 4, y), (cx[b] - s * 5, y)], sw=2.2, dash="7 5" if s < 0 else None)
        if r["lines"]:
            sk.label((cx[a] + cx[b]) / 2, y - 9 - r["lh"] / 2, r["lines"])
    return sk.out(), W, H


_BUILDERS = {"flow": _svg_flow, "stack": _svg_stack, "compare": _svg_compare, "cycle": _svg_cycle, "tree": _svg_tree, "timeline": _svg_timeline,
             "mindmap": _svg_mindmap, "sequence": _svg_sequence}


def build_diagram_svg(diagram, width: float = 690.0, css_class: str = "d") -> tuple[str, float, float] | None:
    """Return (svg_markup, vb_w, vb_h) or None. Never raises on odd input."""
    dg = _clean_diagram(diagram)
    if not dg:
        return None
    try:
        inner, vw, vh = _BUILDERS[dg["type"]](dg, width)
    except Exception:  # defensive: a broken diagram must not break the whole notebook
        try:
            inner, vw, vh = _svg_flow({**dg, "edges": []}, width)
        except Exception:
            return None
    svg = ('<svg class="%s" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %s %s" preserveAspectRatio="xMidYMid meet" role="img" aria-label="%s">%s</svg>'
           % (css_class, _f(vw), _f(vh), e(dg["title"] or "diagram"), inner))
    return svg, vw, vh


def _diagram_item(diagram) -> str:
    dg = _clean_diagram(diagram)
    if not dg:
        return ""
    res = build_diagram_svg(diagram)
    if not res:
        return ""
    svg, vw, vh = res
    title = ""
    if dg["title"] and dg["type"] not in ("stack", "cycle"):
        title = '<div class="dt">%s</div>' % e(dg["title"])
    cap = '<div class="cap">%s</div>' % e(dg["caption"]) if dg["caption"] else ""
    return '<div class="item dgm">%s%s%s</div>' % (title, svg, cap)


# ----------------------------------------------------------------------------------------------
# page furniture (rings, borders, underline squiggles)
# ----------------------------------------------------------------------------------------------
@lru_cache(maxsize=1)
def _rings_svg() -> str:
    r = random.Random(7)
    parts = []
    for i in range(24):
        cy = 36 + i * 45.9
        cx = 27 + r.uniform(-1, 1)
        d = ""
        steps = 46
        for s in range(steps + 1):
            t = s / steps
            ang = t * 2 * math.pi * 2.6 + r.uniform(0, .1)
            rad = 3 + 9 * t + r.uniform(-.9, .9)
            x, y = cx + math.cos(ang) * rad * 1.15, cy + math.sin(ang) * rad * .95
            d += ("M" if s == 0 else "L") + "%s %s" % (_f(x), _f(y))
        parts.append('<path d="%s" fill="none" stroke="#6f6454" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>' % d)
        parts.append('<circle cx="%s" cy="%s" r="2.2" fill="#3a332b" opacity=".75"/>' % (_f(cx), _f(cy)))
    return '<svg class="rings" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 1122" aria-hidden="true">%s</svg>' % "".join(parts)


def _underline_svg(seed: str, width: float = 690, sw: float = 3.2) -> str:
    sk = Sketch(_seed("ul", seed))
    d = sk.line_d(2, 6, width - 2, 5, amp=1.8)
    d2 = sk.line_d(width * 0.04, 8.5, width * 0.9, 7.5, amp=1.4)
    return ('<svg class="ul" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %s 12" preserveAspectRatio="none" aria-hidden="true">'
            '<path d="%s" fill="none" stroke="%s" stroke-width="%s" stroke-linecap="round"/>'
            '<path d="%s" fill="none" stroke="%s" stroke-width="1.4" stroke-linecap="round" opacity=".55"/></svg>') % (
        _f(width), d, INK, _f(sw), d2, INK)


def _cover_border_svg() -> str:
    sk = Sketch(_seed("cover-border"))
    sk.rect(66, 54, 672, 1004, fill="none", stroke=INK, sw=3.4, double=True)
    sk.rect(76, 64, 652, 984, fill="none", stroke=INK, sw=2.0, double=False)
    return '<svg class="border" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 794 1122" aria-hidden="true">%s</svg>' % sk.out_plain()


# ----------------------------------------------------------------------------------------------
# block renderers
# ----------------------------------------------------------------------------------------------
_SENT = re.compile(r"(?<=[.!?\u3002])\s+(?=[A-Z\u201c\"'(\[0-9])")


def _sentences(text: str) -> list[str]:
    parts = _SENT.split(text)
    out: list[str] = []
    buf = ""
    for p in parts:
        buf = (buf + " " + p).strip() if buf else p
        if buf.count("**") % 2 == 0 and buf.count("`") % 2 == 0:
            out.append(buf)
            buf = ""
    if buf:
        out.append(buf)
    return out


def _b_paragraph(b) -> str:
    t = _s(b.get("text"))
    if not t:
        return ""
    sents = _sentences(t) if len(t) > 180 else [t]
    spans = "".join('<span class="s">%s </span>' % rich(x) for x in sents)
    return ('<div class="item blk b-para" data-split="1" data-minkeep="2" data-minmove="2"><p class="sb para">%s</p></div>' % spans)


def _b_bullets(b) -> str:
    items = [_s(i) for i in _list(b.get("items")) if _s(i)]
    if not items:
        return ""
    lis = "".join("<li>%s</li>" % rich(i) for i in items)
    return '<div class="item blk b-bullets" data-split="1" data-minkeep="2" data-minmove="2"><ul class="sb">%s</ul></div>' % lis


def _b_steps(b) -> str:
    items = [_s(i) for i in _list(b.get("items")) if _s(i)]
    if not items:
        return ""
    lis = "".join('<li><span class="num">%d</span>%s</li>' % (n, rich(i)) for n, i in enumerate(items, 1))
    return '<div class="item blk b-steps" data-split="1" data-minkeep="2" data-minmove="2"><ol class="sb">%s</ol></div>' % lis


def _b_definition(b) -> str:
    term, text = _s(b.get("term")), _s(b.get("text"))
    if not (term or text):
        return ""
    return ('<div class="item blk b-def"><div class="box"><span class="tag">def.</span><span class="term">%s</span> \u2014 %s</div></div>' % (e(term), rich(text)))


def _b_example(b) -> str:
    title, text = _s(b.get("title")), _s(b.get("text"))
    if not (title or text):
        return ""
    t = '<span class="ex-t">e.g. %s</span>' % e(title) if title else '<span class="ex-t">e.g.</span>'
    return '<div class="item blk b-ex"><div class="box">%s%s</div></div>' % (t, rich(text))


_CALL_LABEL = {"note": "note to self", "warning": "watch out!", "tip": "pro tip"}


def _b_callout(b, n: int) -> str:
    text = _s(b.get("text"))
    if not text:
        return ""
    style = _s(b.get("style")).lower()
    if style not in _CALL_LABEL:
        style = "note"
    return ('<div class="item blk b-call %s t%d"><div class="box"><span class="lbl">%s</span><span class="tx">%s</span></div></div>'
            % (style, 1 + n % 2, e(_CALL_LABEL[style]), rich(text)))


def _b_code(b) -> str:
    code = str(b.get("code") if b.get("code") is not None else "").replace("\r\n", "\n").replace("\r", "\n").expandtabs(4).strip("\n")
    if not code.strip():
        return ""
    lines = code.split("\n")[:160]
    lines = [l if len(l) <= 400 else l[:399] + "\u2026" for l in lines]
    lang = _s(b.get("language"))[:24]
    body = "".join('<div class="ln">%s</div>' % (e(l) if l.strip() else "&nbsp;") for l in lines)
    tag = '<span class="lang">%s</span>' % e(lang) if lang else ""
    return ('<div class="item blk b-code" data-split="1" data-minkeep="4" data-minmove="3"><div class="box">%s<div class="sb">%s</div></div></div>' % (tag, body))


def _b_table(b) -> str:
    headers = [_s(h) for h in _list(b.get("headers"))]
    rows = [r for r in _list(b.get("rows")) if isinstance(r, list)][:60]
    ncol = max([len(headers)] + [len(r) for r in rows] + [1])
    if not headers and not rows:
        return ""
    headers = (headers + [""] * ncol)[:ncol]
    thead = "<thead><tr>%s</tr></thead>" % "".join("<th>%s</th>" % rich(h) for h in headers) if any(headers) else ""
    trs = ""
    for r in rows:
        cells = ([_s(c) for c in r] + [""] * ncol)[:ncol]
        trs += "<tr>%s</tr>" % "".join("<td>%s</td>" % rich(c) for c in cells)
    return ('<div class="item blk b-table" data-split="1" data-minkeep="3" data-minmove="2"><table>%s<tbody class="sb">%s</tbody></table></div>' % (thead, trs))


def _b_formula(b) -> str:
    t = _s(b.get("text"))
    if not t:
        return ""
    return '<div class="item blk b-formula"><div class="box">%s</div></div>' % e(t)


def _render_blocks(blocks: list) -> list[str]:
    out, ncall = [], 0
    for b in blocks:
        if not isinstance(b, dict):
            continue
        typ = _s(b.get("type")).lower()
        if typ == "paragraph":
            h = _b_paragraph(b)
        elif typ == "bullets":
            h = _b_bullets(b)
        elif typ == "steps":
            h = _b_steps(b)
        elif typ == "definition":
            h = _b_definition(b)
        elif typ == "example":
            h = _b_example(b)
        elif typ == "callout":
            h = _b_callout(b, ncall)
            ncall += 1
        elif typ == "code":
            h = _b_code(b)
        elif typ == "table":
            h = _b_table(b)
        elif typ == "formula":
            h = _b_formula(b)
        else:
            h = ""
        if h:
            out.append(h)
    return out


# ----------------------------------------------------------------------------------------------
# document assembly
# ----------------------------------------------------------------------------------------------
def _title_class(t: str) -> str:
    n = len(t)
    return "" if n <= 24 else ("m" if n <= 38 else "s")


def _head(num, title: str, subtitle: str, ts: str, seed: str) -> str:
    num_s = ("%s. " % e(num)) if num not in (None, "") else ""
    sub = '<span class="sub">\u2014 %s</span>' % e(subtitle) if subtitle else ""
    tss = '<span class="ts">\u25f7 %s</span>' % e(ts) if ts else ""
    return ('<div class="item sec-head" data-keep="1"><h2 class="%s">%s%s</h2>%s%s%s</div>'
            % (_title_class(num_s + title), num_s, e(title), sub, tss, _underline_svg(seed, 690)))


def _takeaways(items) -> str:
    items = [_s(i) for i in _list(items) if _s(i)][:6]
    if not items:
        return ""
    lis = "".join("<li>%s</li>" % rich(i) for i in items)
    return '<div class="item take"><div class="tt">\u2605 to remember</div><ul>%s</ul></div>' % lis


def _recall(r) -> str:
    r = _dict(r)
    q, a = _s(r.get("q")), _s(r.get("a"))
    if not (q or a):
        return ""
    return ('<div class="item recall"><div class="box"><div class="rt">\u2605 recall question</div>'
            '<div class="q">Q: %s</div><div class="a">A: %s</div></div></div>' % (rich(q), rich(a)))


def _section_unit(sec: dict, i: int) -> str:
    sec = _dict(sec)
    num = sec.get("number")
    if not isinstance(num, (int, float)) or isinstance(num, bool):
        num = _s(num) or (i + 2)
    num = int(num) if isinstance(num, float) and num == int(num) else num
    title = _s(sec.get("title")) or "section %s" % num
    items = [_head(num, title, _s(sec.get("subtitle")), _s(sec.get("timestamp")), "%s|%s" % (num, title))]
    blocks = _render_blocks(_list(sec.get("blocks")))
    dg = _diagram_item(sec.get("diagram"))
    first_is_para = blocks and 'b-para' in blocks[0][:60]
    if first_is_para:
        items.append(blocks.pop(0))
    if dg:
        items.append(dg)
    items.extend(blocks)
    items.append(_takeaways(sec.get("key_takeaways")))
    items.append(_recall(sec.get("recall")))
    nxt = _s(sec.get("next"))
    return ('<div class="unit" data-kind="section" data-num="%s" data-title="%s" data-next="%s">%s</div>'
            % (e(num), e(title), e(nxt), "".join(x for x in items if x)))


def _glossary_unit(gl) -> str:
    rows = []
    for g in _list(gl):
        if not isinstance(g, dict):
            continue
        t, d = _s(g.get("term")), _s(g.get("definition"))
        if t or d:
            rows.append('<div class="item gl-row"><span class="t">%s</span><span class="d">%s</span></div>' % (rich(t), rich(d)))
    if not rows:
        return ""
    head = _head(None, "glossary", "words worth knowing", "", "glossary")
    return '<div class="unit" data-kind="glossary" data-num="" data-title="glossary">%s%s</div>' % (head, "".join(rows))


def _recap_unit(rc) -> str:
    rc = _dict(rc)
    pts = [_s(p) for p in _list(rc.get("points")) if _s(p)]
    dg = _diagram_item(rc.get("diagram"))
    if not pts and not dg:
        return ""
    title = _s(rc.get("title")) or "the whole picture, recapped"
    items = [_head(None, title, "", "", "recap|" + title)]
    if pts:
        lis = "".join('<li><span class="num">%d</span>%s</li>' % (n, rich(p)) for n, p in enumerate(pts, 1))
        items.append('<div class="item blk recap-pts" data-split="1" data-minkeep="2" data-minmove="2"><ol class="sb" style="list-style:none;margin:0;padding:0">%s</ol></div>' % lis)
    if dg:
        items.append(dg)
    return '<div class="unit" data-kind="recap" data-num="" data-title="%s">%s</div>' % (e(title), "".join(items))


def _fmt_date(s: str) -> str:
    try:
        d = _dt.datetime.strptime(s[:10], "%Y-%m-%d")
        return d.strftime("%b %Y")
    except Exception:
        return s


def _cover_unit(notes: dict, title: str) -> str:
    meta, cover = _dict(notes.get("meta")), _dict(notes.get("cover"))
    tagline = _s(cover.get("tagline")) or "a student's own field notebook \u2014"
    subtitle = _s(meta.get("subtitle"))
    n = len(title)
    tsize = 80 if n <= 14 else 68 if n <= 20 else 58 if n <= 28 else 48 if n <= 40 else 40 if n <= 60 else 33
    info = " \u00b7 ".join(x for x in [_s(meta.get("channel")), ("%s lecture" % _s(meta.get("duration"))) if _s(meta.get("duration")) else "", _s(meta.get("language"))] if x)
    # diagram: first section diagram, else a generic sketch
    dg = None
    for s in _list(notes.get("sections")):
        d = _clean_diagram(_dict(s).get("diagram"))
        if d and d["type"] not in ("stack", "sequence", "mindmap"):
            dg = d
            break
    if dg is None:
        dg = {"type": "flow", "title": "", "caption": "",
              "nodes": [{"id": "a", "label": "the lecture", "detail": ""}, {"id": "b", "label": "these notes", "detail": ""}, {"id": "c", "label": "recall & revise", "detail": ""}],
              "edges": [{"from": "a", "to": "b", "label": ""}, {"from": "b", "to": "c", "label": ""}]}
    dg = {**dg, "nodes": [{**nd, "detail": trunc(nd["detail"], 38)} for nd in dg["nodes"]], "title": ""}
    res = build_diagram_svg(dg, 600.0, "d")
    dsvg = res[0] if res else ""
    dcap = '<div class="cap">%s</div>' % e(dg["caption"]) if dg.get("caption") else ""
    toc = [_s(t) for t in _list(cover.get("toc")) if _s(t)][:24]
    if not toc:
        toc = ["%s. %s" % (_dict(s).get("number", i + 2), _s(_dict(s).get("title"))) for i, s in enumerate(_list(notes.get("sections"))[:24])]
    cls = "" if len(toc) <= 11 else ("two" if len(toc) <= 18 else "two many")
    toc_html = "".join("<li>%s</li>" % e(t) for t in toc)
    idea = _s(cover.get("big_idea"))
    summ = _s(cover.get("summary"))
    sticky = '<div class="cv-idea">%s</div>' % e(trunc(idea, 90)) if idea else ""
    howto = ('<div class="cv-how"><div class="rt">\u2605 recall question</div><div class="q">Q: How do I use this book?</div>'
             'A: After each page, close it and explain the page out loud in 30 seconds. Every page ends with one recall question.</div>')
    summary = '<div class="cv-sum">%s</div>' % e(trunc(summ, 200)) if summ else ""
    date = _fmt_date(_s(meta.get("generated_on")))
    date_html = '<div class="cv-date">\u2014 field notes%s</div>' % (", " + e(date) if date else "")
    toc_title = "what's inside \u2014 read top to bottom"
    body = (
        '<div class="page cover">' + _rings_svg() + '%s<div class="cv-in">'
        '<div class="cv-tag">%s</div><div class="cv-title" style="font-size:%dpx">%s</div>%s'
        '%s%s'
        '<div class="cv-dgm">%s%s</div>'
        '<div class="cv-low"><div><h3>%s</h3><ul class="cv-toc %s">%s</ul></div><div class="cv-side">%s%s%s</div></div>'
        '</div>%s</div>'
    ) % (
        _cover_border_svg(), e(tagline), tsize, e(title), _underline_svg("cover-title", 600, 4.2).replace('class="ul"', 'class="cv-ul"'),
        ('<div class="cv-sub">%s</div>' % e(trunc(subtitle, 140))) if subtitle else "",
        ('<div class="cv-info">%s</div>' % e(info)) if info else "",
        dsvg, dcap, e(toc_title), cls, toc_html, sticky, howto, summary, date_html,
    )
    return '<div class="unit" data-kind="cover">%s</div>' % body


@lru_cache(maxsize=1)
def _rough_js() -> str:
    """Rough.js (MIT, templates/vendor/rough.js), inlined so previews and PDFs work offline.

    Returns "" when the file is missing; diagrams then keep their plain-SVG strokes."""
    try:
        src = (TPL_DIR / "vendor" / "rough.js").read_text(encoding="utf-8")
    except OSError:
        return ""
    return src.replace("</script", "<\\/script")


def _build(notes: dict, for_print: bool) -> str:
    notes = _dict(notes)
    meta = _dict(notes.get("meta"))
    title = _s(meta.get("title")) or "Lecture notes"
    units = [_cover_unit(notes, title)]
    for i, sec in enumerate(_list(notes.get("sections"))):
        units.append(_section_unit(sec, i))
    units.append(_glossary_unit(notes.get("glossary")))
    units.append(_recap_unit(notes.get("recap")))
    css = (TPL_DIR / "notebook.css").read_text(encoding="utf-8")
    js = (TPL_DIR / "notebook.js").read_text(encoding="utf-8")
    rough = _rough_js()
    rough_tag = ("<script>%s</script>\n" % rough) if rough else ""
    return (
        '<!DOCTYPE html>\n<html lang="%s" data-print="%s" data-doc-title="%s">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>%s \u2014 notebook</title>\n'
        '<style>%s</style>\n<style>%s</style>\n</head>\n<body>\n'
        '<template id="rings-tpl">%s</template>\n<div id="source">%s</div>\n<div id="pages"></div>\n%s<script>%s</script>\n</body>\n</html>\n'
    ) % (e(_s(meta.get("language")) or "en"), "1" if for_print else "0", e(title), e(title), _font_css(), css,
         _rings_svg(), "".join(u for u in units if u), rough_tag, js)


def render_html(notes: dict, *, for_print: bool = False) -> str:
    """Full self-contained HTML (fonts embedded as base64). Pagination runs in the browser."""
    return _build(notes, for_print)


# ----------------------------------------------------------------------------------------------
# PDF via headless Edge / Chrome
# ----------------------------------------------------------------------------------------------
def _find_browser() -> str:
    env = os.environ.get("LNAI_BROWSER")
    cands = [env] if env else []
    cands += [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    ]
    for c in cands:
        if c and os.path.isfile(c):
            return c
    for name in ("msedge", "microsoft-edge", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"):
        p = shutil.which(name)
        if p:
            return p
    raise PdfError("No Edge or Chrome installation was found; install Microsoft Edge or Google Chrome to create PDFs.")


def _pdf_ok(path: str) -> tuple[bool, int, int]:
    """(consistent, pages, declared_total). Consistent == every page carries 'pg. N / M' with M == pages."""
    try:
        import pymupdf  # type: ignore
        doc = pymupdf.open(path)
    except Exception:
        return False, 0, 0
    n = len(doc)
    totals = set()
    ok = n > 0
    for i, pg in enumerate(doc):
        m = re.search(r"pg\.\s*(\d+)\s*/\s*(\d+)", pg.get_text())
        if not m or int(m.group(1)) != i + 1:
            ok = False
        else:
            totals.add(int(m.group(2)))
    doc.close()
    ok = ok and totals == {n}
    return ok, n, (next(iter(totals)) if len(totals) == 1 else 0)


def render_pdf(notes: dict, out_path: str) -> str:
    """Render ``notes`` to an A4 PDF at ``out_path`` (returns the path)."""
    try:
        exe = _find_browser()
        html_doc = _build(notes, True)
    except PdfError:
        raise
    except Exception as ex:  # pragma: no cover
        raise PdfError("Could not build the notebook layout: %s" % type(ex).__name__) from ex
    out_path = str(out_path)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="lnai_pdf_")
    try:
        hp = os.path.join(tmp, "notebook.html")
        with open(hp, "w", encoding="utf-8") as fh:
            fh.write(html_doc)
        tmp_pdf = os.path.join(tmp, "notebook.pdf")
        uri = Path(hp).as_uri()
        last_err = ""
        for attempt, budget in enumerate((20000, 60000)):
            prof = os.path.join(tmp, "profile%d" % attempt)
            cmd = [exe, "--headless=new", "--disable-gpu", "--no-pdf-header-footer", "--no-first-run", "--no-default-browser-check",
                   "--disable-extensions", "--disable-background-networking", "--hide-scrollbars", "--force-color-profile=srgb",
                   "--user-data-dir=" + prof, "--virtual-time-budget=%d" % budget, "--print-to-pdf=" + tmp_pdf, uri]
            try:
                if os.path.exists(tmp_pdf):
                    os.remove(tmp_pdf)
                subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180, check=False)
            except subprocess.TimeoutExpired:
                last_err = "the browser timed out"
                continue
            except OSError as ex:
                raise PdfError("Could not start the browser: %s" % type(ex).__name__) from ex
            if os.path.isfile(tmp_pdf) and os.path.getsize(tmp_pdf) > 1000:
                ok, n, tot = _pdf_ok(tmp_pdf)
                if ok:
                    break
                last_err = "page numbering check failed (%d pages, declared %d)" % (n, tot)
            else:
                last_err = "the browser produced no output"
        else:
            raise PdfError("PDF rendering failed: %s" % last_err)
        shutil.move(tmp_pdf, out_path)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return out_path
