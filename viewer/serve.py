"""Viewer server: static files + click-to-print pipeline (P1S + AD5M).

Serves the ARM project root (viewer pages + STLs). POST /print takes a part's
URL path + material + printer, slices it headless (Bambu Studio CLI for the
P1S, OrcaSlicer CLI for the FlashForge Adventurer 5M), and after the user
confirms, uploads over LAN and starts the print. One job at a time;
GET /print/status reports.

Run:  python viewer\\serve.py
"""
import http.server
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import zipfile

PORT = 8347
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # ...\Projects\ARM

BBL = r"C:\Program Files\Bambu Studio\resources\profiles\BBL"
FFP = ROOT + r"\tools\orcaslicer\resources\profiles\Flashforge"

PRINTERS = {
    "p1s": {
        "label": "Bambu P1S",
        "kind": "bambu",
        "ip": "PRINTER_IP_HERE",
        "code": "ACCESS_CODE_HERE",
        "serial": "SERIAL_HERE",
        "use_ams": False,
        "slicer": r"C:\Program Files\Bambu Studio\bambu-studio.exe",
        "machine": BBL + r"\machine\Bambu Lab P1S 0.4 nozzle.json",
        "process": BBL + r"\process\0.20mm Standard @BBL X1C.json",
        "filaments": {"PLA": BBL + r"\filament\Generic PLA.json",
                      "PETG": BBL + r"\filament\Generic PETG.json",
                      "TPU": BBL + r"\filament\Generic TPU.json"},
        "origin": "corner",       # plate coords 0..256
        "bed": (256, 256, 256),
        "extra_args": ["--curr-bed-type", "Textured PEI Plate"],
        "eta_re": r"total estimated time: ([^\n;]+)",
    },
    "ad5m": {
        "label": "FlashForge AD5M",
        "kind": "flashforge",
        "ip": "PRINTER_IP_HERE",
        "code": "CHECK_CODE_HERE",       # LAN check code (his "printer ID")
        "serial": "SERIAL_HERE",
        "slicer": ROOT + r"\tools\orcaslicer\orca-slicer.exe",
        "machine": FFP + r"\machine\Flashforge Adventurer 5M 0.4 Nozzle.json",
        "process": FFP + r"\process\0.20mm Standard @Flashforge AD5M 0.4 Nozzle.json",
        "filaments": {"PLA": FFP + r"\filament\Flashforge Generic PLA.json",
                      "PETG": FFP + r"\filament\Flashforge Generic PETG.json",
                      "TPU": FFP + r"\filament\Flashforge Generic TPU.json"},
        "origin": "center",       # plate coords -110..110
        "bed": (220, 220, 220),
        "extra_args": [],
        "eta_re": r"estimated printing time \(normal mode\) = ([^\n;]+)",
    },
}

# local printer credentials: viewer/printers_local.json (gitignored)
# {"p1s": {"ip": "...", "code": "...", "serial": "..."}, "ad5m": {...}}
try:
    import json as _json
    with open(os.path.join(os.path.dirname(__file__), "printers_local.json")) as _f:
        for _k, _v in _json.load(_f).items():
            if _k in PRINTERS:
                PRINTERS[_k].update(_v)
except FileNotFoundError:
    pass

job = {"state": "idle", "detail": "", "part": "", "eta": ""}
job_lock = threading.Lock()
pending = {}              # sliced-and-waiting: {workdir, threemf, name, eta, png}


def set_job(**kw):
    with job_lock:
        job.update(kw)


def flatten_profile(path):
    """Resolve a BBL profile's `inherits` chain (child wins). The CLI does not
    follow inheritance for file-path settings: the P1S machine json carries no
    printable_height/printable_area itself, and the fallback ceiling (~100mm)
    silently rejected any part taller than that ('Nothing to be sliced' on the
    Main base, 118mm)."""
    merged = {}
    chain = []
    d = os.path.dirname(path)
    name = os.path.basename(path)
    while name:
        with open(os.path.join(d, name), encoding="utf-8") as f:
            p = json.load(f)
        chain.append(p)
        name = (p["inherits"] + ".json") if p.get("inherits") else None
    for p in reversed(chain):          # root first, child overrides
        merged.update(p)
    merged.pop("inherits", None)
    return merged


