"""out/evaluation.json -> D:\\AQspace\\aq-api\\dev-ui\\eval-data.json (no transcripts, no notes bodies, no keys)."""
from __future__ import annotations

import json
import re

import common as C
import evaluate


def main() -> None:
    ev = C.read_json(C.OUT / "evaluation.json") or evaluate.aggregate()
    data = json.loads(json.dumps(ev))  # deep copy
    data["schema"] = "aq-notes-eval/1"
    text = json.dumps(data, ensure_ascii=False)
    # defence in depth: refuse to publish anything that looks like a key
    if re.search(r"AIza[0-9A-Za-z_\-]{20,}|gsk_[A-Za-z0-9]{20,}|nvapi-[A-Za-z0-9_\-]{20,}|hf_[A-Za-z0-9]{20,}", text):
        raise SystemExit("refusing to write eval-data.json: key-like string found")
    for v in C._KEYS.values():
        if len(v) >= 12 and v in text:
            raise SystemExit("refusing to write eval-data.json: key value found")
    C.write_json(C.DEV_UI / "eval-data.json", data)
    print("wrote", C.DEV_UI / "eval-data.json", len(text), "bytes")


if __name__ == "__main__":
    C.key("GEMINI_API_KEY")  # loads key values so the leak check can compare against them
    main()
