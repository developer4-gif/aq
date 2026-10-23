"""Notes JSON validation / coercion (schema: docs/notes-schema.md).

``validate_notes`` is deliberately forgiving: LLM output is messy, so we coerce
instead of rejecting.  It only raises ``ValueError`` when nothing usable is left
(no sections at all).

Decisions worth knowing (all deterministic, no network):
* Section numbers are always re-assigned 2, 3, 4 ... (page 1 is the cover).
* ``cover.toc`` and every section's ``next`` line are always rebuilt from the
  final section list, so they can never drift from what the LLM wrote
  (sections may be dropped/merged during coercion).
* ``meta`` facts (title, channel, duration, url, language) come from the
  transcript when given; the LLM only contributes the subtitle.
"""
from __future__ import annotations

import datetime as _dt
import json
import re
from typing import Any

# ---------------------------------------------------------------- limits ----
MAX_SECTIONS = 24
MAX_BLOCKS = 14
MAX_ITEMS = 12
MAX_NODES = 8
MAX_MINDMAP_NODES = 10   # root + up to 9 others
MINDMAP_MAX_DEPTH = 2    # root = depth 0
MAX_SEQ_ACTORS = 5
MAX_SEQ_MESSAGES = 8
MAX_LABEL = 40
MAX_GLOSSARY = 30
MAX_RECAP_POINTS = 8
MAX_TAKEAWAYS = 4

BLOCK_TYPES = ("paragraph", "bullets", "steps", "definition", "example",
               "callout", "code", "table", "formula")
DIAGRAM_TYPES = ("flow", "stack", "compare", "cycle", "tree", "timeline", "mindmap", "sequence")

DEFAULT_TAGLINE = "a student's own field notebook —"
DEFAULT_RECAP_TITLE = "the whole picture, recapped"

_BLOCK_ALIASES = {
    "text": "paragraph", "p": "paragraph", "para": "paragraph", "prose": "paragraph",
    "list": "bullets", "bullet": "bullets", "bullet_list": "bullets", "ul": "bullets",
    "points": "bullets", "numbered": "steps", "ol": "steps", "step": "steps",
    "process": "steps", "numbered_list": "steps", "def": "definition",
    "term": "definition", "snippet": "code", "codeblock": "code",
    "code_block": "code", "eq": "formula", "equation": "formula",
    "math": "formula", "tbl": "table", "sticky": "callout",
}
_CALLOUT_TYPES = {"note": "note", "info": "note", "warning": "warning",
                  "warn": "warning", "caution": "warning", "tip": "tip",
                  "hint": "tip", "important": "warning"}
_DIAGRAM_ALIASES = {
    "flowchart": "flow", "process": "flow", "pipeline": "flow",
    "mind_map": "mindmap", "mind": "mindmap", "concept_map": "mindmap",
    "sequence_diagram": "sequence", "sequencediagram": "sequence",
    "layers": "stack", "layer": "stack", "architecture": "stack",
    "comparison": "compare", "versus": "compare", "vs": "compare", "table": "compare",
    "loop": "cycle", "circular": "cycle", "hierarchy": "tree", "graph": "tree",
    "time": "timeline", "history": "timeline",
}

_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_WS = re.compile(r"\s+")
_NUM_PREFIX = re.compile(r"^\s*(?:pg\.?\s*)?\d{1,2}\s*[.):\-–]\s+")


# --------------------------------------------------------------- helpers ----
def _to_str(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return str(v)
    if isinstance(v, (list, tuple)):
        return " ".join(_to_str(x) for x in v if x is not None)
    if isinstance(v, dict):
        for k in ("text", "label", "title", "content", "value"):
            if k in v:
                return _to_str(v[k])
        return ""
    return str(v)


def _clip(s: str, n: int) -> str:
    if len(s) <= n:
        return s
    cut = s[: max(1, n - 1)]
    sp = cut.rfind(" ")
    if sp > n * 0.6:
        cut = cut[:sp]
    return cut.rstrip(" ,;:-") + "…"


def _line(v: Any, n: int = 400) -> str:
    """Single-line cleaned string, capped at n chars."""
    s = _CTRL.sub("", _to_str(v))
    return _clip(_WS.sub(" ", s).strip(), n)


def _multiline(v: Any, n: int) -> str:
    s = _CTRL.sub("", _to_str(v)).replace("\r\n", "\n").replace("\r", "\n").replace("\t", "    ")
    s = s.strip("\n")
    return s[:n]


def _str_list(v: Any, max_items: int = MAX_ITEMS, max_len: int = 300) -> list[str]:
    if v is None:
        return []
    if isinstance(v, str):
        parts = [p for p in re.split(r"\n+", v) if p.strip()]
        v = [re.sub(r"^\s*(?:[-*•]|\d+[.)])\s+", "", p) for p in parts]
    if isinstance(v, dict):
        v = list(v.values())
    if not isinstance(v, (list, tuple)):
        v = [v]
    out = []
    for item in v:
        s = _line(item, max_len)
        if s:
            out.append(s)
        if len(out) >= max_items:
            break
    return out


def _dict(v: Any) -> dict:
    return v if isinstance(v, dict) else {}


def _strip_num(title: str) -> str:
    return _NUM_PREFIX.sub("", title).strip()


def format_duration(sec: Any) -> str:
    """Seconds -> 'h:mm:ss' (e.g. 4983 -> '1:23:03'); '' when unknown."""
    try:
        total = int(round(float(sec)))
    except (TypeError, ValueError):
        return ""
    if total < 0:
        return ""
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}"


