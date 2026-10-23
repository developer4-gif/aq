"""Start the Lecture Notes AI server:  python run.py  ->  http://127.0.0.1:5055"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)                      # backend/  (the web app)
sys.path.insert(0, os.path.dirname(_HERE))      # repo root (the notes_engine package, when not pip-installed)

from app.server import create_app  # noqa: E402

HOST = "127.0.0.1"  # local only - never bind to 0.0.0.0
PORT = int(os.environ.get("LNA_PORT", "5055"))


def main() -> None:
    app = create_app()
    print(f"Lecture Notes AI running at http://{HOST}:{PORT}  (Ctrl+C to stop)")
    app.run(host=HOST, port=PORT, debug=False, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
