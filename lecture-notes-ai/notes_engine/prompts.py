"""Prompt templates for Lecture Notes AI.

Pipeline shapes (llm.py decides which one runs):
  single-pass : compose_single_messages        -> full Notes JSON
  map-reduce  : digest_messages  (per chunk)   -> {"topics": [...]}   (compact facts)
                compose_batch_messages (batch) -> {"sections": [...]}
                compose_final_messages         -> {subtitle, cover, glossary, recap}

All builders return ``(system, user)`` strings.  Every prompt demands JSON only.
"""
from __future__ import annotations

import json
import math
from typing import Any

# ------------------------------------------------------------ shared text ----
RULES = """\
You write STUDY NOTES from a lecture/video transcript, in the voice of a diligent student's hand-written field notebook: terse, concrete, well organised, lower-case friendly section titles (like "architecture, the 30,000ft map" or "session & auth").

HARD RULES
1. KNOWLEDGE ONLY. Keep only what teaches something: concepts, definitions, mechanisms, steps, trade-offs, numbers, examples that illuminate, code the speaker actually shows. DROP completely: greetings/intros/outros, "welcome back", like/subscribe/bell asks, sponsors and ads, channel/course/merch promos, housekeeping, jokes, rambling, repeated restatements, personal anecdotes with no teaching value, "as I said earlier", filler. Never write a section about these.
2. FAITHFUL. Every claim, number, name, command and code line must come from the transcript. Do NOT add outside facts, do not "improve" the lecture with your own knowledge, do not guess what was unclear (leave it out). If the speaker misspeaks or the auto-captions garble a technical term, fix only the obvious spelling (e.g. "cooper netties" -> "Kubernetes") when the context makes it certain.
3. REWRITE, never transcribe. Compress into clear study-note prose and structured blocks. Do not copy more than a short phrase verbatim. Write facts directly ("TCP retransmits lost segments"), never "the speaker says / in this video / we will see / let's", no rhetorical questions, no hype words.
4. LANGUAGE: write the notes in English (translate if the lecture is in another language, keeping original technical terms and proper nouns). Plain text only inside strings: no markdown, no HTML, no emoji. Write math with symbols, not words, in plain text/Unicode (e.g. "dA ≈ 2πr·dr", "A = πr²", "dA/dx = x²", never "2 pi times r"); no LaTeX backslashes.
5. STRUCTURE. A section is about one notebook page: one coherent topic, 3-6 blocks mixing types (paragraph, bullets, steps, definition, example, callout, code, table, formula). Use `steps` for ordered processes, `table` for comparisons of 2+ things across attributes, `formula` for every equation/quantitative relation stated, `example` for a concrete worked example or analogy the lecture gives (with its numbers), `code` ONLY for code shown in the lecture (omit otherwise), `callout` (note|warning|tip) for pitfalls and rules of thumb the speaker stresses. Never pad. BRIEF & DENSE: prefer `bullets` over prose; each bullet is ONE fact in <= 20 words, telegraphic study-note style (drop "basically", "really", "actually", "so"). At most one framing `paragraph` per section, <= 2 sentences. State every fact once in the whole notebook (no repetition across sections; takeaways must not copy a bullet word for word). Section titles follow the lecture's own order of topics.
6. DIAGRAMS. Give a section a `diagram` when it teaches a process (flow), layered architecture (stack), side-by-side contrast (compare), repeating loop (cycle), hierarchy (tree), chronology (timeline), a topic overview with sub-ideas (mindmap) or request/response / step-by-step exchanges between actors (sequence). One diagram per such section; `null` when there is nothing structural to draw. Max 8 nodes (mindmap 10; sequence 2-5 actors, <= 8 messages); node `label` <= 40 chars (short noun phrases, no sentences); optional `detail` <= 80 chars; ids are short lowercase ([a-z0-9_]); every edge `from`/`to` must be an existing node id. flow/cycle/tree need edges; stack/compare/timeline edges are optional (list nodes in order: top->bottom, left->right, earliest->latest). sequence: nodes are the actors, edges are the messages in time order, each with a short `label`. mindmap: `edges` is [], one root node (no `parent`), every other node has `parent` = an existing id, at most 2 levels deep.
7. EVERY section ends with 2-3 `key_takeaways` (the "remember" lines: one crisp line each, <= 15 words) and exactly one `recall` question: a question a good interviewer or examiner would ask about THAT section, with a 1-3 sentence answer that is fully supported by the section's content (style: "Q: Why ...?  A: Because ...").
8. TIMESTAMPS. The transcript has inline [mm:ss] / [h:mm:ss] markers. Set each section's `timestamp` to the marker where its topic starts ("mm:ss" or "h:mm:ss").
9. Output ONE JSON object and nothing else (no prose, no ``` fences). Keep strings concise; do not exceed the requested number of sections."""
SECTION_EXAMPLE: dict[str, Any] = {
    "number": 2,
    "title": "architecture, the 30,000ft map",
    "subtitle": "one process, one db",
    "timestamp": "04:12",
    "blocks": [
        {"type": "paragraph", "text": "Every client talks to one Express API, which is the only thing that touches MySQL."},
        {"type": "bullets", "items": ["3 roles share one API: parent, teacher, admin", "JWT checked on every route"]},
        {"type": "definition", "term": "idempotent", "text": "Repeating the request gives the same result as sending it once."},
        {"type": "steps", "items": ["client sends JWT", "API verifies token", "route queries MySQL"]},
        {"type": "callout", "style": "tip", "text": "Screens never call fetch() directly; they go through a repository."},
        {"type": "table", "headers": ["layer", "job"], "rows": [["repository", "typed data access"], ["client.ts", "adds the JWT"]]},
        {"type": "code", "language": "js", "code": "app.use(requireAuth);"},
    ],
    "diagram": {
        "type": "flow", "title": "request path", "caption": "one backend serves every screen",
        "nodes": [{"id": "app", "label": "mobile app"}, {"id": "api", "label": "Express API", "detail": "JWT on every request"},
                  {"id": "db", "label": "MySQL"}],
        "edges": [{"from": "app", "to": "api", "label": "REST"}, {"from": "api", "to": "db"}],
    },
    "key_takeaways": ["one backend, three roles", "auth is checked on every request"],
    "recall": {"q": "Walk me through the architecture in one breath.",
               "a": "App -> repository -> client adds the JWT -> Express route -> MySQL."},
}
FRONT_EXAMPLE: dict[str, Any] = {
    "subtitle": "parent / teacher / admin app for a school",
    "cover": {"summary": "Two or three sentences on what the lecture teaches.",
              "big_idea": "same backend serves every screen!",
              "takeaways": ["one Express API is the only path to MySQL", "every request carries a JWT"]},
    "glossary": [{"term": "JWT", "definition": "Signed token that proves who the caller is."}],
    "recap": {"title": "the whole picture, recapped",
              "points": ["one-line recap point", "another"],
              "diagram": {"type": "stack", "title": "the stack", "caption": "",
                          "nodes": [{"id": "ui", "label": "screens"}, {"id": "api", "label": "API"}, {"id": "db", "label": "database"}],
                          "edges": []}},
}