def _timestamp(v: Any) -> str:
    """Normalise to 'mm:ss' or 'h:mm:ss'; '' if not parseable."""
    if v is None or v == "":
        return ""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        total = int(v)
    else:
        s = _to_str(v).strip().strip("[]")
        m = re.fullmatch(r"(?:(\d+):)?(\d{1,3}):(\d{1,2})", s)
        if m:
            h = int(m.group(1) or 0)
            total = h * 3600 + int(m.group(2)) * 60 + int(m.group(3))
        elif re.fullmatch(r"\d+(?:\.\d+)?", s):
            total = int(float(s))
        else:
            return ""
    if total < 0:
        return ""
    h, rem = divmod(total, 3600)
    mm, ss = divmod(rem, 60)
    return f"{h}:{mm:02d}:{ss:02d}" if h else f"{mm:02d}:{ss:02d}"


def _slug(s: str) -> str:
    s = re.sub(r"[^a-z0-9_]+", "_", s.lower()).strip("_")
    return s[:20]


# ---------------------------------------------------------------- blocks ----
def _coerce_table(b: dict) -> dict | None:
    headers = _str_list(b.get("headers") or b.get("columns"), 8, 60)
    rows_raw = b.get("rows") or b.get("data") or []
    rows: list[list[str]] = []
    if isinstance(rows_raw, list):
        for r in rows_raw:
            if isinstance(r, dict):
                r = [r.get(h, "") for h in headers] if headers else list(r.values())
            if not isinstance(r, (list, tuple)):
                r = [r]
            rows.append([_line(c, 100) for c in r])
            if len(rows) >= 12:
                break
    rows = [r for r in rows if any(c for c in r)]
    if not rows:
        return None
    if not headers:
        headers, rows = rows[0], rows[1:]
        if not rows:
            return None
    headers = headers[:8]
    n = len(headers)
    rows = [(r + [""] * n)[:n] for r in rows]
    return {"type": "table", "headers": headers, "rows": rows}


def _coerce_block(b: Any) -> dict | None:
    if isinstance(b, str):
        t = _line(b, 1200)
        return {"type": "paragraph", "text": t} if t else None
    if not isinstance(b, dict):
        return None
    raw_type = _line(b.get("type"), 40).lower().replace("-", "_").replace(" ", "_")
    style = None
    if raw_type in _CALLOUT_TYPES:  # e.g. {"type": "tip", ...} -> callout/tip
        style = _CALLOUT_TYPES[raw_type]
        raw_type = "callout"
    btype = _BLOCK_ALIASES.get(raw_type, raw_type)
    if btype not in BLOCK_TYPES:
        return None

    if btype == "paragraph":
        t = _line(b.get("text") or b.get("content"), 1200)
        return {"type": "paragraph", "text": t} if t else None
    if btype in ("bullets", "steps"):
        items = _str_list(b.get("items") if b.get("items") is not None else b.get("points") or b.get("steps"))
        return {"type": btype, "items": items} if items else None
    if btype == "definition":
        term = _line(b.get("term") or b.get("title"), 80)
        text = _line(b.get("text") or b.get("definition") or b.get("content"), 500)
        return {"type": "definition", "term": term, "text": text} if term and text else None
    if btype == "example":
        text = _line(b.get("text") or b.get("content"), 800)
        if not text:
            return None
        return {"type": "example", "title": _line(b.get("title"), 80) or "example", "text": text}
    if btype == "callout":
        text = _line(b.get("text") or b.get("content"), 500)
        if not text:
            return None
        st = style or _CALLOUT_TYPES.get(_line(b.get("style"), 20).lower(), "note")
        return {"type": "callout", "style": st, "text": text}
    if btype == "code":
        code = _multiline(b.get("code") or b.get("text") or b.get("content"), 3000)
        if not code.strip():
            return None
        lang = _line(b.get("language") or b.get("lang"), 20).lower() or "text"
        return {"type": "code", "language": lang, "code": code}
    if btype == "table":
        return _coerce_table(b)
    if btype == "formula":
        t = _line(b.get("text") or b.get("formula") or b.get("content"), 300)
        return {"type": "formula", "text": t} if t else None
    return None


