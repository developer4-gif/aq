# Changes: Dashboard, Streak Tracker, Glass Nav Bar and Faster, Better Notes

Branch: `feature/dev-tools`

## 1. Dashboard (new)
Route: `#/dashboard`. Files: `lecture-notes-ui/dashboard.js`, `dashboard.css`.

- Shows a greeting based on the time of day.
- Responsive grid: 3 columns on desktop, 2 on tablet, 1 on phone.
- The streak card sits in the top-left corner. The other slots ("Continue learning", "Weekly activity", "Goals", "Recent notes") are placeholders for upcoming cards.
- `#/ai` and `#/goals` show "coming soon" pages for now.

## 2. Daily streak tracker (new)
Files: `lecture-notes-ui/streak.js`, `streak.css`.

| Feature | Details |
|---|---|
| Current streak | Big counter with an animated flame. The flame grows at 1, 7, 30 and 100 days, and turns blue-white at 100+. |
| "Keep it alive" | Today is empty but yesterday was active: the card shows the hours left today, so the streak isn't broken yet. |
| Stats | Longest streak, active days, total activities, this week vs last week. |
| This week | 7 dots, today ringed. |
| Year view | GitHub-style heatmap of 52 weeks with 5 intensity levels. Hover or focus a day for a tooltip. Arrow keys move between days. |
| Month view | LeetCode-style calendar. Consecutive active days join into a pill. Browse back up to 24 months. |
| Badges | Spark (7), Blaze (30), Inferno (100), Supernova (365), with a progress bar to the next one. |
| Celebration | A small burst on the first activity of the day. Respects reduced motion. |

- **What counts as activity:** watching a lecture, finishing a notes job, and creating or importing a playlist. The hooks are in `app.js`.
- **Storage:** data stays in the browser (`localStorage` key `aq.activity.v1`) and uses local dates.
- **Demo data:** add `?demo=streak` to the URL to fill the tracker with sample history. This overwrites your real activity history in that browser.
- **Not yet active:** streak freezes are stored but don't protect a streak.

## 3. Bottom nav bar with a liquid-glass lens (new)
Files: `lecture-notes-ui/navbar.js`, `navbar.css`. Preview: `navbar-demo.html`.

- **Buttons:** Dashboard, AI and Playlists, as icons only. The Playlists button opens the main playlists page.
- **Lens:** a glass lens that overflows the pill. It has a bright rim, blue refraction caps, and a magnified copy of the icons inside it.
- **Motion:** a soft spring with a gentle overshoot. The lens stretches and squashes with speed, smoothed to avoid jitter, and it is centred exactly on each icon.
- **Input:** you can drag the lens, use the arrow keys or Home/End, or click. It follows `role=tablist` for accessibility.
- **Performance:**
  - The page changes about 300 ms after the click, so rendering heavy pages doesn't make the glide stutter.
  - The per-frame `backdrop-filter` and `drop-shadow` were removed.
- **Pages without a tab:** the lens fades out (`setActive(null)`).

## 4. Notes generation: faster and better (Gemini)
Files: `lecture-notes-ai/notes_engine/llm.py`, `prompts.py`, `notes_schema.py`.

### Speed
| Lecture | Before | After |
|---|---|---|
| 60 min (Karpathy, Intro to LLMs) | ~31 s | **~7 s** |
| 17 min (Essence of Calculus) | ~28 s | ~5–8 s |
| 18 min (Neural Networks) | not measured | ~6 s |

How the speedup works:

- **Structured output.** Gemini requests now send `responseJsonSchema`, so the JSON always comes back valid. This removes the old second "repair JSON" call, which was the main cost. If the API rejects the schema, the request falls back to plain JSON mode.
- **Parallel single pass.** A lecture is split by time into up to 4 slices that are written at the same time, plus one call for the cover, glossary and recap.
- **Safety limits:**
  - Each slice has an output cap, and a truncated answer is salvaged.
  - Calls time out after 45 s and are retried.
  - When a topic is split across two slices, the two halves are merged back into one section.
  - For very long lectures, the map-reduce digests also run in parallel.
- **Other providers unchanged:** Groq, NVIDIA, Colab, xAI and Hugging Face keep their old behaviour.

### Content
- Brief and dense: one fact per bullet, at most 20 words, telegraphic. At most one framing paragraph of 2 sentences per section, and 3–6 blocks per section.
- No transcript phrasing such as "the speaker says" or "let's". No filler, and no fact repeated anywhere in the notebook.
- Formulas are written with symbols (`A = πr²`). Worked examples use `example` blocks.
- Each section has 2–3 short "remember" lines and a recall question.
- Noise is removed: sponsors, greetings, "like and subscribe".
- **New:** `cover.takeaways` holds the 4–6 key points of the whole lecture. The field is optional, so older notes still validate. It is documented in `docs/notes-schema.md`.

## 5. Notes layout: compact, with no wasted space
Files: `notes_engine/pdf.py`, `templates/notebook.css`, `templates/notebook.js`.

- Sections flow one after another instead of each starting on a new page. The 60-minute sample went from **23 pages to 13**.
- A heading always moves to the next page together with its first block, so no heading is left alone at the bottom of a page. "Continued" appears only when a block is actually split.
- Tighter A4 margins, smaller headings (29 px) and body text of 15.5 px with a tight line height.
- Definition, example, formula, callout and recall boxes are more compact. Callouts are full width with no ragged gaps.
- Short bullet lists are shown in 2 columns.
- Diagrams are capped at 400 px tall and never split across pages.
- The cover's side column has a **★ key takeaways** box, filled from `cover.takeaways`.
- Unknown block types are rendered as text instead of being dropped.
- Rendering is faster, because the old loop that re-ran each section at several zoom levels was removed.

## Tests
- `lecture-notes-ai`: `python -m pytest -q` gives **390 passed** (7 new LLM tests and new layout tests).
- `node --check` passes on all new UI files.

## Known limits / next ideas
- **Narrow notes panel:** pages are scaled A4, so the text is small. "Open in new tab" shows it full size.
- **Gemini free tier:** a lecture now sends up to 5 requests at once, so you may hit the per-minute limit. A 429 is retried automatically.
- **No automatic provider switch yet.** The proposed "smart switch" would try Gemini, then NVIDIA, then Groq, and remember which provider is down.
- **Dashboard cards still to come:** goals, time studied, continue learning, course completion and review reminders.
