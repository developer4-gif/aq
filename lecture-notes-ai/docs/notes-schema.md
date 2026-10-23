# Notes JSON schema

The structure `llm.py` produces, `notes_schema.validate_notes` enforces, and `pdf.py` renders. Each section is roughly one notebook page.

```jsonc
{
  "meta":   { "title": str, "subtitle": str, "source_url": str, "channel": str, "duration": "1:23:45",
              "language": "en", "generated_on": "2026-10-23", "model": "provider/model" },
  "cover":  { "tagline": "a student's own field notebook —", "summary": str (2-3 sentences),
              "big_idea": str (one-line sticky-note text, e.g. "same backend serves every screen!"),
              "toc": [ "2. architecture, the 30,000ft map", ... ] },
  "sections": [ {
      "number": 2, "title": "architecture, the 30,000ft map", "subtitle": "one process, one DB", "timestamp": "04:12",
      "blocks": [
         {"type":"paragraph","text": str},
         {"type":"bullets","items":[str,...]},
         {"type":"steps","items":[str,...]},                       // numbered, ordered process
         {"type":"definition","term": str,"text": str},
         {"type":"example","title": str,"text": str},
         {"type":"callout","style":"note|warning|tip","text": str},  // yellow sticky
         {"type":"code","language": str,"code": str},                // only if lecture shows code
         {"type":"table","headers":[str],"rows":[[str]]},
         {"type":"formula","text": str}
      ],
      "diagram": null | { "type": "flow|stack|compare|cycle|tree|timeline|mindmap|sequence",
                          "title": str, "caption": str,
                          "nodes": [ {"id": "a", "label": str, "detail": str?, "parent": "id"?} ],   // <= 8 nodes (mindmap 10, sequence 2-5), labels <= 40 chars
                          "edges": [ {"from":"a","to":"b","label": str?} ] },          // optional for stack/compare/timeline; [] for mindmap
      "key_takeaways": [str, ...],                                                      // 2-4
      "recall": { "q": str, "a": str },                                                 // the "★ recall question" yellow box
      "next": "pg. 3: the tech stack behind each box"
  } ],
  "glossary": [ {"term": str, "definition": str} ],
  "recap":    { "title": "the whole picture, recapped", "points": [str,...], "diagram": null | <same diagram object> }
}
```

## Diagram types

All diagrams share `{type, title, caption, nodes, edges}`. `validate_notes` coerces whatever the model sends (ids are slugged and de-duplicated, edges may reference ids, labels or 0/1-based indexes, unresolvable edges are dropped, fewer than 2 nodes means no diagram). Accepted aliases for `type`: `flowchart`/`process`/`pipeline` -> flow, `layers`/`architecture` -> stack, `comparison`/`vs` -> compare, `loop` -> cycle, `hierarchy`/`graph` -> tree, `time`/`history` -> timeline, `mind map`/`mind-map`/`mind_map`/`concept map` -> mindmap, `sequence diagram`/`sequence-diagram` -> sequence. Unknown types fall back to flow. Spaces and hyphens in `type` are treated as underscores.

| type | use it for | nodes | edges |
|---|---|---|---|
| `flow` | a process | <= 8 steps | arrows (default: chain) |
| `stack` | layered architecture | <= 8, top to bottom | optional |
| `compare` | side-by-side contrast | <= 8, left to right | optional |
| `cycle` | a repeating loop | <= 8 | arrows (default: ring) |
| `tree` | a hierarchy | <= 8 | parent -> child (default: first node is the parent of all) |
| `timeline` | chronology | <= 8, earliest to latest | optional |
| `mindmap` | a topic overview with sub-ideas | <= 10 | always `[]`; the tree lives in `parent` |
| `sequence` | request/response or step-by-step exchanges between actors | 2-5 actors | <= 8 ordered messages |

Self-edges (`from == to`) are dropped for every type except `sequence`.

### mindmap

```jsonc
{ "type": "mindmap", "title": "caching", "caption": "",
  "nodes": [ {"id": "root", "label": "caching"},                       // root: the only node without "parent"
             {"id": "where", "label": "where it lives", "parent": "root"},
             {"id": "cdn", "label": "CDN", "detail": "edge copies", "parent": "where"} ],
  "edges": [] }
```

* `parent` must reference an existing node id. Unknown or self parents count as "no parent".
* Root: the single parentless node. If there are several, the first one is the root and the others attach to it; if there is none (a parent cycle), the first node is the root. The root is always written first.
* Depth <= 2 (root = 0). Deeper nodes are re-parented to their depth-1 ancestor. At most 10 nodes (breadth first, so every top-level branch survives before deep leaves).
* Also accepted on input and converted to `parent` fields: nested `"children": [...]` lists (items may be strings), a single root object instead of a `nodes` list, and parent -> child `edges`. The output `edges` is always `[]`.

### sequence

```jsonc
{ "type": "sequence", "title": "login", "caption": "",
  "nodes": [ {"id": "app", "label": "client"}, {"id": "api", "label": "server"}, {"id": "db", "label": "database"} ],
  "edges": [ {"from": "app", "to": "api", "label": "POST /login"},
             {"from": "api", "to": "api", "label": "hash password"},      // self-message
             {"from": "api", "to": "db",  "label": "find user"},
             {"from": "api", "to": "app", "label": "token"} ] }
```

* `nodes` are the actors (left to right), at most 5; `edges` are the messages in time order, at most 8. Order and repeats are kept (no de-duplication).
* `label` is required for messages; a missing one becomes `"calls"`. Messages with an empty endpoint are dropped.
* An endpoint that is not a known actor is added as a new actor if there is room, otherwise the whole message is dropped. If no message survives, one `"calls"` message per neighbouring actor pair is generated.
* `validate_notes(validate_notes(x))` is stable for both new types.