# --------------------------------------------------------------- diagram ----
_CHILD_KEYS = ("children", "subtopics", "branches", "subnodes")
_PARENT_KEYS = ("parent", "parent_id", "parentId")


def _node_fields(n: Any) -> tuple[str, str, str]:
    """(label, detail, original id) of a raw node (dict or bare string)."""
    if isinstance(n, dict):
        label = _line(n.get("label") or n.get("name") or n.get("title") or n.get("text"), MAX_LABEL)
        detail = _line(n.get("detail") or n.get("description") or n.get("sub"), 100)
        return label, detail, _line(n.get("id"), 40)
    return _line(n, MAX_LABEL), "", ""


def _add_node(nodes: list, used: set, alias: dict, label: str, detail: str, orig: str, idx: int) -> dict | None:
    """Append a node with a unique slug id and register every alias the LLM may use for it."""
    if not label:
        return None
    nid = _slug(orig) or _slug(label) or f"n{idx + 1}"
    base, k = nid, 2
    while nid in used:
        nid = f"{base}_{k}"
        k += 1
    used.add(nid)
    node = {"id": nid, "label": label}
    if detail:
        node["detail"] = detail
    nodes.append(node)
    for key in (orig, orig.lower(), label, label.lower(), nid, str(idx), str(idx + 1)):
        if key and key not in alias:
            alias[key] = nid
    return node


def _resolver(alias: dict, used: set):
    def resolve(x: Any) -> str | None:
        key = _line(x, 40)
        return alias.get(key) or alias.get(key.lower()) or (key if key in used else None)
    return resolve


def _raw_edges(d: dict) -> list[dict]:
    out = []
    for e in d.get("edges") if isinstance(d.get("edges"), list) else []:
        if isinstance(e, (list, tuple)) and len(e) >= 2:
            e = {"from": e[0], "to": e[1], "label": e[2] if len(e) > 2 else None}
        if isinstance(e, dict):
            out.append(e)
    return out


def _edge_ends(e: dict) -> tuple[Any, Any]:
    return e.get("from", e.get("source", e.get("src"))), e.get("to", e.get("target", e.get("dst")))


