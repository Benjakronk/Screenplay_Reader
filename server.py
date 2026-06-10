"""Screenplay Reader — local server.

Run: python server.py [--port 8766] [--host 127.0.0.1]
Then open http://127.0.0.1:8766 in your browser.

Scripts live under ./scripts/. Version snapshots under ./scripts/.history/.
Image uploads (storyboards, stage diagrams) under ./scripts/_assets/.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import mimetypes
import shutil
import sys
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SCRIPTS_DIR = ROOT / "scripts"
STATIC_DIR = ROOT / "static"
ASSETS_DIRNAME = "_assets"
HISTORY_DIRNAME = ".history"

ALLOWED_EXT = {".fountain", ".spmd", ".txt"}
MAX_BODY_BYTES = 8 * 1024 * 1024

# Version-history throttling. Autosaves fire every ~1.5s while typing; without
# throttling that buries the real checkpoints under hundreds of near-identical
# snapshots and grows .history/ without bound. So: an autosave only snapshots if
# the newest existing snapshot is older than SNAPSHOT_MIN_INTERVAL_S; a manual
# save always snapshots (force=True). Either way we prune to SNAPSHOT_MAX_PER_FILE.
SNAPSHOT_MIN_INTERVAL_S = 300   # 5 minutes between auto-snapshots
SNAPSHOT_MAX_PER_FILE = 80      # keep the most recent N snapshots per file


def _resolve_within(base: Path, rel: str) -> Path:
    rel = (rel or "").lstrip("/\\").replace("\\", "/")
    if not rel:
        raise ValueError("empty path")
    if ".." in rel.split("/"):
        raise ValueError("path traversal")
    candidate = (base / rel).resolve()
    candidate.relative_to(base.resolve())
    return candidate


def safe_script_path(rel: str) -> Path:
    return _resolve_within(SCRIPTS_DIR, rel)


def history_dir_for(rel: str) -> Path:
    safe_script_path(rel)
    return SCRIPTS_DIR / HISTORY_DIRNAME / rel


def _newest_snapshot_mtime(hdir: Path) -> float | None:
    if not hdir.is_dir():
        return None
    times = [f.stat().st_mtime for f in hdir.iterdir() if f.is_file()]
    return max(times) if times else None


def _prune_snapshots(hdir: Path, keep: int):
    if not hdir.is_dir():
        return
    # Snapshot filenames are timestamps, so name order == chronological order.
    files = sorted((f for f in hdir.iterdir() if f.is_file()), key=lambda f: f.name)
    excess = len(files) - keep
    for f in files[:max(0, excess)]:
        try:
            f.unlink()
        except OSError:
            pass


def snapshot_if_changed(rel: str, new_content: str, force: bool = False):
    p = safe_script_path(rel)
    if not p.is_file():
        return
    try:
        old = p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return
    if old == new_content:
        return
    hdir = history_dir_for(rel)
    # Throttle auto-snapshots: skip if we snapshotted recently. Manual saves
    # (force=True) and deletes always checkpoint.
    if not force:
        newest = _newest_snapshot_mtime(hdir)
        if newest is not None and (time.time() - newest) < SNAPSHOT_MIN_INTERVAL_S:
            return
    hdir.mkdir(parents=True, exist_ok=True)
    ts = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    suffix = p.suffix or ".fountain"
    # Avoid clobbering a snapshot from the same second (filenames are 1s
    # resolution). list_history reads the timestamp from the stem, so keep the
    # base timestamp readable and disambiguate with a short suffix.
    dest = hdir / f"{ts}{suffix}"
    n = 1
    while dest.exists():
        dest = hdir / f"{ts}-{n}{suffix}"
        n += 1
    dest.write_text(old, encoding="utf-8")
    _prune_snapshots(hdir, SNAPSHOT_MAX_PER_FILE)


def list_history(rel: str) -> list[dict]:
    safe_script_path(rel)
    hdir = SCRIPTS_DIR / HISTORY_DIRNAME / rel
    if not hdir.is_dir():
        return []
    out = []
    for f in sorted(hdir.iterdir(), reverse=True):
        if not f.is_file():
            continue
        out.append({"timestamp": f.stem, "size": f.stat().st_size, "name": f.name})
    return out


def history_content(rel: str, name: str) -> str:
    safe_script_path(rel)
    if "/" in name or "\\" in name or name.startswith("."):
        raise ValueError("invalid snapshot id")
    f = (SCRIPTS_DIR / HISTORY_DIRNAME / rel / name).resolve()
    f.relative_to((SCRIPTS_DIR / HISTORY_DIRNAME).resolve())
    if not f.is_file():
        raise ValueError("snapshot not found")
    return f.read_text(encoding="utf-8", errors="replace")


def list_tree() -> list[dict]:
    def walk(folder: Path) -> list[dict]:
        entries = []
        for child in sorted(folder.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
            if child.name.startswith("."):
                continue
            if child.name == ASSETS_DIRNAME:
                continue
            rel = child.relative_to(SCRIPTS_DIR).as_posix()
            if child.is_dir():
                entries.append({"type": "dir", "name": child.name, "path": rel, "children": walk(child)})
            elif child.suffix.lower() in ALLOWED_EXT:
                entries.append({"type": "file", "name": child.name, "path": rel})
        return entries
    if not SCRIPTS_DIR.exists():
        return []
    return walk(SCRIPTS_DIR)


class Handler(BaseHTTPRequestHandler):
    server_version = "ScreenplayReader/0.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _send_json(self, status: int, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, status: int, body: bytes, content_type: str, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length > MAX_BODY_BYTES * 2:
            raise ValueError("payload too large")
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            raise ValueError("invalid JSON body")

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)
        try:
            if path == "/api/tree":
                return self._send_json(200, {"tree": list_tree()})
            if path == "/api/file":
                rel = (qs.get("path") or [""])[0]
                p = safe_script_path(rel)
                if not p.is_file():
                    return self._send_json(404, {"error": "not found"})
                return self._send_json(200, {
                    "path": rel,
                    "content": p.read_text(encoding="utf-8", errors="replace"),
                    "mtime": p.stat().st_mtime,
                })
            if path == "/api/history":
                rel = (qs.get("path") or [""])[0]
                return self._send_json(200, {"snapshots": list_history(rel)})
            if path == "/api/history/file":
                rel = (qs.get("path") or [""])[0]
                name = (qs.get("name") or [""])[0]
                return self._send_json(200, {"content": history_content(rel, name)})
            if path == "/api/export/pdf":
                rel = (qs.get("path") or [""])[0]
                p = safe_script_path(rel)
                if not p.is_file():
                    return self._send_json(404, {"error": "not found"})
                try:
                    import pdf_layout
                    pdf = pdf_layout.build_pdf(p.read_text(encoding="utf-8", errors="replace"))
                except Exception as e:  # noqa: BLE001
                    return self._send_json(500, {"error": f"pdf build failed: {e}"})
                fname = Path(rel).stem + ".pdf"
                return self._send_bytes(200, pdf, "application/pdf",
                    extra={"Content-Disposition": f'attachment; filename="{fname}"'})
            if path == "/api/export/cue-sheet":
                rel = (qs.get("path") or [""])[0]
                p = safe_script_path(rel)
                if not p.is_file():
                    return self._send_json(404, {"error": "not found"})
                try:
                    import pdf_layout
                    pdf = pdf_layout.build_cue_sheet_pdf(
                        p.read_text(encoding="utf-8", errors="replace"))
                except Exception as e:  # noqa: BLE001
                    return self._send_json(500, {"error": f"cue sheet failed: {e}"})
                fname = Path(rel).stem + "-cue-sheet.pdf"
                return self._send_bytes(200, pdf, "application/pdf",
                    extra={"Content-Disposition": f'attachment; filename="{fname}"'})
            if path == "/api/export/fdx":
                rel = (qs.get("path") or [""])[0]
                p = safe_script_path(rel)
                if not p.is_file():
                    return self._send_json(404, {"error": "not found"})
                try:
                    import fdx
                    data = fdx.build_fdx(p.read_text(encoding="utf-8", errors="replace"))
                except Exception as e:  # noqa: BLE001
                    return self._send_json(500, {"error": f"fdx export failed: {e}"})
                fname = Path(rel).stem + ".fdx"
                return self._send_bytes(200, data, "application/xml",
                    extra={"Content-Disposition": f'attachment; filename="{fname}"'})
            if path == "/api/export/sides":
                rel = (qs.get("path") or [""])[0]
                character = (qs.get("character") or [""])[0]
                if not character:
                    return self._send_json(400, {"error": "character required"})
                p = safe_script_path(rel)
                if not p.is_file():
                    return self._send_json(404, {"error": "not found"})
                try:
                    import pdf_layout
                    pdf = pdf_layout.build_sides_pdf(
                        p.read_text(encoding="utf-8", errors="replace"), character)
                except Exception as e:  # noqa: BLE001
                    return self._send_json(500, {"error": f"sides build failed: {e}"})
                fname = f"{Path(rel).stem}-sides-{character}.pdf"
                return self._send_bytes(200, pdf, "application/pdf",
                    extra={"Content-Disposition": f'attachment; filename="{fname}"'})
            if path.startswith("/scripts/"):
                rel = urllib.parse.unquote(path[len("/scripts/"):])
                p = safe_script_path(rel)
                if not p.is_file():
                    return self._send_json(404, {"error": "not found"})
                ctype, _ = mimetypes.guess_type(p.name)
                return self._send_bytes(200, p.read_bytes(), ctype or "application/octet-stream")
            return self._serve_static(path)
        except ValueError as e:
            return self._send_json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            return self._send_json(500, {"error": str(e)})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            data = self._read_json()
            if path == "/api/save":
                rel = data.get("path", "")
                content = data.get("content", "")
                if not isinstance(content, str):
                    raise ValueError("content must be string")
                p = safe_script_path(rel)
                if p.suffix.lower() not in ALLOWED_EXT:
                    raise ValueError("unsupported extension")
                is_auto = bool(data.get("auto"))
                force = bool(data.get("force"))
                base_mtime = data.get("baseMtime")
                # Conflict detection: if the file changed on disk since the
                # client loaded it (external edit, restore, second tab), refuse
                # to clobber unless the client explicitly forces the overwrite.
                if p.is_file() and base_mtime is not None and not force:
                    try:
                        disk_mtime = p.stat().st_mtime
                        if disk_mtime > float(base_mtime) + 1.0:
                            return self._send_json(409, {
                                "error": "conflict",
                                "mtime": disk_mtime,
                                "disk": p.read_text(encoding="utf-8", errors="replace"),
                            })
                    except (TypeError, ValueError):
                        pass
                snapshot_if_changed(rel, content, force=not is_auto)
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(content, encoding="utf-8")
                return self._send_json(200, {"ok": True, "path": rel, "mtime": p.stat().st_mtime})
            if path == "/api/new":
                rel = (data.get("path", "") or "").lstrip("/\\").replace("\\", "/")
                p = safe_script_path(rel)
                if p.exists():
                    raise ValueError("already exists")
                if p.suffix.lower() not in ALLOWED_EXT:
                    raise ValueError("unsupported extension")
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(data.get("content", "") or "", encoding="utf-8")
                return self._send_json(200, {"ok": True, "path": rel})
            if path == "/api/rename":
                from_rel = (data.get("from", "") or "").lstrip("/\\").replace("\\", "/")
                to_rel = (data.get("to", "") or "").lstrip("/\\").replace("\\", "/")
                src = safe_script_path(from_rel)
                dst = safe_script_path(to_rel)
                if not src.exists():
                    raise ValueError("source does not exist")
                if dst.exists():
                    raise ValueError("destination already exists")
                dst.parent.mkdir(parents=True, exist_ok=True)
                src.rename(dst)
                return self._send_json(200, {"ok": True})
            if path == "/api/delete":
                rel = data.get("path", "")
                p = safe_script_path(rel)
                if p.is_file():
                    snapshot_if_changed(rel, "")
                    p.unlink()
                    return self._send_json(200, {"ok": True})
                return self._send_json(404, {"error": "not found"})
            if path == "/api/import/fdx":
                name = (data.get("name", "") or "imported").rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
                xml = data.get("content", "")
                if not isinstance(xml, str) or not xml.strip():
                    raise ValueError("empty .fdx content")
                try:
                    import fdx
                    fountain_text = fdx.fdx_to_fountain(xml)
                except Exception as e:  # noqa: BLE001
                    return self._send_json(400, {"error": f"could not parse .fdx: {e}"})
                stem = (name.rsplit(".", 1)[0] or "imported")
                # Find a free <stem>.fountain (append -1, -2, ... if taken).
                rel = f"{stem}.fountain"
                candidate = safe_script_path(rel)
                n = 1
                while candidate.exists():
                    rel = f"{stem}-{n}.fountain"
                    candidate = safe_script_path(rel)
                    n += 1
                candidate.parent.mkdir(parents=True, exist_ok=True)
                candidate.write_text(fountain_text, encoding="utf-8")
                return self._send_json(200, {"ok": True, "path": rel})
            if path == "/api/restore":
                rel = data.get("path", "")
                name = data.get("name", "")
                content = history_content(rel, name)
                p = safe_script_path(rel)
                snapshot_if_changed(rel, content)
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(content, encoding="utf-8")
                return self._send_json(200, {"ok": True})
            return self._send_json(404, {"error": "unknown endpoint"})
        except ValueError as e:
            return self._send_json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            return self._send_json(500, {"error": str(e)})

    def _serve_static(self, path: str):
        if path == "/" or path == "":
            path = "/index.html"
        # Allow /tests/... to reach tests/ for the parser test runner.
        if path.startswith("/tests/"):
            rel = path.lstrip("/")
            candidate = (ROOT / rel).resolve()
            try:
                candidate.relative_to(ROOT.resolve())
            except ValueError:
                return self._send_json(403, {"error": "forbidden"})
        else:
            rel = path.lstrip("/")
            candidate = (STATIC_DIR / rel).resolve()
            try:
                candidate.relative_to(STATIC_DIR.resolve())
            except ValueError:
                return self._send_json(403, {"error": "forbidden"})
        if not candidate.is_file():
            return self._send_json(404, {"error": "not found"})
        ctype, _ = mimetypes.guess_type(candidate.name)
        ctype = ctype or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript") or ctype.endswith("json"):
            ctype += "; charset=utf-8"
        return self._send_bytes(200, candidate.read_bytes(), ctype)


def ensure_seed():
    SCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    (SCRIPTS_DIR / ASSETS_DIRNAME).mkdir(exist_ok=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    ensure_seed()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}/"
    print(f"Screenplay Reader serving {SCRIPTS_DIR} at {url}")
    print("Press Ctrl+C to stop.")
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        httpd.server_close()


if __name__ == "__main__":
    main()
