# AQ Learning - repository overview

This repository holds two things:

1. **Google OAuth app** (`backend/`, `frontend/`, `docker-compose.yml`) - setup notes right below.
2. **AQ Learning (lecture notes)** - turns YouTube lectures into hand-drawn "field notebook" study notes. See [AQ Learning (lecture notes)](#aq-learning-lecture-notes) further down.

---

## OAuth app

### Setup
1. Google Cloud Console -> APIs & Services -> Credentials -> Create OAuth client ID (Web application)
   - Authorized JavaScript origin:  http://localhost:5173
   - Authorized redirect URI:       http://localhost:5173/api/auth/google/callback
2. Put the client id/secret in `.env` (and set a long random SESSION_SECRET)
3. `docker compose up --build`
4. Open http://localhost:5173

### Test with Postman / curl (no Google needed)
- GET  http://localhost:4000/api/health
- GET  http://localhost:4000/api/workspaces            -> 401
- POST http://localhost:4000/api/auth/dev-login        body (JSON): {"email":"a@b.com","name":"Karan"}
- GET  http://localhost:4000/api/auth/me               -> authenticated: true  (Postman keeps the cookie)
- GET  http://localhost:4000/api/workspaces            -> 200
- POST http://localhost:4000/api/auth/logout

---

## AQ Learning (lecture notes)

Paste a YouTube video or playlist and get study notes (PDF + HTML) written by the AI provider of your choice, with a notebook-style UI to browse playlists, watch the video and read the notes side by side.

### Architecture

```
 Browser (vanilla JS UI, served by the Node API)
        |
        v
 aq-api  - Node/Express app backend      http://127.0.0.1:5180   (playlists, progress, data store, serves the UI)
        |   HTTP, local only
        v
 lecture-notes-ai - Python AI worker     http://127.0.0.1:5055   (transcripts, LLM calls, notes -> PDF/HTML)
```

- **aq-api/** - Node/Express app backend. Owns app data and talks to the Python worker. Data lives in `aq-api/data/` (git-ignored).
- **lecture-notes-ai/** - Python (Flask) service plus the `notes_engine` package: fetches the transcript, calls Gemini / Groq / xAI / Hugging Face, renders the notebook PDF.
- **lecture-notes-ui/** - vanilla JS front end (no build step).
- **docs/** - architecture notes and the developer notebook.

Full details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the notebook [docs/AQ-Learning-Dev-Notebook.pdf](docs/AQ-Learning-Dev-Notebook.pdf).

### Quick start (Windows PowerShell)

Requirements: Python 3.10+, Node.js 18+.

1. Get a free API key - either one is enough:
   - Groq: https://console.groq.com/keys
   - Google Gemini: https://aistudio.google.com/apikey
2. Save it on your machine (never committed):
   ```powershell
   Copy-Item lecture-notes-ai\backend\.env.example lecture-notes-ai\backend\.env
   # then edit lecture-notes-ai\backend\.env and fill in GROQ_API_KEY= or GEMINI_API_KEY=
   ```
   You can also paste a key in the web page instead.
3. Start everything:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\start-all.ps1
   ```
   The first run creates `lecture-notes-ai\.venv`, installs the Python and npm dependencies, starts both services and opens http://127.0.0.1:5180/. Press Ctrl+C to stop (or run `.\stop-all.ps1` from another window). Logs go to `.run\`.

### Folder map

| Path | What it is |
|---|---|
| `backend/`, `frontend/`, `docker-compose.yml` | Google OAuth app (see above) |
| `aq-api/` | Node/Express app backend, port 5180 |
| `lecture-notes-ai/` | Python AI/notes worker, port 5055 (`backend/` Flask app, `notes_engine/`, `tests/`) |
| `lecture-notes-ui/` | Vanilla JS UI |
| `docs/` | `ARCHITECTURE.md`, `AQ-Learning-Dev-Notebook.pdf` |
| `scripts/` | `sync.ps1` (mirror working folders into this repo), `secret-scan.ps1` (key scanner) |
| `start-all.ps1`, `stop-all.ps1` | Start / stop both services |

### Development

- Python tests: `cd lecture-notes-ai; $env:LNA_OFFLINE='1'; .venv\Scripts\python -m pytest tests -q`
- Node tests: `cd aq-api; npm test`
- Before pushing: `powershell -File scripts\secret-scan.ps1` (fails if a real-looking key or a `.env` file is in the tree).