def _coerce_mindmap(d: dict) -> dict | None:
    """Tree stored as ``parent`` fields. Accepts parent fields, nested ``children`` and parent->child edges.

    Root = the node without a parent (first one if several; the first node if a cycle leaves none);
    other parentless nodes attach to it.  Depth <= MINDMAP_MAX_DEPTH, <= MAX_MINDMAP_NODES nodes.
    """
    raw_nodes = d.get("nodes")
    if isinstance(raw_nodes, dict):
        raw_nodes = [raw_nodes]
    if not isinstance(raw_nodes, list) and isinstance(d.get("root"), dict):
        raw_nodes = [d["root"]]
    if not isinstance(raw_nodes, list):
        return None

    # 1. flatten, breadth first (so the node cap keeps every top-level branch before deep leaves)
    entries: list[dict] = []
    queue = [(n, None) for n in raw_nodes]
    qi = 0
    while qi < len(queue) and len(entries) < 200:
        n, nested_parent = queue[qi]
        qi += 1
        label, detail, orig = _node_fields(n)
        parent_raw = None
        if isinstance(n, dict):
            for k in _PARENT_KEYS:
                if _line(n.get(k), 40):
                    parent_raw = n[k]
                    break
            for k in _CHILD_KEYS:
                if isinstance(n.get(k), list):
                    queue.extend((c, len(entries)) for c in n[k])
                    break
        entries.append({"label": label, "detail": detail, "orig": orig,
                        "parent_raw": parent_raw, "nested": nested_parent})

    # 2. register nodes (entry index -> final id)
    nodes: list[dict] = []
    used: set[str] = set()
    alias: dict[str, str] = {}
    entry_id: dict[int, str] = {}
    for i, en in enumerate(entries):
        if len(nodes) >= MAX_MINDMAP_NODES:
            break
        node = _add_node(nodes, used, alias, en["label"], en["detail"], en["orig"], i)
        if node:
            entry_id[i] = node["id"]
    if len(nodes) < 2:
        return None
    resolve = _resolver(alias, used)

    # 3. parents: explicit field, else nesting, else parent->child edge
    parent: dict[str, str | None] = {}
    for i, en in enumerate(entries):
        nid = entry_id.get(i)
        if not nid:
            continue
        p = resolve(en["parent_raw"]) if en["parent_raw"] is not None else None
        if p is None and en["nested"] is not None:
            p = entry_id.get(en["nested"])
        parent[nid] = p if p != nid else None
    for e in _raw_edges(d):
        a, b = (resolve(x) for x in _edge_ends(e))
        if a and b and a != b and parent.get(b) is None:
            parent[b] = a

    # 4. break cycles, pick the root, attach orphans to it
    ids = [n["id"] for n in nodes]
    for nid in ids:
        seen: set[str] = set()
        cur: str | None = nid
        while cur is not None:
            if cur in seen:
                parent[cur] = None
                break
            seen.add(cur)
            cur = parent[cur]
    root = next(i for i in ids if parent[i] is None)  # exists: every walk above ends at a parentless node
    for nid in ids:
        if nid != root and parent[nid] is None:
            parent[nid] = root

    # 5. depth cap: deeper nodes move up to their depth-1 ancestor
    def depth(nid: str) -> int:
        n = 0
        while parent[nid] is not None:
            nid, n = parent[nid], n + 1
        return n

    for nid in ids:
        if depth(nid) > MINDMAP_MAX_DEPTH:
            anc = nid
            while parent[anc] != root:
                anc = parent[anc]
            parent[nid] = anc
    out = [dict(n) for n in nodes]
    for n in out:
        if parent[n["id"]] is not None:
            n["parent"] = parent[n["id"]]
    out.sort(key=lambda n: n["id"] != root)  # stable: root first, rest keep their order
    return {"type": "mindmap", "title": _line(d.get("title"), 60),
            "caption": _line(d.get("caption"), 160), "nodes": out, "edges": []}


def _coerce_sequence(d: dict) -> dict | None:
    """Actors (2-5) + ordered messages (<= 8). Self-messages allowed; label required (default "calls")."""
    raw_nodes = d.get("nodes") if isinstance(d.get("nodes"), list) else (
        d.get("actors") if isinstance(d.get("actors"), list) else [])
    nodes: list[dict] = []
    used: set[str] = set()
    alias: dict[str, str] = {}
    for i, n in enumerate(raw_nodes):
        if len(nodes) >= MAX_SEQ_ACTORS:
            break
        _add_node(nodes, used, alias, *_node_fields(n), i)
    resolve = _resolver(alias, used)

    edges: list[dict] = []
    for e in _raw_edges(d):
        if len(edges) >= MAX_SEQ_MESSAGES:
            break
        ends = [(resolve(x), _line(x, MAX_LABEL)) for x in _edge_ends(e)]  # (known id | None, raw name)
        if any(not rid and not name for rid, name in ends):
            continue
        new: list[str] = []  # unknown actors this message would add
        for rid, name in ends:
            if not rid and name.lower() not in (x.lower() for x in new):
                new.append(name)
        if len(nodes) + len(new) > MAX_SEQ_ACTORS:  # no room: drop the message
            continue
        made = {}
        for name in new:
            node = _add_node(nodes, used, alias, name, "", "", len(nodes))
            made[name.lower()] = node["id"]  # type: ignore[index]
        a, b = (rid or made[name.lower()] for rid, name in ends)
        edges.append({"from": a, "to": b,
                      "label": _line(e.get("label") or e.get("message") or e.get("text"), 40) or "calls"})
    if len(nodes) < 2:
        return None
    if not edges:  # keep the diagram drawable: one message between neighbouring actors
        edges = [{"from": nodes[i]["id"], "to": nodes[i + 1]["id"], "label": "calls"}
                 for i in range(min(len(nodes) - 1, MAX_SEQ_MESSAGES))]
    return {"type": "sequence", "title": _line(d.get("title"), 60),
            "caption": _line(d.get("caption"), 160), "nodes": nodes, "edges": edges}