PROFILE_CACHE = {}         # (printer, material) -> (machine, process, filament) paths


def prepare_profiles(pkey, material, brim=False, fast=False, supports=True):
    """Flatten machine/process/filament for a printer (filament profiles
    inherit too: raw Generic PETG carries no filament_max_volumetric_speed and
    the CLI fallback throttled every print ~3.7x). Process gets tree
    auto-supports (generates nothing on flat parts). AD5M machine profile
    ships a degenerate bed_exclude_area ('0x0') that kills the CLI - drop it."""
    key = (pkey, material, brim, fast, supports)
    if key in PROFILE_CACHE:
        return PROFILE_CACHE[key]
    P = PRINTERS[pkey]
    tmp = tempfile.gettempdir()

    m = flatten_profile(P["machine"])
    m["bed_exclude_area"] = []
    mpath = os.path.join(tmp, f"arm_{pkey}_machine.json")
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(m, f)

    proc = flatten_profile(P["process"])
    proc["name"] = proc.get("name", "proc") + " +treesupport"
    proc["enable_support"] = "1" if supports else "0"
    proc["support_type"] = "tree(auto)"
    # Petar's structural spec (docs/D_Printing.rst): 3 perimeters, 25-30% infill
    proc["wall_loops"] = "3"
    proc["sparse_infill_density"] = "25%"
    if fast:
        # measured on the J1 shell: 0.28 layers + 4 walls + 12% infill is 24%
        # faster AND stronger than 0.20/3w/25% - on shell-like parts the walls
        # carry the load and the infill is nearly free time
        proc["layer_height"] = "0.28"
        proc["initial_layer_print_height"] = "0.28"
        proc["wall_loops"] = "4"
        proc["sparse_infill_density"] = "12%"
    if brim:
        proc["brim_type"] = "outer_only"
        proc["brim_width"] = "5"
        proc["brim_object_gap"] = "0.1"
    ppath = os.path.join(tmp, f"arm_{pkey}_process{'_brim' if brim else ''}.json")
    with open(ppath, "w", encoding="utf-8") as f:
        json.dump(proc, f)

    fil = flatten_profile(P["filaments"][material])
    fpath = os.path.join(tmp, f"arm_{pkey}_filament_{material}.json")
    with open(fpath, "w", encoding="utf-8") as f:
        json.dump(fil, f)

    PROFILE_CACHE[key] = (mpath, ppath, fpath)
    return PROFILE_CACHE[key]


def printer_busy(pkey):
    """Ask the actual printer what it's doing - the pipeline's own job state
    knows nothing about prints started from Bambu Studio / the touchscreen.
    Returns a human string if busy, None if free (or unreachable: fail open,
    the human confirm gate still stands)."""
    P = PRINTERS[pkey]
    try:
        if P["kind"] == "flashforge":
            r = subprocess.run(
                ["curl", "-s", "-m", "6", "-X", "POST",
                 f"http://{P['ip']}:8898/detail",
                 "-H", "Content-Type: application/json",
                 "-d", json.dumps({"serialNumber": P["serial"],
                                   "checkCode": P["code"]})],
                capture_output=True, text=True, timeout=15)
            st = json.loads(r.stdout).get("detail", {}).get("status", "")
            if st.lower() in ("printing", "busy", "paused", "pausing",
                              "heating", "calibrate_doing"):
                return f"{P['label']} is {st}"
        else:
            import bambulabs_api as bl
            import time
            p = bl.Printer(P["ip"], P["code"], P["serial"])
            p.connect()
            try:
                time.sleep(2)
                st = str(p.get_state())
            finally:
                p.disconnect()
            if st.upper() in ("RUNNING", "PAUSE", "PREPARE"):
                return f"{P['label']} is {st.lower()}"
    except Exception:
        return None
    return None


