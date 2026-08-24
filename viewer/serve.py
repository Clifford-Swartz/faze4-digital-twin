#!/usr/bin/env python3
"""Serve the FAZE4 digital twin. Run this, open the URL, done.

    python viewer/serve.py
    -> http://localhost:8347/viewer/index.html

Stdlib only, no dependencies. Serves the repo root so the viewer can load
meshes, data, and the assembly-instruction pages.
"""
import argparse
import http.server
import os
import socketserver

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        # the viewer cache-busts with query strings; let everything else cache
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, fmt, *args):  # quiet: errors only
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Serve the FAZE4 digital twin")
    ap.add_argument("--host", default="127.0.0.1",
                    help="bind address; use 0.0.0.0 to reach it from other devices (Pi setups)")
    ap.add_argument("--port", type=int, default=8347)
    args = ap.parse_args()
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer((args.host, args.port), Handler) as httpd:
        shown = "localhost" if args.host == "127.0.0.1" else args.host
        print(f"FAZE4 twin: http://{shown}:{args.port}/viewer/index.html")
        httpd.serve_forever()