def _coerce_diagram(d: Any) -> dict | None:
    if not isinstance(d, dict):
        return None
    raw_type = _line(d.get("type"), 20).lower().replace("-", "_").replace(" ", "_")
    dtype = _DIAGRAM_ALIASES.get(raw_type, raw_type)
    if dtype not in DIAGRAM_TYPES:
        dtype = "flow"
    if dtype == "mindmap":
        return _coerce_mindmap(d)
    if dtype == "sequence":
        return _coerce_sequence(d)

    raw_nodes = d.get("nodes")
    if not isinstance(raw_nodes, list):
        return None
    nodes: list[dict] = []
    used: set[str] = set()
    alias: dict[str, str] = {}  # any identifier the LLM used -> final id
    for i, n in enumerate(raw_nodes):
        if len(nodes) >= MAX_NODES:
            break
        _add_node(nodes, used, alias, *_node_fields(n), i)
    if len(nodes) < 2:
        return None
    resolve = _resolver(alias, used)

    edges: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for e in _raw_edges(d):
        a, b = (resolve(x) for x in _edge_ends(e))
        if not a or not b or a == b or (a, b) in seen:  # self-edges are dropped (sequence only allows them)
            continue
        seen.add((a, b))
        edge = {"from": a, "to": b}
        lab = _line(e.get("label"), 30)
        if lab:
            edge["label"] = lab
        edges.append(edge)

    ids = [n["id"] for n in nodes]
    if not edges:  # sensible default wiring so the renderer always has arrows
        if dtype == "flow":
            edges = [{"from": ids[i], "to": ids[i + 1]} for i in range(len(ids) - 1)]
        elif dtype == "cycle":
            edges = [{"from": ids[i], "to": ids[(i + 1) % len(ids)]} for i in range(len(ids))]
        elif dtype == "tree":
            edges = [{"from": ids[0], "to": x} for x in ids[1:]]

    return {"type": dtype, "title": _line(d.get("title"), 60),
            "caption": _line(d.get("caption"), 160), "nodes": nodes, "edges": edges}


# -------------------------------------------------------------- sections ----
def _coerce_section(s: Any) -> dict | None:
    if not isinstance(s, dict):
        return None
    title = _strip_num(_line(s.get("title") or s.get("heading"), 80))
    blocks: list[dict] = []
    raw_blocks = s.get("blocks")
    if isinstance(raw_blocks, dict):
        raw_blocks = [raw_blocks]
    block_diagram = None
    for b in raw_blocks if isinstance(raw_blocks, list) else []:
        if isinstance(b, dict) and b.get("type") == "diagram":
            # models sometimes put the diagram inside blocks, flat or wrapped in "detail"/"diagram"
            inner = b.get("detail") or b.get("diagram") or b
            if isinstance(inner, dict) and inner.get("type") == "diagram":
                inner = {**inner, "type": inner.get("diagram_type") or inner.get("kind") or "flow"}
            block_diagram = block_diagram or _coerce_diagram(inner)
            continue
        cb = _coerce_block(b)
        if cb:
            blocks.append(cb)
        if len(blocks) >= MAX_BLOCKS:
            break
    diagram = _coerce_diagram(s.get("diagram")) or block_diagram
    takeaways = _str_list(s.get("key_takeaways") or s.get("takeaways"), MAX_TAKEAWAYS, 220)
    if not (blocks or diagram or takeaways):
        return None
    if not title:
        title = "untitled section"

    rc = _dict(s.get("recall"))
    q = _line(rc.get("q") or rc.get("question"), 260)
    a = _line(rc.get("a") or rc.get("answer"), 500)
    if q and a:
        recall: dict | None = {"q": q, "a": a}
    elif takeaways:  # derive a minimal explain-it-back prompt from the notes themselves
        recall = {"q": f"In your own words: what is the key idea of “{_clip(title, 60)}”?",
                  "a": takeaways[0]}
    else:
        recall = None

    return {
        "number": 0,  # assigned later
        "title": title,
        "subtitle": _line(s.get("subtitle"), 90),
        "timestamp": _timestamp(s.get("timestamp") or s.get("start")),
        "blocks": blocks,
        "diagram": diagram,
        "key_takeaways": takeaways,
        "recall": recall,
        "next": "",
    }