def render_preview(stl_path):
    """Shaded 3D preview of the sliced mesh (used when the slicer's 3mf has no
    thumbnail - the Orca CLI path). Returns PNG bytes."""
    import io
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection
    import trimesh
    import numpy as np
    m = trimesh.load(stl_path, force="mesh")
    if len(m.faces) > 12000:
        m = m.simplify_quadric_decimation(face_count=12000)
    fig = plt.figure(figsize=(3.2, 2.6), dpi=100)
    ax = fig.add_subplot(111, projection="3d")
    tris = m.vertices[m.faces]
    shade = (m.face_normals @ np.array([0.3, -0.5, 0.8])).clip(0.15, 1)
    col = Poly3DCollection(tris, facecolors=plt.cm.Blues(0.35 + 0.5 * shade),
                           edgecolors="none")
    ax.add_collection3d(col)
    lo, hi = m.bounds
    c, r = (lo + hi) / 2, (hi - lo).max() / 2
    for setl, i in ((ax.set_xlim, 0), (ax.set_ylim, 1), (ax.set_zlim, 2)):
        setl(c[i] - r, c[i] + r)
    ax.view_init(elev=28, azim=-55)
    ax.set_axis_off()
    fig.tight_layout(pad=0)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", facecolor="#14161a")
    plt.close(fig)
    return buf.getvalue()


def slice_job(url_path, material, pkey, brim=False, fast=False, supports=True):
    global pending
    try:
        P = PRINTERS[pkey]
        rel = url_path.lstrip("/").replace("/", os.sep)
        src = os.path.join(ROOT, rel)
        if not os.path.isfile(src):
            set_job(state="error", detail=f"file not found: {url_path}")
            return
        busy = printer_busy(pkey)
        if busy:
            set_job(state="error", detail=f"{busy} - pick the other printer or wait")
            return
        machine_p, process_p, filament_p = prepare_profiles(pkey, material, brim, fast, supports)
        name = re.sub(r"[^A-Za-z0-9_-]", "_", os.path.splitext(os.path.basename(src))[0])
        workdir = tempfile.mkdtemp(prefix="armprint_")
        threemf = f"{name}.gcode.3mf"

        # STLs carry assembly coordinates (often far outside the plate, which
        # the CLI rejects) - re-center onto this printer's bed origin
        try:
            import trimesh
            m = trimesh.load(src, force="mesh")
            lo, hi = m.bounds
            ext = sorted(float(h - l) for l, h in zip(lo, hi))
            bed = sorted(P["bed"])
            if any(e > b - 4 for e, b in zip(ext, bed)):
                others = [q for q, Q in PRINTERS.items()
                          if all(e <= b - 4 for e, b in zip(ext, sorted(Q["bed"])))]
                hint = f" - fits: {', '.join(others)}" if others else ""
                set_job(state="error",
                        detail=f"{name} ({ext[0]:.0f}x{ext[1]:.0f}x{ext[2]:.0f}) "
                               f"exceeds {P['label']} bed{hint}")
                shutil.rmtree(workdir, ignore_errors=True)
                return
            cx = 128 if P["origin"] == "corner" else 0
            m.apply_translation([cx - (lo[0] + hi[0]) / 2,
                                 cx - (lo[1] + hi[1]) / 2,
                                 -lo[2]])
            src = os.path.join(workdir, "input.stl")
            m.export(src)
        except Exception as e:
            set_job(state="error", detail=f"mesh re-center failed: {e}")
            return

        set_job(state="slicing",
                detail=f"{name} in {material} on {P['label']} (tree supports auto)",
                part=name, printer=pkey, eta="")
        cmd = [P["slicer"], "--debug", "1",
               "--load-settings", f"{machine_p};{process_p}",
               "--load-filaments", filament_p,
               *P["extra_args"],
               # everything we feed is print-oriented and pre-centered; the
               # auto-orienter chokes on merged plates and once flipped a part
               "--slice", "0", "--orient", "0", "--arrange", "0",
               "--outputdir", workdir, "--export-3mf", threemf, src]
        r = subprocess.run(cmd, cwd=workdir, capture_output=True, text=True, timeout=600)
        out3mf = os.path.join(workdir, threemf)
        if not os.path.isfile(out3mf):
            tail = (r.stdout + r.stderr)[-400:]
            set_job(state="error", detail=f"slice failed: {tail}")
            shutil.rmtree(workdir, ignore_errors=True)
            return

        # eta + preview live inside the 3mf
        eta, png, gtext = "", None, ""
        try:
            with zipfile.ZipFile(out3mf) as z:
                gnames = [n for n in z.namelist() if n.endswith(".gcode")]
                if gnames:
                    gtext = z.read(gnames[0]).decode(errors="ignore")
                    # Bambu writes the estimate in the header, Orca in the
                    # config footer - search the whole file
                    mm = re.search(P["eta_re"], gtext)
                    if mm:
                        eta = mm.group(1).strip()
                cands = [n for n in z.namelist()
                         if re.search(r"Metadata/(plate_1\.png|top_1\.png)", n)]
                if cands:
                    png = z.read(sorted(cands)[0])
        except Exception:
            pass
        if png is None:
            # Orca's CLI 3mf carries no thumbnail - render a silhouette
            try:
                png = render_preview(src)
            except Exception:
                pass

        with job_lock:
            pending.clear()
            pending.update({"workdir": workdir, "threemf": threemf, "name": name,
                            "eta": eta, "png": png, "printer": pkey})
        set_job(state="await_confirm",
                detail=f"{name}: sliced ({material}, {P['label']}), "
                       f"est {eta or '?'} - confirm to print",
                eta=eta)
    except Exception as e:
        set_job(state="error", detail=f"{type(e).__name__}: {e}")


