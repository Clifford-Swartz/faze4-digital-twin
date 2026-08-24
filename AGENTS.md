# Agent quickstart

Instructions for AI coding agents (and impatient humans) working in this repo.

## Zero-hardware quickstart

```
python viewer/serve.py          # opens the browser itself; --no-browser to suppress
```

Python 3.10+, stdlib only. The full arm renders, joint sliders
move it with gear-ratio-faithful kinematics, all pages work offline. No node,
no build step, no package install.

Pages: `index.html` (the twin), `build.html` (assembly explorer),
`part.html?stl=<name>` (single part), `cyclo.html` (cycloidal drive
visualizer), `encoder.html` (encoder bench).

## Repo map

- `viewer/app.js` — all twin logic, one file. Key structures: `LIVE_MAP`
  (CAN node → joint index + gear ratio), `jointCtl[]` (slider/quaternion
  control per joint), `applyHb()` (heartbeat → twin pose), the arrow-key
  handler (teleop nudges).
- `viewer/data/build_j1.json`, `viewer_transforms.json` — assembly graph and
  part transforms the twin is built from. `rebuild_parts.json` maps stock
  FAZE4 parts to rebuilt replacements.
- `viewer/serve.py` — static server + print pipeline (see below).
- `firmware/` — Zephyr apps for the SAME70 CAN bridge. `firmware/README.md`
  has wiring and build commands.

## Editing gotchas

- `index.html` loads `app.js?v=<timestamp>` — bump the query string after
  editing app.js or the browser serves you the stale cached version and your
  change silently "does nothing."
- Data JSONs are fetched with cache-busting query params already.
- Meshes in `viewer/assets/` are in assembly coordinates, often far from the
  origin — don't assume parts are origin-centered.

## BLE teleop (needs the bench)

Chain: browser (Web Bluetooth) → RNBD451 → UART3 → SAME70 (`firmware/teleop`)
→ CAN 250k → ODrive S1. Transparent UART service UUIDs are in app.js.

Line protocol to the SAME70: `V,<node>,<mvel>` + `GO,<node>` (velocity mode),
`N,<node>,<mturns>` (position nudge, trap-traj, holds after), `STOP` (all),
`PING` → `PONG`. Telemetry: `HB,<node>,<state>,<err_hex>,<mvel>,<mpos>` at
2 Hz per node (m-prefixed = milli-units).

- Only ONE central can hold the module — a zombie browser tab or the OS
  Bluetooth stack will steal the connection. Close other tabs first.
- Automating the Web Bluetooth chooser from Playwright/CDP works:
  `DeviceAccess.enable`, listen for `deviceRequestPrompted`, then
  `DeviceAccess.selectPrompt`. An agent can drive the physical arm this way —
  arrow keys via `page.keyboard.press` after connecting.

## Firmware

```
west build -d build_teleop firmware/teleop    # board sam_e70_xplained/same70q21b
west flash -d build_teleop                    # OpenOCD via onboard EDBG
```

Wiring, phantom-power traps, and ODrive arming order are in
`firmware/README.md`. The BLE link usually survives a SAME70 reflash.
