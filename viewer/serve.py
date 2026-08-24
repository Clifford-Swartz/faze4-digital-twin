#!/usr/bin/env python3
"""Serve the FAZE4 digital twin. Run this, open the URL, done.

    python viewer/serve.py
    -> http://localhost:8347/viewer/index.html

Stdlib only, no dependencies. Serves the repo root so the viewer can load
meshes, data, and the assembly-instruction pages.
"""
import http.server
import os
import socketserver

PORT = 8347
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
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"FAZE4 twin: http://localhost:{PORT}/viewer/index.html")
        httpd.serve_forever()