def send_bambu(P, info):
    """Native P1S path. Uploads over implicit FTPS via curl (python ftplib
    hangs on STOR against Bambu's TLS stack; bambulabs_api returned success
    without ever landing a file), then starts via raw MQTT project_file and
    believes nothing until the printer reports RUNNING."""
    import ssl
    import time
    import paho.mqtt.client as mqtt

    name, eta = info["name"], info["eta"]
    out3mf = os.path.join(info["workdir"], info["threemf"])

    up = subprocess.run(["curl", "-k", "--ssl-reqd", "-m", "300", "-T", out3mf,
                         f"ftps://{P['ip']}:990/{info['threemf']}",
                         "--user", f"bblp:{P['code']}"],
                        capture_output=True, text=True, timeout=360)
    if up.returncode != 0:
        set_job(state="error", detail=f"{name}: FTPS upload failed ({up.returncode})")
        return False
    # bytes + lossy decode: the SD listing contains non-cp1252 filenames that
    # crash text-mode capture on Windows (stdout comes back None)
    ls = subprocess.run(["curl", "-k", "--ssl-reqd", "-m", "30", "-l",
                         f"ftps://{P['ip']}:990/",
                         "--user", f"bblp:{P['code']}"],
                        capture_output=True, timeout=60)
    listing = (ls.stdout or b"").decode("utf-8", "replace")
    if info["threemf"] not in listing:
        set_job(state="error", detail=f"{name}: upload not visible on the P1S SD")
        return False

    set_job(state="starting", detail=f"{name}: starting print")
    states = []

    def on_msg(c, u, m):
        try:
            p = json.loads(m.payload).get("print", {})
            if "gcode_state" in p:
                states.append(p["gcode_state"])
        except Exception:
            pass

    c = mqtt.Client(protocol=mqtt.MQTTv311)
    c.tls_set(cert_reqs=ssl.CERT_NONE)
    c.tls_insecure_set(True)
    c.username_pw_set("bblp", P["code"])
    c.on_connect = lambda cl, *a: cl.subscribe(f"device/{P['serial']}/report")
    c.on_message = on_msg
    c.connect(P["ip"], 8883, 10)
    c.loop_start()
    try:
        time.sleep(2)
        import hashlib
        with open(out3mf, "rb") as fh:
            md5 = hashlib.md5(fh.read()).hexdigest()
        # full Bambu-Studio-style payload; requires Developer Mode ON at the
        # printer (commands are ACKed but ignored without it)
        c.publish(f"device/{P['serial']}/request", json.dumps({"print": {
            "sequence_id": "1", "command": "project_file",
            "param": "Metadata/plate_1.gcode",
            "url": f"ftp:///{info['threemf']}", "md5": md5,
            "project_id": "0", "profile_id": "0", "task_id": "0",
            "subtask_id": "0", "subtask_name": name,
            "use_ams": P["use_ams"], "ams_mapping": "",
            "timelapse": False, "bed_type": "auto", "bed_leveling": True,
            "flow_cali": False, "vibration_cali": False, "layer_inspect": False,
        }}))
        started = False
        for _ in range(12):
            time.sleep(3)
            # the printer only volunteers gcode_state on change - ask outright
            c.publish(f"device/{P['serial']}/request",
                      json.dumps({"pushing": {"sequence_id": "2", "command": "pushall"}}))
            if any(s in ("RUNNING", "PREPARE") for s in states[-4:]):
                started = True
                break
    finally:
        c.loop_stop()
        c.disconnect()
    if started:
        set_job(state="printing", detail=f"{name} printing on {P['label']}, est {eta}")
    else:
        hint = ("its screen shows a FINISHED print - tap Done there, then confirm again"
                if "FINISH" in states[-3:] else
                f"check its screen (last states: {states[-3:]}), confirm to retry")
        set_job(state="await_confirm",
                detail=f"{P['label']} took the file but never started: {hint}")
    return started