def _unwrap(raw: Any) -> dict:
    if isinstance(raw, (str, bytes)):
        try:
            raw = json.loads(raw)
        except Exception as e:  # noqa: BLE001
            raise ValueError("notes are not valid JSON") from e
    if not isinstance(raw, dict):
        raise ValueError("notes must be a JSON object")
    for key in ("notes", "result", "data"):
        inner = raw.get(key)
        if "sections" not in raw and isinstance(inner, dict) and "sections" in inner:
            return inner
    return raw


# ------------------------------------------------------------------ main ----
def validate_notes(raw: dict, transcript: dict | None = None, *, model: str | None = None) -> dict:
    """Coerce ``raw`` into the contract schema. Raises ValueError if unusable.

    ``model`` (optional, keyword) sets ``meta.model`` (e.g. "groq/llama-3.3-70b-versatile");
    otherwise any value present in ``raw['meta']['model']`` is kept.
    """
    raw = _unwrap(raw)
    t = transcript or {}
    rmeta, rcover = _dict(raw.get("meta")), _dict(raw.get("cover"))

    sections: list[dict] = []
    raw_sections = raw.get("sections")
    if isinstance(raw_sections, dict):
        raw_sections = list(raw_sections.values())
    for s in raw_sections if isinstance(raw_sections, list) else []:
        cs = _coerce_section(s)
        if cs:
            sections.append(cs)
        if len(sections) >= MAX_SECTIONS:
            break
    if not sections:
        raise ValueError("notes contain no usable sections")

    recap_raw = _dict(raw.get("recap"))
    recap_title = _line(recap_raw.get("title"), 80) or DEFAULT_RECAP_TITLE

    for i, sec in enumerate(sections):
        sec["number"] = i + 2  # page 1 is the cover
    for i, sec in enumerate(sections):
        if i + 1 < len(sections):
            nxt = sections[i + 1]
            sec["next"] = f"pg. {nxt['number']}: {nxt['title']}"
        else:
            sec["next"] = f"pg. {sec['number'] + 1}: {recap_title}"

    glossary, seen_terms = [], set()
    gl = raw.get("glossary")
    if isinstance(gl, dict):  # {"term": "definition"} form
        gl = [{"term": k, "definition": v} for k, v in gl.items()]
    for g in gl if isinstance(gl, list) else []:
        if not isinstance(g, dict):
            continue
        term = _line(g.get("term"), 60)
        definition = _line(g.get("definition") or g.get("text"), 300)
        if term and definition and term.lower() not in seen_terms:
            seen_terms.add(term.lower())
            glossary.append({"term": term, "definition": definition})
        if len(glossary) >= MAX_GLOSSARY:
            break

    points = _str_list(recap_raw.get("points"), MAX_RECAP_POINTS, 260)
    if not points:  # fall back to the first takeaway of each section
        points = [sec["key_takeaways"][0] for sec in sections if sec["key_takeaways"]][:MAX_RECAP_POINTS]
    recap = {"title": recap_title, "points": points, "diagram": _coerce_diagram(recap_raw.get("diagram"))}

    title = _line(t.get("title"), 120) or _line(rmeta.get("title"), 120) or sections[0]["title"]
    duration = format_duration(t.get("duration_sec")) if t.get("duration_sec") is not None else ""
    if not duration:
        d = _line(rmeta.get("duration"), 12)
        duration = d if re.fullmatch(r"\d+:\d{2}(:\d{2})?", d) else ""
    meta = {
        "title": title,
        "subtitle": _line(rmeta.get("subtitle") or rcover.get("subtitle"), 140),
        "source_url": _line(t.get("url"), 300) or _line(rmeta.get("source_url"), 300),
        "channel": _line(t.get("channel"), 100) or _line(rmeta.get("channel"), 100),
        "duration": duration,
        "language": _line(t.get("language"), 16) or _line(rmeta.get("language"), 16) or "en",
        "generated_on": _dt.date.today().isoformat(),
        "model": _line(model, 120) or _line(rmeta.get("model"), 120),
    }

    summary = _line(rcover.get("summary"), 600)
    big_idea = _line(rcover.get("big_idea"), 120)
    if not big_idea and sections[0]["key_takeaways"]:
        big_idea = _clip(sections[0]["key_takeaways"][0], 120)
    cover = {
        "tagline": _line(rcover.get("tagline"), 80) or DEFAULT_TAGLINE,
        "summary": summary,
        "big_idea": big_idea,
        "toc": [f"{sec['number']}. {sec['title']}" for sec in sections],
    }
    return {"meta": meta, "cover": cover, "sections": sections, "glossary": glossary, "recap": recap}
