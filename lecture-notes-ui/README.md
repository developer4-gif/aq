# AQ Learning - playlists screen

The in-app **Playlists** screen: an all-black app UI where you group YouTube lectures into playlists, watch them in order and request hand-drawn notes. Plain HTML/CSS/JS, no build step, no npm.

(The old marketing landing page is preserved in `_landing-backup/` - `index.html`, `styles.css`, `app.js`, `resources.js`.)

## Run

1. (For "Get notes") start the notes server: `D:\AQspace\lecture-notes-ai\start.ps1` and keep it open (listens on http://127.0.0.1:5055).
2. Serve this folder: `powershell -ExecutionPolicy Bypass -File .\serve.ps1`
3. Open **http://127.0.0.1:5173/** (or http://localhost:5173/).

**With the application backend (recommended):** `cd D:\AQspace\aq-api; npm start`, then open **http://127.0.0.1:5180/** - it serves this UI and the API from one origin. `api.js` then syncs playlists and watch progress with the server (localStorage stays as offline cache; existing local data is imported once), and "Get notes" / "Import from YouTube" go through the API, which caches notes per video. Without the backend the UI works exactly as before (steps 1-3 above). See `D:\AQspace\aq-api\README.md`.

Do not open index.html by double-click: the notes API only accepts `localhost` / `127.0.0.1` origins, and a `file://` page sends `Origin: null`, which it rejects.

## Screens (hash routing, single page)

| Route | Screen |
|---|---|
| `#/` | **Playlists home**: top bar (logo, search by name, avatar placeholder), "Your playlists" + count + the glass **New playlist** button, grid of **chroma cards** (full-bleed first-video thumbnail, greyscale at rest; the pointer reveals colour through a soft spotlight and a per-playlist accent glow; name, "N videos · duration", **watch progress** bar "x of N watched / %", card menu with Rename / Delete-with-confirm), dashed "+ Create playlist" card, empty state. |
| `#/playlist/<id>` | **Playlist detail**: "← Playlists", name, description, stats, actions **Add video / Play all / Rename / Delete**. Video rows: number, thumbnail, title, channel, duration, **Watch / Get notes / Edit / Move up / Move down / Remove** (remove has Undo), drag-and-drop reordering (mouse) plus the Move buttons (keyboard / touch). Empty playlist shows an inline add form. |
| dialogs | Create/rename playlist (name required, max 60, unique case-insensitive; description max 160), edit video (title, channel, optional duration `m:ss` / `h:mm:ss`), delete confirm, player (youtube-nocookie embed, previous/next through the playlist, switch to notes). Focus is trapped, Esc closes, focus returns to the opener. |

### Effects

- **Chroma cards** (`app.js` + `.pcard*` in `styles.css`): pointer-tracking spotlight that un-greys the cover, accent pair derived from the playlist id. Static when `prefers-reduced-motion`.
- **Glass New playlist button** (`water.js`): iOS-style liquid glass with SVG refraction, spring hover (swell, wobble, pointer-following rim light) and a jelly press feel. **Click** briefly brightens the rim, the form opens immediately and the global click spark is the click effect.
- **Click sparks** (`clickspark.js`): small spark burst on every click anywhere (except text fields, selects and elements with `data-no-spark`; it fires on the glass button too).

**Import from YouTube** (`importpl.js`, button next to "New playlist"): paste a playlist link, "Fetch" (calls the notes server `GET /api/playlist?url=...`), preview (title, channel, N videos, total time, first thumbnails), edit the name (unique-name rule; "Title (2)" is suggested when taken) and description, then "Import N videos" creates a local copy with one storage write (`AQ.store.createWithVideos(name, desc, videos, source)`; `AQ.store.addVideos(pid, list)` is the batch add) and opens it. The playlist records `source: {type:"youtube", listId, url, importedAt}` and its detail header shows an "Imported from YouTube" badge + "Open on YouTube". Nothing syncs back; you can still add your own videos. Needs the notes server (restart it after updating so the new endpoint exists).

Adding a video: paste a YouTube link (watch / youtu.be / shorts / embed / bare 11-char id). The id is validated, duplicates in the same playlist are rejected, and title/channel come from `https://www.youtube.com/oembed`. If that fails the video is added as "YouTube video <id>" and an "Edit details" link lets you fix the title (oEmbed has no duration, so duration is optional and edited by hand).

## Data model

Stored in `localStorage` key **`aq.playlists.v1`** (JSON array). Seeded on first run only (when the key is absent) with Data Science (`data-science`), AI & Agents (`ai-agents`), Programming (`programming`). If storage is blocked or full the app keeps working in memory and shows a banner.

```
Playlist = { id, name, description, created, updated, videos: [Video] }   // id = slug [a-z0-9-], used in the route
Playlist may also carry  source?: { type: "youtube", listId, url, importedAt }   // set by "Import from YouTube"
Video    = { id /* 11-char YouTube id */, title, channel, duration /* "m:ss" | "h:mm:ss" | "" */, added }
```

Everything read from storage is sanitised (bad ids, duplicate videos, over-long text dropped/trimmed). Changes made in another tab are picked up via the `storage` event. To reset: delete the key in DevTools > Application > Local Storage (the seed comes back).

## Where things live

| File | What to change there |
|---|---|
| `index.html` | page shell: top bar, `#view` (screens are rendered into it), modal markup, script order |
| `styles.css` | tokens at the top (`--bg`, `--panel`, `--white`, `--line`, `--font-display`, radii...), then top bar / grid / rows / modal / responsive sections |
| `util.js` | DOM helpers (`el`, `icon`, `button`), YouTube id parser, thumbnail URL, duration + "time ago" formatting |
| `store.js` | data layer: seed data (`seedData`), sanitising, CRUD (`create/update/remove`, `addVideo/removeVideo/updateVideo/moveVideo`), persistence, limits (`LIMITS`) |
| `api.js` | adapter for the aq-api backend: detects it, loads/migrates data, write-through queue (`AQ.api.record`), `AQ.api.available()` |
| `dialog.js` | accessible modal host (focus trap, Esc, restore focus) + `confirm` |
| `player.js` | player dialog (embed, previous/next, notes switch) |
| `notes.js` | "Get notes" client for the notes API |
| `water.js` | glass "New playlist" button: `AQ.water.button(label, {icon, onActivate})`; hover springs, lens, jelly press |
| `clickspark.js` | click sparks everywhere (vanilla port of React Bits ClickSpark; look = `DEFAULTS` at the top, or `AQ.clickSpark.configure({...})`) |
| `app.js` | router + rendering: home grid with chroma cards, watch progress, card menu, playlist form, detail, add form, rows, drag and drop, toasts |
| `screenshots/` | reference screenshots of the screens and effects |
| `_landing-backup/` | previous landing page, untouched |

All user text is inserted with `textContent` / DOM APIs; there is no `innerHTML`.

## Notes API

`POST http://127.0.0.1:5055/api/jobs {url, provider:"groq"}` then poll `GET /api/jobs/<id>` every 2 s; on `done` the PDF link is `/api/jobs/<id>/notes.pdf`. The notes server needs a Groq key in its `backend/.env` (or the request is rejected with a clear message, which the dialog shows). If the server is down the dialog says to start `start.ps1`. Jobs are kept per video id, so closing the dialog does not lose progress.