def send_flashforge(P, info):
    """Upload + start over the AD5M's REST API (port 8898). Auth and options
    ride as HTTP headers; the multipart carries only gcodeFile - format from
    OrcaSlicer's Flashforge.cpp. The printer wants raw gcode, not 3mf."""
    name, eta = info["name"], info["eta"]
    out3mf = os.path.join(info["workdir"], info["threemf"])
    gpath = os.path.join(info["workdir"], f"{name}.gcode")
    with zipfile.ZipFile(out3mf) as z:
        gnames = [n for n in z.namelist() if n.endswith(".gcode")]
        with open(gpath, "wb") as f:
            f.write(z.read(gnames[0]))
    import base64
    hdrs = {
        "serialNumber": P["serial"], "checkCode": P["code"],
        "fileSize": str(os.path.getsize(gpath)),
        "printNow": "true", "levelingBeforePrint": "true",
        "flowCalibration": "false", "firstLayerInspection": "false",
        "timeLapseVideo": "false", "useMatlStation": "false",
        "gcodeToolCnt": "1",
        "materialMappings": base64.b64encode(b"[]").decode(),
    }
    cmd = ["curl", "-s", "-m", "120", "-X", "POST",
           f"http://{P['ip']}:8898/uploadGcode"]
    for k, v in hdrs.items():
        cmd += ["-H", f"{k}: {v}"]
    cmd += ["-F", f"gcodeFile=@{gpath}"]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    try:
        resp = json.loads(r.stdout)
    except Exception:
        resp = {"code": -1, "message": r.stdout[-200:] or r.stderr[-200:]}
    if resp.get("code") == 0:
        set_job(state="printing", detail=f"{name} printing on {P['label']}, est {eta}")
        return True
    if "busy" in str(resp.get("message", "")).lower():
        # AD5M sits in 'completed' until the touchscreen done-tap; keep the
        # job so a re-confirm works without re-slicing
        set_job(state="await_confirm",
                detail=f"{P['label']} refused - tap DONE on its screen, then confirm again")
    else:
        set_job(state="error", detail=f"{name}: AD5M refused: {resp.get('message')}")
    return False


def send_job():
    try:
        with job_lock:
            info = dict(pending)
        if not info.get("threemf"):
            set_job(state="error", detail="nothing awaiting confirmation")
            return
        pk = info.get("printer", "p1s")
        P = PRINTERS[pk]
        busy = printer_busy(pk)
        if busy:
            # keep the pending job so the confirm card stays up for a retry
            set_job(state="await_confirm",
                    detail=f"{busy} - job held, confirm again when it's free")
            return
        set_job(state="uploading", detail=f"{info['name']} -> {P['label']} ({info['eta']})")
        if P["kind"] == "bambu":
            ok = send_bambu(P, info)
        else:
            ok = send_flashforge(P, info)
        if not ok:
            return          # keep pending: a re-confirm retries without re-slicing
        with job_lock:
            wd = pending.pop("workdir", None)
            pending.clear()
        if wd:
            shutil.rmtree(wd, ignore_errors=True)
    except Exception as e:
        set_job(state="error", detail=f"{type(e).__name__}: {e}")