def _j(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


FULL_EXAMPLE_JSON = _j({**FRONT_EXAMPLE, "sections": [SECTION_EXAMPLE]})
SECTION_EXAMPLE_JSON = _j({"sections": [SECTION_EXAMPLE]})
FRONT_EXAMPLE_JSON = _j(FRONT_EXAMPLE)


def target_section_count(duration_sec: int | None, transcript_chars: int) -> int:
    """~1 section (= 1 notebook page) per 2.5 minutes; 6..18 (dense, one idea per page)."""
    if duration_sec and duration_sec > 0:
        n = round(duration_sec / 150)
    else:
        n = round(transcript_chars / 1900)  # ~ 2.5 min of speech is ~ 1.9k chars
    return max(6, min(18, n))


def _meta_line(meta: dict) -> str:
    bits = [f"title: {meta.get('title') or 'unknown'}"]
    if meta.get("channel"):
        bits.append(f"channel: {meta['channel']}")
    if meta.get("duration"):
        bits.append(f"length: {meta['duration']}")
    return "; ".join(bits)


# ------------------------------------------------------------------ digest ----
DIGEST_SYSTEM = """\
You are the first stage of a lecture-note pipeline. You read ONE slice of a transcript and extract ONLY its teachable knowledge as compact, faithful facts that a second stage will turn into notebook pages.

Drop intros, sponsors, subscribe asks, filler, jokes, tangents and anecdotes with no teaching value. Do not invent or add outside facts; fix only obvious auto-caption spelling of technical terms. Write facts in your own short words (no long verbatim quotes), in English. Keep numbers, names, commands, versions and code exactly as stated. Use the [mm:ss] markers for `start`.
Output ONE JSON object only."""

DIGEST_SHAPE = ('{"topics":[{"heading":"short topic name","start":"mm:ss",'
                '"facts":["one self-contained fact per string"],'
                '"terms":[{"term":"x","definition":"y"}],'
                '"steps":["ordered step, only if a process was explained"],'
                '"example":"one illustrative example or null",'
                '"code":[{"language":"py","code":"only code actually shown"}],'
                '"table":{"headers":["a","b"],"rows":[["x","y"]]} or null,'
                '"formula":"only if stated or null",'
                '"diagram_hint":"if a process/architecture/comparison exists: type (flow|stack|compare|cycle|tree|timeline|mindmap|sequence) + its parts, else null"}]}')


def digest_messages(chunk_text: str, index: int, total: int, meta: dict, max_words: int) -> tuple[str, str]:
    user = f"""\
Lecture: {_meta_line(meta)}
This is slice {index + 1} of {total}. (Slices overlap slightly at the edges: do not worry about a cut-off first/last sentence.)

Extract the teachable knowledge as 1-6 topics, in order. Total output must stay under about {max_words} words, so be selective and dense: prefer facts, definitions, steps, numbers and code over narration. If the slice contains NO teachable content (pure intro/outro/sponsor), return {{"topics":[]}}.

JSON shape (omit empty/null optional fields):
{DIGEST_SHAPE}

TRANSCRIPT SLICE:
\"\"\"
{chunk_text}
\"\"\""""
    return DIGEST_SYSTEM, user


def digest_to_text(d: Any, max_chars: int) -> str:
    """Render a digest JSON as compact plain text for the compose stage (size-capped)."""
    topics = d.get("topics") if isinstance(d, dict) else None
    if not isinstance(topics, list):
        return ""
    out: list[str] = []
    for t in topics:
        if not isinstance(t, dict):
            continue
        out.append(f"## [{t.get('start') or '?'}] {t.get('heading') or 'topic'}")
        for f in t.get("facts") or []:
            out.append(f"- {f}")
        for tm in t.get("terms") or []:
            if isinstance(tm, dict):
                out.append(f"- TERM {tm.get('term')}: {tm.get('definition')}")
        if t.get("steps"):
            out.append("STEPS: " + " | ".join(str(s) for s in t["steps"]))
        if t.get("example"):
            out.append(f"EXAMPLE: {t['example']}")
        for c in t.get("code") or []:
            if isinstance(c, dict) and c.get("code"):
                out.append(f"CODE({c.get('language') or 'text'}): {str(c['code'])[:600]}")
        tb = t.get("table")
        if isinstance(tb, dict) and tb.get("rows"):
            out.append(f"TABLE: {_j(tb)}")
        if t.get("formula"):
            out.append(f"FORMULA: {t['formula']}")
        if t.get("diagram_hint"):
            out.append(f"DIAGRAM: {t['diagram_hint']}")
    text = "\n".join(out)
    return text if len(text) <= max_chars else text[: max_chars - 1].rsplit("\n", 1)[0]


# ----------------------------------------------------------------- compose ----
COMPOSE_SYSTEM = RULES


def compose_single_messages(meta: dict, transcript_text: str, n_sections: int) -> tuple[str, str]:
    lo, hi = n_sections, n_sections + 3
    user = f"""\
Lecture: {_meta_line(meta)}

Write the complete field-notebook notes for this lecture from the transcript below.
- Produce {lo}-{hi} sections, never fewer than {lo}: roughly one notebook page per 2.5 minutes of lecture, and EVERY stretch of the lecture (first [mm:ss] marker to the last) must get its own page(s) in order. Do not stop early and do not lump several topics into one section.
- `cover.summary`: 2-3 sentences on what a reader will learn. `cover.big_idea`: ONE punchy line (<= 60 chars) capturing the central idea. `cover.takeaways`: the 4-6 most important key takeaways of the whole lecture (one line each, <= 18 words). `subtitle`: a short descriptor of the lecture (<= 70 chars).
- `glossary`: 6-20 important terms actually defined/used in the lecture, one-sentence definitions.
- `recap`: title, 4-8 `points` that stitch the sections together, plus a `diagram` summarising the whole picture (or null).
- Do NOT output `meta`, `toc`, section `number` or `next`: they are generated automatically.

JSON shape and style example (content is only an illustration of FORMAT; never reuse its facts):
{FULL_EXAMPLE_JSON}

TRANSCRIPT:
\"\"\"
{transcript_text}
\"\"\""""
    return COMPOSE_SYSTEM, user


def compose_batch_messages(meta: dict, digest_text: str, n_min: int, n_max: int,
                           prior_titles: list[str], batch_no: int, batch_total: int,
                           strict: str = "") -> tuple[str, str]:
    prior = ""
    if prior_titles:
        prior = ("Sections already written earlier in the notebook (continue after them, do NOT repeat their topics):\n"
                 + "\n".join(f"- {t}" for t in prior_titles[-25:]) + "\n")
    user = f"""\
Lecture: {_meta_line(meta)}
This is part {batch_no} of {batch_total} of the lecture. Below are condensed, already-filtered fact digests (with [mm:ss] start markers) for THIS part only. Turn them into notebook sections.

{prior}Produce {n_min}-{n_max} sections for this part, NEVER fewer than {n_min}: split the digests into consecutive groups by [mm:ss] marker and give each group its own section (about one notebook page, ~2.5 minutes of lecture), so this whole part is covered from its first to its last marker. Use only the facts below. Do NOT output meta/cover/glossary/recap, section `number` or `next`.

{strict}
Output shape and style example (illustrates FORMAT only; never reuse its facts):
{SECTION_EXAMPLE_JSON}

DIGESTS:
\"\"\"
{digest_text}
\"\"\""""
    return COMPOSE_SYSTEM, user


def compose_final_messages(meta: dict, outline: list[dict], terms: list[str]) -> tuple[str, str]:
    lines = []
    for i, s in enumerate(outline):
        take = "; ".join(s.get("key_takeaways") or [])[:260]
        lines.append(f"{i + 2}. {s.get('title')} - {s.get('subtitle') or ''} | {take}")
    user = f"""\
Lecture: {_meta_line(meta)}
All sections of the notebook are already written. Below is their outline (number. title - subtitle | takeaways). Using ONLY this information, write the front matter and back matter.

- `subtitle`: short descriptor of the lecture (<= 70 chars).
- `cover.summary`: 2-3 sentences on what a reader learns. `cover.big_idea`: ONE punchy line (<= 60 chars). `cover.takeaways`: the 4-6 most important key takeaways of the whole lecture (one line each).
- `glossary`: 8-20 terms chosen from the candidate terms below (and clearly implied by the outline). One-sentence, faithful definitions; if you are not certain of a definition from the outline, skip the term.
- `recap`: title "the whole picture, recapped", 4-8 `points` that connect the sections, and a `diagram` of the whole picture (or null).
- Do NOT output sections, meta, toc or `next`.

Output shape (FORMAT illustration only):
{FRONT_EXAMPLE_JSON}

OUTLINE:
{chr(10).join(lines)}

CANDIDATE TERMS (already defined in the notes; reuse these definitions, tightened if needed):
{chr(10).join("- " + t for t in terms[:40]) or "(none)"}"""
    return COMPOSE_SYSTEM, user


def compose_part_messages(meta: dict, part_text: str, n_min: int, n_max: int,
                          part_no: int, part_total: int, strict: str = "") -> tuple[str, str]:
    """Parallel single pass: sections for ONE consecutive time slice of the raw transcript."""
    edge = []
    if part_no > 1:
        edge.append("the slice may start mid-topic (an earlier part covers what came before): do not re-introduce the lecture; if it opens mid-topic, keep that first section short and name it after that topic")
    if part_no < part_total:
        edge.append("a later part continues after the end of this slice: do not write a conclusion or summary section")
    user = f"""\
Lecture: {_meta_line(meta)}
This is transcript slice {part_no} of {part_total} (consecutive, non-overlapping; other slices are written in parallel by other writers).
Write the notebook sections for THIS slice only{"; " + "; ".join(edge) if edge else ""}.
- Produce {n_min}-{n_max} sections, NEVER fewer than {n_min}: about one notebook page per ~2.5 minutes, in lecture order, covering this slice from its first [mm:ss] marker to its last.
- Do NOT output meta/cover/glossary/recap, section `number` or `next`.
{strict}
Output shape and style example (illustrates FORMAT only; never reuse its facts):
{SECTION_EXAMPLE_JSON}

TRANSCRIPT SLICE:
\"\"\"
{part_text}
\"\"\""""
    return COMPOSE_SYSTEM, user


def compose_front_messages(meta: dict, transcript_text: str) -> tuple[str, str]:
    """Parallel single pass: cover / glossary / recap straight from the whole transcript."""
    user = f"""\
Lecture: {_meta_line(meta)}
Other writers are producing the notebook's section pages in parallel. YOUR job is only the front and back matter of the notebook, from the whole transcript below.
- `subtitle`: short descriptor of the lecture (<= 70 chars).
- `cover.summary`: 2-3 sentences on what a reader learns. `cover.big_idea`: ONE punchy line (<= 60 chars) capturing the central idea. `cover.takeaways`: the 4-6 most important key takeaways of the whole lecture (one line each, <= 18 words, concrete facts, not topic names).
- `glossary`: 8-20 important terms the lecture defines or relies on, one-sentence definitions faithful to the transcript.
- `recap`: title "the whole picture, recapped", 4-8 `points` that connect the lecture's parts in order, and a `diagram` of the whole picture (or null).
- Do NOT output sections, meta, toc or `next`.

Output shape (FORMAT illustration only; never reuse its facts):
{FRONT_EXAMPLE_JSON}

TRANSCRIPT:
\"\"\"
{transcript_text}
\"\"\""""
    return COMPOSE_SYSTEM, user


# ------------------------------------------------- Gemini response schemas ----
# Gemini's structured output (``responseJsonSchema``) guarantees syntactically valid JSON, which
# removes the costly "repair the JSON" round trip.  Shapes are permissive (one flat block object with
# optional fields); notes_schema.validate_notes still does the real coercion.
_STR = {"type": "string"}
_STRS = {"type": "array", "items": _STR}
_DIAGRAM_SCHEMA = {
    "type": ["object", "null"],
    "properties": {
        "type": {"type": "string", "enum": ["flow", "stack", "compare", "cycle", "tree", "timeline", "mindmap", "sequence"]},
        "title": _STR, "caption": _STR,
        "nodes": {"type": "array", "items": {"type": "object", "properties": {
            "id": _STR, "label": _STR, "detail": _STR, "parent": _STR}, "required": ["id", "label"]}},
        "edges": {"type": "array", "items": {"type": "object", "properties": {
            "from": _STR, "to": _STR, "label": _STR}, "required": ["from", "to"]}},
    },
    "required": ["type", "nodes", "edges"],
}
_BLOCK_SCHEMA = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": ["paragraph", "bullets", "steps", "definition", "example",
                                            "callout", "code", "table", "formula"]},
        "text": _STR, "items": _STRS, "term": _STR, "title": _STR,
        "style": {"type": "string", "enum": ["note", "warning", "tip"]},
        "language": _STR, "code": _STR,
        "headers": _STRS, "rows": {"type": "array", "items": _STRS},
    },
    "required": ["type"],
}
_SECTION_SCHEMA = {
    "type": "object",
    "properties": {
        "title": _STR, "subtitle": _STR, "timestamp": _STR,
        "blocks": {"type": "array", "items": _BLOCK_SCHEMA},
        "diagram": _DIAGRAM_SCHEMA,
        "key_takeaways": _STRS,
        "recall": {"type": "object", "properties": {"q": _STR, "a": _STR}, "required": ["q", "a"]},
    },
    "required": ["title", "timestamp", "blocks", "key_takeaways", "recall"],
}
_FRONT_PROPS = {
    "subtitle": _STR,
    "cover": {"type": "object", "properties": {"summary": _STR, "big_idea": _STR, "takeaways": _STRS},
              "required": ["summary", "big_idea", "takeaways"]},
    "glossary": {"type": "array", "items": {"type": "object", "properties": {"term": _STR, "definition": _STR},
                                            "required": ["term", "definition"]}},
    "recap": {"type": "object", "properties": {"title": _STR, "points": _STRS, "diagram": _DIAGRAM_SCHEMA},
              "required": ["title", "points"]},
}
SECTIONS_SCHEMA = {"type": "object", "properties": {"sections": {"type": "array", "items": _SECTION_SCHEMA}},
                   "required": ["sections"]}
FRONT_SCHEMA = {"type": "object", "properties": _FRONT_PROPS, "required": ["subtitle", "cover", "glossary", "recap"]}
NOTES_SCHEMA = {"type": "object",
                "properties": {**_FRONT_PROPS, "sections": SECTIONS_SCHEMA["properties"]["sections"]},
                "required": ["subtitle", "cover", "glossary", "recap", "sections"]}


FIX_JSON_SYSTEM ="You repair malformed JSON. Output ONLY the corrected JSON object: same content, valid syntax, no commentary, no code fences."


def fix_json_messages(bad_text: str, error: str) -> tuple[str, str]:
    bad = bad_text if len(bad_text) <= 24000 else bad_text[:24000]
    user = f"The following JSON failed to parse ({error}). Fix it (close unterminated strings/brackets, remove trailing commas, escape quotes/newlines in strings) and return the complete JSON object only.\n\n{bad}"
    return FIX_JSON_SYSTEM, user


def digest_word_budget(chunk_chars: int) -> int:
    """Aim for ~22% of the slice size, 150..700 words (1 word ~ 6 chars)."""
    return max(150, min(700, int(math.ceil(chunk_chars * 0.22 / 6))))
