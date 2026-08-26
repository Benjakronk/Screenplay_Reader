"""Faaglarna export sidecar — stateless PDF/FDX rendering for the cloud API.

The Node service (../server-node/) owns accounts, documents and the CRDT, but
the typesetting lives in Python: pdf_layout.py drives ReportLab and fdx.py
speaks Final Draft XML. Rather than reimplement either in JavaScript, the Node
service POSTs the script text here and streams the bytes back.

Every route is text-in / bytes-out over a function that already exists:

    POST /pdf        {"text": ...}                 -> pdf_layout.build_pdf
    POST /sides      {"text": ..., "character": ...} -> pdf_layout.build_sides_pdf
    POST /cue-sheet  {"text": ...}                 -> pdf_layout.build_cue_sheet_pdf
    POST /fdx        {"text": ...}                 -> fdx.build_fdx
    POST /from-fdx   {"xml": ...}                  -> fdx.fdx_to_fountain
    GET  /health                                   -> {"ok": true}

This process is deliberately tiny in what it can do. It has NO database, NO
credentials, and — unlike server.py — takes no file paths, so nothing here can
read or write the disk. It binds to 127.0.0.1 and is reachable only through the
Node service, which does the authentication.

Run:  python export_server.py [--port 3002] [--host 127.0.0.1]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# The Fountain modules live at the repository root during development and
# alongside this file once deployed to /srv/faaglarna-export. Support both.
_HERE = os.path.dirname(os.path.abspath(__file__))
for candidate in (_HERE, os.path.dirname(_HERE)):
    if os.path.isfile(os.path.join(candidate, "pdf_layout.py")) and candidate not in sys.path:
        sys.path.insert(0, candidate)

import fdx           # noqa: E402
import pdf_layout    # noqa: E402

# A feature-length screenplay is well under 1 MB of text; .fdx XML is bulkier.
MAX_BODY = 16 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    server_version = "FaaglarnaExport/1.0"

    # Quieter logs: pm2 captures stdout, and one line per export is plenty.
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ---------- plumbing ----------

    def _json(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _bytes(self, status: int, data: bytes, content_type: str):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise ValueError("empty body")
        if length > MAX_BODY:
            raise ValueError("body too large")
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise ValueError(f"invalid JSON body: {e}") from e
        if not isinstance(data, dict):
            raise ValueError("body must be a JSON object")
        return data

    @staticmethod
    def _text(data: dict, key: str = "text") -> str:
        value = data.get(key, "")
        if not isinstance(value, str):
            raise ValueError(f"{key} must be a string")
        return value

    # ---------- routes ----------

    def do_GET(self):
        if self.path.split("?")[0] in ("/health", "/"):
            return self._json(200, {"ok": True})
        return self._json(404, {"error": "unknown endpoint"})

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            data = self._read_json()

            if path == "/pdf":
                return self._bytes(200, pdf_layout.build_pdf(self._text(data)),
                                   "application/pdf")

            if path == "/cue-sheet":
                return self._bytes(200, pdf_layout.build_cue_sheet_pdf(self._text(data)),
                                   "application/pdf")

            if path == "/sides":
                character = self._text(data, "character")
                if not character:
                    return self._json(400, {"error": "character required"})
                return self._bytes(
                    200, pdf_layout.build_sides_pdf(self._text(data), character),
                    "application/pdf")

            if path == "/fdx":
                return self._bytes(200, fdx.build_fdx(self._text(data)),
                                   "application/xml")

            if path == "/from-fdx":
                xml = self._text(data, "xml")
                if not xml.strip():
                    return self._json(400, {"error": "empty .fdx content"})
                text = fdx.fdx_to_fountain(xml)
                return self._bytes(200, text.encode("utf-8"),
                                   "text/plain; charset=utf-8")

            return self._json(404, {"error": "unknown endpoint"})

        except ValueError as e:
            return self._json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001 — never take the process down
            return self._json(500, {"error": f"{path.lstrip('/') or 'export'} failed: {e}"})


def main():
    ap = argparse.ArgumentParser(description="Faaglarna export sidecar")
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "3002")))
    args = ap.parse_args()

    # ThreadingHTTPServer so one slow PDF render doesn't block the next export.
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"faaglarna-export listening on http://{args.host}:{args.port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