def cancel_job():
    with job_lock:
        wd = pending.pop("workdir", None)
        pending.clear()
    if wd:
        shutil.rmtree(wd, ignore_errors=True)
    set_job(state="idle", detail="", part="", eta="")


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.stl': 'model/stl',
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.json': 'application/json',
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-cache')
        http.server.BaseHTTPRequestHandler.end_headers(self)
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/print/status':
            with job_lock:
                self._json(dict(job))
            return
        if self.path.startswith('/print/preview.png'):
            with job_lock:
                png = pending.get("png")
            if not png:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.send_header('Cache-Control', 'no-cache')
            http.server.BaseHTTPRequestHandler.end_headers(self)
            self.wfile.write(png)
            return
        super().do_GET()

    def do_POST(self):
        if self.path == '/print/confirm':
            with job_lock:
                ok = bool(pending.get("threemf")) and job["state"] == "await_confirm"
            if not ok:
                self.send_response(409)   # nothing pending, or send in flight
                self.end_headers()
                return
            set_job(state="uploading")    # claim before the thread spins up
            threading.Thread(target=send_job, daemon=True).start()
            self.send_response(202)
            self.end_headers()
            return
        if self.path == '/print/cancel':
            cancel_job()
            self.send_response(200)
            self.end_headers()
            return
        if self.path in ('/arm', '/disarm'):
            # subprocess so the USB device is RELEASED afterwards (holding it
            # in this process locks out every bench script)
            code = (
                "import odrive\n"
                "from odrive.enums import AxisState, ControlMode, InputMode\n"
                "d = odrive.find_any(timeout=15)\n"
                "a = d.axis0\n"
                "d.clear_errors()\n"
            )
            if self.path == '/arm':
                code += (
                    "a.controller.config.control_mode = ControlMode.VELOCITY_CONTROL\n"
                    "a.controller.config.input_mode = InputMode.VEL_RAMP\n"
                    "a.controller.config.vel_ramp_rate = 2.0\n"
                    "a.requested_state = AxisState.CLOSED_LOOP_CONTROL\n"
                )
            else:
                code += "a.requested_state = AxisState.IDLE\n"
            try:
                r = subprocess.run(["python", "-c", code], timeout=40,
                                   capture_output=True, text=True)
                self.send_response(200 if r.returncode == 0 else 500)
            except Exception:
                self.send_response(500)
            self.end_headers()
            return
        if self.path == '/markup':
            # pin annotations from the viewers -> file Claude reads
            n = int(self.headers.get('Content-Length', 0))
            try:
                body = json.loads(self.rfile.read(n))
            except Exception:
                self.send_response(400)
                self.end_headers()
                return
            body["saved_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            with open(os.path.join(ROOT, "viewer", "data", "markup_latest.json"),
                      "w", encoding="utf-8") as f:
                json.dump(body, f, indent=1)
            self.send_response(200)
            self.end_headers()
            return
        if self.path != '/print':
            self.send_response(404)
            self.end_headers()
            return
        n = int(self.headers.get('Content-Length', 0))
        try:
            req = json.loads(self.rfile.read(n))
        except Exception:
            self.send_response(400)
            self.end_headers()
            return
        with job_lock:
            busy = job["state"] in ("slicing", "uploading", "starting")
        if busy:
            self.send_response(409)
            self.end_headers()
            return
        mat = req.get("material", "PLA")
        if mat not in ("PLA", "PETG", "TPU"):
            mat = "PLA"
        pkey = req.get("printer", "p1s")
        if pkey not in PRINTERS:
            pkey = "p1s"
        t = threading.Thread(target=slice_job,
                             args=(req.get("file", ""), mat, pkey, bool(req.get("brim")),
                                   bool(req.get("fast")), req.get("supports", True) is not False),
                             daemon=True)
        t.start()
        self.send_response(202)
        self.end_headers()

    def log_message(self, fmt, *args):  # quieter log: only errors
        if args and str(args[1]).startswith(('4', '5')):
            super().log_message(fmt, *args)


def main():
    server = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'Serving {ROOT}')
    print(f'FAZE4 viewer:   http://localhost:{PORT}/viewer/')
    print(f'Construction:   http://localhost:{PORT}/viewer/build.html')
    for k, P in PRINTERS.items():
        print(f'Print pipeline: {P["label"]} {P["ip"]} ({P["serial"]})')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
