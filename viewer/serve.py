#!/usr/bin/env python3
"""Serve the FAZE4 digital twin with optional SSE relay for live motor data.

    python viewer/serve.py
    -> http://localhost:8347/viewer/index.html

    python viewer/serve.py --serial COM5
    -> also streams HB lines from SAME70 debug UART at /events (SSE)

Stdlib only for basic serving. Serial relay requires pyserial (pip install pyserial).
"""
import argparse
import http.server
import threading
import webbrowser
import os
import socketserver
import queue
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Global queue for SSE clients to receive serial data
serial_queue = queue.Queue()
sse_clients = []
sse_lock = threading.Lock()


def serial_reader(port, baud):
    """Read lines from serial port and broadcast to SSE clients."""
    try:
        import serial
    except ImportError:
        print("[SSE] pyserial not installed - run: pip install pyserial")
        return

    print(f"[SSE] Opening {port} at {baud} baud...")
    try:
        ser = serial.Serial(port, baud, timeout=1)
        print(f"[SSE] Connected to {port}")
    except Exception as e:
        print(f"[SSE] Failed to open {port}: {e}")
        return

    while True:
        try:
            line = ser.readline()
            if line:
                text = line.decode('utf-8', errors='ignore').strip()
                if text.startswith('HB,'):
                    # Broadcast to all SSE clients
                    with sse_lock:
                        for client_queue in sse_clients:
                            try:
                                client_queue.put_nowait(text)
                            except queue.Full:
                                pass
        except Exception as e:
            print(f"[SSE] Serial error: {e}")
            time.sleep(1)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_GET(self):
        # SSE endpoint for live motor data
        if self.path == '/events':
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Connection', 'keep-alive')
            self.end_headers()

            # Create a queue for this client
            client_queue = queue.Queue(maxsize=100)
            with sse_lock:
                sse_clients.append(client_queue)

            try:
                while True:
                    try:
                        data = client_queue.get(timeout=30)
                        # SSE format: "data: <payload>\n\n"
                        self.wfile.write(f"data: {data}\n\n".encode())
                        self.wfile.flush()
                    except queue.Empty:
                        # Send keepalive comment
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                pass  # Client disconnected — normal when browser refreshes/closes
            finally:
                with sse_lock:
                    if client_queue in sse_clients:
                        sse_clients.remove(client_queue)
            return

        # Default static file handling
        super().do_GET()

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
    ap.add_argument("--no-browser", action="store_true",
                    help="don't auto-open the viewer (headless / Pi service use)")
    ap.add_argument("--serial", metavar="PORT",
                    help="SAME70 debug UART port (e.g. COM5, /dev/ttyACM0) for SSE relay")
    ap.add_argument("--baud", type=int, default=115200,
                    help="serial baud rate (default: 115200)")
    args = ap.parse_args()

    # Start serial reader thread if port specified
    if args.serial:
        serial_thread = threading.Thread(
            target=serial_reader,
            args=(args.serial, args.baud),
            daemon=True
        )
        serial_thread.start()
        print(f"[SSE] Live data endpoint: http://localhost:{args.port}/events")

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer((args.host, args.port), Handler) as httpd:
        shown = "localhost" if args.host == "127.0.0.1" else args.host
        url = f"http://{shown}:{args.port}/viewer/index.html"
        print(f"FAZE4 twin: {url}")
        if not args.no_browser and args.host == "127.0.0.1":
            threading.Timer(0.5, webbrowser.open, [url]).start()
        httpd.serve_forever()
